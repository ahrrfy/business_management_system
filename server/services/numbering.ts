import { desc, like } from "drizzle-orm";
import { invoices } from "../../drizzle/schema";
import type { Tx } from "../db";
import { toDateStr } from "./money";

/**
 * Per-branch daily invoice number: INV-{branchId}-{YYYYMMDD}-{seq}.
 * The ordered read under FOR UPDATE narrows the race; the unique index on
 * invoiceNumber is the final guard (router retries on ER_DUP_ENTRY).
 */
export async function nextInvoiceNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `INV-${branchId}-${ymd}-`;
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
}
