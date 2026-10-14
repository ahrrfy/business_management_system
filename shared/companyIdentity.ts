/**
 * هوية المنشأة الموحّدة — مصدر حقيقة واحد للعميل (قوالب طباعة المتصفح) والخادم (PDF الرسمي).
 *
 * كانت هذه البيانات حبيسة client/src/lib/printing/brand.ts فولّد الخادم مستندات PDF بلا عنوان
 * ولا هواتف (فاقدة معلومات التواصل). القيم القانونية (ضريبي/سجل/إجازة) قيم افتراضية بانتظار
 * تحديث المالك — كل استدعاء طباعة يمكنه تجاوزها عبر إعدادات الشركة.
 */
export const COMPANY_IDENTITY = {
  name:   'شركة الرؤية العربية للتجارة العامة وتجارة القرطاسية',
  sub:    'مكتبة العربية للطباعة والقرطاسية',
  short:  'مكتبة العربية',
  subtitle: 'للطباعة والقرطاسية',
  footer: 'شكراً لتعاملكم مع مكتبة العربية',
  address: 'بغداد — العامرية / شارع العمل الشعبي',

  /** الأرقام القانونية — قيم افتراضية من مرجع التصميم (لا تُثبّت أرقام تجريبية على مستندات رسمية). */
  taxId:              '700124589',
  commercialRegistry: '45217',
  chamberLicense:     'CCB-11298',

  phones: [
    { l: 'الحسابات',         n: '07883000017' },
    { l: 'المبيعات / واتساب', n: '07838666999' },
    { l: 'المبيعات',          n: '07833484932' },
    { l: 'الطباعة',           n: '07838484932' },
    { l: 'المطبعة',           n: '07838379999' },
    { l: 'الفرع الثاني',      n: '07838666640' },
  ],

  /** خطّ الفوتر المدموج للمستندات الرسمية (عنوان · هاتفان مختصران). */
  footerLine: 'بغداد — العامرية / شارع العمل الشعبي · 07883000017 · 07838666999',
} as const;

export interface CompanyIdentityPhone {
  l: string;
  n: string;
}

export interface CompanyIdentityData {
  name: string;
  sub: string;
  short: string;
  subtitle: string;
  footer: string;
  address: string;
  taxId: string;
  commercialRegistry: string;
  chamberLicense: string;
  phones: readonly CompanyIdentityPhone[];
  footerLine: string;
  logoUrl?: string | null;
}

/**
 * يدمج بيانات الشركة الديناميكية مع القيم الافتراضية المرجعية.
 * تمنح الأولوية للبيانات المخصصة المحفوظة، مع الحفاظ على قيم الطوارئ الافتراضية.
 */
export function resolveCompanyIdentity(override?: Partial<CompanyIdentityData> | null): CompanyIdentityData {
  if (!override) return COMPANY_IDENTITY;

  const name = override.name?.trim() || COMPANY_IDENTITY.name;
  const sub = override.sub?.trim() || COMPANY_IDENTITY.sub;
  const short = override.short?.trim() || COMPANY_IDENTITY.short;
  const subtitle = override.subtitle?.trim() || COMPANY_IDENTITY.subtitle;
  const footer = override.footer?.trim() || COMPANY_IDENTITY.footer;
  const address = override.address?.trim() || COMPANY_IDENTITY.address;
  const taxId = override.taxId?.trim() || COMPANY_IDENTITY.taxId;
  const commercialRegistry = override.commercialRegistry?.trim() || COMPANY_IDENTITY.commercialRegistry;
  const chamberLicense = override.chamberLicense?.trim() || COMPANY_IDENTITY.chamberLicense;
  const phones = override.phones !== undefined ? override.phones : COMPANY_IDENTITY.phones;
  const defaultFirstTwoPhones = phones.slice(0, 2).map((p) => p.n).filter(Boolean).join(' · ');
  const footerLine =
    override.footerLine?.trim() ||
    (address && defaultFirstTwoPhones
      ? `${address} · ${defaultFirstTwoPhones}`
      : (address ? address : COMPANY_IDENTITY.footerLine));
  const logoUrl = override.logoUrl?.trim() || null;

  return {
    name,
    sub,
    short,
    subtitle,
    footer,
    address,
    taxId,
    commercialRegistry,
    chamberLicense,
    phones,
    footerLine,
    logoUrl,
  };
}

