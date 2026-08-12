/**
 * الدفعة الكاملة لخرائط القيود (١٢/٨) — كل أنواع EntryType الـ٣١ صارت مُخطَّطة.
 *
 * الثابت الحاكم المُختبَر أوّلاً وأخيراً: **Σمدين = Σدائن لكل نوعٍ بلا استثناء**. خريطةٌ غير
 * متوازنة تعني ميزان مراجعةٍ لا يُقفل — وهو العطل الوحيد الذي لا يُغتفَر في دفترٍ مزدوج.
 *
 * ويُختبَر بعدها ما لا يلتقطه التوازن: أن يقف كل مبلغٍ في **الحساب الصحيح**. أخطرها تحصيل
 * المندوب (النقد ليس عندنا) وفروق الصرف الموقَّعة (الاتجاه ينقلب بالإشارة).
 */
import { describe, expect, it } from "vitest";
import { CHART_ACCOUNTS } from "../accounting/chartSeed";
import {
  assertBalanced,
  MAPPED_ENTRY_TYPES,
  postingLinesFor,
  type AccountRole,
  type PostingInput,
} from "../accounting/postingEngine";

/** كل أنواع EntryType (ledgerService.ts) — مصدر الحقيقة لتغطية التخطيط. */
const ALL_ENTRY_TYPES = [
  "SALE", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "RETURN", "ADJUST", "OPENING",
  "INTERNAL_USE", "WASTAGE",
  "CASH_HANDOVER", "CASH_TRANSFER_OUT", "CASH_TRANSFER_IN", "SHIFT_FLOAT_OUT", "TREASURY_FUNDING",
  "DELIVERY_DISPATCH", "DELIVERY_REMIT", "DELIVERY_FEE", "DELIVERY_WRITEOFF",
  "EXCHANGE_DEPOSIT", "EXCHANGE_WITHDRAW", "EXCHANGE_FX_BUY", "EXCHANGE_SETTLE",
  "EXCHANGE_FEE", "EXCHANGE_FX_DIFF",
  "GIFT_OUT",
  "DIGITAL_WALLET_DEPOSIT", "DIGITAL_WALLET_WITHDRAWAL", "DIGITAL_WALLET_CONSUMPTION",
  "DIGITAL_WALLET_REVERSAL", "DIGITAL_WALLET_ADJUSTMENT", "DIGITAL_WRITEOFF",
] as const;

/** مُدخلٌ صالحٌ لكل نوع (الطرف/القيم التي يحملها الصفّ فعلاً في النظام). */
const SAMPLES: Record<string, PostingInput> = {
  SALE: { entryType: "SALE", amount: "100", revenue: "100", cost: "60" },
  PURCHASE: { entryType: "PURCHASE", amount: "100" },
  PAYMENT_IN: { entryType: "PAYMENT_IN", amount: "50", party: "CUSTOMER", cashRole: "CASH" },
  PAYMENT_OUT: { entryType: "PAYMENT_OUT", amount: "50", party: "SUPPLIER", cashRole: "CASH" },
  RETURN: { entryType: "RETURN", amount: "-40", revenue: "-40", cost: "-25", party: "CUSTOMER" },
  ADJUST: { entryType: "ADJUST", amount: "150" },
  OPENING: { entryType: "OPENING", amount: "500", party: "CUSTOMER" },
  INTERNAL_USE: { entryType: "INTERNAL_USE", cost: "30" },
  WASTAGE: { entryType: "WASTAGE", cost: "20" },
  CASH_HANDOVER: { entryType: "CASH_HANDOVER", amount: "200" },
  CASH_TRANSFER_OUT: { entryType: "CASH_TRANSFER_OUT", amount: "200" },
  CASH_TRANSFER_IN: { entryType: "CASH_TRANSFER_IN", amount: "200" },
  SHIFT_FLOAT_OUT: { entryType: "SHIFT_FLOAT_OUT", amount: "100" },
  TREASURY_FUNDING: { entryType: "TREASURY_FUNDING", amount: "1000" },
  DELIVERY_DISPATCH: { entryType: "DELIVERY_DISPATCH", amount: "80" },
  DELIVERY_REMIT: { entryType: "DELIVERY_REMIT", amount: "80" },
  DELIVERY_FEE: { entryType: "DELIVERY_FEE", amount: "5", cost: "5" },
  DELIVERY_WRITEOFF: { entryType: "DELIVERY_WRITEOFF", amount: "10", cost: "10" },
  EXCHANGE_DEPOSIT: { entryType: "EXCHANGE_DEPOSIT", amount: "300" },
  EXCHANGE_WITHDRAW: { entryType: "EXCHANGE_WITHDRAW", amount: "300" },
  EXCHANGE_FX_BUY: { entryType: "EXCHANGE_FX_BUY", amount: "300" },
  EXCHANGE_SETTLE: { entryType: "EXCHANGE_SETTLE", amount: "300" },
  EXCHANGE_FEE: { entryType: "EXCHANGE_FEE", amount: "7" },
  EXCHANGE_FX_DIFF: { entryType: "EXCHANGE_FX_DIFF", amount: "12" },
  GIFT_OUT: { entryType: "GIFT_OUT", cost: "15" },
  DIGITAL_WALLET_DEPOSIT: { entryType: "DIGITAL_WALLET_DEPOSIT", amount: "400" },
  DIGITAL_WALLET_WITHDRAWAL: { entryType: "DIGITAL_WALLET_WITHDRAWAL", amount: "400" },
  DIGITAL_WALLET_CONSUMPTION: { entryType: "DIGITAL_WALLET_CONSUMPTION", amount: "90" },
  DIGITAL_WALLET_REVERSAL: { entryType: "DIGITAL_WALLET_REVERSAL", amount: "90" },
  DIGITAL_WALLET_ADJUSTMENT: { entryType: "DIGITAL_WALLET_ADJUSTMENT", amount: "-3" },
  DIGITAL_WRITEOFF: { entryType: "DIGITAL_WRITEOFF", cost: "6" },
};

