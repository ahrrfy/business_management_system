/**
 * سداد أمر شراءٍ بعد استلامه — الفجوة التي كانت تُبقي الشراء الآجل بلا مسار إقفال.
 *
 * ## العلّة
 *
 * بطاقة «دفعة للمورد» تختفي فور اكتمال الاستلام (`closed = RECEIVED || CANCELLED`)، وقائمة
 * إجراءات الأمر بلا «تسديد». البيع يملك `sales.pay`؛ الشراء لا نظير له. فكلّ سدادٍ لاحق كان
 * يخرج إلى **سند صرفٍ عامّ** — وهو يُنقص `suppliers.currentBalance` صحيحاً لكنّه لا يمسّ
 * `purchaseOrders.paidAmount` ولا يحمل `purchaseOrderId` ⇒ عمود «المتبقّي» في القائمة
 * والتفاصيل يطالب بمبلغٍ مسدَّد، وتفصيل أعمار الذمم يُبقي الأمر متأخّراً إلى الأبد،
 * و`reconcileSupplierBalances` يقيس الرصيد الإجماليّ فقط فلا يرى الانحراف. خطرُه العمليّ:
 * **دفعٌ مكرَّر للمورّد**.
 *
 * ## التصميم — إعادة استعمالٍ لا مسارٍ ثانٍ
 *
 * لا ننشئ مسار مالٍ جديداً: نستدعي **نفس** آلية `createSystemPaymentRequestTx` بـ
 * `kind: "PURCHASE_SUPPLIER"` التي يستعملها الاستلام أصلاً. فائدتها أنّها مُختبَرة وأنّ
 * `approveVoucher` يُحدّث `purchaseOrders.paidAmount` عند الاعتماد (لا عند الطلب) ويعيد فحص
 * السقف تحت القفل. وبذلك يسري **قرار المالك** تلقائياً: كلّ صرفٍ للمورّد طلبٌ معلَّق باعتماد
 * ثانٍ مهما صغُر المبلغ — لا بابَ جانبيّاً يلتفّ على Maker-Checker.
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, eq } from "drizzle-orm";
import {
  accountingEntries,
  accrualObligationEvents,
  accrualObligations,
  expenses,
  purchaseOrders,
  receipts,
  suppliers,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, idempotencyHash } from "../idempotency";
import { assertCashOutAvailable, lockCashSourceForUpdate } from "../cash/cashAvailability";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import type { Tx } from "../../db";
import { createSystemPaymentRequestTx } from "../voucher/create";
import { nextVoucherNumber } from "../voucher/helpers";
import { PETTY_CASH_LIMIT_IQD } from "../expenseService";
import { shiftIdForCashTx } from "../shiftService";
import { expenseAccrualSettlement } from "../accounting/accrualPosting";
import { postEntry } from "../ledgerService";
import { transitionAccrualObligationTx } from "../accounting/accrualObligations";
import { appendPurchaseOrderEventTx } from "./revisions";
import {
  assertPurchaseBranch,
  pendingPurchaseSupplierPaymentsTx,
  purchaseCashSettlementUsesClearingTx,
  purchaseOrderPayableBalanceTx,
} from "./internal";

export interface PayPurchaseOrderInput {
  purchaseOrderId: number;
  amount: string;
  /** نقديّ فقط — مرآةُ عقد الاستلام؛ غير النقد يمرّ بسند صرفٍ بمرجع الأداة. */
  method: "CASH";
  clientRequestId: string;
}

export interface PayPurchaseOrderResult {
  purchaseOrderId: number;
  /** إيصال الطلب المعلَّق — لا أثر ماليّ حتى يعتمده مالكٌ ثانٍ. */
  paymentRequestReceiptId: number;
  remainingBefore: string;
}

