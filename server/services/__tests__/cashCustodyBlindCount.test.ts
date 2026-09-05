import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function makeCtx(user: any) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any;
}

const CASHIER = 31;
const RECIPIENT = 32;
const OTHER_ELIGIBLE_MANAGER = 33;

async function loadUser(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

async function seedCustody(input: {
  prefix: "CH" | "CD";
  amount: string;
  opening: string;
}) {
  const shiftResult = await db().insert(s.shifts).values({
    branchId: 1,
    userId: CASHIER,
    openingBalance: input.opening,
    status: "CLOSED",
    countedCash: input.amount,
    expectedCash: input.amount,
    variance: "0",
    closedAt: new Date(),
  });
  const shiftId = Number(
    (shiftResult as any)[0]?.insertId ?? (shiftResult as any).insertId,
  );
  const referenceNumber = `${input.prefix}-1-20260831-BLIND-${shiftId}`;
  await db().insert(s.receipts).values({
    branchId: 1,
    shiftId,
    direction: "OUT",
    amount: input.amount,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    referenceNumber,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    description: "خروج عهدة نقدية للاختبار",
    createdBy: CASHIER,
  });
  const pendingResult = await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: input.amount,
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber,
    status: "PENDING",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    description: "عهدة بانتظار العد الأعمى",
    createdBy: RECIPIENT,
  });
  const treasuryReceiptId = Number(
    (pendingResult as any)[0]?.insertId ?? (pendingResult as any).insertId,
  );
  return { shiftId, referenceNumber, treasuryReceiptId, amount: input.amount };
}

async function recordFirstCount(
  contract: Awaited<ReturnType<typeof seedCustody>>,
  requestId: string,
  count: {
    countedAmount: string;
    variance: string;
    status: "MATCHED" | "VARIANCE_OPEN";
  } = { countedAmount: contract.amount, variance: "0", status: "MATCHED" },
) {
  await db().insert(s.cashCustodyCounts).values({
    treasuryReceiptId: contract.treasuryReceiptId,
    clientRequestId: requestId,
    declaredAmount: contract.amount,
    countedAmount: count.countedAmount,
    variance: count.variance,
    countedBreakdown: {},
    status: count.status,
    countedByUserId: RECIPIENT,
  });
}

beforeEach(async () => {
  const value = db();
  await value.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "cashCustodyCounts",
    "accountingEntries",
    "receipts",
    "shifts",
    "users",
    "branches",
  ]) {
    await value.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await value.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await value.insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await value.insert(s.users).values([
    {
      id: CASHIER,
      openId: "blind-cashier",
      name: "مسلّم النقد",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: RECIPIENT,
      openId: "blind-recipient",
      name: "المستلم المسند",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: OTHER_ELIGIBLE_MANAGER,
      openId: "blind-other-manager",
      name: "مدير مؤهل آخر",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
});

describe("cash custody blind-count visibility", () => {
  it("blocks CH and CD amount correlation by reference and shift until each first count", async () => {
    const ch = await seedCustody({ prefix: "CH", amount: "75000.00", opening: "75000.00" });
    const cd = await seedCustody({ prefix: "CD", amount: "42000.00", opening: "84000.00" });
    const date = new Date().toISOString().slice(0, 10);
    const recipient = appRouter.createCaller(makeCtx(await loadUser(RECIPIENT)));
    const otherEligible = appRouter.createCaller(
      makeCtx(await loadUser(OTHER_ELIGIBLE_MANAGER)),
    );

    const queue = await recipient.treasury.pendingHandoverReceipts();
    expect(queue.map((row) => row.referenceNumber).sort()).toEqual(
      [ch.referenceNumber, cd.referenceNumber].sort(),
    );
    expect(queue.map((row) => row.sourceShiftId).sort()).toEqual(
      [ch.shiftId, cd.shiftId].sort(),
    );

    for (const caller of [recipient, otherEligible]) {
      const movements = await caller.treasury.getRecentMovements({ branchId: 1, limit: 100 });
      expect(
        movements.rows.some(
          (row) =>
            row.referenceNumber === ch.referenceNumber ||
            row.referenceNumber === cd.referenceNumber ||
            row.shiftId === ch.shiftId ||
            row.shiftId === cd.shiftId,
        ),
      ).toBe(false);
      expect(JSON.stringify(movements)).not.toContain("75000.00");
      expect(JSON.stringify(movements)).not.toContain("42000.00");

      const report = await caller.reports.dayCloseReconciliation({ date, branchId: 1 });
      expect(report.withheldBlindCountShiftCount).toBe(2);
      expect(report.shifts).toEqual([]);
      expect(report.totals).toMatchObject({
        handoversCash: "0.00",
        cashDrops: "0.00",
        expected: "0.00",
        counted: "0.00",
        drift: "0.00",
      });
      expect(JSON.stringify(report)).not.toContain("75000.00");
      expect(JSON.stringify(report)).not.toContain("42000.00");
    }

    await recordFirstCount(ch, "blind-ch-first-count", {
      countedAmount: "50000.00",
      variance: "-25000.00",
      status: "VARIANCE_OPEN",
    });

    const afterChMovements = await recipient.treasury.getRecentMovements({
      branchId: 1,
      limit: 100,
    });
    expect(
      afterChMovements.rows.find((row) => row.referenceNumber === ch.referenceNumber),
    ).toMatchObject({ amount: "75000.00", shiftId: ch.shiftId });
    expect(
      afterChMovements.rows.some(
        (row) => row.referenceNumber === cd.referenceNumber || row.shiftId === cd.shiftId,
      ),
    ).toBe(false);

    const afterChReport = await recipient.reports.dayCloseReconciliation({
      date,
      branchId: 1,
    });
    expect(afterChReport.withheldBlindCountShiftCount).toBe(1);
    expect(afterChReport.shifts.map((row) => row.shiftId)).toEqual([ch.shiftId]);
    expect(afterChReport.shifts[0]).toMatchObject({
      handoversCash: "75000.00",
      counted: "75000.00",
      drift: "0.00",
    });

    await recordFirstCount(cd, "blind-cd-first-count");
    const fullyRevealed = await recipient.reports.dayCloseReconciliation({
      date,
      branchId: 1,
    });
    expect(fullyRevealed.withheldBlindCountShiftCount).toBe(0);
    expect(fullyRevealed.shifts.map((row) => row.shiftId).sort()).toEqual(
      [ch.shiftId, cd.shiftId].sort(),
    );
  });
});
