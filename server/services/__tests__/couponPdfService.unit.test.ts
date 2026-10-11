import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  generateCouponsStandalonePdf,
  type CouponPdfItem,
} from "../couponPdfService";

describe("server/services/couponPdfService — تصدير كوبونات مستقلة بصيغة PDF بقياس 54×84 مم", () => {
  it("يرفض توليد مستند فارغ بدون كوبونات", async () => {
    await expect(generateCouponsStandalonePdf({ coupons: [] })).rejects.toThrow("لا توجد كوبونات للتصدير");
  });

  it("يولّد مستند PDF يحوي صفحة مستقلة لكل كوبون بقياس 54×84 مم بدقة نقطية متناهية", async () => {
    const coupons: CouponPdfItem[] = [
      {
        code: "SALE2026-A1",
        discountText: "خصم 25%",
        headline: "عرض الخريف المميز",
        minSpendText: "عند الشراء بـ 25,000 د.ع فأكثر",
        maxDiscountText: "الحد الأقصى للخصم: 10,000 د.ع",
        activeDaysText: "كل الثلاثاء والخميس",
        validToText: "صالح لغاية 31/12/2026",
        terms: "تطبق الشروط والأحكام - غير قابل للتحويل نقداً",
        qrData: "https://alrouya.iq/c/SALE2026-A1",
      },
      {
        code: "BOUNCE-B2",
        discountText: "خصم 5,000 د.ع",
        headline: "هدية لزيارتك القادمة",
        minSpendText: "للطلبات فوق 30,000 د.ع",
        validToText: "صالح لغاية 15/11/2026",
      },
    ];

    const result = await generateCouponsStandalonePdf({ coupons, programName: "عرض الخريف" });
    expect(result.pdfBytes).toBeDefined();
    expect(result.pdfBytes.length).toBeGreaterThan(1000);
    expect(result.pageCount).toBe(2);

    // فحص بنية الـ PDF المحمولة عبر pdf-lib للتأكد من المقاييس وعدد الصفحات
    const loadedDoc = await PDFDocument.load(result.pdfBytes);
    const pages = loadedDoc.getPages();

    // صفحة واحدة مستقلة لكل كوبون
    expect(pages).toHaveLength(2);

    // قياس كل صفحة يجب أن يطابق 54×84 مم بدقة (153.07 × 238.11 نقطة تقريباً)
    for (const page of pages) {
      const { width, height } = page.getSize();
      expect(Math.round(width * 100) / 100).toBe(153.07);
      expect(Math.round(height * 100) / 100).toBe(238.11);
    }
  });
});
