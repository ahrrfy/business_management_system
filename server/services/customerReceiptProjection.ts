import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DB, Tx } from "../db";
import { alias } from "drizzle-orm/mysql-core";
import {
  customerReceiptAllocations,
  customerReceiptSettlements,
  receipts,
} from "../../drizzle/schema";

interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

const sourceReceipt = alias(receipts, "customerReceiptProjectionSource");
const reversalReceipt = alias(receipts, "customerReceiptProjectionReversal");

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as unknown[])?.[0] ?? result;
  return Array.isArray(rows) ? rows : [];
}

/** Read-only invoice portions of real receipts; never another cash/AR movement. */
// Writers hold the target invoice lock. Do not lock the shared source/header:
// native advance consumption takes customer -> source; a source lock here would
// invert that order. Receipt reversal is excluded by the company governance gate.
export function customerReceiptAllocationRowsSql(
  invoiceIds: number[],
  _opts: { lock?: boolean } = {},
): SQL {
  const ids = sql.join(
    invoiceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`
    SELECT ${customerReceiptAllocations.invoiceId} AS invoiceId,
           ${sourceReceipt.paymentMethod} AS rail,
           ${sourceReceipt.direction} AS direction,
           ${sourceReceipt.shiftId} AS shiftId,
           CAST(${customerReceiptAllocations.amount} AS CHAR) AS amount
    FROM ${customerReceiptAllocations}
    JOIN ${customerReceiptSettlements}
      ON ${customerReceiptSettlements.id} = ${customerReceiptAllocations.settlementId}
    JOIN ${receipts} AS ${sourceReceipt}
      ON ${sourceReceipt.id} = ${customerReceiptSettlements.receiptId}
    WHERE ${customerReceiptAllocations.invoiceId} IN (${ids})
      AND ${customerReceiptAllocations.amount} > 0
      AND ${customerReceiptSettlements.reversalReceiptId} IS NULL
      AND ${sourceReceipt.direction} = 'IN'
      AND ${sourceReceipt.status} = 'COMPLETED'
      AND ${sourceReceipt.approvalStatus} = 'APPROVED'
      AND (${sourceReceipt.invoiceId} IS NULL OR ${sourceReceipt.invoiceId} <> ${customerReceiptAllocations.invoiceId})
  `;
}

export interface CustomerReceiptAllocationRow {
  invoiceId: number;
  rail: string;
  direction: "IN";
  shiftId: number | null;
  amount: string;
}

export async function loadCustomerReceiptAllocationRows(
  exec: SqlExecutor,
  invoiceIds: number[],
  opts: { lock?: boolean } = {},
): Promise<CustomerReceiptAllocationRow[]> {
  if (!invoiceIds.length) return [];
  const rows = rowsOf(
    await exec.execute(customerReceiptAllocationRowsSql(invoiceIds, opts)),
  );
  return rows.map((row) => ({
    invoiceId: Number(row.invoiceId),
    rail: String(row.rail),
    direction: "IN",
    shiftId: row.shiftId == null ? null : Number(row.shiftId),
    amount: String(row.amount),
  }));
}

type Receipt = typeof receipts.$inferSelect;

/** Actual sources with only this invoice's portion, for shared refund attribution.
 * These projected rows must never be detached or re-recorded as physical receipts. */
export async function loadCustomerReceiptAllocationSources(
  exec: DB | Tx,
  invoiceId: number,
): Promise<Receipt[]> {
  const rows = await exec
    .select({ receipt: receipts, amount: customerReceiptAllocations.amount })
    .from(customerReceiptAllocations)
    .innerJoin(
      customerReceiptSettlements,
      eq(
        customerReceiptSettlements.id,
        customerReceiptAllocations.settlementId,
      ),
    )
    .innerJoin(receipts, eq(receipts.id, customerReceiptSettlements.receiptId))
    .where(
      and(
        eq(customerReceiptAllocations.invoiceId, invoiceId),
        isNull(customerReceiptSettlements.reversalReceiptId),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
        sql`${customerReceiptAllocations.amount} > 0`,
        sql`(${receipts.invoiceId} IS NULL OR ${receipts.invoiceId} <> ${invoiceId})`,
      ),
    );
  return rows.map((row) => ({ ...row.receipt, amount: row.amount, invoiceId }));
}

export type CustomerReceiptInvoicePayment = Pick<
  Receipt,
  | "id"
  | "direction"
  | "amount"
  | "paymentMethod"
  | "status"
  | "createdAt"
  | "referenceNumber"
  | "voucherNumber"
  | "attachmentUrl"
> & {
  allocationId: number;
  originalInvoiceId: number;
  sourceAmount: string;
  isAllocated: true;
};

/** Invoice history shows actual source/counter receipts with this invoice's portion. */
export async function loadCustomerReceiptInvoicePayments(
  exec: SqlExecutor,
  invoiceId: number,
): Promise<CustomerReceiptInvoicePayment[]> {
  const portionRows = rowsOf(
    await exec.execute(sql`
    SELECT ${sourceReceipt.id} AS id,
           ${sourceReceipt.direction} AS direction,
           CAST(${customerReceiptAllocations.amount} AS CHAR) AS amount,
           ${sourceReceipt.paymentMethod} AS paymentMethod,
           ${sourceReceipt.status} AS status,
           ${sourceReceipt.createdAt} AS createdAt,
           ${sourceReceipt.referenceNumber} AS referenceNumber,
           ${sourceReceipt.voucherNumber} AS voucherNumber,
           ${sourceReceipt.attachmentUrl} AS attachmentUrl,
           ${customerReceiptAllocations.id} AS allocationId,
           ${customerReceiptAllocations.originalInvoiceId} AS originalInvoiceId,
           CAST(${sourceReceipt.amount} AS CHAR) AS sourceAmount
    FROM ${customerReceiptAllocations}
    JOIN ${customerReceiptSettlements}
      ON ${customerReceiptSettlements.id} = ${customerReceiptAllocations.settlementId}
    JOIN ${receipts} AS ${sourceReceipt}
      ON ${sourceReceipt.id} = ${customerReceiptSettlements.receiptId}
    WHERE ${customerReceiptAllocations.invoiceId} = ${invoiceId}
      AND ${customerReceiptAllocations.amount} > 0
      AND ${sourceReceipt.approvalStatus} = 'APPROVED'
      AND ${sourceReceipt.status} IN ('COMPLETED', 'REVERSED')
      AND (${sourceReceipt.invoiceId} IS NULL OR ${sourceReceipt.invoiceId} <> ${invoiceId})
    UNION ALL
    SELECT ${reversalReceipt.id} AS id,
           ${reversalReceipt.direction} AS direction,
           CAST(${customerReceiptAllocations.amount} AS CHAR) AS amount,
           ${reversalReceipt.paymentMethod} AS paymentMethod,
           ${reversalReceipt.status} AS status,
           ${reversalReceipt.createdAt} AS createdAt,
           ${reversalReceipt.referenceNumber} AS referenceNumber,
           ${reversalReceipt.voucherNumber} AS voucherNumber,
           ${reversalReceipt.attachmentUrl} AS attachmentUrl,
           ${customerReceiptAllocations.id} AS allocationId,
           ${customerReceiptAllocations.originalInvoiceId} AS originalInvoiceId,
           CAST(${reversalReceipt.amount} AS CHAR) AS sourceAmount
    FROM ${customerReceiptAllocations}
    JOIN ${customerReceiptSettlements}
      ON ${customerReceiptSettlements.id} = ${customerReceiptAllocations.settlementId}
    JOIN ${receipts} AS ${reversalReceipt}
      ON ${reversalReceipt.id} = ${customerReceiptSettlements.reversalReceiptId}
    WHERE ${customerReceiptAllocations.invoiceId} = ${invoiceId}
      AND ${customerReceiptAllocations.amount} > 0
      AND ${reversalReceipt.approvalStatus} = 'APPROVED'
      AND ${reversalReceipt.status} IN ('COMPLETED', 'REVERSED')
      AND (${reversalReceipt.invoiceId} IS NULL OR ${reversalReceipt.invoiceId} <> ${invoiceId})
  `),
  );
  return portionRows.map((row) => ({
    id: Number(row.id),
    direction: row.direction as Receipt["direction"],
    amount: String(row.amount),
    paymentMethod: row.paymentMethod as Receipt["paymentMethod"],
    status: row.status as Receipt["status"],
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
    referenceNumber:
      row.referenceNumber == null ? null : String(row.referenceNumber),
    voucherNumber: row.voucherNumber == null ? null : String(row.voucherNumber),
    attachmentUrl: row.attachmentUrl == null ? null : String(row.attachmentUrl),
    allocationId: Number(row.allocationId),
    originalInvoiceId: Number(row.originalInvoiceId),
    sourceAmount: String(row.sourceAmount),
    isAllocated: true,
  }));
}
