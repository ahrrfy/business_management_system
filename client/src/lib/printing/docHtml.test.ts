import { describe, expect, it } from "vitest";
import { wrapA4Doc, wrapMultiA4Doc } from "./docHtml";

describe("wrapA4Doc", () => {
  it("يدعم التقرير الأفقي مع بقاء قواعد الجداول متعددة الصفحات", () => {
    const html = wrapA4Doc("تقرير", "<table><thead><tr><th>رأس</th></tr></thead></table>", {
      orientation: "landscape",
    });

    expect(html).toContain("@page{size:A4 landscape;margin:0}");
    expect(html).toContain("width:1123px;min-height:794px");
    expect(html).toContain("thead{display:table-header-group}");
    expect(html).toContain("tr,td,th{page-break-inside:avoid;break-inside:avoid}");
  });
});

describe("wrapMultiA4Doc", () => {
  it("يدعم دمج صفحات A4 متعددة مع فواصل الصفحات وأزرار شريط الأدوات", () => {
    const pages = ["<div>صفحة 1</div>", "<div>صفحة 2</div>"];
    const html = wrapMultiA4Doc("قسائم الرواتب", pages, {
      badgeLabel: "مسيّر رواتب 2026-09",
    });

    expect(html).toContain("قسائم الرواتب");
    expect(html).toContain("مسيّر رواتب 2026-09");
    expect(html).toContain('data-page-index="1"');
    expect(html).toContain('data-page-index="2"');
    expect(html).toContain("page-break-after:always !important");
    expect(html).toContain("حفظ كملف PDF");
    expect(html).toContain("طباعة المستند");
  });
});

