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

/** Google Fonts link tag for Cairo */
export const CAIRO_FONT = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">`;
