import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getCustomerOperations } from "../customerOperationsService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["tasks", "arReminders", "customerNotes", "invoices", "customers", "branches", "users"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "ops-admin", name: "مدير التحصيل", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values([
    { id: 1, name: "عميل متأخر", currentBalance: "1000", creditLimit: "800", isActive: true },
    { id: 2, name: "عميل دائن", currentBalance: "-200", creditLimit: "0", isActive: true },
    { id: 3, name: "عميل مسوّى", currentBalance: "0", creditLimit: null, isActive: false },
    { id: 4, name: "قريب من الحد", currentBalance: "850", creditLimit: "1000", isActive: true },
  ]);
  await d.insert(s.invoices).values({
    id: 1,
    invoiceNumber: "OPS-1",
    sourceType: "POS",
    sourceId: "ops-1",
    branchId: 1,
    customerId: 1,
    dueDate: daysAgo(15),
    subtotal: "1000",
    total: "1000",
    paidAmount: "0",
    status: "PENDING",
  });
  await d.insert(s.arReminders).values({
    customerId: 1,
    branchId: 1,
    totalUnpaidSnapshot: "1000",
    oldestInvoiceDate: daysAgo(15),
    daysOverdue: 15,
    messageBody: "وعد بالدفع",
    status: "SKIPPED",
    skipReason: "وعد العميل",
    promisedDate: daysAgo(1),
    createdBy: 1,
  });
  await d.insert(s.tasks).values({
    taskNumber: "TASK-OPS-1",
    branchId: 1,
    taskKind: "FOLLOW_UP",
    taskStatus: "NEW",
    priority: "HIGH",
    title: "متابعة العميل",
    customerId: 1,
    createdBy: 1,
  });
});

describe("getCustomerOperations", () => {
  it("يحسب الذمم والمتأخرات والحدود والوعود على جميع النتائج", async () => {
    const result = await getCustomerOperations({ includeInactive: true });
    expect(result.total).toBe(4);
    expect(result.summary.receivable).toBe("1850.00");
    expect(result.summary.customerCredit).toBe("200.00");
    expect(result.summary.net).toBe("1650.00");
    expect(result.summary.debtors).toBe(2);
    expect(result.summary.creditors).toBe(1);
    expect(result.summary.overdueAmount).toBe("1000.00");
    expect(result.summary.overdueCustomers).toBe(1);
    expect(result.summary.overLimit).toBe(1);
    expect(result.summary.nearLimit).toBe(1);
    expect(result.summary.promiseBroken).toBe(1);
    expect(result.summary.highestDebtor).toMatchObject({ customerId: 1, amount: "1000.00" });
    expect(result.summary.topFiveConcentrationPct).toBe(100);

    const overdue = result.rows.find((row) => row.id === 1);
    expect(overdue).toMatchObject({
      collectionStatus: "PROMISE_BROKEN",
      overdueAmount: "1000.00",
      openTasks: 1,
    });
  });

  it("تعمل فلاتر التشغيل فوق النتائج قبل الترقيم والملخص", async () => {
    const overLimit = await getCustomerOperations({ credit: "OVER_LIMIT" });
    expect(overLimit.total).toBe(1);
    expect(overLimit.rows.map((row) => row.id)).toEqual([1]);
    expect(overLimit.summary.receivable).toBe("1000.00");

    const nearLimit = await getCustomerOperations({ credit: "NEAR_LIMIT" });
    expect(nearLimit.rows.map((row) => row.id)).toEqual([4]);

    const credits = await getCustomerOperations({ balance: "CREDIT" });
    expect(credits.rows.map((row) => row.id)).toEqual([2]);
    expect(credits.summary.customerCredit).toBe("200.00");
  });
});
