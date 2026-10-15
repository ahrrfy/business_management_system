/**
 * اختبارات الإجهاد والتحدي التجريبي (Empirical Stress & Challenge)
 * لخدمة هوية المنشأة companyProfileService:
 * 1. التزامن والأقفال (Concurrency Stress): 50 استدعاء متزامن في نفس اللحظة للقراءة والتحديث.
 * 2. التحديثات المتكررة (Duplicate & Sequential Updates): استقرار سجل الـ singleton واحتساب updatedBy.
 * 3. حتمية مزامنة الرقم الضريبي (Tax Synchronization Invariants) واختبار سلوك الحذف/الإهمال.
 * 4. تشذيب المدخلات (Input Trimming & Sanitization): المسافات البادئة واللاحقة والأرقام الخالية.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANY_IDENTITY } from "@shared/companyIdentity";
import { companyProfile, taxSettings } from "../../../drizzle/schema";

let companyProfileRows: any[] = [];
let taxSettingsRows: any[] = [];

// محاكاة قاعدة بيانات ذرية مع قفل مبسط لحماية تتابع الذاكرة
const mockDb: any = {
  select: () => ({
    from: (table: any) => {
      const isTax = table === taxSettings;
      const getRows = () => (isTax ? taxSettingsRows : companyProfileRows);
      return {
        where: (_cond: any) => ({
          limit: (_n: number) => Promise.resolve([...getRows()]),
          then: (resolve: any, reject: any) => Promise.resolve([...getRows()]).then(resolve, reject),
        }),
        limit: (_n: number) => Promise.resolve([...getRows()]),
        then: (resolve: any, reject: any) => Promise.resolve([...getRows()]).then(resolve, reject),
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

describe("companyProfileService — تحدي الإجهاد التجريبي وشروط الحدود", () => {
  beforeEach(() => {
    companyProfileRows = [];
    taxSettingsRows = [];
  });

  describe("1. اختبار التزامن الشديد (Concurrency Stress Harness)", () => {
    it("50 استدعاء متزامن لـ getCompanyProfile ينشئ صفاً واحداً فقط دون تصادم", async () => {
      // إطلاق 50 استعلام قراءة متزامن في نفس الجزء من الثانية على جدول فارغ
      const concurrentReads = Array.from({ length: 50 }, () => getCompanyProfile());
      const results = await Promise.all(concurrentReads);

      expect(companyProfileRows).toHaveLength(1);
      expect(results).toHaveLength(50);
      for (const res of results) {
        expect(res.id).toBe(1);
        expect(res.name).toBe(COMPANY_IDENTITY.name);
      }
    });

    it("50 استدعاء متزامن لـ updateCompanyProfile تحافظ على صف واحد وتسجل آخر تحديث سليم", async () => {
      // إطلاق 50 تحديث متزامن من مستخدمين مختلفين
      const concurrentUpdates = Array.from({ length: 50 }, (_, i) =>
        updateCompanyProfile(
          {
            name: `شركة الرؤية - إصدار ${i + 1}`,
            tradeName: `العلامة ${i + 1}`,
          },
          { userId: 100 + i },
        ),
      );

      const results = await Promise.all(concurrentUpdates);

      expect(companyProfileRows).toHaveLength(1);
      expect(results).toHaveLength(50);
      // التحقق من أن السجل في النهاية يحمل حالة متماسكة
      const finalProfile = await getCompanyProfile();
      expect(finalProfile.id).toBe(1);
      expect(finalProfile.name).toMatch(/شركة الرؤية - إصدار \d+/);
      expect(finalProfile.updatedBy).toBeGreaterThanOrEqual(100);
    });
  });

  describe("2. التحديثات المكررة والتعاقبية (Duplicate & Sequential Updates)", () => {
    it("تكرار حفظ نفس البيانات بدقة لا يكرر السجلات ويحدث وقت التعديل", async () => {
      const payload = {
        name: "شركة الرؤية العربية المحدودة",
        tradeName: "الرؤية ستور",
        taxNumber: "TAX-123456",
      };

      const first = await updateCompanyProfile(payload, { userId: 1 });
      const second = await updateCompanyProfile(payload, { userId: 1 });

      expect(companyProfileRows).toHaveLength(1);
      expect(first.name).toBe(second.name);
      expect(first.taxNumber).toBe(second.taxNumber);
    });

    it("تتابع التعديل بين مستخدمين مختلفين يسجل هوية آخر معدّل updatedBy", async () => {
      await updateCompanyProfile({ name: "الاسم بواسطة أدمن 1" }, { userId: 1 });
      let row = await getCompanyProfile();
      expect(row.updatedBy).toBe(1);

      await updateCompanyProfile({ name: "الاسم بواسطة أدمن 2" }, { userId: 2 });
      row = await getCompanyProfile();
      expect(row.updatedBy).toBe(2);
      expect(row.name).toBe("الاسم بواسطة أدمن 2");
    });
  });

  describe("3. حتمية مزامنة الضريبة (Tax Synchronization Invariants)", () => {
    it("تحديث الرقم الضريبي يزامنه فوراً مع جدول taxSettings تحت نفس المستخدم", async () => {
      await updateCompanyProfile(
        {
          name: "شركة الرؤية المحدودة",
          taxNumber: "TAX-999888777",
        },
        { userId: 42 },
      );

      expect(taxSettingsRows).toHaveLength(1);
      expect(taxSettingsRows[0].id).toBe(1);
      expect(taxSettingsRows[0].taxRegistrationNumber).toBe("TAX-999888777");
      expect(taxSettingsRows[0].updatedBy).toBe(42);
    });

    it("تفريغ الرقم الضريبي (null أو فارغ) يزامن القيمة الفارغة في taxSettings", async () => {
      // وضع رقم ضريبي أولاً
      await updateCompanyProfile(
        { name: "الشركة", taxNumber: "TAX-INITIAL" },
        { userId: 1 },
      );
      expect(taxSettingsRows[0].taxRegistrationNumber).toBe("TAX-INITIAL");

      // تفريغه بسلسلة فارغة
      await updateCompanyProfile(
        { name: "الشركة", taxNumber: "" },
        { userId: 2 },
      );
      expect(taxSettingsRows[0].taxRegistrationNumber).toBeNull();
    });

    it("🚨 فحص تجريبي: إهمال تمرير taxNumber (undefined) يسفر عن مسحه في القاعدة ومزامنة null مع taxSettings، بينما يعود بالبديل في العرض", async () => {
      // تهيئة الرقم الضريبي أولاً
      await updateCompanyProfile(
        { name: "شركة مسجلة", taxNumber: "TAX-PERSISTENT" },
        { userId: 1 },
      );
      expect(taxSettingsRows[0].taxRegistrationNumber).toBe("TAX-PERSISTENT");
      expect(companyProfileRows[0].taxNumber).toBe("TAX-PERSISTENT");

      // تحديث الاسم فقط مع ترك taxNumber غير معرّف (undefined)
      const res = await updateCompanyProfile(
        { name: "شركة مسجلة معدلة" }, // taxNumber: undefined
        { userId: 5 },
      );

      // في قاعدة البيانات: تم مسح الرقم الضريبي لأن input.taxNumber?.trim() || null يحوله إلى null
      expect(companyProfileRows[0].taxNumber).toBeNull();
      // في جدول taxSettings: تم تصفيره أيضاً إلى null بسبب if (taxNumber !== undefined)
      expect(taxSettingsRows[0].taxRegistrationNumber).toBeNull();

      // في كائن العرض CompanyProfileView: toView تستبدل القيمة الفارغة بالثابت COMPANY_IDENTITY.taxId ("700124589")
      // مما يسبب تفاوتاً (desync) بين جدول الضريبة (null) وهوية الشركة في العرض ("700124589")
      expect(res.taxNumber).toBe(COMPANY_IDENTITY.taxId);
    });
  });

  describe("4. تشذيب المدخلات والتطهير (Trimming & Sanitization)", () => {
    it("يرفض الأسماء التي تحتوي على مسافات فقط أو أحرف هروب فارغة", async () => {
      await expect(
        updateCompanyProfile({ name: "   \t\n  \r\n" }, { userId: 1 }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("يشذّب المسافات البادئة واللاحقة من كافة الحقول النصية القانونية والتجارية", async () => {
      const updated = await updateCompanyProfile(
        {
          name: "   شركة الرؤية للتجارة العامة   ",
          tradeName: "   الرؤية ستور   ",
          shortName: "   الرؤية   ",
          legalSubtitle: "   مكتبة وقرطاسية   ",
          commercialRegistry: "   CR-9900   ",
          taxNumber: "   TAX-7766   ",
          chamberLicense: "   CH-1122   ",
          address: "   بغداد - المنصور - شارع 14 رمضان   ",
          logoUrl: "   https://example.com/logo.png   ",
          footerText: "   شكراً لتعاملكم معنا   ",
        },
        { userId: 1 },
      );

      expect(updated.name).toBe("شركة الرؤية للتجارة العامة");
      expect(updated.tradeName).toBe("الرؤية ستور");
      expect(updated.shortName).toBe("الرؤية");
      expect(updated.legalSubtitle).toBe("مكتبة وقرطاسية");
      expect(updated.commercialRegistry).toBe("CR-9900");
      expect(updated.taxNumber).toBe("TAX-7766");
      expect(updated.chamberLicense).toBe("CH-1122");
      expect(updated.address).toBe("بغداد - المنصور - شارع 14 رمضان");
      expect(updated.logoUrl).toBe("https://example.com/logo.png");
      expect(updated.footerText).toBe("شكراً لتعاملكم معنا");
    });

    it("يحوّل الحقول المكونة من مسافات فقط إلى null في قاعدة البيانات، بينما toView تستبدلها بالثوابت (ما عدا logoUrl)", async () => {
      const updated = await updateCompanyProfile(
        {
          name: "شركة الرؤية",
          tradeName: "   ",
          shortName: "   ",
          legalSubtitle: "   ",
          commercialRegistry: "   ",
          taxNumber: "   ",
          chamberLicense: "   ",
          address: "   ",
          logoUrl: "   ",
          footerText: "   ",
        },
        { userId: 1 },
      );

      // في جدول قاعدة البيانات Drizzle: تم تخزين null بنجاح
      expect(companyProfileRows[0].tradeName).toBeNull();
      expect(companyProfileRows[0].shortName).toBeNull();
      expect(companyProfileRows[0].legalSubtitle).toBeNull();
      expect(companyProfileRows[0].commercialRegistry).toBeNull();
      expect(companyProfileRows[0].taxNumber).toBeNull();
      expect(companyProfileRows[0].chamberLicense).toBeNull();
      expect(companyProfileRows[0].address).toBeNull();
      expect(companyProfileRows[0].logoUrl).toBeNull();
      expect(companyProfileRows[0].footerText).toBeNull();

      // في واجهة العرض CompanyProfileView: logoUrl فقط هو null لأن باقي الحقول تعود للثوابت عبر toView
      expect(updated.logoUrl).toBeNull();
      expect(updated.tradeName).toBe(COMPANY_IDENTITY.sub);
      expect(updated.shortName).toBe(COMPANY_IDENTITY.short);
      expect(updated.taxNumber).toBe(COMPANY_IDENTITY.taxId);
    });

    it("يشذّب أرقام وتسميات الهواتف، ويهمل الأرقام الفارغة، ويعطي تسمية افتراضية للمسميات الخالية", async () => {
      const updated = await updateCompanyProfile(
        {
          name: "شركة الرؤية",
          phones: [
            { label: "   المبيعات   ", number: "   07801234567   " },
            { label: "   ", number: "   07709876543   " }, // تسمية فارغة
            { label: "حسابات", number: "      " }, // رقم فارغ — يجب حذفه
          ],
        },
        { userId: 1 },
      );

      expect(updated.phones).toHaveLength(2);
      expect(updated.phones[0]).toEqual({ label: "المبيعات", number: "07801234567" });
      expect(updated.phones[1]).toEqual({ label: "عام", number: "07709876543" });
    });
  });
});
