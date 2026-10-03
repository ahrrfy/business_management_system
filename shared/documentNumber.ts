/**
 * أرقام المستندات — فصلُ **رقم العرض** عن **رمز الآلة** (طلب المالك ١٨/٨).
 *
 * رقم العرض: عددٌ تسلسليّ قصير (`10023`) — يُملى هاتفياً ويُكتب يدوياً بلا خطأ.
 * رمز الآلة: نفس الرقم ببادئة نوعه (`INV-10023`) — بها يعرف الماسح إلى أين يذهب.
 *
 * والصيغة التاريخية (`INV-1-20260818-00073`) تبقى صالحةً للبحث والمسح إلى الأبد: المستندات
 * المطبوعة بيد الزبائن لا تُستبدَل، فأيّ دالّة هنا تقبل الصيغتين.
 */

/** بادئات المستندات المعروفة للنظام (نفس مجموعة `scanRouter`). */
export const DOC_PREFIXES = ["INV", "WO", "PO", "QUO", "VCH", "TRN", "EXC", "GIFT", "ORD", "CNS"] as const;
export type DocPrefix = (typeof DOC_PREFIXES)[number];

/** يبني رمز الآلة: `INV-10023`. الرقم التاريخيّ المُبدوء ببادئته يُعاد كما هو بلا تكرارها. */
export function docBarcode(prefix: DocPrefix | string, documentNumber: string): string {
  const n = documentNumber.trim();
  if (!n) return n;
  const p = prefix.toUpperCase();
  return n.toUpperCase().startsWith(`${p}-`) ? n : `${p}-${n}`;
}

/**
 * ينزع بادئة النوع **فقط حين يكون الباقي رقماً قصيراً** — أي حين تكون الصيغة الجديدة.
 *
 * الشرط جوهريّ: `INV-10023` ⇒ `10023` (رقم عرضٍ حقيقيّ يُطابَق في القاعدة)، بينما
 * `INV-1-20260818-00073` يبقى **كما هو** لأنّ الباقي ليس رقماً — وهو رقم العرض التاريخيّ
 * نفسه. بلا هذا الشرط كان المسح على مستندٍ قديم يبحث عن «1-20260818-00073» فلا يجد شيئاً.
 */
export function stripDocPrefix(raw: string): string {
  const s = raw.trim();
  const m = /^(INV|WO|PO|QUO|VCH|TRN|EXC|GIFT|ORD|CNS)-(\d+)$/i.exec(s);
  return m ? m[2] : s;
}
