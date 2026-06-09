/**
 * أداة هاتف دولي (E.164) — تنسيق وتطبيع وتحقّق.
 * v3-add-screens: كل أرقام الهاتف في النظام تُخزّن بصيغة E.164 الدولية
 * (مثل `+9647701234567`) لدعم واتساب وWA Business API لاحقاً بلا تحويل.
 *
 * التصميم:
 *  - الواجهة تختار مفتاح دولة من قائمة DIAL_CODES + رقم محلّي بأرقام إنكليزية فقط.
 *  - التخزين/الإرسال للخادم: E.164 ⇒ `+<cc><nationalDigits>` بلا فراغات.
 *  - parseE164: يفكّك السلسلة لمفتاح ورقم لإعادة عرضها في النموذج.
 *  - أرقامنا العراقية تحذف الصفر البادئ تلقائياً (0770 → 770).
 */

export interface DialCode {
  code: string;   // مثل "+964"
  iso2: string;   // مثل "IQ"
  flag: string;   // علم emoji
  label: string;  // اسم بالعربية
}

export const DIAL_CODES: DialCode[] = [
  { code: "+964", iso2: "IQ", flag: "🇮🇶", label: "العراق" },
  { code: "+966", iso2: "SA", flag: "🇸🇦", label: "السعودية" },
  { code: "+971", iso2: "AE", flag: "🇦🇪", label: "الإمارات" },
  { code: "+965", iso2: "KW", flag: "🇰🇼", label: "الكويت" },
  { code: "+974", iso2: "QA", flag: "🇶🇦", label: "قطر" },
  { code: "+973", iso2: "BH", flag: "🇧🇭", label: "البحرين" },
  { code: "+968", iso2: "OM", flag: "🇴🇲", label: "عُمان" },
  { code: "+962", iso2: "JO", flag: "🇯🇴", label: "الأردن" },
  { code: "+961", iso2: "LB", flag: "🇱🇧", label: "لبنان" },
  { code: "+963", iso2: "SY", flag: "🇸🇾", label: "سوريا" },
  { code: "+970", iso2: "PS", flag: "🇵🇸", label: "فلسطين" },
  { code: "+90",  iso2: "TR", flag: "🇹🇷", label: "تركيا" },
  { code: "+20",  iso2: "EG", flag: "🇪🇬", label: "مصر" },
  { code: "+1",   iso2: "US", flag: "🇺🇸", label: "أمريكا/كندا" },
  { code: "+44",  iso2: "GB", flag: "🇬🇧", label: "المملكة المتحدة" },
  { code: "+49",  iso2: "DE", flag: "🇩🇪", label: "ألمانيا" },
  { code: "+33",  iso2: "FR", flag: "🇫🇷", label: "فرنسا" },
];

export const DEFAULT_DIAL = "+964";

/** يطبع رقم وطني (يحذف الصفر البادئ ويترك الأرقام فقط). */
export function normalizeNational(input: string): string {
  return (input || "")
    .replace(/\D+/g, "")
    .replace(/^0+/, "")
    .slice(0, 15);
}

/** يبني صيغة E.164 من مفتاح + رقم وطني. يعود "" إن كان الرقم فارغاً. */
export function toE164(dial: string, national: string): string {
  const d = (dial || DEFAULT_DIAL).trim();
  const n = normalizeNational(national);
  if (!n) return "";
  return `${d}${n}`;
}

/** يفكّك سلسلة E.164 إلى مفتاح + رقم وطني. أيّ شكل غير معروف يُعاد إلى الافتراضي. */
export function parseE164(s: string | null | undefined): { dial: string; national: string } {
  if (!s) return { dial: DEFAULT_DIAL, national: "" };
  const v = s.trim();
  // فقط أرقام (بلا +) ⇒ نعتبره وطنياً افتراضياً.
  if (/^\d+$/.test(v)) return { dial: DEFAULT_DIAL, national: normalizeNational(v) };
  // بـ + ⇒ نطابق أطول مفتاح ممكن.
  const match = DIAL_CODES.slice().sort((a, b) => b.code.length - a.code.length).find((d) => v.startsWith(d.code));
  if (match) {
    return { dial: match.code, national: normalizeNational(v.slice(match.code.length)) };
  }
  return { dial: DEFAULT_DIAL, national: normalizeNational(v) };
}

/** عرض جميل للهاتف (LTR، مع فراغات): `+964 770 123 4567`. */
export function displayE164(s: string | null | undefined): string {
  if (!s) return "";
  const { dial, national } = parseE164(s);
  if (!national) return dial;
  // قسّم بأطوال شائعة 3-3-4.
  const parts = [
    national.slice(0, 3),
    national.slice(3, 6),
    national.slice(6, 10),
    national.slice(10),
  ].filter(Boolean);
  return `${dial} ${parts.join(" ")}`.trim();
}

/** تحقّق بسيط: الرقم الوطني ٧–١٥ رقماً. */
export function isValidE164(s: string | null | undefined): boolean {
  if (!s) return false;
  const { national } = parseE164(s);
  return national.length >= 7 && national.length <= 15;
}

/** رابط واتساب: wa.me/<digits-without-+>. لا يصلح ⇒ "". */
export function whatsappLink(s: string | null | undefined): string {
  if (!isValidE164(s)) return "";
  const { dial, national } = parseE164(s);
  return `https://wa.me/${dial.replace("+", "")}${national}`;
}
