import { describe, expect, it } from "vitest";
import {
  assertCompanyCommissionAuthority,
  commissionReadScope,
  commissionWriteScope,
} from "./scope";

describe("commission authority scope", () => {
  it("يحصر مدير الفرع في فرعه ولا يمنحه سلطة الشركة", () => {
    const manager = { role: "manager", branchId: 7 };
    expect(commissionReadScope(manager)).toBe(7);
    expect(commissionWriteScope(manager)).toBe(7);
    expect(() => assertCompanyCommissionAuthority(manager)).toThrow(/مستوى الشركة/);
  });

  it("يفتح نطاق الشركة للمالك/الأدمن والمالية المركزية فقط", () => {
    expect(commissionWriteScope({ role: "admin", branchId: null })).toBeNull();
    expect(commissionWriteScope({ role: "user", isOwner: true, branchId: 9 })).toBeNull();
    expect(commissionWriteScope({ role: "accountant", branchId: null })).toBeNull();
    expect(() => assertCompanyCommissionAuthority({ role: "accountant", branchId: null })).not.toThrow();
  });

  it("يفشل مغلقاً لحامل FULL غير المدير أو لحساب بلا فرع", () => {
    expect(() => commissionWriteScope({ role: "cashier", branchId: 1 })).toThrow(/مدير الفرع/);
    expect(() => commissionReadScope({ role: "auditor", branchId: null })).toThrow(/مالية مركزية/);
  });
});
