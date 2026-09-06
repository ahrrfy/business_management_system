import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  completeTermination,
  createTermination,
  listTerminations,
  reverseTerminationPayment,
  reverseTerminationRecognition,
} from "../promotionService";

const CREATOR = { userId: 2, branchId: 2, role: "manager" };
const RECOGNIZER = { userId: 3, branchId: 2, role: "manager" };
const REVERSER = { userId: 4, branchId: 2, role: "manager" };

const TABLES = [
  "terminationAdvanceAllocations",
  "payrollObligationAllocations",
  "payrollAccountingEvents",
  "payrollObligations",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "idempotencyKeys",
  "receipts",
  "financialPeriods",
  "doubleEntrySettings",
  "employeeAdvances",
  "hrDeviceUsers",
  "employeeTerminations",
  "employees",
  "branches",
  "users",
];

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

async function resetAndSeed() {
  const connection = db();
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) {
    await connection.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await connection.insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Sales", code: "SALES", type: "SALES" },
  ]);
  await connection.insert(s.users).values([
    {
      id: 2,
      openId: "term-gross-creator",
      name: "Creator owner",
      role: "manager",
      branchId: 2,
      isOwner: false,
      isActive: true,
    },
    {
      id: 3,
      openId: "term-gross-recognizer",
      name: "Recognizer owner",
      role: "manager",
      branchId: 2,
      isOwner: true,
      isActive: true,
    },
    {
      id: 4,
      openId: "term-gross-reverser",
      name: "Reversal owner",
      role: "manager",
      branchId: 2,
      isOwner: true,
      isActive: true,
    },
  ]);
  await connection.insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "termination-gross-net-branch-test",
  });
  await connection.insert(s.employees).values({
    id: 71,
    branchId: 2,
    firstName: "Gross",
    lastName: "Settlement",
    salary: "1000.00",
    employmentStatus: "active",
    isActive: true,
  });
  await connection.insert(s.employeeAdvances).values({
    id: 81,
    employeeId: 71,
    branchId: 1,
    amount: "1000.00",
    remaining: "1000.00",
    status: "ACTIVE",
    createdBy: 2,
  });
  await connection.insert(s.payrollObligations).values([
    {
      id: 91,
      employeeId: 71,
      branchIdSnapshot: 1,
      revisionNo: 0,
      kind: "EOS_PROVISION",
      originalAmount: "100.00",
      remainingAmount: "100.00",
      dueDate: "2026-08-15",
      status: "OPEN",
      sourceType: "OPENING_CERTIFICATE",
      sourceKey: "TEST:EOS:MAIN:71",
    },
    {
      id: 92,
      employeeId: 71,
      branchIdSnapshot: 2,
      revisionNo: 0,
      kind: "EOS_PROVISION",
      originalAmount: "30.00",
      remainingAmount: "30.00",
      dueDate: "2026-08-15",
      status: "OPEN",
      sourceType: "OPENING_CERTIFICATE",
      sourceKey: "TEST:EOS:SALES:71",
    },
  ]);
}

beforeEach(resetAndSeed);

