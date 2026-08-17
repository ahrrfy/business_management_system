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
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { createSystemPaymentRequestTx } from "../voucher/create";

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
    const po = (
      await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .for("update")
        .limit(1)
    )[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });

    // عزل الفرع (مرآة returnService/correctSale): مدير فرعٍ لا يصرف على أمر فرعٍ آخر.
    if (actor.role !== "admin" && Number(po.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "أمر الشراء لا يخصّ فرعك" });
    }
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

    const remaining = round2(money(po.total).minus(money(po.paidAmount ?? "0")));
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
      await tx.select().from(suppliers).where(eq(suppliers.id, Number(po.supplierId))).limit(1)
    )[0];
    if (!sup) throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
    if (!sup.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الصرف لمورد مُعطَّل" });
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
        referenceNumber: `PO-PAY-${po.poNumber}-${input.clientRequestId}`,
        clientRequestId: `purchase-supplier-${input.clientRequestId}`,
      },
      actor,
      {
        kind: "PURCHASE_SUPPLIER",
        purchaseOrderId: input.purchaseOrderId,
        requestToken: input.clientRequestId,
        expectedAmount: toDbMoney(amount),
        sourceTotal: toDbMoney(money(po.total)),
      },
    );

    return {
      purchaseOrderId: input.purchaseOrderId,
      paymentRequestReceiptId: request.receiptId,
      remainingBefore: remaining.toFixed(2),
    };
  });
}
