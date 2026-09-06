import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = { kind: "period-lock-retry-test-tx" };
  return {
    tx,
    withTx: vi.fn(async (work: (value: unknown) => unknown) => work(tx)),
    requestMonthClose: vi.fn(async () => ({ id: 31, month: "2025-11" })),
    approveMonthClose: vi.fn(async () => ({
      month: "2025-11",
      revision: 1,
      periodId: 32,
      certificateId: 33,
      certificateNumber: "MC-2025-11-R01",
      cutoffDate: "2025-11-30",
    })),
    logAuditTx: vi.fn(async () => undefined),
  };
});

vi.mock("../../services/tx", () => ({
  withTx: mocks.withTx,
  withGovernanceTx: mocks.withTx,
}));
vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  logAuditTx: mocks.logAuditTx,
}));
vi.mock("../../services/reports/monthCloseRequest", () => ({
  requestMonthClose: mocks.requestMonthClose,
  approveMonthClose: mocks.approveMonthClose,
  getCompanyCloseActionReadiness: vi.fn(),
  listMonthCloseRequests: vi.fn(),
  rejectMonthClose: vi.fn(),
}));
vi.mock("../../services/periodLockService", () => ({
  getActiveLock: vi.fn(),
  unlockLatestPeriod: vi.fn(),
}));
vi.mock("../../services/reports/monthCloseCertificate", () => ({
  certificateExportRows: vi.fn(),
  getMonthCloseCertificate: vi.fn(),
  listMonthCloseCertificates: vi.fn(),
  verifyMonthCloseCertificate: vi.fn(),
}));
vi.mock("../../services/reports/monthCloseSequence", () => ({
  bootstrapMonthCloseSequence: vi.fn(),
  getMonthCloseSequence: vi.fn(),
  listSequenceEvents: vi.fn(),
}));
vi.mock("../../auth/password", () => ({ verifyPassword: vi.fn() }));

import { periodLockRouter } from "../periodLockRouter";

function caller(role: "admin" | "manager") {
  return periodLockRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: role === "admin" ? 9 : 8,
      role,
      branchId: role === "admin" ? null : 1,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("periodLockRouter governed transaction retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTx.mockImplementation(async (work: (value: unknown) => unknown) =>
      work(mocks.tx),
    );
  });

  it("retries the entire close request transaction after a lock timeout", async () => {
    mocks.withTx
      .mockRejectedValueOnce({ code: "ER_LOCK_WAIT_TIMEOUT" })
      .mockImplementationOnce(async (work: (value: unknown) => unknown) =>
        work(mocks.tx),
      );

    await expect(
      caller("manager").requestClose({ month: "2025-11" }),
    ).resolves.toMatchObject({ id: 31 });

    expect(mocks.withTx).toHaveBeenCalledTimes(2);
    expect(mocks.requestMonthClose).toHaveBeenCalledTimes(1);
    expect(mocks.logAuditTx).toHaveBeenCalledTimes(1);
    expect(mocks.withTx).toHaveBeenCalledWith(expect.any(Function));
  });

  it("retries close approval atomically and writes both audits only on success", async () => {
    mocks.withTx
      .mockRejectedValueOnce({ code: "ER_LOCK_DEADLOCK" })
      .mockImplementationOnce(async (work: (value: unknown) => unknown) =>
        work(mocks.tx),
      );

    await expect(
      caller("admin").approveClose({ requestId: 31 }),
    ).resolves.toMatchObject({ certificateId: 33 });

    expect(mocks.withTx).toHaveBeenCalledTimes(2);
    expect(mocks.approveMonthClose).toHaveBeenCalledTimes(1);
    expect(mocks.logAuditTx).toHaveBeenCalledTimes(2);
    expect(mocks.withTx).toHaveBeenCalledWith(expect.any(Function));
  });

  it("writes approval and lock audits when the owner's close request is auto-approved", async () => {
    mocks.requestMonthClose.mockResolvedValueOnce({
      id: 31,
      month: "2025-11",
      autoApproval: {
        month: "2025-11",
        revision: 1,
        periodId: 32,
        certificateId: 33,
        certificateNumber: "MC-2025-11-R01",
        cutoffDate: "2025-11-30",
      },
    } as never);

    await caller("admin").requestClose({ month: "2025-11" });

    expect(mocks.logAuditTx).toHaveBeenCalledTimes(3);
    expect(mocks.logAuditTx.mock.calls.map((call) => call[2]?.action)).toEqual([
      "period.close_request",
      "period.close_approve",
      "period.lock",
    ]);
  });

  it("never retries non-lock failures", async () => {
    mocks.withTx.mockRejectedValueOnce(new Error("audit storage failed"));

    await expect(
      caller("manager").requestClose({ month: "2025-11" }),
    ).rejects.toThrow("audit storage failed");
    expect(mocks.withTx).toHaveBeenCalledTimes(1);
  });
});
