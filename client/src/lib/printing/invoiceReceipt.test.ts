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

  it("maps COD paymentMode and formats payment method label when unpaid", () => {
    const receipt = invoiceToReceipt({
      invoiceNumber: "INV-COD-1",
      invoiceDate: "2026-10-12T12:00:00.000Z",
      subtotal: "15000.00",
      total: "15000.00",
      paidAmount: "0.00",
      paymentMode: "COD",
      items: [],
    });

    expect(receipt.paymentMode).toBe("COD");
    expect(receipt.credit).toBe("15000");
    expect(receipt.paymentMethod).toBe("دفع عند الاستلام (COD)");
  });

  it("extracts split paymentLegs when an invoice has multiple IN receipts (MIXED)", async () => {
    const { buildBrowserReceiptHtml } = await import("./printTemplates");
    const { buildSalesInvoiceV2Html } = await import("./printTemplatesV2");

    const receipt = invoiceToReceipt({
      invoiceNumber: "INV-MIXED-1",
      invoiceDate: "2026-10-21T12:00:00.000Z",
      subtotal: "25000.00",
      total: "25000.00",
      paidAmount: "25000.00",
      paymentMethod: "MIXED",
      payments: [
        { direction: "IN", paymentMethod: "CASH", amount: "10000.00", referenceNumber: null },
        { direction: "IN", paymentMethod: "CARD", amount: "15000.00", referenceNumber: "POS-REF-7788" },
      ],
      items: [
        {
          productName: "حقيبة مدرسية",
          unitName: "قطعة",
          quantity: "1",
          unitPrice: "25000.00",
          total: "25000.00",
        },
      ],
    });

    expect(receipt.paymentMethod).toBe("مختلطة");
    expect(receipt.paymentLegs).toEqual([
      { method: "نقدي", amount: "10000.00", reference: null },
      { method: "بطاقة", amount: "15000.00", reference: "POS-REF-7788" },
    ]);

    const thermalHtml = buildBrowserReceiptHtml(receipt);
    expect(thermalHtml).toContain("مختلط");
    expect(thermalHtml).toContain("نقدي");
    expect(thermalHtml).toContain("بطاقة");
    expect(thermalHtml).toContain("POS-REF-7788");

    const a4Html = buildSalesInvoiceV2Html({
      invoiceNumber: "INV-MIXED-1",
      invoiceDate: "2026-10-21",
      items: [{ productName: "حقيبة مدرسية", quantity: 1, unitPrice: 25000, total: 25000 }],
      subtotal: 25000,
      discountAmount: 0,
      taxAmount: 0,
      total: 25000,
      paidAmount: 25000,
      remainingAmount: 0,
      status: "PAID",
      paymentMethod: "MIXED",
      paymentLegs: receipt.paymentLegs,
    });
    expect(a4Html).toContain("نقدي");
    expect(a4Html).toContain("بطاقة");
    expect(a4Html).toContain("POS-REF-7788");
  });
});
