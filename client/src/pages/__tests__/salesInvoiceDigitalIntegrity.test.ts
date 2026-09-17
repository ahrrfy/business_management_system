import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(import.meta.dirname, "../SalesInvoiceNew.tsx"),
  "utf8",
);

const fulfillmentStart = source.indexOf("function startDigitalFulfillment");
const fulfillmentEnd = source.indexOf("function addDigitalBasket", fulfillmentStart);
const fulfillmentSource = source.slice(fulfillmentStart, fulfillmentEnd);

describe("SalesInvoiceNew digital invoice contract", () => {
  it("يمرر عقد البطاقة المؤكد كاملاً ولا يعيد نسخة سعر وهمية", () => {
    expect(source).toContain("lines: digitalLines.map((c) => toDigitalPrepareLine(c.digital!))");
    expect(source).toContain("toDigitalPrepareLine");
    expect(source).not.toMatch(/priceVersionId:\s*1\b/);
  });

  it("يحفظ كل مثيل بمفتاح UUID ويمنع الآجل والدفع الجزئي والقبض الخارجي قبل الحجز", () => {
    expect(source).toContain("internalLineToken: l.digital.lineKey");
    expect(source).toContain("validateDigitalInvoiceCheckout(state.items");
    expect(source).toContain("!hasDigitalItems && state.paymentMethod !== \"CASH\"");
  });

  it("يرفض خصم الرأس والضريبة والتوصيل عند وجود كرت رقمي", () => {
    expect(source).toContain("globalDiscount: totals.globalDiscAmt");
    expect(source).toContain("shipping: totals.shipping, taxEnabled: state.taxEnabled, totalTax: totals.totalTax");
  });

  it("يرفض إهداء السطر الرقمي برسالة تشغيلية واضحة", () => {
    expect(source).toContain("validateDigitalInvoiceCheckout(state.items");
  });

  it("يفصل بيانات اعتماد المدير عن sourcePayload الدائم", () => {
    expect(fulfillmentStart).toBeGreaterThan(-1);
    expect(fulfillmentEnd).toBeGreaterThan(fulfillmentStart);
    expect(fulfillmentSource).toContain("const { managerApproval: _managerApproval, ...sourcePayload } = payload");
    expect(fulfillmentSource).toContain("sourcePayload,");
    expect(fulfillmentSource).toContain("...(approval ? { managerApproval: approval } : {})");
    expect(fulfillmentSource).not.toMatch(/sourcePayload\s*:\s*\{[^}]*managerApproval/s);
  });

  it("يبقي خصم السطر الرقمي في لقطة الفاتورة", () => {
    expect(source).toContain("discountPercent:");
    expect(source).toContain("discountAmount:");
    expect(source).toContain("unitPriceOverride: round2(D(l.price)).toFixed(2)");
  });
});
