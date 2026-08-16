import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = { kind: "year-end-test-tx" };
  return {
    tx,
    withTx: vi.fn(async (work: (value: unknown) => unknown) => work(tx)),
    closeYear: vi.fn(async () => ({
      snapshotId: 91,
      retainedEarningsEntryId: 92,
      periodLockId: 93,
      certificateId: 94,
      certificateNumber: "MC-2025-12-R01",
      year: 2025,
      branchId: null,
      totalRevenue: "1000.00",
      totalCogs: "400.00",
      totalExpenses: "100.00",
      netProfit: "500.00",
    })),
    listSnapshots: vi.fn(async () => []),
    listYearEndReopenRequests: vi.fn(async () => []),
    requestYearEndReopen: vi.fn(async () => ({
      id: 101,
      year: 2025,
      snapshotId: 91,
      certificateId: 94,
      periodId: 93,
      status: "PENDING_APPROVAL",
      requestPayloadHash: "a".repeat(64),
      replayed: false,
    })),
    approveYearEndReopen: vi.fn(async () => ({
      requestId: 101,
      year: 2025,
      snapshotId: 91,
      reversalEntryId: 102,
      reopenEventId: 103,
      nextRequiredMonth: "2025-12",
    })),
    rejectYearEndReopen: vi.fn(async () => ({
      requestId: 101,
      status: "REJECTED",
    })),
    logAuditTx: vi.fn(async () => undefined),
  };
});

vi.mock("../../services/tx", () => ({
  withTx: mocks.withTx,
  withGovernanceTx: mocks.withTx,
}));
vi.mock("../../services/yearEndService", () => ({
  closeYear: mocks.closeYear,
  listSnapshots: mocks.listSnapshots,
  listYearEndReopenRequests: mocks.listYearEndReopenRequests,
  requestYearEndReopen: mocks.requestYearEndReopen,
  approveYearEndReopen: mocks.approveYearEndReopen,
  rejectYearEndReopen: mocks.rejectYearEndReopen,
}));
vi.mock("../../services/auditService", () => ({
  logAuditTx: mocks.logAuditTx,
}));

import { yearEndRouter } from "../yearEndRouter";

type TestRole = "admin" | "manager" | "accountant";

