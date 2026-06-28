// مُطابِق بحث نصّي خفيف للقوائم (تصفية على العميل) — واعٍ بالعربية.
//
// يُطبّع الاستعلام والنصّ (إزالة التشكيل، توحيد الألف/الياء/التاء المربوطة، الأرقام
// العربية ⇒ لاتينية) ثمّ يتحقّق من احتواء كلّ كلمة (AND) في أيّ من الحقول الممرَّرة.
// يُستعمل في شاشات القوائم التي تُحمَّل دفعةً واحدة (مصروفات/فئات/حضور/مرتجعات شراء).

const AR_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

const AR_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** تطبيع نصّ عربي/لاتيني للمقارنة: حروف صغيرة + إزالة تشكيل + توحيد أشكال متقاربة. */
export function arNormalize(input: string): string {
  return (input ?? "")
    .toString()
    .toLowerCase()
    .replace(AR_DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[٠-٩]/g, (d) => AR_DIGITS[d] ?? d)
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * هل تطابق الحقول الاستعلامَ؟ كلّ كلمة في الاستعلام يجب أن تَرِد في الحقول المجمَّعة (AND).
 * استعلام فارغ ⇒ true (يُظهر الكل).
 */
export function matchQuery(query: string, fields: Array<string | number | null | undefined>): boolean {
  const q = arNormalize(query);
  if (!q) return true;
  const hay = arNormalize(fields.filter((f) => f != null && f !== "").join(" "));
  return q.split(" ").every((word) => hay.includes(word));
}
