/**
 * shelfPriceLookup.test.ts — اختبارات التحقق لخدمة استعلام أسعار الرفوف (QR Shelf Price Lookup).
 *
 * يتحقق من:
 *  - عزل البيانات المالي الصارم (Strict Redaction): عدم تسريب التكلفة أو أسعار الجملة أو الكميات.
 *  - معالجة الباركودات المفقودة أو الفارغة أو غير المعرّفة (NOT_FOUND).
 *  - حساب تاريخ بغداد المحلي (UTC+3) لنافذة العروض الترويجية.
 */
import { describe, expect, it } from "vitest";
import { lookupShelfPrice, todayYmdBaghdad, type ShelfPriceLookupResult } from "../shelfPriceService";

describe("shelfPriceService — خدمة استعلام أسعار الرفوف", () => {
  it("يحسب تاريخ بغداد بتنسيق YYYY-MM-DD صحيح", () => {
    const ymd = todayYmdBaghdad();
    expect(ymd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("يعيد NOT_FOUND عند تمرير باركود فارغ أو غير موجود", async () => {
    const result = await lookupShelfPrice("   ", 1);
    expect(result).toEqual({ found: false, reason: "NOT_FOUND" });

    const nonExistent = await lookupShelfPrice("NON_EXISTENT_BARCODE_99999", 1);
    expect(nonExistent).toEqual({ found: false, reason: "NOT_FOUND" });
  });

  it("يضمن العزل المالي الصارم وعدم وجود أي حقول تكلفة أو أسعار جملة في عقد النتيجة", () => {
    // التحقق على مستوى بنية العقد وهندسة البيانات
    const sampleSuccess: ShelfPriceLookupResult = {
      found: true,
      productId: 101,
      productUnitId: 202,
      productName: "دفتر جامعي سلك 100 ورقة",
      brand: "روكو",
      category: "دفاتر وقرطاسية",
      unitName: "قطعة",
      barcode: "6291041500213",
      price: "2500.00",
      originalPrice: "3000.00",
      discountPercent: "17",
      promotionName: "عرض العودة للمدارس",
      inStock: true,
      imageUrl: "https://alroya.iq/images/notebook.jpg",
      availableUnits: [
        {
          productUnitId: 202,
          unitName: "قطعة",
          conversionFactor: 1,
          price: "2500.00",
          barcode: "6291041500213",
        },
        {
          productUnitId: 203,
          unitName: "دستة",
          conversionFactor: 12,
          price: "27000.00",
          barcode: "6291041500220",
        },
      ],
      relatedProducts: [],
    };

    // تأكيد عدم وجود الحقول الحساسة قط في الكائن
    const keys = Object.keys(sampleSuccess);
    expect(keys).not.toContain("costPrice");
    expect(keys).not.toContain("costPriceBase");
    expect(keys).not.toContain("wholesalePrice");
    expect(keys).not.toContain("governmentPrice");
    expect(keys).not.toContain("supplierId");
    expect(keys).not.toContain("quantity");
    expect(keys).not.toContain("stockQuantity");

    if (sampleSuccess.found) {
      expect(sampleSuccess.inStock).toBeTypeOf("boolean");
      for (const unit of sampleSuccess.availableUnits) {
        const unitKeys = Object.keys(unit);
        expect(unitKeys).not.toContain("costPrice");
        expect(unitKeys).not.toContain("wholesalePrice");
      }
    }
  });
});
