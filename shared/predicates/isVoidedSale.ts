/**
 * isVoidedSale — «هل هذه الفاتورة بيعٌ لم يقع أصلاً (تُستبعَد من تجميع الإيراد)؟»
 *
 * **إعادةُ تصديرٍ مُوَثَّقة** من `shared/invoiceStatus.ts` (`isVoidedInvoiceStatus`) تحت اسمٍ يقول
 * الغرض المحاسبيّ بدل أن يقول اسم الحالة. القارئ في تقرير المبيعات يعرف من التوقيع أنّ «هذه لا
 * تُحتسب مبيعاً» بلا فتح `invoiceStatus.ts`.
 *
 * ⚠️ **فرقٌ جوهريٌّ لا سهو** (موثَّق في `shared/invoiceStatus.ts`):
 *   - `isDeadInvoice`  = CANCELLED · RETURNED · SUPERSEDED ⇒ لا تحصيلَ جديد.
 *   - `isVoidedSale`   = CANCELLED · SUPERSEDED **دون** RETURNED ⇒ لم يقع بيعٌ.
 *
 * **لماذا `RETURNED` ليست فيها:** المرتجعة بيعٌ **وقع فعلاً ثمّ أُرجع**، و`returnedTotal = total`
 * يجعل صافيها صفراً حسابياً بينما يبقى الصفّ مرئياً في عمود «المرتجعات» — وهو رقمٌ يحتاجه المالك.
 * استبعادها من التجميع يُخفي المرتجع بدل أن يُظهره ⇒ **خلطُ المجموعتَين يُسقط المرتجع من الإيراد
 * مرّتين** (فهو مطروحٌ أصلاً بـ`returnedTotal`).
 *
 * **الاستعمال المتوقَّع** (يوصَل لاحقاً):
 *   - `reportsSalesService`: `WHERE status NOT IN (VOIDED_INVOICE_STATUSES)` للإيراد الصافي.
 *   - رأسُ صفحة المبيعات: عدّاد «الفواتير الحيّة» يستبعد الملغاة والمُستبدَلة، **يُبقي المرتجعة**.
 */

import { VOIDED_INVOICE_STATUSES, isVoidedInvoiceStatus, type InvoiceStatus } from "../invoiceStatus";

/**
 * ⭐ هل الفاتورةُ **بيعٌ لم يقع** (CANCELLED/SUPERSEDED)؟
 *
 * يقبل الحالة **أو** فاتورةً كاملة بها حقل `status` — الشكلان يُستعملان في المكتبة.
 *
 * @example
 *   isVoidedSale("PAID")           // false — بيعٌ قائم
 *   isVoidedSale("RETURNED")       // false — بيعٌ وقع ثمّ أُرجع (يبقى في «المرتجعات»)
 *   isVoidedSale("CANCELLED")      // true  — لم يقع
 *   isVoidedSale("SUPERSEDED")     // true  — البديلة تحمل الرقم، هذه لا تُحتسب
 *   isVoidedSale({ status: null }) // false — لا حالةَ ⇒ لا نُبطل
 */
export function isVoidedSale(
  input: InvoiceStatus | string | { status?: string | null } | null | undefined,
): boolean {
  if (input == null) return false;
  const status = typeof input === "string" ? input : input.status;
  return isVoidedInvoiceStatus(status);
}

/** إعادةُ تصديرٍ صريحة — للاستعلامات المباشرة (`notInArray(status, VOIDED_INVOICE_STATUSES)`). */
export { VOIDED_INVOICE_STATUSES };
