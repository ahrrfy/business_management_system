import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  asc,
  and,
  Column,
  eq,
  inArray,
  is,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import {
  accountingEntries,
  supplierInvoices,
  supplierBookSettlementAllocations as allocations,
  supplierBookSettlementSources as sources,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, toDbMoney } from "../money";

export type BookInvoiceTotals = {
  paidAmount: string;
  paidCurrencyAmount: string;
  creditedAmount: string;
  creditedCurrencyAmount: string;
};

/** Only this versioned source format permits an explicitly retained, unallocated advance. */
export function isPurchaseAdvanceSnapshot(snapshot: string): boolean {
  try {
    const value = JSON.parse(snapshot);
    return value?.purpose === "PURCHASE_ADVANCE" && value.version === 1;
  } catch {
    return false;
  }
}

/** An owner-approved return remains CREDIT even while it has no invoice target. */
export function isExceptionReturnCreditSnapshot(snapshot: string): boolean {
  try {
    const v = JSON.parse(snapshot);
    return (
      v?.purpose === "OWNER_EXCEPTION_RETURN_CREDIT" &&
      v.version === 1 &&
      Number.isSafeInteger(v.returned?.id) &&
      v.returned?.origin === "OWNER_EXCEPTION"
    );
  } catch {
    return false;
  }
}

export function purchaseAdvanceAvailableAmount(
  source: { amount: string; reversedAmount: string },
  rows: readonly { allocatedAmount: string; reversedAmount: string }[],
): string {
  const allocated = rows.reduce(
    (sum, row) => sum.plus(row.allocatedAmount),
    money(0),
  );
  const reversed = rows.reduce(
    (sum, row) => sum.plus(row.reversedAmount),
    money(0),
  );
  const available = money(source.amount)
    .minus(source.reversedAmount)
    .minus(allocated.minus(reversed));
  if (
    money(source.reversedAmount).lt(0) ||
    money(source.reversedAmount).gt(source.amount) ||
    rows.some(
      (row) =>
        money(row.reversedAmount).lt(0) ||
        money(row.reversedAmount).gt(row.allocatedAmount),
    ) ||
    available.lt(0)
  )
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر قراءة الرصيد المقدم للمورد",
        why: "رصيد المصدر لا يطابق تخصيصاته أو مبالغ عكسه",
        doThis: "راجع سند الصرف وروابطه قبل متابعة التسوية",
      }),
    });
  return toDbMoney(available);
}
const MAX_ROWS = 20_000;
function assertBounded(length: number) {
  if (length > MAX_ROWS)
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر قراءة تسويات المورد",
        why: "تجاوز دليل التسوية حد القراءة الآمنة",
        doThis: "قسّم المراجعة إلى فواتير أقل قبل المتابعة",
      }),
    });
}

/** Currency values here are invoice book quantities, never proof of currency tender. */
export async function loadSupplierBookInvoiceTotals(
  db: DB | Tx,
  invoiceIds: readonly number[],
  options: { currentRead?: boolean } = {},
): Promise<Map<number, BookInvoiceTotals>> {
  const result = new Map<number, BookInvoiceTotals>();
  if (!invoiceIds.length) return result;
  const query = db
    .select({
      invoiceId: allocations.supplierInvoiceId,
      kind: sources.kind,
      status: sources.status,
      amount: allocations.allocatedAmount,
      currencyAmount: allocations.allocatedCurrencyAmount,
      reversedAmount: allocations.reversedAmount,
      reversedCurrencyAmount: allocations.reversedCurrencyAmount,
    })
    .from(sources)
    .innerJoin(allocations, eq(allocations.sourceId, sources.id))
    .where(inArray(allocations.supplierInvoiceId, Array.from(invoiceIds)))
    .orderBy(asc(sources.id), asc(allocations.id))
    .limit(MAX_ROWS + 1);
  // A locking current read must not use a REPEATABLE READ aggregate snapshot.
  const rows = await (options.currentRead ? query.for("share") : query);
  assertBounded(rows.length);
  for (const row of rows) {
    const id = Number(row.invoiceId);
    const totals = result.get(id) ?? {
      paidAmount: "0.00",
      paidCurrencyAmount: "0.00",
      creditedAmount: "0.00",
      creditedCurrencyAmount: "0.00",
    };
    // Retain tracked zero totals after full reversal so legacy readers cannot fall back to stale PO caches.
    result.set(id, totals);
    if (row.status === "REVERSED") continue;
    const amountKey = row.kind === "PAYMENT" ? "paidAmount" : "creditedAmount";
    const currencyKey =
      row.kind === "PAYMENT" ? "paidCurrencyAmount" : "creditedCurrencyAmount";
    totals[amountKey] = toDbMoney(
      money(totals[amountKey]).plus(
        money(row.amount).minus(row.reversedAmount),
      ),
    );
    totals[currencyKey] = toDbMoney(
      money(totals[currencyKey]).plus(
        money(row.currencyAmount).minus(row.reversedCurrencyAmount),
      ),
    );
    result.set(id, totals);
  }
  return result;
}

