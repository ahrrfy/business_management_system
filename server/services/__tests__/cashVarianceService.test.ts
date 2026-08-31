import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  approveCashVarianceCase,
  buildCashVariancePostingPlan,
  proposeCashVarianceCase,
  rejectCashVarianceCase,
} from "../cashVarianceService";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, toDateStr } from "../money";
import {
  buildDailyCashEvidenceTx,
  closeDailyCashReconciliation,
  getDailyCashReconciliation,
} from "../cashDailyReconciliationService";
import { suggestDeductionsForPeriod } from "../advancesService";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";
import { truncateTables } from "./__testUtils__";

const MAKER = { userId: 71, branchId: 1, role: "manager" as const };
const COUNTER = { userId: 72, branchId: 1, role: "manager" as const };
const CHECKER = { userId: 73, branchId: 1, role: "manager" as const };
const SECOND_CHECKER = { userId: 76, branchId: 1, role: "admin" as const };
const OTHER_BRANCH = { userId: 74, branchId: 2, role: "manager" as const };
const RESPONSIBLE_USER_ID = 75;
const INNOCENT_USER_ID = 77;
const RESPONSIBLE_EMPLOYEE_ID = 501;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const TABLES = [
  "auditLogs",
  "cashVarianceCaseEvents",
  "cashVarianceCases",
  "advanceSettlements",
  "employeeAdvances",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "doubleEntrySettings",
  "monthCloseSequence",
  "financialPeriods",
  "cashDailyReconciliations",
  "cashCustodyCounts",
  "receipts",
  "shifts",
  "employees",
  "users",
  "branches",
];

async function seedBase() {
  await truncateTables(TABLES);
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: MAKER.userId, openId: "variance-maker", name: "منشئ الحالة", role: "manager", branchId: 1 },
    { id: COUNTER.userId, openId: "variance-counter", name: "منفذ العد", role: "manager", branchId: 1 },
    { id: CHECKER.userId, openId: "variance-checker", name: "معتمد مستقل", role: "manager", branchId: 1 },
    { id: SECOND_CHECKER.userId, openId: "variance-checker-2", name: "معتمد مستقل ثان", role: "admin", branchId: 1 },
    { id: OTHER_BRANCH.userId, openId: "variance-other", name: "مدير فرع آخر", role: "manager", branchId: 2 },
    { id: RESPONSIBLE_USER_ID, openId: "variance-responsible", name: "الموظف المسؤول", role: "cashier", branchId: 1 },
    { id: INNOCENT_USER_ID, openId: "variance-innocent", name: "موظف بريء", role: "cashier", branchId: 1 },
  ]);
  await db().insert(s.employees).values([
    { id: RESPONSIBLE_EMPLOYEE_ID, userId: RESPONSIBLE_USER_ID, branchId: 1, firstName: "الموظف", lastName: "المسؤول", isActive: true, employmentStatus: "active" },
    { id: 502, userId: INNOCENT_USER_ID, branchId: 1, firstName: "موظف", lastName: "بريء", isActive: true, employmentStatus: "active" },
  ]);
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "cash-variance-test",
  });
  await ensureFinancialPostingGate(db());
}

beforeEach(seedBase);

