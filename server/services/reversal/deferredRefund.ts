/**
 * ═══ إغلاقُ أثرَي الردّ المؤجَّل عند اعتماد سند الصرف (Codex P2) ═══
 *
 * حين يكون رافدُ ردّ الإلغاء/المرتجع تحويلاً أو صكّاً أو محفظةً، لا يخرج المالُ لحظةَ العكس بل
 * يمرّ بسند صرفٍ معلَّقٍ يعتمده المالك. فيترك محرّكُ العكس أثرَين مفتوحَين **بقصدٍ معلن**:
 *  · `PAID_AMOUNT` (نطاق `sale`) — «ردٌّ لم يُصرَف بعد».
 *  · `CUSTOMER_BALANCE` (نطاق `refund-pending`، مربوطٌ بإيصال الصرف) — «رصيدٌ دائنٌ حتى الصرف».
 *
 * عند اعتماد السند يتجسّد المالُ في `approveVoucher` (paidAmount ينقص + رصيد العميل يُستعاد +
 * قيد PAYMENT_OUT)، لكنّ سجلَّ الأثر كان يبقى يبلّغ **ردّاً غير مدفوعٍ وائتماناً بعد صرف المال**؛
 * والمنفّذُ العامّ للرصيد لا يُغلق أثرَ `refund-pending` (يشترط `effectTable = "customers"` بينما
 * الصفُّ يشير إلى `receipts`). هنا نُغلق الأثرَين بصفَّي REVERSE صريحَين يشيران إلى إيصال الصرف —
 * فيعود Σ كلٍّ منهما صفراً، ويتتبّع المدقّق العكسَ إلى صرفه الفعليّ.
 *
 * ⛔ لا يمسّ مالاً ولا رصيداً — تجسيدُ المال تمّ في المستدعي؛ هذا **قيدُ سجلٍّ** محضٌ يلحق بالحقيقة.
 * idempotent: `loadApplyEffects(onlyOutstanding)` لا يعيد أثراً أُغلق سلفاً، فإعادةُ الاعتماد لا تُكرّر.
 */
import Decimal from "decimal.js";

import type { Tx } from "../../db";
import { loadApplyEffects, recordReverseRow } from "./effectLedger";
import { INVOICE_SALE_SCOPE } from "./materialize/invoice";
import type { Actor } from "../tx";

/** نطاقُ الرصيد الدائن المعلَّق حتى صرف السند — يطابق `keepAsCustomerCredit(scope: "refund-pending")`. */
const REFUND_PENDING_SCOPE = "refund-pending";

export interface CloseDeferredRefundResult {
  /** ما أُغلق من أثر `PAID_AMOUNT` (نطاق البيع). */
  closedPaidAmount: Decimal;
  /** ما أُغلق من أثر الرصيد الدائن المعلَّق. */
  closedPendingCredit: Decimal;
}

/**
 * يُغلق الأثرَين المؤجَّلَين لردٍّ غير نقديٍّ صار مصروفاً باعتماد سنده. يُستدعى **داخل معاملة
 * الاعتماد** بعد تجسيد المال، فيبقى صفُّ REVERSE ذرّياً مع الصرف.
 */
export async function closeDeferredSaleRefundEffectsTx(
  tx: Tx,
  args: { invoiceId: number; receiptId: number; amount: Decimal; reason: string },
  actor: Actor,
): Promise<CloseDeferredRefundResult> {
  const { invoiceId, receiptId, amount, reason } = args;
  let closedPaidAmount = new Decimal(0);
  let closedPendingCredit = new Decimal(0);

  // ① أثرُ `PAID_AMOUNT` (نطاق البيع): يُنقَص بما صُرف فعلاً — أثرٌ واحدٌ للفاتورة في هذا النطاق.
  const paidEffects = await loadApplyEffects(
    tx,
    "INVOICE",
    invoiceId,
    { kind: "ONLY", effectKinds: ["PAID_AMOUNT"], operationScopes: [INVOICE_SALE_SCOPE] },
    { onlyOutstanding: true },
  );
  for (const effect of paidEffects) {
    const reverseBy = Decimal.min(amount, effect.outstandingAmount);
    if (reverseBy.lte(0)) continue;
    await recordReverseRow(
      tx,
      effect,
      {
        signedAmount: reverseBy.negated(),
        signedQuantity: 0,
        reason,
        effectTable: "receipts",
        effectRowId: receiptId,
        payloadJson: { deferredRefundDisbursed: true, receiptId, amount: reverseBy.toFixed(2) },
      },
      actor,
    );
    closedPaidAmount = reverseBy;
    break;
  }

  // ② أثرُ الرصيد الدائن المعلَّق المربوطُ بهذا الإيصال: يُغلَق كلّه (كان يشير إلى `receipts`
  //    فلا يمسّه المنفّذُ العامّ للرصيد).
  const pendingCredits = await loadApplyEffects(
    tx,
    "INVOICE",
    invoiceId,
    { kind: "ONLY", effectKinds: ["CUSTOMER_BALANCE"], operationScopes: [REFUND_PENDING_SCOPE] },
    { onlyOutstanding: true },
  );
  for (const effect of pendingCredits) {
    if (effect.effectTable !== "receipts" || Number(effect.effectRowId) !== receiptId) continue;
    await recordReverseRow(
      tx,
      effect,
      {
        signedAmount: effect.outstandingAmount.negated(),
        signedQuantity: 0,
        reason,
        effectTable: "receipts",
        effectRowId: receiptId,
        payloadJson: { deferredRefundDisbursed: true, receiptId },
      },
      actor,
    );
    closedPendingCredit = closedPendingCredit.plus(effect.outstandingAmount.negated());
  }

  return { closedPaidAmount, closedPendingCredit };
}
