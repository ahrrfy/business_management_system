import { describe, expect, it } from "vitest";
import {
  reportsAdminProcedure,
  reportsManagerProcedure,
  router,
} from "../../trpc";

const authorityProbe = router({
  requestClose: reportsManagerProcedure.query(() => true),
  approveClose: reportsAdminProcedure.query(() => true),
});

type ProbeRole = "admin" | "manager" | "accountant" | "cashier";

function caller(
  role: ProbeRole,
  options: {
    branchId?: number | null;
    reports?: "FULL" | "READ" | "NONE";
  } = {},
) {
  return authorityProbe.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 41,
      role,
      branchId: options.branchId ?? null,
      permissionsOverride: options.reports
        ? { reports: options.reports }
        : null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("period lock authority", () => {
  it("keeps admin access company-wide even with a restrictive reports override", async () => {
    const admin = caller("admin", { reports: "NONE" });
    await expect(admin.requestClose()).resolves.toBe(true);
    await expect(admin.approveClose()).resolves.toBe(true);
  });

  it("lets the default manager request a close but never approve it", async () => {
    const manager = caller("manager");
    await expect(manager.requestClose()).resolves.toBe(true);
    await expect(manager.approveClose()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("honours an explicit reports revocation for a manager", async () => {
    await expect(
      caller("manager", { reports: "NONE" }).requestClose(),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("does not widen the manager boundary from a role template alone", async () => {
    await expect(
      caller("accountant", { branchId: 7 }).requestClose(),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("honours an explicit reports:FULL grant without granting admin approval", async () => {
    const explicitlyGranted = caller("cashier", {
      branchId: 7,
      reports: "FULL",
    });
    await expect(explicitlyGranted.requestClose()).resolves.toBe(true);
    await expect(explicitlyGranted.approveClose()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("requires an assigned branch for an explicitly granted non-manager", async () => {
    await expect(
      caller("cashier", { reports: "FULL" }).requestClose(),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
