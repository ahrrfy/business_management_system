import { and, eq, sql } from "drizzle-orm";
import type { DB, Tx } from "../../db";
import { getDb } from "../../db";
import {
  branches,
  journalEntries,
  journalLines,
} from "../../../drizzle/schema";
import { money, round2 } from "../money";
import {
  BRANCH_OPERATIONAL_ROLES,
  CONFIRMED_OPERATIONAL_ROLES,
  readOperationalBalanceSnapshot,
  resolveShadowCycleId,
  SHADOW_OPENING_ALLOCATION_ROLES,
  type ConfirmedOperationalRole,
  type ShadowOpeningBlocker,
} from "./shadowOpening";

const ALLOCATION_ROLE_SET = new Set<string>(SHADOW_OPENING_ALLOCATION_ROLES);
const RECONCILABLE_OPERATIONAL_ROLES = CONFIRMED_OPERATIONAL_ROLES.filter(
  (role) => !ALLOCATION_ROLE_SET.has(role),
);

export interface DoubleEntryOperationalReconcileRow {
  scope: "GLOBAL" | "BRANCH";
  branchId: number | null;
  role: ConfirmedOperationalRole;
  operationalNetDebit: string;
  journalNetDebit: string;
  /** journal − operational; zero means exact agreement. */
  difference: string;
  matches: boolean;
}

export interface DoubleEntryOperationalReconciliation {
  cycleId: string;
  asOf: string;
  snapshotDate: string;
  ok: boolean;
  rows: DoubleEntryOperationalReconcileRow[];
  globalRows: DoubleEntryOperationalReconcileRow[];
  branchRows: DoubleEntryOperationalReconcileRow[];
  driftCount: number;
  totalAbsoluteDifference: string;
  journalIntegrity: {
    debit: string;
    credit: string;
    difference: string;
    isBalanced: boolean;
  };
  blockers: ShadowOpeningBlocker[];
}

function requireDb(db?: DB | Tx): DB | Tx {
  const resolved = db ?? getDb();
  if (!resolved) throw new Error("DATABASE_URL not set");
  return resolved;
}

function key(role: string, branchId: number | null): string {
  return `${role}\u0000${branchId == null ? "GLOBAL" : String(branchId)}`;
}

/**
 * Compares the authoritative operational balance sheet to POSTED journal lines
 * through `asOf`, using Decimal arithmetic end-to-end.  SHADOW_OPENING heads are
 * intentionally included: their asset/liability lines establish the cut-over
 * balance. Manual opening-allocation roles are intentionally excluded from
 * operational drift: their approved opening certificate is their governing
 * source, and mixing (for example) manually allocated CAPITAL with immutable
 * treasury funding would report a false operational mismatch.
 */
