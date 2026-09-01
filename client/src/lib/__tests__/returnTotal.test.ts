// اختبار مطابقة إجمالي المرتجع الواجهيّ لصيغة الخادم (returnService، فرع الإرجاع الجزئيّ):
// returnedRevenue = round2(Σ(itemTotal × qtyBase/itemBase) × (1 − discount/subtotal))
// returnedTax     = round2(returnedRevenue × taxAmount/(subtotal − discount))
// returnedTotal   = round2(returnedRevenue + returnedTax)
//
// ⚠️ نُقل من `pages/__tests__/salesReturnTotal.test.ts` بعد توحيد شاشتَي المرتجع في
// `ReturnComposer` (١٧/٨/٢٦): الصيغة كانت دالّةً مُصدَّرة من صفحة `SalesReturnNew` التي صارت
// إعادة تصديرٍ للشاشة الموحّدة، فأُخرجت إلى `lib/returnTotal` لتبقى مُختبَرةً وحدها.
// الحالات الستّ محفوظةٌ بحسابها كما كانت — العقد لم يتغيّر، مكانه فقط.
import { describe, expect, it } from "vitest";
import { computeReturnTotal, type ReturnTotalItem } from "../returnTotal";

const item = (invoiceItemId: number, baseQuantity: number, total: string): ReturnTotalItem => ({
  invoiceItemId,
  baseQuantity,
  total,
});

describe("computeReturnTotal — مطابقة صيغة returnService الجزئيّة", () => {
  it("بلا خصم ولا ضريبة: نسبة مباشرة", () => {
    // بند total=1000 مبيع 10، نُرجِع 4 ⇒ 1000×4/10 = 400.
    const inv = { subtotal: "1000.00", discountAmount: "0.00", taxAmount: "0.00" };
    expect(computeReturnTotal([item(1, 10, "1000.00")], { 1: 4 }, inv)).toBe("400.00");
  });

  it("خصم على مستوى الفاتورة (١٠٪) يُطبَّق تناسبياً", () => {
    // grossNet = 1000×5/10 = 500؛ discountRatio = 100/1000 = 0.1 ⇒ 500×0.9 = 450.
    const inv = { subtotal: "1000.00", discountAmount: "100.00", taxAmount: "0.00" };
    expect(computeReturnTotal([item(1, 10, "1000.00")], { 1: 5 }, inv)).toBe("450.00");
  });

  it("خصم + ضريبة: إرجاع كامل البند", () => {
    // grossNet=1000؛ revenue=1000×0.9=900؛ taxRate=45/900=0.05 ⇒ tax=45 ⇒ total=945.
    const inv = { subtotal: "1000.00", discountAmount: "100.00", taxAmount: "45.00" };
    expect(computeReturnTotal([item(1, 10, "1000.00")], { 1: 10 }, inv)).toBe("945.00");
  });

  it("بنود متعددة جزئية تُجمَع قبل التقريب", () => {
    // 1000×3/10 = 300، و500×1/4 = 125 ⇒ 425 (بلا خصم/ضريبة).
    const inv = { subtotal: "1500.00", discountAmount: "0.00", taxAmount: "0.00" };
    const items = [item(1, 10, "1000.00"), item(2, 4, "500.00")];
    expect(computeReturnTotal(items, { 1: 3, 2: 1 }, inv)).toBe("425.00");
  });

  it("بندٌ بلا كمية مُدخَلة يُتجاوَز (لا يُفسِد الإجمالي)", () => {
    const inv = { subtotal: "1000.00", discountAmount: "0.00", taxAmount: "0.00" };
    const items = [item(1, 10, "1000.00"), item(2, 0, "500.00")];
    // البند الثاني بمقامٍ صفريّ وبلا كمية ⇒ يُتجاهَل، فيبقى 1000×2/10 = 200.
    expect(computeReturnTotal(items, { 1: 2 }, inv)).toBe("200.00");
  });

  it("لا بنود ⇒ 0.00؛ ولا كميات ⇒ 0.00", () => {
    const inv = { subtotal: "1000.00", discountAmount: "0.00", taxAmount: "0.00" };
    expect(computeReturnTotal([], {}, inv)).toBe("0.00");
    expect(computeReturnTotal([item(1, 10, "1000.00")], {}, inv)).toBe("0.00");
  });

  it("المرتجع المُكمِل يأخذ الإجمالي المقرّب المخزّن لا إجمالي البنود الخام", () => {
    // بيع نقدي 1300 قُرّب إلى 1250: المطلوب من الدرج هو 1250 بالضبط.
    const inv = {
      subtotal: "1300.00", discountAmount: "0.00", taxAmount: "0.00",
      total: "1250.00", returnedTotal: "0.00",
    };
    expect(computeReturnTotal([item(1, 1, "1300.00")], { 1: 1 }, inv)).toBe("1250.00");
  });

  it("آخر مرتجع جزئي يأخذ باقي الفاتورة الدقيق بعد المرتجعات السابقة", () => {
    const inv = {
      subtotal: "1300.00", discountAmount: "0.00", taxAmount: "0.00",
      total: "1250.00", returnedTotal: "650.00",
    };
    const partiallyReturned = { ...item(1, 2, "1300.00"), returnedBaseQuantity: 1 };
    expect(computeReturnTotal([partiallyReturned], { 1: 1 }, inv)).toBe("600.00");
  });
});
