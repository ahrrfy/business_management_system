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
      readComponent("reception/ReceptionOfflineCapture.tsx"),
      readComponent("reception/ReceptionInvoiceQueue.tsx"),
    ];

    for (const source of consumers) {
      expect(source).toMatch(/!\w+\.ok/u);
      expect(source).toContain("حجب المتصفح نافذة الطباعة");
    }
    const reception = readPage("Reception.tsx");
    expect(reception).toContain(
      'from "@/components/reception/ReceptionOfflineCapture"',
    );
    expect(reception).toMatch(/return ReceptionOfflineCapture\(\{/u);
    expect(reception).toContain(
      'from "@/components/reception/presentReceptionCheckout"',
    );
    expect(reception).toMatch(/await presentReceptionCheckout\(\{/u);
    const checkout = readComponent("reception/presentReceptionCheckout.tsx");
    expect(checkout).toMatch(/if \(!result\.ok\) printFailures \+= 1/u);
    expect(checkout).toMatch(
      /printFailures > 0[\s\S]*تم الحفظ، لكن تعذّرت طباعة/u,
    );
    expect(checkout).toMatch(/setLastSale\(\{[\s\S]*printFailures,/u);
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
