import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  auditLogs,
  couponPrograms,
  coupons,
  customers,
  productUnits,
  promotions,
  receipts,
  shifts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
} from "../accounting/postingEngine";
import { logAuditTx } from "../auditService";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";
import { hashCouponCode } from "../couponService";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import {
  lockEconomicInventoryScope,
  readEconomicVariant,
} from "../inventory/economicOwnership";
import {
  applyMovement,
  applyValuedInboundMovement,
  convertToBaseQuantity,
} from "../inventoryService";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { paymentAssetRole } from "../sale/paymentPosting";
import { withTx, type Actor } from "../tx";

export interface NoReceiptOrExchangeItemInput {
  variantId: number;
  productUnitId?: number;
  productName: string;
  barcode?: string | null;
  quantity: number;
  unitPrice: string;
  disposition?: "RESTOCK" | "SCRAP";
}

export interface ExecuteNoReceiptOrExchangeInput {
  mode: "STORE_CREDIT" | "DIRECT_EXCHANGE";
  returnItems: Array<
    NoReceiptOrExchangeItemInput & { disposition: "RESTOCK" | "SCRAP" }
  >;
  exchangeItems?: NoReceiptOrExchangeItemInput[];
  customer?: { name?: string | null; phone?: string | null } | null;
  reason?: string | null;
  settlement: {
    returnTotal: string;
    exchangeTotal?: string;
    differenceAmount: string;
    paymentMethod?: "CASH" | "CARD" | "STORE_CREDIT";
    shiftId?: number;
    reference?: string | null;
  };
  clientRequestId?: string;
}

async function resolveItemBaseQty(
  tx: Tx,
  item: { variantId: number; productUnitId?: number; quantity: number },
): Promise<number> {
  if (item.productUnitId != null) {
    const res = await convertToBaseQuantity(
      tx,
      item.productUnitId,
      item.quantity,
      item.variantId,
    );
    return res.baseQuantity;
  }
  const [baseUnit] = await tx
    .select({ id: productUnits.id })
    .from(productUnits)
    .where(
      and(
        eq(productUnits.variantId, item.variantId),
        eq(productUnits.isBaseUnit, true),
      ),
    )
    .limit(1);
  if (baseUnit) {
    const res = await convertToBaseQuantity(
      tx,
      Number(baseUnit.id),
      item.quantity,
      item.variantId,
    );
    return res.baseQuantity;
  }
  return item.quantity;
}

