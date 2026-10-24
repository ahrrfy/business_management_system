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
export const DOC_PREFIXES = [
  "INV",
  "WO",
  "PO",
  "QUO",
  "VCH",
  "TRN",
  "EXC",
  "GIFT",
  "ORD",
  "CN",
  "CNS",
  "DRF",
  "RET",
  "PAY",
  "REC",
  "FR",
  "AE",
  "CHG",
] as const;
export type DocPrefix = (typeof DOC_PREFIXES)[number];

/** يبني رمز الآلة: `INV-10023`. الرقم التاريخيّ المُبدوء ببادئته يُعاد كما هو بلا تكرارها. */
export function docBarcode(prefix: DocPrefix | string, documentNumber: string): string {
  const n = documentNumber.trim();
  if (!n) return n;
  const p = prefix.toUpperCase();
  if (n.toUpperCase().startsWith(`${p}-`)) return n;
  if ((p === "CN" || p === "CNS") && /^CNS?-/i.test(n)) return n;
  return `${p}-${n}`;
}

/**
 * ينزع بادئة النوع **فقط حين يكون الباقي رقماً قصيراً** — أي حين تكون الصيغة الجديدة.
 *
 * الشرط جوهريّ: `INV-10023` ⇒ `10023` (رقم عرضٍ حقيقيّ يُطابَق في القاعدة)، بينما
 * `INV-1-20260818-00073` يبقى **كما هو** لأنّ الباقي ليس رقماً — وهو رقم العرض التاريخيّ
 * نفسه. بلا هذا الشرط كان المسح على مستندٍ قديم يبحث عن «1-20260818-00073» فلا يجد شيئاً.
 */
export function stripDocPrefix(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // الصيغة التاريخية (مثل INV-1-20260818-00073 أو المصحَّحة INV-1-20260818-00073-1) تبقى كما هي للبحث والمسح
  if (/^(?:INV|WO|PO|QUO|VCH|TRN|EXC|GIFT|ORD|CNS?|DRF|RET|PAY|REC)-\d+-\d{8}-\d+(?:-\d+)*$/i.test(s)) {
    return s;
  }
  const m = /^(?:INV|WO|PO|QUO|VCH|TRN|EXC|GIFT|ORD|CNS?|DRF|RET|PAY|REC)-(\d+(?:-\d+)*)$/i.exec(s);
  return m ? m[1] : s;
}

/**
 * ينسّق رقم المستند المشتقّ من رقم التتبع الأساسي للمعاملة (R1).
 *
 * - المستند الوحيد (أو siblingIndex = 0/undefined): يحمل رقم التتبع الأساسي مباشرةً (`100001`).
 * - عند تعدد المستندات من نفس النوع في المعاملة (أكثر من أمر شغل في سلة واحدة، أو أكثر من إرسالية):
 *   يحمل كل مستند لاحقة فرعية (`100001-1`, `100001-2`) لمنع تصادم القيود الفريدة (`UNIQUE`)
 *   مع بقاء الرقم الأساسي هو مرجع التتبع والعرض.
 */
export function formatDocumentNumber(baseTrackingNumber: string, siblingIndex?: number): string {
  const base = String(baseTrackingNumber ?? "").trim();
  if (!base) {
    return "";
  }
  if (typeof siblingIndex === "number" && Number.isInteger(siblingIndex) && siblingIndex > 0) {
    return `${base}-${siblingIndex}`;
  }
  return base;
}

