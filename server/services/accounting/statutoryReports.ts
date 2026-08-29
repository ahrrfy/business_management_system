import { TRPCError } from "@trpc/server";
import { eq, ne, sql } from "drizzle-orm";
import {
  doubleEntrySettings,
  statutoryAccountingProfiles,
} from "../../../drizzle/schema";
import { getDb, type DB, type Tx } from "../../db";
import { money, toDbMoney } from "../money";
import { getVerifiedStatutoryProfileDetails } from "./statutoryAccounting";

type DbExecutor = DB | Tx;

function requireDb(): NonNullable<ReturnType<typeof getDb>> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL غير مضبوط");
  return db;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[];
  return result as T[];
}

type ProfileScope = "ACTIVE" | "ALL_APPROVED";

function snapshotProfilePredicate(
  profileId: number | undefined,
  profileScope: ProfileScope | undefined,
  referenceProfileId: number,
) {
  if (profileId) return sql`AND jl.statutoryProfileId = ${profileId}`;
  return profileScope === "ALL_APPROVED"
    ? sql`AND sp.status <> 'DRAFT'`
    : sql`AND jl.statutoryProfileId = ${referenceProfileId}`;
}

function branchPredicate(branchId?: number | null) {
  // في النطاق الفرعي نفشل مغلقاً للأسطر القديمة ذات branchId=NULL؛ بعد السطر أدق من الرأس.
  return branchId == null ? sql`` : sql`AND jl.branchId = ${branchId}`;
}

function cyclePredicate(cycleId: string) {
  return sql`AND je.cycleId = ${cycleId}`;
}

async function reportContext(
  profileId?: number,
  profileScope?: ProfileScope,
  db: DbExecutor = requireDb(),
) {
  const activeProfile = (
    await db
      .select()
      .from(statutoryAccountingProfiles)
      .where(eq(statutoryAccountingProfiles.status, "ACTIVE"))
      .limit(1)
  )[0];
  const profile = profileId
    ? (
        await db
          .select()
          .from(statutoryAccountingProfiles)
          .where(eq(statutoryAccountingProfiles.id, profileId))
          .limit(1)
      )[0]
    : activeProfile;
  if (!profile || profile.status === "DRAFT") {
    return { available: false as const, reason: "لا يوجد إصدار نظامي معتمد." };
  }
  const includedProfileIds = profileId || profileScope !== "ALL_APPROVED"
    ? [Number(profile.id)]
    : (
        await db
          .select({ id: statutoryAccountingProfiles.id })
          .from(statutoryAccountingProfiles)
          .where(ne(statutoryAccountingProfiles.status, "DRAFT"))
      ).map((row) => Number(row.id));
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
  if (!runtime?.cycleId) {
    return {
      available: false as const,
      reason: "لا توجد دورة دفتر مزدوج حالية؛ ابدأ دورة SHADOW محكومة قبل قراءة التقارير النظامية.",
    };
  }
  return {
    available: true as const,
    db,
    profile,
    activeProfileId: activeProfile ? Number(activeProfile.id) : null,
    includedProfileIds,
    mode: runtime?.mode ?? "OFF",
    cycleId: runtime.cycleId,
  };
}

