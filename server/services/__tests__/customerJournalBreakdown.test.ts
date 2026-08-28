/**
 * Tier-3 #6 (٢٧/٨) — تقرير: تفصيل حساب العميل بالحسابات المحاسبيّة.
 *
 * الحالات المُثبَتة:
 *   • بلا صفوف journalLines ⇒ empty result (لا كسر).
 *   • صفوفٌ لعميلَين مختلفَين ⇒ فقط ما يخصّ customerId المطلوب.
 *   • الأسطر بلا accountId مُستبعَدة (نطاق Tier-3 #5).
 *   • الأسطر برأسٍ UNMAPPED مُستبعَدة.
 *   • مجموع مدين وائتمان والصافي محسوبةٌ صحيحاً.
 *   • فلترة branchId تقصر على فرعٍ واحد.
 *   • فلترة from/to تقصر على مدى التاريخ.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { getCustomerJournalBreakdown } from "../reports/customerJournalBreakdown";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "accounts",
  "customers",
  "branches",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`DELETE FROM \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.customers).values([
    { id: 100, name: "عميل الاختبار", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
    { id: 200, name: "عميل آخر", phone: "+9647709999999", currentBalance: "0.00", creditLimit: null },
  ]);
  const [ar] = await d.insert(s.accounts).values({
    code: "1100", name: "ذمم مدينة", type: "ASSET", systemRole: "AR",
  });
  const [sales] = await d.insert(s.accounts).values({
    code: "4100", name: "مبيعات قرطاسية", type: "REVENUE", systemRole: "SALES_STATIONERY",
  });
  return {
    arId: Number((ar as { insertId: number }).insertId),
    salesId: Number((sales as { insertId: number }).insertId),
  };
}

async function seedEntry(): Promise<number> {
  const res = await db().insert(s.accountingEntries).values({
    entryType: "SALE",
    revenue: "100.00",
    cost: "0.00",
    profit: "100.00",
    taxAmount: "0.00",
    amount: "100.00",
    entryDate: new Date("2026-08-11"),
  });
  return extractInsertId(res);
}

async function seedJournal(
  entryId: number,
  branchId: number | null = 1,
  entryDate = new Date("2026-08-11"),
  status: "POSTED" | "UNMAPPED" = "POSTED",
): Promise<number> {
  const res = await db().insert(s.journalEntries).values({
    entryId, sourceType: "ACCOUNTING_ENTRY", entryDate, branchId, status,
  });
  return extractInsertId(res);
}

describe("getCustomerJournalBreakdown", () => {
  beforeEach(async () => { await reset(); });

  it("لا صفوف journalLines ⇒ مجموعُ ٠ ونتيجةٌ فارغة", async () => {
    await seed();
    const result = await getCustomerJournalBreakdown({ customerId: 100 });
    expect(result.rows).toEqual([]);
    expect(result.totalDebit).toBe("0.00");
    expect(result.totalCredit).toBe("0.00");
    expect(result.totalNet).toBe("0.00");
  });

  it("يجمع مدين/دائن لحساباتِ العميل المطلوب فقط", async () => {
    const { arId, salesId } = await seed();
    const entryId1 = await seedEntry();
    const journalId1 = await seedJournal(entryId1);
    // قيدُ عميلنا (customerId=100): AR مدين 100، SALES دائن 100.
    await db().insert(s.journalLines).values([
      { journalId: journalId1, role: "AR", accountId: arId, customerId: 100, branchId: 1, debit: "100.00", credit: "0.00" },
      { journalId: journalId1, role: "SALES_STATIONERY", accountId: salesId, customerId: 100, branchId: 1, debit: "0.00", credit: "100.00" },
    ]);
    // قيدُ عميلٍ آخر (200): AR مدين 500 — يجب أن يُستبعَد.
    const entryId2 = await seedEntry();
    const journalId2 = await seedJournal(entryId2);
    await db().insert(s.journalLines).values([
      { journalId: journalId2, role: "AR", accountId: arId, customerId: 200, branchId: 1, debit: "500.00", credit: "0.00" },
    ]);

    const result = await getCustomerJournalBreakdown({ customerId: 100 });
    expect(result.rows).toHaveLength(2);
    const ar = result.rows.find((r) => r.systemRole === "AR");
    const sales = result.rows.find((r) => r.systemRole === "SALES_STATIONERY");
    expect(ar?.debitTotal).toBe("100.00");
    expect(ar?.creditTotal).toBe("0.00");
    expect(sales?.debitTotal).toBe("0.00");
    expect(sales?.creditTotal).toBe("100.00");
    expect(result.totalDebit).toBe("100.00");
    expect(result.totalCredit).toBe("100.00");
    expect(result.totalNet).toBe("0.00");
  });

  it("الأسطر بلا accountId مُستبعَدة (نطاق Tier-3 #5)", async () => {
    await seed();
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId);
    await db().insert(s.journalLines).values({
      journalId, role: "AR", accountId: null, customerId: 100, branchId: 1, debit: "50.00", credit: "0.00",
    });
    const result = await getCustomerJournalBreakdown({ customerId: 100 });
    expect(result.rows).toEqual([]);
  });

  it("رأسٌ UNMAPPED مُستبعَد", async () => {
    const { arId } = await seed();
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId, 1, new Date("2026-08-11"), "UNMAPPED");
    await db().insert(s.journalLines).values({
      journalId, role: "AR", accountId: arId, customerId: 100, branchId: 1, debit: "50.00", credit: "0.00",
    });
    const result = await getCustomerJournalBreakdown({ customerId: 100 });
    expect(result.rows).toEqual([]);
  });

  it("فلترة branchId تُقصِر النتيجة على فرعٍ واحد", async () => {
    const { arId } = await seed();
    const entryId1 = await seedEntry();
    const journalIdMain = await seedJournal(entryId1, 1);
    const entryId2 = await seedEntry();
    const journalIdSales = await seedJournal(entryId2, 2);
    await db().insert(s.journalLines).values([
      { journalId: journalIdMain, role: "AR", accountId: arId, customerId: 100, branchId: 1, debit: "100.00", credit: "0.00" },
      { journalId: journalIdSales, role: "AR", accountId: arId, customerId: 100, branchId: 2, debit: "200.00", credit: "0.00" },
    ]);
    const result = await getCustomerJournalBreakdown({ customerId: 100, branchId: 1 });
    expect(result.totalDebit).toBe("100.00");
  });

  it("فلترة from/to تقصر على مدى التاريخ", async () => {
    const { arId } = await seed();
    const entryId1 = await seedEntry();
    const journalIdEarly = await seedJournal(entryId1, 1, new Date("2026-07-15"));
    const entryId2 = await seedEntry();
    const journalIdLate = await seedJournal(entryId2, 1, new Date("2026-08-15"));
    await db().insert(s.journalLines).values([
      { journalId: journalIdEarly, role: "AR", accountId: arId, customerId: 100, branchId: 1, debit: "100.00", credit: "0.00" },
      { journalId: journalIdLate, role: "AR", accountId: arId, customerId: 100, branchId: 1, debit: "200.00", credit: "0.00" },
    ]);
    // نطاق فقط أغسطس ⇒ نلتقط الثاني.
    const result = await getCustomerJournalBreakdown({
      customerId: 100, from: "2026-08-01", to: "2026-08-31",
    });
    expect(result.totalDebit).toBe("200.00");
  });
});
