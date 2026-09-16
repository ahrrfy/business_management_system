import { describe, expect, it } from "vitest";
import { buildReturnRequestDecisionView } from "../returnRequestView";

const item = {
  id: 10,
  itemNameSnapshot: "ورق ليجر amigo 100g 500sheets",
  productName: "ورق ليجر",
  variantName: "100g",
  sku: "PR-AMIGO100G500-EC0E",
  unitName: "قطعة",
  conversionFactor: 1,
  total: "50000.00",
  baseQuantity: 5,
  returnedBaseQuantity: 0,
  unitPrice: "10000.00",
};

const base = {
  invoice: {
    subtotal: "100000.00",
    discountAmount: "0.00",
    taxAmount: "0.00",
    total: "100000.00",
    paidAmount: "0.00",
    returnedTotal: "0.00",
    paymentMethod: null,
    createdAt: new Date("2026-09-13T10:18:00.000Z"),
    createdByName: "نور محمد احمد",
  },
  lines: [{ invoiceItemId: 10, baseQuantity: 1 }],
  items: [item],
  refundable: "0.00",
};

describe("عرض قرار طلب مرتجع البيع القديم", () => {
  it("يحسب قيمة المرتجع الجزئي من البند ولا يعيد إجمالي الفاتورة", () => {
    const view = buildReturnRequestDecisionView(base);
    expect(view.amount).toBe("10000.00");
    expect(view.summaryItems[0]).toMatchObject({
      label: "ورق ليجر amigo 100g 500sheets",
      qty: 1,
      unit: "قطعة",
      unitPrice: "10000.00",
    });
  });

  it("الفاتورة غير المقبوضة تمحو أثر البيع ولا تدّعي خروج مال", () => {
    const view = buildReturnRequestDecisionView(base);
    expect(view.cashOutCap).toBe("0.00");
    expect(view.trigger).toBe("ERASE_EFFECT");
    expect(view.summaryItems.some((x) => x.label.includes("لا مال يخرج"))).toBe(true);
    expect(view.summaryItems.some((x) => x.label.includes("لا توجد دفعة مسجلة"))).toBe(true);
  });

  it("وجود قبض لا يعني خروج مال إن بقيت ذمة بعد المرتجع", () => {
    const view = buildReturnRequestDecisionView({
      ...base,
      invoice: { ...base.invoice, paidAmount: "40000.00", paymentMethod: "CASH" },
      refundable: "40000.00",
    });
    expect(view.cashOutCap).toBe("0.00");
    expect(view.trigger).toBe("ERASE_EFFECT");
  });

  it("يضع خروج مال فقط بقدر ما سيصبح مستحقاً للعميل", () => {
    const view = buildReturnRequestDecisionView({
      ...base,
      invoice: { ...base.invoice, paidAmount: "100000.00", paymentMethod: "CASH" },
      refundable: "100000.00",
    });
    expect(view.cashOutCap).toBe("10000.00");
    expect(view.trigger).toBe("MONEY_OUT");
    expect(view.summaryItems.some((x) => x.label.includes("أقصى رد مالي"))).toBe(true);
  });

  it("يطبّق الخصم والضريبة بنفس ترتيب تقريب محرّك التنفيذ", () => {
    const view = buildReturnRequestDecisionView({
      ...base,
      invoice: {
        ...base.invoice,
        subtotal: "100.00",
        discountAmount: "20.00",
        taxAmount: "8.00",
        total: "88.00",
        paidAmount: "35.00",
      },
      lines: [{ invoiceItemId: 10, baseQuantity: 5 }],
      items: [{ ...item, total: "100.00", baseQuantity: 10 }],
      refundable: "35.00",
    });
    expect(view.amount).toBe("44.00");
    expect(view.cashOutCap).toBe("0.00");
    expect(view.trigger).toBe("ERASE_EFFECT");
  });

  it("يستعمل باقي إجمالي الفاتورة عند الإرجاع المكمل لالتقاط الشحن والتقريب", () => {
    const view = buildReturnRequestDecisionView({
      ...base,
      invoice: {
        ...base.invoice,
        subtotal: "100.00",
        discountAmount: "20.00",
        taxAmount: "8.00",
        total: "98.00",
        returnedTotal: "44.00",
        paidAmount: "98.00",
      },
      lines: [{ invoiceItemId: 10, baseQuantity: 5 }],
      items: [{ ...item, total: "100.00", baseQuantity: 10, returnedBaseQuantity: 5 }],
      refundable: "54.00",
    });
    expect(view.amount).toBe("54.00");
    expect(view.cashOutCap).toBe("54.00");
    expect(view.trigger).toBe("MONEY_OUT");
  });

  it("يعرض منشئ الفاتورة ووقتها كبيانات مستقلة عن وقت الطلب", () => {
    const view = buildReturnRequestDecisionView(base);
    expect(view.summaryItems).toContainEqual({
      label: "أنشأ الفاتورة: نور محمد احمد",
      timestamp: "2026-09-13T10:18:00.000Z",
    });
  });

  it("لا يخترع مبلغاً حين لا يطابق بند الطلب الفاتورة", () => {
    const view = buildReturnRequestDecisionView({
      ...base,
      lines: [{ invoiceItemId: 999, baseQuantity: 1 }],
    });
    expect(view.amount).toBeNull();
    expect(view.cashOutCap).toBeNull();
    expect(view.trigger).toBeNull();
    expect(view.summaryItems[0]?.label).toContain("#999");
  });

  it.each([
    {
      invoiceNumber: "15374",
      total: "64000.00",
      lines: [
        { invoiceItemId: 38997, baseQuantity: 2 },
        { invoiceItemId: 38998, baseQuantity: 2 },
      ],
      items: [
        { ...item, id: 38997, itemNameSnapshot: "ورق ليجر amigo 100g 500sheets", total: "60000.00", baseQuantity: 2, unitPrice: "30000.00" },
        { ...item, id: 38998, itemNameSnapshot: "قلم سوفت PILOT V5 Grip", total: "4000.00", baseQuantity: 2, unitPrice: "2000.00" },
      ],
    },
    {
      invoiceNumber: "16066",
      total: "25000.00",
      lines: [{ invoiceItemId: 42726, baseQuantity: 1 }],
      items: [{ ...item, id: 42726, itemNameSnapshot: "بكج كتب ثاني متوسط", total: "25000.00", baseQuantity: 1, unitPrice: "25000.00" }],
    },
  ])("فاتورة $invoiceNumber غير المقبوضة تبقى بلا خروج مال وتعرض بنودها الحقيقية", (fixture) => {
    const view = buildReturnRequestDecisionView({
      invoice: { ...base.invoice, subtotal: fixture.total, total: fixture.total },
      lines: fixture.lines,
      items: fixture.items,
      refundable: "0.00",
    });
    expect(view.amount).toBe(fixture.total);
    expect(view.cashOutCap).toBe("0.00");
    expect(view.trigger).toBe("ERASE_EFFECT");
    expect(view.summaryItems.slice(0, fixture.items.length).map((line) => line.label)).toEqual(
      fixture.items.map((line) => line.itemNameSnapshot),
    );
  });
});