export async function getStatutoryTrialBalance(input: {
  from: string;
  to: string;
  profileId?: number;
  profileScope?: ProfileScope;
  branchId?: number | null;
}, executor?: DbExecutor) {
  const context = await reportContext(input.profileId, input.profileScope, executor);
  if (!context.available) {
    return {
      available: false as const,
      reason: context.reason,
      rows: [],
    };
  }
  const raw = rowsOf<{
    accountId: number;
    profileId: number;
    profileVersion: number;
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
        sp.id AS profileId,
        sp.version AS profileVersion,
        sa.code,
        sa.name,
        sa.type,
        sa.normalBalance,
        CAST(COALESCE(SUM(jl.debit), 0) AS CHAR) AS debit,
        CAST(COALESCE(SUM(jl.credit), 0) AS CHAR) AS credit
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId AND je.status = 'POSTED'
      INNER JOIN statutoryAccounts sa ON sa.id = jl.statutoryAccountId
      INNER JOIN statutoryAccountingProfiles sp ON sp.id = jl.statutoryProfileId
      WHERE je.entryDate >= ${input.from}
        AND je.entryDate <= ${input.to}
        ${snapshotProfilePredicate(input.profileId, input.profileScope, Number(context.profile.id))}
        ${cyclePredicate(context.cycleId)}
        ${branchPredicate(input.branchId)}
      GROUP BY sp.id, sp.version, sp.effectiveFrom, sa.id, sa.code, sa.name, sa.type, sa.normalBalance, sa.sortOrder
      HAVING debit <> 0 OR credit <> 0
      ORDER BY sp.effectiveFrom, sp.version, sa.sortOrder, sa.code
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
      profileId: Number(row.profileId),
      profileVersion: Number(row.profileVersion),
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
    scope: {
      profileScope: input.profileId ? "PROFILE" as const : input.profileScope ?? "ACTIVE",
      activeProfileId: context.activeProfileId,
      referenceProfileId: Number(context.profile.id),
      includedProfileIds: context.includedProfileIds,
      branchId: input.branchId ?? null,
    },
    totals: {
      debit: toDbMoney(totalDebit),
      credit: toDbMoney(totalCredit),
      difference: toDbMoney(totalDebit.sub(totalCredit)),
    },
    rows,
  };
}

type StatementRawRow = {
  accountId: number;
  profileId: number;
  profileVersion: number;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  debit: string;
  credit: string;
};

function statementRow(row: StatementRawRow, presentation: "DEBIT" | "CREDIT") {
  const debit = money(row.debit ?? 0);
  const credit = money(row.credit ?? 0);
  const amount = presentation === "DEBIT" ? debit.sub(credit) : credit.sub(debit);
  return {
    accountId: Number(row.accountId),
    profileId: Number(row.profileId),
    profileVersion: Number(row.profileVersion),
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normalBalance,
    debit: toDbMoney(debit),
    credit: toDbMoney(credit),
    amount: toDbMoney(amount),
  };
}

/** قائمة الدخل من تصنيف السطر المثبّت وقت القيد، لا من الدليل التشغيلي الحالي. */
export async function getStatutoryIncomeStatement(input: {
  from: string;
  to: string;
  profileId?: number;
  profileScope?: ProfileScope;
  branchId?: number | null;
}, executor?: DbExecutor) {
  const context = await reportContext(input.profileId, input.profileScope, executor);
  if (!context.available) {
    return { available: false as const, reason: context.reason, rows: [] };
  }
  const raw = rowsOf<StatementRawRow>(
    await context.db.execute(sql`
      SELECT
        sa.id AS accountId,
        sp.id AS profileId,
        sp.version AS profileVersion,
        sa.code,
        sa.name,
        sa.type,
        sa.normalBalance,
        CAST(COALESCE(SUM(jl.debit), 0) AS CHAR) AS debit,
        CAST(COALESCE(SUM(jl.credit), 0) AS CHAR) AS credit
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId AND je.status = 'POSTED'
      INNER JOIN statutoryAccounts sa ON sa.id = jl.statutoryAccountId
      INNER JOIN statutoryAccountingProfiles sp ON sp.id = jl.statutoryProfileId
      WHERE sa.type IN ('REVENUE', 'EXPENSE')
        AND je.entryDate >= ${input.from}
        AND je.entryDate <= ${input.to}
        ${snapshotProfilePredicate(input.profileId, input.profileScope, Number(context.profile.id))}
        ${cyclePredicate(context.cycleId)}
        ${branchPredicate(input.branchId)}
      GROUP BY sp.id, sp.version, sp.effectiveFrom, sa.id, sa.code, sa.name, sa.type, sa.normalBalance, sa.sortOrder
      HAVING debit <> 0 OR credit <> 0
      ORDER BY sp.effectiveFrom, sp.version, sa.type DESC, sa.sortOrder, sa.code
    `),
  );
  const revenues = raw
    .filter((row) => row.type === "REVENUE")
    .map((row) => statementRow(row, "CREDIT"));
  const expenses = raw
    .filter((row) => row.type === "EXPENSE")
    .map((row) => statementRow(row, "DEBIT"));
  const totalRevenue = revenues.reduce((sum, row) => sum.add(row.amount), money(0));
  const totalExpenses = expenses.reduce((sum, row) => sum.add(row.amount), money(0));
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
    scope: {
      profileScope: input.profileId ? "PROFILE" as const : input.profileScope ?? "ACTIVE",
      activeProfileId: context.activeProfileId,
      referenceProfileId: Number(context.profile.id),
      includedProfileIds: context.includedProfileIds,
      branchId: input.branchId ?? null,
    },
    totals: {
      revenue: toDbMoney(totalRevenue),
      expenses: toDbMoney(totalExpenses),
      netIncome: toDbMoney(totalRevenue.sub(totalExpenses)),
    },
    revenues,
    expenses,
    rows: [...revenues, ...expenses],
  };
}

