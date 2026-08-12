/**
 * تحويل ناتج قارئ HID عندما يكون تخطيط لوحة المفاتيح في Windows مضبوطاً على العربية (101).
 *
 * القارئ لا يرسل «نصاً»؛ بل يرسل مواقع مفاتيح. لذلك يصبح INV مثلاً ÷آ{ عند التخطيط العربي.
 * هذه الدالة مخصّصة حصراً لمدخل قارئ مؤكّد بالتوقيت، وليست لتطبيع البحث العربي اليدوي.
 */
const ARABIC_101_TO_ASCII: Readonly<Record<string, string>> = Object.freeze({
  // الصف العلوي
  "ذ": "`", "ّ": "~",

  // QWERTY
  "ض": "q", "ص": "w", "ث": "e", "ق": "r", "ف": "t", "غ": "y", "ع": "u", "ه": "i", "خ": "o", "ح": "p",
  "ج": "[", "د": "]",
  "َ": "Q", "ً": "W", "ُ": "E", "ٌ": "R", "لإ": "T", "إ": "Y", "‘": "U", "÷": "I", "×": "O", "؛": "P",
  "<": "{", ">": "}",

  // ASDF
  "ش": "a", "س": "s", "ي": "d", "ب": "f", "ل": "g", "ا": "h", "ت": "j", "ن": "k", "م": "l", "ك": ";", "ط": "'",
  "ِ": "A", "ٍ": "S", "]": "D", "[": "F", "لأ": "G", "أ": "H", "ـ": "J", "،": "K", "/": "L",

  // ZXCV
  "ئ": "z", "ء": "x", "ؤ": "c", "ر": "v", "لا": "b", "ى": "n", "ة": "m", "و": ",", "ز": ".", "ظ": "/",
  "ْ": "X", "}": "C", "{": "V", "لآ": "B", "آ": "N", "’": "M", ",": "<", ".": ">", "؟": "?",
});

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const MULTI_CHAR_KEYS = ["لإ", "لأ", "لآ", "لا"] as const;
const HAS_ARABIC_LAYOUT_OUTPUT = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff÷×‘’]/;

function latinDigit(char: string): string | null {
  const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(char);
  if (arabicIndex >= 0) return String(arabicIndex);
  const persianIndex = PERSIAN_DIGITS.indexOf(char);
  return persianIndex >= 0 ? String(persianIndex) : null;
}

export function normalizeBarcodeScannerInput(raw: string): string {
  // إذا كان المدخل ASCII صحيحاً فلا نلمس رموزه المتداخلة مع مخرجات Shift العربية
  // (مثل / و[ و{). وجود حرف/رمز عربي واحد هو دليل أن التخطيط العربي كان فعّالاً.
  const translateLayout = HAS_ARABIC_LAYOUT_OUTPUT.test(raw);
  let normalized = "";
  for (let index = 0; index < raw.length;) {
    const multi = translateLayout
      ? MULTI_CHAR_KEYS.find((token) => raw.startsWith(token, index))
      : undefined;
    if (multi) {
      normalized += ARABIC_101_TO_ASCII[multi];
      index += multi.length;
      continue;
    }

    const char = raw[index];
    normalized += latinDigit(char) ?? (translateLayout ? ARABIC_101_TO_ASCII[char] : undefined) ?? char;
    index += 1;
  }
  return normalized.trim();
}

/**
 * تصحيح محافظ للنصوص التي لم يُثبت أنها صادرة من قارئ (رابط قديم/لصق/Enter يدوي).
 * لا نعيد النص المصحّح إلا إذا كشف بادئة نظام معروفة؛ وبذلك لا نفسد اسم عميل/منتج عربي.
 */
export function normalizeKnownSystemBarcode(raw: string): string {
  const normalized = normalizeBarcodeScannerInput(raw);
  return /^(?:INV|WO|PO|QUO|CUST|EMP|USER|ALR)(?:[-|]|\d)/i.test(normalized)
    ? normalized
    : raw;
}
