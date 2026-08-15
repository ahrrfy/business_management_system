// تسديد ذمّة مورد عبر الصيرفة: يخفض المحفظة (مبدأ+عمولة) ودين المورد؛ يُسجّل فرق الصرف والعمولة.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions, purchaseOrders, receipts, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustExchangeBalanceIqd, adjustSupplierBalance, adjustSupplierBalanceUsd, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { computeSignature, nextVoucherNumber } from "../voucher/helpers";
import { assertNonPhysicalOutReceipt } from "../cash/cashAvailability";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";
import { calculateSignedUsdMovement, persistSignedUsdControl } from "./reverse";
import { postExchangeControlReclassification } from "./controlClassification";

export interface SettleSupplierInput {
  exchangeHouseId: number;
  branchId: number;
  supplierId: number;
  purchaseOrderId?: number | null;
  currency: "USD" | "IQD";
  /** المبلغ المخصوم من المحفظة (المبدأ) بعملة المحفظة. */
  walletAmount: string;
  /** الدين الديناري المُطفأ من ذمّة المورد. */
  settledIqd?: string | null;
  /** مبلغ الدولار الذي وصل إلى المورد وأُطفئ من الفاتورة. */
  settledUsd?: string | null;
  /** عمولة الصيرفة بعملة المحفظة (تُخصم من المحفظة، مصروف). */
  commission?: string | null;
  /** سعر الصرف وقت التسديد (للتدقيق، عملة USD). */
  exchangeRate?: string | null;
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** تسديد ذمّة مورد عبر الصيرفة. يخفض المحفظة (مبدأ+عمولة) ودين المورد؛ يُسجّل فرق الصرف والعمولة.
 *  ⚠️ لا يمسّ الخزينة (النقد غادر عند الإيداع). فرق الصرف = settledIqd − (walletAmount بالدينار بالكلفة). */
export async function settleSupplierViaExchange(
  input: SettleSupplierInput,
  actor: Actor,
): Promise<{ txnId: number; txnNumber: string; fxDiff: string; receiptId: number | null; voucherNumber: string | null }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.settle", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        const receipt = t?.receiptId
          ? (await tx.select().from(receipts).where(eq(receipts.id, Number(t.receiptId))).limit(1))[0]
          : null;
        return { txnId: existing, txnNumber: t?.txnNumber ?? "", fxDiff: t?.fxDiff ?? "0.00", receiptId: receipt ? Number(receipt.id) : null, voucherNumber: receipt?.voucherNumber ?? null };
      }
    }
    const walletAmount = round2(input.walletAmount);
    let settledIqd = round2(input.settledIqd ?? 0);
    const settledUsd = round2(input.settledUsd ?? 0);
    const commission = round2(input.commission ?? 0);
    if (walletAmount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ التسديد يجب أن يكون موجباً" });
    if (commission.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمولة لا تكون سالبة" });

    // كل كاتب مالي في الفرع يبدأ ببوابة الفرع: تمنع سباق إقفال الشهر، وتوحّد
    // ترتيب الأقفال مع اعتماد سند المورد (branch→supplier→PO→house).
    await lockBranchMonthCloseGate(tx, input.branchId);
    const supplier = (await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).for("update").limit(1))[0];
    if (!supplier) throw new TRPCError({ code: "BAD_REQUEST", message: "المورد غير موجود" });

    let purchaseOrder: typeof purchaseOrders.$inferSelect | null = null;
    if (input.purchaseOrderId != null) {
      purchaseOrder = (await tx.select().from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId)).for("update").limit(1))[0] ?? null;
      if (!purchaseOrder) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الشراء غير موجودة" });
      if (Number(purchaseOrder.supplierId) !== input.supplierId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "فاتورة الشراء لا تخص المورد المحدد" });
      }
      if (purchaseOrder.agreedCurrency !== "USD" || !purchaseOrder.usdTotal || !purchaseOrder.agreedRate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المحددة ليست فاتورة مورد دولارية" });
      }
      if (settledUsd.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل مبلغ الدولار الذي سيصل إلى المورد" });
      }
      const remainingUsd = round2(
        money(purchaseOrder.usdTotal).minus(money(purchaseOrder.paidUsd)).minus(money(purchaseOrder.returnedUsd)),
      );
      if (settledUsd.gt(remainingUsd)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الدفع (${settledUsd.toFixed(2)}$) يتجاوز المتبقي على الفاتورة (${remainingUsd.toFixed(2)}$)`,
        });
      }
      settledIqd = round2(settledUsd.times(money(purchaseOrder.agreedRate)));
    }
    if (settledIqd.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الدين المُسوّى يجب أن يكون موجباً" });
    if (settledIqd.gt(money(supplier.currentBalance))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة التسديد تتجاوز رصيد المورد الدفتري" });
    }
    if (settledUsd.gt(0) && settledUsd.gt(money(supplier.currentBalanceUsd))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الدولار يتجاوز رصيد المورد الدولاري" });
    }

    const house = await lockHouse(tx, input.exchangeHouseId);
    const usdRate = money(house.usdCostRate); // عرض فقط؛ الحركة تستخدم carrying الموقّع أدناه.
    const controlBeforeIqd = input.currency === "USD"
      ? money(house.balanceUsdCarryingIqd)
      : money(house.balanceIqd);
    let controlAfterIqd = controlBeforeIqd;

    let walletCostIqd: Decimal;
    let commissionIqd: Decimal;
    let usdAmountCol = new Decimal(0);
    let iqdAmountCol = settledIqd;
    let finalUsdMovement: ReturnType<typeof calculateSignedUsdMovement> | null = null;
    let settlementFxDiff = new Decimal(0);

    if (input.currency === "USD") {
      if (purchaseOrder && !walletAmount.eq(settledUsd)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "عند الدفع من محفظة الدولار يجب أن يساوي المسحوب مبلغ الدولار الواصل للمورد" });
      }
      const oldUsd = money(house.balanceUsd);
      const oldCarrying = money(house.balanceUsdCarryingIqd);
      const sourceRate = input.exchangeRate
        ? money(input.exchangeRate)
        : oldUsd.isZero()
          ? settledIqd.div(walletAmount)
          : oldCarrying.abs().div(oldUsd.abs());
      if (sourceRate.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يلزم سعر مصدر موجب للتسديد الدولاري" });
      }
      const principalMovement = calculateSignedUsdMovement(
        oldUsd,
        oldCarrying,
        walletAmount.negated(),
        round2(walletAmount.times(sourceRate)),
      );
      walletCostIqd = round2(principalMovement.balanceCarryingIqd.minus(oldCarrying).abs());
      commissionIqd = commission.isZero() ? new Decimal(0) : round2(commission.times(sourceRate));
      finalUsdMovement = commission.isZero()
        ? principalMovement
        : calculateSignedUsdMovement(
          principalMovement.balanceUsd,
          principalMovement.balanceCarryingIqd,
          commission.negated(),
          commissionIqd,
        );
      // The supplier liability is extinguished at settledIqd, while the house
      // control moves at its exact signed carrying basis.  The FX line is the
      // balancing difference; commission remains a separate expense line.
      settlementFxDiff = round2(
        settledIqd
          .plus(commissionIqd)
          .plus(finalUsdMovement.balanceCarryingIqd.minus(oldCarrying)),
      );
      const totalUsdOut = walletAmount.plus(commission);
      const availUsd = money(house.balanceUsd);
      // يُطلَب التأكيد فقط عند أوّل عبورٍ من رصيدٍ غير سالب إلى سالب — لا عند تعميق دَينٍ قائم أصلاً.
      if (totalUsdOut.gt(availUsd) && availUsd.gte(0) && !input.confirmNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `التسديد سيجعل رصيد الدولار لدى الصيرفة سالباً (${availUsd.toFixed(2)}$ متاح مقابل ${totalUsdOut.toFixed(2)}$ مطلوب). أرسل confirmNegative=true للتجاوز.`,
        });
      }
      await persistSignedUsdControl(tx, input.exchangeHouseId, finalUsdMovement);
      controlAfterIqd = finalUsdMovement.balanceCarryingIqd;
      usdAmountCol = walletAmount;
    } else {
      // لفاتورة USD المسحوب هو الدينار الفعلي، بينما settledIqd قيمة الدين الدفترية بسعر التثبيت.
      if (!purchaseOrder && !walletAmount.eq(settledIqd)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "للتسديد بالدينار يجب تساوي المبلغ المسحوب والدين المُسوّى" });
      }
      walletCostIqd = walletAmount;
      commissionIqd = commission;
      const totalIqdOut = walletAmount.plus(commission);
      const availIqd = money(house.balanceIqd);
      // يُطلَب التأكيد فقط عند أوّل عبورٍ من رصيدٍ غير سالب إلى سالب — لا عند تعميق دَينٍ قائم أصلاً.
      if (totalIqdOut.gt(availIqd) && availIqd.gte(0) && !input.confirmNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `التسديد سيجعل رصيد الدينار لدى الصيرفة سالباً (${availIqd.toFixed(2)} متاح مقابل ${totalIqdOut.toFixed(2)} مطلوب). أرسل confirmNegative=true للتجاوز.`,
        });
      }
      await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, totalIqdOut.negated());
      controlAfterIqd = availIqd.minus(totalIqdOut);
      iqdAmountCol = walletAmount;
    }

    // فرق الصرف المحقَّق = الدين المُطفأ − كلفة ما خرج من المحفظة (بلا العمولة).
    const fxDiff = input.currency === "USD"
      ? settlementFxDiff
      : settledIqd.minus(walletCostIqd);

    // إطفاء دين المورد (التسديد الفعلي — هنا فقط).
    await adjustSupplierBalance(tx, input.supplierId, settledIqd.negated());
    if (settledUsd.gt(0)) {
      await adjustSupplierBalanceUsd(tx, input.supplierId, settledUsd.negated());
    }
    if (purchaseOrder) {
      await tx.update(purchaseOrders)
        .set({
          paidAmount: toDbMoney(money(purchaseOrder.paidAmount).plus(settledIqd)),
          paidUsd: toDbMoney(money(purchaseOrder.paidUsd).plus(settledUsd)),
        })
        .where(eq(purchaseOrders.id, Number(purchaseOrder.id)));
    }

    // قراءة الرصيد بعد كل الخصومات (لقطة الكشف).
    const after = (await tx.select().from(exchangeHouses).where(eq(exchangeHouses.id, input.exchangeHouseId)).limit(1))[0];

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "SETTLE",
      currency: input.currency,
      iqdAmount: toDbMoney(iqdAmountCol),
      usdAmount: toDbMoney(usdAmountCol),
      exchangeRate: settledUsd.gt(0)
        ? toDbRate(input.exchangeRate ? money(input.exchangeRate) : walletCostIqd.dividedBy(settledUsd))
        : (input.currency === "USD" ? toDbRate(money(input.exchangeRate ?? usdRate)) : "0.0000"),
      commission: toDbMoney(commission),
      commissionIqd: toDbMoney(commissionIqd),
      fxDiff: toDbMoney(fxDiff),
      supplierId: input.supplierId,
      purchaseOrderId: purchaseOrder ? Number(purchaseOrder.id) : null,
      settledUsd: toDbMoney(settledUsd),
      settledIqd: toDbMoney(settledIqd),
      balanceIqdAfter: after ? toDbMoney(money(after.balanceIqd)) : "0.00",
      balanceUsdAfter: after ? toDbMoney(money(after.balanceUsd)) : "0.00",
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    // سند الصرف والقيد وعملية الصيرفة في transaction واحدة: إما أن تُحفظ الأطراف كلها أو لا شيء.
    const voucherNumber = await nextVoucherNumber(tx, "PAYMENT", input.branchId);
    const voucherDate = toDateStr();
    const description = `تسديد مورد «${supplier.name}» عبر صيرفة «${house.name}»`;
    assertNonPhysicalOutReceipt({
      classification: "NON_CASH_METHOD", paymentMethod: "EXCHANGE", cashBucket: null,
      operation: "تسديد المورد عبر محفظة الصيرفة",
    });
    const receiptRes = await tx.insert(receipts).values({
      branchId: input.branchId, shiftId: null, cashBucket: null, direction: "OUT",
      amount: toDbMoney(settledIqd), paymentMethod: "EXCHANGE", referenceNumber: txnNumber,
      status: "COMPLETED", voucherNumber, partyType: "SUPPLIER", partyId: input.supplierId,
      description, voucherDate: new Date(`${voucherDate}T00:00:00.000Z`),
      approvalStatus: "APPROVED", approvedBy: actor.userId, approvedAt: new Date(), createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptRes);
    const signatureHash = computeSignature({
      id: receiptId, amount: toDbMoney(settledIqd), partyType: "SUPPLIER", partyId: input.supplierId,
      paymentMethod: "EXCHANGE", voucherDate, voucherNumber, createdBy: actor.userId,
      approvedBy: actor.userId, branchId: input.branchId,
    });
    await tx.update(receipts).set({ signatureHash }).where(eq(receipts.id, receiptId));
    await tx.update(exchangeTransactions).set({ receiptId }).where(eq(exchangeTransactions.id, txnId));
    const exchangeWalletRole = input.currency === "USD" ? "EXCHANGE_WALLET_USD" as const : "EXCHANGE_WALLET_IQD" as const;
    const settleComponents = {
      roleDebits: { AP: settledIqd },
      roleCredits: { [exchangeWalletRole]: settledIqd },
    } as const;

    // قيد التسديد (حركة إطفاء ذمّة، مُستثناة من الإيراد) مربوط بالسند.
    await postEntry(tx, {
      entryType: "EXCHANGE_SETTLE",
      branchId: input.branchId,
      receiptId,
      purchaseOrderId: purchaseOrder ? Number(purchaseOrder.id) : null,
      exchangeHouseId: input.exchangeHouseId,
      supplierId: input.supplierId,
      amount: settledIqd,
      dedupeKey: `EXSET:${txnNumber}`,
      notes: description,
      postingSourceComponents: settleComponents,
      postingIntent: createPostingIntent(
        "EXCHANGE_SETTLE_SUPPLIER",
        "EXCHANGE_SETTLE",
        [debitLine("AP", settledIqd), creditLine(exchangeWalletRole, settledIqd)],
        settleComponents,
      ),
    });

    // فرق الصرف المحقَّق (amount موقَّع، معزول عن إيراد البيع).
    if (!fxDiff.isZero()) {
      const fxAmount = fxDiff.abs();
      const fxComponents = fxDiff.isPositive()
        ? { roleDebits: { [exchangeWalletRole]: fxAmount }, roleCredits: { FX_GAIN: fxAmount } }
        : { roleDebits: { FX_LOSS: fxAmount }, roleCredits: { [exchangeWalletRole]: fxAmount } };
      await postEntry(tx, {
        entryType: "EXCHANGE_FX_DIFF",
        branchId: input.branchId,
        purchaseOrderId: purchaseOrder ? Number(purchaseOrder.id) : null,
        exchangeHouseId: input.exchangeHouseId,
        supplierId: input.supplierId,
        amount: fxDiff,
        dedupeKey: `EXFX:${txnNumber}`,
        notes: fxDiff.isPositive() ? "مكسب صرف محقَّق" : "خسارة صرف محقَّقة",
        postingSourceComponents: fxComponents,
        postingIntent: fxDiff.isPositive()
          ? createPostingIntent(
            "EXCHANGE_FX_GAIN",
            "EXCHANGE_FX_DIFF",
            [debitLine(exchangeWalletRole, fxDiff), creditLine("FX_GAIN", fxDiff)],
            fxComponents,
          )
          : createPostingIntent(
            "EXCHANGE_FX_LOSS",
            "EXCHANGE_FX_DIFF",
            [debitLine("FX_LOSS", fxDiff.abs()), creditLine(exchangeWalletRole, fxDiff.abs())],
            fxComponents,
          ),
      });
    }

    // العمولة مصروف (cost=amount، profit سالب) — تظهر في P&L والكشف.
    if (commissionIqd.gt(0)) {
      const feeComponents = {
        roleDebits: { OPERATING_EXPENSE: commissionIqd },
        roleCredits: { [exchangeWalletRole]: commissionIqd },
      } as const;
      await postEntry(tx, {
        entryType: "EXCHANGE_FEE",
        branchId: input.branchId,
        purchaseOrderId: purchaseOrder ? Number(purchaseOrder.id) : null,
        exchangeHouseId: input.exchangeHouseId,
        supplierId: input.supplierId,
        amount: commissionIqd,
        cost: commissionIqd,
        profit: commissionIqd.negated(),
        dedupeKey: `EXFEE:${txnNumber}`,
        notes: "عمولة صيرفة",
        postingSourceComponents: feeComponents,
        postingIntent: createPostingIntent(
          "EXCHANGE_FEE_EXPENSE",
          "EXCHANGE_FEE",
          [debitLine("OPERATING_EXPENSE", commissionIqd), creditLine(exchangeWalletRole, commissionIqd)],
          feeComponents,
        ),
      });
    }

    await postExchangeControlReclassification(tx, {
      exchangeHouseId: input.exchangeHouseId,
      currency: input.currency,
      beforeSignedIqd: controlBeforeIqd,
      afterSignedIqd: controlAfterIqd,
      sourceKey: txnNumber,
      notes: `تصنيف ذمة الصيرفة لتسوية المورد ${txnNumber}`,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.settle", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber, fxDiff: toDbMoney(fxDiff), receiptId, voucherNumber };
  });
}
