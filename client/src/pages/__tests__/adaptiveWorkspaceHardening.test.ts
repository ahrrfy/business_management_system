import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readComponent = (relative: string) =>
  readFileSync(
    new URL(`../../components/${relative}`, import.meta.url),
    "utf8",
  );

describe("عقود تقوية مساحة العمل التشغيلية", () => {
  it("لا يعلن نجاح الطباعة عند حجب نافذة المتصفح", () => {
    const consumers = [
      readPage("Invoices.tsx"),
      readPage("InvoiceDetail.tsx"),
      readPage("POS.tsx"),
      readPage("PrintPOS.tsx"),
      readPage("Reception.tsx"),
      readComponent("reception/ReceptionInvoiceQueue.tsx"),
    ];

    for (const source of consumers) {
      expect(source).toMatch(/!\w+\.ok/u);
      expect(source).toContain("حجب المتصفح نافذة الطباعة");
    }
  });

  it("يبقي عنوان الصفحة دلالياً وفلاتر الفترة قابلة للوصول على الهاتف", () => {
    const toolbar = readComponent("list/ListToolbar.tsx");
    expect(toolbar).toContain("<h1");
    expect(toolbar).toContain("pageTitle = false");
    expect(toolbar).toContain('className="sm:hidden"');
    expect(readPage("Invoices.tsx")).toMatch(/title="المبيعات"\s+pageTitle/u);
    expect(readPage("Purchases.tsx")).toMatch(/title="المشتريات"\s+pageTitle/u);
  });

  it("يوفر خيار الكل الحقيقي لفلاتر المشتريات المبنية على Radix", () => {
    const purchases = readPage("Purchases.tsx");
    expect(purchases.match(/<option value="ALL">/gu)).toHaveLength(3);
    expect(purchases.match(/=== "ALL" \? ""/gu)).toHaveLength(3);
    expect(purchases).not.toContain('<option value="">— كل');
  });
});