async function seedCustodyVariance(input: {
  declared?: string;
  counted?: string;
  reference?: string;
  withoutShift?: boolean;
}) {
  const declared = input.declared ?? "100000.00";
  const counted = input.counted ?? "75000.00";
  const reference = input.reference ?? "CH-1-20260831-0001";
  const shiftId = input.withoutShift
    ? null
    : extractInsertId(await db().insert(s.shifts).values({
        branchId: 1,
        userId: RESPONSIBLE_USER_ID,
        openingBalance: declared,
        status: "CLOSED",
        shiftType: "RETAIL",
      }));
  const outInsert = await db().insert(s.receipts).values({
    branchId: 1,
    shiftId,
    direction: "OUT",
    amount: declared,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: reference,
    createdBy: RESPONSIBLE_USER_ID,
  });
  const outReceiptId = extractInsertId(outInsert);
  const inInsert = await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: declared,
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "PENDING",
    approvalStatus: "APPROVED",
    referenceNumber: reference,
    createdBy: COUNTER.userId,
  });
  const treasuryReceiptId = extractInsertId(inInsert);
  await db().transaction((tx) =>
    postEntry(tx, {
      entryType: "CASH_TRANSFER_OUT",
      postingIntent: createPostingIntent(
        "CASH_HANDOVER_TO_TRANSIT",
        "CASH_TRANSFER_OUT",
        [
          debitLine("CASH_IN_TRANSIT", declared),
          creditLine("CASH", declared),
        ],
      ),
      branchId: 1,
      receiptId: outReceiptId,
      amount: money(declared),
      dedupeKey: `TEST-CASH-VARIANCE-STAGE:${reference}`,
    }),
  );
  const countInsert = await db().insert(s.cashCustodyCounts).values({
    treasuryReceiptId,
    clientRequestId: `count-${reference}`,
    declaredAmount: declared,
    countedAmount: counted,
    variance: money(counted).minus(declared).toFixed(2),
    countedBreakdown: {},
    status: "VARIANCE_OPEN",
    countedByUserId: COUNTER.userId,
  });
  return {
    treasuryReceiptId,
    countId: extractInsertId(countInsert),
    reference,
  };
}

function proposal(sourceType: "CUSTODY" | "DAILY_TREASURY", sourceId: number, requestId: string) {
  return proposeCashVarianceCase(
    {
      sourceType,
      sourceId,
      reasonCode: "CUSTODY_LOSS",
      reason: "فرق نقد فعلي مثبت بعد عد مستقل ومراجعة المستند",
      evidenceReference: "evidence://cash-count/verified",
      clientRequestId: requestId,
    },
    MAKER,
  );
}

