import { describe, expect, it } from "vitest";
import { invoiceToReceipt } from "./invoiceReceipt";

describe("invoiceToReceipt", () => {
  it("rebuilds an accurate thermal receipt from a saved invoice", () => {
    const receipt = invoiceToReceipt({
      invoiceNumber: "INV-42",
      invoiceDate: "2026-07-28T11:35:00.000Z",
      customerName: "أحمد",
      salespersonName: "سارة",
      shiftId: 17,
      subtotal: "12000.00",
      discountAmount: "1000.00",
      taxAmount: "500.00",
      total: "11500.00",
      paidAmount: "6000.00",
      returnedTotal: "500.00",
      paymentMethod: "CASH",
      items: [{
        productName: "دفتر",
        variantName: "أزرق",
        unitName: "قطعة",
        quantity: "2",
        unitPrice: "6000.00",
        total: "12000.00",
      }],
    });

    expect(receipt.receiptNumber).toBe("INV-42");
    expect(receipt.cashierName).toBe("سارة");
    expect(receipt.shiftId).toBe(17);
    expect(receipt.discount).toBe("1000.00");
    expect(receipt.credit).toBe("5000");
    expect(receipt.paymentMethod).toBe("نقدي");
    expect(receipt.items[0]).toMatchObject({
      name: "دفتر — أزرق — (قطعة)",
      quantity: 2,
    });
    expect(receipt.delivery).toBeNull();
  });

  it("includes delivery information when courier consignment is active", () => {
    const receipt = invoiceToReceipt({
      invoiceNumber: "INV-43",
      invoiceDate: "2026-07-28T11:35:00.000Z",
      subtotal: "10000.00",
      total: "10000.00",
      courierName: "شركة البراق",
      courierFee: "5000.00",
      courierFeeCollection: "COURIER",
      consignmentStatus: "DISPATCHED",
      items: [],
    });

    expect(receipt.delivery).toEqual({
      partyName: "شركة البراق",
      fee: "5000.00",
      feeCollection: "COURIER",
    });
  });

  it("atomically omits delivery information when courier consignment is CANCELLED", () => {
    const receipt = invoiceToReceipt({
      invoiceNumber: "INV-44",
      invoiceDate: "2026-07-28T11:35:00.000Z",
      subtotal: "10000.00",
      total: "10000.00",
      courierName: "شركة البراق",
      courierFee: "5000.00",
      courierFeeCollection: "COURIER",
      consignmentStatus: "CANCELLED",
      items: [],
    });

    expect(receipt.delivery).toBeNull();
  });
});