export async function reconcileDoubleEntryOperational(
  input: {
    asOf?: string;
    cycleId?: string;
    db?: DB | Tx;
  } = {},
): Promise<DoubleEntryOperationalReconciliation> {
  const dbHandle = requireDb(input.db);
  const db = dbHandle as DB;
  const [snapshot, cycleId] = await Promise.all([
    readOperationalBalanceSnapshot({ asOf: input.asOf, db: dbHandle }),
    resolveShadowCycleId(dbHandle, input.cycleId),
  ]);
  const asOf = snapshot.asOf;

  const [journalRows, branchRowsFromDb] = await Promise.all([
    db
      .select({
        role: journalLines.role,
        branchId: journalEntries.branchId,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
      .where(
        and(
          eq(journalEntries.status, "POSTED"),
          eq(journalEntries.cycleId, cycleId),
          sql`${journalEntries.entryDate} <= ${asOf}`,
        ),
      ),
    db.select({ id: branches.id }).from(branches),
  ]);

  const roleSet = new Set<string>(RECONCILABLE_OPERATIONAL_ROLES);
  const operationalByScope = new Map<string, ReturnType<typeof money>>();
  const operationalGlobal = new Map<string, ReturnType<typeof money>>();
  for (const balance of snapshot.balances) {
    operationalByScope.set(
      key(balance.role, balance.branchId),
      money(balance.netDebit),
    );
    operationalGlobal.set(
      balance.role,
      (operationalGlobal.get(balance.role) ?? money(0)).plus(balance.netDebit),
    );
  }

  const journalByScope = new Map<string, ReturnType<typeof money>>();
  const journalGlobal = new Map<string, ReturnType<typeof money>>();
  const knownBranchIds = new Set(branchRowsFromDb.map((row) => row.id));
  let journalDebit = money(0);
  let journalCredit = money(0);
  for (const row of journalRows) {
    const debit = money(row.debit);
    const credit = money(row.credit);
    journalDebit = journalDebit.plus(debit);
    journalCredit = journalCredit.plus(credit);
    if (!roleSet.has(row.role)) continue;
    const net = debit.minus(credit);
    journalByScope.set(
      key(row.role, row.branchId),
      (journalByScope.get(key(row.role, row.branchId)) ?? money(0)).plus(net),
    );
    journalGlobal.set(
      row.role,
      (journalGlobal.get(row.role) ?? money(0)).plus(net),
    );
    if (row.branchId != null) knownBranchIds.add(row.branchId);
  }

  const makeRow = (
    scope: "GLOBAL" | "BRANCH",
    branchId: number | null,
    role: ConfirmedOperationalRole,
    operational: ReturnType<typeof money>,
    journal: ReturnType<typeof money>,
  ): DoubleEntryOperationalReconcileRow => {
    const difference = round2(journal.minus(operational));
    return {
      scope,
      branchId,
      role,
      operationalNetDebit: round2(operational).toFixed(2),
      journalNetDebit: round2(journal).toFixed(2),
      difference: difference.toFixed(2),
      matches: difference.isZero(),
    };
  };

  const globalRows = RECONCILABLE_OPERATIONAL_ROLES.map((role) =>
    makeRow(
      "GLOBAL",
      null,
      role,
      operationalGlobal.get(role) ?? money(0),
      journalGlobal.get(role) ?? money(0),
    ),
  );

  const branchRows: DoubleEntryOperationalReconcileRow[] = [];
  for (const branchId of Array.from(knownBranchIds).sort((a, b) => a - b)) {
    for (const role of RECONCILABLE_OPERATIONAL_ROLES) {
      if (!BRANCH_OPERATIONAL_ROLES.has(role)) continue;
      branchRows.push(
        makeRow(
          "BRANCH",
          branchId,
          role,
          operationalByScope.get(key(role, branchId)) ?? money(0),
          journalByScope.get(key(role, branchId)) ?? money(0),
        ),
      );
    }
  }

  const integrityDifference = round2(journalDebit.minus(journalCredit));
  const blockers = [...snapshot.blockers];
  if (!integrityDifference.isZero()) {
    blockers.push({
      code: "JOURNAL_UNBALANCED",
      source: "journalEntries/journalLines",
      message: "مجموع أسطر القيود المنشورة غير متوازن حتى تاريخ المطابقة.",
      count: 1,
      amount: integrityDifference.abs().toFixed(2),
    });
  }

  // Official drift has one row per authoritative grain. Company totals for
  // branch-backed roles remain available in globalRows for display only; adding
  // them to the verdict would count the same branch difference twice.
  const rows = [
    ...globalRows.filter((row) => !BRANCH_OPERATIONAL_ROLES.has(row.role)),
    ...branchRows,
  ];
  const driftRows = rows.filter((row) => !row.matches);
  const totalAbsoluteDifference = driftRows.reduce(
    (sum, row) => sum.plus(money(row.difference).abs()),
    money(0),
  );

  return {
    cycleId,
    asOf,
    snapshotDate: snapshot.snapshotDate,
    ok: blockers.length === 0 && driftRows.length === 0,
    rows,
    globalRows,
    branchRows,
    driftCount: driftRows.length,
    totalAbsoluteDifference: round2(totalAbsoluteDifference).toFixed(2),
    journalIntegrity: {
      debit: round2(journalDebit).toFixed(2),
      credit: round2(journalCredit).toFixed(2),
      difference: integrityDifference.toFixed(2),
      isBalanced: integrityDifference.isZero(),
    },
    blockers: blockers.sort(
      (a, b) =>
        a.code.localeCompare(b.code) || a.source.localeCompare(b.source),
    ),
  };
}
