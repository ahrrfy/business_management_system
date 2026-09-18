import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(import.meta.dirname, "../SalesInvoiceNew.tsx"),
  "utf8",
);
const basketSource = readFileSync(
  path.resolve(import.meta.dirname, "../../components/pos/digitalBasket.ts"),
  "utf8",
);

const fulfillmentStart = source.indexOf("function startDigitalFulfillment");
const fulfillmentEnd = source.indexOf("function addDigitalBasket", fulfillmentStart);
const fulfillmentSource = source.slice(fulfillmentStart, fulfillmentEnd);

describe("SalesInvoiceNew digital invoice contract", () => {
  it("يمرر عقد البطاقة المؤكد كاملاً ولا يعيد نسخة سعر وهمية", () => {
    expect(source).toContain("toDigitalPrepareLine(c.digital!)");
    expect(basketSource).toContain("priceVersionId: meta.priceVersionId");
    expect(basketSource).toContain("providerBasketKey: meta.providerBasketKey");
    expect(basketSource).toContain("providerReference: meta.providerReference");
    expect(basketSource).toContain("student: meta.student ?? null");
    expect(source + basketSource).not.toMatch(/priceVersionId:\s*1\b/);
  });

  it("يحفظ كل مثيل بمفتاح UUID ويمنع الآجل والدفع الجزئي والقبض الخارجي قبل الحجز", () => {
    expect(basketSource).toContain("globalThis.crypto.randomUUID()");
    expect(basketSource).toContain('input.paymentTerms === "INSTALLMENT"');
    expect(basketSource).toContain('input.paymentMethod !== "CASH"');
    expect(basketSource).toContain("D(input.paidTotal)).eq(round2(D(input.grandTotal))");
    expect(source).toContain("!hasDigitalItems && state.paymentMethod !== \"CASH\"");
    expect(source).toContain("لم يبدأ النظام أي عملية قبض خارجية");
  });

  it("يرفض خصم الرأس والضريبة والتوصيل عند وجود كرت رقمي", () => {
    expect(basketSource).toContain("D(input.globalDiscount).gt(0)");
    expect(basketSource).toContain("input.taxEnabled && D(input.totalTax).gt(0)");
    expect(basketSource).toContain("input.shippingFree");
    expect(basketSource).toContain("D(input.shipping).gt(0)");
  });

  it("يرفض إهداء السطر الرقمي برسالة تشغيلية واضحة", () => {
    expect(basketSource).toContain("line.isGift === true");
    expect(basketSource).toContain("بيانات «${changed.name}» الرقمية تغيّرت");
  });

  it("يفصل بيانات اعتماد المدير عن sourcePayload الدائم", () => {
    expect(fulfillmentStart).toBeGreaterThan(-1);
    expect(fulfillmentEnd).toBeGreaterThan(fulfillmentStart);
    expect(fulfillmentSource).toContain("const { managerApproval, ...sourcePayload } = payload");
    expect(fulfillmentSource).toContain("sourcePayload,");
    expect(fulfillmentSource).toContain("...(managerApproval ? { managerApproval } : {})");
    expect(fulfillmentSource).not.toMatch(/sourcePayload\s*:\s*\{[^}]*managerApproval/s);
  });

  it("يبقي خصم السطر الرقمي في لقطة الفاتورة", () => {
    expect(source).toContain("discountPercent:");
    expect(source).toContain("discountAmount:");
    expect(source).toContain("unitPriceOverride: round2(D(l.price)).toFixed(2)");
  });
});
