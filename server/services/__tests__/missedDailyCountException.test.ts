import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  decideMissedDailyCountException,
  requestMissedDailyCountException,
} from "../cash/missedDailyCountException";
import { recordDailyTreasuryCount } from "../cashDailyReconciliationService";
import { getMonthCloseReadiness } from "../reports/monthCloseReadiness";
import { truncateTables } from "./__testUtils__";

const MISSED_DAY = "2026-07-20";
const CARRY_DAY = "2026-07-21";
const REQUESTER = 801;
const REVIEWER = 802;
const OTHER_BRANCH_MANAGER = 803;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function actor(userId: number, branchId = 1) {
  return { userId, branchId, role: "manager" as const };
}

function auditCtx(userId: number, branchId = 1) {
  return {
    userId,
    branchId,
    ipAddress: "127.0.0.1",
    screenPath: "/treasury/day-close",
  };
}

async function readinessCount() {
  const readiness = await getMonthCloseReadiness({
    month: "2026-07",
    branchId: 1,
  });
  return readiness.items.find(
    (item) => item.key === "unclosedDailyCashReconciliations",
  );
}

let carryId = 0;

beforeEach(async () => {
  await truncateTables([
    "auditLogs",
    "cashMissedDailyCountExceptionEvents",
    "cashMissedDailyCountExceptions",
    "cashVarianceCaseEvents",
    "cashVarianceCases",
    "cashDailyReconciliations",
    "cashCustodyCounts",
    "accountingEntries",
    "receipts",
    "shifts",
    "users",
    "branches",
  ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: REQUESTER,
        openId: "missed-count-requester",
        name: "طالب الاستثناء",
        role: "manager",
        branchId: 1,
        loginMethod: "local",
      },
      {
        id: REVIEWER,
        openId: "missed-count-reviewer",
        name: "مراجع الاستثناء",
        role: "manager",
        branchId: 1,
        loginMethod: "local",
      },
      {
        id: OTHER_BRANCH_MANAGER,
        openId: "missed-count-other-branch",
        name: "مدير فرع آخر",
        role: "manager",
        branchId: 2,
        loginMethod: "local",
      },
    ]);
  await db()
    .insert(s.receipts)
    .values([
      {
        branchId: 1,
        direction: "IN",
        amount: "1000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "MISSED-DAY-IN",
        createdBy: REQUESTER,
        approvedBy: REVIEWER,
        createdAt: new Date(`${MISSED_DAY}T08:00:00.000Z`),
        approvedAt: new Date(`${MISSED_DAY}T08:00:00.000Z`),
      },
      {
        branchId: 1,
        direction: "OUT",
        amount: "1000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "CARRY-DAY-OUT",
        createdBy: REQUESTER,
        approvedBy: REVIEWER,
        createdAt: new Date(`${CARRY_DAY}T08:00:00.000Z`),
        approvedAt: new Date(`${CARRY_DAY}T08:00:00.000Z`),
      },
    ]);
  carryId = extractInsertId(
    await db()
      .insert(s.cashDailyReconciliations)
      .values({
        branchId: 1,
        businessDate: CARRY_DAY,
        expectedTreasuryCash: "0.00",
        countedTreasuryCash: "0.00",
        variance: "0.00",
        status: "CLOSED",
        lastClientRequestId: "carry-count",
        closeClientRequestId: "carry-close",
        evidenceHash: "c".repeat(64),
        countedByUserId: REQUESTER,
        countedAt: new Date(`${CARRY_DAY}T20:00:00.000Z`),
        closedByUserId: REVIEWER,
        closedAt: new Date(`${CARRY_DAY}T20:05:00.000Z`),
        version: 1,
      }),
  );
});

