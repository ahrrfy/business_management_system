/**
 * تفقيط عربي مالي — يحوّل عدداً صحيحاً إلى صيغة نصية بالقواعد النحوية العربية الصحيحة.
 * منقول من dc.html في تسليم «مطبوعات مكتبة العربية» (٥/٧/٢٦):
 *  - آحاد/عشرات/مئات ألوف/ملايين/مليارات
 *  - تذكير/تأنيث الأعداد (تُستعمل الصيغة المذكّرة القياسية للتفقيط المالي)
 *  - حالات المفرد/المثنّى/الجمع للأصناف (مليار/ملياران/مليارات، ...)
 * الاستدعاء المعتاد: `formatArabicMoneyWords(n)` → "فقط X دينار عراقي لا غير"
 * ⚠️ يعمل على الجزء الصحيح فقط (يُقرَّب HALF_UP). العملة IQD لا فلوس مُتداولة.
 */
import { D } from "@/lib/money";

const ONES = [
  '', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
  'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر',
] as const;

const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'] as const;

const HUNDREDS = ['', 'مئة', 'مئتان', 'ثلاثمئة', 'أربعمئة', 'خمسمئة', 'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة'] as const;

interface Scale { value: number; s: string; d: string; p: string }

const SCALES: readonly Scale[] = [
  { value: 1_000_000_000, s: 'مليار', d: 'ملياران', p: 'مليارات' },
  { value: 1_000_000,     s: 'مليون', d: 'مليونان', p: 'ملايين' },
  { value: 1_000,         s: 'ألف',    d: 'ألفان',    p: 'آلاف'  },
];

function threeDigits(num: number): string {
  const parts: string[] = [];
  const h = Math.floor(num / 100);
  const rem = num % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rem) {
    if (rem < 20) parts.push(ONES[rem]);
    else {
      const t = Math.floor(rem / 10);
      const o = rem % 10;
      parts.push(o ? `${ONES[o]} و${TENS[t]}` : TENS[t]);
    }
  }
  return parts.join(' و');
}

/** يحوّل عدداً صحيحاً موجباً إلى كلمات عربية (بلا بادئة/لاحقة). */
export function toArabicWords(nRaw: number | string): string {
  // round2/D يضبطان Decimal.rounding=HALF_UP عالمياً (money.ts) — toDecimalPlaces(0) هنا يتبع نفس القاعدة.
  const n = D(nRaw).abs().toDecimalPlaces(0).toNumber();
  if (n === 0) return 'صفر';
  let rem = n;
  const segs: string[] = [];
  for (const sc of SCALES) {
    const c = Math.floor(rem / sc.value);
    rem %= sc.value;
    if (!c) continue;
    if (c === 1)       segs.push(sc.s);
    else if (c === 2)  segs.push(sc.d);
    else if (c <= 10)  segs.push(`${threeDigits(c)} ${sc.p}`);
    else               segs.push(`${threeDigits(c)} ${sc.s}`);
  }
  if (rem > 0) segs.push(threeDigits(rem));
  return segs.join(' و');
}

/** يحوّل مبلغاً إلى صيغة تفقيط مالية كاملة: "فقط ... دينار عراقي لا غير". */
export function formatArabicMoneyWords(nRaw: number | string): string {
  return `فقط ${toArabicWords(nRaw)} دينار عراقي لا غير`;
}
