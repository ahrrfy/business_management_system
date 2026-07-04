/**
 * وحدات `allocateLineTax` — توزيع ضريبة الفاتورة على السطور تناسبياً + امتصاص فرق التقريب.
 *
 * الثابت الصارم: **Σ الحصص = totalTax بالضبط دائماً** (بلا انجراف سنت واحد)، لجميع مدخلات
 * المستخدم الممكنة. هذا اختبار عرض/تدقيق فقط — الدالة لا تمسّ الخادم ولا `invoiceItems`،
 * منطق الضريبة الفعلي يبقى على مستوى الفاتورة في `computeInvoiceTotals` (server/services/billing.ts).
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { allocateLineTax } from "../totals";

function sumShares(shares: string[]): string {
  return shares
    .reduce((a, s) => a.plus(new Decimal(s)), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

describe("allocateLineTax", () => {
  it("قائمة فارغة ⇒ يُعيد []", () => {
    expect(allocateLineTax([], "100.00", "1000.00")).toEqual([]);
  });

  it("totalTax = 0 ⇒ كل الحصص 0.00", () => {
    const shares = allocateLineTax(
      [{ total: "100.00" }, { total: "200.00" }],
      "0.00",
      "300.00",
    );
    expect(shares).toEqual(["0.00", "0.00"]);
  });

  it("taxableBase = 0 ⇒ كل الحصص 0.00 (حماية من قسمة على صفر)", () => {
    const shares = allocateLineTax(
      [{ total: "100.00" }, { total: "200.00" }],
      "50.00",
      "0.00",
    );
    expect(shares).toEqual(["0.00", "0.00"]);
  });

  it("سطر واحد فقط ⇒ يستوعب totalTax بالكامل", () => {
    const shares = allocateLineTax([{ total: "1000.00" }], "150.00", "1000.00");
    expect(shares).toEqual(["150.00"]);
    expect(sumShares(shares)).toBe("150.00");
  });

  it("توزيع متكافئ بلا كسور (سطران متساويان، ضريبة قابلة للقسمة)", () => {
    const shares = allocateLineTax(
      [{ total: "500.00" }, { total: "500.00" }],
      "100.00",
      "1000.00",
    );
    expect(shares).toEqual(["50.00", "50.00"]);
    expect(sumShares(shares)).toBe("100.00");
  });

  it("توزيع غير متساوٍ يمرّ بلا تقريب حرج (Σ = totalTax)", () => {
    const shares = allocateLineTax(
      [{ total: "1000.00" }, { total: "3333.00" }, { total: "777.00" }],
      "511.00", // 10% من 5110
      "5110.00",
    );
    expect(sumShares(shares)).toBe("511.00");
  });

  it("حالة تقريب حرجة: قسمة تنتج .5 لكلٍّ ⇒ آخر سطر يمتصّ التقريب", () => {
    // 3 سطور × 33.33... = 100 → HALF_UP يعطي 33.33/33.33/33.34 (سنت التقريب على الأخير).
    const shares = allocateLineTax(
      [{ total: "100.00" }, { total: "100.00" }, { total: "100.00" }],
      "100.00",
      "300.00",
    );
    expect(sumShares(shares)).toBe("100.00");
    // آخر سطر يحمل السنت (33.33 * 2 + 33.34 = 100.00)
    const nums = shares.map(Number);
    expect(nums[0]).toBe(33.33);
    expect(nums[1]).toBe(33.33);
    expect(nums[2]).toBe(33.34);
  });

  it("مبالغ يومية عراقية (لا كسور صغيرة): 250/500/1000 د.ع بضريبة 15% تُطابق تماماً", () => {
    // Σ line totals = 1750؛ ضريبة 15% = 262.50؛ توزيع تناسبي كامل بلا تقريب حرج.
    const shares = allocateLineTax(
      [{ total: "250.00" }, { total: "500.00" }, { total: "1000.00" }],
      "262.50",
      "1750.00",
    );
    expect(sumShares(shares)).toBe("262.50");
  });

  it("سطر بمجموع صفر يبقى بحصة 0.00 (لا نُقسم عليه) والباقي يتقاسم الضريبة", () => {
    const shares = allocateLineTax(
      [{ total: "0.00" }, { total: "500.00" }, { total: "500.00" }],
      "100.00",
      "1000.00",
    );
    expect(shares[0]).toBe("0.00");
    expect(sumShares(shares)).toBe("100.00");
  });

  it("كل السطور صفر ⇒ لا سطر يستحقّ التخصيص ⇒ كل الحصص 0.00 (لا NaN)", () => {
    const shares = allocateLineTax(
      [{ total: "0.00" }, { total: "0.00" }],
      "50.00",
      "1.00",
    );
    expect(shares).toEqual(["0.00", "0.00"]);
  });

  it("سطور كثيرة بأرقام قذرة (10 سطور بأسعار عشوائية)، Σ الحصص = totalTax بلا انجراف", () => {
    const items = [
      { total: "127.33" },
      { total: "998.99" },
      { total: "3.14" },
      { total: "2718.28" },
      { total: "159.26" },
      { total: "42.42" },
      { total: "888.88" },
      { total: "1000.01" },
      { total: "731.29" },
      { total: "555.55" },
    ];
    const base = items.reduce((a, i) => a.plus(new Decimal(i.total)), new Decimal(0));
    const tax = base.times(new Decimal("0.075")).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const shares = allocateLineTax(items, tax.toFixed(2), base.toFixed(2));
    expect(sumShares(shares)).toBe(tax.toFixed(2));
  });

  it("مدخلات نصّية غير صالحة تنهار برشاقة (safeD) بلا رمي — تُعامَل كصفر", () => {
    const shares = allocateLineTax(
      [{ total: "abc" }, { total: "1000.00" }],
      "100.00",
      "1000.00",
    );
    // السطر الأوّل «abc» = 0 ⇒ لا حصة له؛ الثاني يستوعب كامل الضريبة.
    expect(shares[0]).toBe("0.00");
    expect(sumShares(shares)).toBe("100.00");
  });
});
