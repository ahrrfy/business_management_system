/**
 * أرقام المستندات — فصل رقم العرض عن رمز الآلة (طلب المالك ١٨/٨).
 *
 * الثابت الحاكم: الأرقام التاريخية المطبوعة **بيد الزبائن** لا تُستبدَل، فأيّ دالّة هنا يجب
 * أن تقبل الصيغتين إلى الأبد. الاختبار يحرس ذلك تحديداً — لأنّ نزع البادئة بلا شرطٍ كان
 * سيحوّل `INV-1-20260818-00073` إلى `1-20260818-00073` فلا يُطابَق شيءٌ في القاعدة.
 */
import { describe, expect, it } from "vitest";
import { docBarcode, stripDocPrefix } from "../documentNumber";

describe("docBarcode — رمز الآلة بادئيّ دائماً", () => {
  it("الرقم القصير يُبَدَّأ بنوعه", () => {
    expect(docBarcode("INV", "10023")).toBe("INV-10023");
    expect(docBarcode("WO", "5041")).toBe("WO-5041");
  });

  it("الرقم التاريخيّ لا تُكرَّر بادئته", () => {
    expect(docBarcode("INV", "INV-1-20260818-00073")).toBe("INV-1-20260818-00073");
    expect(docBarcode("WO", "WO-1-20260811-00003")).toBe("WO-1-20260811-00003");
  });
});

describe("stripDocPrefix — نزعٌ مشروطٌ بأن يكون الباقي رقماً", () => {
  it("الصيغة الجديدة: تُنزَع البادئة فيبقى رقم العرض", () => {
    expect(stripDocPrefix("INV-10023")).toBe("10023");
    expect(stripDocPrefix("wo-5041")).toBe("5041"); // غير حسّاسٍ للحالة
  });

  it("⭐ الصيغة التاريخية تبقى **كما هي** — هي نفسها رقم عرضها", () => {
    expect(stripDocPrefix("INV-1-20260818-00073")).toBe("INV-1-20260818-00073");
    expect(stripDocPrefix("WO-1-20260811-00003")).toBe("WO-1-20260811-00003");
  });

  it("يدعم البادئات الموسعة الجديدة للسندات والتحويلات والطلبات", () => {
    expect(docBarcode("VCH", "3001")).toBe("VCH-3001");
    expect(docBarcode("TRN", "4002")).toBe("TRN-4002");
    expect(docBarcode("EXC", "5003")).toBe("EXC-5003");
    expect(docBarcode("GIFT", "6004")).toBe("GIFT-6004");
    expect(docBarcode("ORD", "7005")).toBe("ORD-7005");
    expect(stripDocPrefix("VCH-3001")).toBe("3001");
    expect(stripDocPrefix("TRN-4002")).toBe("4002");
    expect(stripDocPrefix("EXC-5003")).toBe("5003");
    expect(stripDocPrefix("GIFT-6004")).toBe("6004");
    expect(stripDocPrefix("ORD-7005")).toBe("7005");
  });
});