/**
 * المركز المالي حتى تاريخ محدّد. تبقى نتيجة النشاط غير المقفلة بنداً مستقلاً كي تتزن
 * المعادلة حتى قبل قيد الإقفال السنوي، ولا تُخفى داخل حقوق الملكية بصمت.
 */
export async function getStatutoryBalanceSheet(input: {
  asOf: string;
  profileId?: number;
  profileScope?: ProfileScope;
  branchId?: number | null;
}, executor?: DbExecutor) {
  const context = await reportContext(input.profileId, input.profileScope, executor);
  if (!context.available) {
    return { available: false as const, reason: context.reason, rows: [] };
  }
  const raw = rowsOf<StatementRawRow>(
    await context.db.execute(sql`
      SELECT
        sa.id AS accountId,
        sp.id AS profileId,
        sp.version AS profileVersion,
        sa.code,
        sa.name,
        sa.type,
        sa.normalBalance,
        CAST(COALESCE(SUM(jl.debit), 0) AS CHAR) AS debit,
        CAST(COALESCE(SUM(jl.credit), 0) AS CHAR) AS credit
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId AND je.status = 'POSTED'
      INNER JOIN statutoryAccounts sa ON sa.id = jl.statutoryAccountId
      INNER JOIN statutoryAccountingProfiles sp ON sp.id = jl.statutoryProfileId
      WHERE je.entryDate <= ${input.asOf}
        ${snapshotProfilePredicate(input.profileId, input.profileScope, Number(context.profile.id))}
        ${cyclePredicate(context.cycleId)}
        ${branchPredicate(input.branchId)}
      GROUP BY sp.id, sp.version, sp.effectiveFrom, sa.id, sa.code, sa.name, sa.type, sa.normalBalance, sa.sortOrder
      HAVING debit <> 0 OR credit <> 0
      ORDER BY sp.effectiveFrom, sp.version, sa.type, sa.sortOrder, sa.code
    `),
  );
  const assets = raw
    .filter((row) => row.type === "ASSET")
    .map((row) => statementRow(row, "DEBIT"));
  const liabilities = raw
    .filter((row) => row.type === "LIABILITY")
    .map((row) => statementRow(row, "CREDIT"));
  const equity = raw
    .filter((row) => row.type === "EQUITY")
    .map((row) => statementRow(row, "CREDIT"));
  const totalAssets = assets.reduce((sum, row) => sum.add(row.amount), money(0));
  const totalLiabilities = liabilities.reduce((sum, row) => sum.add(row.amount), money(0));
  const totalEquity = equity.reduce((sum, row) => sum.add(row.amount), money(0));
  const unclosedResult = raw.reduce((sum, row) => {
    if (row.type === "REVENUE") return sum.add(money(row.credit).sub(row.debit));
    if (row.type === "EXPENSE") return sum.sub(money(row.debit).sub(row.credit));
    return sum;
  }, money(0));
  const liabilitiesAndEquity = totalLiabilities.add(totalEquity).add(unclosedResult);
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
    asOf: input.asOf,
    scope: {
      profileScope: input.profileId ? "PROFILE" as const : input.profileScope ?? "ACTIVE",
      activeProfileId: context.activeProfileId,
      referenceProfileId: Number(context.profile.id),
      includedProfileIds: context.includedProfileIds,
      branchId: input.branchId ?? null,
    },
    totals: {
      assets: toDbMoney(totalAssets),
      liabilities: toDbMoney(totalLiabilities),
      equity: toDbMoney(totalEquity),
      unclosedResult: toDbMoney(unclosedResult),
      liabilitiesAndEquity: toDbMoney(liabilitiesAndEquity),
      difference: toDbMoney(totalAssets.sub(liabilitiesAndEquity)),
    },
    assets,
    liabilities,
    equity,
    rows: [...assets, ...liabilities, ...equity],
  };
}

