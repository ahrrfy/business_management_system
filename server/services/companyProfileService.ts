// خدمة هوية وبيانات المنشأة المؤسسية — صفّ singleton واحد (id=1) يضبط
// الاسم الرسمي، اسم الشهرة/العلامة التجارية، الاسم المختصر، الأرقام القانونية (السجل، الضريبة، الإجازة)،
// عنوان المقر الرئيسي، أرقام أقسام التواصل، وشعار المنشأة المعتمد لمستندات الطباعة.
//
// get-or-create كسول: القراءة الأولى تُنشئ الصفّ بالقيم المرجعية من shared/companyIdentity.ts إن غاب،
// تماماً كنمط taxSettingsService و openingModeService.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { companyProfile, taxSettings } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";
import { COMPANY_IDENTITY } from "@shared/companyIdentity";

export interface CompanyPhoneItem {
  label: string;
  number: string;
}

export interface CompanyProfileView {
  id: number;
  name: string;
  tradeName: string | null;
  shortName: string | null;
  legalSubtitle: string | null;
  commercialRegistry: string | null;
  taxNumber: string | null;
  chamberLicense: string | null;
  address: string | null;
  phones: CompanyPhoneItem[];
  logoUrl: string | null;
  footerText: string | null;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
}

function normalizePhones(raw: unknown): CompanyPhoneItem[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const label = String((item as any).label ?? (item as any).l ?? "").trim();
        const number = String((item as any).number ?? (item as any).n ?? "").trim();
        if (!label && !number) return null;
        return { label: label || "عام", number };
      })
      .filter((p): p is CompanyPhoneItem => p !== null);
  }
  return COMPANY_IDENTITY.phones.map((p) => ({ label: p.l, number: p.n }));
}