describe("cash variance maker-checker resolution", () => {
  it("uses custody receivables, daily losses, and liability suspense without invented revenue", () => {
    const shortage = buildCashVariancePostingPlan({
      sourceType: "CUSTODY",
      expectedAmount: "100000.00",
      actualAmount: "75000.00",
    });
    expect(shortage).toMatchObject({
      direction: "OUT",
      varianceType: "SHORTAGE",
      counterAccountRole: "EMPLOYEE_ADVANCES",
      postingProfile: "CASH_CUSTODY_SHORTAGE",
    });
    expect(shortage.lines).toEqual([
      { role: "TREASURY_CASH", debit: "75000.00", credit: "0.00" },
      { role: "EMPLOYEE_ADVANCES", debit: "25000.00", credit: "0.00" },
      { role: "CASH_IN_TRANSIT", debit: "0.00", credit: "100000.00" },
    ]);

    const dailyShortage = buildCashVariancePostingPlan({
      sourceType: "DAILY_TREASURY",
      expectedAmount: "100000.00",
      actualAmount: "75000.00",
    });
    expect(dailyShortage).toMatchObject({
      direction: "OUT",
      varianceType: "SHORTAGE",
      counterAccountRole: "LOSSES",
      postingProfile: "CASH_DAILY_SHORTAGE",
    });
    expect(dailyShortage.lines).toEqual([
      { role: "LOSSES", debit: "25000.00", credit: "0.00" },
      { role: "TREASURY_CASH", debit: "0.00", credit: "25000.00" },
    ]);

    const surplus = buildCashVariancePostingPlan({
      sourceType: "DAILY_TREASURY",
      expectedAmount: "100000.00",
      actualAmount: "125000.00",
    });
    expect(surplus).toMatchObject({
      direction: "IN",
      varianceType: "SURPLUS",
      counterAccountRole: "OTHER_LIABILITY",
      postingProfile: "CASH_DAILY_SURPLUS",
    });
    expect(surplus.lines.map((line) => line.role)).not.toContain("OTHER_REVENUE");
    const totals = surplus.lines.reduce(
      (sum, line) => ({
        debit: sum.debit.plus(line.debit),
        credit: sum.credit.plus(line.credit),
      }),
      { debit: money(0), credit: money(0) },
    );
    expect(totals.debit.eq(totals.credit)).toBe(true);
  });

  it("resolves a custody shortage atomically, clears transit and is idempotent", async () => {
    const source = await seedCustodyVariance({});
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-propose-1");

    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-maker" },
        MAKER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-counter" },
        COUNTER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-branch" },
        OTHER_BRANCH,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const approved = await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-1" },
      CHECKER,
    );
    expect(approved).toMatchObject({ status: "APPROVED", version: 2, idempotent: false });
    const replay = await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-1" },
      CHECKER,
    );
    expect(replay.idempotent).toBe(true);

    const custodyReceipt = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, source.treasuryReceiptId))
    )[0];
    expect(custodyReceipt.status).toBe("COMPLETED");
    expect(custodyReceipt.amount).toBe("100000.00");
    const adjustment = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
    )[0];
    expect(adjustment).toMatchObject({ direction: "OUT", amount: "25000.00", cashBucket: "TREASURY" });

    const resolutionEntry = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`))
    )[0];
    expect(resolutionEntry).toMatchObject({
      postingProfile: "CASH_CUSTODY_SHORTAGE",
      receiptId: adjustment.id,
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
    });
    const journal = (
      await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, resolutionEntry.id))
    )[0];
    const lines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, journal.id));
    expect(lines.map((line) => [line.role, line.debit, line.credit]).sort()).toEqual([
      ["CASH_IN_TRANSIT", "0.00", "100000.00"],
      ["EMPLOYEE_ADVANCES", "25000.00", "0.00"],
      ["TREASURY_CASH", "75000.00", "0.00"],
    ]);
    const approvedEvent = (
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.eventType, "APPROVED"))
    )[0];
    const advance = (
      await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(approvedEvent.advanceId)))
    )[0];
    expect(advance).toMatchObject({
      employeeId: RESPONSIBLE_EMPLOYEE_ID,
      branchId: 1,
      amount: "25000.00",
      remaining: "25000.00",
      status: "ACTIVE",
      receiptId: adjustment.id,
    });
    const employeeAdvanceGl = lines
      .filter((line) => line.role === "EMPLOYEE_ADVANCES")
      .reduce((sum, line) => sum.plus(line.debit).minus(line.credit), money(0));
    expect(employeeAdvanceGl.eq(advance.remaining)).toBe(true);
    expect(await suggestDeductionsForPeriod([RESPONSIBLE_EMPLOYEE_ID])).toEqual({
      [RESPONSIBLE_EMPLOYEE_ID]: { advanceId: Number(advance.id), suggested: "25000.00" },
    });
    expect(await db().select().from(s.cashVarianceCaseEvents)).toHaveLength(2);
  });

  it("derives custody responsibility from the shift contract and blocks the responsible actor", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0006" });
    const malicious = await proposeCashVarianceCase(
      {
        sourceType: "CUSTODY",
        sourceId: source.treasuryReceiptId,
        reasonCode: "CUSTODY_LOSS",
        reason: "عجز عهدة مثبت بمحضر عد مستقل ودليل موقع",
        evidenceReference: "evidence://custody/contract-owner",
        clientRequestId: "variance-derived-responsible",
      },
      MAKER,
    );
    const stored = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, malicious.caseId))
    )[0];
    expect(stored).toMatchObject({
      responsibleUserId: RESPONSIBLE_USER_ID,
      responsibleEmployeeId: RESPONSIBLE_EMPLOYEE_ID,
    });
    await expect(
      approveCashVarianceCase(
        { caseId: malicious.caseId, expectedVersion: 1, clientRequestId: "responsible-approve-denied" },
        { userId: RESPONSIBLE_USER_ID, branchId: 1, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      rejectCashVarianceCase(
        { caseId: malicious.caseId, expectedVersion: 1, clientRequestId: "responsible-reject-denied", reason: "المسؤول لا يحسم قضيته المالية بنفسه" },
        { userId: RESPONSIBLE_USER_ID, branchId: 1, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const second = await seedCustodyVariance({ reference: "CH-1-20260831-0007" });
    await expect(
      proposeCashVarianceCase(
        {
          sourceType: "CUSTODY",
          sourceId: second.treasuryReceiptId,
          reasonCode: "CUSTODY_LOSS",
          reason: "المسؤول لا ينشئ قضية عجز عهدته بنفسه",
          evidenceReference: "evidence://custody/responsible-proposer",
          clientRequestId: "responsible-propose-denied",
        },
        { userId: RESPONSIBLE_USER_ID, branchId: 1, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const shiftless = await seedCustodyVariance({
      reference: "CH-1-20260831-0008",
      withoutShift: true,
    });
    const shiftlessCase = await proposal(
      "CUSTODY",
      shiftless.treasuryReceiptId,
      "variance-shiftless-responsible",
    );
    const shiftlessStored = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, shiftlessCase.caseId))
    )[0];
    expect(shiftlessStored.responsibleUserId).toBe(RESPONSIBLE_USER_ID);
  });

  it("clears custody transit on a surplus and suspends the excess as a liability", async () => {
    const source = await seedCustodyVariance({
      counted: "125000.00",
      reference: "CH-1-20260831-0005",
    });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-surplus-propose");
    const surplusCase = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, created.caseId))
    )[0];
    expect(surplusCase).toMatchObject({
      responsibleUserId: null,
      responsibleEmployeeId: null,
      responsibleNameSnapshot: null,
    });
    await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-surplus-approve" },
      CHECKER,
    );

    const adjustment = (
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
    )[0];
    expect(adjustment).toMatchObject({ direction: "IN", amount: "25000.00" });
    const resolutionEntry = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`))
    )[0];
    expect(resolutionEntry).toMatchObject({
      postingProfile: "CASH_CUSTODY_SURPLUS",
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
    });
    const journal = (
      await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, resolutionEntry.id))
    )[0];
    const lines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, journal.id));
    expect(lines.map((line) => [line.role, line.debit, line.credit]).sort()).toEqual([
      ["CASH_IN_TRANSIT", "0.00", "100000.00"],
      ["OTHER_LIABILITY", "0.00", "25000.00"],
      ["TREASURY_CASH", "125000.00", "0.00"],
    ]);
  });

  it("serializes two checkers in the same lock order and applies one approval only", async () => {
    const source = await seedCustodyVariance({ reference: "CD-1-20260831-0002" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-race-propose");
    const results = await Promise.allSettled([
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-race-a" },
        CHECKER,
      ),
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-race-b" },
        SECOND_CHECKER,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`)),
    ).toHaveLength(1);
    expect(
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(2);
  });

  it("rolls back receipt, event and case resolution when financial posting is blocked", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0003" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-rollback-propose");
    await db().insert(s.financialPeriods).values({
      cutoffDate: toDateStr(),
      status: "LOCKED",
      lockedBy: CHECKER.userId,
    });

    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-rollback-approve" },
        CHECKER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const receipt = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, source.treasuryReceiptId))
    )[0];
    expect(receipt.status).toBe("PENDING");
    expect(
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`)),
    ).toHaveLength(0);
    expect(
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(1);
    expect(await db().select().from(s.employeeAdvances)).toHaveLength(0);
  });

  it("rejects proposing or approving a variance after the branch cash day is closed", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0004" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-close-gate-propose");
    await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: toDateStr(),
      expectedTreasuryCash: "0.00",
      countedTreasuryCash: "0.00",
      variance: "0.00",
      status: "CLOSED",
      lastClientRequestId: "closed-day-count",
      closeClientRequestId: "closed-day-close",
      evidenceHash: "c".repeat(64),
      countedByUserId: COUNTER.userId,
      closedByUserId: CHECKER.userId,
      closedAt: new Date(),
    });

    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-after-close-approve" },
        CHECKER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      proposal("CUSTODY", source.treasuryReceiptId, "variance-after-close-propose"),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(1);
    expect(
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`)),
    ).toHaveLength(0);
    const pendingReceipt = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, source.treasuryReceiptId))
    )[0];
    expect(pendingReceipt.status).toBe("PENDING");
  });

  it("posts a daily shortage without rewriting the historical count as matched", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "100000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "DAILY-OPENING",
      createdBy: MAKER.userId,
    });
    const dailyEvidence = await db().transaction((tx) =>
      buildDailyCashEvidenceTx(tx, 1, toDateStr()),
    );
    const reconciliationInsert = await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: toDateStr(),
      expectedTreasuryCash: "100000.00",
      countedTreasuryCash: "75000.00",
      variance: "-25000.00",
      countedBreakdown: { "50000": 1, "25000": 1 },
      status: "VARIANCE_OPEN",
      lastClientRequestId: "daily-count-variance",
      evidenceHash: dailyEvidence.evidenceHash,
      countedByUserId: COUNTER.userId,
    });
    const reconciliationId = extractInsertId(reconciliationInsert);
    const innocentAdvanceInsert = await db().insert(s.employeeAdvances).values({
      employeeId: 502,
      branchId: 1,
      amount: "333.00",
      remaining: "333.00",
      monthlyDeduction: "50.00",
      status: "ACTIVE",
      note: "ذمة بريئة سابقة لا تخص فرق الخزينة اليومي",
      createdBy: MAKER.userId,
    });
    const innocentAdvanceId = extractInsertId(innocentAdvanceInsert);
    const created = await proposal("DAILY_TREASURY", reconciliationId, "variance-daily-propose");
    await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-daily-approve" },
      CHECKER,
    );

    const reconciliation = (
      await db().select().from(s.cashDailyReconciliations).where(eq(s.cashDailyReconciliations.id, reconciliationId))
    )[0];
    expect(reconciliation).toMatchObject({
      expectedTreasuryCash: "100000.00",
      countedTreasuryCash: "75000.00",
      variance: "-25000.00",
      status: "RESOLVED_WITH_ADJUSTMENT",
      version: 2,
    });
    const dailyAdjustment = (
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
    )[0];
    expect(dailyAdjustment).toMatchObject({ direction: "OUT", amount: "25000.00" });
    const entry = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`))
    )[0];
    expect(entry.postingProfile).toBe("CASH_DAILY_SHORTAGE");
    const dailyCase = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, created.caseId))
    )[0];
    expect(dailyCase).toMatchObject({
      responsibleUserId: null,
      responsibleEmployeeId: null,
      responsibleNameSnapshot: null,
    });
    const dailyApprovedEvent = (
      await db()
        .select()
        .from(s.cashVarianceCaseEvents)
        .where(
          and(
            eq(s.cashVarianceCaseEvents.caseId, created.caseId),
            eq(s.cashVarianceCaseEvents.eventType, "APPROVED"),
          ),
        )
    )[0];
    expect(dailyApprovedEvent).toMatchObject({
      counterAccountRole: "LOSSES",
      advanceId: null,
    });
    const advancesAfterDaily = await db().select().from(s.employeeAdvances);
    expect(advancesAfterDaily).toHaveLength(1);
    expect(advancesAfterDaily[0]).toMatchObject({
      id: innocentAdvanceId,
      employeeId: 502,
      remaining: "333.00",
    });
    const dailyJournal = (
      await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, entry.id))
    )[0];
    const dailyLines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, dailyJournal.id));
    expect(dailyLines.map((line) => [line.role, line.debit, line.credit]).sort()).toEqual([
      ["LOSSES", "25000.00", "0.00"],
      ["TREASURY_CASH", "0.00", "25000.00"],
    ]);

    const netTreasury = (
      await db()
        .select({
          amount: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction} = 'IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END), 0)`,
        })
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.branchId, 1),
            eq(s.receipts.cashBucket, "TREASURY"),
            eq(s.receipts.status, "COMPLETED"),
          ),
        )
    )[0];
    expect(money(netTreasury.amount).toFixed(2)).toBe("75000.00");
  });

  it("approves an August variance in September, closes August honestly and makes September stale", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
      await db().delete(s.receipts);
      await db().insert(s.receipts).values({
        branchId: 1,
        direction: "IN",
        amount: "100000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "AUGUST-OPENING",
        createdBy: MAKER.userId,
        createdAt: new Date("2026-08-31T08:00:00.000Z"),
        approvedAt: new Date("2026-08-31T08:00:00.000Z"),
      });
      const augustEvidence = await db().transaction((tx) => buildDailyCashEvidenceTx(tx, 1, "2026-08-31"));
      const augustInsert = await db().insert(s.cashDailyReconciliations).values({
        branchId: 1,
        businessDate: "2026-08-31",
        expectedTreasuryCash: "100000.00",
        countedTreasuryCash: "75000.00",
        variance: "-25000.00",
        countedBreakdown: { "50000": 1, "25000": 1 },
        status: "VARIANCE_OPEN",
        lastClientRequestId: "august-variance-count",
        evidenceHash: augustEvidence.evidenceHash,
        countedByUserId: COUNTER.userId,
      });
      const augustId = extractInsertId(augustInsert);
      const created = await proposal("DAILY_TREASURY", augustId, "august-variance-propose");

      vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
      const septemberEvidence = await db().transaction((tx) => buildDailyCashEvidenceTx(tx, 1, "2026-09-01"));
      const septemberInsert = await db().insert(s.cashDailyReconciliations).values({
        branchId: 1,
        businessDate: "2026-09-01",
        expectedTreasuryCash: "100000.00",
        countedTreasuryCash: "100000.00",
        variance: "0.00",
        countedBreakdown: { "50000": 2 },
        status: "MATCHED",
        lastClientRequestId: "september-count-before-adjustment",
        evidenceHash: septemberEvidence.evidenceHash,
        countedByUserId: MAKER.userId,
      });
      const septemberId = extractInsertId(septemberInsert);

      await approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "august-approved-in-september" },
        CHECKER,
      );
      const august = (
        await db().select().from(s.cashDailyReconciliations).where(eq(s.cashDailyReconciliations.id, augustId))
      )[0];
      expect(august).toMatchObject({
        expectedTreasuryCash: "100000.00",
        countedTreasuryCash: "75000.00",
        variance: "-25000.00",
        evidenceHash: augustEvidence.evidenceHash,
        status: "RESOLVED_WITH_ADJUSTMENT",
        version: 2,
      });
      const adjustment = (
        await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
      )[0];
      expect(adjustment.approvedAt?.toISOString().slice(0, 10)).toBe("2026-09-01");

      const augustClosed = await closeDailyCashReconciliation(
        { reconciliationId: augustId, expectedVersion: 2, clientRequestId: "august-close-after-resolution" },
        SECOND_CHECKER,
        { user: { id: SECOND_CHECKER.userId, branchId: 1, role: "admin", name: "مراجع" }, req: { headers: {} } } as never,
      );
      expect(augustClosed.status).toBe("CLOSED");

      const september = await getDailyCashReconciliation(
        { branchId: 1, businessDate: "2026-09-01" },
        CHECKER,
      );
      expect(september.blockers.map((item) => item.code)).toContain("STALE_EVIDENCE");
      await expect(
        closeDailyCashReconciliation(
          { reconciliationId: septemberId, expectedVersion: 1, clientRequestId: "september-close-stale" },
          CHECKER,
          { user: { id: CHECKER.userId, branchId: 1, role: "manager", name: "مراجع" }, req: { headers: {} } } as never,
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      vi.useRealTimers();
    }
  });
});
