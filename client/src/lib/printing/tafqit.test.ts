import { describe, expect, it } from "vitest";
import { formatArabicMoneyWords, toArabicWords } from "./tafqit";

describe("tafqit — تفقيط عربي مالي (decimal.js بدل Number الخام، gap-audit ٥/٧ medium)", () => {
  it("صفر ⇒ «صفر»", () => {
    expect(toArabicWords(0)).toBe("صفر");
    expect(toArabicWords("0")).toBe("صفر");
  });

  it("أعداد بسيطة (آحاد/عشرات/مئات)", () => {
    expect(toArabicWords(5)).toBe("خمسة");
    expect(toArabicWords(15)).toBe("خمسة عشر");
    expect(toArabicWords(23)).toBe("ثلاثة وعشرون");
    expect(toArabicWords(100)).toBe("مئة");
  });

  it("مقاييس كبيرة (ألف/مليون/مليار) بصيغة المفرد/المثنّى/الجمع الصحيحة", () => {
    expect(toArabicWords(1000)).toBe("ألف");
    expect(toArabicWords(2000)).toBe("ألفان");
    expect(toArabicWords(3000)).toBe("ثلاثة آلاف");
    expect(toArabicWords(1_000_000)).toBe("مليون");
  });

  it("يقبل نصّاً عشرياً (money string من الخادم) ويقرّبه HALF_UP للجزء الصحيح — بلا Number() خام", () => {
    expect(toArabicWords("1234.00")).toBe(toArabicWords(1234));
    expect(toArabicWords("1234.50")).toBe(toArabicWords(1235)); // HALF_UP
    expect(toArabicWords("1234.49")).toBe(toArabicWords(1234));
  });

  it("قيمة سالبة تُؤخذ بقيمتها المطلقة (Math.abs سابقاً، الآن .abs() عبر decimal.js)", () => {
    expect(toArabicWords(-500)).toBe(toArabicWords(500));
  });

  it("formatArabicMoneyWords يُنتج الصياغة الكاملة", () => {
    expect(formatArabicMoneyWords(1000)).toBe("فقط ألف دينار عراقي لا غير");
    expect(formatArabicMoneyWords("0")).toBe("فقط صفر دينار عراقي لا غير");
  });

  it("null/undefined/فارغ ⇒ صفر (D() يعامله كذلك، لا يرمي)", () => {
    expect(toArabicWords(null as unknown as number)).toBe("صفر");
    expect(toArabicWords(undefined as unknown as number)).toBe("صفر");
    expect(toArabicWords("")).toBe("صفر");
  });
});