async function ensureNoReceiptCreditProgramTx(
  tx: Tx,
  branchId: number,
  amountStr: string,
  voucherCode: string,
  userId: number,
): Promise<number> {
  const now = new Date();
  const todayYmd = new Date(now.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const promoRes = await tx.insert(promotions).values({
    name: `قسيمة مرتجع استثنائي ${voucherCode}`,
    type: "AMOUNT",
    discountAmount: amountStr,
    maxDiscountAmount: amountStr,
    discountPercent: "0.00",
    scope: "ALL",
    effectiveFrom: now,
    effectiveTo: null,
    branchId,
    minLineAmount: "0.00",
    priority: 10,
    isActive: true,
    applicationMode: "COUPON",
    createdBy: userId,
  });
  const promotionId = extractInsertId(promoRes);
  const progRes = await tx.insert(couponPrograms).values({
    promotionId,
    name: `برنامج قسيمة مرتجع ${voucherCode}`,
    status: "ACTIVE",
    branchId,
    validFrom: new Date(`${todayYmd}T00:00:00.000Z`),
    validTo: null,
    perCouponLimit: 1,
    perCustomerLimit: 10,
    codePrefix: "SC",
    createdBy: userId,
  });
  return extractInsertId(progRes);
}

export async function executeNoReceiptOrExchangeService(
  input: ExecuteNoReceiptOrExchangeInput,
  actor: Actor & { role: string },
  auditCtx: Parameters<typeof logAuditTx>[1],
) {
  if (actor.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذر تنفيذ عملية الإرجاع أو الاستبدال",
        why: "لا يوجد فرع تشغيلي محدد للعملية",
        doThis: "اختر الفرع التشغيلي أو أسند فرعاً للمستخدم قبل المتابعة",
      }),
    });
  }
  const branchId = Number(actor.branchId);

  return withTx(
    async (tx) => {
      await assertPeriodOpen(tx, new Date());

      const payloadHash = input.clientRequestId
        ? idempotencyHash({ branchId, ...input })
        : null;
      if (input.clientRequestId) {
        const existingId = await checkIdempotency(
          tx,
          "return.noReceiptOrExchange",
          input.clientRequestId,
          payloadHash,
          { forUpdate: true },
        );
        if (existingId != null) {
          const [auditRow] = await tx
            .select({ newValue: auditLogs.newValue })
            .from(auditLogs)
            .where(eq(auditLogs.id, existingId))
            .limit(1);
          const snap = (auditRow?.newValue ?? {}) as Record<string, unknown>;
          return {
            ok: true as const,
            voucherCode: String(snap.voucherCode ?? ""),
            mode: input.mode,
            returnTotal: String(snap.returnTotal ?? input.settlement.returnTotal),
            exchangeTotal: String(
              snap.exchangeTotal ?? input.settlement.exchangeTotal ?? "0",
            ),
            differenceAmount: String(
              snap.differenceAmount ?? input.settlement.differenceAmount,
            ),
            customerName: String(snap.customerName ?? "زبون عابر"),
            customerPhone:
              typeof snap.customerPhone === "string" ? snap.customerPhone : null,
            dateStr: String(snap.dateStr ?? ""),
            idempotentReplay: true as const,
          };
        }
      }

      const now = new Date();
      const suffix = randomBytes(3).toString("hex").toUpperCase();
      const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const voucherCode =
        input.mode === "DIRECT_EXCHANGE"
          ? `EX-${ym}-${suffix}`
          : `SC-${ym}-${suffix}`;

      const customerName = input.customer?.name?.trim() || "زبون عابر";
      const customerPhone = input.customer?.phone?.trim() || null;
      const returnReason =
        input.reason?.trim() ||
        (input.mode === "DIRECT_EXCHANGE"
          ? "استبدال مباشر بضاعة"
          : "إرجاع بضاعة بدون فاتورة");

      const allVariantIds = Array.from(
        new Set([
          ...input.returnItems.map((i) => i.variantId),
          ...(input.exchangeItems ?? []).map((i) => i.variantId),
        ]),
      ).sort((a, b) => a - b);

      const scope = await lockEconomicInventoryScope(tx, allVariantIds);
      const variantCosts = new Map<number, ReturnType<typeof money>>();
      for (const vid of allVariantIds) {
        const current = await readEconomicVariant(tx, scope, vid);
        if (
          !current.product.isActive ||
          !current.isActive ||
          current.product.isService ||
          current.product.isBundle ||
          current.product.isConsignment ||
          current.product.productType === "DIGITAL_CARD"
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: `تعذر معالجة الصنف «${current.product.name}» في الإرجاع الاستثنائي`,
              why: "الصنف معطل أو ليس مخزوناً مملوكاً (خدمة أو بكج أو أمانة أو بطاقة رقمية)",
              doThis: "استخدم الأصناف المخزنية المملوكة والنشطة فقط في هذا المسار",
            }),
          });
        }
        variantCosts.set(vid, round2(money(current.costPrice ?? "0")));
      }

      // ١) حركات المخزون المقيمة للمرتجع (RESTOCK)
      let restockCostTotal = money(0);
      for (const itm of input.returnItems) {
        if (itm.disposition === "RESTOCK") {
          const effectiveBaseQty = await resolveItemBaseQty(tx, itm);
          const unitCost = variantCosts.get(itm.variantId) ?? money(0);
          const lineValue = round2(unitCost.times(effectiveBaseQty));
          restockCostTotal = round2(restockCostTotal.plus(lineValue));
          await applyValuedInboundMovement(tx, {
            variantId: itm.variantId,
            branchId,
            baseQuantity: effectiveBaseQty,
            historicalValue: lineValue,
            movementType: "RETURN",
            referenceType:
              input.mode === "DIRECT_EXCHANGE"
                ? "EXCHANGE_RETURN"
                : "NO_RECEIPT_RETURN",
            documentNumber: voucherCode,
            notes: `${input.mode === "DIRECT_EXCHANGE" ? "استبدال بضاعة" : "مرتجع استثنائي بدون وصل"} [${voucherCode}] — ${returnReason} (${customerName})`,
            createdBy: actor.userId,
          });
        }
      }

      // ٢) حركات المخزون للبديل الجديد (DIRECT_EXCHANGE)
      let exchangeCostTotal = money(0);
      if (
        input.mode === "DIRECT_EXCHANGE" &&
        input.exchangeItems &&
        input.exchangeItems.length > 0
      ) {
        for (const itm of input.exchangeItems) {
          const effectiveBaseQty = await resolveItemBaseQty(tx, itm);
          const unitCost = variantCosts.get(itm.variantId) ?? money(0);
          exchangeCostTotal = round2(
            exchangeCostTotal.plus(unitCost.times(effectiveBaseQty)),
          );
          await applyMovement(tx, {
            variantId: itm.variantId,
            branchId,
            baseQuantity: effectiveBaseQty,
            movementType: "OUT",
            referenceType: "EXCHANGE_ISSUE",
            documentNumber: voucherCode,
            notes: `صرف بضاعة بديلة مقابل استبدال [${voucherCode}] — ${returnReason} (${customerName})`,
            createdBy: actor.userId,
          });
        }
      }

      // ٣) قيود التقييم المخزني المتوازنة
      if (restockCostTotal.gt(0)) {
        const gainComp = {
          roleDebits: { INVENTORY: restockCostTotal },
          roleCredits: { OTHER_REVENUE: restockCostTotal },
        };
        await postEntry(tx, {
          entryType: "ADJUST",
          dedupeKey: `NO-RECEIPT-RESTOCK:${voucherCode}`,
          branchId,
          createdBy: actor.userId,
          amount: restockCostTotal,
          revenue: restockCostTotal,
          profit: restockCostTotal,
          notes: `إثبات مخزون مرتجع استثنائي [${voucherCode}]`,
          postingIntent: createPostingIntent(
            "ADJUST_INVENTORY_GAIN",
            "ADJUST",
            [
              debitLine("INVENTORY", restockCostTotal),
              creditLine("OTHER_REVENUE", restockCostTotal),
            ],
            gainComp,
          ),
          postingSourceComponents: gainComp,
        });
      }

      if (exchangeCostTotal.gt(0)) {
        const lossComp = {
          roleDebits: { LOSSES: exchangeCostTotal },
          roleCredits: { INVENTORY: exchangeCostTotal },
        };
        await postEntry(tx, {
          entryType: "ADJUST",
          dedupeKey: `NO-RECEIPT-EXCHANGE-OUT:${voucherCode}`,
          branchId,
          createdBy: actor.userId,
          amount: exchangeCostTotal,
          cost: exchangeCostTotal,
          profit: exchangeCostTotal.neg(),
          notes: `تكلفة بضاعة بديلة منصرفة بالاستبدال [${voucherCode}]`,
          postingIntent: createPostingIntent(
            "ADJUST_INVENTORY_LOSS",
            "ADJUST",
            [
              debitLine("LOSSES", exchangeCostTotal),
              creditLine("INVENTORY", exchangeCostTotal),
            ],
            lossComp,
          ),
          postingSourceComponents: lossComp,
        });
      }

      // ٤) اشتقاق مجاميع التسوية من بنود المرتجع والبديل فعلياً ورفض أي تضارب مع حمولة العميل
      if (input.returnItems.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر تنفيذ الإرجاع الاستثنائي",
            why: "قائمة بنود المرتجع فارغة",
            doThis: "أضف صنفاً واحداً على الأقل إلى سلة المرتجعات قبل التنفيذ",
          }),
        });
      }
      if (
        input.mode === "DIRECT_EXCHANGE" &&
        (!input.exchangeItems || input.exchangeItems.length === 0)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر تنفيذ الاستبدال المباشر",
            why: "قائمة الأصناف البديلة فارغة في وضع الاستبدال المباشر",
            doThis: "أضف صنفاً بديلاً واحداً على الأقل إلى سلة الاستبدال قبل التنفيذ",
          }),
        });
      }

      let computedReturnTotal = money(0);
      for (const itm of input.returnItems) {
        const qty = money(itm.quantity);
        const unitPrice = round2(money(itm.unitPrice));
        if (qty.lte(0) || unitPrice.lt(0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: `بيانات بند المرتجع «${itm.productName}» غير صالحة`,
              why: "الكمية يجب أن تكون موجبة وسعر الوحدة غير سالب",
              doThis: "راجع كميات وأسعار البنود المرتجعة ثم أعد المحاولة",
            }),
          });
        }
        computedReturnTotal = round2(
          computedReturnTotal.plus(round2(unitPrice.times(qty))),
        );
      }

      let computedExchangeTotal = money(0);
      if (input.mode === "DIRECT_EXCHANGE") {
        for (const itm of input.exchangeItems ?? []) {
          const qty = money(itm.quantity);
          const unitPrice = round2(money(itm.unitPrice));
          if (qty.lte(0) || unitPrice.lt(0)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: `بيانات البند البديل «${itm.productName}» غير صالحة`,
                why: "الكمية يجب أن تكون موجبة وسعر الوحدة غير سالب",
                doThis: "راجع كميات وأسعار البنود البديلة ثم أعد المحاولة",
              }),
            });
          }
          computedExchangeTotal = round2(
            computedExchangeTotal.plus(round2(unitPrice.times(qty))),
          );
        }
      }

      const submittedReturnTotal = round2(money(input.settlement.returnTotal));
      if (!computedReturnTotal.eq(submittedReturnTotal)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تضارب في إجمالي قيمة المرتجع",
            why: `مجموع بنود المرتجع (${toDbMoney(computedReturnTotal)}) لا يطابق الإجمالي المرسل (${toDbMoney(submittedReturnTotal)})`,
            doThis: "حدّث السلة لإعادة احتساب الإجمالي الفعلي ثم أعد الإرسال",
          }),
        });
      }

      if (input.mode === "DIRECT_EXCHANGE") {
        const submittedExchangeTotal = round2(
          money(input.settlement.exchangeTotal ?? "0"),
        );
        if (!computedExchangeTotal.eq(submittedExchangeTotal)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تضارب في إجمالي الأصناف البديلة",
              why: `مجموع بنود الاستبدال (${toDbMoney(computedExchangeTotal)}) لا يطابق الإجمالي المرسل (${toDbMoney(submittedExchangeTotal)})`,
              doThis: "حدّث السلة لإعادة احتساب إجمالي الاستبدال ثم أعد المحاولة",
            }),
          });
        }
      }

      const returnTotalDec = computedReturnTotal;
      const exchangeTotalDec = computedExchangeTotal;
      const expectedSignedDiff =
        input.mode === "DIRECT_EXCHANGE"
          ? round2(exchangeTotalDec.minus(returnTotalDec))
          : round2(returnTotalDec.neg());
      const submittedDiffDec = round2(money(input.settlement.differenceAmount));
      const diffMatches =
        input.mode === "DIRECT_EXCHANGE"
          ? submittedDiffDec.eq(expectedSignedDiff)
          : submittedDiffDec.eq(expectedSignedDiff) ||
            submittedDiffDec.eq(money(0)) ||
            submittedDiffDec.abs().eq(returnTotalDec);
      if (!diffMatches) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تضارب في فرق التسوية المالية",
            why: `فرق التسوية المرسل (${toDbMoney(submittedDiffDec)}) لا يطابق الفرق الفعلي (${toDbMoney(expectedSignedDiff)})`,
            doThis: "حدّث السلة لإعادة احتساب فرق التسوية ثم أعد المحاولة",
          }),
        });
      }
      const diffDec =
        input.mode === "DIRECT_EXCHANGE"
          ? expectedSignedDiff
          : money(0);

      let matchedCustomerId: number | null = null;
      if (customerPhone) {
        const [cust] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.phone, customerPhone),
              eq(customers.isActive, true),
            ),
          )
          .for("update")
          .limit(1);
        if (cust) matchedCustomerId = Number(cust.id);
      }

      const creditToIssue =
        input.mode === "STORE_CREDIT"
          ? returnTotalDec
          : diffDec.lt(0)
            ? diffDec.abs()
            : money(0);

      if (creditToIssue.gt(0)) {
        if (matchedCustomerId != null) {
          await adjustCustomerBalance(
            tx,
            matchedCustomerId,
            creditToIssue.neg(),
          );
          await postEntry(tx, {
            entryType: "ADJUST",
            dedupeKey: `NO-RECEIPT-CREDIT:${voucherCode}`,
            branchId,
            customerId: matchedCustomerId,
            createdBy: actor.userId,
            amount: creditToIssue.neg(),
            notes: `رصيد دائن لمرتجع استثنائي [${voucherCode}]`,
            postingIntent: createPostingIntent(
              "ADJUST_AR",
              "ADJUST",
              signedPostingLines("AR", "OPENING_EQUITY", creditToIssue.neg()),
            ),
          });
        } else {
          const programId = await ensureNoReceiptCreditProgramTx(
            tx,
            branchId,
            toDbMoney(creditToIssue),
            voucherCode,
            actor.userId,
          );
          await tx.insert(coupons).values({
            programId,
            customerId: null,
            code: voucherCode,
            codeHash: hashCouponCode(voucherCode),
            status: "ACTIVE",
            issuedAt: now,
          });
        }
      }

      let settlementReceiptId: number | null = null;
      if (input.mode === "DIRECT_EXCHANGE" && diffDec.gt(0)) {
        const payMethod = input.settlement.paymentMethod ?? "CASH";
        if (payMethod !== "CASH" && payMethod !== "CARD") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذر تحصيل فرق الاستبدال",
              why: "يجب تحصيل فرق الاستبدال نقداً أو بالبطاقة",
              doThis: "اختر الدفع النقدي أو البطاقة لتحصيل فرق السعر",
            }),
          });
        }
        let effectiveShiftId: number | null = input.settlement.shiftId ?? null;
        if (payMethod === "CASH") {
          if (effectiveShiftId == null) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: "تعذر تحصيل فرق الاستبدال نقداً",
                why: "يلزم تحديد وردية مفتوحة لتحصيل النقد في الدرج",
                doThis: "افتح وردية كاشير في الفرع ثم أعد تنفيذ الاستبدال",
              }),
            });
          }
          const [sh] = await tx
            .select()
            .from(shifts)
            .where(eq(shifts.id, effectiveShiftId))
            .for("update")
            .limit(1);
          if (
            !sh ||
            sh.status !== "OPEN" ||
            Number(sh.branchId) !== branchId
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: "تعذر تحصيل فرق الاستبدال على الوردية المختارة",
                why: "الوردية المختارة غير مفتوحة حالياً أو لا تتبع هذا الفرع",
                doThis: "اختر وردية كاشير مفتوحة تابعة لنفس الفرع ثم أعد تنفيذ الاستبدال",
              }),
            });
          }
          await lockMaterializedCashReceiptSourceForWrite(tx, {
            branchId,
            shiftId: effectiveShiftId,
            cashBucket: "DRAWER",
            paymentMethod: "CASH",
            status: "COMPLETED",
            approvalStatus: "APPROVED",
          });
        } else if (
          input.settlement.reference != null &&
          input.settlement.reference.length > 100
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "مرجع عملية البطاقة غير صالح",
              why: `طول المرجع المدخل (${input.settlement.reference.length}) يتجاوز الحد الأقصى المسموح (100 محرف)`,
              doThis: "اختصر رقم مرجع البطاقة ليكون 100 محرف أو أقل ثم أعد المحاولة",
            }),
          });
        }

        const rIn = await tx.insert(receipts).values({
          branchId,
          shiftId: effectiveShiftId,
          direction: "IN",
          amount: toDbMoney(diffDec),
          paymentMethod: payMethod,
          cashBucket: payMethod === "CASH" ? "DRAWER" : null,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          referenceNumber:
            input.settlement.reference?.trim().slice(0, 100) || voucherCode,
          partyType: matchedCustomerId != null ? "CUSTOMER" : "OTHER",
          partyId: matchedCustomerId,
          description: `فرق استبدال مباشر [${voucherCode}] (${customerName})`,
          createdBy: actor.userId,
        });
        settlementReceiptId = extractInsertId(rIn);
        const assetRole = paymentAssetRole(
          payMethod,
          payMethod === "CASH" ? "DRAWER" : null,
          "IN",
        );
        const diffComp = {
          roleDebits: { [assetRole]: diffDec },
          roleCredits: { OTHER_LIABILITY: diffDec },
        };
        await postEntry(tx, {
          entryType: "PAYMENT_IN",
          dedupeKey: `NO-RECEIPT-DIFF-IN:${voucherCode}`,
          branchId,
          receiptId: settlementReceiptId,
          customerId: matchedCustomerId,
          createdBy: actor.userId,
          amount: diffDec,
          paymentMethod: payMethod,
          notes: `تحصيل فرق استبدال مباشر [${voucherCode}]`,
          postingIntent: createPostingIntent(
            "PAYMENT_IN_OTHER",
            "PAYMENT_IN",
            [debitLine(assetRole, diffDec), creditLine("OTHER_LIABILITY", diffDec)],
            diffComp,
          ),
          postingSourceComponents: diffComp,
        });
      }

      const dateStr = now.toLocaleDateString("ar-IQ-u-nu-latn", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      await logAuditTx(tx, auditCtx, {
        action:
          input.mode === "DIRECT_EXCHANGE"
            ? "return.direct_exchange"
            : "return.no_receipt_voucher",
        entityType: "voucher",
        entityId: settlementReceiptId != null ? String(settlementReceiptId) : voucherCode,
        branchId,
        newValue: {
          voucherCode,
          mode: input.mode,
          customerName,
          customerPhone,
          matchedCustomerId,
          reason: returnReason,
          returnTotal: toDbMoney(returnTotalDec),
          exchangeTotal: toDbMoney(exchangeTotalDec),
          differenceAmount: toDbMoney(diffDec),
          dateStr,
          returnLinesCount: input.returnItems.length,
          exchangeLinesCount: input.exchangeItems?.length ?? 0,
          dispositions: input.returnItems.map((i) => ({
            name: i.productName,
            disp: i.disposition,
            qty: i.quantity,
          })),
        },
      });

      if (input.clientRequestId) {
        const [latestAudit] = await tx
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.entityType, "voucher"),
              eq(
                auditLogs.entityId,
                settlementReceiptId != null
                  ? String(settlementReceiptId)
                  : voucherCode,
              ),
            ),
          )
          .limit(1);
        await recordIdempotencyKey(
          tx,
          "return.noReceiptOrExchange",
          input.clientRequestId,
          latestAudit?.id ?? 1,
          payloadHash,
        );
      }

      return {
        ok: true as const,
        voucherCode,
        mode: input.mode,
        returnTotal: toDbMoney(returnTotalDec),
        exchangeTotal: toDbMoney(exchangeTotalDec),
        differenceAmount: toDbMoney(diffDec),
        customerName,
        customerPhone,
        dateStr,
      };
    },
    { gate: "FINANCIAL_WRITER" },
  );
}
