/**
 * isDeadInvoice — «هل هذه الفاتورة مستندٌ ميّت (لا يقبل تحصيلاً جديداً)؟»
 *
 * **إعادةُ تصديرٍ مُوَثَّقة** من `shared/invoiceStatus.ts` (`isDeadInvoiceStatus`) تحت اسمٍ يقول
 * ماذا يفعل المسند بدل أن يقول ماذا يقيس (`Status`). ⇒ القارئ في راوترٍ أو شاشة يعرف من التوقيع
 * وحده أنّ «هذه فاتورةٌ لا يجوز ربطُ سندٍ بها» بلا فتح `invoiceStatus.ts`.
 *
 * **لا سلوكَ جديداً هنا** — الاختبار العقديّ ([../invoiceStatus.test.ts](../invoiceStatus.test.ts))
 * القائم يحرس القاموس والتمييز الحاكم بين DEAD و VOIDED. اختبار هذا الملف يتحقّق فقط أنّ التغليف
 * لم يُغيّر السلوك (إعادة التصدير حرفياً)، وأنّ اسم الدالّة القاعدية ما زال موجوداً في المصدر.
 *
 * **الاستعمال المتوقَّع** (يوصَل لاحقاً، لا في هذه الشريحة):
 *   - `voucherService.attachToInvoice`: يرفض ربط قبضٍ بفاتورة `isDeadInvoice(inv.status)`.
 *   - `sales.correct`/`cancel`: يرفض تعديل مستندٍ ميّت.
 *   - تقارير الذمم: تستبعد الفواتير الميّتة من «مستحقّ».
 */

import { DEAD_INVOICE_STATUSES, isDeadInvoiceStatus, type InvoiceStatus } from "../invoiceStatus";

/**
 * ⭐ هل الفاتورةُ **مستندٌ ميّت** (CANCELLED/RETURNED/SUPERSEDED)؟
 *
 * يقبل الحالة **أو** فاتورةً كاملة بها حقل `status` — الشكلان يُستعملان في المكتبة (الشاشة تحمل
 * الفاتورة، والخدمة أحياناً تحمل الحالة وحدها بعد `select({ status })`).
 *
 * @example
 *   isDeadInvoice("PAID")                  // false
 *   isDeadInvoice("CANCELLED")             // true
 *   isDeadInvoice({ status: "RETURNED" })  // true
 *   isDeadInvoice(null)                    // false — احتراسٌ ضدّ صفٍّ ناقص
 */
export function isDeadInvoice(
  input: InvoiceStatus | string | { status?: string | null } | null | undefined,
): boolean {
  if (input == null) return false;
  const status = typeof input === "string" ? input : input.status;
  return isDeadInvoiceStatus(status);
}

/** إعادةُ تصديرٍ صريحة — يستهلكها الاستعلام المباشر (`inArray(status, DEAD_INVOICE_STATUSES)`). */
export { DEAD_INVOICE_STATUSES };
