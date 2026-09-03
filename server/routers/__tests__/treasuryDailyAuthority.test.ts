import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../context";

const auditMocks = vi.hoisted(() => ({ logAudit: vi.fn(async () => undefined) }));

vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  ...auditMocks,
}));

import { treasuryRouter } from "../treasuryRouter";

function caller(
  role: string,
  options: {
    branchId?: number | null;
    permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null;
  } = {},
) {
  return treasuryRouter.createCaller({
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 91,
      role,
      branchId: options.branchId === undefined ? 1 : options.branchId,
      name: "مستخدم اختبار الخزينة اليومية",
      email: "treasury-daily@test.local",
      isActive: true,
      permissionsOverride: options.permissionsOverride ?? null,
      totpEnabledAt: new Date(),
    },
  } as unknown as TrpcContext);
}

const DATE = "2026-08-31";
const invalidCount = {
  branchId: 1,
  businessDate: DATE,
  countedCash: "1.00",
  countedBreakdown: {},
  expectedVersion: 0,
  clientRequestId: "treasury-daily-authority-count",
};

describe("treasury daily procedures — authority and branch scope", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("honours an explicit treasury revocation on read, count, close and reopen", async () => {
    const revoked = caller("manager", {
      permissionsOverride: { reports: "FULL", treasury: "NONE" },
    });

    await expect(
      revoked.dailyCashReconciliation({ branchId: 1, businessDate: DATE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(revoked.recordDailyTreasuryCount(invalidCount)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      revoked.closeDailyCashReconciliation({
        reconciliationId: 1,
        expectedVersion: 1,
        clientRequestId: "treasury-daily-authority-close",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      revoked.reopenDailyCashReconciliation({
        reconciliationId: 1,
        expectedVersion: 1,
        reason: "سبب إداري موثق لإعادة فتح المطابقة اليومية",
        clientRequestId: "treasury-daily-authority-reopen",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets an explicit treasury FULL grant reach validation without widening reports", async () => {
    const granted = caller("user", {
      permissionsOverride: { treasury: "FULL", reports: "NONE" },
    });
    await expect(granted.recordDailyTreasuryCount(invalidCount)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      granted.dailyCashReconciliation({ branchId: 1, businessDate: DATE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects cross-branch daily reads and writes for a branch manager", async () => {
    const manager = caller("manager", { branchId: 1 });
    await expect(
      manager.dailyCashReconciliation({ branchId: 2, businessDate: DATE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      manager.recordDailyTreasuryCount({ ...invalidCount, branchId: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
