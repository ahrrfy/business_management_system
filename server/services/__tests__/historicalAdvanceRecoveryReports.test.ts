import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  applyHistoricalAdvanceRecoveries,
  historicalAdvanceRecoveryApplySourceHash,
  historicalAdvanceRecoveryReverseSourceHash,
  reverseHistoricalAdvanceRecoveries,
  type HistoricalAdvanceRecoveryApplyPlan,
  type HistoricalAdvanceRecoveryApplyPlanBase,
  type HistoricalAdvanceRecoveryReversePlan,
  type HistoricalAdvanceRecoveryReversePlanBase,
} from "../advances";
import { getFinancialPosition } from "../reportsFinancialService";

const OWNER = { userId: 1, branchId: 1, role: "admin" };
const NOW = new Date("2026-10-31T12:00:00.000Z");
const EVIDENCE_HASH = createHash("sha256")
  .update("owner-attestation:report-restatement", "utf8")
  .digest("hex");

const TABLES = [
  "employeeAdvanceHistoricalRecoveries",
  "employeeAdvanceRepaymentAllocations",
  "employeeAdvanceRepaymentRequests",
  "terminationAdvanceAllocations",
  "advanceSettlements",
  "employeeAdvances",
  "auditLogs",
  "doubleEntrySettings",
  "employees",
  "users",
  "branches",
];

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function reset(): Promise<void> {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed(): Promise<void> {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "فرع التقرير 1", code: "HIST-RPT-1", type: "MAIN" },
      { id: 2, name: "فرع التقرير 2", code: "HIST-RPT-2", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "historical-report-owner",
    name: "مالك تقرير التسوية",
    role: "admin",
    branchId: 1,
    isOwner: true,
    isActive: true,
  });
  await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
  await db()
    .insert(s.employees)
    .values([
      {
        id: 10,
        branchId: 1,
        firstName: "موظف",
        lastName: "الفرع الأول",
        payType: "monthly",
        salary: "1000000.00",
      },
      {
        id: 20,
        branchId: 2,
        firstName: "موظف",
        lastName: "الفرع الثاني",
        payType: "monthly",
        salary: "900000.00",
      },
    ]);
  await db()
    .insert(s.employeeAdvances)
    .values([
      {
        id: 101,
        employeeId: 10,
        branchId: 1,
        amount: "200000.00",
        remaining: "200000.00",
        sourceType: "LEGACY_UNCLASSIFIED",
        payrollPeriod: null,
        status: "ACTIVE",
        createdBy: 1,
        grantedAt: new Date("2026-09-10T08:00:00.000Z"),
      },
      {
        id: 102,
        employeeId: 10,
        branchId: 1,
        amount: "110000.00",
        remaining: "110000.00",
        sourceType: "LEGACY_UNCLASSIFIED",
        payrollPeriod: null,
        status: "ACTIVE",
        createdBy: 1,
        grantedAt: new Date("2026-09-11T08:00:00.000Z"),
      },
      {
        id: 103,
        employeeId: 10,
        branchId: 1,
        amount: "359000.00",
        remaining: "359000.00",
        sourceType: "SALARY_ADVANCE",
        payrollPeriod: "2026-10",
        status: "ACTIVE",
        createdBy: 1,
        grantedAt: new Date("2026-10-01T08:00:00.000Z"),
      },
      {
        id: 201,
        employeeId: 20,
        branchId: 2,
        amount: "70000.00",
        remaining: "70000.00",
        sourceType: "LEGACY_UNCLASSIFIED",
        payrollPeriod: null,
        status: "ACTIVE",
        createdBy: 1,
        grantedAt: new Date("2026-09-12T08:00:00.000Z"),
      },
    ]);
}

function applyPlan(): HistoricalAdvanceRecoveryApplyPlan {
  const base: HistoricalAdvanceRecoveryApplyPlanBase = {
    batchKey: "hist-report-apply-20261031",
    evidenceKind: "OWNER_ATTESTATION",
    evidenceReference: "owner-attestation:prior-balances-recovered",
    evidenceHash: EVIDENCE_HASH,
    priorToPeriod: "2026-10",
    totalAmount: "310000.00",
    rows: [
      {
        advanceId: 101,
        amount: "200000.00",
        expected: {
          employeeId: 10,
          branchId: 1,
          amount: "200000.00",
          remaining: "200000.00",
          receiptId: null,
          grantedAt: "2026-09-10T08:00:00.000Z",
        },
      },
      {
        advanceId: 102,
        amount: "110000.00",
        expected: {
          employeeId: 10,
          branchId: 1,
          amount: "110000.00",
          remaining: "110000.00",
          receiptId: null,
          grantedAt: "2026-09-11T08:00:00.000Z",
        },
      },
    ],
  };
  return {
    ...base,
    sourceHash: historicalAdvanceRecoveryApplySourceHash(base),
  };
}

