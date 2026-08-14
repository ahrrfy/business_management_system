import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { cashRemediationRouter } from "../../../routers/cashRemediationRouter";
import { getDb } from "../../../db";
import { getCashRemediationDryRun } from "../reportService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function rowCounts() {
  const d = db();
  const [receiptCount, expenseCount, entryCount] = await Promise.all([
    d.select({ count: sql<number>`COUNT(*)` }).from(s.receipts),
    d.select({ count: sql<number>`COUNT(*)` }).from(s.expenses),
    d.select({ count: sql<number>`COUNT(*)` }).from(s.accountingEntries),
  ]);
  return {
    receipts: Number(receiptCount[0]?.count ?? 0),
    expenses: Number(expenseCount[0]?.count ?? 0),
    entries: Number(entryCount[0]?.count ?? 0),
  };
}

describe("getCashRemediationDryRun — DB read-only", () => {
  it("يجلب المصدر والقيد ويثبت أن التقرير والمحاكاة لا تغير أي صف", async () => {
    const d = db();
    await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
    await d.insert(s.users).values({ id: 7, openId: "u_taghreed", name: "تغريد", role: "cashier", branchId: 1 });
    await d.insert(s.shifts).values({
      id: 11,
      branchId: 1,
      userId: 7,
      openingBalance: "100.00",
      expectedCash: "-50.00",
      countedCash: "100.00",
      variance: "150.00",
      status: "CLOSED",
      openedAt: new Date("2026-02-01T08:00:00.000Z"),
      closedAt: new Date("2026-02-01T16:00:00.000Z"),
    });
    await d.insert(s.receipts).values([
      {
        id: 21,
        shiftId: 11,
        branchId: 1,
        direction: "IN",
        amount: "20.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        createdBy: 7,
        createdAt: new Date("2026-02-01T09:00:00.000Z"),
      },
      {
        id: 22,
        shiftId: 11,
        branchId: 1,
        direction: "OUT",
        amount: "150.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        description: "صرف نقل",
        createdBy: 7,
        createdAt: new Date("2026-02-01T10:00:00.000Z"),
      },
    ]);
    await d.insert(s.expenses).values({
      id: 31,
      branchId: 1,
      shiftId: 11,
      expenseDate: "2026-02-01",
      category: "TRANSPORT",
      amount: "150.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      description: "صرف نقل",
      payee: "شركة نقل",
      receiptId: 22,
      createdBy: 7,
    });
    await d.insert(s.accountingEntries).values({
      id: 41,
      entryType: "PAYMENT_OUT",
      branchId: 1,
      receiptId: 22,
      amount: "150.00",
      entryDate: "2026-02-01",
      createdBy: 7,
    });

    const before = await rowCounts();
    const report = await getCashRemediationDryRun({
      from: "2026-02-01",
      to: "2026-02-01",
      branchId: 1,
      simulations: [{ receiptId: 22, classification: "TREASURY_PAID" }],
    });
    const after = await rowCounts();

    expect(after).toEqual(before);
    expect(report.mode).toBe("DRY_RUN_READ_ONLY");
    expect(report.shifts[0].firstNegative?.receiptId).toBe(22);
    expect(report.shifts[0].outflows[0].source).toMatchObject({
      documentType: "EXPENSE",
      documentId: 31,
      ledgerEntryIds: [41],
      ledgerEntryTypes: ["PAYMENT_OUT"],
    });
    expect(report.shifts[0].afterSimulation).toMatchObject({
      expectedCash: "120.00",
      drawerDelta: "150.00",
      treasuryDelta: "-150.00",
    });
    expect(report.safeguards.sourceRowsChanged).toBe(0);
  });
});

describe("cashRemediationRouter", () => {
  it("يعرض query واحدة فقط ولا يعرّف أي mutation", () => {
    const procedures = cashRemediationRouter._def.procedures as Record<string, { _def: { type: string } }>;
    expect(Object.keys(procedures)).toEqual(["dryRun"]);
    expect(procedures.dryRun._def.type).toBe("query");
  });

  it("يرفض مدير الفرع عند طلب فرع أجنبي أو عند غياب فرعه", async () => {
    const context = (branchId: number | null) => ({
      req: { headers: {} },
      res: { cookie() {}, clearCookie() {} },
      user: {
        id: 7,
        role: "manager",
        branchId,
        isOwner: false,
        permissionsOverride: null,
      },
    }) as never;
    const foreignCaller = cashRemediationRouter.createCaller(context(1));
    await expect(
      foreignCaller.dryRun({ from: "2026-01-01", to: "2026-01-01", branchId: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const unassignedCaller = cashRemediationRouter.createCaller(context(null));
    await expect(
      unassignedCaller.dryRun({ from: "2026-01-01", to: "2026-01-01" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
