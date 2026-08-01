import { describe, expect, it } from "vitest";
import { wrapA4Doc } from "./docHtml";

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
