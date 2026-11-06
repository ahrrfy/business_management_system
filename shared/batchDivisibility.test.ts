import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_MULTIPLE,
  batchMultipleNote,
  coefficientBatchMultiple,
  isBatchDivisible,
  largestValidBatchAtMost,
  requiredBatchMultiple,
} from "./batchDivisibility";

describe("دفعات صحيحة باستهلاك مواد عشري دقيق", () => {
  it("المعامِل الصحيح لا يقيّد شيئاً", () => {
    expect(coefficientBatchMultiple("80")).toBe(1);
    expect(coefficientBatchMultiple(1)).toBe(1);
    expect(coefficientBatchMultiple("12.0000")).toBe(1);
  });

  it("أربع منازل استهلاك لا تفرض مضاعفات على الناتج الصحيح", () => {
    expect(MAX_BATCH_MULTIPLE).toBe(1);
    for (const coefficient of ["0.5", "0.25", "0.16", "0.01", "0.0001"]) {
      expect(coefficientBatchMultiple(coefficient)).toBe(1);
    }
  });

  it("المعامِل غير الصالح لا ينتج دفعة قابلة للتنفيذ ولا يرمي في محرر الواجهة", () => {
    for (const coefficient of ["0", "-2.5", "abc", "", "0.00001", "NaN", "Infinity"]) {
      expect(coefficientBatchMultiple(coefficient)).toBe(0);
      expect(requiredBatchMultiple(["1", coefficient])).toBe(0);
      expect(isBatchDivisible([coefficient], 1)).toBe(false);
    }
  });

  it("خلط المواد الصحيحة والكسرية يبقي أصغر دفعة وحدة نهائية واحدة", () => {
    expect(requiredBatchMultiple(["80", "40"])).toBe(1);
    expect(requiredBatchMultiple(["80", "0.5"])).toBe(1);
    expect(requiredBatchMultiple(["0.5", "0.25"])).toBe(1);
    expect(requiredBatchMultiple(["0.16", "0.5"])).toBe(1);
    expect(requiredBatchMultiple(["0.01", "80"])).toBe(1);
    expect(requiredBatchMultiple([])).toBe(1);
  });

  it("بيع وإنتاج وحدة واحدة أو أي دفعة صحيحة يقبلان معامل 0.01", () => {
    const recipe = ["0.01", "80"]; // مكوّن كسريّ + مكوّن صحيح
    expect(isBatchDivisible(recipe, 100)).toBe(true);
    expect(isBatchDivisible(recipe, 200)).toBe(true);
    expect(isBatchDivisible(recipe, 300)).toBe(true);
    expect(isBatchDivisible(recipe, 1)).toBe(true);
    expect(isBatchDivisible(recipe, 50)).toBe(true);
    expect(isBatchDivisible(recipe, 150)).toBe(true);
    expect(isBatchDivisible(recipe, 99)).toBe(true);
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
