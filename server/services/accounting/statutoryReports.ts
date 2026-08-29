import { eq, sql } from "drizzle-orm";
import {
  doubleEntrySettings,
  statutoryAccountingProfiles,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";

function requireDb(): NonNullable<ReturnType<typeof getDb>> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL غير مضبوط");
  return db;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[];
  return result as T[];
}

async function reportContext(profileId?: number) {
  const db = requireDb();
  const profile = profileId
    ? (
        await db
          .select()
          .from(statutoryAccountingProfiles)
          .where(eq(statutoryAccountingProfiles.id, profileId))
          .limit(1)
      )[0]
    : (
        await db
          .select()
          .from(statutoryAccountingProfiles)
          .where(eq(statutoryAccountingProfiles.status, "ACTIVE"))
          .limit(1)
      )[0];
  if (!profile || profile.status === "DRAFT") return null;
  const runtime = (
    await db
      .select({
        mode: doubleEntrySettings.mode,
        cycleId: doubleEntrySettings.shadowCycleId,
      })
      .from(doubleEntrySettings)
      .where(eq(doubleEntrySettings.id, 1))
      .limit(1)
  )[0];
  return {
    db,
    profile,
    mode: runtime?.mode ?? "OFF",
    cycleId: runtime?.cycleId ?? null,
  };
}

export async function getStatutoryTrialBalance(input: {
  from: string;
  to: string;
  profileId?: number;
}) {
  const context = await reportContext(input.profileId);
  if (!context) {
    return {
      available: false as const,
      reason: "لا يوجد إصدار نظامي معتمد.",
      rows: [],
    };
  }
  const raw = rowsOf<{
    accountId: number;
    code: string;
    name: string;
    type: string;
    normalBalance: "DEBIT" | "CREDIT";
    debit: string;
    credit: string;
  }>(
    await context.db.execute(sql`
      SELECT
        sa.id AS accountId,
        sa.code,
        sa.name,
        sa.type,
        sa.normalBalance,
        CAST(COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END), 0) AS CHAR) AS debit,
        CAST(COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END), 0) AS CHAR) AS credit
      FROM statutoryAccounts sa
      LEFT JOIN journalLines jl ON jl.statutoryAccountId = sa.id
      LEFT JOIN journalEntries je
        ON je.id = jl.journalId
       AND je.status = 'POSTED'
       AND je.entryDate >= ${input.from}
       AND je.entryDate <= ${input.to}
      WHERE sa.profileId = ${Number(context.profile.id)}
      GROUP BY sa.id, sa.code, sa.name, sa.type, sa.normalBalance, sa.sortOrder
      HAVING debit <> 0 OR credit <> 0
      ORDER BY sa.sortOrder, sa.code
    `),
  );
  let totalDebit = money(0);
  let totalCredit = money(0);
  const rows = raw.map((row) => {
    const debit = money(row.debit ?? 0);
    const credit = money(row.credit ?? 0);
    totalDebit = totalDebit.add(debit);
    totalCredit = totalCredit.add(credit);
    const signed = debit.sub(credit);
    return {
      accountId: Number(row.accountId),
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normalBalance,
      debit: toDbMoney(debit),
      credit: toDbMoney(credit),
      debitBalance: toDbMoney(signed.isPositive() ? signed : money(0)),
      creditBalance: toDbMoney(signed.isNegative() ? signed.abs() : money(0)),
    };
  });
  return {
    available: true as const,
    accountingBasis: context.mode === "ACTIVE" ? "STATUTORY_ACTIVE" : "STATUTORY_PREVIEW",
    mode: context.mode,
    profile: {
      id: Number(context.profile.id),
      key: context.profile.profileKey,
      version: context.profile.version,
      name: context.profile.name,
      contentHash: context.profile.contentHash,
    },
    period: { from: input.from, to: input.to },
    totals: {
      debit: toDbMoney(totalDebit),
      credit: toDbMoney(totalCredit),
      difference: toDbMoney(totalDebit.sub(totalCredit)),
    },
    rows,
  };
}

export async function getStatutoryGeneralJournal(input: {
  from: string;
  to: string;
  profileId?: number;
  limit?: number;
  offset?: number;
}) {
  const context = await reportContext(input.profileId);
  if (!context) {
    return { available: false as const, reason: "لا يوجد إصدار نظامي معتمد.", rows: [] };
  }
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const rows = rowsOf<{
    journalId: number;
    entryDate: string;
    sourceType: string;
    sourceId: number | null;
    sourceKey: string | null;
    branchId: number | null;
    internalCode: string;
    role: string;
    statutoryCode: string;
    statutoryName: string;
    debit: string;
    credit: string;
  }>(
    await context.db.execute(sql`
      SELECT
        je.id AS journalId,
        CAST(je.entryDate AS CHAR) AS entryDate,
        je.sourceType,
        je.entryId AS sourceId,
        je.sourceKey,
        je.branchId,
        a.code AS internalCode,
        jl.role,
        sa.code AS statutoryCode,
        sa.name AS statutoryName,
        CAST(jl.debit AS CHAR) AS debit,
        CAST(jl.credit AS CHAR) AS credit
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId AND je.status = 'POSTED'
      INNER JOIN accounts a ON a.id = jl.accountId
      INNER JOIN statutoryAccounts sa ON sa.id = jl.statutoryAccountId
      WHERE jl.statutoryProfileId = ${Number(context.profile.id)}
        AND je.entryDate >= ${input.from}
        AND je.entryDate <= ${input.to}
      ORDER BY je.entryDate, je.id, jl.id
      LIMIT ${limit} OFFSET ${offset}
    `),
  );
  return {
    available: true as const,
    mode: context.mode,
    profileId: Number(context.profile.id),
    period: { from: input.from, to: input.to },
    pagination: { limit, offset, hasMore: rows.length === limit },
    rows: rows.map((row) => ({
      ...row,
      journalId: Number(row.journalId),
      sourceId: row.sourceId == null ? null : Number(row.sourceId),
      branchId: row.branchId == null ? null : Number(row.branchId),
      debit: toDbMoney(money(row.debit ?? 0)),
      credit: toDbMoney(money(row.credit ?? 0)),
    })),
  };
}
