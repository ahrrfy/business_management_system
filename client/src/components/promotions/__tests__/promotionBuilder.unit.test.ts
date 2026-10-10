import { describe, expect, it } from "vitest";
import {
  INITIAL_PROMOTION_FORM_DATA,
  validatePromotionFormData,
  type PromotionFormData,
} from "../promotionBuilderTypes";
import { qrSvgSync } from "@/lib/printing/qr";
import { code128Svg } from "@/lib/printing/barcode";
import { D } from "@/lib/money";

describe("Omnichannel Promotion Builder (M2 & M3)", () => {
  it("يرفض النموذج بدون اسم أو ببادئة فارغة", () => {
    const invalidData: PromotionFormData = {
      ...INITIAL_PROMOTION_FORM_DATA,
      name: " ",
      codePrefix: "",
    };

    const res = validatePromotionFormData(invalidData);
    expect(res.valid).toBe(false);
    expect(res.errors.name).toBeDefined();
    expect(res.errors.codePrefix).toBeDefined();
  });

  it("يفرض سقف الخصم الأقصى (Max Discount Cap) إلزامياً عند اختيار النسبة المئوية", () => {
    const noCapData: PromotionFormData = {
      ...INITIAL_PROMOTION_FORM_DATA,
      type: "PERCENT",
      discountPercent: "20",
      maxDiscountAmount: "", // سقف مالي فارغ
    };

    const res = validatePromotionFormData(noCapData);
    expect(res.valid).toBe(false);
    expect(res.errors.maxDiscountAmount).toContain("سقف الخصم الأقصى");
  });

  it("يرفض سقف الخصم الأقصى إذا كان صفراً أو سالباً", () => {
    const zeroCapData: PromotionFormData = {
      ...INITIAL_PROMOTION_FORM_DATA,
      type: "PERCENT",
      discountPercent: "20",
      maxDiscountAmount: "0",
    };

    const res = validatePromotionFormData(zeroCapData);
    expect(res.valid).toBe(false);
    expect(res.errors.maxDiscountAmount).toBeDefined();
  });

  it("يقبل نموذج النسبة المئوية عندما يستوفي النسبة والسقف المالي الإلزامي", () => {
    const validPercentData: PromotionFormData = {
      ...INITIAL_PROMOTION_FORM_DATA,
      name: "عرض الربيع الحصري",
      codePrefix: "SPRING",
      type: "PERCENT",
      discountPercent: "15",
      maxDiscountAmount: "30000",
      minOrderSpend: "50000",
    };

    const res = validatePromotionFormData(validPercentData);
    expect(res.valid).toBe(true);
    expect(Object.keys(res.errors)).toHaveLength(0);
  });

  it("يفرض مبلغ الخصم بالدينار عند اختيار نوع الخصم بالمبلغ المقطوع", () => {
    const noAmountData: PromotionFormData = {
      ...INITIAL_PROMOTION_FORM_DATA,
      type: "AMOUNT",
      discountAmount: "0",
    };

    const res = validatePromotionFormData(noAmountData);
    expect(res.valid).toBe(false);
    expect(res.errors.discountAmount).toBeDefined();
  });

  it("يرفض تاريخ النهاية إذا كان يسبق تاريخ البداية", () => {
    const invalidDateData: PromotionFormData = {
      ...INITIAL_PROMOTION_FORM_DATA,
      validFrom: "2026-10-15",
      validTo: "2026-10-10",
    };

    const res = validatePromotionFormData(invalidDateData);
    expect(res.valid).toBe(false);
    expect(res.errors.validTo).toContain("لا يمكن أن يسبق");
  });

  it("يتحقق من نسبة عمولة المسوق عند إدخال بيانات المسوق", () => {
    const invalidAffiliateData: PromotionFormData = {
      ...INITIAL_PROMOTION_FORM_DATA,
      affiliateName: "وكالة تسويق",
      affiliateCommissionRate: "150", // أكبر من 100%
    };

    const res = validatePromotionFormData(invalidAffiliateData);
    expect(res.valid).toBe(false);
    expect(res.errors.affiliateCommissionRate).toBeDefined();
  });

  it("يولد رمز QR متزامن بصيغة SVG صالحة لكود الكوبون", () => {
    const code = "VIP-2026-X";
    const svg = qrSvgSync(code, 150);

    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox");
    expect(svg).toContain("<path");
  });

  it("يولد باركود Code128 بصيغة SVG صالحة وقابلة للمسح الضوئي", () => {
    const code = "VIP-2026-X";
    const barcode = code128Svg(code, { height: 40, moduleWidth: 1.5 });

    expect(barcode.svg).toContain("<svg");
    expect(barcode.svg).toContain(code);
    expect(barcode.widthPx).toBeGreaterThan(50);
  });

  it("محاكاة صمام الأمان المالي: كبح الخصم عند السقف الأقصى", () => {
    const subtotal = 500000; // فاتورة بنصف مليون دينار
    const percent = 20; // خصم 20% = 100,000 دينار
    const maxCap = 25000; // السقف الأقصى 25,000 دينار

    const rawDiscount = D(subtotal).times(percent).div(100);
    const clampedDiscount = rawDiscount.gt(maxCap) ? D(maxCap) : rawDiscount;

    expect(rawDiscount.toNumber()).toBe(100000);
    expect(clampedDiscount.toNumber()).toBe(25000);
  });
});
