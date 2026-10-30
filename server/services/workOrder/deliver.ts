import { loadWorkOrderDepositReceiptSet } from "./depositReceiptSet";
// READY → DELIVERED: إنشاء فاتورة (sourceType=WORKORDER) + دفعة اختيارية + قيد SALE + تسوية الذمم.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, notLike, or, sql } from "drizzle-orm";
import { customers, invoiceItems, invoices, productUnits, productVariants, products, receipts, shifts, workOrders } from "../../../drizzle/schema";
import { assertCreditLimit } from "../../lib/credit";
import { requiresFullPaymentAtHandover, COD_PICKUP_PAYMENT_ERROR_AR, type CodPaymentMode } from "@shared/codHandoverPolicy";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { readOpeningWindowState } from "../openingModeService";
import { appliedCollectionsForWorkOrder, linkSoleTargetCollectionsToInvoice } from "../deposits";
import type { Tx } from "../../db";
import { type Actor, withTx } from "../tx";
import { assertNoLiveConsignment, assertWorkOrderBranch, loadWorkOrder, workOrderInvoiceSourceId, resolveDeliveryInvoiceNumber } from "./helpers";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { logAuditTx } from "../auditService";
import { recordWorkOrderEvent } from "../workOrderEvents";
import { assertSiblingsReady } from "./siblings";
import type { PaymentMethod } from "./types";
import { userNameSnapshot } from "../userSnapshot";
import { paymentAssetRole } from "../sale/paymentPosting";
import { mixedAwarePaymentMethod } from "../sale/payment";
import { titleForChannel } from "@shared/productChannelTitles";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";
import { appErrorMessage } from "@shared/errors";
import { assertBaseProductUnitBinding,
  requireWorkOrderBaseSnapshot,
} from "./baseInventorySnapshot";
import { publishRealtimeEvent } from "../../realtime";
import {
  REALTIME_EVENT_TYPES,
  type WorkOrderStatusChangedPayload,
  type ReceptionQueueUpdatedPayload,
} from "@shared/realtimeEvents";

export interface DeliverWorkOrderInput {
  workOrderId: number;
  payment?: { amount: string; method: PaymentMethod; reference?: string | null } | null;
  clientRequestId?: string | null;
  /** إقرارُ تسليم جزءٍ من طلبٍ إخوتُه لم يجهزوا — يفشل مغلقاً بدونه (ش٥). */
  partialDispatchConfirmed?: boolean;
  /** إضافة المتبقي غير المستحصل إلى ذمة العميل (باعتماد مدير) */
  addToCustomerDebt?: boolean;
  /** معرّف المدير الذي اعتمد إضافة المتبقي إلى ذمة العميل */
  managerOverrideByUserId?: number | null;
  /** فرض التحقق من اعتماد الدين (إلزامي في راوتر التسليم والواجهات) */
  enforceDebtApproval?: boolean;
}

export type DeliverWorkOrderTxResult = {
  workOrderId: number;
  invoiceId: number;
  invoiceNumber: string;
  status: string;
  branchId: number;
  idempotentReplay?: true;
};

