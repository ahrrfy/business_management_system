import { desc, like, sql } from "drizzle-orm";
import { invoices } from "../../drizzle/schema";
import type { Tx } from "../db";
import { toDateStr } from "./money";

/**
 * Per-branch daily invoice number: INV-{branchId}-{YYYYMMDD}-{seq}.
 *
 * Race protection via MySQL connection-bound GET_LOCK: SELECT...FOR UPDATE on a
 * LIKE-prefix scan does not lock non-existent rows in InnoDB ⇒ two concurrent
 * transactions can read the same MAX and both compute seq=N. GET_LOCK is held
 * on the connection (same as tx) for the rest of the transaction and released
 * explicitly to free waiters immediately. The unique index on invoiceNumber
 * remains the final guard (router retries on ER_DUP_ENTRY).
 */
export async function nextInvoiceNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `INV-${branchId}-${ymd}-`;
  const lockName = `numbering:invoice:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: invoices.invoiceNumber })
      .from(invoices)
      .where(like(invoices.invoiceNumber, `${prefix}%`))
      .orderBy(desc(invoices.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}
