// محرّك القيود المزدوجة (P1) — اختبارٌ صارم: كل خريطة متوازنة (Σمدين=Σدائن) + الأدوار الصحيحة +
// تطابق تركيب البيع (SALE يَمدين AR بالكامل + PAYMENT_IN يُدائنه بالمدفوع ⇒ صافي AR = الآجل) +
// **الصدق في النطاق:** الحالات المحمَّلة غير المدعومة (مرتجع مورّد/دفع بلا طرف/افتتاحيّ صيرفة/مبلغ سالب) تَرمي.
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
      // لا سطرٌ يحمل مديناً/دائناً سالباً.
      for (const l of lines) { expect(Number(l.debit)).toBeGreaterThanOrEqual(0); expect(Number(l.credit)).toBeGreaterThanOrEqual(0); }
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

  it("قبضٌ نقديّ من عميل: مدين CASH/دائن AR؛ وبطاقةً: مدين CARD_BANK", () => {
    expect(netByRole(postingLinesFor({ entryType: "PAYMENT_IN", amount: "3000", party: "CUSTOMER" })).CASH).toBeCloseTo(3000, 2);
    const card = netByRole(postingLinesFor({ entryType: "PAYMENT_IN", amount: "3000", party: "CUSTOMER", cashRole: "CARD_BANK" }));
    expect(card.CARD_BANK).toBeCloseTo(3000, 2);
    expect(card.AR).toBeCloseTo(-3000, 2);
  });

  it("شراء: مدين المخزون/دائن ذمم المورّد. صرفٌ لمورّد: مدين ذمم المورّد/دائن النقد", () => {
    expect(netByRole(postingLinesFor({ entryType: "PURCHASE", amount: "5000" }))).toMatchObject({ INVENTORY: 5000, AP: -5000 });
    expect(netByRole(postingLinesFor({ entryType: "PAYMENT_OUT", amount: "2000", party: "SUPPLIER" }))).toMatchObject({ AP: 2000, CASH: -2000 });
  });

  it("تطابق تركيب البيع: بيعٌ نقديّ كامل ⇒ صافي AR = 0؛ بيعٌ آجل كامل ⇒ صافي AR = المبلغ", () => {
    const sale = postingLinesFor({ entryType: "SALE", revenue: "10000", cost: "6000", amount: "10000" });
    // نقديّ: PAYMENT_IN بكامل المبلغ من العميل.
    const cashPay = postingLinesFor({ entryType: "PAYMENT_IN", amount: "10000", party: "CUSTOMER" });
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

  it("نوعٌ خارج EntryType أصلاً ⇒ UnmappedEntryTypeError (لا تخمين على النواة المالية)", () => {
    // تحديثُ نطاق (١٢/٨): بعد الدفعة الكاملة صارت أنواع EntryType الـ٣١ كلّها مُخطَّطة، فلم يبقَ
    // نوعٌ حقيقيٌّ يَرمي. الحارس يبقى لما هو **خارج** العقد أصلاً (نوعٌ مُختلَق/مُخطئ).
    expect(() => postingLinesFor({ entryType: "NOT_A_REAL_TYPE", amount: "1000" })).toThrow(UnmappedEntryTypeError);
    expect(MAPPED_ENTRY_TYPES.has("EXCHANGE_DEPOSIT")).toBe(true);
    expect(MAPPED_ENTRY_TYPES.has("SALE")).toBe(true);
  });

  it("الصدق في النطاق: ما بقي غير مدعومٍ يَرمي بدل التخمين الصامت", () => {
    // قبضٌ من مورّد (ردٌّ منه) ⇒ ما زال يَرمي: الطرف المقابل غير محدَّد بلا مُدخلٍ إضافيّ.
    expect(() => postingLinesFor({ entryType: "PAYMENT_IN", amount: "3000", party: "SUPPLIER" })).toThrow(UnmappedEntryTypeError);
    expect(() => postingLinesFor({ entryType: "PAYMENT_IN", amount: "3000" })).toThrow(UnmappedEntryTypeError);
    // رصيد افتتاحيّ بلا طرف عميل/مورّد (صيرفة مثلاً) ⇒ يَرمي (لا افتراض AR صامت).
    expect(() => postingLinesFor({ entryType: "OPENING", amount: "4000" })).toThrow(UnmappedEntryTypeError);
    // مبلغٌ سالبٌ على نوعٍ غير موقَّعٍ ولا مرتجع ⇒ يَرمي (لا مدين/دائن سالب).
    expect(() => postingLinesFor({ entryType: "PURCHASE", amount: "-5000" })).toThrow(UnmappedEntryTypeError);
    expect(() => postingLinesFor({ entryType: "PAYMENT_OUT", amount: "-2000", party: "SUPPLIER" })).toThrow(UnmappedEntryTypeError);
  });

  it("ما صار مُخطَّطاً في الدفعة الكاملة لم يعد يَرمي — وأسطرُه في الحسابات الصحيحة", () => {
    // مرتجع شراء: عكسُ شراءٍ (ذمم موردين مدينة / مخزون دائن) لا عكسُ بيع.
    expect(netByRole(postingLinesFor({ entryType: "RETURN", revenue: "-10000", cost: "-6000", amount: "-10000", party: "SUPPLIER" })))
      .toMatchObject({ AP: 10000, INVENTORY: -10000 });
    // ردُّ عميلٍ نقداً: ذمّته تُدان بالمردود والصندوق يُدائن.
    expect(netByRole(postingLinesFor({ entryType: "PAYMENT_OUT", amount: "2000", party: "CUSTOMER", cashRole: "CASH" })))
      .toMatchObject({ AR: 2000, CASH: -2000 });
    // صرفٌ بلا طرف ⇒ مصروفٌ تشغيليّ.
    expect(netByRole(postingLinesFor({ entryType: "PAYMENT_OUT", amount: "2000", cashRole: "CASH" })))
      .toMatchObject({ OPERATING_EXPENSE: 2000, CASH: -2000 });
  });
});