/** Source ownership survives reversal; an old original GL row must never become unclaimed cash again. */
export async function loadSupplierBookSourceClaims(
  db: DB | Tx,
  entryIds: readonly number[],
  options: { currentRead?: boolean } = {},
) {
  const result = new Map<
    number,
    { id: number; amount: string; kind: "PAYMENT" | "CREDIT" }
  >();
  if (!entryIds.length) return result;
  const query = db
    .select({
      id: sources.id,
      entryId: sources.sourceAccountingEntryId,
      amount: sources.amount,
      kind: sources.kind,
    })
    .from(sources)
    .where(inArray(sources.sourceAccountingEntryId, Array.from(entryIds)))
    .orderBy(asc(sources.id))
    .limit(MAX_ROWS + 1);
  const rows = await (options.currentRead ? query.for("share") : query);
  assertBounded(rows.length);
  for (const row of rows)
    result.set(Number(row.entryId), {
      id: Number(row.id),
      amount: row.amount,
      kind: row.kind,
    });
  return result;
}

export function supplierBookSourceClaimedSql(entryId: SQLWrapper) {
  const qualified = is(entryId, Column)
    ? sql`${entryId.table}.${sql.identifier(entryId.name)}`
    : entryId;
  return sql<boolean>`EXISTS (SELECT 1 FROM supplierBookSettlementSources sbsc WHERE sbsc.sourceAccountingEntryId = ${qualified})`;
}

/** Used before source filtering/count/pagination, with exactly the same net semantics as the raw reader. */
export function supplierBookInvoiceTotalsSql(invoiceId: SQLWrapper) {
  const qualified = is(invoiceId, Column)
    ? sql`${invoiceId.table}.${sql.identifier(invoiceId.name)}`
    : invoiceId;
  const sum = (
    kind: "PAYMENT" | "CREDIT",
    currency: boolean,
  ) => sql<string>`COALESCE((SELECT SUM(${currency ? sql`sbsa.allocatedCurrencyAmount - sbsa.reversedCurrencyAmount` : sql`sbsa.allocatedAmount - sbsa.reversedAmount`})
    FROM supplierBookSettlementAllocations sbsa INNER JOIN supplierBookSettlementSources sbs ON sbs.id = sbsa.sourceId
    WHERE sbsa.supplierInvoiceId = ${qualified} AND sbs.kind = ${kind} AND sbs.status IN ('APPLIED','PARTIALLY_REVERSED')),0)`;
  return {
    paidAmount: sum("PAYMENT", false),
    paidCurrencyAmount: sum("PAYMENT", true),
    creditedAmount: sum("CREDIT", false),
    creditedCurrencyAmount: sum("CREDIT", true),
  };
}

