// محرّك القيود المزدوجة (P1) — اختبارٌ صارم: كل خريطة متوازنة (Σمدين=Σدائن) + الأدوار الصحيحة +
// تطابق تركيب البيع (SALE يَمدين AR بالكامل + PAYMENT_IN يُدائنه بالمدفوع ⇒ صافي AR = الآجل).
import { describe, expect, it } from "vitest";
import {
  MAPPED_ENTRY_TYPES,
  UnmappedEntryTypeError,
  assertBalanced,
  postingLinesFor,
  type JournalLine,
} from "../accounting/postingEngine";

/** صافي (مدين − دائن) لكل دور — لفحص الأثر الصافي على الحسابات. */
function netByRole(lines: JournalLine[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const l of lines) net[l.role] = (net[l.role] ?? 0) + Number(l.debit) - Number(l.credit);
  return net;
}
function sum(lines: JournalLine[], key: "debit" | "credit"): number {
  return lines.reduce((a, l) => a + Number(l[key]), 0);
}

describe("محرّك القيود المزدوجة (P1) — التوازن والأدوار", () => {
  it("كل خريطةٍ مُخطَّطة متوازنة (Σمدين=Σدائن)", () => {
    const cases = [
      { entryType: "SALE", revenue: "10000", cost: "6000", amount: "10000" },
      { entryType: "RETURN", revenue: "-10000", cost: "-6000", amount: "-10000" },
      { entryType: "PURCHASE", amount: "5000" },
      { entryType: "PAYMENT_IN", amount: "3000", party: "CUSTOMER" as const },
      { entryType: "PAYMENT_OUT", amount: "2000", party: "SUPPLIER" as const },
      { entryType: "OPENING", amount: "4000", party: "CUSTOMER" as const },
      { entryType: "OPENING", amount: "4000", party: "SUPPLIER" as const },
      { entryType: "OPENING", amount: "-1000", party: "CUSTOMER" as const },
    ];
    for (const c of cases) {
      const lines = postingLinesFor(c);
      expect(sum(lines, "debit")).toBeCloseTo(sum(lines, "credit"), 2);
      expect(() => assertBalanced(lines, c.entryType)).not.toThrow();
    }
  });

  it("بيع (بلا ضريبة): مدين AR 10000، دائن المبيعات 10000، مدين تكلفة 6000/دائن مخزون 6000", () => {
    const net = netByRole(postingLinesFor({ entryType: "SALE", revenue: "10000", cost: "6000", amount: "10000" }));
    expect(net.AR).toBeCloseTo(10000, 2);
    expect(net.SALES_STATIONERY).toBeCloseTo(-10000, 2); // دائن
    expect(net.COGS).toBeCloseTo(6000, 2);
    expect(net.INVENTORY).toBeCloseTo(-6000, 2); // دائن
  });

  it("بيع بضريبة: الفرق (الإجمالي − الإيراد) يُدائن التزاماً فيبقى التوازن", () => {
    const lines = postingLinesFor({ entryType: "SALE", revenue: "10000", cost: "6000", amount: "11000", taxAmount: "1000" });
    const net = netByRole(lines);
    expect(net.AR).toBeCloseTo(11000, 2);
    expect(net.SALES_STATIONERY).toBeCloseTo(-10000, 2);
    expect(net.OTHER_LIABILITY).toBeCloseTo(-1000, 2);
    expect(sum(lines, "debit")).toBeCloseTo(sum(lines, "credit"), 2);
  });

  it("قطاع البيع يوجَّه لحساب المبيعات الصحيح (salesRole)", () => {
    const net = netByRole(postingLinesFor({ entryType: "SALE", revenue: "5000", cost: "0", amount: "5000", salesRole: "SALES_PRINT" }));
    expect(net.SALES_PRINT).toBeCloseTo(-5000, 2);
  });

  it("مرتجع بيع = عكس البيع بالضبط (نفس الأدوار باتجاهٍ معاكس)", () => {
    const sale = netByRole(postingLinesFor({ entryType: "SALE", revenue: "10000", cost: "6000", amount: "10000" }));
    const ret = netByRole(postingLinesFor({ entryType: "RETURN", revenue: "-10000", cost: "-6000", amount: "-10000" }));
    for (const role of Object.keys(sale)) expect(ret[role]).toBeCloseTo(-sale[role], 2);
  });

  it("قبضٌ نقديّ: مدين CASH/دائن AR؛ وبطاقةً: مدين CARD_BANK", () => {
    expect(netByRole(postingLinesFor({ entryType: "PAYMENT_IN", amount: "3000" })).CASH).toBeCloseTo(3000, 2);
    const card = netByRole(postingLinesFor({ entryType: "PAYMENT_IN", amount: "3000", cashRole: "CARD_BANK" }));
    expect(card.CARD_BANK).toBeCloseTo(3000, 2);
    expect(card.AR).toBeCloseTo(-3000, 2);
  });

  it("شراء: مدين المخزون/دائن ذمم المورّد. صرفٌ: مدين ذمم المورّد/دائن النقد", () => {
    expect(netByRole(postingLinesFor({ entryType: "PURCHASE", amount: "5000" }))).toMatchObject({ INVENTORY: 5000, AP: -5000 });
    expect(netByRole(postingLinesFor({ entryType: "PAYMENT_OUT", amount: "2000" }))).toMatchObject({ AP: 2000, CASH: -2000 });
  });

  it("تطابق تركيب البيع: بيعٌ نقديّ كامل ⇒ صافي AR = 0؛ بيعٌ آجل كامل ⇒ صافي AR = المبلغ", () => {
    const sale = postingLinesFor({ entryType: "SALE", revenue: "10000", cost: "6000", amount: "10000" });
    // نقديّ: PAYMENT_IN بكامل المبلغ.
    const cashPay = postingLinesFor({ entryType: "PAYMENT_IN", amount: "10000" });
    const cashCombined = netByRole([...sale, ...cashPay]);
    expect(cashCombined.AR).toBeCloseTo(0, 2); // صافي ذمّة العميل صفر (نقديّ)
    expect(cashCombined.CASH).toBeCloseTo(10000, 2);
    // آجل: بلا قبض.
    expect(netByRole(sale).AR).toBeCloseTo(10000, 2);
  });

  it("رصيد افتتاحيّ: عميل موجب=AR مدين؛ مورّد موجب=AP دائن؛ عميل سالب يعكس", () => {
    expect(netByRole(postingLinesFor({ entryType: "OPENING", amount: "4000", party: "CUSTOMER" }))).toMatchObject({ AR: 4000, OPENING_EQUITY: -4000 });
    expect(netByRole(postingLinesFor({ entryType: "OPENING", amount: "4000", party: "SUPPLIER" }))).toMatchObject({ AP: -4000, OPENING_EQUITY: 4000 });
    expect(netByRole(postingLinesFor({ entryType: "OPENING", amount: "-1000", party: "CUSTOMER" }))).toMatchObject({ AR: -1000, OPENING_EQUITY: 1000 });
  });

  it("نوعٌ غير مُخطَّطٍ بعد ⇒ UnmappedEntryTypeError (لا تخمين على النواة المالية)", () => {
    expect(() => postingLinesFor({ entryType: "EXCHANGE_DEPOSIT", amount: "1000" })).toThrow(UnmappedEntryTypeError);
    expect(MAPPED_ENTRY_TYPES.has("EXCHANGE_DEPOSIT")).toBe(false);
    expect(MAPPED_ENTRY_TYPES.has("SALE")).toBe(true);
  });
});
