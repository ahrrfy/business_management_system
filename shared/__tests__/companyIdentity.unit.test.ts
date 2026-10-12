import { describe, expect, it } from "vitest";
import {
  COMPANY_IDENTITY,
  resolveCompanyIdentity,
  type CompanyIdentityData,
} from "../companyIdentity";

describe("shared/companyIdentity — دمج هوية المنشأة الافتراضية والديناميكية", () => {
  it("يعيد الهوية المرجعية الافتراضية عند غياب أي تخصيص", () => {
    const identity = resolveCompanyIdentity();
    expect(identity.name).toBe(COMPANY_IDENTITY.name);
    expect(identity.sub).toBe(COMPANY_IDENTITY.sub);
    expect(identity.short).toBe(COMPANY_IDENTITY.short);
    expect(identity.commercialRegistry).toBe(COMPANY_IDENTITY.commercialRegistry);
    expect(identity.taxId).toBe(COMPANY_IDENTITY.taxId);
    expect(identity.phones.length).toBe(COMPANY_IDENTITY.phones.length);
  });

  it("يُطبّق الحقول المخصّصة مع إعطاء الأولوية للقيم الديناميكية", () => {
    const override: Partial<CompanyIdentityData> = {
      name: "شركة النور للحلول البرمجية",
      sub: "النور تكنولوجي",
      short: "النور",
      subtitle: "حلول تقنية",
      commercialRegistry: "CR-8877",
      taxId: "TAX-12345",
      chamberLicense: "CHAMBER-99",
      address: "المنصور، بغداد",
      phones: [
        { l: "الدعم الفني", n: "+9647711111111" },
        { l: "الإدارة", n: "+9647722222222" },
      ],
      logoUrl: "https://example.com/logo.png",
      footer: "شعار النور",
    };

    const identity = resolveCompanyIdentity(override);
    expect(identity.name).toBe("شركة النور للحلول البرمجية");
    expect(identity.sub).toBe("النور تكنولوجي");
    expect(identity.short).toBe("النور");
    expect(identity.commercialRegistry).toBe("CR-8877");
    expect(identity.taxId).toBe("TAX-12345");
    expect(identity.chamberLicense).toBe("CHAMBER-99");
    expect(identity.address).toBe("المنصور، بغداد");
    expect(identity.phones).toHaveLength(2);
    expect(identity.phones[0].l).toBe("الدعم الفني");
    expect(identity.logoUrl).toBe("https://example.com/logo.png");
    expect(identity.footer).toBe("شعار النور");
  });

  it("يسقط تلقائياً إلى القيم الافتراضية لأي حقل غير مخصّص", () => {
    const identity = resolveCompanyIdentity({
      name: "شركة البصرة الحديثة",
    });

    expect(identity.name).toBe("شركة البصرة الحديثة");
    expect(identity.sub).toBe(COMPANY_IDENTITY.sub);
    expect(identity.taxId).toBe(COMPANY_IDENTITY.taxId);
  });

  it("يحترم قائمة الهواتف الفارغة عمداً ولا يسرب أرقام الهاتف الافتراضية إلى تذييل المستند", () => {
    const identity = resolveCompanyIdentity({
      name: "شركة النجف للطباعة",
      address: "النجف الأشرف — شارع المدينة",
      phones: [],
    });

    expect(identity.phones).toHaveLength(0);
    // يجب ألا يحوي تذييل المستند أي رقم افتراضي بل يعتمد العنوان
    expect(identity.footerLine).toBe("النجف الأشرف — شارع المدينة");
    expect(identity.footerLine).not.toContain(COMPANY_IDENTITY.phones[0].n);
  });
});
