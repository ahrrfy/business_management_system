import { describe, expect, it } from "vitest";
import type { OperationUser } from "@shared/operationPermissions";
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
    expect(() => assertCompanyCommissionAuthority(manager)).toThrow(
      /مستوى الشركة/,
    );
  });

  it("يفتح نطاق الشركة للمالك/الأدمن والمالية المركزية فقط", () => {
    expect(commissionWriteScope({ role: "admin", branchId: null })).toBeNull();
    expect(
      commissionWriteScope({ role: "user", isOwner: true, branchId: 9 }),
    ).toBeNull();
    expect(
      commissionWriteScope({ role: "accountant", branchId: null }),
    ).toBeNull();
    expect(() =>
      assertCompanyCommissionAuthority({ role: "accountant", branchId: null }),
    ).not.toThrow();
  });

  it("يفشل مغلقاً لحامل FULL غير المدير أو لحساب بلا فرع", () => {
    expect(() =>
      commissionWriteScope({ role: "cashier", branchId: 1 }),
    ).toThrow(/مدير الفرع/);
    expect(() =>
      commissionReadScope({ role: "auditor", branchId: null }),
    ).toThrow(/مالية مركزية/);
  });

  it("ينفذ التفويض المحدد لدور مستودع في فرعه لكل عملية عمولات فرعية", () => {
    const paths = [
      "commissions.plans.assign",
      "commissions.plans.endAssignment",
      "commissions.targets.saveAll",
      "commissions.targets.copyFromPrevious",
      "commissions.runs.compute",
      "commissions.runs.approve",
    ];
    for (const path of paths) {
      const user: OperationUser & { branchId: number } = {
        role: "warehouse",
        branchId: 7,
        operationPolicyEnabled: true,
        resolvedOperationPolicy: {
          version: 1,
          grants: { [`operation.${path}`]: true },
        },
      };
      expect(commissionWriteScope(user, path)).toBe(7);
      expect(() =>
        commissionWriteScope(
          user,
          paths.find((other) => other !== path),
        ),
      ).toThrow(/لم تُفوَّض/);
    }
  });

  it("يحترم منع مدير محفوظ ولا يجعل التفويض فرعاً أو سلطة شركة", () => {
    const path = "commissions.targets.saveAll";
    const denied: OperationUser & { branchId: number } = {
      role: "manager",
      branchId: 7,
      operationPolicyEnabled: true,
      resolvedOperationPolicy: { version: 1, grants: {} },
    };
    expect(() => commissionWriteScope(denied, path)).toThrow(/لم تُفوَّض/);
    const granted = {
      ...denied,
      role: "warehouse",
      resolvedOperationPolicy: {
        version: 1 as const,
        grants: { [`operation.${path}`]: true },
      },
    };
    expect(() =>
      commissionWriteScope({ ...granted, branchId: null }, path),
    ).toThrow(/اسند فرعاً/);
    expect(() => assertCompanyCommissionAuthority(granted)).toThrow(
      /مدير الفرع/,
    );
    // اللقطة المحلولة للتوافق وحدها لا تغيّر سلطة الدور القديم.
    expect(() =>
      commissionWriteScope({ ...granted, operationPolicyEnabled: false }, path),
    ).toThrow(/مدير الفرع/);
  });
});
