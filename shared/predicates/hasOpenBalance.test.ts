import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  balanceDirection,
  hasOpenBalance,
  hasOpenBalanceStrict,
  IndeterminateBalanceError,
  readBalanceStrict,
} from "./hasOpenBalance";

/**
 * اختبارٌ عقديّ: **لا سلوكَ جديداً بلا حرسٍ يمنعُ الانحراف**. المسند القائم في ≥١٥ موضعاً يجب
 * أن يتّفق كلُّه على تعريفٍ واحد: «مفتوح = غير صفريّ» بأيّ اتّجاه. اختباراتٌ محدَّدة تحمي كلَّ
 * حافّةٍ رأيتُها في المكتبة (صفر بمنازل · نصّ فارغ · null · Decimal مباشر · سالب).
 */
describe("hasOpenBalance — «مفتوح» = غير صفريّ", () => {
  it("الصفر بمنازلٍ عشرية = مُصفَّى (نصّ قاعدة `decimal(15,2)`)", () => {
    expect(hasOpenBalance({ currentBalance: "0.00" })).toBe(false);
    expect(hasOpenBalance({ currentBalance: "0" })).toBe(false);
    expect(hasOpenBalance({ currentBalance: 0 })).toBe(false);
  });

  it("الرصيد الموجب مفتوح (AR على العميل — مدينٌ لنا)", () => {
    expect(hasOpenBalance({ currentBalance: "1250.50" })).toBe(true);
    expect(hasOpenBalance({ currentBalance: 1250.5 })).toBe(true);
    expect(hasOpenBalance({ currentBalance: "0.01" })).toBe(true);
  });

  it("الرصيد السالب مفتوح (دائنٌ — مورّد أو دفعٌ زائد)", () => {
    expect(hasOpenBalance({ currentBalance: "-300.00" })).toBe(true);
    expect(hasOpenBalance({ currentBalance: -0.01 })).toBe(true);
  });

  it("قيمٌ نصّية غامضة/غائبة ⇒ صفر ⇒ مُصفَّى (احتراسٌ ضدّ صفٍّ ناقصٍ يُسقط شاشة)", () => {
    expect(hasOpenBalance({ currentBalance: null })).toBe(false);
    expect(hasOpenBalance({ currentBalance: undefined })).toBe(false);
    expect(hasOpenBalance({ currentBalance: "" })).toBe(false);
    expect(hasOpenBalance({ currentBalance: "abc" })).toBe(false);
  });

  it("الطرفُ نفسه null/undefined ⇒ لا رصيد ⇒ false", () => {
    expect(hasOpenBalance(null)).toBe(false);
    expect(hasOpenBalance(undefined)).toBe(false);
  });

  it("يقبل `Decimal` مباشرةً (مسارات الخادم بعد `money()`)", () => {
    expect(hasOpenBalance({ currentBalance: new Decimal("0.00").toString() })).toBe(false);
    expect(hasOpenBalance({ currentBalance: new Decimal("42.75").toString() })).toBe(true);
  });

  it("لا يُصنّف Infinity/NaN رصيداً مفتوحاً (يفشل مغلقاً، لا يُقفل شاشةً على قيمة فاسدة)", () => {
    // النصّ "Infinity" ⇒ Decimal يقبله لكن `!isFinite` ⇒ toDecimalSafe يُعيده صفراً.
    expect(hasOpenBalance({ currentBalance: "Infinity" })).toBe(false);
    expect(hasOpenBalance({ currentBalance: "NaN" })).toBe(false);
  });
});

describe("balanceDirection — إشارةُ الرصيد تُقلَب في المورّد (Codex #961)", () => {
  it("العميل/جهةُ التوصيل: موجب ⇒ receivable · سالب ⇒ payable", () => {
    expect(balanceDirection({ currentBalance: "100" }, "customer")).toBe("receivable");
    expect(balanceDirection({ currentBalance: "-100" }, "customer")).toBe("payable");
    expect(balanceDirection({ currentBalance: "100" }, "deliveryParty")).toBe("receivable");
    expect(balanceDirection({ currentBalance: "-100" }, "deliveryParty")).toBe("payable");
  });

  it("**المورّد يُعكَس**: موجب ⇒ payable (ندين له) · سالب ⇒ receivable (دفعنا زيادة)", () => {
    expect(balanceDirection({ currentBalance: "100" }, "supplier")).toBe("payable");
    expect(balanceDirection({ currentBalance: "-100" }, "supplier")).toBe("receivable");
  });

  it("صفر أو null ⇒ zero لأيّ نوع", () => {
    expect(balanceDirection({ currentBalance: "0" }, "customer")).toBe("zero");
    expect(balanceDirection(null, "supplier")).toBe("zero");
  });
});

describe("readBalanceStrict — للبوّابات الحسّاسة (Codex #961)", () => {
  it("قيمٌ صالحة ⇒ Decimal", () => {
    expect(readBalanceStrict({ currentBalance: "1250.50" }).toString()).toBe("1250.5");
    expect(readBalanceStrict({ currentBalance: "0.00" }).toString()).toBe("0");
    expect(readBalanceStrict({ currentBalance: "-100" }).toString()).toBe("-100");
  });

  it("null/undefined/فارغ ⇒ يرمي IndeterminateBalanceError (لا يترجم صفراً)", () => {
    expect(() => readBalanceStrict({ currentBalance: null })).toThrow(IndeterminateBalanceError);
    expect(() => readBalanceStrict({ currentBalance: undefined })).toThrow(IndeterminateBalanceError);
    expect(() => readBalanceStrict({ currentBalance: "" })).toThrow(IndeterminateBalanceError);
    expect(() => readBalanceStrict(null)).toThrow(IndeterminateBalanceError);
  });

  it("قيمٌ غير رقميّة/غير منتهية ⇒ يرمي", () => {
    expect(() => readBalanceStrict({ currentBalance: "abc" })).toThrow(IndeterminateBalanceError);
    expect(() => readBalanceStrict({ currentBalance: "Infinity" })).toThrow(IndeterminateBalanceError);
    expect(() => readBalanceStrict({ currentBalance: "NaN" })).toThrow(IndeterminateBalanceError);
  });

  it("hasOpenBalanceStrict يرمي حين يرمي readBalanceStrict — بوّابةُ الحذف لا تعبُر رصيداً فاسداً", () => {
    expect(() => hasOpenBalanceStrict({ currentBalance: "abc" })).toThrow(IndeterminateBalanceError);
    expect(hasOpenBalanceStrict({ currentBalance: "0" })).toBe(false);
    expect(hasOpenBalanceStrict({ currentBalance: "100" })).toBe(true);
  });
});
