import { createHash } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { sumMoney, toDbMoney } from "../money";
import {
  advancePeriodClassificationReverseSourceHash,
  advancePeriodClassificationSourceHash,
  applyAdvancePeriodClassifications,
  parseAdvancePeriodClassificationPlan,
  reverseAdvancePeriodClassifications,
  suggestDeductionsForPeriod,
  type AdvancePeriodClassificationPlan,
  type AdvancePeriodClassificationPlanBase,
  type AdvancePeriodClassificationReversePlan,
  type AdvancePeriodClassificationReversePlanBase,
} from "../advances";

const OWNER = { userId: 1, branchId: 1, role: "admin" };
const NOW = new Date("2026-11-01T12:00:00.000Z");
const EVIDENCE_HASH = createHash("sha256")
  .update("owner-attestation:october-advances-not-yet-deducted", "utf8")
  .digest("hex");

const TABLES = [
  "employeeAdvancePeriodClassifications",
  "employeeAdvanceHistoricalRecoveries",
  "employeeAdvanceRepaymentAllocations",
  "employeeAdvanceRepaymentRequests",
  "terminationAdvanceAllocations",
  "advanceSettlements",
  "employeeLoanRequests",
  "employeeAdvances",
  "payrollAccountingEvents",
  "payrollObligations",
  "payrollItems",
  "payrollRuns",
  "accountingEntries",
  "auditLogs",
  "receipts",
  "doubleEntrySettings",
  "monthCloseSequence",
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
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed(): Promise<void> {
  await db().insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "ADV-PERIOD",
    type: "MAIN",
  });
  await db().insert(s.users).values({
    id: 1,
    openId: "advance-period-owner",
    name: "مالك الاختبار",
    role: "admin",
    branchId: 1,
    isOwner: true,
    isActive: true,
  });
  await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
  await db().insert(s.monthCloseSequence).values({
    id: 1,
    status: "NEEDS_BOOTSTRAP",
    version: 0,
  });
  await db()
    .insert(s.employees)
    .values([
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
        branchId: 1,
        firstName: "موظف",
        lastName: "20",
        payType: "monthly",
        salary: "900000.00",
      },
    ]);
  await db()
    .insert(s.receipts)
    .values([
      {
        id: 601,
        branchId: 1,
        direction: "OUT",
        amount: "100000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        voucherNumber: "PV-1-20261011-00601",
        voucherDate: new Date("2026-10-11T00:00:00.000Z"),
        createdBy: 1,
      },
      {
        id: 602,
        branchId: 1,
        direction: "OUT",
        amount: "50000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        voucherNumber: "PV-1-20261014-00602",
        voucherDate: new Date("2026-10-14T00:00:00.000Z"),
        createdBy: 1,
      },
    ]);
  await db()
    .insert(s.employeeAdvances)
    .values([
      {
        id: 201,
        employeeId: 10,
        branchId: 1,
        amount: "100000.00",
        remaining: "100000.00",
        sourceType: "LEGACY_UNCLASSIFIED",
        payrollPeriod: null,
        status: "ACTIVE",
        receiptId: 601,
        createdBy: 1,
        grantedAt: new Date("2026-10-11T15:00:00.000Z"),
      },
      {
        id: 202,
        // سلفة ثانية للموظف نفسه: يجب أن تُجمع مع الأولى في بند المسير، لا أن تحل محلها.
        employeeId: 10,
        branchId: 1,
        amount: "50000.00",
        remaining: "50000.00",
        sourceType: "LEGACY_UNCLASSIFIED",
        payrollPeriod: null,
        status: "ACTIVE",
        receiptId: 602,
        createdBy: 1,
        grantedAt: new Date("2026-10-14T15:00:00.000Z"),
      },
    ]);
}

beforeEach(async () => {
  vi.setSystemTime(NOW);
  await reset();
  await seed();
});

afterAll(() => vi.useRealTimers());

