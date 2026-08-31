import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
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
const DATE = new Date().toISOString().slice(0, 10);

function actor(userId: number) {
  return { userId, branchId: 1, role: "manager" as const };
}

function auditCtx(userId: number) {
  return {
    user: { id: userId, branchId: 1, role: "manager", name: `manager-${userId}` },
    req: { headers: {} },
  } as any;
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "auditLogs",
    "cashVarianceCaseEvents",
    "cashVarianceCases",
    "advanceSettlements",
    "employeeAdvances",
    "cashDailyReconciliations",
    "cashCustodyCounts",
    "accountingEntries",
    "receipts",
    "shifts",
    "users",
    "branches",
  ]) await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: MANAGER, openId: "daily-manager", name: "Counter", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CHECKER, openId: "daily-checker", name: "Checker", role: "manager", loginMethod: "local", branchId: 1 },
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
  });
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
      { reconciliationId: Number(counted.id), reason: "إعادة فتح اليوم لتسجيل حركة تشغيلية جديدة" },
      actor(MANAGER),
      auditCtx(MANAGER),
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