type StatutoryAccountLedgerInput = {
  from: string;
  to: string;
  accountId: number;
  profileId?: number;
  branchId?: number | null;
  limit?: number;
  offset?: number;
};

/** كشف حركة حساب نظامي مع رصيد افتتاحي ورصيد جارٍ صحيح عبر الصفحات. */
async function queryStatutoryAccountLedger(
  input: StatutoryAccountLedgerInput,
  hardLimit: number,
  executor: DbExecutor,
) {
  const context = await reportContext(input.profileId, undefined, executor);
  if (!context.available) {
    return { available: false as const, reason: context.reason, rows: [] };
  }
  const account = rowsOf<{
    id: number;
    code: string;
    name: string;
    type: string;
    normalBalance: "DEBIT" | "CREDIT";
  }>(
    await context.db.execute(sql`
      SELECT id, code, name, type, normalBalance
      FROM statutoryAccounts
      WHERE id = ${input.accountId} AND profileId = ${Number(context.profile.id)} AND isPosting = 1
      LIMIT 1
    `),
  )[0];
  if (!account) {
    return { available: false as const, reason: "الحساب النظامي غير موجود في الإصدار المحدد.", rows: [] };
  }
  const limit = Math.min(Math.max(input.limit ?? 100, 1), hardLimit);
  const offset = Math.max(input.offset ?? 0, 0);
  const openingRaw = rowsOf<{ debit: string; credit: string }>(
    await context.db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(jl.debit), 0) AS CHAR) AS debit,
        CAST(COALESCE(SUM(jl.credit), 0) AS CHAR) AS credit
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId AND je.status = 'POSTED'
      WHERE jl.statutoryProfileId = ${Number(context.profile.id)}
        AND jl.statutoryAccountId = ${input.accountId}
        AND je.entryDate < ${input.from}
        ${cyclePredicate(context.cycleId)}
        ${branchPredicate(input.branchId)}
    `),
  )[0] ?? { debit: "0", credit: "0" };
  const openingSigned = money(openingRaw.debit ?? 0).sub(openingRaw.credit ?? 0);
  const raw = rowsOf<{
    journalId: number;
    lineId: number;
    entryDate: string;
    sourceType: string;
    sourceId: number | null;
    sourceKey: string | null;
    branchId: number | null;
    internalCode: string;
    role: string;
    debit: string;
    credit: string;
    periodSigned: string;
  }>(
    await context.db.execute(sql`
      SELECT
        je.id AS journalId,
        jl.id AS lineId,
        CAST(je.entryDate AS CHAR) AS entryDate,
        je.sourceType,
        je.entryId AS sourceId,
        je.sourceKey,
        jl.branchId,
        a.code AS internalCode,
        jl.role,
        CAST(jl.debit AS CHAR) AS debit,
        CAST(jl.credit AS CHAR) AS credit,
        CAST(SUM(jl.debit - jl.credit) OVER (ORDER BY je.entryDate, je.id, jl.id) AS CHAR) AS periodSigned
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId AND je.status = 'POSTED'
      INNER JOIN accounts a ON a.id = jl.accountId
      WHERE jl.statutoryProfileId = ${Number(context.profile.id)}
        AND jl.statutoryAccountId = ${input.accountId}
        AND je.entryDate >= ${input.from}
        AND je.entryDate <= ${input.to}
        ${cyclePredicate(context.cycleId)}
        ${branchPredicate(input.branchId)}
      ORDER BY je.entryDate, je.id, jl.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `),
  );
  const hasMore = raw.length > limit;
  const rows = raw.slice(0, limit).map((row) => {
    const signed = openingSigned.add(row.periodSigned ?? 0);
    return {
      ...row,
      journalId: Number(row.journalId),
      lineId: Number(row.lineId),
      sourceId: row.sourceId == null ? null : Number(row.sourceId),
      branchId: row.branchId == null ? null : Number(row.branchId),
      debit: toDbMoney(money(row.debit ?? 0)),
      credit: toDbMoney(money(row.credit ?? 0)),
      debitBalance: toDbMoney(signed.isPositive() ? signed : money(0)),
      creditBalance: toDbMoney(signed.isNegative() ? signed.abs() : money(0)),
    };
  });
  return {
    available: true as const,
    mode: context.mode,
    profileId: Number(context.profile.id),
    account: { ...account, id: Number(account.id) },
    period: { from: input.from, to: input.to },
    scope: {
      profileScope: "PROFILE" as const,
      activeProfileId: context.activeProfileId,
      referenceProfileId: Number(context.profile.id),
      includedProfileIds: context.includedProfileIds,
      branchId: input.branchId ?? null,
    },
    opening: {
      debitBalance: toDbMoney(openingSigned.isPositive() ? openingSigned : money(0)),
      creditBalance: toDbMoney(openingSigned.isNegative() ? openingSigned.abs() : money(0)),
    },
    pagination: { limit, offset, hasMore },
    rows,
  };
}

export function getStatutoryAccountLedger(input: StatutoryAccountLedgerInput) {
  const database = requireDb();
  return database.transaction(
    (tx) => queryStatutoryAccountLedger(input, 500, tx),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function getStatutoryAccountLedgerExport(
  input: Omit<StatutoryAccountLedgerInput, "limit" | "offset">,
) {
  const database = requireDb();
  return database.transaction(
    (tx) => queryStatutoryAccountLedger({ ...input, limit: 10_000, offset: 0 }, 10_000, tx),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

type StatutoryGeneralJournalInput = {
  from: string;
  to: string;
  profileId?: number;
  profileScope?: ProfileScope;
  branchId?: number | null;
  limit?: number;
  offset?: number;
};

async function queryStatutoryGeneralJournal(
  input: StatutoryGeneralJournalInput,
  hardLimit: number,
  executor: DbExecutor,
) {
  const context = await reportContext(input.profileId, input.profileScope, executor);
  if (!context.available) {
    return { available: false as const, reason: context.reason, rows: [] };
  }
  const limit = Math.min(Math.max(input.limit ?? 100, 1), hardLimit);
  const offset = Math.max(input.offset ?? 0, 0);
  const raw = rowsOf<{
    journalId: number;
    profileId: number;
    profileVersion: number;
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
        sp.id AS profileId,
        sp.version AS profileVersion,
        CAST(je.entryDate AS CHAR) AS entryDate,
        je.sourceType,
        je.entryId AS sourceId,
        je.sourceKey,
        jl.branchId,
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
      INNER JOIN statutoryAccountingProfiles sp ON sp.id = jl.statutoryProfileId
      WHERE je.entryDate >= ${input.from}
        AND je.entryDate <= ${input.to}
        ${snapshotProfilePredicate(input.profileId, input.profileScope, Number(context.profile.id))}
        ${cyclePredicate(context.cycleId)}
        ${branchPredicate(input.branchId)}
      ORDER BY je.entryDate, je.id, jl.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `),
  );
  const hasMore = raw.length > limit;
  const rows = raw.slice(0, limit).map((row) => ({
    ...row,
    journalId: Number(row.journalId),
    profileId: Number(row.profileId),
    profileVersion: Number(row.profileVersion),
    sourceId: row.sourceId == null ? null : Number(row.sourceId),
    branchId: row.branchId == null ? null : Number(row.branchId),
    debit: toDbMoney(money(row.debit ?? 0)),
    credit: toDbMoney(money(row.credit ?? 0)),
  }));
  return {
    available: true as const,
    mode: context.mode,
    profileId: Number(context.profile.id),
    period: { from: input.from, to: input.to },
    scope: {
      profileScope: input.profileId ? "PROFILE" as const : input.profileScope ?? "ACTIVE",
      activeProfileId: context.activeProfileId,
      referenceProfileId: Number(context.profile.id),
      includedProfileIds: context.includedProfileIds,
      pageProfileIds: Array.from(new Set(rows.map((row) => row.profileId))),
      branchId: input.branchId ?? null,
    },
    pagination: { limit, offset, hasMore },
    rows,
  };
}

