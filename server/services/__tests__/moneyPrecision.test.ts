// اختبارات دقّة الأموال: positiveDiff + roundCashIQD + sumMoney (§٥).
// لا تحتاج قاعدة بيانات — وحدة بحتة.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { money, positiveDiff, roundCashIQD, sumMoney, toDbMoney } from "../money";

describe("positiveDiff", () => {
  it("يطرح بدقّة Decimal بلا انجراف float", () => {
    expect(positiveDiff("100.10", "0.10").toFixed(2)).toBe("100.00");
    // 0.1 + 0.2 = 0.3 (Decimal). 0.3 - 0.1 = 0.2 بلا انجراف.
    expect(positiveDiff("0.3", "0.1").toFixed(2)).toBe("0.20");
  });

  it("يقصّ السالب إلى صفر", () => {
    expect(positiveDiff("50", "100").toFixed(2)).toBe("0.00");
    expect(positiveDiff(0, 1).toFixed(2)).toBe("0.00");
  });

  it("يتعامل مع null/undefined/فارغ", () => {
    expect(positiveDiff(null as never, "10").toFixed(2)).toBe("0.00");
    expect(positiveDiff("10", null as never).toFixed(2)).toBe("10.00");
  });
});

describe("roundCashIQD", () => {
  it("يقرّب لأعلى عند 50% أو أكثر من الفئة", () => {
    expect(roundCashIQD("125").toString()).toBe("250"); // 125 ≥ 250/2 ⇒ يرتفع
    expect(roundCashIQD("126").toString()).toBe("250");
    expect(roundCashIQD("375").toString()).toBe("500"); // 375 = 250+125 ⇒ يرتفع
  });

  it("يقرّب لأسفل عند أقل من نصف الفئة", () => {
    expect(roundCashIQD("100").toString()).toBe("0"); // 100 < 125 ⇒ ينخفض
    expect(roundCashIQD("124").toString()).toBe("0");
    expect(roundCashIQD("370").toString()).toBe("250"); // 370 < 375 ⇒ ينخفض
  });

  it("يُبقي مضاعفات الفئة كما هي", () => {
    expect(roundCashIQD("250").toString()).toBe("250");
    expect(roundCashIQD("500").toString()).toBe("500");
    expect(roundCashIQD("10000").toString()).toBe("10000");
  });

  it("صفر ⇒ صفر؛ سالب ⇒ صفر", () => {
    expect(roundCashIQD(0).toString()).toBe("0");
    expect(roundCashIQD("-100").toString()).toBe("0");
  });

  it("يقبل فئة مخصّصة (٥٠٠ مثلاً)", () => {
    expect(roundCashIQD("750", 500).toString()).toBe("1000"); // 750 ≥ 250 ⇒ يرتفع
    expect(roundCashIQD("249", 500).toString()).toBe("0"); // 249 < 250 ⇒ ينخفض
  });

  it("يرفض فئة غير صالحة", () => {
    expect(() => roundCashIQD("100", 0)).toThrow();
    expect(() => roundCashIQD("100", -250)).toThrow();
    expect(() => roundCashIQD("100", 100.5)).toThrow();
  });
});

describe("regression: sumMoney لا ينجرف على ١٠٠٠ إضافة 0.01", () => {
  it("يجمع 1000 × 0.01 = 10.00 بدقّة Decimal", () => {
    const cents = Array(1000).fill("0.01");
    const total = sumMoney(cents);
    expect(toDbMoney(total)).toBe("10.00");
  });

  it("يقارن: نفس الجمع بـ Number يفقد دقّة (تأكيد سلوك float المرفوض)", () => {
    // float drift: 0.1+0.2 = 0.30000000000000004 — Decimal لا يفعل ذلك.
    expect(new Decimal("0.1").plus(new Decimal("0.2")).toFixed(20)).toBe("0.30000000000000000000");
    expect(0.1 + 0.2).not.toBe(0.3); // كاشف الفخّ
  });
});

describe("money() يرفض القيم غير الصالحة", () => {
  it("Infinity ⇒ يرمي", () => {
    expect(() => money(Infinity)).toThrow();
  });
  it("سلسلة غير رقمية ⇒ يرمي", () => {
    expect(() => money("abc")).toThrow();
  });
  it("سلسلة فارغة ⇒ صفر", () => {
    expect(money("").toString()).toBe("0");
  });
});
