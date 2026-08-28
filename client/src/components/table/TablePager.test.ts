import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TablePager } from "./TablePager";

const baseProps = {
  page: 0,
  onPageChange: () => undefined,
  pageSize: 50,
};

describe("TablePager", () => {
  it("لا يكرر رسالة الجدول الفارغ بلا أدوات", () => {
    const html = renderToStaticMarkup(createElement(TablePager, { ...baseProps, rowsOnPage: 0, total: 0 }));
    expect(html).toBe("");
  });

  it("يبقي أدوات الجدول متاحة عندما تكون الصفحة فارغة", () => {
    const html = renderToStaticMarkup(
      createElement(TablePager, {
        ...baseProps,
        rowsOnPage: 0,
        total: 0,
        actions: createElement("button", { type: "button" }, "الأعمدة"),
      }),
    );
    expect(html).toContain('role="navigation"');
    expect(html).toContain("لا بيانات");
    expect(html).toContain("الأعمدة");
    expect(html).not.toContain("السابق");
    expect(html).not.toContain("التالي");
  });

  it("يعرض ترقيماً متجاوباً ودلالة حالة منفصلة", () => {
    const html = renderToStaticMarkup(createElement(TablePager, { ...baseProps, rowsOnPage: 50, total: 120 }));
    expect(html).toContain('aria-label="ترقيم الصفحات"');
    expect(html).toContain('role="status"');
    expect(html).toContain("flex-wrap");
    expect(html).toContain("السابق");
    expect(html).toContain("التالي");
  });
});
