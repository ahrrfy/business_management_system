/**
 * PUR-UNIT-01 (٤/٩/٢٦): تدقيق Codex أثبت بصرياً (لقطة cp47) أنّ ProductSearchBar/BulkPicker
 * يعرضان «١٥٠ د.ع/درزن» لصنفٍ تكلفةُ قطعتِه ١٥٠ ومعامل درزنه ١٢ (الصحيح ١٨٠٠). حمولةُ الشراء
 * تحمل `unitPrice=l.price`، فيقسمه `receive.ts` على المعامل ⇒ costPerBase=12.50 يسمّم WAVG.
 *
 * هذه الحزمة تُثبّت **الحساب النقيّ** الذي يُغذّي مسارَي الإضافة (بحث سريع + إضافة جماعية):
 * `price = costBase × conversionFactor`. الاختبار يفشل قبل الإصلاح ويمرّ بعده.
 */
import { describe, expect, it } from "vitest";
import { estimatedPurchaseUnitPrice } from "../purchasePrice";

describe("estimatedPurchaseUnitPrice — PUR-UNIT-01", () => {
  it("الوحدة الأساس (معامل ١) ⇒ لا تغيّر: تكلفةُ قطعةٍ ١٥٠ ⇒ ١٥٠", () => {
    expect(estimatedPurchaseUnitPrice("150", "1")).toBe("150.00");
  });

  it("درزن (معامل ١٢): تكلفةُ قطعةٍ ١٥٠ ⇒ ١٨٠٠ (نواة البلاغ — كان يُنتج ١٥٠ فيسمّم WAVG)", () => {
    expect(estimatedPurchaseUnitPrice("150", "12")).toBe("1800.00");
  });

  it("كرتون (معامل ٤٨): تكلفةُ قطعةٍ ١٢٥ ⇒ ٦٠٠٠", () => {
    expect(estimatedPurchaseUnitPrice("125", "48")).toBe("6000.00");
  });

  it("تكلفةٌ كسريّة بمنزلتين ⇒ ضربٌ بلا فقدٍ ثمّ منزلتان: ٧٫٥٠ × ١٢ = ٩٠٫٠٠", () => {
    expect(estimatedPurchaseUnitPrice("7.50", "12")).toBe("90.00");
  });

  it("عملة الدولار ⇒ أربع منازل: ٠٫١٢٥ × ٢٤ = ٣٫٠٠٠٠", () => {
    expect(estimatedPurchaseUnitPrice("0.125", "24", "USD")).toBe("3.0000");
  });

  it("تكلفةٌ صفريّة (بكجٌ صار متاحاً بغلطة؟) ⇒ ٠ لا رمي: ٠ × ١٢ = ٠", () => {
    expect(estimatedPurchaseUnitPrice("0", "12")).toBe("0.00");
    expect(estimatedPurchaseUnitPrice("0.00", "12")).toBe("0.00");
  });

  it("معاملٌ ≤ صفر أو معدوم ⇒ التكلفةُ كما هي (كأنّ الوحدة أساس) — لا قسمةَ على صفر", () => {
    expect(estimatedPurchaseUnitPrice("150", "0")).toBe("150.00");
    expect(estimatedPurchaseUnitPrice("150", null)).toBe("150.00");
    expect(estimatedPurchaseUnitPrice("150", undefined)).toBe("150.00");
    expect(estimatedPurchaseUnitPrice("150", "-3")).toBe("150.00");
  });

  it("مدخلٌ نصّيٌّ فارغ/نال ⇒ صفرٌ بلا رمي (`D()` الخام يرمي)", () => {
    expect(estimatedPurchaseUnitPrice("", "12")).toBe("0.00");
    expect(estimatedPurchaseUnitPrice(null, "12")).toBe("0.00");
    expect(estimatedPurchaseUnitPrice(undefined, "12")).toBe("0.00");
  });
});
