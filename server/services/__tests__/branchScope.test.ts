/**
 * ش٦ — نطاق الفرع متعدّد القيم. المُحلِّل النقيّ مُختبَرٌ كاملاً (أساسٌ خاملٌ مؤجَّل التفعيل، صفر أثر
 * على الإنفاذ). يثبت دلالة العضوية والفشل المغلق وعدم الرفع المديريّ الضمنيّ قبل أي وصلٍ بالمخانق.
 */
import { describe, expect, it } from "vitest";
import { deriveAllowedBranches, isBranchAllowed } from "@shared/branchScope";

describe("deriveAllowedBranches — النطاق الفعليّ", () => {
  it("admin ⇒ كل الفروع (null)", () => {
    expect(deriveAllowedBranches({ role: "admin", userBranchId: 1 })).toBeNull();
  });

  it("«كل الفروع» الصريح ⇒ null (قرار مُدقَّق، لا يُشتقّ من الرفع المديريّ)", () => {
    expect(deriveAllowedBranches({ role: "manager", userBranchId: 1, allBranches: true })).toBeNull();
  });

  it("دورٌ مديريّ بفروعٍ محدّدة يبقى مقيّداً بها (لا يقفز لكل الفروع)", () => {
    const scope = deriveAllowedBranches({ role: "manager", userBranchId: 1, roleBranchIds: [1, 2] });
    expect(scope).toEqual([1, 2]);
  });

  it("دورٌ بلا فروع صريحة ⇒ فرعه المفرد فقط (السلوك الحاليّ حرفياً)", () => {
    expect(deriveAllowedBranches({ role: "cashier", userBranchId: 3 })).toEqual([3]);
  });

  it("دورٌ بلا فرعٍ مفرد ولا فروع صريحة ⇒ لا فرع (فشلٌ مغلق، لا فرع ضمنيّ ١)", () => {
    expect(deriveAllowedBranches({ role: "cashier", userBranchId: null })).toEqual([]);
  });

  it("يزيل التكرار في فروع الدور", () => {
    expect(deriveAllowedBranches({ role: "cashier", userBranchId: 1, roleBranchIds: [2, 2, 3] })).toEqual([2, 3]);
  });
});

describe("isBranchAllowed — فحص العضوية", () => {
  it("null ⇒ كل الفروع مسموحة", () => {
    expect(isBranchAllowed(null, 5)).toBe(true);
  });
  it("مصفوفة ⇒ العضوية فقط", () => {
    expect(isBranchAllowed([1, 2], 2)).toBe(true);
    expect(isBranchAllowed([1, 2], 3)).toBe(false);
  });
  it("فرعٌ فارغ خارج نطاقٍ محدّد ⇒ مرفوض (فشلٌ مغلق)", () => {
    expect(isBranchAllowed([1], null)).toBe(false);
  });
});