const sum = (lines: { debit: string; credit: string }[], k: "debit" | "credit") =>
  lines.reduce((a, l) => a + Number(l[k]), 0);
const roleOf = (lines: { role: string; debit: string; credit: string }[], role: string) =>
  lines.find((l) => l.role === role);

describe("خرائط القيود — الدفعة الكاملة (٣١ نوعاً)", () => {
  it("تغطية: كل نوعٍ في EntryType مُخطَّط — لا فجوةَ نوعٍ باقية", () => {
    const missing = ALL_ENTRY_TYPES.filter((t) => !MAPPED_ENTRY_TYPES.has(t));
    expect(missing).toEqual([]);
    expect(MAPPED_ENTRY_TYPES.size).toBe(ALL_ENTRY_TYPES.length);
  });

  /** أنواعٌ لا قيدَ لها **عمداً** (قرار محاسبيّ، لا عجز) — تُعيد صفر أسطر فتُسجَّل NO_ENTRY. */
  const NO_ENTRY_TYPES = new Set(["DELIVERY_DISPATCH"]);

  it.each(ALL_ENTRY_TYPES)("%s ⇒ قيدٌ متوازن بأسطرٍ غير سالبة", (type) => {
    const lines = postingLinesFor(SAMPLES[type]);
    if (NO_ENTRY_TYPES.has(type)) {
      expect(lines).toEqual([]);
      return;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(sum(lines, "debit")).toBeCloseTo(sum(lines, "credit"), 2);
    for (const l of lines) {
      expect(Number(l.debit)).toBeGreaterThanOrEqual(0);
      expect(Number(l.credit)).toBeGreaterThanOrEqual(0);
      expect(Number(l.debit) === 0 || Number(l.credit) === 0).toBe(true); // أحدهما صفر دائماً
    }
    expect(() => assertBalanced(lines, type)).not.toThrow();
  });

  it("كل دورٍ تستعمله الخرائط له حسابٌ في الشجرة — لا سطرَ بلا حساب", () => {
    const seeded = new Set(CHART_ACCOUNTS.map((a) => a.systemRole).filter(Boolean));
    const used = new Set<string>();
    for (const t of ALL_ENTRY_TYPES) for (const l of postingLinesFor(SAMPLES[t])) used.add(l.role);
    expect([...used].filter((r) => !seeded.has(r))).toEqual([]);
  });

  it("🔴 تحصيل المندوب: ذمّة ← عهدة، وصفرٌ على الصندوق (النقد ليس عندنا)", () => {
    const lines = postingLinesFor({
      entryType: "PAYMENT_IN", amount: "80", party: "CUSTOMER", hasDeliveryParty: true,
    });
    expect(roleOf(lines, "DELIVERY_FLOAT")?.debit).toBe("80.00");
    expect(roleOf(lines, "AR")?.credit).toBe("80.00");
    expect(lines.some((l) => l.role === "CASH")).toBe(false);
  });

  it("إرسال COD بلا قيدٍ عمداً: لا أصلَ جديد ينشأ (العميل مَدين والمندوب وكيلٌ لم يقبض)", () => {
    expect(postingLinesFor(SAMPLES.DELIVERY_DISPATCH)).toEqual([]);
  });

  it("تمويل الخزينة يُقيَّد على جاري المالك لا رأس المال (التزامٌ يُردّ)", () => {
    const lines = postingLinesFor(SAMPLES.TREASURY_FUNDING);
    expect(roleOf(lines, "OWNER_CURRENT")?.credit).toBe("1000.00");
    expect(lines.some((l) => l.role === "CAPITAL")).toBe(false);
  });

  it("تسليم الوردية: الخزينة مدينة والدرج دائن (لا العكس)", () => {
    const lines = postingLinesFor(SAMPLES.CASH_HANDOVER);
    expect(roleOf(lines, "TREASURY_CASH")?.debit).toBe("200.00");
    expect(roleOf(lines, "CASH")?.credit).toBe("200.00");
  });

  it("التحويل بين الفروع يتصافر: OUT ثم IN ⇒ «نقدٌ في الطريق» = صفر", () => {
    const out = postingLinesFor(SAMPLES.CASH_TRANSFER_OUT);
    const inn = postingLinesFor(SAMPLES.CASH_TRANSFER_IN);
    const transit =
      Number(roleOf(out, "CASH_IN_TRANSIT")?.debit ?? 0) - Number(roleOf(inn, "CASH_IN_TRANSIT")?.credit ?? 0);
    expect(transit).toBe(0);
  });

  it("فرق الصرف موقَّع: الموجب ربحٌ والسالب خسارة — الاتجاه ينقلب بالإشارة", () => {
    const gain = postingLinesFor({ entryType: "EXCHANGE_FX_DIFF", amount: "12" });
    const loss = postingLinesFor({ entryType: "EXCHANGE_FX_DIFF", amount: "-12" });
    expect(roleOf(gain, "EXCHANGE_WALLET_IQD")?.debit).toBe("12.00");
    expect(roleOf(gain, "FX_GAIN_LOSS")?.credit).toBe("12.00");
    expect(roleOf(loss, "FX_GAIN_LOSS")?.debit).toBe("12.00");
    expect(roleOf(loss, "EXCHANGE_WALLET_IQD")?.credit).toBe("12.00");
  });

  it("مرتجع الشراء عكسُ شراءٍ لا عكسُ بيع: ذمم الموردين مدينة والمخزون دائن", () => {
    const lines = postingLinesFor({ entryType: "RETURN", amount: "-40", cost: "-25", party: "SUPPLIER" });
    expect(roleOf(lines, "AP")?.debit).toBe("40.00");
    expect(roleOf(lines, "INVENTORY")?.credit).toBe("40.00");
    expect(lines.some((l) => l.role === "COGS")).toBe(false);
  });

  it("أجرة المندوب تمريرٌ لا مصروف: التزامٌ مقابل العهدة، بلا أثرٍ على النتيجة", () => {
    const lines = postingLinesFor(SAMPLES.DELIVERY_FEE);
    expect(roleOf(lines, "COURIER_PAYABLE")?.debit).toBe("5.00");
    expect(roleOf(lines, "DELIVERY_FLOAT")?.credit).toBe("5.00");
    expect(lines.some((l) => l.role === "OPERATING_EXPENSE" || l.role === "LOSSES")).toBe(false);
  });

  it("الهدية حسابٌ مستقلّ لا مصروفٌ عامّ (بندٌ رقابيّ للمالك)", () => {
    const lines = postingLinesFor(SAMPLES.GIFT_OUT);
    expect(roleOf(lines, "GIFTS_PROMO")?.debit).toBe("15.00");
    expect(roleOf(lines, "INVENTORY")?.credit).toBe("15.00");
  });

  it("صرفٌ بلا طرفٍ ⇒ مصروفٌ تشغيليّ (لم يعد يرمي)", () => {
    const lines = postingLinesFor({ entryType: "PAYMENT_OUT", amount: "25", cashRole: "CASH" });
    expect(roleOf(lines, "OPERATING_EXPENSE")?.debit).toBe("25.00");
    expect(roleOf(lines, "CASH")?.credit).toBe("25.00");
  });
});
