import { describe, expect, it } from "vitest";
import { invoiceToReceipt } from "./invoiceReceipt";
import { invoicePrintAmounts } from "./receiptLayoutInvoiceAmounts";
import { buildBrowserReceiptHtml } from "./receiptLayoutHtml";
import { buildSalesInvoiceV2Html } from "./printTemplatesV2";

describe("credit invoice delivery collection", () => {
  const creditInvoice = {
    invoiceNumber: "101567", invoiceDate: "2026-10-24T17:25:00Z", status: "PARTIALLY_PAID",
    subtotal: "35000.00", total: "35000.00", paidAmount: "30000.00", returnedTotal: "0.00",
    paymentMode: "CREDIT", courierName: "ناقل", courierFee: "5000.00", items: [],
  };

  it("prints invoice101567 goods5000 plus fee5000 when credit collection is explicitly selected",()=>{
    const input={...creditInvoice,collectCreditOnDelivery:true,courierFeeCollection:"COURIER" as const};
    expect(invoicePrintAmounts(input)).toMatchObject({courierGoodsDue:"5000.00",creditDue:"0.00"});
    for(const html of [buildBrowserReceiptHtml(invoiceToReceipt(input)),buildSalesInvoiceV2Html({...input,courierDelivery:{partyName:"ناقل",fee:"5000.00",feeCollection:"COURIER"}})]) {
      expect(html).toContain("10,000");expect(html).not.toContain("رصيد البضاعة آجل؛ لا يحصله المندوب");
      expect(html).not.toContain("أجرة التوصيل فقط");
    }
  });

  it("keeps the customer debt outside courier goods collection", () => {
    expect(invoicePrintAmounts(creditInvoice)).toMatchObject({
      remainingAmount: "5000.00", courierGoodsDue: "0.00", creditDue: "5000.00",
    });
  });

  it.each(["COURIER", "COUNTER", "SHOP"] as const)("preserves credit debt without prepaid claims for %s fee collection", (feeCollection) => {
    const input = { ...creditInvoice, courierFeeCollection: feeCollection };
    const htmls = [
      buildBrowserReceiptHtml(invoiceToReceipt(input)),
      buildSalesInvoiceV2Html({ ...input, courierDelivery: { partyName: "ناقل", fee: "5000.00", feeCollection } }),
    ];
    for (const html of htmls) {
      expect(html).toContain("5,000");
      expect(html).toContain("رصيد البضاعة آجل؛ لا يحصله المندوب");
      expect(html).not.toContain("10,000");
      expect(html).not.toContain("مدفوع بالكامل");
      expect(html).not.toContain("مدفوعة مسبقاً");
      if (feeCollection === "COURIER") expect(html).toContain("أجرة التوصيل فقط");
      else expect(html).toContain("0 د.ع");
    }
  });
});

