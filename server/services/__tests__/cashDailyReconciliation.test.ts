import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  closeDailyCashReconciliation,
  getDailyCashReconciliation,
  recordDailyTreasuryCount,
  reopenDailyCashReconciliation,
} from "../cashDailyReconciliationService";
import { openShift } from "../shiftService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const MANAGER = 71;
const CHECKER = 72;
const REOPENER = 73;
const TEST_NOW = new Date("2026-08-31T12:00:00.000Z");
const DATE = "2026-08-31";

function actor(userId: number) {
  return { userId, branchId: 1, role: "manager" as const };
}

function auditCtx(userId: number) {
  return {
    userId,
    branchId: 1,
    ipAddress: "127.0.0.1",
    screenPath: "/treasury/day-close",
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TEST_NOW);
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "auditLogs",
    "idempotencyKeys",
    "cashVarianceCaseEvents",
    "cashVarianceCases",
    "advanceSettlements",
    "employeeAdvances",
    "cashDailyReconciliations",
    "cashCustodyCounts",
    "cashTransfers",
    "accountingEntries",
    "receipts",
    "shifts",
    "users",
    "branches",
  ]) await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Second", code: "SECOND", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: MANAGER, openId: "daily-manager", name: "Counter", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CHECKER, openId: "daily-checker", name: "Checker", role: "manager", loginMethod: "local", branchId: 1 },
    { id: REOPENER, openId: "daily-reopener", name: "Reopener", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "100000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-DAILY-TREASURY",
    createdBy: MANAGER,
    createdAt: TEST_NOW,
    approvedAt: TEST_NOW,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("daily physical treasury reconciliation", () => {
  it("records a matched count idempotently and requires a second manager to close", async () => {
    const initial = await getDailyCashReconciliation({ branchId: 1, businessDate: DATE }, actor(MANAGER));
    expect(initial.expectedTreasuryCash).toBe("100000.00");
    expect(initial.actions.canCount).toBe(true);

    const counted = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "100000.00",
        countedBreakdown: { "50000": 2 },
        expectedVersion: 0,
        clientRequestId: "daily-count-1",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    expect(counted).toMatchObject({ status: "MATCHED", variance: "0.00", idempotent: false });

    const replay = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "100000.00",
        countedBreakdown: { "50000": 2 },
        expectedVersion: Number(counted.version),
        clientRequestId: "daily-count-1",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    expect(replay.idempotent).toBe(true);

    await expect(
      closeDailyCashReconciliation(
        { reconciliationId: Number(counted.id), expectedVersion: Number(counted.version), clientRequestId: "daily-close-self" },
        actor(MANAGER),
        auditCtx(MANAGER),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const closed = await closeDailyCashReconciliation(
      { reconciliationId: Number(counted.id), expectedVersion: Number(counted.version), clientRequestId: "daily-close-1" },
      actor(CHECKER),
      auditCtx(CHECKER),
    );
    expect(closed.status).toBe("CLOSED");

    await expect(
      openShift(
        { branchId: 1, openingBalance: "0.00", shiftType: "RETAIL" },
        actor(MANAGER),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await reopenDailyCashReconciliation(
      {
        reconciliationId: Number(counted.id),
        expectedVersion: Number(closed.version),
        reason: "إعادة فتح اليوم لتسجيل حركة تشغيلية جديدة",
        clientRequestId: "daily-reopen-1",
      },
      actor(REOPENER),
      auditCtx(REOPENER),
    );
    await expect(
      openShift(
        { branchId: 1, openingBalance: "0.00", shiftType: "RETAIL" },
        actor(MANAGER),
      ),
    ).resolves.toMatchObject({ shiftId: expect.any(Number), treasuryBalanceAfter: null });
  });

  it("stores a physical variance without changing treasury cash", async () => {
    const counted = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "75000.00",
        countedBreakdown: { "50000": 1, "25000": 1 },
        expectedVersion: 0,
        clientRequestId: "daily-variance-1",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    expect(counted).toMatchObject({ status: "VARIANCE_OPEN", variance: "-25000.00" });
    const status = await getDailyCashReconciliation({ branchId: 1, businessDate: DATE }, actor(MANAGER));
    expect(status.expectedTreasuryCash).toBe("100000.00");
    expect(status.actions.canClose).toBe(false);
    expect(status.blockers.map((item) => item.code)).toContain("TREASURY_VARIANCE");
  });

  it("does not expose the pending custody amount through blind-count reconciliation evidence", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "87500.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "PENDING",
      approvalStatus: "APPROVED",
      referenceNumber: "CH-BLIND-DAILY-EVIDENCE",
      createdBy: CHECKER,
      createdAt: TEST_NOW,
    });

    const status = await getDailyCashReconciliation(
      { branchId: 1, businessDate: DATE },
      actor(MANAGER),
    );
    expect(status.blockers.map((item) => item.code)).toContain("PENDING_CUSTODY");
    expect(status.evidence).not.toHaveProperty("pendingCustodyCash");
    expect(status.currentEvidence).not.toHaveProperty("pendingCustodyCash");
    expect(JSON.stringify(status)).not.toContain("87500.00");
  });

  it("blocks a drawer custody source that has no matching treasury target", async () => {
    const inserted = await db().insert(s.shifts).values({
      branchId: 1,
      userId: MANAGER,
      openingBalance: "25000.00",
      status: "CLOSED",
      shiftType: "RETAIL",
      openedAt: TEST_NOW,
      closedAt: TEST_NOW,
      countedCash: "25000.00",
      expectedCash: "25000.00",
      variance: "0.00",
      reconciliationStatus: "MATCHED",
    });
    const shiftId = Number((inserted as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId,
      direction: "OUT",
      amount: "25000.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "CH-UNPAIRED-SOURCE",
      createdBy: MANAGER,
      createdAt: TEST_NOW,
    });

    const blocked = await getDailyCashReconciliation(
      { branchId: 1, businessDate: DATE },
      actor(MANAGER),
    );
    expect(blocked.blockers.map((item) => item.code)).toContain("PENDING_CUSTODY");
    expect(blocked.actions.canCount).toBe(false);
  });

  it("blocks counting and closing while interbranch cash is in transit", async () => {
    const cleanCount = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "100000.00",
        countedBreakdown: { "50000": 2 },
        expectedVersion: 0,
        clientRequestId: "position-blocker-clean-count",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "10000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "CT-DAILY-BLOCKER",
      createdBy: MANAGER,
      createdAt: TEST_NOW,
      approvedAt: TEST_NOW,
    });
    const sentReceipt = (await db().select({ id: s.receipts.id }).from(s.receipts)
      .where(sql`${s.receipts.referenceNumber} = 'CT-DAILY-BLOCKER'`).limit(1))[0]!;
    await db().insert(s.cashTransfers).values({
      transferNumber: "CT-DAILY-BLOCKER",
      fromBranchId: 1,
      toBranchId: 2,
      amount: "10000.00",
      status: "IN_TRANSIT",
      sentBy: MANAGER,
      sentReceiptId: Number(sentReceipt.id),
      sentAt: TEST_NOW,
    });

    const blocked = await getDailyCashReconciliation({ branchId: 1, businessDate: DATE }, actor(MANAGER));
    expect(blocked.blockers.map((item) => item.code)).toContain("CASH_IN_TRANSIT");
    expect(blocked.actions.canCount).toBe(false);

    await expect(recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "90000.00",
        countedBreakdown: { "50000": 1, "10000": 4 },
        expectedVersion: Number(cleanCount.version),
        clientRequestId: "position-blocker-recount",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // نحاكي شهادة قديمة سُجّلت قبل إضافة العائق كي نثبت أن الإقفال نفسه محمي أيضاً.
    await db().update(s.cashDailyReconciliations).set({
      expectedTreasuryCash: blocked.evidence.expectedTreasuryCash,
      countedTreasuryCash: blocked.evidence.expectedTreasuryCash,
      variance: "0.00",
      evidenceHash: blocked.evidence.evidenceHash,
      status: "MATCHED",
    }).where(sql`${s.cashDailyReconciliations.id} = ${Number(cleanCount.id)}`);
    await expect(closeDailyCashReconciliation(
      {
        reconciliationId: Number(cleanCount.id),
        expectedVersion: Number(cleanCount.version),
        clientRequestId: "position-blocker-close",
      },
      actor(CHECKER),
      auditCtx(CHECKER),
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("blocks the treasury certificate while a closed drawer retains cash", async () => {
    await db().insert(s.shifts).values({
      branchId: 1,
      userId: MANAGER,
      openingBalance: "25000.00",
      status: "CLOSED",
      shiftType: "RETAIL",
      openedAt: TEST_NOW,
      closedAt: TEST_NOW,
      countedCash: "25000.00",
      expectedCash: "25000.00",
      variance: "0.00",
      reconciliationStatus: "MATCHED",
    });

    const blocked = await getDailyCashReconciliation({ branchId: 1, businessDate: DATE }, actor(MANAGER));
    expect(blocked.blockers.map((item) => item.code)).toContain("RESIDUAL_DRAWER_CASH");
    expect(blocked.actions.canCount).toBe(false);
    await expect(recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "100000.00",
        countedBreakdown: { "50000": 2 },
        expectedVersion: 0,
        clientRequestId: "residual-drawer-blocker-count",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("blocks a legacy closed shift whose closing timestamp is unknown", async () => {
    await db().insert(s.shifts).values({
      branchId: 1,
      userId: MANAGER,
      openingBalance: "0.00",
      status: "CLOSED",
      shiftType: "RETAIL",
      openedAt: new Date("2026-08-30T09:00:00.000Z"),
      closedAt: null,
      countedCash: "0.00",
      expectedCash: "0.00",
      variance: "0.00",
      reconciliationStatus: "MATCHED",
    });

    const blocked = await getDailyCashReconciliation(
      { branchId: 1, businessDate: DATE },
      actor(MANAGER),
    );
    expect(blocked.blockers.map((item) => item.code)).toContain("RESIDUAL_DRAWER_CASH");
    expect(blocked.actions.canCount).toBe(false);
  });

  it("blocks the treasury certificate while materialized cash is unscoped", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      direction: "IN",
      amount: "5000.00",
      paymentMethod: "CASH",
      cashBucket: null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "DAILY-UNSCOPED-CASH",
      createdBy: MANAGER,
      createdAt: TEST_NOW,
    });

    const blocked = await getDailyCashReconciliation({ branchId: 1, businessDate: DATE }, actor(MANAGER));
    expect(blocked.blockers.map((item) => item.code)).toContain("UNSCOPED_CASH");
    expect(blocked.actions.canCount).toBe(false);
  });

  it("reopens with optimistic concurrency and never lets an old replay reopen a newer certificate", async () => {
    const counted = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "100000.00",
        countedBreakdown: { "50000": 2 },
        expectedVersion: 0,
        clientRequestId: "reopen-contract-count-1",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    const closed = await closeDailyCashReconciliation(
      {
        reconciliationId: Number(counted.id),
        expectedVersion: Number(counted.version),
        clientRequestId: "reopen-contract-close-1",
      },
      actor(CHECKER),
      auditCtx(CHECKER),
    );

    await expect(
      reopenDailyCashReconciliation(
        {
          reconciliationId: Number(closed.id),
          expectedVersion: Number(closed.version) - 1,
          reason: "محاولة إعادة فتح بنسخة شهادة قديمة",
          clientRequestId: "reopen-contract-stale",
        },
        actor(REOPENER),
        auditCtx(REOPENER),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const reopenInput = {
      reconciliationId: Number(closed.id),
      expectedVersion: Number(closed.version),
      reason: "إعادة فتح موثقة لإجراء جرد تشغيلي جديد",
      clientRequestId: "reopen-contract-request-1",
    };
    const [firstAttempt, secondAttempt] = await Promise.all([
      reopenDailyCashReconciliation(reopenInput, actor(REOPENER), auditCtx(REOPENER)),
      reopenDailyCashReconciliation(reopenInput, actor(REOPENER), auditCtx(REOPENER)),
    ]);
    const reopened = [firstAttempt, secondAttempt].find((result) => !result.idempotent);
    const immediateReplay = [firstAttempt, secondAttempt].find((result) => result.idempotent);
    expect(reopened).toMatchObject({
      status: "REOPENED",
      version: Number(closed.version) + 1,
      idempotent: false,
    });
    expect(immediateReplay).toMatchObject({
      status: "REOPENED",
      version: Number(reopened?.version),
      idempotent: true,
    });

    await expect(
      reopenDailyCashReconciliation(
        { ...reopenInput, reason: "سبب مختلف على المفتاح نفسه يجب رفضه" },
        actor(REOPENER),
        auditCtx(REOPENER),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const recounted = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "100000.00",
        countedBreakdown: { "50000": 2 },
        expectedVersion: Number(reopened?.version),
        clientRequestId: "reopen-contract-count-2",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    const newerClosed = await closeDailyCashReconciliation(
      {
        reconciliationId: Number(recounted.id),
        expectedVersion: Number(recounted.version),
        clientRequestId: "reopen-contract-close-2",
      },
      actor(CHECKER),
      auditCtx(CHECKER),
    );

    const oldReplay = await reopenDailyCashReconciliation(
      reopenInput,
      actor(REOPENER),
      auditCtx(REOPENER),
    );
    expect(oldReplay).toMatchObject({
      status: "CLOSED",
      version: Number(newerClosed.version),
      reopenedVersion: Number(closed.version) + 1,
      idempotent: true,
    });
    const persisted = await db().query.cashDailyReconciliations.findFirst({
      where: (table, { eq }) => eq(table.id, Number(closed.id)),
    });
    expect(persisted).toMatchObject({ status: "CLOSED", version: Number(newerClosed.version) });

    const auditRows = await db()
      .select()
      .from(s.auditLogs)
      .where(sql`${s.auditLogs.action} = 'treasury.dailyCash.reopen'`);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ userId: REOPENER, entityId: String(closed.id) });
    expect(auditRows[0]?.oldValue).toMatchObject({ status: "CLOSED", version: Number(closed.version) });
    expect(auditRows[0]?.newValue).toMatchObject({
      status: "REOPENED",
      version: Number(closed.version) + 1,
      clientRequestId: reopenInput.clientRequestId,
    });
  });

  it("attributes a delayed maker-checker receipt to its approval day, not its creation day", async () => {
    await db().delete(s.receipts);
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "IN",
        amount: "50000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "TEST-DELAYED-APPROVAL-DAY",
        createdBy: MANAGER,
        approvedBy: CHECKER,
        createdAt: new Date("2026-07-31T23:30:00.000Z"),
        approvedAt: new Date("2026-08-01T00:30:00.000Z"),
      });

    const creationDay = await getDailyCashReconciliation(
      { branchId: 1, businessDate: "2026-07-31" },
      actor(MANAGER),
    );
    const approvalDay = await getDailyCashReconciliation(
      { branchId: 1, businessDate: "2026-08-01" },
      actor(MANAGER),
    );

    expect(creationDay.expectedTreasuryCash).toBe("0.00");
    expect(approvalDay.expectedTreasuryCash).toBe("50000.00");
  });

  it("rejects a delayed stale recount instead of overwriting a newer physical count", async () => {
    const first = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "100000.00",
        countedBreakdown: { "50000": 2 },
        notes: "first",
        expectedVersion: 0,
        clientRequestId: "daily-stale-a",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    const second = await recordDailyTreasuryCount(
      {
        branchId: 1,
        businessDate: DATE,
        countedCash: "75000.00",
        countedBreakdown: { "50000": 1, "25000": 1 },
        notes: "second",
        expectedVersion: Number(first.version),
        clientRequestId: "daily-stale-b",
      },
      actor(MANAGER),
      auditCtx(MANAGER),
    );
    expect(second.version).toBe(2);

    await expect(
      recordDailyTreasuryCount(
        {
          branchId: 1,
          businessDate: DATE,
          countedCash: "100000.00",
          countedBreakdown: { "50000": 2 },
          notes: "first",
          expectedVersion: Number(first.version),
          clientRequestId: "daily-stale-a-delayed",
        },
        actor(MANAGER),
        auditCtx(MANAGER),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
