// ثوابت العلامة التجارية لمكتبة العربية — مشتركة بين كل قوالب الطباعة

export const BRAND = {
  green: '#1A9B78',
  greenDark: '#0D6B52',
  greenDeep: '#064E3B',
  greenLight: '#D1FAE5',
  greenPale: '#ECFDF5',
  greenMist: '#F0FDF9',
  orange: '#CC7E3F',
  orangeLight: '#FEF3C7',
  orangePale: '#FFFBEB',
  orangeDark: '#92400E',
  text: '#000000',
  textSec: '#000000',
  textMuted: '#1a1a1a',
  textFaint: '#333333',
  border: '#E5E7EB',
  borderDk: '#D1D5DB',
  borderLight: '#F3F4F6',
  bg: '#F9FAFB',
  bgWarm: '#FDFCFA',
  white: '#ffffff',
};

export const CO = {
  name: 'شركة الرؤية العربية للتجارة العامة وتجارة القرطاسية',
  sub: 'مكتبة العربية للطباعة والقرطاسية',
  footer: 'شكراً لتعاملكم مع مكتبة العربية',
  address: 'بغداد — العامرية / شارع العمل الشعبي',
  phones: [
    { l: 'الحسابات',         n: '07883000017' },
    { l: 'المبيعات / واتساب', n: '07838666999' },
    { l: 'المبيعات',          n: '07833484932' },
    { l: 'الطباعة',           n: '07838484932' },
    { l: 'المطبعة',           n: '07838379999' },
    { l: 'الفرع الثاني',      n: '07838666640' },
  ],
};

/** HTML-escape helper */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Format number with English locale (comma-separated) */
export const fmt = (n: string | number | null | undefined): string =>
  n == null || n === '' ? '—' : Number(n).toLocaleString('en-US');

/** Format currency in IQD */
export const fmtC = (n: string | number | null | undefined): string =>
  n == null || n === '' ? '—' : `${fmt(n)} د.ع`;

/** Absolute logo URL for use in print windows */
export function logoUrl(): string {
  return typeof window !== 'undefined' ? `${window.location.origin}/logo.png` : '/logo.png';
}

/** Open a print window with given HTML */
export function openPrintWindow(html: string, opts = 'width=900,height=1100'): void {
  if (typeof window === 'undefined') return;
  const w = window.open('', '_blank', opts);
  if (w) { w.document.write(html); w.document.close(); }
}

/**
 * خط Cairo مستضاف محلياً لقوالب الطباعة (بلا Google Fonts CDN) ⇒ تطبع المستندات بالخط الصحيح **بلا إنترنت**.
 * الملفات في client/public/fonts/ تُخدَم من خادم التطبيق؛ نستعمل أصلاً مطلقاً (origin) لأن نافذة الطباعة
 * تُفتح كـabout:blank فلا تُحلّ المسارات النسبية. لكل وزن: وجهٌ لاتيني (افتراضي) + وجهٌ عربي (بنطاق يونيكود).
 */
const FONT_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const CAIRO_ARABIC_RANGE =
  "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC";
export const CAIRO_FONT = `<style>${[400, 500, 600, 700, 800, 900]
  .map(
    (w) =>
      `@font-face{font-family:'Cairo';font-style:normal;font-weight:${w};font-display:swap;src:url('${FONT_ORIGIN}/fonts/cairo-latin-${w}-normal.woff2') format('woff2')}` +
      `@font-face{font-family:'Cairo';font-style:normal;font-weight:${w};font-display:swap;src:url('${FONT_ORIGIN}/fonts/cairo-arabic-${w}-normal.woff2') format('woff2');unicode-range:${CAIRO_ARABIC_RANGE}}`,
  )
  .join("")}</style>`;
