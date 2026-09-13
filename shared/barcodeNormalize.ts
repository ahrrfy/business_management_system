/**
 * تطبيع مدخل الباركود — نقطة حقيقة واحدة تُستعمَل عند الحفظ وعند المطابقة معاً.
 *
 * الجذر (٤/٩): حقول الباركود كانت تُحفَظ بلا أيّ تطبيع (مخطّطات zod بلا `.trim()` والإدراج يكتب
 * المُدخل خاماً)، بينما مسارات المسح/البحث تُقارن بمساواةٍ SQL خامّة على العمود المخزَّن. فمسافةٌ
 * طرفية واحدة عند الحفظ (لصقٌ من Excel، قارئٌ يُلحق مسافة، ضغطةُ مسافةٍ عرضية) تجعل الباركود
 * غير قابل للمطابقة أبداً بعدها — بلا خطأ ولا تحذير، فقط «الرمز الممسوح لا يطابق» على منتجٍ موجود.
 *
 * القاعدة: حدّ الإدخال (`server/lib/schemas.ts`) وخدمات الحفظ ومسارات المطابقة تُطبّع بهذه الدالّة
 * نفسها — ولا يُعاد اختراع «trim» في مكانٍ ثالث.
 */

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

// علامات اتجاه/تنسيق قد تُنسخ من صفحات RTL أو تُحقنها لوحة مفاتيح الهاتف. ليست جزءاً من
// أيّ باركود منتج، وبقاؤها يجعل رمزاً مرئياً واحداً هويتين مختلفتين.
const INVISIBLE_FORMAT_MARKS = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// قارئات HID وبعض ملفات CSV تلحق محارف framing. نزيلها عند الحافتين فقط؛ وجودها داخل
// الرمز خطأٌ يجب أن يرفضه حدّ الـAPI، لا أن يحوّله صامتاً إلى رمز آخر.
const EDGE_SCANNER_FRAMING = /^[\s\u0000-\u001f\u007f-\u009f]+|[\s\u0000-\u001f\u007f-\u009f]+$/g;
const INTERNAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NON_ASCII_WHITESPACE = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const UNSUPPORTED_FORMAT = /[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;

/**
 * يُطبِّع باركوداً واحداً:
 * - يُزيل المسافات **الطرفية** فقط — Code39 يسمح بمسافةٍ داخلية حرفاً معنوياً
 *   (`shared/barcodeSymbology.ts:CODE39_RE`) فلا تُلمَس.
 * - يطوي الأرقام العربية-الهندية والفارسية إلى لاتينية: لا ترميز باركودٍ معياريّ يعتمدها حرفاً،
 *   فظهورها دليلٌ قاطع على تسرّب تخطيط لوحة مفاتيح عربية أو لصقٍ من مصدرٍ غير مطبَّع.
 * - لا يمسّ حالة الأحرف: الحفظ يحتفظ بما طُبع على الملصق، والمطابقة توحّد الحالة في طرفها.
 */
export function canonicalizeBarcodeInput(raw: string): string {
  const trimmed = (raw ?? "")
    .replace(INVISIBLE_FORMAT_MARKS, "")
    .replace(EDGE_SCANNER_FRAMING, "");
  let out = "";
  for (const ch of trimmed) {
    const ai = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (ai >= 0) {
      out += String(ai);
      continue;
    }
    const pi = PERSIAN_DIGITS.indexOf(ch);
    out += pi >= 0 ? String(pi) : ch;
  }
  return out;
}

/** محارف لا يمكن حفظها/طباعتها بأمان داخل هوية باركود المنتج. */
export function hasUnsupportedBarcodeCharacters(raw: string): boolean {
  const normalized = canonicalizeBarcodeInput(raw);
  return INTERNAL_CONTROL.test(normalized)
    || NON_ASCII_WHITESPACE.test(normalized)
    || UNSUPPORTED_FORMAT.test(normalized);
}

function upcCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

function ean13CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

function isValidUpcA(code: string): boolean {
  return /^\d{12}$/.test(code) && Number(code[11]) === upcCheckDigit(code.slice(0, 11));
}

function isZeroPrefixedEan13(code: string): boolean {
  return /^0\d{12}$/.test(code) && Number(code[12]) === ean13CheckDigit(code.slice(0, 12));
}

/**
 * صور الهوية المكافئة التي قد تعيدها محركات المسح لنفس GTIN.
 *
 * ZXing قد يعيد EAN-13 البادئ بصفر كـUPC-A من 12 خانة. نوسّع صفراً واحداً فقط وبعد
 * التحقق من خانة الفحص؛ الأكواد القصيرة وغير القياسية تبقى حرفية ولا تفقد أصفارها.
 */
export function barcodeIdentityCandidates(raw: string): string[] {
  const code = canonicalizeBarcodeInput(raw);
  if (!code) return [];
  if (isValidUpcA(code)) return [code, `0${code}`];
  if (isZeroPrefixedEan13(code)) return [code, code.slice(1)];
  return [code];
}

/** مفتاح المقارنة الحالي للنظام: التطبيع النصي + عدم حساسية حالة الأحرف. */
export function barcodeComparisonKey(raw: string): string {
  return canonicalizeBarcodeInput(raw).toLowerCase();
}

export function barcodesEquivalent(left: string, right: string): boolean {
  const rightKeys = new Set(barcodeIdentityCandidates(right).map(barcodeComparisonKey));
  return barcodeIdentityCandidates(left).some((candidate) => rightKeys.has(barcodeComparisonKey(candidate)));
}
