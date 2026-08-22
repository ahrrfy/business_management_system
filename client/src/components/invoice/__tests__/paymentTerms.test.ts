import { describe, expect, it } from "vitest";
import { derivePaymentTerms } from "../paymentTerms";

describe("derivePaymentTerms — اشتقاق شروط الدفع من فاتورةٍ قائمة", () => {
  it("الأصل مسدَّدٌ بالكامل ⇒ نقديّ", () => {
    expect(derivePaymentTerms({ total: "250.00", paidAmount: "250.00" })).toBe("CASH");
  });

  it("الأصل غير مسدَّد (ذمّة كاملة) ⇒ آجل — لا يُفترَض قبضٌ لم يقع", () => {
    expect(derivePaymentTerms({ total: "250.00", paidAmount: "0.00" })).toBe("CREDIT");
  });

  it("الأصل مسدَّدٌ جزئياً ⇒ آجل — الدفعة تُعاد إدخالها صراحةً لا ضمناً", () => {
    expect(derivePaymentTerms({ total: "250.00", paidAmount: "100.00" })).toBe("CREDIT");
  });

  it("دفعٌ زائد على الأصل ⇒ نقديّ (المسموح به بقرار المالك)", () => {
    expect(derivePaymentTerms({ total: "250.00", paidAmount: "300.00" })).toBe("CASH");
  });

  it("الحالة تُحسب على الصافي بعد المرتجعات — مرآةُ computeInvoiceStatus", () => {
    // إجماليّ ١٠٠٠، أُرجِع ٦٠٠، دُفِع ٤٠٠ ⇒ الصافي ٤٠٠ مسدَّدٌ بالكامل ⇒ نقديّ.
    expect(derivePaymentTerms({ total: "1000", paidAmount: "400", returnedTotal: "600" })).toBe("CASH");
    // نفس الإجماليّ والمرتجع لكن دُفِع ٣٠٠ فقط ⇒ يبقى مستحقّاً ⇒ آجل.
    expect(derivePaymentTerms({ total: "1000", paidAmount: "300", returnedTotal: "600" })).toBe("CREDIT");
  });

  it("صافٍ غير موجب (مُرتجَعة بالكامل أو فاتورة فارغة) ⇒ آجل، لا سدادَ مفترَض", () => {
    expect(derivePaymentTerms({ total: "1000", paidAmount: "0", returnedTotal: "1000" })).toBe("CREDIT");
    expect(derivePaymentTerms({ total: "0", paidAmount: "0" })).toBe("CREDIT");
  });

  it("حقولٌ غائبة/فارغة (null) لا تنهار ولا تُنتج نقديّاً افتراضياً", () => {
    expect(derivePaymentTerms({})).toBe("CREDIT");
    expect(derivePaymentTerms({ total: null, paidAmount: null, returnedTotal: null })).toBe("CREDIT");
    // الحارس الجوهريّ: `paidAmount` مفقود بينما الإجماليّ موجب ⇒ لا يُفترَض السداد أبداً.
    expect(derivePaymentTerms({ total: "250.00" })).toBe("CREDIT");
  });

  it("لا يُستعمل parseFloat — الكسور العشرية الطويلة تُقارَن بدقّة", () => {
    expect(derivePaymentTerms({ total: "0.30", paidAmount: "0.10" })).toBe("CREDIT");
    expect(derivePaymentTerms({ total: "0.30", paidAmount: "0.30" })).toBe("CASH");
  });
});
