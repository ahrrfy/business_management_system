import { describe, expect, it } from "vitest";
import {
  couponCardsHtml,
  COUPON_CARD_SIZE,
  COUPON_CODE_FIELD_SIZE,
} from "./couponCard";

describe("coupon card printing", () => {
  it("uses the production 54×84 mm page size exactly", async () => {
    const html = await couponCardsHtml([{ code: "CRM-ABCDE-12345", title: "خصم خاص" }]);
    expect(COUPON_CARD_SIZE).toEqual({ widthMm: 54, heightMm: 84 });
    expect(html).toContain("@page{size:54mm 84mm;margin:0}");
    expect(html).toContain("width:54mm;height:84mm");
    expect(html).toContain("CRM-ABCDE-12345");
  });

  it("constrains the human-readable code field to 40×8 mm", async () => {
    const html = await couponCardsHtml([{ code: "CRM-ABCDE-12345" }]);
    expect(COUPON_CODE_FIELD_SIZE).toEqual({ widthMm: 40, heightMm: 8 });
    expect(html).toContain("width:40mm;height:8mm;max-width:40mm;max-height:8mm");
    expect(html).toContain("white-space:nowrap;overflow:hidden");
  });

  it("imposes nine coupons on an exact 3×3 A4 production sheet", async () => {
    const cards = Array.from({ length: 10 }, (_, index) => ({ code: `CRM-${index}` }));
    const html = await couponCardsHtml(cards, { layout: "A4" });
    expect(html).toContain("@page{size:A4 portrait;margin:18.5mm 20mm}");
    expect(html).toContain("grid-template-columns:repeat(3,54mm)");
    expect(html).toContain("grid-template-rows:repeat(3,84mm)");
    expect(html).toContain("gap:4mm");
    expect(html.match(/class="sheet"/g)).toHaveLength(2);
  });

  it("escapes design content before printing", async () => {
    const html = await couponCardsHtml([{ code: "SAFE-1", title: '<img src=x onerror="alert(1)">' }]);
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("formats validity cleanly without duplicating prefix when validTo is omitted", async () => {
    const htmlWithoutDate = await couponCardsHtml([{ code: "OPEN-1" }]);
    expect(htmlWithoutDate).toContain('<div class="valid">صالح حتى نفاد/انتهاء الحملة</div>');
    expect(htmlWithoutDate).not.toContain("صالح لغاية حتى");

    const htmlWithDate = await couponCardsHtml([{ code: "EXPIRE-1", validTo: "2026-12-31" }]);
    expect(htmlWithDate).toContain('<div class="valid">صالح لغاية');
    expect(htmlWithDate).not.toContain("حتى نفاد");
  });

  it("renders discount cap on printed card when specified", async () => {
    const htmlWithCap = await couponCardsHtml([{
      code: "CAP-1",
      heroDiscount: "خصم 20٪",
      discountCap: "سقف التوفير: 25,000 د.ع",
      minSpend: "للطلبات بقيمة 50,000 د.ع فأكثر",
    }]);
    expect(htmlWithCap).toContain('<div class="hero-discount">خصم 20٪</div>');
    expect(htmlWithCap).toContain('<div class="discount-cap">سقف التوفير: 25,000 د.ع</div>');
    expect(htmlWithCap).toContain('<div class="min-spend">للطلبات بقيمة 50,000 د.ع فأكثر</div>');
  });

  it("renders full terms with adaptive sizing without fixed height clipping", async () => {
    const longTerms = "هذا الكوبون يخضع لجميع شروط وضوابط الحملة الترويجية لشركة الرؤية العربية. يُستخدم لمرة واحدة فقط لكل عميل ولا يمكن دمجه مع أي عروض أخرى أو فواتير تعاقدية خاصة.";
    const htmlWithTerms = await couponCardsHtml([{
      code: "TERMS-1",
      terms: longTerms,
    }]);
    expect(htmlWithTerms).toContain(longTerms);
    expect(htmlWithTerms).toContain("font-size:1.25mm");
    expect(htmlWithTerms).not.toContain("max-height:7mm");
  });
});

