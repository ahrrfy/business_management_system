import { describe, expect, it } from "vitest";
import { createInitialState, invoiceReducer } from "../reducer";
import { getLineStockState } from "../stockAvailability";
import type { InvoiceLine } from "../types";

function line(overrides: Partial<InvoiceLine> = {}): InvoiceLine {
  return {
    productId: 1,
    variantId: 1,
    productUnitId: 1,
    name: "دفتر",
    sku: "TEST",
    barcode: null,
    unit: "قطعة",
    qty: 1,
    conversionFactor: "1",
    stockBase: 0,
    price: "1000",
    costBase: "500",
    discount: "0",
    discountType: "percent",
    note: "",
    ...overrides,
  };
}

describe("دلالة مخزون سطر الفاتورة", () => {
  it("يميّز الفعلي والمحجوز ويعرض المتاح صفراً عند زيادة الحجز", () => {
    const state = getLineStockState(line({ stockBase: 10, reservedBase: 13, availableBase: 0 }), 1);
    expect(state).toMatchObject({
      isKnown: true,
      isOut: true,
      onHandBase: 10,
      reservedBase: 13,
      availableBase: 0,
      overbookedBase: 3,
    });
  });

  it("لا يخفي رصيداً فعلياً سالباً بينما يثبت المتاح للبيع عند الصفر", () => {
    const state = getLineStockState(line({ stockBase: -4, reservedBase: 0, availableBase: 0 }), 1);
    expect(state).toMatchObject({ onHandBase: -4, availableBase: 0, isOut: true, overbookedBase: 0 });
  });

  it("يحوّل المتاح من وحدة الأساس إلى وحدة البيع", () => {
    const state = getLineStockState(
      line({ conversionFactor: "12", stockBase: 30, reservedBase: 6, availableBase: 24 }),
      12,
    );
    expect(state.availableInUnit).toBe(2);
    expect(state.isShort).toBe(false);
  });

  it("لا يصف الخدمة بأنها نافذة حتى لو لم يكن لها رصيد", () => {
    const state = getLineStockState(line({ isService: true, stockBase: 0, availableBase: 0 }), 100);
    expect(state).toMatchObject({ isKnown: true, isService: true, isOut: false, isShort: false });
  });

  it("يعامل لقطة النسخ القديمة كمجهولة حتى يصل التحديث الحي", () => {
    const state = getLineStockState(line({ stockBase: 0, availableBase: undefined }), 1);
    expect(state).toMatchObject({ isKnown: false, isOut: false, isShort: false });
  });

  it("يمحو لقطة السلة ذرياً عند تغيير الفرع حتى لا يعرض رصيد الفرع القديم", () => {
    const initial = invoiceReducer(createInitialState("SALE", 1), {
      type: "ADD_ITEM",
      item: line({ stockBase: 10, stockBranchId: 1, reservedBase: 2, availableBase: 8 }),
    });

    const changed = invoiceReducer(initial, { type: "SET_FIELD", field: "branchId", value: 2 });
    expect(changed.branchId).toBe(2);
    expect(changed.items[0]).toMatchObject({ stockBase: 10 });
    expect(changed.items[0].stockBranchId).toBeUndefined();
    expect(changed.items[0].reservedBase).toBeUndefined();
    expect(changed.items[0].availableBase).toBeUndefined();
  });
});