export function getStatutoryGeneralJournal(input: StatutoryGeneralJournalInput) {
  return queryStatutoryGeneralJournal(input, 500, requireDb());
}

export function getStatutoryGeneralJournalExport(
  input: Omit<StatutoryGeneralJournalInput, "limit" | "offset">,
) {
  return queryStatutoryGeneralJournal(
    { ...input, limit: 10_000, offset: 0 },
    10_000,
    requireDb(),
  );
}

export function requireCompleteAccountantPackJournal<
  T extends { pagination: { hasMore: boolean } },
>(generalJournal: T): T {
  if (generalJournal.pagination.hasMore) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: "اليومية النظامية تتجاوز 10,000 سطر؛ قسّم الفترة ثم أعد التصدير.",
    });
  }
  return generalJournal;
}

/** حزمة رسمية واحدة من لقطة REPEATABLE READ؛ لا تُتاح في OFF/SHADOW. */
export async function getStatutoryAccountantPack(input: {
  from: string;
  to: string;
  branchId?: number | null;
}, snapshotHooks?: {
  /** Test-only concurrency probe; production callers omit it. */
  afterTrialBalance?: () => Promise<void>;
}) {
  const database = requireDb();
  return database.transaction(
    async (tx) => {
      const context = await reportContext(undefined, "ALL_APPROVED", tx);
      if (!context.available) return { ...context, rows: [] };
      if (context.mode !== "ACTIVE") {
        return {
          available: false as const,
          reason: "الحزمة الرسمية متاحة فقط عندما يكون الدفتر المزدوج في وضع ACTIVE؛ التقارير الحالية للمعاينة.",
          rows: [],
        };
      }
      const profileDetails = await getVerifiedStatutoryProfileDetails(
        tx,
        context.includedProfileIds,
      );
      const periodInput = {
        from: input.from,
        to: input.to,
        profileScope: "ALL_APPROVED" as const,
        branchId: input.branchId,
      };
      const trialBalance = await getStatutoryTrialBalance(periodInput, tx);
      await snapshotHooks?.afterTrialBalance?.();
      const incomeStatement = await getStatutoryIncomeStatement(periodInput, tx);
      const balanceSheet = await getStatutoryBalanceSheet(
        { asOf: input.to, profileScope: "ALL_APPROVED", branchId: input.branchId },
        tx,
      );
      const generalJournal = await queryStatutoryGeneralJournal(
        { ...periodInput, limit: 10_000, offset: 0 },
        10_000,
        tx,
      );
      if (
        !trialBalance.available ||
        !incomeStatement.available ||
        !balanceSheet.available ||
        !generalJournal.available
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "تغيّرت جاهزية التقارير أثناء إعداد الحزمة؛ أعد المحاولة.",
        });
      }
      requireCompleteAccountantPackJournal(generalJournal);
      return {
        available: true as const,
        generatedAt: new Date().toISOString(),
        cycleId: context.cycleId,
        profileDetails,
        trialBalance,
        incomeStatement,
        balanceSheet,
        generalJournal: {
          ...generalJournal,
          export: { complete: true as const, rowLimit: 10_000 },
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
