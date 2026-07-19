// اختبار مطابقة إجمالي المرتجع الواجهيّ لصيغة الخادم (returnService، فرع الإرجاع الجزئيّ):
// returnedRevenue = round2(Σ(itemTotal × qtyBase/itemBase) × (1 − discount/subtotal))
// returnedTax     = round2(returnedRevenue × taxAmount/(subtotal − discount))
// returnedTotal   = round2(returnedRevenue + returnedTax)
import { describe, expect, it } from "vitest";
import { computeExpectedReturnTotal } from "../SalesReturnNew";
import type { InvoiceLine } from "@/components/invoice";

// بند محرّر مبسّط (الدالّة تقرأ productUnitId/qty/conversionFactor فقط).
const line = (productUnitId: number, qty: number | string): InvoiceLine =>
  ({ productUnitId, qty: String(qty), conversionFactor: "1" } as unknown as InvoiceLine);

const meta = (m: Record<number, { itemTotal: string; itemBaseQuantity: number }>) =>
  Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k, { invoiceItemId: Number(k), remainingBase: v.itemBaseQuantity, conversionFactor: "1", ...v }]),
  ) as any;

describe("computeExpectedReturnTotal — مطابقة صيغة returnService الجزئيّة", () => {
  it("بلا خصم ولا ضريبة: نسبة مباشرة", () => {
    // بند total=1000 مبيع 10، نُرجِع 4 ⇒ 1000×4/10 = 400.
    const inv = { subtotal: "1000.00", discountAmount: "0.00", taxAmount: "0.00" };
    const total = computeExpectedReturnTotal([line(-1, 4)], meta({ [-1]: { itemTotal: "1000.00", itemBaseQuantity: 10 } }), inv);
    expect(total).toBe("400.00");
  });

  it("خصم على مستوى الفاتورة (١٠٪) يُطبَّق تناسبياً", () => {
    // grossNet = 1000×5/10 = 500؛ discountRatio = 100/1000 = 0.1 ⇒ 500×0.9 = 450.
    const inv = { subtotal: "1000.00", discountAmount: "100.00", taxAmount: "0.00" };
    const total = computeExpectedReturnTotal([line(-1, 5)], meta({ [-1]: { itemTotal: "1000.00", itemBaseQuantity: 10 } }), inv);
    expect(total).toBe("450.00");
  });

  it("خصم + ضريبة: إرجاع كامل البند", () => {
    // grossNet=1000؛ revenue=1000×0.9=900؛ taxRate=45/900=0.05 ⇒ tax=45 ⇒ total=945.
    const inv = { subtotal: "1000.00", discountAmount: "100.00", taxAmount: "45.00" };
    const total = computeExpectedReturnTotal([line(-1, 10)], meta({ [-1]: { itemTotal: "1000.00", itemBaseQuantity: 10 } }), inv);
    expect(total).toBe("945.00");
  });

  it("بنود متعددة جزئية تُجمَع قبل التقريب", () => {
    // item1: 600×3/6=300؛ item2: 400×2/4=200 ⇒ 500 (بلا خصم/ضريبة).
    const inv = { subtotal: "1000.00", discountAmount: "0.00", taxAmount: "0.00" };
    const total = computeExpectedReturnTotal(
      [line(-1, 3), line(-2, 2)],
      meta({ [-1]: { itemTotal: "600.00", itemBaseQuantity: 6 }, [-2]: { itemTotal: "400.00", itemBaseQuantity: 4 } }),
      inv,
    );
    expect(total).toBe("500.00");
  });

  it("لا بنود ⇒ 0.00؛ لا فاتورة ⇒ 0.00", () => {
    expect(computeExpectedReturnTotal([], meta({}), { subtotal: "1000", discountAmount: "0", taxAmount: "0" })).toBe("0.00");
    expect(computeExpectedReturnTotal([line(-1, 4)], meta({ [-1]: { itemTotal: "1000", itemBaseQuantity: 10 } }), null)).toBe("0.00");
  });

  it("بندٌ بلا meta يُتجاوَز (لا يُفسِد الإجمالي)", () => {
    const inv = { subtotal: "1000.00", discountAmount: "0.00", taxAmount: "0.00" };
    const total = computeExpectedReturnTotal([line(-1, 4), line(-99, 5)], meta({ [-1]: { itemTotal: "1000.00", itemBaseQuantity: 10 } }), inv);
    expect(total).toBe("400.00");
  });
});