describe("termination gross-to-net accrual", () => {
  it("creates exact net/tax/SS obligations, allocates advances and branch provisions, and reverses in the original open period", async () => {
    const termination = await createTermination(
      {
        employeeId: 71,
        terminationType: "RESIGNATION",
        lastDay: "2026-08-15",
        breakdown: {
          earnedGrossWages: "500.00",
          wageReductions: "0.00",
          advanceRecovery: "400.00",
          incomeTax: "50.00",
          employeeSocialSecurity: "25.00",
          employerSocialSecurity: "30.00",
          eosBenefit: "80.00",
        },
        settlementEvidenceNote: "Accountant worksheet TERM-71 reviewed manually",
        zeroAmountsAttested: true,
        paymentMethod: "TRANSFER",
        paymentReference: "BANK-TERM-71",
        reason: "Contract completed",
      },
      CREATOR,
    );
    const completed = await completeTermination(Number(termination!.id), RECOGNIZER);
    expect(completed.recognition).toMatchObject({
      provisionAvailable: "130.00",
      provisionConsumed: "80.00",
      provisionReleased: "50.00",
      expenseRecognized: "0.00",
    });

    const obligations = await db()
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.terminationId, Number(termination!.id)))
      .orderBy(asc(s.payrollObligations.kind));
    expect(
      obligations.map((obligation) => ({
        kind: obligation.kind,
        amount: obligation.originalAmount,
        remaining: obligation.remainingAmount,
        status: obligation.status,
      })),
    ).toEqual([
      { kind: "SALARY_NET", amount: "105.00", remaining: "0.00", status: "SETTLED" },
      { kind: "INCOME_TAX", amount: "50.00", remaining: "50.00", status: "OPEN" },
      { kind: "SOCIAL_SECURITY", amount: "55.00", remaining: "55.00", status: "OPEN" },
    ]);

    const [advance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 81));
    expect(advance).toMatchObject({ remaining: "600.00", status: "ACTIVE" });
    const advanceApplications = await db()
      .select()
      .from(s.terminationAdvanceAllocations)
      .where(eq(s.terminationAdvanceAllocations.terminationId, Number(termination!.id)));
    expect(advanceApplications).toHaveLength(1);
    expect(advanceApplications[0]).toMatchObject({
      advanceId: 81,
      direction: "APPLY",
      amount: "400.00",
      reversalOfId: null,
    });
    const [frozenTermination] = await db()
      .select({
        remainingAdvanceAtRecognition:
          s.employeeTerminations.remainingAdvanceAtRecognition,
        settlementSnapshotHash: s.employeeTerminations.settlementSnapshotHash,
      })
      .from(s.employeeTerminations)
      .where(eq(s.employeeTerminations.id, Number(termination!.id)));
    expect(frozenTermination.remainingAdvanceAtRecognition).toBe("600.00");
    await db()
      .update(s.employeeAdvances)
      .set({ remaining: "400.00" })
      .where(eq(s.employeeAdvances.id, 81));
    const [listedAfterLaterRepayment] = await listTerminations(RECOGNIZER);
    expect(listedAfterLaterRepayment).toMatchObject({
      remainingAdvanceAtRecognition: "600.00",
      currentRemainingAdvanceBalance: "400.00",
      settlementSnapshotHash: frozenTermination.settlementSnapshotHash,
    });
    await db()
      .update(s.employeeAdvances)
      .set({ remaining: "600.00" })
      .where(eq(s.employeeAdvances.id, 81));

    const recognitionEvents = await db()
      .select()
      .from(s.payrollAccountingEvents)
      .where(
        and(
          eq(s.payrollAccountingEvents.terminationId, Number(termination!.id)),
          eq(s.payrollAccountingEvents.eventKind, "EOS_SETTLEMENT"),
        ),
      );
    expect(recognitionEvents).toHaveLength(3);
    expect(
      recognitionEvents.map((event) => Number(event.branchIdSnapshot)).sort(),
    ).toEqual([1, 1, 2]);
    const mainEvent = recognitionEvents.find(
      (event) => Number(event.id) === completed.recognition.eventId,
    )!;
    const [mainEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.id, Number(mainEvent.accountingEntryId)));
    expect(mainEntry.amount).toBe("480.00");
    const advanceTransferEvent = recognitionEvents.find((event) =>
      event.sourceKey.includes("ADVANCE_TRANSFER"),
    )!;
    const [advanceTransferEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        eq(
          s.accountingEntries.id,
          Number(advanceTransferEvent.accountingEntryId),
        ),
      );
    expect(advanceTransferEntry.postingProfile).toBe(
      "ADJUST_TERMINATION_ADVANCE_TRANSFER_OUT",
    );
    expect(advanceTransferEntry.postingIntentJson).toMatchObject({
      lines: expect.arrayContaining([
        { role: "INTERBRANCH_CLEARING", debit: "400.00", credit: "0.00" },
        { role: "EMPLOYEE_ADVANCES", debit: "0.00", credit: "400.00" },
      ]),
    });
    expect(mainEntry.postingIntentJson).toMatchObject({
      lines: expect.arrayContaining([
        { role: "INTERBRANCH_CLEARING", debit: "0.00", credit: "300.00" },
      ]),
    });
    const clearingByBranch = await db()
      .select({
        branchId: s.journalEntries.branchId,
        debit: sql<string>`SUM(${s.journalLines.debit})`,
        credit: sql<string>`SUM(${s.journalLines.credit})`,
      })
      .from(s.journalLines)
      .innerJoin(
        s.journalEntries,
        eq(s.journalEntries.id, s.journalLines.journalId),
      )
      .where(eq(s.journalLines.role, "INTERBRANCH_CLEARING"))
      .groupBy(s.journalEntries.branchId)
      .orderBy(asc(s.journalEntries.branchId));
    expect(clearingByBranch).toEqual([
      { branchId: 1, debit: "400.00", credit: "100.00" },
      { branchId: 2, debit: "0.00", credit: "300.00" },
    ]);

    const eosAfterRecognition = await db()
      .select()
      .from(s.payrollObligations)
      .where(inArray(s.payrollObligations.id, [91, 92]));
    expect(eosAfterRecognition.every((row) => row.status === "SETTLED")).toBe(true);
    expect(eosAfterRecognition.every((row) => row.remainingAmount === "0.00")).toBe(true);

    await reverseTerminationPayment(
      Number(termination!.id),
      REVERSER,
      {
        reason: "Return payment before recognition correction",
        paymentMethod: "TRANSFER",
        referenceNumber: "BANK-TERM-71-RETURN",
      },
    );
    await db().insert(s.financialPeriods).values({
      cutoffDate: "2026-08-15",
      status: "LOCKED",
      lockedBy: 4,
      notes: "Locked period test",
    });
    await expect(
      reverseTerminationRecognition(
        Number(termination!.id),
        REVERSER,
        "Correct gross-to-net evidence",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await db()
        .select()
        .from(s.payrollAccountingEvents)
        .where(eq(s.payrollAccountingEvents.eventKind, "EOS_SETTLEMENT_REVERSAL")),
    ).toHaveLength(0);

    await db().delete(s.financialPeriods);
    const reversed = await reverseTerminationRecognition(
      Number(termination!.id),
      REVERSER,
      "Correct gross-to-net evidence",
    );
    expect(reversed.replayed).toBe(false);
    const reversalEvents = await db()
      .select()
      .from(s.payrollAccountingEvents)
      .where(eq(s.payrollAccountingEvents.eventKind, "EOS_SETTLEMENT_REVERSAL"));
    expect(reversalEvents).toHaveLength(3);
    expect(
      reversalEvents.every(
        (event) =>
          new Date(event.occurredAt).toISOString().slice(0, 10) === "2026-08-15",
      ),
    ).toBe(true);
    const clearingAfterReversal = await db()
      .select({
        branchId: s.journalEntries.branchId,
        debit: sql<string>`SUM(${s.journalLines.debit})`,
        credit: sql<string>`SUM(${s.journalLines.credit})`,
      })
      .from(s.journalLines)
      .innerJoin(
        s.journalEntries,
        eq(s.journalEntries.id, s.journalLines.journalId),
      )
      .where(eq(s.journalLines.role, "INTERBRANCH_CLEARING"))
      .groupBy(s.journalEntries.branchId)
      .orderBy(asc(s.journalEntries.branchId));
    expect(clearingAfterReversal).toEqual([
      { branchId: 1, debit: "500.00", credit: "500.00" },
      { branchId: 2, debit: "300.00", credit: "300.00" },
    ]);

    const reversedObligations = await db()
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.terminationId, Number(termination!.id)));
    expect(reversedObligations.every((row) => row.status === "REVERSED")).toBe(true);
    const restoredEos = await db()
      .select()
      .from(s.payrollObligations)
      .where(inArray(s.payrollObligations.id, [91, 92]));
    expect(restoredEos.map((row) => row.remainingAmount).sort()).toEqual([
      "100.00",
      "30.00",
    ]);
    const [restoredAdvance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 81));
    expect(restoredAdvance).toMatchObject({ remaining: "1000.00", status: "ACTIVE" });
    const allAdvanceAllocations = await db()
      .select()
      .from(s.terminationAdvanceAllocations)
      .where(eq(s.terminationAdvanceAllocations.terminationId, Number(termination!.id)));
    expect(allAdvanceAllocations.map((row) => row.direction).sort()).toEqual([
      "APPLY",
      "REVERSE",
    ]);

    const replay = await reverseTerminationRecognition(
      Number(termination!.id),
      REVERSER,
      "Correct gross-to-net evidence",
    );
    expect(replay).toMatchObject({ eventId: reversed.eventId, replayed: true });
    await expect(
      reverseTerminationRecognition(
        Number(termination!.id),
        REVERSER,
        "Different reversal evidence",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
