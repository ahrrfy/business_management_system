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
import { eq } from "drizzle-orm";
import { purchaseOrders, suppliers } from "../../../drizzle/schema";
import { findIdempotentRefId, idempotencyHash } from "../idempotency";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { createSystemPaymentRequestTx } from "../voucher/create";
import { notifyApprovalPendingByReceipt } from "../approvalEventNotifier";
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

  const result = await withTx(async (tx) => {
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
  // ن-٢-هـ (Codex P2 ٢٨/٨): أخطر المُعتمِدين إن كان السند PENDING_APPROVAL — الدالّة
  // تُصفّي على الحالة داخلياً فالاستدعاءُ آمنٌ عند سنداتٍ اعتُمِدت مباشرةً كذلك.
  if (result.paymentRequestReceiptId != null) {
    void notifyApprovalPendingByReceipt(result.paymentRequestReceiptId);
  }
  return result;
}
