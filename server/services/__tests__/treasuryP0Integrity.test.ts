import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createCashDrop } from "../cashDropService";
import { createExpense } from "../expenseService";
import { openShift } from "../shiftService";
import { getTreasurySummary } from "../reportsTreasuryService";
import { getDashboard } from "../treasury/dashboard";
import { getRecentMovements } from "../treasury/movements";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const CASHIER = 11;
const MANAGER = 12;
const OTHER_MANAGER = 13;

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "accountingEntries",
    "idempotencyKeys",
    "expenses",
    "receipts",
    "shifts",
    "users",
    "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SECOND", code: "SECOND", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: CASHIER, openId: "p0-cashier", name: "Cashier", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER, openId: "p0-manager", name: "Manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: OTHER_MANAGER, openId: "p0-manager-2", name: "Other manager", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
});

describe("treasury P0 integrity", () => {
  it("rejects cashier-created expenses before any cash or expense row is written", async () => {
    await expect(
      createExpense(
        {
          branchId: 1,
          amount: "750000",
          category: "OTHER",
          paymentMethod: "CASH",
          description: "attempt to conceal drawer shortage",
        },
        { userId: CASHIER, branchId: 1, role: "cashier" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(s.expenses)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("requires a distinct same-branch recipient and keeps cash-drop receipt pending outside treasury balance", async () => {
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "100000", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-FUND", createdBy: MANAGER,
    });
    const { shiftId } = await openShift(
      { branchId: 1, openingBalance: "100000" },
      { userId: CASHIER, branchId: 1 },
    );

    await expect(
      createCashDrop(
        { shiftId, amount: "10000" },
        { userId: CASHIER, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/تحديد مدير مستلم/);
    await expect(
      createCashDrop(
        { shiftId, amount: "10000", dropTo: OTHER_MANAGER },
        { userId: CASHIER, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/فرع الوردية نفسه/);

    const result = await createCashDrop(
      { shiftId, amount: "10000", dropTo: MANAGER, clientRequestId: "p0-drop-1" },
      { userId: CASHIER, branchId: 1, role: "cashier" },
    );
    const contract = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, result.inReceiptId))
    )[0];
    expect(contract.direction).toBe("IN");
    expect(contract.cashBucket).toBe("TREASURY");
    expect(contract.status).toBe("PENDING");
    expect(contract.createdBy).toBe(MANAGER);

    // العهدة الوسيطة: تمويل 100000 ثم فتح الوردية يسحبها كاملةً ⇒ الخزينة صفر.
    // السحب النقديّ المعلّق (PENDING) لا يُضاف حتى يُقبَل؛ وإلا ظهر 10000 وهمياً.
    const dashboard = await getDashboard(
      { branchId: 1 },
      { scopedBranchId: null, role: "admin", userId: MANAGER },
    );
    expect(dashboard.treasuryBalances.find((r) => r.branchId === 1)?.balance).toBe("0.00");
  });

  it("excludes unapproved receipts from treasury summaries", async () => {
    await db().insert(s.receipts).values([
      {
        branchId: 1,
        direction: "IN",
        amount: "500000",
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "PENDING_APPROVAL",
        partyType: "OTHER",
        createdBy: MANAGER,
      },
      {
        branchId: 1,
        direction: "IN",
        amount: "100000",
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        partyType: "OTHER",
        createdBy: MANAGER,
      },
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const summary = await getTreasurySummary({ from: today, to: today, branchId: 1 });
    expect(summary.totalIn).toBe("100000.00");

    const dashboard = await getDashboard(
      { branchId: 1 },
      { scopedBranchId: null, role: "admin", userId: MANAGER },
    );
    expect(dashboard.todayReceiptsTotal).toBe("100000.00");
  });

  it("shows a linked cash expense once in recent movements", async () => {
    const receiptInsert = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "25000",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: MANAGER,
    });
    const receiptId = Number((receiptInsert as any)[0]?.insertId ?? (receiptInsert as any).insertId);
    await db().insert(s.expenses).values({
      branchId: 1,
      expenseDate: new Date(),
      category: "OTHER",
      amount: "25000",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      receiptId,
      status: "ACTIVE",
      createdBy: MANAGER,
    });

    const rows = await getRecentMovements(
      { branchId: 1, limit: 20 },
      { scopedBranchId: null, role: "admin", userId: MANAGER },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "RECEIPT", direction: "OUT", amount: "25000.00" });
  });
});
