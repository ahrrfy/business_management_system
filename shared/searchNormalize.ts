/**
 * تطبيع نص البحث العربي — مصدر واحد للعميل والخادم.
 *
 * المشكلة: «ازرق» يجب أن يجد «أزرق»، و«مكتبه» يجب أن تجد «مكتبة».
 * المستخدم لا يلتزم بالهمزات/التاء المربوطة/الألف المقصورة عند الكتابة السريعة على الكاشير،
 * وملفات الاستيراد القديمة غير منضبطة إملائياً أصلاً.
 *
 * القاعدة: تُطبَّع **كلتا الجهتين** (نص العمود في SQL عبر سلسلة REPLACE مولَّدة من
 * نفس الجدول أدناه، ونص الاستعلام هنا) ⇒ المطابقة تتم في فضاء مُوحَّد.
 */

/** أزواج (من ⇒ إلى) لتطبيع المحارف العربية — تُستعمل حرفياً لتوليد REPLACE في SQL. */
export const ARABIC_FOLD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["أ", "ا"],
  ["إ", "ا"],
  ["آ", "ا"],
  ["ٱ", "ا"],
  ["ة", "ه"],
  ["ى", "ي"],
  ["ؤ", "و"],
  ["ئ", "ي"],
  ["ـ", ""], // التطويل (كشيدة)
];

/** الأرقام العربية-الهندية ⇒ لاتينية (الباركود/الأسعار تُكتب أحياناً بهما من لوحة عربية). */
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** حركات التشكيل — تُحذف من نص الاستعلام (أسماء المنتجات لا تُشكَّل عادة). */
const DIACRITICS = /[ً-ٰٟ]/g;

/** تطبيع نص استعلام/اسم للمقارنة: همزات + تاء مربوطة + مقصورة + أرقام + تشكيل + مسافات. */
export function normalizeSearchText(s: string): string {
  let out = (s ?? "").trim().toLowerCase();
  out = out.replace(DIACRITICS, "");
  for (const [from, to] of ARABIC_FOLD_PAIRS) out = out.split(from).join(to);
  let digits = "";
  for (const ch of out) {
    const ai = ARABIC_DIGITS.indexOf(ch);
    const pi = PERSIAN_DIGITS.indexOf(ch);
    digits += ai >= 0 ? String(ai) : pi >= 0 ? String(pi) : ch;
  }
  return digits.replace(/\s+/g, " ");
}

/** تقطيع الاستعلام إلى كلمات مُطبَّعة (كل كلمة تُطابَق باستقلال ⇒ «قلم ازرق» يجد «قلم جاف أزرق»). */
export function tokenizeSearchQuery(s: string, maxTokens = 5): string[] {
  return normalizeSearchText(s)
    .split(" ")
    .filter(Boolean)
    .slice(0, maxTokens);
}

/** تهريب محارف أنماط LIKE — وإلا «100%» يطابق كل شيء. (escape char = \\) */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
