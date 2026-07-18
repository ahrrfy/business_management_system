// عزل درج الكاشير في سجلّ الحركات (تدقيق ١٧/٧): الكاشير يرى حركات ورديّاته فقط لا دروج زملائه.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getRecentMovements } from "../treasury/movements";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId);

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["accountingEntries", "receipts", "expenses", "shifts", "users", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeEach(async () => {
  await reset();
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "c1", name: "كاشير ١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c2", name: "كاشير ٢", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 9, openId: "adm", name: "مدير", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
});

async function seedShiftReceipt(userId: number, amount: string, ref: string) {
  const d = db();
  const sh = await d.insert(s.shifts).values({ branchId: 1, userId, openingBalance: "0", status: "OPEN" });
  const shiftId = insertId(sh);
  await d.insert(s.receipts).values({
    branchId: 1, shiftId, direction: "IN", amount, paymentMethod: "CASH", cashBucket: "DRAWER",
    status: "COMPLETED", partyType: "OTHER", referenceNumber: ref, createdBy: userId,
  });
}

describe("getRecentMovements — عزل درج الكاشير (تدقيق ١٧/٧)", () => {
  it("الكاشير يرى حركات ورديّاته فقط لا درج زميله في الفرع نفسه", async () => {
    await seedShiftReceipt(1, "100.00", "R-A"); // درج كاشير ١
    await seedShiftReceipt(2, "200.00", "R-B"); // درج كاشير ٢

    const rowsC1 = await getRecentMovements({ branchId: 1 }, { scopedBranchId: 1, role: "cashier", userId: 1 });
    expect(rowsC1.map((r) => r.amount)).toEqual(["100.00"]); // R-A فقط

    const rowsC2 = await getRecentMovements({ branchId: 1 }, { scopedBranchId: 1, role: "cashier", userId: 2 });
    expect(rowsC2.map((r) => r.amount)).toEqual(["200.00"]); // R-B فقط

    // الأدمن يرى درجَي الفرع كليهما (لا عزل على المرتفع).
    const rowsAdmin = await getRecentMovements({ branchId: 1 }, { scopedBranchId: null, role: "admin", userId: 9 });
    expect(rowsAdmin.length).toBe(2);
  });
});