export async function payPurchaseOrder(
  input: PayPurchaseOrderInput,
  actor: Actor & { role?: string },
): Promise<PayPurchaseOrderResult> {
  const amount = round2(money(input.amount));
  if (!amount.gt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الدفعة يجب أن يكون موجباً" });
  }

  return withTx(async (tx) => {
    const preview = (
      await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .limit(1)
    )[0];
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(preview, actor);

    // ترتيب القفل موحّد مع الاستلام والاعتماد: مصدر النقد ← PO ← المورد.
    // كان هذا المسار يقفل PO أولاً بينما الاعتماد يقفل الخزينة أولاً، فتتكوّن دورة deadlock.
    await lockCashSourceForUpdate(tx, {
      branchId: Number(preview.branchId),
      cashBucket: "TREASURY",
      shiftId: null,
    });
    const po = (
      await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .for("update")
        .limit(1)
    )[0];
    if (!po || Number(po.branchId) !== Number(preview.branchId)) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر أمر الشراء أثناء طلب الدفع؛ أعد المحاولة" });
    }

    assertPurchaseBranch(po, actor);
    if (po.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُسدَّد أمر شراءٍ ملغى" });
    }
    // العملة الدولارية لها مسارها الخاصّ (settleUsdDirect) بسعر تثبيتٍ وفرق صرف.
    if (po.agreedCurrency === "USD") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أمر الشراء بالدولار يُسدَّد من «تسديد مباشر بالدولار» (سعر التثبيت وفرق الصرف)",
      });
    }
    const useCashClearing =
      po.settlementType === "CASH" &&
      (await purchaseCashSettlementUsesClearingTx(tx, input.purchaseOrderId));

    // عقد الاعتماد يقبل رمز مصدر canonical من 16 خانة hex فقط؛ المفتاح الخام كان ينشئ
    // طلباً يبدو ناجحاً ثم يستحيل اعتماده. تبقى idempotency مربوطة بالمفتاح الخام أدناه.
    const requestToken = idempotencyHash({
      purchaseOrderId: input.purchaseOrderId,
      clientRequestId: input.clientRequestId,
    }).slice(0, 16);
    const voucherClientRequestId = `purchase-supplier-${input.clientRequestId}`;
    const referenceNumber = `PO-PAY-${po.poNumber}-${requestToken}`;

    // replay الحي يمرّ إلى عقد السند نفسه قبل فحص الحجز؛ وإلا سيخصم الطلب نفسه من
    // available ثم يحوّل نجاح شبكة سابقاً إلى «لا يوجد مستحق» مضلّل.
    const replayReceiptId = await findIdempotentRefId(tx, "voucher.create", voucherClientRequestId);
    if (replayReceiptId != null) {
      const replay = await createSystemPaymentRequestTx(
        tx,
        {
          branchId: Number(po.branchId),
          amount: toDbMoney(amount),
          paymentMethod: input.method,
          partyType: "SUPPLIER",
          partyId: Number(po.supplierId),
          description: `تسديد أمر الشراء ${po.poNumber}`,
          referenceNumber,
          clientRequestId: voucherClientRequestId,
        },
        actor,
        {
          kind: "PURCHASE_SUPPLIER",
          purchaseOrderId: input.purchaseOrderId,
          requestToken,
          expectedAmount: toDbMoney(amount),
          sourceTotal: toDbMoney(money(po.total)),
          liabilityAccount: useCashClearing ? "CASH_CLEARING" : "AP",
        },
      );
      return {
        purchaseOrderId: input.purchaseOrderId,
        paymentRequestReceiptId: replay.receiptId,
        remainingBefore: "0.00",
      };
    }

    // المستحق الحقيقي هو GL المعترف به لهذا PO بعد الاستلامات والمرتجعات والمدفوعات،
    // ناقص الطلبات المعلّقة. po.total/paidAmount يسمحان بدفع بضاعة لم تُستلم أو حجزها مرتين.
    const payable = await purchaseOrderPayableBalanceTx(tx, input.purchaseOrderId);
    const pending = await pendingPurchaseSupplierPaymentsTx(tx, String(po.poNumber));
    const remaining = round2(payable.minus(pending));
    if (!remaining.gt(0)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد مبلغ مستحق على أمر الشراء" });
    }
    if (amount.gt(remaining)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الدفعة (${amount.toFixed(2)}) تتجاوز المتبقّي على أمر الشراء (${remaining.toFixed(2)}).`,
      });
    }

    const sup = (
      await tx.select().from(suppliers).where(eq(suppliers.id, Number(po.supplierId))).for("update").limit(1)
    )[0];
    if (!sup) throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
    if (!sup.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الصرف لمورد مُعطَّل" });
    }
    if (
      !useCashClearing &&
      amount.gt(money(sup.currentBalance))
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الدفعة تتجاوز رصيد المورد الجاري" });
    }

    // نفس آلية الاستلام: طلبٌ معلَّق يُحدّث `paidAmount` عند الاعتماد ويعيد فحص السقف تحت القفل.
    const request = await createSystemPaymentRequestTx(
      tx,
      {
        branchId: Number(po.branchId),
        amount: toDbMoney(amount),
        paymentMethod: input.method,
        partyType: "SUPPLIER",
        partyId: Number(po.supplierId),
        description: `تسديد أمر الشراء ${po.poNumber}`,
        referenceNumber,
        clientRequestId: voucherClientRequestId,
      },
      actor,
      {
        kind: "PURCHASE_SUPPLIER",
        purchaseOrderId: input.purchaseOrderId,
        requestToken,
        expectedAmount: toDbMoney(amount),
        sourceTotal: toDbMoney(money(po.total)),
        liabilityAccount: useCashClearing ? "CASH_CLEARING" : "AP",
      },
    );

    return {
      purchaseOrderId: input.purchaseOrderId,
      paymentRequestReceiptId: request.receiptId,
      remainingBefore: remaining.toFixed(2),
    };
  });
}

export interface SettlePurchaseShippingFromShiftInput {
  purchaseOrderId: number;
  shiftId?: number | null;
}

export interface SettlePurchaseShippingFromShiftResult {
  purchaseOrderId: number;
  receiptId: number;
  voucherNumber: string;
  amount: string;
  shiftId: number;
  status: "PAID";
}

/**
 * صرف وتسوية مصاريف الشحن/الكمرك لأمر الشراء نقداً من درج الوردية المفتوحة.
 * يحقق الأركان الخمسة (§٥ في CLAUDE.md):
 *  ١. إيصال بمصدره (DRAWER, shiftId, OUT)
 *  ٢. قيد دفتر مصنف (PAYMENT_OUT: مدين ACCRUED_EXPENSES / دائن CASH)
 *  ٣. أثر في تسوية الدرج (ينقص النقد المتوقع في Z-report الوردية فورياً بلا عجز)
 *  ٤. طرف منسوب إليه (الناقل + مستخدم الوردية)
 *  ٥. تقرير يظهره ويربطه بمستنده وأمر الشراء
 */
export async function settlePurchaseShippingFromShiftTx(
  tx: Tx,
  input: SettlePurchaseShippingFromShiftInput,
  actor: Actor,
): Promise<SettlePurchaseShippingFromShiftResult> {
  const po = (
    await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .for("update")
      .limit(1)
  )[0];
  if (!po) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذر العثور على أمر الشراء",
        why: `أمر الشراء بالمعرف #${input.purchaseOrderId} غير موجود في قاعدة البيانات`,
        doThis: "تحقق من صحة رقم أمر الشراء وأعد المحاولة",
      }),
    });
  }
  assertPurchaseBranch(po, actor);

  const totalShippingMoney = round2(
    money(po.shippingCost ?? 0).plus(money(po.customsCost ?? 0)),
  );
  if (!totalShippingMoney.gt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "أمر الشراء لا يتضمن مصاريف شحن أو كمرك للتسوية",
        why: "مجموع أجور الشحن والكمرك في هذا الأمر يساوي صفراً",
        doThis: "تحقق من بنود وتكاليف أمر الشراء قبل محاولة صرف أجور الشحن",
      }),
    });
  }

  // البحث عن التزام الشحن المرتبط
  const [obligation] = await tx
    .select()
    .from(accrualObligations)
    .where(
      and(
        eq(accrualObligations.purchaseOrderId, po.id),
        eq(accrualObligations.kind, "PURCHASE_SHIPPING"),
      ),
    )
    .for("update")
    .limit(1);

  if (!obligation) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "التزام مصروف الشحن غير مسجل",
        why: "لم يُعثر على التزام شحن وكمرك مستحق مرتبط بأمر الشراء هذا",
        doThis: "تأكد من اعتماد واستلام أمر الشراء لإنشاء استحقاق الشحن أولاً",
      }),
    });
  }

  if (obligation.status === "PAID") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "مصروف الشحن مسدد مسبقاً",
        why: "حالة التزام الشحن الحالي هي مسدد (PAID) بالفعل",
        doThis: "راجع سند الصرف المالي وإيصالات الصرف المرتبطة بأمر الشراء",
      }),
    });
  }

  if (obligation.status === "RECOGNITION_REVERSED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "التزام مصروف الشحن معكوس",
        why: "تم عكس قيد استحقاق مصروف الشحن مسبقاً ولا يمكن صرفه",
        doThis: "راجع قيود وتعديلات أمر الشراء وسجل التعديلات",
      }),
    });
  }

  const amount = money(obligation.recognizedAmount);
  if (amount.gte(PETTY_CASH_LIMIT_IQD)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "المبلغ يتجاوز سقف النثرية النقدية للوردية",
        why: `المبلغ المطلوب (${amount.toFixed(2)} د.ع) يبلغ أو يتجاوز الحد الأقصى للنثرية (٥٠٠٬٠٠٠ د.ع)`,
        doThis: "قم بصرف أجور الشحن عبر سند صرف إداري معتمد من الخزينة الرئيسية",
      }),
    });
  }

  // حل وتحديد وردية الكاشير المفتوحة في الفرع
  const resolvedCash = await shiftIdForCashTx(
    tx,
    actor,
    Number(po.branchId),
    "صرف شحن أمر الشراء من درج الوردية",
    "RETAIL",
    input.shiftId ?? null,
  );

  if (resolvedCash.cashBucket !== "DRAWER" || !resolvedCash.shiftId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذر صرف أجور الشحن من الدرج",
        why: "لا توجد وردية مبيعات مفتوحة في هذا الفرع لصرف المبلغ منها",
        doThis: "افتح وردية مبيعات جديدة في الفرع ثم نفّذ عملية الصرف من نقدية الدرج",
      }),
    });
  }

  // التحقق من توفر النقد في درج الوردية تحت القفل
  await assertCashOutAvailable(tx, {
    branchId: Number(po.branchId),
    cashBucket: "DRAWER",
    shiftId: resolvedCash.shiftId,
    amount,
    operation: "صرف مصروف شحن أمر الشراء من درج الوردية",
  });

  // فحص ما إذا كان هناك طلب دفع معلّق سابقاً
  const [pendingEvent] = await tx
    .select()
    .from(accrualObligationEvents)
    .where(
      and(
        eq(accrualObligationEvents.obligationId, obligation.id),
        eq(accrualObligationEvents.eventType, "PAYMENT_REQUESTED"),
      ),
    )
    .for("update")
    .limit(1);

  let finalReceiptId: number;
  let finalVoucherNumber: string;

  if (pendingEvent?.receiptId) {
    finalReceiptId = Number(pendingEvent.receiptId);
    const [existingReceipt] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, finalReceiptId))
      .for("update")
      .limit(1);

    if (!existingReceipt) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "إيصال طلب تسوية الشحن المعلّق مفقود",
      });
    }
    finalVoucherNumber = existingReceipt.voucherNumber ?? "";

    await tx
      .update(receipts)
      .set({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
        shiftId: resolvedCash.shiftId,
        cashBucket: "DRAWER",
        paymentMethod: "CASH",
      })
      .where(eq(receipts.id, finalReceiptId));
  } else {
    // إنشاء إيصال صرف مكتمل معتمد فورياً من الدرج
    finalVoucherNumber = await nextVoucherNumber(
      tx,
      "PAYMENT",
      Number(po.branchId),
    );
    const [rRes] = await tx.insert(receipts).values({
      branchId: Number(po.branchId),
      shiftId: resolvedCash.shiftId,
      cashBucket: "DRAWER",
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      voucherNumber: finalVoucherNumber,
      partyType: "OTHER",
      partyId: null,
      counterpartyName: obligation.beneficiaryName ?? "ناقل غير محدَّد",
      description: `تسوية مصروف شحن/كمرك — أمر الشراء ${po.poNumber}`,
      referenceNumber: `SHIP-${po.poNumber}-DRAWER`,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      createdBy: actor.userId,
    });
    finalReceiptId = extractInsertId(rRes);
  }

  // ترحيل قيد الصرف النقدي PAYMENT_OUT يخصم الصندوق (CASH) ويقفل المصروف المستحق (ACCRUED_EXPENSES)
  const posting = expenseAccrualSettlement("CASH", amount);
  const dedupeKey = `PURCHASE_SHIPPING_DRAWER_SETTLE:${obligation.id}:${finalReceiptId}`;
  await postEntry(tx, {
    entryType: "PAYMENT_OUT",
    branchId: Number(po.branchId),
    receiptId: finalReceiptId,
    purchaseOrderId: Number(po.id),
    amount,
    paymentMethod: "CASH",
    postingIntent: posting.intent,
    postingSourceComponents: posting.sourceComponents,
    dedupeKey,
    notes: `صرف مصروف شحن أمر الشراء ${po.poNumber} من درج الوردية #${resolvedCash.shiftId}`,
    createdBy: actor.userId,
  });

  const [settlementEntry] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, dedupeKey))
    .limit(1);

  if (!settlementEntry) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "قيد تسوية مصروف الشحن من الدرج مفقود",
    });
  }

  await transitionAccrualObligationTx(tx, {
    obligationId: Number(obligation.id),
    expectedStatus: obligation.status as "ACCRUED_UNPAID" | "PAYMENT_PENDING",
    nextStatus: "PAID",
    eventType: "PAYMENT_SETTLED",
    actorId: actor.userId,
    receiptId: finalReceiptId,
    accountingEntryId: Number(settlementEntry.id),
    evidenceReference: obligation.evidenceReference,
    dedupeKey: `ACCRUAL:PAYMENT_SETTLED:${obligation.id}:${finalReceiptId}`,
  });

  if (obligation.expenseId != null) {
    await tx
      .update(expenses)
      .set({
        receiptId: finalReceiptId,
        shiftId: resolvedCash.shiftId,
        cashBucket: "DRAWER",
        paymentMethod: "CASH",
        source: "CASH",
        status: "ACTIVE",
      })
      .where(eq(expenses.id, Number(obligation.expenseId)));
  }

  await appendPurchaseOrderEventTx(tx, {
    eventKey: `PO-SHIPPING-DRAWER-SETTLED:${obligation.id}:${finalReceiptId}`,
    purchaseOrderId: Number(po.id),
    revisionId:
      po.currentRevisionId == null ? null : Number(po.currentRevisionId),
    requestId: null,
    branchId: Number(po.branchId),
    eventType: "SHIPPING_SETTLED_FROM_DRAWER",
    reason: `صرف أجور الشحن (${amount.toFixed(2)} د.ع) من درج الوردية #${resolvedCash.shiftId}`,
    actorUserId: actor.userId,
    payload: {
      amount: amount.toFixed(2),
      shiftId: resolvedCash.shiftId,
      receiptId: finalReceiptId,
      voucherNumber: finalVoucherNumber,
    },
  });

  return {
    purchaseOrderId: Number(po.id),
    receiptId: finalReceiptId,
    voucherNumber: finalVoucherNumber,
    amount: amount.toFixed(2),
    shiftId: resolvedCash.shiftId,
    status: "PAID",
  };
}

export async function settlePurchaseShippingFromShift(
  input: SettlePurchaseShippingFromShiftInput,
  actor: Actor,
): Promise<SettlePurchaseShippingFromShiftResult> {
  return withTx(async (tx) =>
    settlePurchaseShippingFromShiftTx(tx, input, actor),
  );
}