describe("invoiceToReceipt", () => {
  const returnedInvoice = {
    invoiceNumber: "INV-PARTIAL-RETURN", invoiceDate: "2026-10-23T12:00:00Z",
    subtotal: "100000.00", total: "100000.00", returnedTotal: "40000.00", paidAmount: "10000.00",
    paymentMode: "COD", courierName: "شركة البراق", courierFee: "5000.00", consignmentStatus: "DISPATCHED",
    items: [{ productName: "دفتر", quantity: "2", unitPrice: "50000.00", total: "100000.00" }],
  };

  it("forwards current invoice facts for delivery collection while retaining original line amounts", () => {
    const receipt = invoiceToReceipt(returnedInvoice);
    expect(receipt).toMatchObject({
      subtotal: "100000.00", total: "100000.00", paid: "10000",
      returnedTotal: "40000.00", currentTotal: "60000.00", remainingAmount: "50000.00", credit: "50000",
      items: [{ quantity: 2, price: "50000.00", total: "100000.00" }],
      delivery: { fee: "5000.00" },
    });
  });

  it.each(["CANCELLED", "RETURNED", "SUPERSEDED"])("forwards %s without a current debt while preserving original amounts and the historical delivery fee", (status) => {
    const receipt = invoiceToReceipt({ ...returnedInvoice, status, returnedTotal: "0.00" });
    expect(receipt).toMatchObject({
      status, total: "100000.00", returnedTotal: "0.00", currentTotal: "0.00", remainingAmount: "0.00", credit: null,
      delivery: { fee: "5000.00" },
    });
    expect(receipt.paymentMethod).toBeNull();
  });

  it("clamps current credit after an overpayment without rounding drift", () => {
    const receipt = invoiceToReceipt({ ...returnedInvoice, total: "100.10", returnedTotal: "40.20", paidAmount: "59.91" });
    expect(receipt).toMatchObject({ currentTotal: "59.90", remainingAmount: "0.00", credit: null });
  });

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

  it("renders marketing promotional banner & free-shipping gift callout across Thermal, A4 V2, and Shipping Label", async () => {
    const { buildBrowserReceiptHtml } = await import("./printTemplates");
    const { buildSalesInvoiceV2Html } = await import("./printTemplatesV2");
    const { invoiceDetailPrintData } = await import("./invoiceDetailPrintData");
    const { invoiceToShippingLabel } = await import("./invoiceShippingLabel");
    const { shippingLabelHtml } = await import("./shippingLabel");

    const savedPromoInvoice = {
      invoiceNumber: "INV-PROMO-77",
      invoiceDate: "2026-11-13T12:00:00.000Z",
      subtotal: "30000.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      total: "24000.00",
      paidAmount: "24000.00",
      returnedTotal: "0.00",
      status: "PAID" as const,
      paymentMethod: "CASH",
      deliveryFree: true,
      deliveryWaivedAmount: "5000.00",
      courierName: "شركة النور للتوصيل",
      courierFee: "5000.00",
      courierFeeCollection: "SHOP" as const,
      items: [
        {
          productName: "طقم دفاتر جامعية",
          unitName: "قطعة",
          quantity: "3",
          unitPrice: "10000.00",
          total: "24000.00",
          promotionId: 77,
          promotionDiscount: "6000.00",
          promotionName: "عرض العودة للمدارس + توصيل مجاني",
        },
      ],
    };

    const receipt = invoiceToReceipt(savedPromoInvoice);
    expect(receipt.promoSummary).toMatchObject({
      offerNames: ["عرض العودة للمدارس + توصيل مجاني"],
      merchandiseSavings: "6000.00",
      freeShipping: true,
      waivedDeliveryAmount: "5000.00",
      totalSavings: "11000.00",
    });

    const thermalHtml = buildBrowserReceiptHtml(receipt);
    expect(thermalHtml).toContain("مزايا العروض وتوفيرك في هذه الفاتورة");
    expect(thermalHtml).toContain("عرض العودة للمدارس + توصيل مجاني");
    expect(thermalHtml).toContain("هدية التوصيل المجاني");
    expect(thermalHtml).toContain("11,000");

    const a4Input = invoiceDetailPrintData(savedPromoInvoice as never, null);
    const a4Html = buildSalesInvoiceV2Html({
      ...a4Input,
      items: a4Input.items,
    });
    expect(a4Html).toContain("مزايا العروض الترويجية");
    expect(a4Html).toContain("عرض العودة للمدارس + توصيل مجاني");
    expect(a4Html).toContain("إجمالي توفير العميل");
    expect(a4Html).toContain("11,000");
    expect(a4Html).toContain("هدية عرض ترويجي");

    const labelData = invoiceToShippingLabel(savedPromoInvoice);
    expect(labelData.freeShippingPromo).toBe(true);
    const labelHtml = await shippingLabelHtml(labelData);
    expect(labelHtml).toContain("عرض التوصيل المجاني");

    // Dead (CANCELLED) invoice suppresses promotional marketing callout
    const cancelledReceipt = invoiceToReceipt({ ...savedPromoInvoice, status: "CANCELLED" });
    expect(cancelledReceipt.promoSummary).toBeNull();
    expect(buildBrowserReceiptHtml(cancelledReceipt)).not.toContain("مزايا العروض وتوفيرك في هذه الفاتورة");
  });
});
