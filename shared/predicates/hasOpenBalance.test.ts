import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { hasOpenBalance, balanceDirection } from "./hasOpenBalance";

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

describe("balanceDirection — للاستهلاك بعد المسند لا بدلاً منه", () => {
  it("موجب ⇒ receivable · سالب ⇒ payable · صفر ⇒ zero", () => {
    expect(balanceDirection({ currentBalance: "100" })).toBe("receivable");
    expect(balanceDirection({ currentBalance: "-100" })).toBe("payable");
    expect(balanceDirection({ currentBalance: "0" })).toBe("zero");
    expect(balanceDirection(null)).toBe("zero");
  });
});
