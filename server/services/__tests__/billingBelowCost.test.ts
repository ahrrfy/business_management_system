import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { isInvoiceBelowCost } from "../billing";

/**
 * SALES-01/02 — اختبار وحدة نقي (بلا قاعدة بيانات) لبوّابة البيع تحت التكلفة.
 * المنطق مشترك بين saleService و printSaleService عبر billing.isInvoiceBelowCost،
 * فاختباره هنا يُغطّي القناتين معاً ويُثبت سدّ: سعر صفر (SALES-01)، خصم ١٠٠٪ (SALES-02)،
 * وخصم فاتورة يَنزل بالصافي تحت COGS — مع إبقاء الهدايا (تكلفة=صفر) والبيع فوق التكلفة مسموحاً.
 */
describe("isInvoiceBelowCost (SALES-01/02 below-cost gate)", () => {
  const L = (total: string, unitCost: string, baseQuantity: number) => ({ total, unitCost, baseQuantity });

  it("بيع فوق التكلفة ⇒ false (لا حاجة لموافقة)", () => {
    expect(isInvoiceBelowCost([L("10.00", "4.00", 1)], "10.00", "0.00", "4.00")).toBe(false);
  });

  it("سعر بند صفر مع تكلفة>0 ⇒ true (SALES-01)", () => {
    expect(isInvoiceBelowCost([L("0.00", "4.00", 1)], "0.00", "0.00", "4.00")).toBe(true);
  });

  it("خصم بند ١٠٠٪ (الإجمالي صفر) مع تكلفة>0 ⇒ true (SALES-02)", () => {
    // computeLineTotal يُنتج total=0 عند خصم ١٠٠٪؛ نُحاكيه هنا.
    expect(isInvoiceBelowCost([L("0.00", "5.00", 2)], "0.00", "0.00", "10.00")).toBe(true);
  });

  it("هدية: تكلفة=صفر وسعر=صفر ⇒ false (مسموح)", () => {
    expect(isInvoiceBelowCost([L("0.00", "0.00", 1)], "0.00", "0.00", "0.00")).toBe(false);
  });

  it("بيع عند التكلفة بالضبط ⇒ false (المقارنة صارمة lt)", () => {
    expect(isInvoiceBelowCost([L("4.00", "4.00", 1)], "4.00", "0.00", "4.00")).toBe(false);
  });

  it("بنود فوق التكلفة فُرادى لكن خصم الفاتورة يُنزل الصافي تحت COGS ⇒ true", () => {
    // سطران 10.00 (تكلفة 4 لكلٍّ) = صافي بنود 20؛ خصم فاتورة 15 ⇒ إيراد 5 < COGS 8.
    const lines = [L("10.00", "4.00", 1), L("10.00", "4.00", 1)];
    expect(isInvoiceBelowCost(lines, "20.00", "15.00", "8.00")).toBe(true);
  });

  it("كمية الأساس متعددة الوحدات: تكلفة السطر = unitCost×baseQuantity", () => {
    // درزن (١٢) بسعر 100 وتكلفة وحدة 4 ⇒ تكلفة السطر 48 ⇒ 100≥48 ⇒ false.
    expect(isInvoiceBelowCost([L("100.00", "4.00", 12)], "100.00", "0.00", "48.00")).toBe(false);
    // نفس الدرزن لكن بِيع بـ40 ⇒ 40 < 48 ⇒ true.
    expect(isInvoiceBelowCost([L("40.00", "4.00", 12)], "40.00", "0.00", "48.00")).toBe(true);
  });

  it("يَقبل costTotal كـDecimal (اتحاد string | Decimal لقناة الطباعة)", () => {
    expect(isInvoiceBelowCost([L("100.00", "4.00", 1)], "100.00", "0.00", new Decimal("4.00"))).toBe(false);
    expect(isInvoiceBelowCost([L("3.00", "4.00", 1)], "3.00", "0.00", new Decimal("4.00"))).toBe(true);
  });
});
