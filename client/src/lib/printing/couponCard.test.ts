import { describe, expect, it } from "vitest";
import { couponCardsHtml, COUPON_CARD_SIZE } from "./couponCard";

describe("coupon card printing", () => {
  it("uses the production 54×84 mm page size exactly", async () => {
    const html = await couponCardsHtml([{ code: "CRM-ABCDE-12345", title: "خصم خاص" }]);
    expect(COUPON_CARD_SIZE).toEqual({ widthMm: 54, heightMm: 84 });
    expect(html).toContain("@page{size:54mm 84mm;margin:0}");
    expect(html).toContain("width:54mm;height:84mm");
    expect(html).toContain("CRM-ABCDE-12345");
  });

  it("escapes design content before printing", async () => {
    const html = await couponCardsHtml([{ code: "SAFE-1", title: '<img src=x onerror="alert(1)">' }]);
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
