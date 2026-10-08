import { describe, expect, it, beforeEach } from "vitest";
import {
  CO,
  RECEIPT_PHONES,
  BRAND,
  setDynamicCompanyProfile,
  getCompanyIdentity,
} from "../brand";
import { COMPANY_IDENTITY } from "@shared/companyIdentity";

describe("client/src/lib/printing/brand — الوكلاء التفاعليون للهوية المؤسسية", () => {
  beforeEach(() => {
    setDynamicCompanyProfile(null);
  });

  it("يعيد القيم الافتراضية قبل إرساء بيانات منشأة مخصّصة", () => {
    expect(CO.name).toBe(COMPANY_IDENTITY.name);
    expect(CO.sub).toBe(COMPANY_IDENTITY.sub);
    expect(CO.taxId).toBe(COMPANY_IDENTITY.taxId);
    expect(RECEIPT_PHONES).toEqual(COMPANY_IDENTITY.phones.slice(0, 4));
  });

  it("يُحدّث قيم كائن CO عبر البروكسي فور استدعاء setDynamicCompanyProfile دون حاجة لإعادة تحميل الصفحة", () => {
    setDynamicCompanyProfile({
      name: "شركة الفرات للتوزيع",
      sub: "الفرات إكسبريس",
      short: "الفرات",
      subtitle: "نقل سريع",
      commercialRegistry: "CR-777",
      taxId: "TAX-888",
      chamberLicense: "CH-999",
      address: "البصرة - العشار",
      phones: [{ l: "الفرع", n: "+9647800000000" }],
      logoUrl: "https://example.com/furat.png",
      footer: "شكراً لاختياركم الفرات",
    });

    expect(CO.name).toBe("شركة الفرات للتوزيع");
    expect(CO.sub).toBe("الفرات إكسبريس");
    expect(CO.short).toBe("الفرات");
    expect(CO.taxId).toBe("TAX-888");
    expect(CO.commercialRegistry).toBe("CR-777");
    expect(CO.chamberLicense).toBe("CH-999");
    expect(CO.address).toBe("البصرة - العشار");
    expect(CO.logoUrl).toBe("https://example.com/furat.png");
    expect(CO.footer).toBe("شكراً لاختياركم الفرات");

    expect(RECEIPT_PHONES).toHaveLength(1);
    expect(RECEIPT_PHONES[0]).toEqual({ l: "الفرع", n: "+9647800000000" });

    const snapshot = getCompanyIdentity();
    expect(snapshot.name).toBe("شركة الفرات للتوزيع");
    expect(snapshot.logoUrl).toBe("https://example.com/furat.png");
  });

  it("يحتفظ بثوابت التصميم اللوني BRAND سليمة ومستقلة", () => {
    expect(BRAND.green).toBeDefined();
    expect(BRAND.greenDark).toBeDefined();
    expect(BRAND.text).toBeDefined();
    expect(BRAND.alert).toBeDefined();
    expect(BRAND.paper).toBeDefined();
  });

  it("يتعامل بسلاسة مع تفريغ أرقام الهواتف", () => {
    setDynamicCompanyProfile({
      name: "شركة دجلة",
      phones: [],
    });

    expect(CO.name).toBe("شركة دجلة");
    expect(RECEIPT_PHONES).toHaveLength(0);
  });
});
