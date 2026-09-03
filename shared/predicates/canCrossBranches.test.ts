import { describe, it, expect } from "vitest";
import { canCrossBranches } from "./canCrossBranches";
import { canCrossBranches as serverCanCross } from "../../server/lib/branchAuthority";

/**
 * اختبارٌ عقديّ: **نسخة `shared/` مطابقةٌ حرفياً** لنسخة الخادم. أيّ انحرافٍ لاحقٍ في أيٍّ منهما
 * يكسر هذا الاختبار فوراً ⇒ لا سلوكَ يتعدّل في نصفٍ دون النصف الآخر.
 */
describe("canCrossBranches — سلطة الفرع", () => {
  const cases = [
    { role: "admin" },
    { role: "manager", isOwner: true },
    { role: "manager", isOwner: false },
    { role: "manager" },
    { role: "cashier", isOwner: true },
    { role: "cashier" },
    { role: "auditor" },
    { role: null, isOwner: true },
    { role: null, isOwner: null },
    { role: null },
    {},
  ] as const;

  it("يعطي نفس نتيجة نسخة `server/lib/branchAuthority.ts` على كل حالة", () => {
    for (const c of cases) {
      expect(canCrossBranches(c), `تباين على ${JSON.stringify(c)}`).toBe(serverCanCross(c));
    }
  });

  it("admin يعبر (قرار المالك ١٢/٨: تصحيح إداريّ)", () => {
    expect(canCrossBranches({ role: "admin" })).toBe(true);
  });

  it("المالك isOwner يعبر بأيّ دور — دفاعٌ في العمق قبل تطبيع الدور", () => {
    expect(canCrossBranches({ role: "cashier", isOwner: true })).toBe(true);
    expect(canCrossBranches({ role: "manager", isOwner: true })).toBe(true);
  });

  it("مدير الفرع (بلا isOwner) لا يعبر ⇒ مقيَّدٌ بفرعه (عزل ١٢/٨)", () => {
    expect(canCrossBranches({ role: "manager" })).toBe(false);
    expect(canCrossBranches({ role: "manager", isOwner: false })).toBe(false);
  });

  it("null/undefined/{} ⇒ false (لا فاعل ⇒ لا سلطة)", () => {
    expect(canCrossBranches(null)).toBe(false);
    expect(canCrossBranches(undefined)).toBe(false);
    expect(canCrossBranches({})).toBe(false);
  });
});