async function makePlan(
  advanceIds = [201, 202],
  batchKey = "october-period-apply-1",
): Promise<AdvancePeriodClassificationPlan> {
  const advances = await db()
    .select()
    .from(s.employeeAdvances)
    .where(inArray(s.employeeAdvances.id, advanceIds))
    .orderBy(asc(s.employeeAdvances.id));
  const receiptRows = await db()
    .select()
    .from(s.receipts)
    .where(
      inArray(
        s.receipts.id,
        advances.map((row) => Number(row.receiptId)),
      ),
    );
  const receiptById = new Map(receiptRows.map((row) => [Number(row.id), row]));
  const base: AdvancePeriodClassificationPlanBase = {
    batchKey,
    evidenceKind: "OWNER_ATTESTATION",
    evidenceReference: "إقرار المالك: سلف تشرين لم تُخصم ولم يُنشأ مسيرها بعد",
    evidenceHash: EVIDENCE_HASH,
    payrollPeriod: "2026-10",
    totalAmount: toDbMoney(sumMoney(advances.map((row) => row.remaining))),
    rows: advances.map((row) => {
      const receipt = receiptById.get(Number(row.receiptId));
      if (!receipt?.voucherNumber || !receipt.voucherDate) {
        throw new Error("missing seeded receipt identity");
      }
      return {
        advanceId: Number(row.id),
        amount: row.remaining,
        expected: {
          employeeId: Number(row.employeeId),
          branchId: Number(row.branchId),
          amount: row.amount,
          remaining: row.remaining,
          receiptId: Number(row.receiptId),
          voucherNumber: receipt.voucherNumber,
          voucherDate: receipt.voucherDate.toISOString().slice(0, 10),
          grantedAt: row.grantedAt.toISOString(),
        },
      };
    }),
  };
  return { ...base, sourceHash: advancePeriodClassificationSourceHash(base) };
}

function makeReversePlan(
  applyPlan: AdvancePeriodClassificationPlan,
  classificationIds: number[],
  batchKey = "october-period-reverse-1",
): AdvancePeriodClassificationReversePlan {
  const base: AdvancePeriodClassificationReversePlanBase = {
    batchKey,
    reason: "تراجع المالك قبل إنشاء مسير تشرين واختبار مسار الاستعادة",
    payrollPeriod: applyPlan.payrollPeriod,
    totalAmount: applyPlan.totalAmount,
    rows: applyPlan.rows.map((row, index) => ({
      classificationId: classificationIds[index],
      advanceId: row.advanceId,
      employeeId: row.expected.employeeId,
      branchId: row.expected.branchId,
      amount: row.expected.amount,
      remaining: row.expected.remaining,
      applySourceHash: applyPlan.sourceHash,
    })),
  };
  return {
    ...base,
    sourceHash: advancePeriodClassificationReverseSourceHash(base),
  };
}

