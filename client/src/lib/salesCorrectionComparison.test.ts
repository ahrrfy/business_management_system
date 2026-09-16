import { describe, expect, it } from "vitest";
import { buildSalesCorrectionComparison } from "./salesCorrectionComparison";

describe("buildSalesCorrectionComparison", () => {
  it("يعرض قبل/بعد مع الإضافة والحذف والخصم والضريبة دون حساب عائم", () => {
    const result = buildSalesCorrectionComparison({
      total: "2000.00",
      paidAmount: "1000.00",
      paymentMethod: "CASH",
      items: [
        { productUnitId: 1, productName: "دفتر", unitName: "قطعة", quantity: "2", unitPrice: "1000", total: "2000" },
        { productUnitId: 2, productName: "قلم", unitName: "قطعة", quantity: "1", unitPrice: "500", total: "500" },
      ],
    }, {
      lines: [
        { productUnitId: 1, quantity: "3", unitPriceOverride: "1000", discountPercent: "10" },
        { productUnitId: 3, quantity: "1", unitPriceOverride: "500" },
      ],
      invoiceDiscount: "200",
      taxRatePercent: "10",
      deliveryFee: "100",
      additionalPayment: { amount: "1370", method: "CARD" },
    }, [
      { productUnitId: 1, productName: "دفتر", unitName: "قطعة", price: "1000" },
      { productUnitId: 3, productName: "حقيبة", unitName: "قطعة", price: "500" },
    ]);

    expect(result.afterTotal).toBe("3400.00");
    expect(result.afterPaid).toBe("2370.00");
    expect(result.afterDue).toBe("1030.00");
    expect(result.paymentMethod).toBe("MIXED");
    expect(result.afterLines.map((line) => line.change)).toEqual(["changed", "added"]);
    expect(result.removedLines).toHaveLength(1);
  });

  it("يقصر المدفوع على الإجمالي ويكشف الفرق الزائد", () => {
    const result = buildSalesCorrectionComparison({
      total: "2000",
      paidAmount: "2000",
      paymentMethod: "CASH",
      items: [{ productUnitId: 1, productName: "دفتر", unitName: "قطعة", quantity: "2", unitPrice: "1000", total: "2000" }],
    }, {
      lines: [{ productUnitId: 1, quantity: "1", unitPriceOverride: "1000" }],
      overpayHandling: "CASH_REFUND",
    }, []);
    expect(result.afterPaid).toBe("1000.00");
    expect(result.overpay).toBe("1000.00");
    expect(result.afterDue).toBe("0.00");
  });

  it("يطابق تقريب خصم النسبة الخادمي: الخصم من الإجمالي الخام ثم يُقرّب", () => {
    const result = buildSalesCorrectionComparison({
      total: "0.01",
      paidAmount: "0",
      items: [],
    }, {
      lines: [{ productUnitId: 1, quantity: "0.5", unitPriceOverride: "0.01", discountPercent: "50" }],
    }, [{ productUnitId: 1, productName: "عينة", unitName: "قطعة", price: "0.01" }]);
    expect(result.afterLines[0].total).toBe("0.01");
    expect(result.afterTotal).toBe("0.01");
  });

  it("يحمل إفصاح التوصيل المجاني وقيمته من دون إدخاله في الإجمالي", () => {
    const result = buildSalesCorrectionComparison({
      total: "1000",
      paidAmount: "0",
      deliveryFree: true,
      deliveryWaivedAmount: "250",
      items: [],
    }, {
      lines: [{ productUnitId: 1, quantity: "1", unitPriceOverride: "1000" }],
      deliveryFree: true,
      deliveryWaivedAmount: "250",
    }, [{ productUnitId: 1, productName: "دفتر", unitName: "قطعة", price: "1000" }]);

    expect(result.afterTotal).toBe("1000.00");
    expect(result.afterDeliveryFree).toBe(true);
    expect(result.afterDeliveryWaived).toBe("250.00");
  });
});
