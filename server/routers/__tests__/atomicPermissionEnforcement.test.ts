import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  adminProcedure,
  protectedProcedure,
  requireAtomicPermission,
  router,
} from "../../trpc";
import { periodLockRouter } from "../periodLockRouter";

const testProbeRouter = router({
  testReopenPeriod: adminProcedure
    .use(requireAtomicPermission("treasury.period.reopen"))
    .mutation(() => ({ success: true })),

  testApproveReversal: protectedProcedure
    .use(requireAtomicPermission("purchasing.goods_receipt_reversal.approve"))
    .mutation(() => ({ approved: true })),

  testCreateReservation: protectedProcedure
    .use(requireAtomicPermission("inventory.reservation.create"))
    .mutation(() => ({ created: true })),

  testInstallmentCollect: protectedProcedure
    .use(requireAtomicPermission("treasury.installment.collect"))
    .mutation(() => ({ collected: true })),
});

function createProbeCaller(user: {
  id?: number;
  role?: string;
  branchId?: number | null;
  resolvedAtomicPermissions?: Record<string, boolean>;
}) {
  return testProbeRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: "test-session",
    platformAdmin: null,
    user: {
      id: user.id ?? 1,
      role: user.role ?? "admin",
      branchId: user.branchId ?? 1,
      totpEnabledAt: new Date(),
      resolvedAtomicPermissions: user.resolvedAtomicPermissions,
    },
  } as never);
}

function createPeriodLockCaller(user: {
  id?: number;
  role?: string;
  branchId?: number | null;
  resolvedAtomicPermissions?: Record<string, boolean>;
}) {
  return periodLockRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: "test-session",
    platformAdmin: null,
    user: {
      id: user.id ?? 1,
      role: user.role ?? "admin",
      branchId: user.branchId ?? 1,
      totpEnabledAt: new Date(),
      resolvedAtomicPermissions: user.resolvedAtomicPermissions,
    },
  } as never);
}

describe("Atomic Permission Enforcement Engine", () => {
  describe("Fail-closed security on explicit revocations (Addressing Codex Review)", () => {
    it("strictly blocks an admin when atomic permission is explicitly set to false", async () => {
      const caller = createProbeCaller({
        role: "admin",
        resolvedAtomicPermissions: {
          "treasury.period.reopen": false,
        },
      });

      await expect(caller.testReopenPeriod()).rejects.toThrowError(TRPCError);
      await expect(caller.testReopenPeriod()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("صلاحية المفتاح الذري (treasury.period.reopen) محظورة لحسابك"),
      });
    });

    it("strictly blocks real periodLockRouter.unlock when treasury.period.reopen is false", async () => {
      const caller = createPeriodLockCaller({
        role: "admin",
        resolvedAtomicPermissions: {
          "treasury.period.reopen": false,
        },
      });

      await expect(
        caller.unlock({
          lockId: 99,
          reason: "فحص أمني للاختبار",
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("treasury.period.reopen"),
      });
    });

    it("allows admin when atomic permission is not explicitly revoked", async () => {
      const caller = createProbeCaller({
        role: "admin",
        resolvedAtomicPermissions: {
          "treasury.period.reopen": true,
        },
      });

      await expect(caller.testReopenPeriod()).resolves.toEqual({ success: true });
    });

    it("allows admin when resolvedAtomicPermissions does not contain negative override", async () => {
      const caller = createProbeCaller({
        role: "admin",
        resolvedAtomicPermissions: {},
      });

      await expect(caller.testReopenPeriod()).resolves.toEqual({ success: true });
    });
  });

  describe("Non-admin role enforcement", () => {
    it("blocks non-admin user when required atomic permission is missing", async () => {
      const caller = createProbeCaller({
        role: "manager",
        resolvedAtomicPermissions: {},
      });

      await expect(caller.testApproveReversal()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("purchasing.goods_receipt_reversal.approve"),
      });
    });

    it("blocks non-admin user when required atomic permission is explicitly false", async () => {
      const caller = createProbeCaller({
        role: "accountant",
        resolvedAtomicPermissions: {
          "purchasing.goods_receipt_reversal.approve": false,
        },
      });

      await expect(caller.testApproveReversal()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("purchasing.goods_receipt_reversal.approve"),
      });
    });

    it("allows non-admin user when required atomic permission is granted (true)", async () => {
      const caller = createProbeCaller({
        role: "manager",
        resolvedAtomicPermissions: {
          "purchasing.goods_receipt_reversal.approve": true,
          "inventory.reservation.create": true,
          "treasury.installment.collect": true,
        },
      });

      await expect(caller.testApproveReversal()).resolves.toEqual({ approved: true });
      await expect(caller.testCreateReservation()).resolves.toEqual({ created: true });
      await expect(caller.testInstallmentCollect()).resolves.toEqual({ collected: true });
    });
  });
});