function caller(role: TestRole) {
  return yearEndRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 41,
      role,
      branchId: role === "admin" ? null : 1,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("yearEndRouter close contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTx.mockImplementation(async (work: (value: unknown) => unknown) =>
      work(mocks.tx),
    );
  });

  it("retries the whole governed transaction after a deadlock", async () => {
    mocks.withTx
      .mockRejectedValueOnce({ code: "ER_LOCK_DEADLOCK" })
      .mockImplementationOnce(async (work: (value: unknown) => unknown) =>
        work(mocks.tx),
      );

    await expect(
      caller("admin").close({ year: 2025, requestId: 77 }),
    ).resolves.toMatchObject({ snapshotId: 91 });
    expect(mocks.withTx).toHaveBeenCalledTimes(2);
    expect(mocks.closeYear).toHaveBeenCalledTimes(1);
    expect(mocks.logAuditTx).toHaveBeenCalledTimes(1);
  });

  it("يمرّر طلب ديسمبر ويثبت النطاق الشركي ويسجل التدقيق داخل نفس المعاملة", async () => {
    const result = await caller("admin").close({
      year: 2025,
      requestId: 77,
    });

    expect(result.snapshotId).toBe(91);
    expect(mocks.withTx).toHaveBeenCalledTimes(1);
    expect(mocks.withTx).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.closeYear).toHaveBeenCalledWith(mocks.tx, {
      year: 2025,
      requestId: 77,
      branchId: null,
      closedBy: 41,
    });
    expect(mocks.logAuditTx).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({ user: expect.objectContaining({ id: 41 }) }),
      expect.objectContaining({
        action: "yearEnd.close",
        entityType: "yearEndSnapshot",
        entityId: 91,
        newValue: expect.objectContaining({
          year: 2025,
          branchId: null,
          requestId: 77,
          periodLockId: 93,
          certificateId: 94,
          certificateNumber: "MC-2025-12-R01",
        }),
      }),
    );
  });

  it("يرفض الحمولة التي لا تحمل requestId قبل دخول المعاملة", async () => {
    await expect(
      caller("admin").close({ year: 2025 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.withTx).not.toHaveBeenCalled();
    expect(mocks.closeYear).not.toHaveBeenCalled();
  });

  it("يرفض عقد العميل القديم الذي يطلب فرعاً كي لا يتحول صامتاً إلى إقفال الشركة", async () => {
    await expect(
      caller("admin").close({
        year: 2025,
        requestId: 77,
        branchId: 9,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.withTx).not.toHaveBeenCalled();
  });

  it.each(["manager", "accountant"] as const)(
    "يرفض الدور %s عن اعتماد الإقفال السنوي",
    async (role) => {
      await expect(
        caller(role).close({ year: 2025, requestId: 77 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.closeYear).not.toHaveBeenCalled();
    },
  );

  it("يتيح سجل الإقفالات للمدير صانع الطلب ويحجبه عن قارئ بلا reports:FULL", async () => {
    await expect(caller("manager").list()).resolves.toEqual({ rows: [] });
    await expect(caller("accountant").list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(1);
  });

  it("لا ينجح المسار إذا فشل سجل التدقيق الذري", async () => {
    mocks.logAuditTx.mockRejectedValueOnce(new Error("audit write failed"));
    await expect(
      caller("admin").close({ year: 2025, requestId: 77 }),
    ).rejects.toThrow("audit write failed");
    expect(mocks.closeYear).toHaveBeenCalledTimes(1);
  });

  it("يسمح للمدير بطلب فتح أحدث لقطة ويسجل الطلب ذرياً بلا أثر مالي", async () => {
    const result = await caller("manager").requestReopen({
      snapshotId: 91,
      reason: "تصحيح قيد مثبت بعد الإقفال",
      clientRequestId: "year-reopen-request-001",
    });

    expect(result).toMatchObject({ id: 101, status: "PENDING_APPROVAL" });
    expect(mocks.requestYearEndReopen).toHaveBeenCalledWith(mocks.tx, {
      snapshotId: 91,
      reason: "تصحيح قيد مثبت بعد الإقفال",
      clientRequestId: "year-reopen-request-001",
      requestedBy: 41,
    });
    expect(mocks.logAuditTx).toHaveBeenCalledWith(
      mocks.tx,
      expect.anything(),
      expect.objectContaining({
        action: "yearEnd.reopen.request",
        entityType: "yearEndReopenRequest",
        entityId: 101,
      }),
    );
  });

  it("يعيد الطلب المطابق بلا سجل تدقيق جديد", async () => {
    mocks.requestYearEndReopen.mockResolvedValueOnce({
      id: 101,
      year: 2025,
      snapshotId: 91,
      certificateId: 94,
      periodId: 93,
      status: "PENDING_APPROVAL",
      requestPayloadHash: "a".repeat(64),
      replayed: true,
    });

    const result = await caller("manager").requestReopen({
      snapshotId: 91,
      reason: "تصحيح قيد مثبت بعد الإقفال",
      clientRequestId: "year-reopen-request-001",
    });

    expect(result.replayed).toBe(true);
    expect(mocks.logAuditTx).not.toHaveBeenCalled();
    expect(mocks.withTx).toHaveBeenCalledWith(expect.any(Function));
  });

  it("يحصر اعتماد/رفض الفتح بالأدمن ويثبت القيد العكسي في audit داخل tx", async () => {
    await expect(
      caller("manager").approveReopen({
        requestId: 101,
        decisionReason: "الدليل صحيح",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const result = await caller("admin").approveReopen({
      requestId: 101,
      decisionReason: "الدليل صحيح",
    });
    expect(result.reversalEntryId).toBe(102);
    expect(mocks.approveYearEndReopen).toHaveBeenCalledWith(mocks.tx, {
      requestId: 101,
      decisionReason: "الدليل صحيح",
      decidedBy: 41,
    });
    expect(mocks.logAuditTx).toHaveBeenCalledWith(
      mocks.tx,
      expect.anything(),
      expect.objectContaining({
        action: "yearEnd.reopen.approve",
        newValue: expect.objectContaining({
          reversalEntryId: 102,
          reopenEventId: 103,
        }),
      }),
    );
  });

  it("يعيد معاملة اعتماد الفتح كاملة عند deadlock ولا يكرر audit خارج النجاح", async () => {
    mocks.withTx
      .mockRejectedValueOnce({ code: "ER_LOCK_DEADLOCK" })
      .mockImplementationOnce(async (work: (value: unknown) => unknown) =>
        work(mocks.tx),
      );

    await caller("admin").approveReopen({
      requestId: 101,
      decisionReason: "اعتماد الدليل",
    });
    expect(mocks.withTx).toHaveBeenCalledTimes(2);
    expect(mocks.approveYearEndReopen).toHaveBeenCalledTimes(1);
    expect(mocks.logAuditTx).toHaveBeenCalledTimes(1);
  });
});
