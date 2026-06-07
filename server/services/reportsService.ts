import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { customers, invoices, receipts } from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * تقارير مالية للقراءة فقط:
 *  - getARAging: شيخوخة الذمم المدينة لكل العملاء، بدلاء 0-30/31-60/61-90/90+.
 *  - getCustomerStatement: كشف حساب عميل (فواتير + دفعات + ملخّص).
 */

export interface ARAgingRow {
  customerId: number;
  customerName: string;
  phone: string | null;
  customerType: string | null;
  currentBalance: string;
  d0_30: string;
  d31_60: string;
  d61_90: string;
  d91p: string;
  unpaidTotal: string;
  oldestInvoiceDate: string | null;
}

/** AR aging — buckets per customer. Filters: optional branchId. */
export async function getARAging(opts: { branchId?: number } = {}): Promise<ARAgingRow[]> {
  const db = getDb();
  if (!db) return [];
  const branchFilter = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  const rows = await db.execute(sql`
    SELECT
      c.id AS customerId,
      c.name AS customerName,
      c.phone,
      c.customerType,
      CAST(c.currentBalance AS CHAR) AS currentBalance,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(i.invoiceDate)) <= 30 THEN GREATEST(i.total - i.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d0_30,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(i.invoiceDate)) BETWEEN 31 AND 60 THEN GREATEST(i.total - i.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d31_60,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(i.invoiceDate)) BETWEEN 61 AND 90 THEN GREATEST(i.total - i.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d61_90,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(i.invoiceDate)) > 90 THEN GREATEST(i.total - i.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d91p,
      CAST(COALESCE(SUM(GREATEST(i.total - i.paidAmount, 0)), 0) AS CHAR) AS unpaidTotal,
      DATE_FORMAT(MIN(CASE WHEN i.status IN ('PENDING','PARTIALLY_PAID') THEN i.invoiceDate END), '%Y-%m-%d') AS oldestInvoiceDate
    FROM customers c
    LEFT JOIN invoices i
      ON i.customerId = c.id
      AND i.status IN ('PENDING', 'PARTIALLY_PAID')
      ${branchFilter}
    WHERE c.isActive = TRUE
    GROUP BY c.id, c.name, c.phone, c.customerType, c.currentBalance
    HAVING unpaidTotal > 0 OR c.currentBalance > 0
    ORDER BY unpaidTotal DESC, c.currentBalance DESC
  `);
  const data = (rows as any)[0] ?? rows;
  return Array.isArray(data) ? (data as ARAgingRow[]) : [];
}

export interface CustomerStatementInvoice {
  id: number;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date | null;
  total: string;
  paidAmount: string;
  status: string;
  sourceType: string;
}

export interface CustomerStatementPayment {
  id: number;
  invoiceId: number | null;
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod: string;
  status: string;
  createdAt: Date;
}

export interface CustomerStatementResult {
  customer: typeof customers.$inferSelect;
  invoices: CustomerStatementInvoice[];
  payments: CustomerStatementPayment[];
  summary: {
    totalSales: string;
    totalPaid: string;
    unpaid: string;
    currentBalance: string;
  };
}

/** Customer account statement: invoices + payments + running summary. */
export async function getCustomerStatement(customerId: number): Promise<CustomerStatementResult | null> {
  const db = getDb();
  if (!db) return null;
  const c = (await db.select().from(customers).where(eq(customers.id, customerId)).limit(1))[0];
  if (!c) return null;

  const invs = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      status: invoices.status,
      sourceType: invoices.sourceType,
    })
    .from(invoices)
    .where(eq(invoices.customerId, customerId))
    .orderBy(desc(invoices.invoiceDate));

  const invIds = invs.map((i) => Number(i.id));
  const payments =
    invIds.length === 0
      ? []
      : await db
          .select({
            id: receipts.id,
            invoiceId: receipts.invoiceId,
            direction: receipts.direction,
            amount: receipts.amount,
            paymentMethod: receipts.paymentMethod,
            status: receipts.status,
            createdAt: receipts.createdAt,
          })
          .from(receipts)
          .where(inArray(receipts.invoiceId, invIds))
          .orderBy(asc(receipts.createdAt));

  const totalSales = invs.reduce((acc, i) => acc + Number(i.total ?? 0), 0);
  const totalPaid = invs.reduce((acc, i) => acc + Number(i.paidAmount ?? 0), 0);
  const unpaid = invs
    .filter((i) => i.status === "PENDING" || i.status === "PARTIALLY_PAID")
    .reduce((acc, i) => acc + Math.max(Number(i.total ?? 0) - Number(i.paidAmount ?? 0), 0), 0);

  return {
    customer: c,
    invoices: invs.map((i) => ({
      id: Number(i.id),
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      total: String(i.total),
      paidAmount: String(i.paidAmount),
      status: i.status,
      sourceType: i.sourceType,
    })),
    payments: payments.map((p) => ({
      id: Number(p.id),
      invoiceId: p.invoiceId ? Number(p.invoiceId) : null,
      direction: p.direction as "IN" | "OUT",
      amount: String(p.amount),
      paymentMethod: String(p.paymentMethod),
      status: String(p.status),
      createdAt: p.createdAt,
    })),
    summary: {
      totalSales: totalSales.toFixed(2),
      totalPaid: totalPaid.toFixed(2),
      unpaid: unpaid.toFixed(2),
      currentBalance: String(c.currentBalance ?? "0"),
    },
  };
}
