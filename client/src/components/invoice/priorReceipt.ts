/**
 * استنتاج «كم استُلم فعلاً» من المقبوض المسجَّل على فاتورةٍ تُصحَّح — منطقٌ نقيّ بلا واجهة.
 *
 * قرار المالك: الموظّف لا يسوّي إيصالاً إيصالاً؛ النظام يستنتج من كان/أصبح:
 *  • لا مقبوض ⇒ لا شيء يُرسَل (null).
 *  • الأصل مسدَّد (نقديّ) ثم صار «آجل» ⇒ المال لم يُستلم (بيعٌ آجل سُجِّل نقداً خطأً).
 *  • غير ذلك ⇒ استُلم كاملاً ويُحمَل إلى الفاتورة البديلة (ولو تغيّر العميل).
 * المفتاح الصريح (RECEIVED/NOT_RECEIVED) يغلب الاستنتاج دائماً. الخادم هو الحكم النهائيّ.
 */
import { D } from "@/lib/money";
import type { PaymentTerm } from "./types";

/** AUTO = يستنتجه النظام من الفرق؛ الآخران تجاوزٌ صريح من الموظّف. */
export type PriorReceiptMode = "AUTO" | "RECEIVED" | "NOT_RECEIVED";

export function resolvePriorReceipt(input: {
  recordedPaid: string;
  originalTerms: PaymentTerm;
  targetTerms: PaymentTerm;
  mode: PriorReceiptMode;
}): { amount: string | null; inferredNotReceived: boolean } {
  const paid = D(input.recordedPaid || "0");
  if (!paid.gt(0)) return { amount: null, inferredNotReceived: false };
  const inferredNotReceived = input.originalTerms !== "CREDIT" && input.targetTerms === "CREDIT";
  const received = input.mode === "RECEIVED"
    ? true
    : input.mode === "NOT_RECEIVED"
      ? false
      : !inferredNotReceived;
  return { amount: received ? paid.toFixed(2) : "0.00", inferredNotReceived };
}
