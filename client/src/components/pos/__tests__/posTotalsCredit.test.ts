import { describe, expect, it } from "vitest";
import { computePOSTotals } from "../posTotals";
import type { CartItem, POSTab } from "../posShared";

function makeItem(price: number, qty = 1): CartItem {
  return {
    row: {
      productId: 1,
      productUnitId: 10,
      productName: "دفتر تجارب",
      price: String(price),
      contractUnitPrice: String(price),
      currency: "IQD",
      unitName: "قطعة",
      barcode: "123456",
      sku: "SKU1",
      stockQty: "100",
      minQty: "0",
      categoryName: "قرطاسية",
    } as any,
    qty,
    disc: 0,
    origPrice: price,
  };
}

function makeTab(overrides: Partial<POSTab> = {}): POSTab {
  return {
    id: 1,
    label: "فاتورة 1",
    cart: [],
    payInput: "",
    method: "CASH",
    selId: null,
    numMode: "PAY",
    customerId: null,
    tierOverride: null,
    clientRequestId: "req-1",
    couponInput: "",
    couponCode: null,
    couponLabel: null,
    paymentRef: "",
    externalPayment: null,
    dueDate: "",
    invoiceDiscountPct: "",
    ...overrides,
  };
}

describe("computePOSTotals — credit and customer payment logic", () => {
  it("treats payInput='0' as full credit when customer is selected", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: 42,
      payInput: "0",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(true);
    expect(res.paid).toBe(0);
    expect(res.credit).toBe(10000);
    expect(res.total).toBe(10000);
  });

  it("does not treat payInput='0' as credit when customer is null (cash customer)", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: null,
      payInput: "0",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(false);
    expect(res.isChange).toBe(false);
  });

  it("calculates partial payment credit correctly when customer is selected", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: 42,
      payInput: "3000",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(true);
    expect(res.paid).toBe(3000);
    expect(res.credit).toBe(7000);
  });

  it("calculates full payment without credit", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: 42,
      payInput: "10000",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(false);
    expect(res.isChange).toBe(true);
    expect(res.paid).toBe(10000);
    expect(res.change).toBe(0);
    expect(res.credit).toBe(0);
  });
});
