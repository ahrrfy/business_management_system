import { describe, expect, it } from "vitest";
import { resolveSuperAppAuthority } from "../superAppRouter";
import { normalizeOwnerAuthority, type AuthUser } from "../../context";
import { adminProcedure, router } from "../../trpc";
import {
  assertExecutiveAccess,
  resolveExecutiveBranch,
  resolveExecutiveCapabilities,
  selectPermittedExecutiveMetrics,
} from "../executiveRouter";

const adminGateProbe = router({
  read: adminProcedure.query(() => true),
});

describe("super app effective authority", () => {
  it("keeps admin company-wide and immune to restrictive UI overrides", () => {
    const authority = resolveSuperAppAuthority({
      role: "admin",
      branchId: null,
      permissionsOverride: { reports: "NONE", treasury: "NONE" },
    });
    expect(authority.scope).toMatchObject({ allBranches: true, effectiveBranchId: null });
    expect(authority.permissions.reports).toBe("FULL");
    expect(authority.permissions.treasury).toBe("FULL");
    expect(authority.capabilities).toMatchObject({
      canSeeCost: true,
      canViewReports: true,
      isExecutive: true,
      roleDegraded: false,
    });
  });

  it("keeps a manager scoped to the assigned branch", () => {
    const authority = resolveSuperAppAuthority({ role: "manager", branchId: 17 });
    expect(authority.scope).toEqual({ branchId: 17, allBranches: false, effectiveBranchId: 17 });
    expect(authority.capabilities.isExecutive).toBe(true);
  });

  it("fails a branchless manager closed instead of widening to all branches", () => {
    const authority = resolveSuperAppAuthority({ role: "manager", branchId: null });
    expect(authority.scope).toEqual({ branchId: null, allBranches: false, effectiveBranchId: -1 });
  });

  it("surfaces an inactive custom-role downgrade explicitly", () => {
    const authority = resolveSuperAppAuthority({
      role: "user",
      branchId: 1,
      roleLockedByInactiveCustomRole: true,
    });
    expect(authority.capabilities.roleDegraded).toBe(true);
    expect(authority.capabilities.isExecutive).toBe(false);
  });

  it("derives owner capability only from the persisted owner flag", () => {
    expect(resolveSuperAppAuthority({ role: "admin", isOwner: false }).capabilities.isOwner).toBe(false);
    const owner = resolveSuperAppAuthority({ role: "manager", isOwner: true, branchId: 1 });
    expect(owner.capabilities.isOwner).toBe(true);
    expect(owner.capabilities.isExecutive).toBe(true);
    expect(owner.role).toBe("admin");
    expect(owner.scope).toEqual({ branchId: 1, allBranches: true, effectiveBranchId: null });
    expect(owner.permissions.users).toBe("FULL");
    expect(owner.permissions.settings).toBe("FULL");
    expect(resolveExecutiveBranch({ role: "manager", isOwner: true, branchId: 1 })).toBeUndefined();
    expect(resolveExecutiveBranch({ role: "user", isOwner: true, branchId: null }, 9)).toBe(9);
    expect(() => assertExecutiveAccess({ role: "user", isOwner: true })).not.toThrow();
  });

  it("normalizes an owner request context before operational API gates", async () => {
    const owner = normalizeOwnerAuthority({
      role: "user",
      isOwner: true,
      permissionsOverride: { users: "NONE", settings: "NONE" },
      customRoleLabel: "Restricted",
      customRoleKey: "restricted",
      roleLockedByInactiveCustomRole: true,
    } as AuthUser);
    expect(owner.role).toBe("admin");
    expect(owner.permissionsOverride).toBeNull();
    expect(owner.customRoleLabel).toBeNull();
    expect(owner.roleLockedByInactiveCustomRole).toBe(false);
    const caller = adminGateProbe.createCaller({
      req: { headers: {} },
      res: {},
      sessionId: null,
      platformAdmin: null,
      user: { ...owner, totpEnabledAt: new Date() },
    } as never);
    await expect(caller.read()).resolves.toBe(true);
  });

  it("omits every command-center slice whose capability is false", () => {
    const capabilities = resolveExecutiveCapabilities({
      role: "manager",
      branchId: 3,
      permissionsOverride: {
        reports: "NONE", sales: "NONE", pos: "NONE", collections: "NONE",
        inventory: "NONE", products: "NONE", workorders: "NONE", tasks: "NONE",
        treasury: "NONE", purchases: "NONE", suppliers: "NONE",
      },
    });
    expect(Object.values(capabilities).every((value) => value === false)).toBe(true);
    const selected = selectPermittedExecutiveMetrics({
      health: { status: "ok", sourceErrors: [] },
      lowStockCount: 7,
      overdueAR: { count: 2, total: "900.00" },
      salesPulse: { yesterday: "100.00", avg7d: "80.00", direction: "up", changePct: 25 },
      morningBrief: { arRemindersDue: 4, promisedToday: 3, overdueWorkOrders: 2, myOpenTasks: 1, overdueTasks: 6 },
    }, capabilities);
    expect(selected).toEqual({
      lowStockCount: null,
      overdueAR: null,
      salesPulse: null,
      morningBrief: {
        arRemindersDue: null,
        promisedToday: null,
        overdueWorkOrders: null,
        myOpenTasks: null,
        overdueTasks: null,
      },
    });
  });
});
