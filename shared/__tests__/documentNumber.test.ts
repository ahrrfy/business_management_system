/**
 * أرقام المستندات — فصل رقم العرض عن رمز الآلة (طلب المالك ١٨/٨).
 *
 * الثابت الحاكم: الأرقام التاريخية المطبوعة **بيد الزبائن** لا تُستبدَل، فأيّ دالّة هنا يجب
 * أن تقبل الصيغتين إلى الأبد. الاختبار يحرس ذلك تحديداً — لأنّ نزع البادئة بلا شرطٍ كان
 * سيحوّل `INV-1-20260818-00073` إلى `1-20260818-00073` فلا يُطابَق شيءٌ في القاعدة.
 */
import { describe, expect, it } from "vitest";
import { docBarcode, formatDocumentNumber, stripDocPrefix } from "../documentNumber";

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

  it("يدعم البادئات الموسعة الجديدة للسندات والتحويلات والطلبات والإرساليات", () => {
    expect(docBarcode("VCH", "3001")).toBe("VCH-3001");
    expect(docBarcode("TRN", "4002")).toBe("TRN-4002");
    expect(docBarcode("EXC", "5003")).toBe("EXC-5003");
    expect(docBarcode("GIFT", "6004")).toBe("GIFT-6004");
    expect(docBarcode("ORD", "7005")).toBe("ORD-7005");
    expect(docBarcode("CN", "100034")).toBe("CN-100034");
    expect(docBarcode("CN", "CN-1-20261019-00001")).toBe("CN-1-20261019-00001");
    expect(docBarcode("CN", "CNS-001")).toBe("CNS-001");
    expect(stripDocPrefix("VCH-3001")).toBe("3001");
    expect(stripDocPrefix("TRN-4002")).toBe("4002");
    expect(stripDocPrefix("EXC-5003")).toBe("5003");
    expect(stripDocPrefix("GIFT-6004")).toBe("6004");
    expect(stripDocPrefix("ORD-7005")).toBe("7005");
    expect(stripDocPrefix("CN-100034")).toBe("100034");
    expect(stripDocPrefix("CNS-100034")).toBe("100034");
    expect(stripDocPrefix("CN-1-20261019-00001")).toBe("CN-1-20261019-00001");
  });

  it("يدعم نزع البادئة مع اللاحقة الفرعية للأشقاء واللواحق المتعددة (multi-hyphen suffixes)", () => {
    expect(stripDocPrefix("INV-100001-1")).toBe("100001-1");
    expect(stripDocPrefix("WO-100001-2")).toBe("100001-2");
    expect(stripDocPrefix("PO-100001-3")).toBe("100001-3");
    expect(stripDocPrefix("ORD-100001-1")).toBe("100001-1");
    expect(stripDocPrefix("CN-100001-1")).toBe("100001-1");
    expect(stripDocPrefix("WO-100001-1-1")).toBe("100001-1-1");
    expect(stripDocPrefix("INV-100001-2-1")).toBe("100001-2-1");
    expect(stripDocPrefix("RET-100001")).toBe("100001");
    expect(stripDocPrefix("PAY-100001")).toBe("100001");
    expect(stripDocPrefix("REC-100001")).toBe("100001");
  });
});

describe("formatDocumentNumber — تنسيق رقم المستند وتوريث اللاحقة للأشقاء", () => {
  it("المستند المنفرد أو الفهرس 0 يعيد رقم التتبع الأساسي مباشرة", () => {
    expect(formatDocumentNumber("100001")).toBe("100001");
    expect(formatDocumentNumber("100001", 0)).toBe("100001");
    expect(formatDocumentNumber("100001", undefined)).toBe("100001");
  });

  it("المستندات الشقيقة تأخذ لاحقة تسلسلية -1 و -2", () => {
    expect(formatDocumentNumber("100001", 1)).toBe("100001-1");
    expect(formatDocumentNumber("100001", 2)).toBe("100001-2");
    expect(formatDocumentNumber("100001", 3)).toBe("100001-3");
  });

  it("حالات الحدود: معالجة المدخلات الفارغة والكسور و NaN والأعداد السالبة بأمان", () => {
    expect(formatDocumentNumber("100001", NaN)).toBe("100001");
    expect(formatDocumentNumber("100001", 1.5)).toBe("100001");
    expect(formatDocumentNumber("100001", 0)).toBe("100001");
    expect(formatDocumentNumber("100001", -5)).toBe("100001");
    expect(formatDocumentNumber("", 1)).toBe("");
    expect(formatDocumentNumber("   ", 1)).toBe("");
    expect(formatDocumentNumber("  100001  ", 2)).toBe("100001-2");
  });
});

