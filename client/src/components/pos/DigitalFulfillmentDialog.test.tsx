import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialog = readFileSync(new URL("./DigitalFulfillmentDialog.tsx", import.meta.url), "utf8");
const pos = readFileSync(new URL("../../pages/POS.tsx", import.meta.url), "utf8");
const reception = readFileSync(new URL("../../pages/Reception.tsx", import.meta.url), "utf8");
const advancedInvoice = readFileSync(new URL("../../pages/SalesInvoiceNew.tsx", import.meta.url), "utf8");
const digitalBasket = readFileSync(new URL("./digitalBasket.ts", import.meta.url), "utf8");
const trpc = readFileSync(new URL("../../../../server/trpc.ts", import.meta.url), "utf8");

describe("نافذة تنفيذ الكروت — سبب فشل التثبيت الحقيقي لا «تعذّر الاتصال» دائماً", () => {
  it("تقبل finalizeError وتعرضه بدل النصّ الثابت حين موجود", () => {
    expect(dialog).toContain("finalizeError?: string | null");
    expect(dialog).toContain("finalizeError ? (");
    expect(dialog).toContain("{finalizeError}");
  });

  it("لا يُتّهم تعذّر الاتصال حين السبب الحقيقي معروف ومعروض", () => {
    expect(dialog).toContain('"أعد محاولة تثبيت الفاتورة"');
    expect(dialog).toContain('"إعادة محاولة تثبيت الفاتورة عند تعذّر الاتصال"');
  });

  it("POS.tsx يمرّر خطأ finalizeSale الفعلي إلى النافذة بدل إسقاطه صامتاً", () => {
    expect(pos).toContain("finalizeError={finalizeSale.error ? errMsg(finalizeSale.error) : null}");
  });

  it("يعرض صافي السطر المحصّل بعد الخصم لا سعر القائمة", () => {
    expect(dialog).toContain("sum.plus(item.chargeAmount)");
    expect(dialog).toContain("الصافي المحصّل {fmtAr(item.chargeAmount)}");
    expect(dialog).toContain("الصافي المحصّل {fmtAr(it.chargeAmount)}");
  });

  it("يمنع POS من قبض CARD لسلة رقمية قبل إنشاء النية والحجز", () => {
    expect(pos).toContain('if (activeTab.method !== "CASH")');
    expect(pos).toContain("لم يبدأ النظام أي قبض خارجي");
    expect(pos).toContain('!(cartHasDigital && activeTab.method !== "CASH")');
  });
});

describe("تكامل بيع الكروت — الاستقبال والفاتورة المتقدمة", () => {
  it("تسمح بوابة البيع الرقمي لمحطتي التجزئة والاستقبال وتبقي الطباعة محجوبة", () => {
    expect(trpc).toContain("canUseDigitalCardsSellingStation");
    expect(trpc).not.toContain("requireDigitalCardsRetailStation");
  });

  it("ترسل الفاتورة المتقدمة إصدار السعر الحقيقي ومرجع سلة المزوّد", () => {
    expect(advancedInvoice).not.toContain("priceVersionId: 1");
    expect(advancedInvoice).toContain("captureDigitalInvoiceBasketItems(basket)");
    expect(advancedInvoice).toContain("toDigitalPrepareLine(c.digital!)");
    expect(digitalBasket).toContain("captureDigitalBasketLines(basket)");
  });

  it("يحفظ الاستقبال بيانات الكرت ويجهّز نيّة RECEPTION قبل التثبيت", () => {
    expect(reception).toContain('sourceType: "RECEPTION"');
    expect(reception).toContain("toDigitalPrepareLine");
    expect(reception).toContain("captureDigitalReceptionCartLines(basket, branchId)");
    expect(digitalBasket).toContain("digital,");
  });
});
