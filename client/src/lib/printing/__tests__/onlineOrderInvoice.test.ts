import { describe, expect, it, vi } from "vitest";
import {
  buildOnlineOrderInvoicePrintData,
  printOnlineOrderInvoiceA4,
  type OnlineOrderPrintData,
} from "../onlineOrder";
import * as printTemplates from "../printTemplates";

describe("Online Order Unified Invoice Printing", () => {
  const sampleOrder: OnlineOrderPrintData = {
    orderNumber: "ORD-2026-1045",
    customerName: "علي حسن",
    customerPhone: "07701234567",
    governorate: "بغداد",
    addressText: "الكرادة - شارع 14 رمضان",
    status: "PROCESSING",
    subtotal: "25000",
    deliveryFee: "5000",
    deliveryFree: false,
    deliveryWaivedAmount: "0",
    total: "30000",
    createdAt: new Date("2026-10-06T12:00:00Z"),
    items: [
      {
        productName: "دفتر ملاحظات جلدي",
        variantLabel: "أسود A5",
        imageUrl: null,
        unitName: "قطعة",
        quantity: "2",
        unitPrice: "10000",
        total: "20000",
        customizationSummary: "طباعة الاسم بالليزر",
      },
      {
        productName: "قلم حبر جاف فاخر",
        variantLabel: "أزرق",
        imageUrl: null,
        unitName: "قطعة",
        quantity: "1",
        unitPrice: "5000",
        total: "5000",
      },
    ],
    notes: "يرجى الاتصال قبل الوصول",
  };

  it("preserves UX ID integrity in invoiceNumber and barcode", () => {
    const printData = buildOnlineOrderInvoicePrintData(sampleOrder);

    // UX ID integrity: orderNumber ORD-2026-1045 used directly without mutation
    expect(printData.invoiceNumber).toBe("ORD-2026-1045");
    expect(printData.barcode).toBe("ORD-2026-1045");
    expect(printData.qrPayload).toBe("ORD-2026-1045");
    expect(printData.paymentMethod).toBe("الدفع عند الاستلام (COD)");
    expect(printData.customerName).toBe("علي حسن");
    expect(printData.customerPhone).toBe("07701234567");
    expect(printData.customerAddress).toBe("بغداد — الكرادة - شارع 14 رمضان");
    expect(printData.notes).toBe("يرجى الاتصال قبل الوصول");
  });

  it("correctly maps items with variant label and customization summary", () => {
    const printData = buildOnlineOrderInvoicePrintData(sampleOrder);

    expect(printData.items).toHaveLength(2);
    expect(printData.items[0]).toEqual({
      productName: "دفتر ملاحظات جلدي — أسود A5 (تخصيص: طباعة الاسم بالليزر)",
      unitName: "قطعة",
      quantity: "2",
      unitPrice: "10000",
      total: "20000",
    });
    expect(printData.items[1]).toEqual({
      productName: "قلم حبر جاف فاخر — أزرق",
      unitName: "قطعة",
      quantity: "1",
      unitPrice: "5000",
      total: "5000",
    });
  });

  it("handles free delivery and waived amount correctly", () => {
    const freeDeliveryOrder: OnlineOrderPrintData = {
      ...sampleOrder,
      deliveryFee: "0",
      deliveryFree: true,
      deliveryWaivedAmount: "5000",
      total: "25000",
    };

    const printData = buildOnlineOrderInvoicePrintData(freeDeliveryOrder);
    expect(printData.deliveryFee).toBe("0");
    expect(printData.deliveryFree).toBe(true);
    expect(printData.deliveryWaivedAmount).toBe("5000");
    expect(printData.total).toBe("25000");
  });

  it("respects barcode: false setting", () => {
    const noBarcodeOrder: OnlineOrderPrintData = {
      ...sampleOrder,
      barcode: false,
    };

    const printData = buildOnlineOrderInvoicePrintData(noBarcodeOrder);
    expect(printData.barcode).toBeNull();
  });

  it("maps coupon discount and coupon code correctly", () => {
    const discountedOrder: OnlineOrderPrintData = {
      ...sampleOrder,
      couponCode: "SAVE10",
      couponDiscount: "5000",
      total: "25000",
    };

    const printData = buildOnlineOrderInvoicePrintData(discountedOrder);
    expect(printData.discountAmount).toBe("5000");
    expect(printData.notes).toContain("كوبون خصم: SAVE10");
  });

  it("falls back to standard 'عميل نقدي' when customer name is missing, empty, or whitespace", () => {
    const anonymousOrder: OnlineOrderPrintData = {
      ...sampleOrder,
      customerName: "   ",
    };

    const printData = buildOnlineOrderInvoicePrintData(anonymousOrder);
    expect(printData.customerName).toBe("عميل نقدي");
  });

  it("resolves governorate code to Arabic name and combines address", () => {
    const orderWithGovCode: OnlineOrderPrintData = {
      ...sampleOrder,
      governorate: "basra",
      addressText: "شارع الجزائر",
    };

    const printData = buildOnlineOrderInvoicePrintData(orderWithGovCode);
    expect(printData.customerAddress).toBe("البصرة — شارع الجزائر");
  });

  it("constructs verified storefront tracking QR URL when labelToken is provided", () => {
    const orderWithToken: OnlineOrderPrintData = {
      ...sampleOrder,
      labelToken: "secure-token-123",
    };

    const printData = buildOnlineOrderInvoicePrintData(orderWithToken);
    expect(printData.qrUrl).toContain("order=ORD-2026-1045");
    expect(printData.qrUrl).toContain("token=secure-token-123");
  });

  it("printOnlineOrderInvoiceA4 delegates to printInvoiceA4 with transformed data", async () => {
    const spy = vi.spyOn(printTemplates, "printInvoiceA4").mockResolvedValue(undefined as never);

    await printOnlineOrderInvoiceA4(sampleOrder);

    expect(spy).toHaveBeenCalledTimes(1);
    const calledArg = spy.mock.calls[0][0];
    expect(calledArg.invoiceNumber).toBe("ORD-2026-1045");
    expect(calledArg.barcode).toBe("ORD-2026-1045");
    expect(calledArg.items).toHaveLength(2);
    expect(calledArg.customerBalance).toBeUndefined();

    spy.mockRestore();
  });

  it("sanitizes whitespace-only customerPhone, addressText, and notes", () => {
    const whitespaceOrder: OnlineOrderPrintData = {
      ...sampleOrder,
      customerPhone: "   ",
      governorate: null,
      addressText: "   ",
      notes: "   ",
    };

    const printData = buildOnlineOrderInvoicePrintData(whitespaceOrder);
    expect(printData.customerPhone).toBeNull();
    expect(printData.customerAddress).toBeNull();
    expect(printData.notes).toBeNull();
    expect(printData.customerBalance).toBeUndefined();
  });

  it("reflects paidAmount equal to total when order is DELIVERED, and 0 otherwise", () => {
    const deliveredOrder: OnlineOrderPrintData = {
      ...sampleOrder,
      status: "DELIVERED",
    };
    const deliveredData = buildOnlineOrderInvoicePrintData(deliveredOrder);
    expect(deliveredData.paidAmount).toBe("30000");

    const processingData = buildOnlineOrderInvoicePrintData(sampleOrder);
    expect(processingData.paidAmount).toBe("0");
  });
});