/** Documentary provenance on the original receipt; no native payment/request identity is implied. */
export async function loadSupplierBookReceiptSettlement(
  db: DB | Tx,
  receiptId: number,
) {
  const [source] = await db
    .select({
      id: sources.id,
      sourceKind: sources.kind,
      status: sources.status,
      amount: sources.amount,
      reversedAmount: sources.reversedAmount,
      accountingEntryId: sources.sourceAccountingEntryId,
      adoptedAt: sources.adoptedAt,
      sourceSnapshot: sources.sourceSnapshot,
    })
    .from(sources)
    .where(eq(sources.sourceReceiptId, receiptId))
    .limit(1);
  if (!source) return null;
  const rows = await db
    .select({
      id: allocations.id,
      supplierInvoiceId: allocations.supplierInvoiceId,
      openingEntryId: allocations.openingEntryId,
      invoiceNumber: supplierInvoices.invoiceNumber,
      invoiceDate: supplierInvoices.invoiceDate,
      openingDate: accountingEntries.entryDate,
      currency: supplierInvoices.currency,
      amount: allocations.allocatedAmount,
      currencyAmount: allocations.allocatedCurrencyAmount,
      reversedAmount: allocations.reversedAmount,
      reversedCurrencyAmount: allocations.reversedCurrencyAmount,
    })
    .from(allocations)
    .leftJoin(
      supplierInvoices,
      eq(supplierInvoices.id, allocations.supplierInvoiceId),
    )
    .leftJoin(
      accountingEntries,
      eq(accountingEntries.id, allocations.openingEntryId),
    )
    .where(eq(allocations.sourceId, source.id))
    .orderBy(asc(allocations.id))
    .limit(MAX_ROWS + 1);
  assertBounded(rows.length);
  const { sourceSnapshot, ...sourceFields } = source;
  const unallocatedAmount =
    isPurchaseAdvanceSnapshot(sourceSnapshot)
      ? purchaseAdvanceAvailableAmount(
          source,
          rows.map((row) => ({
            allocatedAmount: row.amount,
            reversedAmount: row.reversedAmount,
          })),
        )
      : "0.00";
  const invoiceIds = rows.flatMap((row) =>
    row.supplierInvoiceId == null ? [] : [Number(row.supplierInvoiceId)],
  );
  // Posted credits are shown separately so they cannot be mistaken for money in this receipt.
  const credits = invoiceIds.length
    ? await db
        .select({
          id: allocations.id,
          sourceId: sources.id,
          accountingEntryId: sources.sourceAccountingEntryId,
          status: sources.status,
          supplierInvoiceId: allocations.supplierInvoiceId,
          invoiceNumber: supplierInvoices.invoiceNumber,
          invoiceDate: supplierInvoices.invoiceDate,
          currency: supplierInvoices.currency,
          amount: allocations.allocatedAmount,
          currencyAmount: allocations.allocatedCurrencyAmount,
          reversedAmount: allocations.reversedAmount,
          reversedCurrencyAmount: allocations.reversedCurrencyAmount,
        })
        .from(sources)
        .innerJoin(allocations, eq(allocations.sourceId, sources.id))
        .innerJoin(
          supplierInvoices,
          eq(supplierInvoices.id, allocations.supplierInvoiceId),
        )
        .where(
          and(
            eq(sources.kind, "CREDIT"),
            inArray(allocations.supplierInvoiceId, invoiceIds),
          ),
        )
        .orderBy(asc(sources.id), asc(allocations.id))
        .limit(MAX_ROWS + 1)
    : [];
  assertBounded(credits.length);
  return {
    kind: "BOOK" as const,
    ...sourceFields,
    unallocatedAmount,
    allocations: rows.map((row) => ({
      ...row,
      targetKind:
        row.supplierInvoiceId == null
          ? ("OPENING" as const)
          : ("INVOICE" as const),
      targetDate:
        row.invoiceDate ?? row.openingDate?.toISOString().slice(0, 10) ?? null,
    })),
    credits,
  };
}
