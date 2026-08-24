const arabicIndicDigits = "٠١٢٣٤٥٦٧٨٩";
const extendedArabicIndicDigits = "۰۱۲۳۴۵۶۷۸۹";

export function latinDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String(arabicIndicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(extendedArabicIndicDigits.indexOf(digit)));
}

/** يحفظ الرقم المحلي بصيغة 7XXXXXXXXX، وتبقى +964 خارج حقل التحرير. */
export function canonicalIraqiLocalPhone(value: string) {
  const digits = latinDigits(value).replace(/\D/g, "");
  if (/^9647\d{9}$/.test(digits)) return digits.slice(3);
  if (/^07\d{9}$/.test(digits)) return digits.slice(1);
  return digits.slice(0, 10);
}

export function normalizeIraqiPhone(value: string) {
  const local = canonicalIraqiLocalPhone(value);
  return /^7\d{9}$/.test(local) ? `+964${local}` : null;
}
