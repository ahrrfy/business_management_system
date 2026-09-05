/**
 * **مصدرُ «النقد بيد الجهة»** — علَمُ الإطفاء لموجة م١ (PR-3، الخطّة §١٠).
 *
 * العلَم القائم `courierLedgerDerived` (`shared/rolloutFlags.ts`، البيئة
 * `ROLLOUT_COURIER_LEDGER_DERIVED`) هو الثابت الوحيد — لا متغيّرَ بيئةٍ ثانٍ:
 *   · `OFF`    (الافتراض) ⇒ `stored`: العمود المخزَّن `deliveryParties.currentBalance` هو المرجع.
 *   · `SHADOW`             ⇒ `stored` مرجعاً، والدفترُ يُحسَب ويُعرَض جانبه (شارة الانحراف).
 *   · `ON`                 ⇒ `ledger`: المشتقّ من `deliveryLedgerEntries` هو المرجع — يُقلَب
 *     بقرار المالك بعد أيامٍ متطابقة (`cashInHandDrift = 0` على كلّ الجهات).
 *
 * مَن يقرؤه: لوحة الجهات (`board.ts`)، سقفُ التوريد (`remittance.ts`)، حارسُ سقف العهدة
 * (`parties.assertFloatLimitTx`)، والتسويةُ الحرّة (`settle.ts`) — كلُّها تقرأ المصدرَ من هنا لا
 * من العلَم مباشرةً، كي يبقى الانتقالُ قلبةً واحدة.
 */
import { rolloutMode } from "../../config/rolloutFlags";

export type DeliveryCashSource = "ledger" | "stored";

export function deliveryCashSource(): DeliveryCashSource {
  return rolloutMode("courierLedgerDerived") === "ON" ? "ledger" : "stored";
}

/** هل يُحسَب الدفترُ جانب المخزَّن (SHADOW أو ON)؟ للعرض لا للقرار. */
export function deliveryCashShadowEnabled(): boolean {
  const mode = rolloutMode("courierLedgerDerived");
  return mode === "SHADOW" || mode === "ON";
}
