/**
 * Tier-3 #5 (٢٧/٨) — كاشف أيتام journalLines.
 *
 * الحالات المُثبَتة هنا:
 *   • رأسٌ POSTED + سطرٌ بلا accountId + role موجود ⇒ journalLineMissingBackfill.
 *   • رأسٌ POSTED + سطرٌ بلا accountId + role مجهول ⇒ journalLineUnknownRole.
 *   • رأسٌ POSTED + سطرٌ بـaccountId مُملَّى ⇒ لا انحراف.
 *   • رأسٌ UNMAPPED/MEMO أو SHADOW_OPENING ⇒ يُستبعَد (لا يُطبَّق العقد).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { reconcileOrphanJournalLines } from "../reconcileService";

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
  "doubleEntrySettings",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`DELETE FROM \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedEntry(): Promise<number> {
  const res = await db().insert(s.accountingEntries).values({
    entryType: "SALE",
    revenue: "150.00",
    cost: "0.00",
    profit: "150.00",
    taxAmount: "0.00",
    amount: "150.00",
    entryDate: new Date("2026-08-11"),
  });
  return extractInsertId(res);
}

async function seedJournal(
  entryId: number,
  status: "POSTED" | "UNMAPPED" | "MEMO" = "POSTED",
  sourceType: "ACCOUNTING_ENTRY" | "SHADOW_OPENING" = "ACCOUNTING_ENTRY",
): Promise<number> {
  const res = await db().insert(s.journalEntries).values({
    entryId,
    sourceType,
    sourceKey: sourceType === "SHADOW_OPENING" ? `SO-${entryId}` : null,
    entryDate: new Date("2026-08-11"),
    branchId: null,
    status,
  });
  return extractInsertId(res);
}

describe("reconcileOrphanJournalLines", () => {
  beforeEach(async () => { await reset(); });

  it("سطرٌ POSTED بلا accountId + role موجودٌ في accounts ⇒ journalLineMissingBackfill", async () => {
    await db().insert(s.accounts).values({ code: "1100", name: "ذمم مدينة", type: "ASSET", systemRole: "AR" });
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId);
    await db().insert(s.journalLines).values({
      journalId, role: "AR", accountId: null, debit: "150.00", credit: "0.00",
    });

    const issues = await reconcileOrphanJournalLines();
    expect(issues).toHaveLength(1);
    expect(issues[0].entity).toBe("journalLineMissingBackfill");
    expect(issues[0].note).toContain("backfill");
  });

  it("سطرٌ POSTED بلا accountId + role مجهول ⇒ journalLineUnknownRole", async () => {
    // لا نبذر حساباً بـsystemRole=WEIRD_ROLE.
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId);
    await db().insert(s.journalLines).values({
      journalId, role: "WEIRD_ROLE", accountId: null, debit: "150.00", credit: "0.00",
    });

    const issues = await reconcileOrphanJournalLines();
    expect(issues).toHaveLength(1);
    expect(issues[0].entity).toBe("journalLineUnknownRole");
    expect(issues[0].note).toContain("drift");
  });

  it("سطرٌ POSTED بـaccountId مُملَّى ⇒ لا انحراف", async () => {
    const [inserted] = await db().insert(s.accounts).values({
      code: "1100", name: "ذمم مدينة", type: "ASSET", systemRole: "AR",
    });
    const accId = Number((inserted as { insertId: number }).insertId);
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId);
    await db().insert(s.journalLines).values({
      journalId, role: "AR", accountId: accId, debit: "150.00", credit: "0.00",
    });

    expect(await reconcileOrphanJournalLines()).toEqual([]);
  });

  it("رأسٌ UNMAPPED ⇒ يُستبعَد (لا يُطبَّق العقد على قيدٍ غير مُخطَّط)", async () => {
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId, "UNMAPPED");
    await db().insert(s.journalLines).values({
      journalId, role: "AR", accountId: null, debit: "150.00", credit: "0.00",
    });
    // ليس هذا نمطاً معتاداً (UNMAPPED عادةً بلا أسطر) لكنّ الكاشف يجب أن يُصفّي بالحالة.
    expect(await reconcileOrphanJournalLines()).toEqual([]);
  });

  it("رأسٌ SHADOW_OPENING ⇒ يُستبعَد (بيانات استيرادٍ تاريخية)", async () => {
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId, "POSTED", "SHADOW_OPENING");
    await db().insert(s.journalLines).values({
      journalId, role: "AR", accountId: null, debit: "150.00", credit: "0.00",
    });
    expect(await reconcileOrphanJournalLines()).toEqual([]);
  });

  it("سطران بنفس role مجهول ⇒ يُبَلَّغ عن كلٍّ منهما (لا اجتزال — كلٌّ عطبٌ مستقلّ)", async () => {
    const entryId = await seedEntry();
    const journalId = await seedJournal(entryId);
    await db().insert(s.journalLines).values([
      { journalId, role: "WEIRD", accountId: null, debit: "50.00", credit: "0.00" },
      { journalId, role: "WEIRD", accountId: null, debit: "0.00", credit: "50.00" },
    ]);
    const issues = await reconcileOrphanJournalLines();
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.entity === "journalLineUnknownRole")).toBe(true);
  });
});
