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
    expect(html).not.toContain("باركود أساسي");
    expect(html).not.toContain("باركود بديل");
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

  it("يوضح مطابقة الباركود الأساسي والوحدة الممسوحة بلا تفاصيل زائدة لوحدة الأساس", () => {
    const html = renderToStaticMarkup(
      createElement(ProductScanIdentityCard, {
        productName: "قلم حبر",
        sku: "PEN-1",
        scanned: true,
        scanMatch: {
          kind: "PRIMARY",
          scannedBarcode: "6290000000001",
          primaryBarcode: "6290000000001",
          unitName: "قطعة",
          factor: 1,
        },
      }),
    );

    expect(html).toContain("باركود أساسي");
    expect(html).toContain("الوحدة الممسوحة");
    expect(html).toContain("قطعة");
    expect(html).toContain("6290000000001");
    expect(html).not.toContain("من وحدة الأساس");
    expect(html).not.toContain("الباركود الأساسي للوحدة");
  });

  it("يميّز الباركود البديل ويعرض الوحدة ومعاملها والباركود الأساسي المختلف", () => {
    const html = renderToStaticMarkup(
      createElement(ProductScanIdentityCard, {
        productName: "دفتر جامعي",
        variantName: "أزرق",
        sku: "NOTE-BLUE",
        scanned: true,
        scanMatch: {
          kind: "ALIAS",
          scannedBarcode: "ALIAS-12",
          primaryBarcode: "6290000012345",
          unitName: "كرتون",
          factor: 12,
        },
      }),
    );

    expect(html).toContain("باركود بديل");
    expect(html).toContain("الباركود الممسوح");
    expect(html).toContain("الوحدة الممسوحة");
    expect(html).toContain("كرتون");
    expect(html).toContain("× 12 من وحدة الأساس");
    expect(html).toContain("ALIAS-12");
    expect(html).toContain("الباركود الأساسي للوحدة");
    expect(html).toContain("6290000012345");
    expect(html).toContain('aria-label="تفاصيل مطابقة الباركود"');
  });

  it("لا يكرر الباركود الأساسي في حقل مستقل إذا ساوى الممسوح", () => {
    const html = renderToStaticMarkup(
      createElement(ProductScanIdentityCard, {
        productName: "ورق تصوير",
        sku: "PAPER-A4",
        scanMatch: {
          kind: "ALIAS",
          scannedBarcode: "SAME-CODE",
          primaryBarcode: "SAME-CODE",
          unitName: "رزمة",
          factor: 5,
        },
      }),
    );

    expect(html).toContain("باركود بديل");
    expect(html).not.toContain("الباركود الأساسي للوحدة");
  });
});
