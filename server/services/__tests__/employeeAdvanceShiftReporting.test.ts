import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { todayUtcDate, baghdadToday } from "../businessDay";
import {
  disburseEmployeeLoan,
  getEmployeeLoanDisbursementReadiness,
} from "../employeeLoanService";
import { getDayCloseReconciliation } from "../reportsDayCloseService";
import { getShiftReport } from "../shiftService";
import type { Actor } from "../tx";

const BRANCH_ID = 1;
const REQUESTER_ID = 1;
const EXECUTOR_ID = 2;
const REVIEWER_ID = 3;
const EMPLOYEE_ID = 10;
const SHIFT_ID = 101;
const OPENING_BALANCE = "1000000.00";
const ADVANCE_AMOUNT = "300000.00";

const requesterName = "منشئ طلب السلفة";
const executorName = "منفذ صرف السلفة";

const executorActor: Actor = {
  userId: EXECUTOR_ID,
  branchId: BRANCH_ID,
  role: "cashier",
};
const reviewerActor: Actor = {
  userId: REVIEWER_ID,
  branchId: BRANCH_ID,
  role: "admin",
};

const TABLES = [
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "idempotencyKeys",
  "cashCustodyCounts",
  "cashDailyReconciliations",
  "receipts",
  "employeeAdvances",
  "employeeLoanRequests",
  "shifts",
  "employees",
  "branches",
  "users",
];

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

async function resetDb() {
  const connection = db();
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) {
    await connection.execute(sql.raw(`DELETE FROM \`${table}\``));
  }
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const connection = db();
  await connection.insert(s.branches).values({
    id: BRANCH_ID,
    name: "فرع اختبار عهدة السلف",
    code: "ADV-SHIFT",
    type: "MAIN",
  });
  await connection.insert(s.users).values([
    {
      id: REQUESTER_ID,
      openId: "advance-shift-requester",
      name: requesterName,
      role: "admin",
      branchId: BRANCH_ID,
    },
    {
      id: EXECUTOR_ID,
      openId: "advance-shift-executor",
      name: executorName,
      role: "cashier",
      branchId: BRANCH_ID,
      operationPolicy: {
        version: 1,
        grants: {
          "operation.payroll.advanceGrant": true,
          "operation.hrEnterprise.loans.disburse": true,
        },
      },
    },
    {
      id: REVIEWER_ID,
      openId: "advance-shift-reviewer",
      name: "معتمد طلب السلفة",
      role: "admin",
      branchId: BRANCH_ID,
    },
  ]);
  await connection.insert(s.employees).values({
    id: EMPLOYEE_ID,
    branchId: BRANCH_ID,
    firstName: "علي",
    fatherName: "حسين",
    grandfatherName: "محمد",
    lastName: "الساعدي",
    salary: "15000000.00",
    payType: "monthly",
    hireDate: "2020-01-01",
    employmentStatus: "active",
  });
  await connection.insert(s.shifts).values({
    id: SHIFT_ID,
    branchId: BRANCH_ID,
    userId: EXECUTOR_ID,
    openingBalance: OPENING_BALANCE,
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: `${BRANCH_ID}:${EXECUTOR_ID}:RETAIL`,
  });
  await connection.insert(s.receipts).values({
    branchId: BRANCH_ID,
    direction: "IN",
    amount: "5000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "ADVANCE-SHIFT-TREASURY-FUND",
    createdBy: REQUESTER_ID,
  });
  const [floatReceipt] = await connection.insert(s.receipts).values({
    branchId: BRANCH_ID,
    direction: "OUT",
    amount: OPENING_BALANCE,
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: `SF-${BRANCH_ID}-${SHIFT_ID}`,
    description: `عهدة افتتاح وردية #${SHIFT_ID}`,
    createdBy: EXECUTOR_ID,
  });
  await connection.insert(s.accountingEntries).values({
    entryType: "SHIFT_FLOAT_OUT",
    branchId: BRANCH_ID,
    receiptId: Number(floatReceipt.insertId),
    amount: OPENING_BALANCE,
    dedupeKey: `SHIFT_FLOAT:${SHIFT_ID}`,
    entryDate: new Date(`${todayUtcDate()}T12:00:00.000Z`),
  });
}

async function insertApprovedRequest(key: string, amount = ADVANCE_AMOUNT) {
  const [result] = await db()
    .insert(s.employeeLoanRequests)
    .values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount,
      installmentsCount: 1,
      monthlyDeduction: amount,
      reason: "اختبار عهدة صرف سلفة الموظف",
      status: "APPROVED",
      createdById: REQUESTER_ID,
      reviewedById: REVIEWER_ID,
      reviewedAt: new Date(),
      payrollPeriod: baghdadToday().slice(0, 7),
      clientRequestId: `employee-advance-shift-reporting-${key}`,
    });
  return Number(result.insertId);
}

async function expectNoFinancialEffect(requestId: number) {
  const connection = db();
  const [outReceipts, entries, advances, [request]] = await Promise.all([
    connection
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.direction, "OUT"),
          eq(s.receipts.cashBucket, "DRAWER"),
        ),
      ),
    connection
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT")),
    connection.select().from(s.employeeAdvances),
    connection
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.id, requestId)),
  ]);
  expect(outReceipts).toHaveLength(0);
  expect(entries).toHaveLength(0);
  expect(advances).toHaveLength(0);
  expect(request.status).toBe("APPROVED");
  expect(request.receiptId).toBeNull();
  expect(request.advanceId).toBeNull();
}

