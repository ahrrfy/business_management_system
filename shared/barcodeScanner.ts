/**
 * تحويل ناتج قارئ HID عندما يكون تخطيط لوحة المفاتيح في Windows مضبوطاً على العربية (101).
 *
 * القارئ لا يرسل «نصاً»؛ بل يرسل مواقع مفاتيح. لذلك يصبح INV مثلاً ÷آ{ عند التخطيط العربي.
 * هذه الدالة مخصّصة حصراً لمدخل قارئ مؤكّد بالتوقيت أو البادئة، وليست لتطبيع البحث العربي اليدوي.
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

const INVISIBLE_FORMAT_MARKS = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/** بادئة معرّف المعيار الدولي للماسحات (ISO/IEC 15424 AIM Identifier): مثل ]E0 (لـ EAN) أو ]C1 (لـ Code-128) */
const AIM_CODE_IDENTIFIER = /^\][A-Za-z0-9]{2}/;

export function normalizeBarcodeScannerInput(raw: string): string {
  if (!raw) return "";
  const cleaned = raw.replace(INVISIBLE_FORMAT_MARKS, "").trim();
  const translateLayout = HAS_ARABIC_LAYOUT_OUTPUT.test(cleaned);
  let normalized = "";
  for (let index = 0; index < cleaned.length;) {
    const multi = translateLayout
      ? MULTI_CHAR_KEYS.find((token) => cleaned.startsWith(token, index))
      : undefined;
    if (multi) {
      normalized += ARABIC_101_TO_ASCII[multi];
      index += multi.length;
      continue;
    }

    const char = cleaned[index];
    normalized += latinDigit(char) ?? (translateLayout ? ARABIC_101_TO_ASCII[char] : undefined) ?? char;
    index += 1;
  }
  const result = normalized.trim();
  // تجريد بادئة معرّف AIM الدولي إن وُجدت
  return result.replace(AIM_CODE_IDENTIFIER, "").trim();
}

/**
 * تصحيح محافظ للنصوص التي يُراد التحقق من أنها تحمل بادئة باركود مستندية معروفة في النظام:
 * - فواتير: INV-
 * - أوامر شغل: WO-
 * - طلبات متجر/موقع: ORD-
 * - إرساليات توصيل: CN-
 * - حجوزات: RES-
 * - أوامر شراء: PO-
 * - عروض أسعار: QUO-
 * - بطاقات وتراخيص: CUST-, EMP-, USER-, ALR-
 */
export const KNOWN_SYSTEM_PREFIXES = [
  "INV", "ORD", "WO", "CN", "RES", "PO", "QUO", "CUST", "EMP", "USER", "ALR",
] as const;

export function looksLikeSystemBarcode(raw: string): boolean {
  if (!raw) return false;
  const normalized = normalizeBarcodeScannerInput(raw);
  return new RegExp(`^(?:${KNOWN_SYSTEM_PREFIXES.join("|")})(?:[-|]|\\d)`, "i").test(normalized);
}

export const normalizeArabicKeyboardToAscii = normalizeBarcodeScannerInput;

export function normalizeKnownSystemBarcode(raw: string): string {
  if (!raw) return "";
  const normalized = normalizeBarcodeScannerInput(raw);
  if (!looksLikeSystemBarcode(normalized)) {
    return raw.startsWith("]") ? normalized : raw.trim();
  }
  const match = normalized.match(new RegExp(`^(${KNOWN_SYSTEM_PREFIXES.join("|")})([-|]?.*)$`, "i"));
  if (match) {
    return `${match[1].toUpperCase()}${match[2]}`;
  }
  return normalized;
}
