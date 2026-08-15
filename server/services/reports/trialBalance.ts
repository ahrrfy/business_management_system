/**
 * ميزان المراجعة الرسمي من الدفتر المزدوج (P2/ش٣).
 *
 * المصدر الوحيد هنا هو journalEntries/journalLines. لا نشتقّ حقوق الملكية كي «نُوازن» التقرير؛
 * الفرق إن وُجد يبقى ظاهراً، وأي role بلا حسابٍ في شجرة الحسابات يظهر كسطر خلل صريح كي لا يضيع
 * دينارٌ بصمت. القيم تُجمّع في MySQL كـDECIMAL ثم تُعالج بـdecimal.js فقط.
 */
import { asc, isNotNull, sql } from "drizzle-orm";
import {
  accounts,
  doubleEntrySettings,
  journalEntries,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import type { AccountType } from "../accountsService";
import type { DoubleEntryMode } from "../accounting/journalStore";

type RawAggregate = {
  role: string;
  openingDebit: string | null;
  openingCredit: string | null;
  periodDebit: string | null;
  periodCredit: string | null;
};

export interface TrialBalanceRow {
  accountId: number | null;
  code: string;
  name: string;
  type: AccountType | null;
  systemRole: string;
  isUnmappedAccount: boolean;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceTotals {
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  openingDifference: string;
  periodDifference: string;
  closingDifference: string;
  isBalanced: boolean;
}

export interface TrialBalanceResult {
  mode: DoubleEntryMode;
  shadowStartedAt: string | null;
  from: string;
  to: string;
  branchId: number | null;
  openingUnmappedCount: number;
  periodUnmappedCount: number;
  unmappedCount: number;
  unmappedAccountRoles: string[];
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
}

function rowsOf<T>(result: unknown): T[] {
  const data = (result as any)?.[0] ?? result;
  return Array.isArray(data) ? (data as T[]) : [];
}

function timestampText(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 19).replace("T", " ");
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function splitBalance(signed: ReturnType<typeof money>): {
  debit: string;
  credit: string;
} {
  if (signed.isNegative()) {
    return { debit: "0.00", credit: toDbMoney(signed.abs()) };
  }
  return { debit: toDbMoney(signed), credit: "0.00" };
}

function emptyTotals(): TrialBalanceTotals {
  return {
    openingDebit: "0.00",
    openingCredit: "0.00",
    periodDebit: "0.00",
    periodCredit: "0.00",
    closingDebit: "0.00",
    closingCredit: "0.00",
    openingDifference: "0.00",
    periodDifference: "0.00",
    closingDifference: "0.00",
    isBalanced: true,
  };
}

export async function getTrialBalance(input: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<TrialBalanceResult> {
  const db = getDb();
  if (!db) {
    return {
      mode: "OFF",
      shadowStartedAt: null,
      from: input.from,
      to: input.to,
      branchId: input.branchId ?? null,
      openingUnmappedCount: 0,
      periodUnmappedCount: 0,
      unmappedCount: 0,
      unmappedAccountRoles: [],
      rows: [],
      totals: emptyTotals(),
    };
  }

  const [setting] = await db
    .select({
      mode: doubleEntrySettings.mode,
      shadowStartedAt: doubleEntrySettings.shadowStartedAt,
    })
    .from(doubleEntrySettings)
    .limit(1);
  const mode = (setting?.mode as DoubleEntryMode | undefined) ?? "OFF";

  const postingAccounts = await db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      systemRole: accounts.systemRole,
      sortOrder: accounts.sortOrder,
    })
    .from(accounts)
    .where(isNotNull(accounts.systemRole))
    .orderBy(asc(accounts.sortOrder), asc(accounts.code));

  const branchClause =
    input.branchId == null ? sql`` : sql` AND je.branchId = ${input.branchId}`;
  const aggregates = rowsOf<RawAggregate>(
    await db.execute(sql`
      SELECT
        jl.role AS role,
        CAST(COALESCE(SUM(CASE WHEN je.entryDate < ${input.from} THEN jl.debit ELSE 0 END), 0) AS CHAR) AS openingDebit,
        CAST(COALESCE(SUM(CASE WHEN je.entryDate < ${input.from} THEN jl.credit ELSE 0 END), 0) AS CHAR) AS openingCredit,
        CAST(COALESCE(SUM(CASE WHEN je.entryDate >= ${input.from} THEN jl.debit ELSE 0 END), 0) AS CHAR) AS periodDebit,
        CAST(COALESCE(SUM(CASE WHEN je.entryDate >= ${input.from} THEN jl.credit ELSE 0 END), 0) AS CHAR) AS periodCredit
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId
      WHERE je.status = 'POSTED'
        AND je.entryDate <= ${input.to}
        ${branchClause}
      GROUP BY jl.role
    `),
  );
  const byRole = new Map(aggregates.map((row) => [String(row.role), row]));

  const buildRow = (account: {
    id: number | null;
    code: string;
    name: string;
    type: AccountType | null;
    systemRole: string;
    isUnmappedAccount: boolean;
  }): TrialBalanceRow => {
    const aggregate = byRole.get(account.systemRole);
    const openingDebitRaw = money(aggregate?.openingDebit);
    const openingCreditRaw = money(aggregate?.openingCredit);
    const periodDebit = money(aggregate?.periodDebit);
    const periodCredit = money(aggregate?.periodCredit);
    const opening = splitBalance(openingDebitRaw.sub(openingCreditRaw));
    const closing = splitBalance(
      openingDebitRaw.sub(openingCreditRaw).add(periodDebit).sub(periodCredit),
    );
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      systemRole: account.systemRole,
      isUnmappedAccount: account.isUnmappedAccount,
      openingDebit: opening.debit,
      openingCredit: opening.credit,
      periodDebit: toDbMoney(periodDebit),
      periodCredit: toDbMoney(periodCredit),
      closingDebit: closing.debit,
      closingCredit: closing.credit,
    };
  };

  const knownRoles = new Set<string>();
  const rows: TrialBalanceRow[] = postingAccounts.map((account) => {
    const role = String(account.systemRole);
    knownRoles.add(role);
    return buildRow({
      id: Number(account.id),
      code: account.code,
      name: account.name,
      type: account.type as AccountType,
      systemRole: role,
      isUnmappedAccount: false,
    });
  });

  const unmappedAccountRoles = aggregates
    .map((row) => String(row.role))
    .filter((role) => !knownRoles.has(role))
    .sort();
  for (const role of unmappedAccountRoles) {
    rows.push(
      buildRow({
        id: null,
        code: "—",
        name: `دور محاسبي غير مربوط: ${role}`,
        type: null,
        systemRole: role,
        isUnmappedAccount: true,
      }),
    );
  }

  const sum = (
    key: keyof Pick<
      TrialBalanceRow,
      | "openingDebit"
      | "openingCredit"
      | "periodDebit"
      | "periodCredit"
      | "closingDebit"
      | "closingCredit"
    >,
  ) => rows.reduce((total, row) => total.add(money(row[key])), money(0));

  const openingDebit = sum("openingDebit");
  const openingCredit = sum("openingCredit");
  const periodDebit = sum("periodDebit");
  const periodCredit = sum("periodCredit");
  const closingDebit = sum("closingDebit");
  const closingCredit = sum("closingCredit");
  const openingDifference = openingDebit.sub(openingCredit);
  const periodDifference = periodDebit.sub(periodCredit);
  const closingDifference = closingDebit.sub(closingCredit);

  const gapBranchClause =
    input.branchId == null
      ? sql``
      : sql` AND ${journalEntries.branchId} = ${input.branchId}`;
  const [gapRow] = rowsOf<{
    openingCount: number | string;
    periodCount: number | string;
  }>(
    await db.execute(sql`
      SELECT
        SUM(CASE WHEN ${journalEntries.entryDate} < ${input.from} THEN 1 ELSE 0 END) AS openingCount,
        SUM(CASE WHEN ${journalEntries.entryDate} >= ${input.from} THEN 1 ELSE 0 END) AS periodCount
      FROM ${journalEntries}
      WHERE ${journalEntries.status} = 'UNMAPPED'
        AND ${journalEntries.entryDate} <= ${input.to}
        ${gapBranchClause}
    `),
  );
  const openingUnmappedCount = Number(gapRow?.openingCount ?? 0);
  const periodUnmappedCount = Number(gapRow?.periodCount ?? 0);

  return {
    mode,
    shadowStartedAt: timestampText(setting?.shadowStartedAt),
    from: input.from,
    to: input.to,
    branchId: input.branchId ?? null,
    openingUnmappedCount,
    periodUnmappedCount,
    unmappedCount: openingUnmappedCount + periodUnmappedCount,
    unmappedAccountRoles,
    rows,
    totals: {
      openingDebit: toDbMoney(openingDebit),
      openingCredit: toDbMoney(openingCredit),
      periodDebit: toDbMoney(periodDebit),
      periodCredit: toDbMoney(periodCredit),
      closingDebit: toDbMoney(closingDebit),
      closingCredit: toDbMoney(closingCredit),
      openingDifference: toDbMoney(openingDifference),
      periodDifference: toDbMoney(periodDifference),
      closingDifference: toDbMoney(closingDifference),
      isBalanced:
        openingDifference.isZero() &&
        periodDifference.isZero() &&
        closingDifference.isZero(),
    },
  };
}
