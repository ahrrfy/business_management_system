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
    expect(source).toContain("priceVersionId: c.digital!.priceVersionId");
    expect(source).toContain("providerBasketKey: c.digital!.providerBasketKey");
    expect(source).toContain("providerReference: c.digital!.providerReference");
    expect(source).toContain("student: c.digital!.student ?? null");
    expect(source).not.toMatch(/priceVersionId:\s*1\b/);
  });

  it("يحفظ كل مثيل بمفتاح UUID ويمنع الآجل والدفع الجزئي والقبض الخارجي قبل الحجز", () => {
    expect(source).toContain("internalLineToken: crypto.randomUUID()");
    expect(source).toContain('state.paymentTerms !== "CASH"');
    expect(source).toContain('state.paymentMethod !== "CASH"');
    expect(source).toContain("!D(computePaidStr()).eq(D(totals.grandTotal))");
    expect(source).toContain("!hasDigitalItems && state.paymentMethod !== \"CASH\"");
    expect(source).toContain("لم يبدأ النظام أي عملية قبض خارجية");
  });

  it("يرفض خصم الرأس والضريبة والتوصيل عند وجود كرت رقمي", () => {
    expect(source).toContain("D(totals.globalDiscAmt).gt(0)");
    expect(source).toContain('(state.taxEnabled && D(state.taxRatePercent || "0").gt(0))');
    expect(source).toContain("state.shippingFree");
    expect(source).toContain("D(totals.shipping).gt(0)");
    expect(source).toContain(
      "لا تجمع الكروت الرقمية مع خصم رأس الفاتورة أو الضريبة أو التوصيل؛ افصلها في فاتورة مستقلة حتى يبقى كل استرداد دقيقاً.",
    );
  });

  it("يرفض إهداء السطر الرقمي برسالة تشغيلية واضحة", () => {
    expect(source).toContain("line.digital != null && line.isGift");
    expect(source).toContain(
      "لا يمكن إهداء كرت رقمي صادر؛ استخدم خصماً صريحاً ضمن الصلاحية أو افصل قرار الإهداء بمسار إداري.",
    );
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