beforeEach(async () => {
  await resetDb();
  await seedBase();
});

describe("employee advance drawer custody and reporting", () => {
  it("يصرف من درج وردية المنفذ وينسب OUT إليه في Z وإقفال اليوم بلا أثر مكرر عند replay", async () => {
    const requestId = await insertApprovedRequest("success");

    expect(
      await getEmployeeLoanDisbursementReadiness(executorActor, requestId),
    ).toMatchObject({
      ready: true,
      shiftId: SHIFT_ID,
      availableBefore: OPENING_BALANCE,
      availableAfter: "700000.00",
      blockers: [],
    });

    const first = await disburseEmployeeLoan(executorActor, requestId);
    const replay = await disburseEmployeeLoan(executorActor, requestId);
    expect(replay).toEqual({ ...first, replayed: true });

    const receiptRows = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, first.receiptId));
    expect(receiptRows).toHaveLength(1);
    const [receipt] = receiptRows;
    expect(receipt).toMatchObject({
      branchId: BRANCH_ID,
      shiftId: SHIFT_ID,
      direction: "OUT",
      amount: ADVANCE_AMOUNT,
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: REQUESTER_ID,
      approvedBy: REVIEWER_ID,
      executedBy: EXECUTOR_ID,
    });

    const linkedEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, first.receiptId));
    expect(linkedEntries).toHaveLength(1);
    expect(linkedEntries[0]).toMatchObject({
      entryType: "PAYMENT_OUT",
      branchId: BRANCH_ID,
      receiptId: first.receiptId,
      amount: ADVANCE_AMOUNT,
    });

    const zReport = await getShiftReport(SHIFT_ID);
    expect(zReport).not.toBeNull();
    const zExpense = zReport?.cashReconciliation.breakdown.expenses.find(
      (item) => item.receiptId === first.receiptId,
    );
    expect(zExpense).toMatchObject({
      direction: "OUT",
      amount: ADVANCE_AMOUNT,
      cashBucket: "DRAWER",
      shiftId: SHIFT_ID,
      createdBy: EXECUTOR_ID,
      createdByName: executorName,
    });
    expect(zExpense?.createdBy).not.toBe(REQUESTER_ID);
    expect(zReport?.cashReconciliation.expenses).toBe(ADVANCE_AMOUNT);
    expect(zReport?.cashReconciliation.expectedCash).toBe("700000.00");

    const dayClose = await getDayCloseReconciliation({
      date: todayUtcDate(),
      branchId: BRANCH_ID,
    });
    const shiftLine = dayClose.shifts.find((line) => line.shiftId === SHIFT_ID);
    expect(shiftLine).toMatchObject({
      userId: EXECUTOR_ID,
      userName: executorName,
      expensesCash: ADVANCE_AMOUNT,
      operatingOut: ADVANCE_AMOUNT,
      expected: "700000.00",
    });
    const dayMovement = shiftLine?.movements.find(
      (movement) => movement.id === first.receiptId,
    );
    expect(dayMovement).toMatchObject({
      direction: "OUT",
      categoryType: "EXPENSE",
      amount: ADVANCE_AMOUNT,
      createdByName: executorName,
    });
    expect(dayMovement?.createdByName).not.toBe(requesterName);
    expect(
      shiftLine?.movements.filter(
        (movement) => movement.id === first.receiptId,
      ),
    ).toHaveLength(1);
    expect(dayClose.totals.shiftOperatingOut).toBe(ADVANCE_AMOUNT);
    expect(dayClose.totals.physicalDrawerCash).toBe("700000.00");
  });

  it("يفشل مغلقاً بلا وردية للمنفذ ولا يرجع إلى الخزينة", async () => {
    const requestId = await insertApprovedRequest("no-open-shift");

    expect(
      await getEmployeeLoanDisbursementReadiness(reviewerActor, requestId),
    ).toMatchObject({ ready: false, shiftId: null });

    await expect(
      disburseEmployeeLoan(reviewerActor, requestId),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expectNoFinancialEffect(requestId);
  });

  it("يرفض الصرف عندما لا يغطي رصيد درج المنفذ مبلغ السلفة", async () => {
    const requestId = await insertApprovedRequest("insufficient-drawer");
    await db()
      .update(s.shifts)
      .set({ openingBalance: "100000.00" })
      .where(eq(s.shifts.id, SHIFT_ID));
    await db()
      .update(s.receipts)
      .set({ amount: "100000.00" })
      .where(eq(s.receipts.referenceNumber, `SF-${BRANCH_ID}-${SHIFT_ID}`));
    await db()
      .update(s.accountingEntries)
      .set({ amount: "100000.00" })
      .where(eq(s.accountingEntries.dedupeKey, `SHIFT_FLOAT:${SHIFT_ID}`));

    expect(
      await getEmployeeLoanDisbursementReadiness(executorActor, requestId),
    ).toMatchObject({
      ready: false,
      shiftId: SHIFT_ID,
      availableBefore: "100000.00",
    });

    await expect(
      disburseEmployeeLoan(executorActor, requestId),
    ).rejects.toThrow(/رصيد الدرج المتاح.*أقل من المطلوب/);
    await expectNoFinancialEffect(requestId);
  });
});