/** READY → DELIVERED داخل معاملة خارجية قائمة (يُستخدَم في التسليم الفردي وجرد الرفّ الذري). */
export async function deliverWorkOrderInTx(
  tx: Tx,
  input: DeliverWorkOrderInput,
  actor: Actor & { role?: string },
): Promise<DeliverWorkOrderTxResult> {
  // دفعة التسليم قبضٌ ذاتي من الموظف؛ نرفض غير النقدي قبل فحص idempotency وقفل الأمر.
  if (input.payment) assertPosPaymentMethodEnabled(input.payment.method);
  {
    const requestFingerprint = input.clientRequestId ? idempotencyHash(input) : null;
    // Idempotency: double-click / network-retry ⇒ return the already-created invoice.
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "workOrder.deliver", input.clientRequestId, requestFingerprint);
      if (existingId != null) {
        const inv = (await tx.select({ invoiceNumber: invoices.invoiceNumber, status: invoices.status })
          .from(invoices).where(eq(invoices.id, existingId)).limit(1))[0];
        return {
          workOrderId: input.workOrderId,
          invoiceId: existingId,
          invoiceNumber: inv?.invoiceNumber ?? "",
          status: inv?.status ?? "PENDING",
          idempotentReplay: true as const,
          branchId: actor.branchId ?? 0,
        };
      }
    }
    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (input.clientRequestId) {
      const replayAfterLock = await checkIdempotency(tx, "workOrder.deliver", input.clientRequestId, requestFingerprint, { forUpdate: true });
      if (replayAfterLock != null) {
        const inv = (await tx.select({ invoiceNumber: invoices.invoiceNumber, status: invoices.status })
          .from(invoices).where(eq(invoices.id, replayAfterLock)).limit(1))[0];
        return {
          workOrderId: input.workOrderId,
          invoiceId: replayAfterLock,
          invoiceNumber: inv?.invoiceNumber ?? "",
          status: inv?.status ?? "PENDING",
          idempotentReplay: true as const,
          branchId: Number(wo.branchId),
        };
      }
    }
    if (wo.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس جاهزاً للتسليم" });
    // (حُذف حارسُ اعتماد التصميم — قرار المالك ١/٩/٢٦؛ التعليل في `lifecycle.startWorkOrder`.)
    // إخوةُ السلّة الواحدة: التسليمُ المباشر مخرجٌ ثالثٌ كان يفلت من حارس الإرسال الجزئيّ،
    // ومسوّدةٌ كلُّها أوامرُ شغل لا تصل إليه أصلاً (لا فاتورة بضاعةٍ لها).
    await assertSiblingsReady(tx, {
      draftId: wo.draftId,
      excludeWorkOrderId: input.workOrderId,
      confirmed: input.partialDispatchConfirmed === true,
      action: "deliver",
    });
    // أمرٌ مخصّص للتوصيل لا يجوز إغلاقه من مسار الاستلام المباشر. هذا المسار لا ينشئ
    // deliveryConsignment؛ السماح به كان يحوّل الأمر إلى DELIVERED ثم يُسقطه من طابور
    // التوصيل بلا أي سجل يستطيع المندوب/الشركة رؤيته.
    if (wo.hasDelivery) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "هذا الطلب مخصّص للتوصيل — أسنده من «إدارة التوصيل» ولا تستخدم التسليم المباشر",
      });
    }
    await assertNoLiveConsignment(tx, Number(wo.id), "deliver");

    // معالجة التسليم المباشر لأمر شغل سبق إصدار فاتورته عند الإسناد للتوصيل ثم أُلغي الإسناد
    // أو أُعيد الطرد إلى READY دون عكس البيع: نسوّي الفاتورة القائمة دون إنشاء فاتورة أو SALE ثانٍ.
    if (wo.invoiceId != null) {
      const paidNow = money(input.payment?.amount ?? "0");
      const paymentReference = input.payment?.reference?.trim() || null;
      if (paidNow.lt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "المبلغ المدفوع لا يمكن أن يكون سالباً",
            why: `المبلغ المُرسَل (${paidNow.toFixed(2)}) أقل من الصفر`,
            doThis: "أدخل مبلغاً موجباً أو صفراً عند التسليم",
          }),
        });
      }
      if (paidNow.gt(0) && input.payment?.method !== "CASH" && !paymentReference) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "مرجع عملية البطاقة/التحويل مطلوب",
            why: "وسائل الدفع غير النقدية تتطلّب رقم مرجع لإثبات التحصيل",
            doThis: "أدخل رقم مرجع عملية البطاقة أو التحويل ثم أعد المحاولة",
          }),
        });
      }

      const [existingInv] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, Number(wo.invoiceId)))
        .for("update")
        .limit(1);
      if (!existingInv) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تسليم الطلب — الفاتورة المرتبطة غير موجودة",
            why: `أمر الشغل مرتبط بمعرّف فاتورة (${Number(wo.invoiceId)}) غير موجود في السجلات`,
            doThis: "راجع سجل الفواتير المرتبطة بالطلب مع المدير قبل إعادة المحاولة",
          }),
        });
      }
      if (isDeadInvoiceStatus(existingInv.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر التسليم المباشر على فاتورةٌ صادرة سلفاً بحالة منتهية",
            why: `الفاتورة المرتبطة ${existingInv.invoiceNumber} بحالة ${existingInv.status} (ملغاة أو مرتجعة)`,
            doThis: "راجع حالة الفاتورة المرتبطة بالطلب قبل محاولة التسليم المباشر",
          }),
        });
      }

      const existingRemaining = round2(
        money(existingInv.total)
          .minus(money(existingInv.returnedTotal ?? "0"))
          .minus(money(existingInv.paidAmount ?? "0")),
      );
      if (paidNow.gt(existingRemaining)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `دفعة التسليم (${paidNow.toFixed(2)}) تتجاوز المتبقي على الفاتورة ${existingInv.invoiceNumber} (${existingRemaining.toFixed(2)})`,
            why: `إجمالي الفاتورة ${money(existingInv.total).toFixed(2)} والمسدَّد سابقاً ${money(existingInv.paidAmount ?? "0").toFixed(2)}`,
            doThis: `أدخل مبلغاً لا يتجاوز المتبقي (${existingRemaining.toFixed(2)}) د.ع`,
          }),
        });
      }

      const remainingAfterPay = round2(existingRemaining.minus(paidNow));
      const woPaymentMode = (wo.paymentMode ?? "PREPAID") as CodPaymentMode;
      if (requiresFullPaymentAtHandover(woPaymentMode, !!wo.hasDelivery) && remainingAfterPay.gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: COD_PICKUP_PAYMENT_ERROR_AR(remainingAfterPay.toFixed(2)),
        });
      }
      const isElevated = actor.role === "manager" || actor.role === "admin";
      const effectiveCustomerId =
        existingInv.customerId != null
          ? Number(existingInv.customerId)
          : wo.customerId != null
            ? Number(wo.customerId)
            : null;

      if (remainingAfterPay.gt(0)) {
        if (!input.addToCustomerDebt) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "لا يمكن تسليم الطلب بمتبقٍ مالي غير مستحصل — لهذا الطلب فاتورةٌ صادرة سلفاً",
              why: `يوجد متبقٍ غير مدفوع بقيمة ${remainingAfterPay.toFixed(2)} د.ع على الفاتورة ${existingInv.invoiceNumber}`,
              doThis: "حصّل كامل المبلغ المتبقي عند التسليم أو فعّل خيار البيع الآجل باعتماد المدير",
            }),
          });
        }
        if (effectiveCustomerId == null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "طلب الخدمة الآجل يتطلب عميلاً محدداً",
              why: `يتبقّى مبلغ ${remainingAfterPay.toFixed(2)} د.ع ولا يوجد عميل مرتبط بالطلب أو الفاتورة`,
              doThis: "اربط أمر الشغل بعميل مسجّل أولاً أو حصّل كامل المتبقي عند التسليم",
            }),
          });
        }
        if (!isElevated && !input.managerOverrideByUserId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "اعتماد المدير مطلوب لإضافة المتبقي لذمة العميل",
              why: `الموظف الحالي ليس مديراً ويلزم اعتماد مسؤول لإبقاء ${remainingAfterPay.toFixed(2)} د.ع في ذمة العميل`,
              doThis: "أدخل اعتماد المدير لإتمام التسليم الآجل أو استوفِ كامل المبلغ المتبقي",
            }),
          });
        }
      }

      const receptionShiftRow = (
        await tx
          .select({ id: shifts.id })
          .from(shifts)
          .where(
            and(
              eq(shifts.userId, actor.userId),
              eq(shifts.branchId, Number(wo.branchId)),
              eq(shifts.status, "OPEN"),
              eq(shifts.shiftType, "RECEPTION"),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      const deliveryShiftId = receptionShiftRow ? Number(receptionShiftRow.id) : null;
      if (input.payment?.method === "CASH" && paidNow.gt(0) && deliveryShiftId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر قبض دفعة التسليم نقداً بلا وردية استقبال مفتوحة",
            why: "لا يجوز إدخال نقد في درج الاستقبال (DRAWER) دون وردية RECEPTION مفتوحة للمستخدم الحالي",
            doThis: "افتح وردية RECEPTION أولاً ثم أعد تنفيذ التسليم والتحصيل",
          }),
        });
      }
      await lockMaterializedCashReceiptSourceForWrite(tx, {
        branchId: Number(wo.branchId),
        shiftId: deliveryShiftId,
        cashBucket: input.payment?.method === "CASH" && paidNow.gt(0) ? "DRAWER" : null,
        paymentMethod: input.payment?.method ?? "CASH",
        status: paidNow.gt(0) ? "COMPLETED" : "PENDING",
        approvalStatus: "APPROVED",
      });

      if (
        existingInv.customerId == null &&
        effectiveCustomerId != null &&
        remainingAfterPay.gt(0) &&
        !(await readOpeningWindowState(tx)).active
      ) {
        const hasCreditOverride = Boolean(
          input.addToCustomerDebt && (isElevated || input.managerOverrideByUserId != null),
        );
        if (!hasCreditOverride) {
          await assertCreditLimit(
            tx,
            effectiveCustomerId,
            remainingAfterPay,
            Number(wo.branchId),
            woPaymentMode,
          );
        }
      }

      if (effectiveCustomerId != null) {
        await tx
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, effectiveCustomerId))
          .for("update")
          .limit(1);
      }

      const nextPaidAmount = round2(money(existingInv.paidAmount ?? "0").plus(paidNow));
      const nextInvStatus = computeInvoiceStatus(
        String(existingInv.total),
        toDbMoney(nextPaidAmount),
        String(existingInv.returnedTotal ?? "0"),
      );

      if (paidNow.gt(0)) {
        const rRes = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId: deliveryShiftId,
          direction: "IN",
          amount: toDbMoney(paidNow),
          paymentMethod: input.payment!.method,
          cashBucket: input.payment!.method === "CASH" ? "DRAWER" : null,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          referenceNumber: paymentReference,
          invoiceId: Number(existingInv.id),
          createdBy: actor.userId,
        });
        const receiptId = extractInsertId(rRes);
        const paymentRole = paymentAssetRole(
          input.payment!.method,
          input.payment!.method === "CASH" ? "DRAWER" : null,
          "IN",
        );
        const paymentPostingSource = {
          roleDebits: { [paymentRole]: paidNow },
          roleCredits: { AR: paidNow },
        };
        await postEntry(tx, {
          entryType: "PAYMENT_IN",
          branchId: Number(wo.branchId),
          invoiceId: Number(existingInv.id),
          receiptId,
          customerId: effectiveCustomerId,
          amount: paidNow,
          paymentMethod: input.payment!.method,
          postingIntent: createPostingIntent(
            "PAYMENT_IN_CUSTOMER",
            "PAYMENT_IN",
            [debitLine(paymentRole, paidNow), creditLine("AR", paidNow)],
            paymentPostingSource,
          ),
          postingSourceComponents: paymentPostingSource,
        });

        const nextPaymentMethod = mixedAwarePaymentMethod(
          existingInv.paymentMethod ?? null,
          input.payment!.method,
        );
        await tx
          .update(invoices)
          .set({
            paidAmount: toDbMoney(nextPaidAmount),
            status: nextInvStatus,
            paymentMethod: nextPaymentMethod,
            paymentDate: new Date(),
            ...(existingInv.customerId == null && effectiveCustomerId != null
              ? { customerId: effectiveCustomerId }
              : {}),
            ...(existingInv.shiftId == null && deliveryShiftId != null
              ? { shiftId: deliveryShiftId }
              : {}),
          })
          .where(eq(invoices.id, Number(existingInv.id)));

        if (existingInv.customerId != null) {
          await adjustCustomerBalance(tx, Number(existingInv.customerId), paidNow.neg());
        } else if (effectiveCustomerId != null && remainingAfterPay.gt(0)) {
          await adjustCustomerBalance(tx, effectiveCustomerId, remainingAfterPay);
        }
      } else if (
        (existingInv.customerId == null && effectiveCustomerId != null) ||
        (existingInv.shiftId == null && deliveryShiftId != null)
      ) {
        await tx
          .update(invoices)
          .set({
            ...(existingInv.customerId == null && effectiveCustomerId != null
              ? { customerId: effectiveCustomerId }
              : {}),
            ...(existingInv.shiftId == null && deliveryShiftId != null
              ? { shiftId: deliveryShiftId }
              : {}),
          })
          .where(eq(invoices.id, Number(existingInv.id)));
        if (existingInv.customerId == null && effectiveCustomerId != null && remainingAfterPay.gt(0)) {
          await adjustCustomerBalance(tx, effectiveCustomerId, remainingAfterPay);
        }
      }

      const deliveredAt = new Date();
      await tx
        .update(workOrders)
        .set({
          status: "DELIVERED",
          kanbanState: "NORMAL",
          blockedReason: null,
          deliveredAt,
        })
        .where(eq(workOrders.id, Number(wo.id)));

      await recordWorkOrderEvent(tx, {
        workOrderId: Number(wo.id),
        eventType: "DELIVERED",
        fromStatus: wo.status,
        toStatus: "DELIVERED",
        payload: {
          invoiceId: Number(existingInv.id),
          invoiceNumber: existingInv.invoiceNumber,
          paidNow: toDbMoney(paidNow),
          reusedPriorInvoice: true,
        },
        actorUserId: actor.userId,
        branchId: Number(wo.branchId),
        seq: Number(existingInv.id),
      });

      await logAuditTx(
        tx,
        { userId: actor.userId, branchId: Number(wo.branchId) },
        {
          action: "workOrder.deliver",
          entityType: "workOrder",
          entityId: Number(wo.id),
          branchId: Number(wo.branchId),
          oldValue: { status: wo.status, invoiceId: Number(existingInv.id) },
          newValue: {
            status: "DELIVERED",
            invoiceId: Number(existingInv.id),
            invoiceNumber: existingInv.invoiceNumber,
            invoiceStatus: nextInvStatus,
            paidNow: toDbMoney(paidNow),
            reusedPriorInvoice: true,
          },
        },
      );

      if (input.clientRequestId) {
        await recordIdempotencyKey(
          tx,
          "workOrder.deliver",
          input.clientRequestId,
          Number(existingInv.id),
          requestFingerprint,
        );
      }

      return {
        workOrderId: Number(wo.id),
        invoiceId: Number(existingInv.id),
        invoiceNumber: existingInv.invoiceNumber,
        status: nextInvStatus,
        branchId: Number(wo.branchId),
      };
    }

    // ─── تصحيح تلقائي ذري للأوامر التاريخية ─────────────────────────────────
    // الأوامر التي أُنشئت قبل هجرة 0363 لديها baseVariantId لكن لقطة الوحدة/الكمية
    // مفقودة. نصحّحها داخل نفس المعاملة كي يُسلَّم الأمر فوراً دون تدخل يدوي.
    if (wo.baseVariantId != null && (wo as any).baseProductUnitId == null) {
      // أ) نجلب أفضل وحدة للصنف (نفس أولوية create.ts)
      const allUnits = await tx
        .select({
          id: productUnits.id,
          isBaseUnit: productUnits.isBaseUnit,
          isActive: productUnits.isActive,
          conversionFactor: productUnits.conversionFactor,
        })
        .from(productUnits)
        .where(eq(productUnits.variantId, Number(wo.baseVariantId)));

      type UnitRow = typeof allUnits[number];
      const pickBestUnit = (rows: UnitRow[]): UnitRow | undefined => {
        const byIdAsc = (a: UnitRow, b: UnitRow) => Number(a.id) - Number(b.id);
        const t1 = rows.filter((u) => u.isBaseUnit && u.isActive);
        if (t1.length) return t1.sort(byIdAsc)[0];
        const t2 = rows.filter((u) => u.isActive && Number(u.conversionFactor) === 1);
        if (t2.length) return t2.sort(byIdAsc)[0];
        const t3 = rows.filter((u) => u.isBaseUnit);
        if (t3.length) return t3.sort(byIdAsc)[0];
        return rows.sort(byIdAsc)[0];
      };
      const bestUnit = pickBestUnit(allUnits);

      // ب) نجلب isService للصنف لتحديد baseConsumesInventory
      const productRow = bestUnit
        ? (
            await tx
              .select({ isService: products.isService })
              .from(productVariants)
              .innerJoin(products, eq(productVariants.productId, products.id))
              .where(eq(productVariants.id, Number(wo.baseVariantId)))
              .limit(1)
          )[0]
        : undefined;

      if (bestUnit && productRow != null) {
        const convFactor = Number(bestUnit.conversionFactor);
        const computedBaseQty = Math.round(Number(wo.quantity) * convFactor);
        const baseConsumesInventory = productRow.isService === false;

        // ج) تحديث ذري داخل المعاملة — WHERE idempotency guard
        await tx.execute(
          sql`UPDATE \`workOrders\`
              SET \`baseProductUnitId\`     = ${Number(bestUnit.id)},
                  \`baseBaseQuantity\`      = ${computedBaseQty},
                  \`baseConsumesInventory\` = ${baseConsumesInventory ? 1 : 0}
              WHERE id = ${Number(wo.id)}
                AND \`baseProductUnitId\` IS NULL`,
        );

        // د) نُحدّث wo في الذاكرة كي تراه requireWorkOrderBaseSnapshot
        (wo as any).baseProductUnitId    = Number(bestUnit.id);
        (wo as any).baseBaseQuantity     = computedBaseQty;
        (wo as any).baseConsumesInventory = baseConsumesInventory;
      }
      // هـ) إن لم نجد وحدة → تمرير كـnull (يُعامَل كأمر خدمة خالصة بلا سطر مخزون)
    }
    // ─────────────────────────────────────────────────────────────────────────

    // أمر خدمة خالص (بلا منتج أساس): الفاتورة بلا سطر مخزون (invoiceItems.variantId = NOT NULL FK).
    // كانت deliver السابقة تُدرج variantId = Number(null) = 0 ⇒ انتهاك FK ⇒ تعذّر تسليم أوامر
    // التخصيص الخالصة. الآن: سطرٌ فقط حين يوجد منتج أساس؛ صافي الفاتورة/القيد محفوظ بـsalePrice.
    const baseSnapshot = requireWorkOrderBaseSnapshot(wo as any);
    if (baseSnapshot) await assertBaseProductUnitBinding(tx, baseSnapshot);
    const hasBaseVariant = baseSnapshot != null;

    const quantity = wo.quantity;
    const salePrice = money(wo.salePrice);
    const unitPrice = round2(salePrice.dividedBy(quantity));
    const materialsCost = money(wo.materialsCost);
    const laborCost = money(wo.laborCost);
    const costTotal = round2(materialsCost.plus(laborCost));

    // Credit-sale guard. العربون المقبوض سابقاً (receipt+PAYMENT_IN عند الإنشاء) يُضمّ لمدفوع الفاتورة.
    const paidNow = money(input.payment?.amount ?? "0");
    const paymentReference = input.payment?.reference?.trim() || null;
    if (paidNow.gt(0) && input.payment?.method !== "CASH" && !paymentReference) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع عملية البطاقة/التحويل مطلوب" });
    }
    const depositPaid = round2(money(wo.deposit ?? "0"));
    const appliedDepositParts = depositPaid.gt(0)
      ? await appliedCollectionsForWorkOrder(tx, Number(wo.id))
      : [];
    const appliedDepositTotal = round2(
      appliedDepositParts.reduce((sum, part) => sum.plus(money(part.amount)), money(0)),
    );
    const directDepositExpected = round2(depositPaid.minus(appliedDepositTotal));
    if (directDepositExpected.lt(0)) {
      throw new TRPCError({ code: "CONFLICT", message: "حصص العربون المطبقة تتجاوز عربون أمر الشغل" });
    }
    const appliedReceiptIds = Array.from(new Set(
      appliedDepositParts.map((part) => part.receiptId).filter((id): id is number => id != null),
    ));
    if (appliedDepositParts.some((part) => part.receiptId == null)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "عربون أمر الشغل يحتوي قبضاً قديماً بلا إيصال قابل لإثبات التنفيذ",
      });
    }
    const directDepositReceipts = await loadWorkOrderDepositReceiptSet(tx, wo, directDepositExpected.toFixed(2));
    let depositPaymentMethod: string | null = depositPaid.gt(0) ? (wo.paymentMethod ?? null) : null;
    for (const receipt of directDepositReceipts) depositPaymentMethod = mixedAwarePaymentMethod(depositPaymentMethod, receipt.paymentMethod);
    if (appliedReceiptIds.length) {
      const appliedReceipts = await tx
        .select({
          id: receipts.id,
          direction: receipts.direction,
          status: receipts.status,
          approvalStatus: receipts.approvalStatus,
          paymentMethod: receipts.paymentMethod,
        })
        .from(receipts)
        .where(inArray(receipts.id, appliedReceiptIds))
        .for("update");
      const validIds = new Set(
        appliedReceipts
          .filter((receipt) => receipt.direction === "IN" && receipt.status === "COMPLETED" && receipt.approvalStatus === "APPROVED")
          .map((receipt) => Number(receipt.id)),
      );
      if (appliedReceiptIds.some((id) => !validIds.has(id))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يُحتسب عربون غير منفذ: يلزم إيصال IN بحالة COMPLETED واعتماد APPROVED",
        });
      }
      for (const receipt of appliedReceipts) {
        if (receipt.paymentMethod) {
          depositPaymentMethod = mixedAwarePaymentMethod(depositPaymentMethod, receipt.paymentMethod);
        }
      }
    }
    const effectiveInvoicePaymentMethod =
      input.payment?.method != null
        ? mixedAwarePaymentMethod(depositPaymentMethod, input.payment.method)
        : depositPaymentMethod;
    const totalPaid = round2(depositPaid.plus(paidNow));
    if (paidNow.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع لا يمكن أن يكون سالباً" });
    if (totalPaid.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع (مع العربون) يتجاوز إجمالي الأمر" });
    if (totalPaid.lt(salePrice) && !wo.customerId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب الخدمة الآجل يتطلب عميلاً محدداً" });

    // H5: فحص حدّ الائتمان على الجزء الآجل قبل إنشاء الفاتورة (يَرمي FORBIDDEN عند التجاوز).
    // وضع الافتتاح (قرار المالك ١٠/٨): أثناء النافذة الفعّالة يُعفى تسليم أمر الشغل من حاجز الائتمان —
    // الجزء الآجل يُرحَّل ذمّةً على العميل (AR) كالمعتاد دون رفض. مؤقّتٌ وينتهي بانتهاء النافذة.
    //
    // paymentMode='COD' (٢٨/٨/٢٦، هجرة 0276): يُتجاوز فحصُ السقف حين الأمر مُصنَّفٌ COD صراحةً —
    // المندوب يحمل المسؤوليّة الماليّة (نمط codDispatchPending للاستقبال، لكن أعمّ). لكنّ حماية
    // «لا دينار صامت» تبقى: إن كان `unpaidPortion > 0` مع COD فهذا يعني المندوب لم يُحصِّل كاملاً،
    // وهو سيناريو مشروع (تسليم جزئيّ أُقرّ) لكن يفتح ذمّةً حقيقيّة تُعالَج كباقي الآجل.
    //
    // ٣٠/٨/٢٦ (بلاغ المالك — Slice O): COD للاستلام (بلا توصيل) صار مسموحاً في المسار — لكنّ
    // ضمان «لا دينار صامت» هنا حرِج: العميل يستلم بيده ولا مندوبَ يُحصِّل. نُلزم دفعاً كاملاً
    // لحظة التسليم (`totalPaid === salePrice`). خلافُه رفضٌ بـBAD_REQUEST برسالةٍ صريحة.
    // ثابتة السياسة + نصّ الرسالة في `@shared/codHandoverPolicy` (٦ اختبارات وحدة تحرسها).
    const unpaidPortion = round2(salePrice.minus(totalPaid));
    const woPaymentMode = (wo.paymentMode ?? "PREPAID") as CodPaymentMode;
    if (requiresFullPaymentAtHandover(woPaymentMode, !!wo.hasDelivery) && unpaidPortion.gt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: COD_PICKUP_PAYMENT_ERROR_AR(unpaidPortion.toFixed(2)),
      });
    }

    // حظر تسليم أي طلب استلام مباشر بمتبقٍ غير مستحصل بدون اعتماد مدير صريح لإضافته إلى ذمة العميل
    const isDirectPickup = !wo.hasDelivery;
    const isElevated = actor.role === "manager" || actor.role === "admin";
    if (isDirectPickup && unpaidPortion.gt(0)) {
      if (input.enforceDebtApproval || input.addToCustomerDebt !== undefined) {
        if (!input.addToCustomerDebt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "لا يمكن تسليم الطلب بمتبقٍ مالي غير مستحصل",
              why: `يوجد متبقٍ غير مدفوع بقيمة ${unpaidPortion.toFixed(2)} د.ع`,
              doThis: "استوفِ كامل المبلغ نقداً أو اطلب اعتماد المدير لإضافة المتبقي إلى ذمة العميل",
            }),
          });
        }
        if (!isElevated && !input.managerOverrideByUserId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "اعتماد المدير مطلوب لإضافة المتبقي لذمة العميل",
              why: `الموظف الحالي ليس مديراً ويلزم اعتماد مسؤول لتحويل ${unpaidPortion.toFixed(2)} د.ع لذمة العميل`,
              doThis: "أدخل بريد وكلمة مرور المدير لاعتماد العملية وإتمام التسليم",
            }),
          });
        }
      }
    }
    // ش١ (٥/٨): فاتورة التسليم تنتمي لوردية مُسلِّمها — كانت تُنشأ بلا shiftId فتسقط خارج
    // طابور فواتير المحطة (innerJoin shifts) وخارج نطاق reception.collectOnInvoice، بينما هي
    // **الحالة الأولى** لتسديد المتبقّي (عربونٌ مقبوض والباقي عند الاستلام). تُحلّ مبكراً وتُعاد
    // في إيصال الدفعة أدناه (نفس الوردية حتماً — لا انشطار درج).
    // مراجعة عدائية (٥/٨): الختم بوردية **RECEPTION حصراً** — openShiftIdTx المرن كان يلتقط
    // وردية RETAIL/PRINT_SERVICES الوحيدة فتسقط الفاتورة من طابور المحطة (innerJoin RECEPTION)
    // وتتضخّم Z تلك الوردية بمبيعاتٍ ليست لها. غيابها ⇒ null (سلوك ما قبل ش١، دلالة نظيفة).
    //
    // ⚠️ **موضعه هنا مُلزَمٌ بترتيب الأقفال** (فحص الحمل ٣٠/٨/٢٦ + مراجعة Codex على #901):
    // كان بعد العدّاد، ثم نُقل إلى ما بعد حارس الائتمان — وكلاهما خطأ لأنّ `assertCreditLimit`
    // **يقفل صفّ العميل**، فينتج ترتيب «عميل ← وردية» مقابل ترتيب البيع «وردية ← عميل»
    // (sale/create) ⇒ ABBA حين يتشارك بيعٌ وتسليمٌ متزامنان وردية الاستقبال نفسها والعميل نفسه.
    // الترتيب القانوني الوحيد: **وردية ← عميل ← عدّاد**، فيسبق هذا القفلُ كلَّ ما يمسّ العميل.
    // (أثرٌ جانبيّ مقصود: من لا وردية استقبالٍ له ويتجاوز سقف الائتمان معاً يرى رسالة الوردية
    // أوّلاً بدل رسالة الائتمان — كلتاهما حاجزٌ مشروع ولا أثر ماليّ للترتيب بينهما.)
    const receptionShiftRow = (
      await tx
        .select({ id: shifts.id })
        .from(shifts)
        .where(and(
          eq(shifts.userId, actor.userId),
          eq(shifts.branchId, Number(wo.branchId)),
          eq(shifts.status, "OPEN"),
          eq(shifts.shiftType, "RECEPTION"),
        ))
        .for("update")
        .limit(1)
    )[0];
    const deliveryShiftId = receptionShiftRow ? Number(receptionShiftRow.id) : null;
    if (input.payment?.method === "CASH" && paidNow.gt(0) && deliveryShiftId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "افتح وردية RECEPTION قبل قبض دفعة أمر الشغل نقداً؛ لا يجوز DRAWER بلا وردية استقبال مقفلة",
      });
    }
    await lockMaterializedCashReceiptSourceForWrite(tx, {
      branchId: Number(wo.branchId),
      shiftId: deliveryShiftId,
      cashBucket: input.payment?.method === "CASH" && paidNow.gt(0) ? "DRAWER" : null,
      paymentMethod: input.payment?.method ?? "CASH",
      status: paidNow.gt(0) ? "COMPLETED" : "PENDING",
      approvalStatus: "APPROVED",
    });

    if (wo.customerId && unpaidPortion.gt(0) && !(await readOpeningWindowState(tx)).active) {
      const hasCreditOverride = Boolean(input.addToCustomerDebt && (isElevated || input.managerOverrideByUserId != null));
      if (!hasCreditOverride) {
        await assertCreditLimit(tx, Number(wo.customerId), unpaidPortion, Number(wo.branchId), woPaymentMode);
      }
    }

    // ترتيب الأقفال القانوني (فحص الحمل ٣٠/٨/٢٦): صفّ العميل يُقفَل **قبل** عدّاد الترقيم دائماً،
    // كما في sale/create (وردية ثم العميل ثم العدّاد). كان القفل هنا مشروطاً بحارس الائتمان أعلاه،
    // فإذا تخطّاه المسار (نافذة الافتتاح أو COD) انقلب الترتيب: عدّاد ← عميل (adjustCustomerBalance
    // أدناه) مقابل بيعٍ متزامنٍ عميل ← عدّاد ⇒ ABBA deadlock حتميّ الاحتمال. قفلٌ غير مشروط
    // يوحّد الاتجاه؛ وإن سبقه حارسُ الائتمان فالصفّ محجوز أصلاً والقفل هنا لا يكلف شيئاً.
    if (wo.customerId) {
      await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, Number(wo.customerId)))
        .for("update")
        .limit(1);
    }

    // Invoice number — collision-safe delivery invoice number inheriting unified tracking number
    const invoiceNumber = await resolveDeliveryInvoiceNumber(tx, wo.orderNumber, Number(wo.branchId));
    const status = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(totalPaid));
    const sourceId = workOrderInvoiceSourceId(wo);
    /**
     * **نسبة البيع لمنشئ الطلب لا للمُسلِّم** (١٩/٨ — قاعدة #638: «العمولة تتبع البائع
     * الأصليّ»). فاتورة أمر الشغل تُنشأ لحظة التسليم، وقد ينفّذه كاشيرٌ آخر عن الذي استقبل
     * الطلب وباعه فعلاً — فكان `createdBy = actor` ينسب البيعَ والعمولةَ للمُسلِّم، وتقارير
     * الموظفين تعرض اسمه، بينما البائع الحقيقيّ لا أثر له.
     *
     * وأثرُ المُسلِّم **يبقى كاملاً بلا عمودٍ جديد**: إيصال القبض بـ`createdBy = actor`،
     * والفاتورة تُختم بوردية المُسلِّم (`deliveryShiftId` أدناه) ⇒ النقد والدرج وZ كلّها
     * عليه — وهو الصحيح مالياً: النقد في درجه هو.
     */
    const sellerUserId = wo.createdBy != null ? Number(wo.createdBy) : actor.userId;
    const salespersonNameSnapshot = await userNameSnapshot(tx, sellerUserId);
    const invRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId,
      shiftId: deliveryShiftId,
      branchId: Number(wo.branchId),
      customerId: wo.customerId ?? null,
      priceTier: "RETAIL",
      subtotal: salePrice.toFixed(2),
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: salePrice.toFixed(2),
      costTotal: costTotal.toFixed(2),
      status,
      paidAmount: toDbMoney(totalPaid),
      paymentMethod: effectiveInvoicePaymentMethod,
      // Codex #854 P2: نشرُ paymentMode من الأمر إلى الفاتورة عند التسليم — الأمرُ ومستنده
      // التجاريّ يجب أن يتّفقا على «كيف حُصِّل الرصيد».
      paymentMode: woPaymentMode,
      paymentDate: totalPaid.gt(0) ? new Date() : null,
      notes: `طلب خدمة ${wo.orderNumber}: ${wo.title}`,
      salespersonNameSnapshot,
      createdBy: sellerUserId,
    });
    const invoiceId = extractInsertId(invRes);
    const productNameRow = hasBaseVariant
      ? (await tx
          .select({ name: products.name, invoiceLabel: products.invoiceLabel, shortTitle: products.shortTitle })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(eq(productVariants.id, baseSnapshot!.variantId))
          .limit(1))[0]
      : null;
    const itemNameSnapshot = productNameRow ? titleForChannel(productNameRow, "invoice") : null;
    if (hasBaseVariant) {
      await tx.insert(invoiceItems).values({
        invoiceId,
        variantId: baseSnapshot!.variantId,
        productUnitId: baseSnapshot!.productUnitId,
        workOrderId: Number(wo.id),
        quantity: Number(quantity).toFixed(3),
        baseQuantity: baseSnapshot!.baseQuantity,
        unitPrice: unitPrice.toFixed(2),
        unitCost: round2(costTotal.dividedBy(quantity)).toFixed(2),
        discountAmount: "0",
        total: salePrice.toFixed(2),
        itemNameSnapshot,
      });
    }

    // Ledger: SALE entry (no stock movement here — already consumed at start).
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`, // حارس بنيوي: قيد SALE واحد لكل فاتورة
      branchId: Number(wo.branchId),
      invoiceId,
      customerId: wo.customerId ?? null,
      revenue: salePrice,
      cost: materialsCost,
      profit: round2(salePrice.minus(materialsCost)),
      amount: salePrice,
      createdBy: sellerUserId,
      createdByNameSnapshot: salespersonNameSnapshot,
      notes: `تكلفة أمر الشغل التحليلية=${toDbMoney(costTotal)}؛ مواد COGS/WIP=${toDbMoney(materialsCost)}؛ أجور تحليلية غير مرسملة=${toDbMoney(laborCost)} (تظهر في فاتورة/تقرير ربحية الأمر، والأجر الفعلي في قيود الرواتب/المصروف)`,
      postingIntent: createPostingIntent("SALE_SERVICE_FLEX", "SALE", [debitLine("AR", salePrice), creditLine("SALES_FLEX", salePrice), ...(materialsCost.isZero() ? [] : [debitLine("COGS", materialsCost), creditLine("WORK_IN_PROGRESS", materialsCost)]), ...(depositPaid.isZero() ? [] : [debitLine("OTHER_LIABILITY", depositPaid), creditLine("AR", depositPaid)])], { roleDebits: { AR: salePrice, OTHER_LIABILITY: depositPaid, COGS: materialsCost }, roleCredits: { SALES_FLEX: salePrice, WORK_IN_PROGRESS: materialsCost, AR: depositPaid } }),
      postingSourceComponents: { roleDebits: { AR: salePrice, OTHER_LIABILITY: depositPaid, COGS: materialsCost }, roleCredits: { SALES_FLEX: salePrice, WORK_IN_PROGRESS: materialsCost, AR: depositPaid } },
    });

    // AR if credit portion (المتبقّي بعد العربون + دفعة التسليم).
    if (wo.customerId) {
      const unpaid = round2(salePrice.minus(totalPaid));
      if (unpaid.gt(0)) await adjustCustomerBalance(tx, Number(wo.customerId), unpaid);
    }

    // A1 (١٩/٦/٢٦) — append-only:
    // - receipt.invoiceId يُحدَّث (المقبوضات قابلة للنقل: ليست قيوداً محاسبية).
    // - accountingEntries.invoiceId يبقى NULL على قيد العربون (الـPAYMENT_IN الأصلي) ⇒ append-only صارم.
    // الإقفال محاسبياً: deposit مُحتسَب في invoice.paidAmount عند التسليم (totalPaid). reconcileService
    // يستثني قيد العربون من voucherSum عبر فلتر receipt.workOrderId NOT NULL (لا يعتمد على entry.invoiceId).
    if (depositPaid.gt(0)) {
      // ش٠ (V3): هويّة إيصال العربون من عموده الصريح — الالتقاط القديم بـ`.limit(1)` على
      // (workOrderId, invoiceId NULL) كان يتصادم مع إيصال أجرة COUNTER (نفس البصمة) فقد يربط
      // إيصال الأجرة بالفاتورة بدل العربون. البديل الاحتياطي (أوامر قديمة قبل 0151 لم يلتقطها
      // backfill) يستثني إيصالات الأجرة صراحةً.
      for (const receipt of directDepositReceipts) {
        await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(receipt.id)));
      }
      // ش٤: حصص العربون المقبوضة **سلفاً** (مسوّدة ⇒ orderPayments APPLICATION على هذا الأمر) —
      // إيصال القبض أحاديّ الهدف يُختم بفاتورة التسليم (نفس نمط append-only أعلاه)؛ المُشظّى
      // بين أهدافٍ يبقى بلا ختم وحقيقتُه في orderPayments (I4). depositReceiptId يحمل N وحده.
      await linkSoleTargetCollectionsToInvoice(tx, Number(wo.id), invoiceId);
    }

    // Optional payment receipt + PAYMENT_IN entry.
    if (paidNow.gt(0)) {
      // انسب الدفع النقدي لوردية الموظّف المفتوحة (تسوية الصندوق/Z-report) — تفضيل وردية الاستقبال.
    // الدفعة النقدية لا تدخل إلا درج RECEPTION المقفول نفسه الذي خُتمت به الفاتورة.
      const shiftId = deliveryShiftId;
      const rRes = await tx.insert(receipts).values({
        branchId: Number(wo.branchId),
        shiftId,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        // cashBucket='DRAWER' للنقد ⇒ يَدخل تسوية الدرج/Z-report (مرآة createSale/processPayment).
        cashBucket: input.payment!.method === "CASH" ? "DRAWER" : null,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: paymentReference,
        invoiceId,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      const paymentRole = paymentAssetRole(input.payment!.method, input.payment!.method === "CASH" ? "DRAWER" : null, "IN");
      const paymentPostingSource = {
        roleDebits: { [paymentRole]: paidNow },
        roleCredits: { AR: paidNow },
      };
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: Number(wo.branchId),
        invoiceId,
        receiptId,
        customerId: wo.customerId ?? null,
        amount: paidNow,
        paymentMethod: input.payment!.method, // دلو النقد للدفتر المزدوج (لا يُخزَّن)
        postingIntent: createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [debitLine(paymentRole, paidNow), creditLine("AR", paidNow)], paymentPostingSource),
        postingSourceComponents: paymentPostingSource,
      });
    }

    await tx
      .update(workOrders)
      .set({
        status: "DELIVERED",
        kanbanState: "NORMAL",
        blockedReason: null,
        invoiceId,
        deliveredAt: new Date(),
      })
      .where(eq(workOrders.id, Number(wo.id)));

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "workOrder.deliver", input.clientRequestId, invoiceId, requestFingerprint);
    }

    return {
      workOrderId: Number(wo.id),
      invoiceId,
      invoiceNumber,
      status,
      branchId: Number(wo.branchId),
    };
  }
}

export function publishWorkOrderDeliveredRealtime(
  result: Pick<DeliverWorkOrderTxResult, "workOrderId" | "branchId" | "idempotentReplay">,
  actorUserId: number,
): void {
  if (result.idempotentReplay) return;
  try {
    publishRealtimeEvent<WorkOrderStatusChangedPayload>(
      REALTIME_EVENT_TYPES.WORK_ORDER_STATUS_CHANGED,
      {
        workOrderId: result.workOrderId,
        branchId: result.branchId,
        previousStatus: "READY",
        newStatus: "DELIVERED",
        updatedBy: actorUserId,
      },
      { branchId: result.branchId },
    );
    publishRealtimeEvent<ReceptionQueueUpdatedPayload>(
      REALTIME_EVENT_TYPES.RECEPTION_QUEUE_UPDATED,
      {
        orderId: result.workOrderId,
        branchId: result.branchId,
        status: "DELIVERED",
        readyForPickup: false,
      },
      { branchId: result.branchId },
    );
  } catch {
    // fail-safe
  }
}

/** READY → DELIVERED: create invoice (sourceType=WORKORDER) + optional payment + SALE entry + AR adjust. */
export async function deliverWorkOrder(input: DeliverWorkOrderInput, actor: Actor & { role?: string }) {
  if (input.payment) assertPosPaymentMethodEnabled(input.payment.method);
  const result = await withTx((tx) => deliverWorkOrderInTx(tx, input, actor));
  publishWorkOrderDeliveredRealtime(result, actor.userId);

  return {
    workOrderId: result.workOrderId,
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber,
    status: result.status,
    ...(result.idempotentReplay ? { idempotentReplay: true as const } : {}),
  };
}