describe("MISSED_DAILY_COUNT zero-effect exception", () => {
  it("keeps the month blocked for PENDING, enforces maker-checker, and exempts only APPROVED", async () => {
    expect(await readinessCount()).toMatchObject({ status: "BLOCK", count: 1 });

    const request = await requestMissedDailyCountException(
      {
        branchId: 1,
        businessDate: MISSED_DAY,
        carryForwardReconciliationId: carryId,
        reason: "تعذر تنفيذ الجرد المادي بسبب انقطاع الموقع بعد انتهاء العمل",
        evidenceReference: "incident://cash-room/2026-07-20",
        clientRequestId: "missed-count-request-1",
      },
      actor(REQUESTER),
      auditCtx(REQUESTER),
    );
    expect(request).toMatchObject({ status: "PENDING", version: 1 });
    expect(await readinessCount()).toMatchObject({ status: "BLOCK", count: 1 });

    await expect(
      decideMissedDailyCountException(
        {
          exceptionId: Number(request.id),
          expectedVersion: 1,
          decision: "APPROVED",
          note: "راجعت المحضر وبصمة المطابقة المرحّلة",
          clientRequestId: "missed-count-self-approval",
        },
        actor(REQUESTER),
        auditCtx(REQUESTER),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const approved = await decideMissedDailyCountException(
      {
        exceptionId: Number(request.id),
        expectedVersion: 1,
        decision: "APPROVED",
        note: "راجعت المحضر وبصمة المطابقة المرحّلة",
        clientRequestId: "missed-count-approval-1",
      },
      actor(REVIEWER),
      auditCtx(REVIEWER),
    );
    expect(approved).toMatchObject({ status: "APPROVED", version: 2 });
    expect(await readinessCount()).toMatchObject({ status: "OK", count: 0 });

    const [receiptCount] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.receipts);
    const [entryCount] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.accountingEntries);
    const events = await db()
      .select()
      .from(s.cashMissedDailyCountExceptionEvents)
      .where(
        eq(
          s.cashMissedDailyCountExceptionEvents.exceptionId,
          Number(request.id),
        ),
      );
    expect(Number(receiptCount.n)).toBe(2);
    expect(Number(entryCount.n)).toBe(0);
    expect(events.map((event) => event.eventType)).toEqual([
      "PROPOSED",
      "APPROVED",
    ]);
    expect(events.every((event) => event.payloadHash.length === 64)).toBe(true);
  });

  it("rejects approval when the closed carry-forward version becomes stale", async () => {
    const request = await requestMissedDailyCountException(
      {
        branchId: 1,
        businessDate: MISSED_DAY,
        carryForwardReconciliationId: carryId,
        reason: "تعذر تنفيذ الجرد المادي بسبب إغلاق الموقع الطارئ",
        evidenceReference: "incident://cash-room/stale-carry",
        clientRequestId: "missed-count-request-stale",
      },
      actor(REQUESTER),
      auditCtx(REQUESTER),
    );
    await db()
      .update(s.cashDailyReconciliations)
      .set({ version: 2 })
      .where(eq(s.cashDailyReconciliations.id, carryId));

    await expect(
      decideMissedDailyCountException(
        {
          exceptionId: Number(request.id),
          expectedVersion: 1,
          decision: "APPROVED",
          note: "محاولة اعتماد دليل ترحيل تغيّر إصداره",
          clientRequestId: "missed-count-approval-stale",
        },
        actor(REVIEWER),
        auditCtx(REVIEWER),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readinessCount()).toMatchObject({ status: "BLOCK", count: 1 });
  });

  it("is payload-aware idempotent and branch scoped", async () => {
    const input = {
      branchId: 1,
      businessDate: MISSED_DAY,
      carryForwardReconciliationId: carryId,
      reason: "تعذر تنفيذ الجرد المادي بسبب إغلاق الموقع الطارئ",
      evidenceReference: "incident://cash-room/idempotent",
      clientRequestId: "missed-count-request-idempotent",
    };
    const first = await requestMissedDailyCountException(
      input,
      actor(REQUESTER),
      auditCtx(REQUESTER),
    );
    const replay = await requestMissedDailyCountException(
      input,
      actor(REQUESTER),
      auditCtx(REQUESTER),
    );
    expect(Number(replay.id)).toBe(Number(first.id));
    expect(replay.idempotent).toBe(true);
    await expect(
      requestMissedDailyCountException(
        {
          ...input,
          reason: "سبب مختلف يحمل مفتاح المحاولة نفسه ولا يجوز قبوله",
        },
        actor(REQUESTER),
        auditCtx(REQUESTER),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      requestMissedDailyCountException(
        { ...input, clientRequestId: "missed-count-other-branch" },
        actor(OTHER_BRANCH_MANAGER, 2),
        auditCtx(OTHER_BRANCH_MANAGER, 2),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("never permits recordDailyTreasuryCount to fabricate a historical count", async () => {
    await expect(
      recordDailyTreasuryCount(
        {
          branchId: 1,
          businessDate: MISSED_DAY,
          countedCash: "1000.00",
          countedBreakdown: { "1000": 1 },
          expectedVersion: 0,
          clientRequestId: "forbidden-historical-count",
        },
        actor(REQUESTER),
        auditCtx(REQUESTER),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const historical = await db()
      .select()
      .from(s.cashDailyReconciliations)
      .where(eq(s.cashDailyReconciliations.businessDate, MISSED_DAY));
    expect(historical).toHaveLength(0);
  });
});