function reversePlan(
  applied: Awaited<ReturnType<typeof applyHistoricalAdvanceRecoveries>>,
  appliedPlan: HistoricalAdvanceRecoveryApplyPlan,
): HistoricalAdvanceRecoveryReversePlan {
  const base: HistoricalAdvanceRecoveryReversePlanBase = {
    batchKey: "hist-report-reverse-20261031",
    reason: "إلغاء إقرار التسوية التاريخية بعد مراجعة المالك",
    totalAmount: appliedPlan.totalAmount,
    rows: appliedPlan.rows.map((row, index) => ({
      recoveryId: applied.recoveryIds[index],
      advanceId: row.advanceId,
      employeeId: row.expected.employeeId,
      branchId: row.expected.branchId,
      amount: row.amount,
      applySourceHash: appliedPlan.sourceHash,
    })),
  };
  return {
    ...base,
    sourceHash: historicalAdvanceRecoveryReverseSourceHash(base),
  };
}

beforeEach(async () => {
  vi.setSystemTime(NOW);
  await reset();
  await seed();
});

afterAll(() => vi.useRealTimers());

describe.sequential(
  "historical advance recovery financial-position restatement",
  () => {
    it("reconciles live and October as-of balances, preserves prior history/current advances, and reverses exactly", async () => {
      const plan = applyPlan();
      const applied = await applyHistoricalAdvanceRecoveries(OWNER, plan);

      const liveApplied = await getFinancialPosition({
        branchId: 1,
        verify: false,
      });
      const octoberApplied = await getFinancialPosition({
        branchId: 1,
        asOf: "2026-10-31",
        verify: false,
      });
      const boundaryApplied = await getFinancialPosition({
        branchId: 1,
        asOf: "2026-10-01",
        verify: false,
      });
      const beforeBoundary = await getFinancialPosition({
        branchId: 1,
        asOf: "2026-09-30",
        verify: false,
      });
      const otherBranch = await getFinancialPosition({
        branchId: 2,
        asOf: "2026-10-31",
        verify: false,
      });
      expect(liveApplied.employeeAdvanceReceivable).toBe("359000.00");
      expect(octoberApplied.employeeAdvanceReceivable).toBe(
        liveApplied.employeeAdvanceReceivable,
      );
      expect(boundaryApplied.employeeAdvanceReceivable).toBe("359000.00");
      expect(beforeBoundary.employeeAdvanceReceivable).toBe("310000.00");
      expect(otherBranch.employeeAdvanceReceivable).toBe("70000.00");

      const [octoberAdvance] = await db()
        .select()
        .from(s.employeeAdvances)
        .where(eq(s.employeeAdvances.id, 103));
      expect(octoberAdvance).toMatchObject({
        status: "ACTIVE",
        remaining: "359000.00",
        sourceType: "SALARY_ADVANCE",
        payrollPeriod: "2026-10",
      });

      await reverseHistoricalAdvanceRecoveries(
        OWNER,
        reversePlan(applied, plan),
      );
      const liveReversed = await getFinancialPosition({
        branchId: 1,
        verify: false,
      });
      const octoberReversed = await getFinancialPosition({
        branchId: 1,
        asOf: "2026-10-31",
        verify: false,
      });
      const boundaryReversed = await getFinancialPosition({
        branchId: 1,
        asOf: "2026-10-01",
        verify: false,
      });
      const beforeBoundaryReversed = await getFinancialPosition({
        branchId: 1,
        asOf: "2026-09-30",
        verify: false,
      });
      const otherBranchReversed = await getFinancialPosition({
        branchId: 2,
        asOf: "2026-10-31",
        verify: false,
      });
      expect(liveReversed.employeeAdvanceReceivable).toBe("669000.00");
      expect(octoberReversed.employeeAdvanceReceivable).toBe(
        liveReversed.employeeAdvanceReceivable,
      );
      expect(boundaryReversed.employeeAdvanceReceivable).toBe("669000.00");
      expect(beforeBoundaryReversed.employeeAdvanceReceivable).toBe(
        "310000.00",
      );
      expect(otherBranchReversed.employeeAdvanceReceivable).toBe("70000.00");
    });
  },
);
