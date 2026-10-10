import { describe, expect, it } from "vitest";
import { computePOSTotals, evaluatePosCreditPrompt } from "../posTotals";
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

describe("evaluatePosCreditPrompt — credit limit pre-flight evaluation", () => {
  it("returns null when not a credit sale", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "0", currentBalance: "0" },
      isCredit: false,
      creditAmount: 0,
    });
    expect(res).toBeNull();
  });

  it("returns null when customer is null or undefined", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: null,
      isCredit: true,
      creditAmount: 5000,
    });
    expect(res).toBeNull();
  });

  it("returns null when customer has unlimited credit (creditLimit: null)", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: null, currentBalance: "100000" },
      isCredit: true,
      creditAmount: 500000,
    });
    expect(res).toBeNull();
  });

  it("returns prompt for cash-only customer (creditLimit: 0) without debt", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "0", currentBalance: "0" },
      isCredit: true,
      creditAmount: 15000,
    });
    expect(res).toContain("هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر)");
    expect(res).toContain("موافقة مدير");
    expect(res).not.toContain("رصيد سابق");
  });

  it("returns prompt mentioning existing debt for cash-only customer with balance", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "0", currentBalance: "25000.00" },
      isCredit: true,
      creditAmount: 10000,
    });
    expect(res).toContain("هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر)");
    expect(res).toContain("رصيد سابق (25000.00)");
    expect(res).toContain("موافقة مدير");
  });

  it("returns null when purchase is within positive credit limit", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "100000.00", currentBalance: "40000.00" },
      isCredit: true,
      creditAmount: 50000, // 40000 + 50000 = 90000 <= 100000
    });
    expect(res).toBeNull();
  });

  it("returns prompt when purchase exceeds credit limit", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "100000.00", currentBalance: "40000.00" },
      isCredit: true,
      creditAmount: 70000, // 40000 + 70000 = 110000 > 100000
    });
    expect(res).toContain("تجاوز حدّ الائتمان");
    expect(res).toContain("على العميل 40000.00");
    expect(res).toContain("وهذا البيع يضيف 70000.00");
    expect(res).toContain("وسقفه 100000.00");
    expect(res).toContain("المتاح 60000.00");
    expect(res).toContain("موافقة مدير");
  });

  it("handles customer balance already at or above limit", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "50000.00", currentBalance: "55000.00" },
      isCredit: true,
      creditAmount: 10000,
    });
    expect(res).toContain("المتاح 0.00");
    expect(res).toContain("موافقة مدير");
  });
});

