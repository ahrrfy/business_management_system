import { describe, expect, it } from "vitest";
import {
  ownerProcedure,
  reportsAdminProcedure,
  reportsManagerProcedure,
  router,
} from "../../trpc";
import { periodLockRouter } from "../periodLockRouter";

const authorityProbe = router({
  requestClose: reportsManagerProcedure.query(() => true),
  approveClose: reportsAdminProcedure.query(() => true),
  readCertificate: reportsAdminProcedure.query(() => true),
  bootstrapSequence: ownerProcedure.query(() => true),
});

type ProbeRole = "admin" | "manager" | "accountant" | "cashier";

function caller(
  role: ProbeRole,
  options: {
    branchId?: number | null;
    reports?: "FULL" | "READ" | "NONE";
    isOwner?: boolean;
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
      isOwner: options.isOwner ?? false,
    },
  } as never);
}

describe("period lock authority", () => {
  it("لا يعرّض API قفلاً مباشراً يتجاوز طلب الإقفال والاعتماد", () => {
    const procedures = periodLockRouter._def.procedures as Record<
      string,
      unknown
    >;
    expect(procedures.lock).toBeUndefined();
    expect(procedures.closeActionReadiness).toBeDefined();
    expect(procedures.bootstrapSequence).toBeDefined();
    expect(procedures.certificates).toBeDefined();
    expect(procedures.certificate).toBeDefined();
    expect(procedures.verifyCertificate).toBeDefined();
    expect(procedures.exportCertificate).toBeDefined();
  });

  it("restricts sequence bootstrap to an explicit owner session", async () => {
    await expect(caller("admin").bootstrapSequence()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller("admin", { isOwner: true }).bootstrapSequence(),
    ).resolves.toBe(true);
  });

  it("keeps certificate evidence behind reports-admin authority", async () => {
    await expect(caller("admin").readCertificate()).resolves.toBe(true);
    await expect(caller("manager").readCertificate()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

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
