import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

const filterLabels = (source: string) =>
  Array.from(source.matchAll(/<FilterField label="([^"]+)"/g), (match) => match[1]);

describe("FilterField coverage for the remaining list screens", () => {
  it.each([
    [
      "Vouchers.tsx",
      ["النوع", "الطرف", "طريقة الدفع", "الاعتماد", "حالة السند", "الفرع", "الفئة", "من تاريخ", "إلى تاريخ", "بحث (رقم/وصف/اسم مُستفيد)"],
    ],
    ["SalesReturns.tsx", ["العميل", "الفرع", "منفّذ المرتجع", "من تاريخ", "إلى تاريخ"]],
    ["Quotations.tsx", ["من تاريخ", "إلى تاريخ", "الحالة", "الفرع"]],
    // The branch selector (admin) and read-only branch scope (other roles) are
    // runtime-exclusive, but both source branches must retain an explicit caption.
    ["Products.tsx", ["الفرع (للمخزون)", "الفرع (للمخزون)", "الفئة"]],
  ])("keeps an explicit caption above every structured filter in %s", (page, labels) => {
    expect(filterLabels(readPage(page as string))).toEqual(labels);
  });

  it("keeps the products inactive toggle visibly labelled beside its checkbox", () => {
    expect(readPage("Products.tsx")).toContain("<span className=\"text-muted-foreground\">إظهار المعطّل</span>");
  });
});
