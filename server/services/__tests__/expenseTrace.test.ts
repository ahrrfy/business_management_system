import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveExpense,
  createExpense,
  getExpenseTrace,
  listExpenses,
} from "../expenseService";
import { openShift } from "../shiftService";

const manager1 = { userId: 1, branchId: 1, role: "manager" };
const manager2 = { userId: 2, branchId: 1, role: "manager" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "auditLogs",
    "accountingEntries",
    "expenseStockItems",
    "receipts",
    "expenses",
    "shifts",
    "branches",
    "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "expense-trace-m1",
      name: "مروة",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "expense-trace-m2",
      name: "تغريد",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "20000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "EXPENSE-TRACE-TREASURY-FUND",
    createdBy: manager1.userId,
  });
}

beforeEach(reset);

describe("عقد التتبع التفصيلي للمصروفات", () => {
  it("يعيد المنشئ وصاحب الدرج والسند والاعتماد والفلاتر والمجاميع", async () => {
    const { shiftId } = await openShift(
      { branchId: 1, openingBalance: "5000" },
      manager1,
    );
    const created = await createExpense(
      {
        branchId: 1,
        shiftId,
        cashSource: "OWN_DRAWER",
        category: "UTILITIES",
        amount: "1250.00",
        paymentMethod: "CASH",
        description: "اشتراك الإنترنت",
        referenceNumber: "NET-1250",
        payee: "شركة الإنترنت",
        costCenter: "الإدارة والتشغيل",
        isRecurring: true,
        recurringFrequency: "MONTHLY",
      },
      manager1,
    );

    const listed = await listExpenses({
      fundingKind: "DRAWER",
      createdBy: 1,
      shiftId,
      amount: "1250.00",
      q: "1250",
    });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]).toMatchObject({
      id: created.expenseId,
      branchName: "الرئيسي",
      branchCode: "MAIN",
      cashBucket: "DRAWER",
      fundingKind: "DRAWER",
      payee: "شركة الإنترنت",
      costCenter: "الإدارة والتشغيل",
      isRecurring: true,
      recurringFrequency: "MONTHLY",
      receiptId: created.receiptId,
      linkedReceiptId: created.receiptId,
      createdBy: 1,
      createdByName: "مروة",
      shiftOwnerId: 1,
      shiftOwnerName: "مروة",
      shiftStatus: "OPEN",
      receiptDirection: "OUT",
      receiptStatus: "COMPLETED",
      receiptApprovalStatus: "APPROVED",
      receiptApprovedBy: null,
      needsAudit: false,
      integrityWarnings: [],
    });
    expect(listed.totals).toMatchObject({
      active: "1250.00",
      drawer: "1250.00",
      treasury: "0.00",
      nonCash: "0.00",
      stock: "0.00",
      cancelled: "0.00",
      needsAudit: 0,
      count: 1,
    });

    const trace = await getExpenseTrace(created.expenseId, { branchId: 1 });
    expect(trace?.expense.createdByName).toBe("مروة");
    expect(trace?.ledgerEntries).toHaveLength(1);
    expect(trace?.ledgerEntries[0]).toMatchObject({
      entryType: "PAYMENT_OUT",
      createdBy: 1,
    });
  });

  it("طلب TREASURY لا ينفذ قبل اعتماد مالك آخر وOWN_DRAWER يرفض وردية شخص آخر", async () => {
    const own = await openShift(
      { branchId: 1, openingBalance: "1000" },
      manager1,
    );
    const treasury = await createExpense(
      {
        branchId: 1,
        shiftId: own.shiftId,
        cashSource: "TREASURY",
        category: "RENT",
        amount: "300.00",
        paymentMethod: "CASH",
        description: "صرف من الخزينة",
        payee: "مستفيد موثق",
      },
      manager1,
    );
    const pendingRow = (await listExpenses({ status: "PENDING_APPROVAL" }))
      .rows[0];
    expect(pendingRow).toMatchObject({
      id: treasury.expenseId,
      shiftId: null,
      cashBucket: null,
      status: "PENDING_APPROVAL",
      needsAudit: false,
    });
    await approveExpense(treasury.expenseId, {
      ...manager2,
      isOwner: true,
    });
    const treasuryRow = (await listExpenses({ fundingKind: "TREASURY" }))
      .rows[0];
    expect(treasuryRow).toMatchObject({
      id: treasury.expenseId,
      shiftId: null,
      cashBucket: "TREASURY",
      fundingKind: "TREASURY",
      needsAudit: false,
    });

    const other = await openShift(
      { branchId: 1, openingBalance: "1000" },
      manager2,
    );
    await expect(
      createExpense(
        {
          branchId: 1,
          shiftId: other.shiftId,
          cashSource: "OWN_DRAWER",
          category: "SUPPLIES",
          amount: "50.00",
          paymentMethod: "CASH",
          description: "محاولة درج آخر",
        },
        manager1,
      ),
    ).rejects.toThrow(/درج وردية المُنشئ فقط/);
  });

  it("يكشف اختلاف المصروف عن السند ويحسب needsAudit", async () => {
    const created = await createExpense(
      {
        branchId: 1,
        category: "MAINTENANCE",
        amount: "400.00",
        paymentMethod: "TRANSFER",
        description: "صيانة",
        referenceNumber: "TX-400",
        payee: "الفني",
      },
      manager1,
    );
    await approveExpense(created.expenseId, {
      ...manager2,
      isOwner: true,
    });
    await db()
      .update(s.receipts)
      .set({ amount: "401.00" })
      .where(eq(s.receipts.id, created.receiptId!));

    const listed = await listExpenses({ fundingKind: "NON_CASH", q: "الفني" });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0].fundingKind).toBe("NON_CASH");
    expect(listed.rows[0].integrityWarnings).toContain(
      "RECEIPT_AMOUNT_MISMATCH",
    );
    expect(listed.rows[0].needsAudit).toBe(true);
    expect(listed.totals).toMatchObject({ nonCash: "400.00", needsAudit: 1 });
  });
});
