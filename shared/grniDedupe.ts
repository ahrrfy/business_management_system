// المصدر الوحيد لبادئات `dedupeKey` لقيود GRNI الخاصّة بفاتورة المورّد — يستعمله الخادم
// (`server/services/ledger/supplierApEffect.ts` وكشف الحساب) والواجهة (كشف حساب المورّد) معاً،
// فلا تنجرف تسميةٌ عن أخرى. راجع [[supplier-statement-grni-adjust-blindness-2026-09-11]].
//
// لماذا نُميّز بالـdedupeKey؟ عمود `postingProfile` لا يُملأ إلّا حين يكون الدفتر المزدوج مفعَّلاً
// (OFF افتراضياً في الإنتاج) ⇒ NULL على كل قيود الإنتاج. أمّا dedupeKey فيُكتب دائماً على قيود GRNI.
//
// ⚠️ قيود GRNI **قد لا تحمل purchaseOrderId**: فاتورةٌ مطابَقة على عدّة أوامر تُرحَّل بـ`null`
// (supplierInvoices.ts)، وكلّ عكسٍ لفاتورة مورّد يُرحَّل بـ`null` كذلك — فهذه القيود تحرّك ذمّة
// المورّد لكنّها لا تنتمي لصفّ أمرٍ واحد، فيجب أن يعرفها كلُّ قارئٍ للذمّة.

/** بادئة قيد فاتورة المورّد GRNI (يدائن AP، أثرٌ موجب على ما ندين به). */
export const GRNI_SUPPLIER_INVOICE_FORWARD_PREFIX = "GRNI:SUPPLIER_INVOICE:";
/** بادئة عكس فاتورة المورّد GRNI (يَدين AP، أثرٌ سالب). */
export const GRNI_SUPPLIER_INVOICE_REVERSAL_PREFIX = "GRNI:SUPPLIER_INVOICE_REVERSAL:";

export type GrniApKind = "FORWARD" | "REVERSAL" | null;

/**
 * يصنّف قيداً بحسب نوعه وdedupeKey: فاتورة مورّد GRNI (`FORWARD` = +AP)، أو عكسها
 * (`REVERSAL` = −AP)، أو `null` (ليس قيد ذمّة GRNI). يُفحَص العكسُ أوّلاً للوضوح — والبادئتان
 * متمايزتان أصلاً (`…INVOICE:` مقابل `…INVOICE_REVERSAL:`).
 */
export function classifyGrniApEntry(
  entryType: string | null | undefined,
  dedupeKey: string | null | undefined,
): GrniApKind {
  if (entryType !== "ADJUST" || !dedupeKey) return null;
  if (dedupeKey.startsWith(GRNI_SUPPLIER_INVOICE_REVERSAL_PREFIX)) return "REVERSAL";
  if (dedupeKey.startsWith(GRNI_SUPPLIER_INVOICE_FORWARD_PREFIX)) return "FORWARD";
  return null;
}