describe("legacy advance period classification", () => {
  it("rejects a caller whose owner status has been revoked", async () => {
    const plan = await makePlan();
    await db().update(s.users).set({ isOwner: false }).where(eq(s.users.id, 1));
    await expect(
      applyAdvancePeriodClassifications(OWNER, plan),
    ).rejects.toThrow("مالك");
    expect(
      await db().select().from(s.employeeAdvancePeriodClassifications),
    ).toHaveLength(0);
    expect(await db().select().from(s.employeeAdvances)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 201,
          sourceType: "LEGACY_UNCLASSIFIED",
          remaining: "100000.00",
        }),
        expect.objectContaining({
          id: 202,
          sourceType: "LEGACY_UNCLASSIFIED",
          remaining: "50000.00",
        }),
      ]),
    );
  });

  it("rejects a changed balance and a period outside the prior Baghdad month", async () => {
    const plan = await makePlan();
    await db()
      .update(s.employeeAdvances)
      .set({ remaining: "90000.00" })
      .where(eq(s.employeeAdvances.id, 201));
    await expect(
      applyAdvancePeriodClassifications(OWNER, plan),
    ).rejects.toThrow("مختلطة");
    expect(
      await db().select().from(s.employeeAdvancePeriodClassifications),
    ).toHaveLength(0);
    await db()
      .update(s.employeeAdvances)
      .set({ remaining: "100000.00" })
      .where(eq(s.employeeAdvances.id, 201));
    vi.setSystemTime(new Date("2026-12-01T12:00:00.000Z"));
    await expect(
      applyAdvancePeriodClassifications(OWNER, plan),
    ).rejects.toThrow("شهر بغداد السابق");
    expect(
      await db().select().from(s.employeeAdvancePeriodClassifications),
    ).toHaveLength(0);
  });

  it("rolls back the first classification when persisting the second row fails", async () => {
    const plan = await makePlan();
    const advancesBefore = await db()
      .select()
      .from(s.employeeAdvances)
      .orderBy(asc(s.employeeAdvances.id));
    const receiptsBefore = await db()
      .select()
      .from(s.receipts)
      .orderBy(asc(s.receipts.id));
    await db().execute(
      sql`CREATE TRIGGER test_advperiod_fail_second BEFORE INSERT ON employeeAdvancePeriodClassifications FOR EACH ROW BEGIN IF NEW.advanceId = 202 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected second classification failure'; END IF; END`,
    );
    try {
      await expect(
        applyAdvancePeriodClassifications(OWNER, plan),
      ).rejects.toThrow();
    } finally {
      await db().execute(
        sql`DROP TRIGGER IF EXISTS test_advperiod_fail_second`,
      );
    }
    expect(
      await db()
        .select()
        .from(s.employeeAdvances)
        .orderBy(asc(s.employeeAdvances.id)),
    ).toEqual(advancesBefore);
    expect(
      await db().select().from(s.receipts).orderBy(asc(s.receipts.id)),
    ).toEqual(receiptsBefore);
    expect(
      await db().select().from(s.employeeAdvancePeriodClassifications),
    ).toHaveLength(0);
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("classifies the complete October scope without money effects and feeds the payroll deduction contract", async () => {
    const plan = await makePlan();
    const receiptBefore = await db()
      .select()
      .from(s.receipts)
      .orderBy(asc(s.receipts.id));

    const applied = await applyAdvancePeriodClassifications(OWNER, plan);
    const replay = await applyAdvancePeriodClassifications(OWNER, plan);

    expect(applied).toMatchObject({
      mode: "APPLIED",
      payrollPeriod: "2026-10",
      totalAmount: "150000.00",
    });
    expect(replay).toEqual({ ...applied, mode: "REPLAY_VERIFIED" });
    const advances = await db()
      .select()
      .from(s.employeeAdvances)
      .orderBy(asc(s.employeeAdvances.id));
    expect(
      advances.map((row) => [
        Number(row.id),
        row.sourceType,
        row.payrollPeriod,
        row.status,
        row.remaining,
      ]),
    ).toEqual([
      [201, "SALARY_ADVANCE", "2026-10", "ACTIVE", "100000.00"],
      [202, "SALARY_ADVANCE", "2026-10", "ACTIVE", "50000.00"],
    ]);
    expect(await suggestDeductionsForPeriod([10, 20], "2026-10")).toEqual({
      10: { advanceId: 201, suggested: "150000.00" },
    });
    expect(
      await db().select().from(s.receipts).orderBy(asc(s.receipts.id)),
    ).toEqual(receiptBefore);
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
    expect(await db().select().from(s.advanceSettlements)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(
      await db().select().from(s.employeeAdvancePeriodClassifications),
    ).toHaveLength(2);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(
          eq(s.auditLogs.action, "employeeAdvance.periodClassification.apply"),
        ),
    ).toHaveLength(1);
  });

  it("reverses the entire apply batch only before payroll/effect creation and replays safely", async () => {
    const applyPlan = await makePlan();
    const applied = await applyAdvancePeriodClassifications(OWNER, applyPlan);
    const reversePlan = makeReversePlan(applyPlan, applied.classificationIds);

    const reversed = await reverseAdvancePeriodClassifications(
      OWNER,
      reversePlan,
    );
    const replay = await reverseAdvancePeriodClassifications(
      OWNER,
      reversePlan,
    );

    expect(reversed.mode).toBe("APPLIED");
    expect(replay).toEqual({ ...reversed, mode: "REPLAY_VERIFIED" });
    const advances = await db()
      .select()
      .from(s.employeeAdvances)
      .orderBy(asc(s.employeeAdvances.id));
    expect(
      advances.map((row) => [row.sourceType, row.payrollPeriod, row.remaining]),
    ).toEqual([
      ["LEGACY_UNCLASSIFIED", null, "100000.00"],
      ["LEGACY_UNCLASSIFIED", null, "50000.00"],
    ]);
    const ledger = await db()
      .select()
      .from(s.employeeAdvancePeriodClassifications)
      .orderBy(asc(s.employeeAdvancePeriodClassifications.id));
    expect(ledger.map((row) => row.direction)).toEqual([
      "APPLY",
      "APPLY",
      "REVERSE",
      "REVERSE",
    ]);
    expect(ledger.slice(2).map((row) => Number(row.reversalOfId))).toEqual(
      applied.classificationIds,
    );
  });

  it("rejects an incomplete October scope and a non-final receipt", async () => {
    await db()
      .insert(s.receipts)
      .values({
        id: 603,
        branchId: 1,
        direction: "OUT",
        amount: "1000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        voucherNumber: "PV-1-20261020-00603",
        voucherDate: new Date("2026-10-20T00:00:00.000Z"),
        createdBy: 1,
      });
    await db()
      .insert(s.employeeAdvances)
      .values({
        id: 203,
        employeeId: 10,
        branchId: 1,
        amount: "1000.00",
        remaining: "1000.00",
        sourceType: "LEGACY_UNCLASSIFIED",
        payrollPeriod: null,
        status: "ACTIVE",
        receiptId: 603,
        createdBy: 1,
        grantedAt: new Date("2026-10-20T12:00:00.000Z"),
      });
    await expect(
      applyAdvancePeriodClassifications(OWNER, await makePlan([201, 202])),
    ).rejects.toThrow("لا تغطي كل السلف");

    await db().delete(s.employeeAdvances).where(eq(s.employeeAdvances.id, 203));
    await db().delete(s.receipts).where(eq(s.receipts.id, 603));
    await db()
      .update(s.receipts)
      .set({ status: "REVERSED" })
      .where(eq(s.receipts.id, 601));
    await expect(
      applyAdvancePeriodClassifications(OWNER, await makePlan()),
    ).rejects.toThrow("سند صرف إحدى السلف");
  });

  it("blocks reverse as soon as an October payroll exists", async () => {
    const applyPlan = await makePlan();
    const applied = await applyAdvancePeriodClassifications(OWNER, applyPlan);
    await db().insert(s.payrollRuns).values({
      id: 701,
      period: "2026-10",
      status: "draft",
      employeeCount: 0,
      totalGross: "0.00",
      totalDeductions: "0.00",
      totalNet: "0.00",
      createdBy: 1,
    });
    await expect(
      reverseAdvancePeriodClassifications(
        OWNER,
        makeReversePlan(applyPlan, applied.classificationIds),
      ),
    ).rejects.toThrow("يوجد مسير رواتب");
  });

  it("rejects unknown fields and a changed canonical payload", async () => {
    const plan = await makePlan();
    expect(() =>
      parseAdvancePeriodClassificationPlan({ ...plan, unexpected: true }),
    ).toThrow("حقولاً ناقصة أو غير معروفة");
    expect(() =>
      parseAdvancePeriodClassificationPlan({
        ...plan,
        totalAmount: "149999.00",
      }),
    ).toThrow();
  });
});
