/**
 * shared/quantityFormat.ts — مصدر الحقيقة الموحّد لتنسيق وعرض الكميات عبر النظام وقوالب الطباعة.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * المشكلة والدافع:
 * في MySQL/Drizzle، تُعرَّف أعمدة الكميات كـ `decimal(15,3)` (أو `decimal(15,4)` في بعض الجداول).
 * يعيد محرك قاعدة البيانات ومشغل mysql2 هذه الحقول كسلاسل نصية ثابتة المنازل محشوة بأصفارٍ عشرية
 * زائدة (مثل "1000.000" أو "120.000")، مما يسبب تشتتاً بصرياً وإرباكاً للمستخدم عند القراءة.
 *
 * الفخاخ المعمارية السابقة:
 * ١) تصيير السلسلة النصية الخام مباشرة (`row.original.quantity` ⇒ "1000.000" في الفواتير وعروض الأسعار).
 * ٢) استعمال دوال المال `fmtAr` التي تطبق `round2` فتُقصر الكسر العشري الحقيقي للكميات قسراً
 *    (مثل 1.125 كغم تحولها إلى 1.13)، وهذا تلفٌ في الدقة المخزنية.
 * ٣) نسخ دوال محلية خاصة مثل `fmtQty` داخل ملفات منفصلة دون تعميمها (`printTemplatesV2.ts`).
 *
 * القواعد الصارمة لهذه الوحدة:
 * • حذف الأصفار الزائدة بعد الفاصلة (1000.000 ⇒ 1,000 | 120.000 ⇒ 120 | 1.500 ⇒ 1.5).
 * • حفظ الكسور العشرية الحقيقية حتى 4 منازل بلا تقريب جائر (1.125 ⇒ 1.125).
 * • دعم فواصل الآلاف لتسهيل القراءة (10,000).
 * • معالجة آمنة للقيم الفارغة (null / undefined / "" ⇒ fallback "—").
 * • ممنوع استعمالها في حمولات الـ API أو الحسابات المحاسبية — هذه الدالة للعرض فقط (Display only).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface FormatQuantityOptions {
  /** القيمة المعادة في حال كان المدخل null أو undefined أو نصاً فارغاً (الافتراضي: "—") */
  fallback?: string;
  /** تفعيل فواصل الآلاف (الافتراضي: true) */
  useGrouping?: boolean;
  /** اسم بديل لـ useGrouping */
  groupThousands?: boolean;
  /** الحد الأقصى للمنازل العشرية (الافتراضي: 4 لحماية كامل دقة decimal(15,4)) */
  maximumFractionDigits?: number;
  /** المحلّي (الافتراضي: "en-US" لإنتاج أرقام لاتينية قياسية 0..9 وفواصل آلاف واضحة) */
  locale?: string;
}

/**
 * تنسيق كمية للعرض فقط: إزالة الأصفار العشرية الزائدة مع حفظ الكسور الحقيقية وفواصل الآلاف.
 */
export function formatQuantity(
  value: string | number | { toString(): string } | null | undefined,
  options?: FormatQuantityOptions,
): string {
  const fallback = options?.fallback ?? "—";
  if (value == null) return fallback;

  const str = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : String(value).trim();
  if (str === "") return fallback;

  const num = Number(str);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return str;
  }

  const useGrouping = options?.useGrouping ?? options?.groupThousands ?? true;
  const maximumFractionDigits = options?.maximumFractionDigits ?? 4;
  const locale = options?.locale ?? "en-US";

  return num.toLocaleString(locale, {
    useGrouping,
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

/**
 * الاسم البديل المختصر المعتمد في قوالب الطباعة والإشعارات (printTemplatesV2).
 */
export const fmtQty = formatQuantity;
