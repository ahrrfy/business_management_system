import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ProductScanIdentityCard } from "./ProductScanIdentityCard";

describe("ProductScanIdentityCard", () => {
  it("يجمع الاسم والصورة وباركود المسح وSKU في بطاقة تحقق واحدة", () => {
    const html = renderToStaticMarkup(
      createElement(ProductScanIdentityCard, {
        productName: "دفتر جامعي",
        variantName: "أزرق",
        sku: "NOTE-BLUE",
        barcode: "6290000012345",
        imageUrl: "/api/img/count-product/CNT-1/77?v=abc",
        scanned: true,
        actionLabel: "تأكيد المادة",
        onAction: () => undefined,
      }),
    );

    expect(html).toContain("تم التعرّف على المادة");
    expect(html).toContain("دفتر جامعي");
    expect(html).toContain("أزرق");
    expect(html).toContain("6290000012345");
    expect(html).toContain("NOTE-BLUE");
    expect(html).toContain("/api/img/count-product/CNT-1/77?v=abc");
    expect(html).toContain("تأكيد المادة");
    expect(html).toContain('aria-live="polite"');
  });

  it("يعرض بديلاً صريحاً عند غياب الصورة ولا يوهم العامل بصورة مفقودة", () => {
    const html = renderToStaticMarkup(
      createElement(ProductScanIdentityCard, {
        productName: "قلم حبر",
        variantName: null,
        sku: "PEN-1",
        barcode: null,
        imageUrl: null,
      }),
    );

    expect(html).toContain("لا توجد صورة مسجّلة");
    expect(html).toContain("PEN-1");
    expect(html).not.toContain("<img");
  });
});
