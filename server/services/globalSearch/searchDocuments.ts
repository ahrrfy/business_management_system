// بحث المستندات المُقيَّدة بالفرع: الفواتير، عروض الأسعار، أوامر الشغل، أوامر الشراء، المصاريف.
import { and, desc, eq, or, sql } from "drizzle-orm";
import { customers, expenses, invoices, purchaseOrders, quotations, suppliers, workOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import type { SearchKind, SearchResult } from "./types";
import { formatDate } from "./helpers";

// ────────────────────────────── فواتير البيع ──────────────────────────────

async function searchInvoices(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(invoices.branchId, scopedBranchId));

  // باركود ⇒ يطابق رقم فاتورة بالضبط، أو رقم فاتورة يحتوي الباركود (نادر لكن المالك يطلبه: مسح ⇒ فاتورة).
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    const like_ = `%${escLike(query)}%`;
    conds.push(or(eq(invoices.invoiceNumber, query), sql`${invoices.invoiceNumber} LIKE ${like_} ESCAPE '!'`));
  } else {
    const like_ = `%${escLike(query)}%`;
    // نص ⇒ نطابق رقم الفاتورة أو ملاحظة (الملاحظات أحياناً تحوي اسم عميل/مرجع).
    conds.push(or(sql`${invoices.invoiceNumber} LIKE ${like_} ESCAPE '!'`, sql`${invoices.notes} LIKE ${like_} ESCAPE '!'`));
  }

  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerName: customers.name,
      total: invoices.total,
      invoiceDate: invoices.invoiceDate,
      status: invoices.status,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...conds))
    .orderBy(desc(invoices.invoiceDate), desc(invoices.id))
    .limit(limit);

  const STATUS_LABEL: Record<string, string> = {
    CANCELLED: " · ملغاة",
    RETURNED: " · مُرجَعة",
  };
  return rows.map((r) => ({
    type: "INVOICE" as const,
    id: r.id,
    title: r.invoiceNumber,
    subtitle: r.customerName ?? "عميل نقدي",
    meta: `${r.total} د.ع · ${formatDate(r.invoiceDate)}${STATUS_LABEL[r.status ?? ""] ?? ""}`,
    route: `/invoices/${r.id}`,
    rank: r.invoiceNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── عروض الأسعار ──────────────────────────────

async function searchQuotations(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(quotations.branchId, scopedBranchId));

  const like_ = `%${escLike(query)}%`;
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    conds.push(or(eq(quotations.quoteNumber, query), sql`${quotations.quoteNumber} LIKE ${like_} ESCAPE '!'`));
  } else {
    conds.push(or(sql`${quotations.quoteNumber} LIKE ${like_} ESCAPE '!'`, sql`${quotations.notes} LIKE ${like_} ESCAPE '!'`));
  }

  const rows = await db
    .select({
      id: quotations.id,
      quoteNumber: quotations.quoteNumber,
      customerName: customers.name,
      total: quotations.total,
      quoteDate: quotations.quoteDate,
    })
    .from(quotations)
    .leftJoin(customers, eq(customers.id, quotations.customerId))
    .where(and(...conds))
    .orderBy(desc(quotations.quoteDate), desc(quotations.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "QUOTATION" as const,
    id: r.id,
    title: r.quoteNumber,
    subtitle: r.customerName ?? "عميل نقدي",
    meta: `${r.total} د.ع · ${formatDate(r.quoteDate)}`,
    route: `/quotations/${r.id}`,
    rank: r.quoteNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── أوامر الشغل ──────────────────────────────

async function searchWorkOrders(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(workOrders.branchId, scopedBranchId));

  const like_ = `%${escLike(query)}%`;
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    conds.push(or(eq(workOrders.orderNumber, query), sql`${workOrders.orderNumber} LIKE ${like_} ESCAPE '!'`));
  } else {
    conds.push(or(sql`${workOrders.orderNumber} LIKE ${like_} ESCAPE '!'`, sql`${workOrders.title} LIKE ${like_} ESCAPE '!'`));
  }

  const rows = await db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      title: workOrders.title,
      customerName: customers.name,
      status: workOrders.status,
      createdAt: workOrders.createdAt,
    })
    .from(workOrders)
    .leftJoin(customers, eq(customers.id, workOrders.customerId))
    .where(and(...conds))
    .orderBy(desc(workOrders.createdAt), desc(workOrders.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "WORK_ORDER" as const,
    id: r.id,
    title: `${r.orderNumber} — ${r.title}`,
    subtitle: r.customerName ?? "بلا عميل",
    meta: `${r.status} · ${formatDate(r.createdAt)}`,
    route: `/work-orders/${r.id}`,
    rank: r.orderNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── أوامر الشراء ──────────────────────────────

async function searchPurchaseOrders(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(purchaseOrders.branchId, scopedBranchId));

  const like_ = `%${escLike(query)}%`;
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    conds.push(or(eq(purchaseOrders.poNumber, query), sql`${purchaseOrders.poNumber} LIKE ${like_} ESCAPE '!'`));
  } else {
    conds.push(or(sql`${purchaseOrders.poNumber} LIKE ${like_} ESCAPE '!'`, sql`${purchaseOrders.notes} LIKE ${like_} ESCAPE '!'`));
  }

  const rows = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      supplierName: suppliers.name,
      total: purchaseOrders.total,
      orderDate: purchaseOrders.orderDate,
      status: purchaseOrders.status,
    })
    .from(purchaseOrders)
    .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(and(...conds))
    .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "PURCHASE_ORDER" as const,
    id: r.id,
    title: r.poNumber,
    subtitle: r.supplierName ?? "—",
    meta: `${r.total} د.ع · ${r.status}`,
    // لا صفحة تفاصيل مستقلّة بعد ⇒ القائمة مع q=رقم الأمر (يُصفّيها إليه) + focus (يُبرزه).
    route: `/purchases?tab=orders&q=${encodeURIComponent(r.poNumber)}&focus=${r.id}`,
    rank: r.poNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── المصاريف ──────────────────────────────

async function searchExpenses(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "BARCODE" || kind === "PHONE") return [];

  const conds: any[] = [eq(expenses.status, "ACTIVE")];
  if (scopedBranchId !== null) conds.push(eq(expenses.branchId, scopedBranchId));

  const like_ = `%${escLike(query)}%`;
  conds.push(or(
    sql`${expenses.description} LIKE ${like_} ESCAPE '!'`,
    sql`${expenses.referenceNumber} LIKE ${like_} ESCAPE '!'`,
    sql`${expenses.payee} LIKE ${like_} ESCAPE '!'`,
  ));

  const rows = await db
    .select({
      id: expenses.id,
      description: expenses.description,
      payee: expenses.payee,
      amount: expenses.amount,
      expenseDate: expenses.expenseDate,
      category: expenses.category,
      referenceNumber: expenses.referenceNumber,
    })
    .from(expenses)
    .where(and(...conds))
    .orderBy(desc(expenses.expenseDate), desc(expenses.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "EXPENSE" as const,
    id: r.id,
    title: r.description?.slice(0, 80) || r.payee || `مصروف #${r.id}`,
    subtitle: [r.payee, r.referenceNumber].filter(Boolean).join(" · ") || r.category,
    meta: `${r.amount} د.ع · ${r.expenseDate}`,
    route: `/treasury?tab=expenses&focus=${r.id}`,
    rank: 2,
  }));
}


export { searchInvoices, searchQuotations, searchWorkOrders, searchPurchaseOrders, searchExpenses };
