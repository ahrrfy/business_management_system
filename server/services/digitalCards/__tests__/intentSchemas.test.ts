import { describe, expect, it } from "vitest";

import {
  assertInvoiceFullPayment,
  assertInvoiceLinePartition,
  assertInvoiceSourceEnvelope,
  computeInvoiceIntentTotal,
  parseInvoiceSourcePayload,
} from "../intentSchemas";

function rawPayload() {
  return {
    branchId: 1,
    shiftId: 9,
    customerId: 4,
    priceTier: "RETAIL" as const,
    clientRequestId: "invoice-request-1",
    lines: [
      { variantId: 10, productUnitId: 100, quantity: "2", unitPriceOverride: "25.00" },
      {
        variantId: 20,
        productUnitId: 200,
        quantity: "1",
        unitPriceOverride: "100.00",
        discountPercent: "10.00",
        internalLineToken: "digital-a",
      },
      {
        variantId: 21,
        productUnitId: 201,
        quantity: "1",
        unitPriceOverride: "100.00",
        internalLineToken: "digital-b",
      },
    ],
    dueDate: "2026-09-30",
    notes: "ملاحظة محفوظة",
    payment: { amount: "240.00", method: "CASH" as const },
  };
}

const digitalLines = [
  { lineKey: "digital-a", variantId: 20, productUnitId: 200, sellPrice: "100.00" },
  { lineKey: "digital-b", variantId: 21, productUnitId: 201, sellPrice: "100.00" },
] as const;

describe("INVOICE digital intent source payload", () => {
  it("يقبل خصم السطر الرقمي ويحسب الإجمالي من السعر الموثق بدقة", () => {
    const sourcePayload = parseInvoiceSourcePayload(rawPayload());
    const result = computeInvoiceIntentTotal({
      regularSubtotal: "50.00",
      sourcePayload,
      digitalLines,
    });

    expect(result.subtotal).toBe("240.00");
    expect(result.total).toBe("240.00");
    expect(result.digitalLineTotals.get("digital-a")).toBe("90.00");
    expect(result.digitalLineTotals.get("digital-b")).toBe("100.00");
    expect(result.digitalSourceLines.get("digital-a")?.discountPercent).toBe("10.00");
  });

  it("يربط الغلاف والبنود العادية والدفع النقدي الكامل بالنيّة", () => {
    const sourcePayload = parseInvoiceSourcePayload(rawPayload());
    expect(() => assertInvoiceSourceEnvelope(sourcePayload, {
      branchId: 1,
      shiftId: 9,
      customerId: 4,
      priceTier: "RETAIL",
      clientRequestId: "invoice-request-1",
    })).not.toThrow();
    expect(() => assertInvoiceLinePartition(sourcePayload, [{
      lineKey: "regular-0",
      variantId: 10,
      productUnitId: 100,
      quantity: "2.000",
      unitPriceOverride: "25",
    }])).not.toThrow();
    expect(() => assertInvoiceFullPayment(sourcePayload, {
      paymentMethod: "CASH",
      paymentAmount: "240.00",
    })).not.toThrow();
  });

  it("يقبل دفع البطاقة فقط عند تطابق المحاولة والجهاز والمبلغ كاملاً", () => {
    const sourcePayload = parseInvoiceSourcePayload({
      ...rawPayload(),
      deviceId: "pos-device-1",
      payment: {
        amount: "240.00",
        method: "CARD",
        externalPaymentAttemptId: 77,
      },
    });
    expect(() => assertInvoiceFullPayment(sourcePayload, {
      paymentMethod: "CARD",
      paymentAmount: "240.00",
      externalPaymentAttemptId: 77,
      externalPaymentDeviceId: "pos-device-1",
    })).not.toThrow();
    expect(() => assertInvoiceFullPayment(sourcePayload, {
      paymentMethod: "CARD",
      paymentAmount: "240.00",
      externalPaymentAttemptId: 78,
      externalPaymentDeviceId: "pos-device-1",
    })).toThrow(/إثبات دفع البطاقة لا يطابق النيّة/);
  });

  it.each([
    ["خصم الرأس", { invoiceDiscount: "1.00" }],
    ["الضريبة", { taxRatePercent: "1.00" }],
    ["أجرة التوصيل", { deliveryFee: "1.00" }],
    ["التوصيل المجاني", { deliveryFree: true, deliveryWaivedAmount: "2.00" }],
  ])("يرفض %s عند وجود كروت رقمية", (_label, headerFields) => {
    const sourcePayload = parseInvoiceSourcePayload({ ...rawPayload(), ...headerFields });
    expect(() => computeInvoiceIntentTotal({
      regularSubtotal: "50.00",
      sourcePayload,
      digitalLines,
    })).toThrow(/خصم رأس الفاتورة أو الضريبة أو التوصيل/);
  });

  it("يرفض إهداء كرت رقمي لأن عكسه يحتاج قيد هدية مستقل", () => {
    const value = rawPayload();
    value.lines[1] = { ...value.lines[1], isGift: true };
    const sourcePayload = parseInvoiceSourcePayload(value);
    expect(() => computeInvoiceIntentTotal({
      regularSubtotal: "50.00",
      sourcePayload,
      digitalLines,
    })).toThrow(/إهداء كرت صادر غير مدعوم/);
  });

  it("يرفض كمية رقمية مجمّعة أو اختلاف البنود العادية", () => {
    const value = rawPayload();
    value.lines[1].quantity = "2";
    const sourcePayload = parseInvoiceSourcePayload(value);
    expect(() => computeInvoiceIntentTotal({
      regularSubtotal: "50.00",
      sourcePayload,
      digitalLines,
    })).toThrow(/كميته تغيّرت/);

    expect(() => assertInvoiceLinePartition(
      parseInvoiceSourcePayload(rawPayload()),
      [{
        lineKey: "regular-0",
        variantId: 10,
        productUnitId: 100,
        quantity: "3",
        unitPriceOverride: "25.00",
      }],
    )).toThrow(/البنود العادية في الفاتورة لا تطابق/);
  });

  it("يحصر طريقة الدفع الدائمة في CASH أو CARD ويرفض البيع الآجل", () => {
    expect(() => parseInvoiceSourcePayload({
      ...rawPayload(),
      payment: { amount: "240.00", method: "CREDIT" },
    })).toThrow(/حمولة فاتورة البيع الرقمية غير صالحة/);

    expect(() => assertInvoiceFullPayment(parseInvoiceSourcePayload(rawPayload()), {
      paymentMethod: "CREDIT",
      paymentAmount: "0.00",
    })).toThrow(/لا تدعم البيع الآجل/);
  });

  it("يفرض مخططاً صارماً ولا يسمح بحفظ بيانات اعتماد المدير", () => {
    expect(() => parseInvoiceSourcePayload({
      ...rawPayload(),
      managerApproval: { email: "manager@example.com", password: "secret" },
    })).toThrow(/حمولة فاتورة البيع الرقمية غير صالحة/);
    expect(() => parseInvoiceSourcePayload({
      ...rawPayload(),
      untrustedField: "must-not-persist",
    })).toThrow(/حمولة فاتورة البيع الرقمية غير صالحة/);
  });
});
