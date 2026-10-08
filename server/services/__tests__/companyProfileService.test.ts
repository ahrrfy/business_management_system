/**
 * اختبارات وحدة companyProfileService — إدارة هوية المنشأة (صفّ singleton id=1):
 * - get-or-create كسول بالقيم الافتراضية المرجعية من shared/companyIdentity.ts
 * - القراءة المتكررة تعيد نفس الصف المنفرد دون تكرار
 * - تحديث الحقول القانونية والتجارية وهوية المنشأة مع تسجيل updatedBy
 * - مزامنة دفاعية للرقم الضريبي مع جدول taxSettings
 * - التحقّق من إلزامية اسم المنشأة ورفض السلاسل الفارغة
 * - تطبيع قائمة الهواتف وتجاهل الأرقام الفارغة
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANY_IDENTITY } from "@shared/companyIdentity";
import { companyProfile, taxSettings } from "../../../drizzle/schema";

// مخزن ذاكرة لمحاكاة Drizzle ORM دون الحاجة لخادم MySQL خارجي
let companyProfileRows: any[] = [];
let taxSettingsRows: any[] = [];

const mockDb: any = {
  select: () => ({
    from: (table: any) => {
      const isTax = table === taxSettings;
      const getRows = () => (isTax ? taxSettingsRows : companyProfileRows);
      return {
        where: (_cond: any) => ({
          limit: (_n: number) => Promise.resolve(getRows()),
          then: (resolve: any, reject: any) => Promise.resolve(getRows()).then(resolve, reject),
        }),
        limit: (_n: number) => Promise.resolve(getRows()),
        then: (resolve: any, reject: any) => Promise.resolve(getRows()).then(resolve, reject),
      };
    },
  }),
  insert: (table: any) => ({
    values: (vals: any) => ({
      onDuplicateKeyUpdate: ({ set }: { set: any }) => {
        if (table === companyProfile) {
          if (companyProfileRows.length === 0) {
            companyProfileRows.push({
              ...vals,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          } else if (set) {
            Object.assign(companyProfileRows[0], set, { updatedAt: new Date() });
          }
        } else if (table === taxSettings) {
          if (taxSettingsRows.length === 0) {
            taxSettingsRows.push({ ...vals });
          } else if (set) {
            Object.assign(taxSettingsRows[0], set);
          }
        }
        return Promise.resolve();
      },
    }),
  }),
  update: (table: any) => ({
    set: (vals: any) => ({
      where: (_cond: any) => {
        if (table === companyProfile && companyProfileRows.length > 0) {
          Object.assign(companyProfileRows[0], vals, { updatedAt: new Date() });
        }
        return Promise.resolve();
      },
    }),
  }),
};

vi.mock("../tx", () => ({
  requireDb: () => mockDb,
  withTx: async (fn: (tx: any) => Promise<any>) => fn(mockDb),
}));

import {
  getCompanyProfile,
  updateCompanyProfile,
} from "../companyProfileService";

describe("companyProfileService — خدمة هوية المنشأة", () => {
  beforeEach(() => {
    companyProfileRows = [];
    taxSettingsRows = [];
  });

  it("ينشئ الصفّ الافتراضي عند أول قراءة (get-or-create كسول)", async () => {
    const profile = await getCompanyProfile();
    expect(profile.id).toBe(1);
    expect(profile.name).toBe(COMPANY_IDENTITY.name);
    expect(profile.tradeName).toBe(COMPANY_IDENTITY.sub);
    expect(profile.shortName).toBe(COMPANY_IDENTITY.short);
    expect(profile.taxNumber).toBe(COMPANY_IDENTITY.taxId);
    expect(profile.commercialRegistry).toBe(COMPANY_IDENTITY.commercialRegistry);
    expect(profile.address).toBe(COMPANY_IDENTITY.address);
    expect(profile.phones.length).toBeGreaterThan(0);
    expect(profile.logoUrl).toBeNull();
  });

  it("القراءة المتكررة تعيد نفس الصف دون تكرار", async () => {
    await getCompanyProfile();
    await getCompanyProfile();
    expect(companyProfileRows).toHaveLength(1);
    expect(companyProfileRows[0].id).toBe(1);
  });

  it("يحدّث بيانات هوية المنشأة بنجاح ويسجل updatedBy", async () => {
    const updated = await updateCompanyProfile(
      {
        name: "شركة الرؤية العربية المحدودة",
        tradeName: "الرؤية ستور",
        shortName: "الرؤية",
        legalSubtitle: "للتجارة العامة والطباعة",
        commercialRegistry: "CR-998877",
        taxNumber: "TAX-112233",
        chamberLicense: "CH-5544",
        address: "بغداد — الكرادة خارج",
        phones: [
          { label: "المبيعات", number: "07801234567" },
          { label: "الحسابات", number: "07807654321" },
        ],
        logoUrl: "https://example.com/logo.png",
        footerText: "شكراً لزيارتكم",
      },
      { userId: 1 },
    );

    expect(updated.name).toBe("شركة الرؤية العربية المحدودة");
    expect(updated.tradeName).toBe("الرؤية ستور");
    expect(updated.taxNumber).toBe("TAX-112233");
    expect(updated.commercialRegistry).toBe("CR-998877");
    expect(updated.phones).toHaveLength(2);
    expect(updated.phones[0].number).toBe("07801234567");
    expect(updated.logoUrl).toBe("https://example.com/logo.png");
    expect(updated.updatedBy).toBe(1);

    // التحقق من القراءة اللاحقة
    const reread = await getCompanyProfile();
    expect(reread.name).toBe("شركة الرؤية العربية المحدودة");
    expect(reread.taxNumber).toBe("TAX-112233");
  });

  it("يزامن الرقم الضريبي دفاعياً مع جدول إعدادات الضريبة taxSettings", async () => {
    await updateCompanyProfile(
      {
        name: "شركة الرؤية العربية",
        taxNumber: "TAX-998811",
      },
      { userId: 1 },
    );

    expect(taxSettingsRows).toHaveLength(1);
    expect(taxSettingsRows[0].taxRegistrationNumber).toBe("TAX-998811");
    expect(taxSettingsRows[0].updatedBy).toBe(1);
  });

  it("يرفض تحديث اسم المنشأة بسلسلة فارغة أو مسافات فقط", async () => {
    await expect(
      updateCompanyProfile({ name: "   " }, { userId: 1 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("يطبّع قائمة الهواتف ويتجاهل الإدخالات الخالية من الأرقام", async () => {
    const updated = await updateCompanyProfile(
      {
        name: "شركة الرؤية",
        phones: [
          { label: "فرع 1", number: "07700000000" },
          { label: "فارغ", number: "   " },
        ],
      },
      { userId: 1 },
    );

    expect(updated.phones).toHaveLength(1);
    expect(updated.phones[0].number).toBe("07700000000");
  });

  it("يقبل تمرير مصفوفة هواتف فارغة صراحة ويحفظها", async () => {
    const updated = await updateCompanyProfile(
      {
        name: "شركة الرؤية",
        phones: [],
      },
      { userId: 1 },
    );

    expect(updated.phones).toHaveLength(0);
  });
});
