/**
 * تنبيهات الأسعار الذكية (`shared/priceAlerts.ts`) — منطقٌ نقيٌّ بلا قاعدة.
 * يحرس: حدود العتبات (١٪/٥٪/١٥٪)، تخطّي المراجع الصفريّة، الإدخال الفارغ، ودقّة decimal.
 */
import { describe, expect, it } from "vitest";
import { daysSince, evaluateSalePriceAlerts, pickReferenceSale, type SaleRef } from "../priceAlerts";

const ref = (price: string, over: Partial<SaleRef> = {}): SaleRef => ({
  invoiceId: 1,
  invoiceNumber: "INV-1-20260901-00001",
  price,
  discountPercent: "0",
  at: "2026-09-20T09:00:00.000Z",
  ...over,
});

describe("evaluateSalePriceAlerts", () => {
  it("لا تنبيه ما دام السعر المُدخَل فارغاً أو صفراً أو غير مقروء", () => {
    for (const entered of ["", "0", "0.00", "abc", null, undefined]) {
      expect(evaluateSalePriceAlerts({ enteredPrice: entered, lastSales: [ref("1000")] })).toEqual([]);
    }
  });

  it("بلا مبيعات سابقة ⇒ «لم يشترِ سابقاً» معلومة", () => {
    expect(evaluateSalePriceAlerts({ enteredPrice: "1000", lastSales: [] })).toEqual([
      { code: "FIRST_TIME", severity: "info" },
    ]);
  });

  it("المراجع الصفريّة فقط (بيع مجّانيّ) تُعامَل كأنْ لا مرجع", () => {
    expect(evaluateSalePriceAlerts({ enteredPrice: "1000", lastSales: [ref("0")] })).toEqual([
      { code: "FIRST_TIME", severity: "info" },
    ]);
  });

  it("نفس السعر (فرق <١٪) ⇒ good", () => {
    const [a] = evaluateSalePriceAlerts({ enteredPrice: "1005", lastSales: [ref("1000")] });
    expect(a).toMatchObject({ code: "SAME_AS_LAST", severity: "good", deltaPercent: "0.0" });
  });

  it("حدّ ١٪ بالضبط يخرج من «نفس السعر»", () => {
    const [up] = evaluateSalePriceAlerts({ enteredPrice: "1010", lastSales: [ref("1000")] });
    expect(up).toMatchObject({ code: "ABOVE_LAST_SALE", severity: "info", deltaPercent: "1.0" });
    const [down] = evaluateSalePriceAlerts({ enteredPrice: "990", lastSales: [ref("1000")] });
    expect(down).toMatchObject({ code: "BELOW_LAST_SALE", severity: "info", deltaPercent: "-1.0" });
  });

  it("الارتفاع معلومة دائماً مهما كبر", () => {
    const [a] = evaluateSalePriceAlerts({ enteredPrice: "5000", lastSales: [ref("1000")] });
    expect(a).toMatchObject({ code: "ABOVE_LAST_SALE", severity: "info", deltaPercent: "400.0" });
  });

  it("النزول: <٥٪ info، ≥٥٪ warn، ≥١٥٪ danger (عند الحدود بالضبط)", () => {
    const sev = (entered: string) =>
      evaluateSalePriceAlerts({ enteredPrice: entered, lastSales: [ref("1000")] })[0]?.severity;
    expect(sev("951")).toBe("info"); // -4.9%
    expect(sev("950")).toBe("warn"); // -5.0%
    expect(sev("851")).toBe("warn"); // -14.9%
    expect(sev("850")).toBe("danger"); // -15.0%
  });

  it("يقارن بأحدث مرجعٍ صالح لا بالأقدم", () => {
    const [a] = evaluateSalePriceAlerts({
      enteredPrice: "900",
      lastSales: [ref("0", { invoiceId: 3 }), ref("1000", { invoiceId: 2 }), ref("500", { invoiceId: 1 })],
    });
    expect(a?.reference?.invoiceId).toBe(2);
    expect(a?.deltaPercent).toBe("-10.0");
  });

  it("decimal دقيق بلا انجراف عائم (0.1+0.2) وأسعارٌ كبيرة", () => {
    const [a] = evaluateSalePriceAlerts({ enteredPrice: "1234567.89", lastSales: [ref("1234567.89")] });
    expect(a).toMatchObject({ code: "SAME_AS_LAST", deltaPercent: "0.0" });
    const [b] = evaluateSalePriceAlerts({ enteredPrice: "0.30", lastSales: [ref("0.10")] });
    expect(b).toMatchObject({ code: "ABOVE_LAST_SALE", deltaPercent: "200.0" });
  });
});

describe("pickReferenceSale / daysSince", () => {
  it("قائمة فارغة أو أسعار غير مقروءة ⇒ null", () => {
    expect(pickReferenceSale([])).toBeNull();
    expect(pickReferenceSale([ref("x"), ref("")])).toBeNull();
  });

  it("daysSince: أيامٌ كاملة، ولا تذهب سالبةً، وتاريخٌ تالف ⇒ null", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    expect(daysSince("2026-09-23T12:00:00.000Z", now)).toBe(12);
    expect(daysSince("2026-10-06T12:00:00.000Z", now)).toBe(0);
    expect(daysSince("garbage", now)).toBeNull();
  });
});
