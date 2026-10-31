import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  applyHistoricalAdvanceRecoveries,
  applyHistoricalAdvanceRecoveriesTx,
  historicalAdvanceRecoveryApplySourceHash,
  historicalAdvanceRecoveryReverseSourceHash,
  lockUntouchedEmployeeAdvanceForCancellationTx,
  parseHistoricalAdvanceRecoveryApplyPlan,
  reverseHistoricalAdvanceRecoveries,
  type HistoricalAdvanceRecoveryApplyPlan,
  type HistoricalAdvanceRecoveryApplyPlanBase,
  type HistoricalAdvanceRecoveryReversePlan,
  type HistoricalAdvanceRecoveryReversePlanBase,
} from "../advances";
import { sumMoney, toDbMoney } from "../money";
import { withTx } from "../tx";

const OWNER = { userId: 1, branchId: 1, role: "admin" };
const NON_OWNER = { userId: 2, branchId: 1, role: "manager" };
const NOW = new Date("2026-10-31T12:00:00.000Z");
const PRIOR_TO_PERIOD = "2026-10";
const EVIDENCE_HASH = createHash("sha256")
  .update("owner-attestation:all-prior-advances-recovered", "utf8")
  .digest("hex");

const TABLES = [
  "employeeAdvanceHistoricalRecoveries",
  "advanceSettlements",
  "employeeAdvanceRepaymentAllocations",
  "terminationAdvanceAllocations",
  "employeeAdvances",
  "payrollItems",
  "payrollRuns",
  "accountingEntries",
  "receipts",
  "auditLogs",
  "doubleEntrySettings",
  "employees",
  "branches",
  "users",
];

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function reset(): Promise<void> {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES)
    await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed(): Promise<void> {
  const database = db();
  await database.insert(s.branches).values([
    { id: 1, name: "فرع 1", code: "HIST-1", type: "MAIN" },
    { id: 2, name: "فرع 2", code: "HIST-2", type: "SALES" },
  ]);
  await database.insert(s.users).values([
    {
      id: 1,
      openId: "historical-owner",
      name: "مالك الاختبار",
      role: "admin",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
    {
      id: 2,
      openId: "historical-non-owner",
      name: "غير مالك",
      role: "manager",
      branchId: 1,
      isOwner: false,
      isActive: true,
    },
  ]);
  await database.insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
  await database.insert(s.employees).values([
    {
      id: 10,
      branchId: 1,
      firstName: "موظف",
      lastName: "10",
      payType: "monthly",
      salary: "1000000.00",
    },
    {
      id: 20,
      branchId: 2,
      firstName: "موظف",
      lastName: "20",
      payType: "monthly",
      salary: "900000.00",
    },
  ]);
  await database.insert(s.receipts).values([
    {
      id: 501,
      branchId: 1,
      direction: "OUT",
      amount: "100000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      referenceNumber: "HIST-ADV-101",
      createdBy: 1,
      createdAt: new Date("2026-09-10T08:00:00.000Z"),
    },
    {
      id: 502,
      branchId: 1,
      direction: "OUT",
      amount: "50000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      referenceNumber: "HIST-ADV-102",
      createdBy: 1,
      createdAt: new Date("2026-09-11T08:00:00.000Z"),
    },
  ]);
  await database.insert(s.employeeAdvances).values([
    {
      id: 101,
      employeeId: 10,
      branchId: 1,
      amount: "100000.00",
      remaining: "100000.00",
      sourceType: "LEGACY_UNCLASSIFIED",
      payrollPeriod: null,
      status: "ACTIVE",
      receiptId: 501,
      createdBy: 1,
      grantedAt: new Date("2026-09-10T08:00:00.000Z"),
    },
    {
      id: 102,
      employeeId: 10,
      branchId: 1,
      amount: "50000.00",
      remaining: "50000.00",
      sourceType: "LEGACY_UNCLASSIFIED",
      payrollPeriod: null,
      status: "ACTIVE",
      receiptId: 502,
      createdBy: 1,
      grantedAt: new Date("2026-09-11T08:00:00.000Z"),
    },
    {
      id: 103,
      employeeId: 10,
      branchId: 1,
      amount: "25000.00",
      remaining: "25000.00",
      sourceType: "LEGACY_UNCLASSIFIED",
      payrollPeriod: null,
      status: "ACTIVE",
      receiptId: null,
      createdBy: 1,
      grantedAt: new Date("2026-10-01T08:00:00.000Z"),
    },
    {
      id: 105,
      employeeId: 10,
      branchId: 1,
      amount: "11000.00",
      remaining: "11000.00",
      sourceType: "LEGACY_UNCLASSIFIED",
      payrollPeriod: null,
      status: "ACTIVE",
      receiptId: null,
      createdBy: 1,
      grantedAt: new Date("2026-09-30T20:59:59.000Z"),
    },
    {
      id: 106,
      employeeId: 10,
      branchId: 1,
      amount: "12000.00",
      remaining: "12000.00",
      sourceType: "LEGACY_UNCLASSIFIED",
      payrollPeriod: null,
      status: "ACTIVE",
      receiptId: null,
      createdBy: 1,
      grantedAt: new Date("2026-09-30T21:00:00.000Z"),
    },
    {
      id: 107,
      employeeId: 10,
      branchId: 2,
      amount: "13000.00",
      remaining: "13000.00",
      sourceType: "LEGACY_UNCLASSIFIED",
      payrollPeriod: null,
      status: "ACTIVE",
      receiptId: null,
      createdBy: 1,
      grantedAt: new Date("2026-09-13T08:00:00.000Z"),
    },
  ]);
  await database.insert(s.payrollRuns).values({
    id: 701,
    period: "2026-10",
    branchId: null,
    status: "draft",
    employeeCount: 1,
    totalGross: "1000000.00",
    totalDeductions: "0.00",
    totalNet: "1000000.00",
    createdBy: 1,
  });
  await database.insert(s.payrollItems).values({
    id: 702,
    runId: 701,
    employeeId: 10,
    branchIdSnapshot: 1,
    payType: "monthly",
    gross: "1000000.00",
    deductions: "0.00",
    advanceDeduction: "0.00",
    net: "1000000.00",
  });
  await database.insert(s.accountingEntries).values({
    id: 801,
    entryType: "OPENING",
    branchId: 1,
    amount: "777.00",
    entryDate: new Date("2026-09-01T00:00:00.000Z"),
    dedupeKey: "HIST-UNCHANGED-GL",
    createdBy: 1,
  });
}

beforeEach(async () => {
  vi.setSystemTime(NOW);
  await reset();
  await seed();
});

afterAll(() => vi.useRealTimers());

async function makeApplyPlan(
  advanceIds: number[],
  batchKey: string,
): Promise<HistoricalAdvanceRecoveryApplyPlan> {
  const advances = await db()
    .select()
    .from(s.employeeAdvances)
    .where(inArray(s.employeeAdvances.id, advanceIds))
    .orderBy(asc(s.employeeAdvances.id));
  const base: HistoricalAdvanceRecoveryApplyPlanBase = {
    batchKey,
    evidenceKind: "OWNER_ATTESTATION",
    evidenceReference: "owner-attestation:2026-10-31:historical-advances-v1",
    evidenceHash: EVIDENCE_HASH,
    priorToPeriod: PRIOR_TO_PERIOD,
    totalAmount: toDbMoney(sumMoney(advances.map((row) => row.remaining))),
    rows: advances.map((row) => ({
      advanceId: Number(row.id),
      amount: toDbMoney(row.remaining),
      expected: {
        employeeId: Number(row.employeeId),
        branchId: Number(row.branchId),
        amount: toDbMoney(row.amount),
        remaining: toDbMoney(row.remaining),
        receiptId: row.receiptId === null ? null : Number(row.receiptId),
        grantedAt: row.grantedAt.toISOString(),
      },
    })),
  };
  return {
    ...base,
    sourceHash: historicalAdvanceRecoveryApplySourceHash(base),
  };
}

function makeReversePlan(
  applied: Awaited<ReturnType<typeof applyHistoricalAdvanceRecoveries>>,
  applyPlan: HistoricalAdvanceRecoveryApplyPlan,
  batchKey = "historical-reverse-1",
  reason = "إلغاء إقرار التسوية التاريخية بعد مراجعة المالك",
): HistoricalAdvanceRecoveryReversePlan {
  const base: HistoricalAdvanceRecoveryReversePlanBase = {
    batchKey,
    reason,
    totalAmount: applyPlan.totalAmount,
    rows: applyPlan.rows.map((row, index) => ({
      recoveryId: applied.recoveryIds[index],
      advanceId: row.advanceId,
      employeeId: row.expected.employeeId,
      branchId: row.expected.branchId,
      amount: row.amount,
      applySourceHash: applyPlan.sourceHash,
    })),
  };
  return {
    ...base,
    sourceHash: historicalAdvanceRecoveryReverseSourceHash(base),
  };
}

async function frozenExternalState() {
  const [payrollRuns, payrollItems, receipts, entries] = await Promise.all([
    db().select().from(s.payrollRuns).orderBy(asc(s.payrollRuns.id)),
    db().select().from(s.payrollItems).orderBy(asc(s.payrollItems.id)),
    db().select().from(s.receipts).orderBy(asc(s.receipts.id)),
    db()
      .select()
      .from(s.accountingEntries)
      .orderBy(asc(s.accountingEntries.id)),
  ]);
  return { payrollRuns, payrollItems, receipts, entries };
}

describe("historical advance recovery — owner-attested non-posting reconciliation", () => {
  it("settles only full prior LEGACY balances and leaves October payroll, cash receipts, and GL byte-stable", async () => {
    const before = await frozenExternalState();
    const plan = await makeApplyPlan([101, 102], "historical-apply-1");

    const result = await applyHistoricalAdvanceRecoveries(OWNER, plan);

    expect(result).toMatchObject({
      mode: "APPLIED",
      batchKey: plan.batchKey,
      sourceHash: plan.sourceHash,
      totalAmount: "150000.00",
    });
    expect(result.recoveryIds).toHaveLength(2);
    const advances = await db()
      .select()
      .from(s.employeeAdvances)
      .where(inArray(s.employeeAdvances.id, [101, 102, 103]))
      .orderBy(asc(s.employeeAdvances.id));
    expect(advances.map((row) => [row.id, row.status, row.remaining])).toEqual([
      [101, "SETTLED", "0.00"],
      [102, "SETTLED", "0.00"],
      [103, "ACTIVE", "25000.00"],
    ]);
    const history = await db()
      .select()
      .from(s.employeeAdvanceHistoricalRecoveries)
      .orderBy(asc(s.employeeAdvanceHistoricalRecoveries.advanceId));
    expect(
      history.map((row) => [row.advanceId, row.direction, row.amount]),
    ).toEqual([
      [101, "APPLY", "100000.00"],
      [102, "APPLY", "50000.00"],
    ]);
    expect(await db().select().from(s.advanceSettlements)).toHaveLength(0);
    expect(await frozenExternalState()).toEqual(before);
  });

  it("rejects a non-owner, a current-month row, wrong branch preimage, partial rows, and unknown JSON fields", async () => {
    const plan = await makeApplyPlan([101], "historical-guards-1");
    await expect(
      applyHistoricalAdvanceRecoveries(NON_OWNER, plan),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const [current] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 103));
    const currentPlan = {
      ...plan,
      batchKey: "historical-current-month",
      totalAmount: "25000.00",
      rows: [
        {
          advanceId: 103,
          amount: "25000.00",
          expected: {
            employeeId: 10,
            branchId: 1,
            amount: "25000.00",
            remaining: "25000.00",
            receiptId: null,
            grantedAt: current.grantedAt.toISOString(),
          },
        },
      ],
      sourceHash: "a".repeat(64),
    };
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, currentPlan),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    const wrongBranchBase: HistoricalAdvanceRecoveryApplyPlanBase = {
      ...plan,
      batchKey: "historical-wrong-branch",
      rows: plan.rows.map((row) => ({
        ...row,
        expected: { ...row.expected, branchId: 2 },
      })),
    };
    const wrongBranch = {
      ...wrongBranchBase,
      sourceHash: historicalAdvanceRecoveryApplySourceHash(wrongBranchBase),
    };
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, wrongBranch),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const partial = {
      ...plan,
      rows: plan.rows.map((row) => ({ ...row, amount: "99999.00" })),
      totalAmount: "99999.00",
    };
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, partial),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(() =>
      parseHistoricalAdvanceRecoveryApplyPlan({ ...plan, surprise: true }),
    ).toThrow(/غير معروفة/);
    expect(
      await db().select().from(s.employeeAdvanceHistoricalRecoveries),
    ).toHaveLength(0);
  });

  it("derives audit scope from source advances and permits transferred employees and multi-branch history", async () => {
    await db()
      .update(s.employees)
      .set({ branchId: 2 })
      .where(eq(s.employees.id, 10));
    const untrustedActorBranch = { ...OWNER, branchId: 999 };

    const singleBranchPlan = await makeApplyPlan(
      [102],
      "historical-audit-branch-1",
    );
    const singleResult = await applyHistoricalAdvanceRecoveries(
      untrustedActorBranch,
      singleBranchPlan,
    );
    const [singleAudit] = await db()
      .select()
      .from(s.auditLogs)
      .where(
        and(
          eq(s.auditLogs.action, "employeeAdvance.historicalRecovery.apply"),
          eq(s.auditLogs.entityId, singleBranchPlan.batchKey),
        ),
      );
    expect(singleAudit.branchId).toBe(1);
    expect(
      (singleAudit.newValue as { businessBranchId: number }).businessBranchId,
    ).toBe(1);

    await db()
      .update(s.auditLogs)
      .set({ branchId: 999 })
      .where(eq(s.auditLogs.id, singleAudit.id));
    await expect(
      applyHistoricalAdvanceRecoveries(untrustedActorBranch, singleBranchPlan),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db()
      .update(s.auditLogs)
      .set({ branchId: 1 })
      .where(eq(s.auditLogs.id, singleAudit.id));
    expect(
      await applyHistoricalAdvanceRecoveries(
        untrustedActorBranch,
        singleBranchPlan,
      ),
    ).toEqual({ ...singleResult, mode: "REPLAY_VERIFIED" });

    const multiBranchPlan = await makeApplyPlan(
      [101, 107],
      "historical-audit-multi-branch",
    );
    await applyHistoricalAdvanceRecoveries(
      untrustedActorBranch,
      multiBranchPlan,
    );
    const [multiAudit] = await db()
      .select()
      .from(s.auditLogs)
      .where(
        and(
          eq(s.auditLogs.action, "employeeAdvance.historicalRecovery.apply"),
          eq(s.auditLogs.entityId, multiBranchPlan.batchKey),
        ),
      );
    expect(multiAudit.branchId).toBeNull();
    expect(
      (multiAudit.newValue as { businessBranchId: number | null })
        .businessBranchId,
    ).toBeNull();
    const histories = await db()
      .select({
        advanceId: s.employeeAdvanceHistoricalRecoveries.advanceId,
        branchId: s.employeeAdvanceHistoricalRecoveries.branchId,
      })
      .from(s.employeeAdvanceHistoricalRecoveries)
      .where(
        inArray(s.employeeAdvanceHistoricalRecoveries.advanceId, [101, 107]),
      )
      .orderBy(asc(s.employeeAdvanceHistoricalRecoveries.advanceId));
    expect(histories).toEqual([
      { advanceId: 101, branchId: 1 },
      { advanceId: 107, branchId: 2 },
    ]);
  });

  it("uses the Baghdad month boundary independently of the process timezone", async () => {
    const eligible = await makeApplyPlan(
      [105],
      "historical-baghdad-boundary-ok",
    );
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, eligible),
    ).resolves.toMatchObject({
      mode: "APPLIED",
      totalAmount: "11000.00",
    });

    const [currentMonth] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 106));
    const ineligible: HistoricalAdvanceRecoveryApplyPlan = {
      batchKey: "historical-baghdad-boundary-reject",
      evidenceKind: "OWNER_ATTESTATION",
      evidenceReference: "owner-attestation:baghdad-boundary",
      evidenceHash: EVIDENCE_HASH,
      priorToPeriod: PRIOR_TO_PERIOD,
      totalAmount: "12000.00",
      rows: [
        {
          advanceId: 106,
          amount: "12000.00",
          expected: {
            employeeId: 10,
            branchId: 1,
            amount: "12000.00",
            remaining: "12000.00",
            receiptId: null,
            grantedAt: currentMonth.grantedAt.toISOString(),
          },
        },
      ],
      sourceHash: "a".repeat(64),
    };
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, ineligible),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [unchanged] = await db()
      .select({
        status: s.employeeAdvances.status,
        remaining: s.employeeAdvances.remaining,
      })
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 106));
    expect(unchanged).toEqual({ status: "ACTIVE", remaining: "12000.00" });
  });

  it("fails closed outside explicit OFF mode and guards reversal after an accounting opening", async () => {
    const plan = await makeApplyPlan([101], "historical-accounting-mode-1");
    for (const mode of ["SHADOW", "ACTIVE"] as const) {
      await db()
        .update(s.doubleEntrySettings)
        .set({ mode })
        .where(eq(s.doubleEntrySettings.id, 1));
      await expect(
        applyHistoricalAdvanceRecoveries(OWNER, plan),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    await db()
      .delete(s.doubleEntrySettings)
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, plan),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db().select().from(s.employeeAdvanceHistoricalRecoveries),
    ).toHaveLength(0);

    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
    const applied = await applyHistoricalAdvanceRecoveries(OWNER, plan);
    const reversePlan = makeReversePlan(
      applied,
      plan,
      "historical-accounting-mode-reverse",
    );
    await db()
      .update(s.doubleEntrySettings)
      .set({ mode: "SHADOW" })
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      reverseHistoricalAdvanceRecoveries(OWNER, reversePlan),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db()
        .select()
        .from(s.employeeAdvanceHistoricalRecoveries)
        .where(eq(s.employeeAdvanceHistoricalRecoveries.direction, "REVERSE")),
    ).toHaveLength(0);
  });

  it("verifies exact replay, rejects a changed payload and mixed state, and never duplicates an effect", async () => {
    const single = await makeApplyPlan([101], "historical-replay-1");
    const mixed = await makeApplyPlan([101, 102], "historical-mixed-1");
    const first = await applyHistoricalAdvanceRecoveries(OWNER, single);
    const replay = await applyHistoricalAdvanceRecoveries(OWNER, single);
    expect(first.mode).toBe("APPLIED");
    expect(replay).toEqual({ ...first, mode: "REPLAY_VERIFIED" });
    vi.setSystemTime(new Date("2026-11-02T12:00:00.000Z"));
    expect(await applyHistoricalAdvanceRecoveries(OWNER, single)).toEqual({
      ...first,
      mode: "REPLAY_VERIFIED",
    });
    vi.setSystemTime(NOW);

    const changedBase: HistoricalAdvanceRecoveryApplyPlanBase = {
      ...single,
      evidenceReference: "owner-attestation:changed-payload",
    };
    const changed = {
      ...changedBase,
      sourceHash: historicalAdvanceRecoveryApplySourceHash(changedBase),
    };
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, changed),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      applyHistoricalAdvanceRecoveries(OWNER, mixed),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(
      await db().select().from(s.employeeAdvanceHistoricalRecoveries),
    ).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(
          eq(s.auditLogs.action, "employeeAdvance.historicalRecovery.apply"),
        ),
    ).toHaveLength(1);
  });

  it("serializes two identical concurrent applications into one APPLY plus one verified replay", async () => {
    const plan = await makeApplyPlan([101], "historical-concurrent-1");
    const results = await Promise.all([
      applyHistoricalAdvanceRecoveries(OWNER, plan),
      applyHistoricalAdvanceRecoveries(OWNER, plan),
    ]);
    expect(results.map((row) => row.mode).sort()).toEqual([
      "APPLIED",
      "REPLAY_VERIFIED",
    ]);
    expect(results[0].recoveryIds).toEqual(results[1].recoveryIds);
    expect(
      await db().select().from(s.employeeAdvanceHistoricalRecoveries),
    ).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(
          eq(s.auditLogs.action, "employeeAdvance.historicalRecovery.apply"),
        ),
    ).toHaveLength(1);
  });

  it("rolls back both rows, balances, and audit when the containing transaction fails after apply", async () => {
    const before = await db()
      .select()
      .from(s.employeeAdvances)
      .where(inArray(s.employeeAdvances.id, [101, 102]))
      .orderBy(asc(s.employeeAdvances.id));
    const plan = await makeApplyPlan([101, 102], "historical-rollback-1");

    await expect(
      withTx(
        async (tx) => {
          await applyHistoricalAdvanceRecoveriesTx(tx, OWNER, plan);
          throw new Error("forced rollback after complete service write set");
        },
        { gate: "GOVERNANCE" },
      ),
    ).rejects.toThrow(/forced rollback/);

    expect(
      await db()
        .select()
        .from(s.employeeAdvances)
        .where(inArray(s.employeeAdvances.id, [101, 102]))
        .orderBy(asc(s.employeeAdvances.id)),
    ).toEqual(before);
    expect(
      await db().select().from(s.employeeAdvanceHistoricalRecoveries),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(
          eq(s.auditLogs.action, "employeeAdvance.historicalRecovery.apply"),
        ),
    ).toHaveLength(0);
  });

  it("reverses append-only without payroll/cash/GL effects, replays stably, and keeps cancellation locked", async () => {
    const beforeExternal = await frozenExternalState();
    const applyPlan = await makeApplyPlan([101], "historical-for-reverse-1");
    const applied = await applyHistoricalAdvanceRecoveries(OWNER, applyPlan);
    const reversePlan = makeReversePlan(applied, applyPlan);

    const untrustedActorBranch = { ...OWNER, branchId: 999 };
    const reversed = await reverseHistoricalAdvanceRecoveries(
      untrustedActorBranch,
      reversePlan,
    );
    const replay = await reverseHistoricalAdvanceRecoveries(
      untrustedActorBranch,
      reversePlan,
    );
    expect(reversed.mode).toBe("APPLIED");
    expect(replay).toEqual({ ...reversed, mode: "REPLAY_VERIFIED" });
    const [advance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 101));
    expect([advance.status, advance.remaining]).toEqual([
      "ACTIVE",
      "100000.00",
    ]);
    const history = await db()
      .select()
      .from(s.employeeAdvanceHistoricalRecoveries)
      .where(eq(s.employeeAdvanceHistoricalRecoveries.advanceId, 101))
      .orderBy(asc(s.employeeAdvanceHistoricalRecoveries.id));
    expect(
      history.map((row) => [row.direction, row.amount, row.reversalOfId]),
    ).toEqual([
      ["APPLY", "100000.00", null],
      ["REVERSE", "100000.00", applied.recoveryIds[0]],
    ]);
    const [reverseAudit] = await db()
      .select()
      .from(s.auditLogs)
      .where(
        and(
          eq(s.auditLogs.action, "employeeAdvance.historicalRecovery.reverse"),
          eq(s.auditLogs.entityId, reversePlan.batchKey),
        ),
      );
    expect(reverseAudit.branchId).toBe(1);
    expect(
      (reverseAudit.newValue as { businessBranchId: number }).businessBranchId,
    ).toBe(1);
    expect(await frozenExternalState()).toEqual(beforeExternal);

    const changedReasonBase: HistoricalAdvanceRecoveryReversePlanBase = {
      ...reversePlan,
      reason: "سبب آخر لا يطابق طلب العكس الأصلي",
    };
    const changedReason = {
      ...changedReasonBase,
      sourceHash: historicalAdvanceRecoveryReverseSourceHash(changedReasonBase),
    };
    await expect(
      reverseHistoricalAdvanceRecoveries(OWNER, changedReason),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const secondReverse = makeReversePlan(
      applied,
      applyPlan,
      "historical-reverse-2",
      "محاولة عكس ثانية يجب أن تفشل مغلقة",
    );
    await expect(
      reverseHistoricalAdvanceRecoveries(OWNER, secondReverse),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await expect(
      withTx(
        (tx) =>
          lockUntouchedEmployeeAdvanceForCancellationTx(tx, {
            originalReceiptId: 501,
            employeeId: 10,
            branchId: 1,
            expectedAmount: "100000.00",
          }),
        { gate: "GOVERNANCE" },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db()
        .select()
        .from(s.employeeAdvanceHistoricalRecoveries)
        .where(and(eq(s.employeeAdvanceHistoricalRecoveries.advanceId, 101))),
    ).toHaveLength(2);
  });
});