function toView(row: typeof companyProfile.$inferSelect): CompanyProfileView {
  return {
    id: row.id,
    name: row.name || COMPANY_IDENTITY.name,
    tradeName: row.tradeName ?? COMPANY_IDENTITY.sub,
    shortName: row.shortName ?? COMPANY_IDENTITY.short,
    legalSubtitle: row.legalSubtitle ?? COMPANY_IDENTITY.subtitle,
    commercialRegistry: row.commercialRegistry ?? COMPANY_IDENTITY.commercialRegistry,
    taxNumber: row.taxNumber ?? COMPANY_IDENTITY.taxId,
    chamberLicense: row.chamberLicense ?? COMPANY_IDENTITY.chamberLicense,
    address: row.address ?? COMPANY_IDENTITY.address,
    phones: normalizePhones(row.phones),
    logoUrl: row.logoUrl ?? null,
    footerText: row.footerText ?? COMPANY_IDENTITY.footer,
    updatedBy: row.updatedBy ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** يقرأ صفّ بيانات المنشأة (id=1)، وينشئه بالقيم الافتراضية إن لم يكن موجوداً بعد. */
export async function getCompanyProfile(): Promise<CompanyProfileView> {
  const db = requireDb();
  const existing = await db.select().from(companyProfile).where(eq(companyProfile.id, 1)).limit(1);
  if (existing[0]) return toView(existing[0]);

  const defaultPhones = COMPANY_IDENTITY.phones.map((p) => ({ label: p.l, number: p.n }));

  await db
    .insert(companyProfile)
    .values({
      id: 1,
      name: COMPANY_IDENTITY.name,
      tradeName: COMPANY_IDENTITY.sub,
      shortName: COMPANY_IDENTITY.short,
      legalSubtitle: COMPANY_IDENTITY.subtitle,
      commercialRegistry: COMPANY_IDENTITY.commercialRegistry,
      taxNumber: COMPANY_IDENTITY.taxId,
      chamberLicense: COMPANY_IDENTITY.chamberLicense,
      address: COMPANY_IDENTITY.address,
      phones: defaultPhones,
      logoUrl: null,
      footerText: COMPANY_IDENTITY.footer,
    })
    .onDuplicateKeyUpdate({ set: { id: 1 } });

  const created = await db.select().from(companyProfile).where(eq(companyProfile.id, 1)).limit(1);
  if (!created[0]) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء بيانات المنشأة." });
  }
  return toView(created[0]);
}

export interface UpdateCompanyProfileInput {
  name: string;
  tradeName?: string | null;
  shortName?: string | null;
  legalSubtitle?: string | null;
  commercialRegistry?: string | null;
  taxNumber?: string | null;
  chamberLicense?: string | null;
  address?: string | null;
  phones?: CompanyPhoneItem[];
  logoUrl?: string | null;
  footerText?: string | null;
}

/** يحدّث بيانات هوية المنشأة (id=1) — ينشئها أولاً إن غابت، ويُزامن الرقم الضريبي مع إعدادات الضريبة. */
export async function updateCompanyProfile(
  input: UpdateCompanyProfileInput,
  actor: { userId: number },
): Promise<CompanyProfileView> {
  const name = input.name?.trim();
  if (!name) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ بيانات المنشأة",
        why: "اسم المنشأة الرسمي إلزامي ولا يمكن حفظ الهوية المؤسسية بتركه فارغاً",
        doThis: "أدخل الاسم القانوني أو التجاري المعتمد للمنشأة قبل إعادة المحاولة",
      }),
    });
  }

  const tradeName = input.tradeName?.trim() || null;
  const shortName = input.shortName?.trim() || null;
  const legalSubtitle = input.legalSubtitle?.trim() || null;
  const commercialRegistry = input.commercialRegistry?.trim() || null;
  const taxNumber = input.taxNumber?.trim() || null;
  const chamberLicense = input.chamberLicense?.trim() || null;
  const address = input.address?.trim() || null;
  const footerText = input.footerText?.trim() || null;
  const logoUrl = input.logoUrl?.trim() || null;

  const phones = input.phones !== undefined
    ? input.phones.map((p) => ({ label: p.label.trim(), number: p.number.trim() })).filter((p) => p.number.length > 0)
    : undefined;

  return withTx(async (tx) => {
    // اضمن وجود الصف أولاً (get-or-create كسول)
    await tx
      .insert(companyProfile)
      .values({
        id: 1,
        name: COMPANY_IDENTITY.name,
        tradeName: COMPANY_IDENTITY.sub,
        shortName: COMPANY_IDENTITY.short,
        legalSubtitle: COMPANY_IDENTITY.subtitle,
        commercialRegistry: COMPANY_IDENTITY.commercialRegistry,
        taxNumber: COMPANY_IDENTITY.taxId,
        chamberLicense: COMPANY_IDENTITY.chamberLicense,
        address: COMPANY_IDENTITY.address,
        phones: COMPANY_IDENTITY.phones.map((p) => ({ label: p.l, number: p.n })),
        logoUrl: null,
        footerText: COMPANY_IDENTITY.footer,
      })
      .onDuplicateKeyUpdate({ set: { id: 1 } });

    await tx
      .update(companyProfile)
      .set({
        name,
        tradeName,
        shortName,
        legalSubtitle,
        commercialRegistry,
        taxNumber,
        chamberLicense,
        address,
        ...(phones !== undefined ? { phones } : {}),
        logoUrl,
        footerText,
        updatedBy: actor.userId,
      })
      .where(eq(companyProfile.id, 1));

    // مزامنة دفاعية للرقم الضريبي في جدول إعدادات الضريبة taxSettings إن كان موجوداً
    if (taxNumber !== undefined) {
      await tx
        .insert(taxSettings)
        .values({
          id: 1,
          enabledByDefault: false,
          defaultTaxRatePercent: "0.00",
          taxRegistrationNumber: taxNumber,
          updatedBy: actor.userId,
        })
        .onDuplicateKeyUpdate({
          set: {
            taxRegistrationNumber: taxNumber,
            updatedBy: actor.userId,
          },
        });
    }

    const rows = await tx.select().from(companyProfile).where(eq(companyProfile.id, 1)).limit(1);
    if (!rows[0]) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تحديث بيانات المنشأة." });
    }
    return toView(rows[0]);
  });
}
