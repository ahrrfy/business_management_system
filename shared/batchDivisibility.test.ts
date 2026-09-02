import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_MULTIPLE,
  batchMultipleNote,
  coefficientBatchMultiple,
  isBatchDivisible,
  largestValidBatchAtMost,
  requiredBatchMultiple,
} from "./batchDivisibility";

/**
 * القاعدة تحرس السلوك الذي أربك المالك: «تعمل عند 100 ولا تعمل عند 50 مع توفّر المواد».
 * الرفض اختبارُ باقي قسمةٍ لا اختبارُ حجم — فهو غير تصاعديّ، والاختبارات تثبّت ذلك صراحةً.
 */
describe("قابلية قسمة الدفعة", () => {
  it("المعامِل الصحيح لا يقيّد شيئاً", () => {
    expect(coefficientBatchMultiple("80")).toBe(1);
    expect(coefficientBatchMultiple(1)).toBe(1);
    expect(coefficientBatchMultiple("12.0000")).toBe(1);
  });

  it("المقام يُختزَل — لا يُؤخَذ 10^المنازل خامّاً", () => {
    expect(coefficientBatchMultiple("0.5")).toBe(2);
    expect(coefficientBatchMultiple("0.25")).toBe(4);
    expect(coefficientBatchMultiple("0.16")).toBe(25); // 0.16 × 25 = 4 صحيح
    expect(coefficientBatchMultiple("0.01")).toBe(100);
    expect(coefficientBatchMultiple("0.0001")).toBe(MAX_BATCH_MULTIPLE);
  });

  it("المعامِل غير الصالح لا يُقحم رأياً — يعود 1", () => {
    expect(coefficientBatchMultiple("0")).toBe(1);
    expect(coefficientBatchMultiple("-2.5")).toBe(1);
    expect(coefficientBatchMultiple("abc")).toBe(1);
    expect(coefficientBatchMultiple("")).toBe(1);
  });

  it("مضاعف الوصفة = lcm مقامات مكوّناتها", () => {
    expect(requiredBatchMultiple(["80", "40"])).toBe(1);
    expect(requiredBatchMultiple(["80", "0.5"])).toBe(2);
    expect(requiredBatchMultiple(["0.5", "0.25"])).toBe(4);
    expect(requiredBatchMultiple(["0.16", "0.5"])).toBe(50); // lcm(25, 2)
    expect(requiredBatchMultiple(["0.01", "80"])).toBe(100);
    expect(requiredBatchMultiple([])).toBe(1);
  });

  it("⭐ الأصغر ليس أسلم — هذا هو بلاغ المالك بعينه", () => {
    const recipe = ["0.01", "80"]; // مكوّن كسريّ + مكوّن صحيح
    expect(isBatchDivisible(recipe, 100)).toBe(true);
    expect(isBatchDivisible(recipe, 200)).toBe(true);
    expect(isBatchDivisible(recipe, 300)).toBe(true);
    expect(isBatchDivisible(recipe, 50)).toBe(false);  // أقلّ ⇒ يُرفض
    expect(isBatchDivisible(recipe, 150)).toBe(false); // أكثر ⇒ يُرفض أيضاً
    expect(isBatchDivisible(recipe, 99)).toBe(false);
  });

  it("الدفعة غير الصحيحة أو غير الموجبة مرفوضة دائماً", () => {
    expect(isBatchDivisible(["80"], 0)).toBe(false);
    expect(isBatchDivisible(["80"], -5)).toBe(false);
    expect(isBatchDivisible(["80"], 7.5)).toBe(false);
  });

  it("قصّ السقف على المضاعف لا يتجاوزه أبداً", () => {
    expect(largestValidBatchAtMost(2447, 100)).toBe(2400);
    expect(largestValidBatchAtMost(2447, 1)).toBe(2447);
    expect(largestValidBatchAtMost(99, 100)).toBe(0);   // لا دفعة صالحة ضمن المتاح
    expect(largestValidBatchAtMost(0, 100)).toBe(0);
    expect(largestValidBatchAtMost(100, 100)).toBe(100);
  });

  it("الجملة الشارحة تصمت حين لا قيد", () => {
    expect(batchMultipleNote(1)).toBeNull();
    expect(batchMultipleNote(0)).toBeNull();
    expect(batchMultipleNote(100)).toContain("مضاعفةً لـ100");
  });
});
