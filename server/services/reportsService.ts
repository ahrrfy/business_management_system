import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  customers,
  invoices,
  purchaseOrders,
  receipts,
  suppliers,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { money, sumMoney, toDbMoney } from "./money";

/** فرق موجب بين قيمتين ماليتين (لا يقلّ عن صفر) بدقّة decimal. */
function positiveDiff(total: unknown, paid: unknown) {
  const d = money((total as string) ?? 0).sub(money((paid as string) ?? 0));
  return d.isNegative() ? money(0) : d;
}

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
      DATE_FORMAT(MIN(CASE WHEN i.invoiceStatus IN ('PENDING','PARTIALLY_PAID') THEN i.invoiceDate END), '%Y-%m-%d') AS oldestInvoiceDate
    FROM customers c
    LEFT JOIN invoices i
      ON i.customerId = c.id
      AND i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
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

  // أموال بدقّة decimal.js (§٥) — لا Number/toFixed على الأموال.
  const totalSales = sumMoney(invs.map((i) => i.total ?? 0));
  const totalPaid = sumMoney(invs.map((i) => i.paidAmount ?? 0));
  const unpaid = sumMoney(
    invs
      .filter((i) => i.status === "PENDING" || i.status === "PARTIALLY_PAID")
      .map((i) => positiveDiff(i.total, i.paidAmount))
  );

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
      totalSales: toDbMoney(totalSales),
      totalPaid: toDbMoney(totalPaid),
      unpaid: toDbMoney(unpaid),
      currentBalance: String(c.currentBalance ?? "0"),
    },
  };
}

/* ============================ AP — الذمم الدائنة (الموردون) ============================ */

export interface APAgingRow {
  supplierId: number;
  supplierName: string;
  phone: string | null;
  currentBalance: string;
  d0_30: string;
  d31_60: string;
  d61_90: string;
  d91p: string;
  unpaidTotal: string;
  oldestPoDate: string | null;
}

/**
 * AP aging — buckets per supplier على أوامر الشراء المستحقّة.
 * DRAFT/SENT لم تُلتزَم مالياً ⇒ تُستبعد؛ CANCELLED تُستبعد؛
 * CONFIRMED/RECEIVED حيث total > paidAmount = مستحق.
 */
export async function getAPAging(opts: { branchId?: number } = {}): Promise<APAgingRow[]> {
  const db = getDb();
  if (!db) return [];
  const branchFilter = opts.branchId ? sql`AND po.branchId = ${opts.branchId}` : sql``;
  const rows = await db.execute(sql`
    SELECT
      s.id AS supplierId,
      s.name AS supplierName,
      s.phone,
      CAST(s.currentBalance AS CHAR) AS currentBalance,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(po.orderDate)) <= 30 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d0_30,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(po.orderDate)) BETWEEN 31 AND 60 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d31_60,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(po.orderDate)) BETWEEN 61 AND 90 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d61_90,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), DATE(po.orderDate)) > 90 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d91p,
      CAST(COALESCE(SUM(GREATEST(po.total - po.paidAmount, 0)), 0) AS CHAR) AS unpaidTotal,
      DATE_FORMAT(MIN(CASE WHEN po.poStatus IN ('CONFIRMED','RECEIVED') AND po.total > po.paidAmount THEN po.orderDate END), '%Y-%m-%d') AS oldestPoDate
    FROM suppliers s
    LEFT JOIN purchaseOrders po
      ON po.supplierId = s.id
      AND po.poStatus IN ('CONFIRMED', 'RECEIVED')
      ${branchFilter}
    WHERE s.isActive = TRUE
    GROUP BY s.id, s.name, s.phone, s.currentBalance
    HAVING unpaidTotal > 0 OR s.currentBalance > 0
    ORDER BY unpaidTotal DESC, s.currentBalance DESC
  `);
  const data = (rows as any)[0] ?? rows;
  return Array.isArray(data) ? (data as APAgingRow[]) : [];
}

export interface SupplierStatementPO {
  id: number;
  poNumber: string;
  orderDate: Date;
  expectedDeliveryDate: Date | null;
  total: string;
  paidAmount: string;
  status: string;
}

export interface SupplierStatementPayment {
  id: number;
  purchaseOrderId: number | null;
  receiptId: number | null;
  amount: string;
  entryDate: Date;
  notes: string | null;
}

export interface SupplierStatementResult {
  supplier: typeof suppliers.$inferSelect;
  purchaseOrders: SupplierStatementPO[];
  payments: SupplierStatementPayment[];
  summary: {
    totalPurchases: string;
    totalPaid: string;
    unpaid: string;
    currentBalance: string;
  };
}

/** كشف حساب مورد: أوامر شراء + دفعات (من accountingEntries.PAYMENT_OUT) + ملخّص. */
export async function getSupplierStatement(supplierId: number): Promise<SupplierStatementResult | null> {
  const db = getDb();
  if (!db) return null;
  const s = (await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1))[0];
  if (!s) return null;

  const pos = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      orderDate: purchaseOrders.orderDate,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      total: purchaseOrders.total,
      paidAmount: purchaseOrders.paidAmount,
      status: purchaseOrders.status,
    })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.supplierId, supplierId))
    .orderBy(desc(purchaseOrders.orderDate));

  // Payments to this supplier are tracked in accountingEntries (entryType=PAYMENT_OUT, supplierId).
  const payments = await db
    .select({
      id: accountingEntries.id,
      purchaseOrderId: accountingEntries.purchaseOrderId,
      receiptId: accountingEntries.receiptId,
      amount: accountingEntries.amount,
      entryDate: accountingEntries.entryDate,
      notes: accountingEntries.notes,
    })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.entryType, "PAYMENT_OUT"),
        eq(accountingEntries.supplierId, supplierId)
      )
    )
    .orderBy(asc(accountingEntries.entryDate), asc(accountingEntries.id));

  // أموال بدقّة decimal.js (§٥).
  const totalPurchases = sumMoney(pos.map((p) => p.total ?? 0));
  const totalPaid = sumMoney(pos.map((p) => p.paidAmount ?? 0));
  const unpaid = sumMoney(
    pos
      .filter((p) => p.status === "CONFIRMED" || p.status === "RECEIVED")
      .map((p) => positiveDiff(p.total, p.paidAmount))
  );

  return {
    supplier: s,
    purchaseOrders: pos.map((p) => ({
      id: Number(p.id),
      poNumber: p.poNumber,
      orderDate: p.orderDate,
      expectedDeliveryDate: p.expectedDeliveryDate,
      total: String(p.total),
      paidAmount: String(p.paidAmount),
      status: p.status,
    })),
    payments: payments.map((p) => ({
      id: Number(p.id),
      purchaseOrderId: p.purchaseOrderId ? Number(p.purchaseOrderId) : null,
      receiptId: p.receiptId ? Number(p.receiptId) : null,
      amount: String(p.amount),
      entryDate: p.entryDate as Date,
      notes: p.notes,
    })),
    summary: {
      totalPurchases: toDbMoney(totalPurchases),
      totalPaid: toDbMoney(totalPaid),
      unpaid: toDbMoney(unpaid),
      currentBalance: String(s.currentBalance ?? "0"),
    },
  };
}

/* ============================ تقارير المبيعات التحليلية ============================ */
//
// النمط: SQL خام بأسماء أعمدة DB الفعلية (راجع [[raw-sql-column-names]]):
//   - invoices.invoiceStatus (لا status)؛ استبعد CANCELLED/RETURNED من إجماليات المبيعات.
//   - invoiceItems.baseQuantity جاهز بالوحدة الأساس ⇒ لا حاجة لحساب quantity×conversionFactor.
//   - تخصم returnedBaseQuantity من الكمية المباعة (الفعلية) للحصول على صافي البيع.
//   - الأموال تُعاد كنصوص (CAST AS CHAR) لتمرّ عبر decimal.js على الواجهة بلا فقد دقّة.

/** فلاتر نطاق زمني + فرع تتشاركها تقارير المبيعات التحليلية. */
export interface SalesAnalyticsFilters {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  branchId?: number;
}

export interface TopProductRow {
  productId: number;
  productName: string;
  categoryName: string | null;
  qtySold: string; // وحدة أساس (صافي بعد المرتجعات)
  revenue: string;
  cost: string;
  profit: string;
  marginPct: string; // (profit/revenue)*100، 0 لو revenue=0
  invoicesCount: number;
}

/**
 * أكثر المنتجات مبيعاً — تجميع على مستوى المنتج (لا المتغيّر) عبر فترة.
 * يستبعد CANCELLED و RETURNED من الإجماليات. الترتيب: revenue أو qty.
 */
export async function getTopProducts(
  opts: SalesAnalyticsFilters & { limit?: number; by?: "revenue" | "qty" } = {}
): Promise<TopProductRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  // ملاحظة: نرتّب على التعبير الرقمي مباشرة لا على الاسم المستعار — لأن
  // العمود في SELECT مُحوَّل CAST AS CHAR ⇒ الترتيب عليه يصبح أبجدياً («50»>«240»).
  const orderCol = opts.by === "qty"
    ? sql`SUM(ii.baseQuantity - ii.returnedBaseQuantity) DESC`
    : sql`SUM(ii.total) DESC`;
  const fromFilter = opts.from ? sql`AND i.invoiceDate >= ${opts.from + " 00:00:00"}` : sql``;
  const toFilter = opts.to ? sql`AND i.invoiceDate <= ${opts.to + " 23:59:59"}` : sql``;
  const branchFilter = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;

  const rows = await db.execute(sql`
    SELECT
      p.id AS productId,
      p.name AS productName,
      c.name AS categoryName,
      CAST(COALESCE(SUM(ii.baseQuantity - ii.returnedBaseQuantity), 0) AS CHAR) AS qtySold,
      CAST(COALESCE(SUM(ii.total), 0) AS CHAR) AS revenue,
      CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
      CAST(COALESCE(SUM(ii.total) - SUM((ii.baseQuantity - ii.returnedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS profit,
      COUNT(DISTINCT ii.invoiceId) AS invoicesCount
    FROM invoiceItems ii
    INNER JOIN invoices i ON i.id = ii.invoiceId
    INNER JOIN productVariants v ON v.id = ii.variantId
    INNER JOIN products p ON p.id = v.productId
    LEFT JOIN categories c ON c.id = p.categoryId
    WHERE i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED')
      ${fromFilter}
      ${toFilter}
      ${branchFilter}
    GROUP BY p.id, p.name, c.name
    HAVING qtySold > 0
    ORDER BY ${orderCol}
    LIMIT ${limit}
  `);
  const data = (rows as any)[0] ?? rows;
  if (!Array.isArray(data)) return [];
  return (data as any[]).map((r) => {
    const revenue = money(r.revenue ?? 0);
    const profit = money(r.profit ?? 0);
    const marginPct = revenue.isZero()
      ? "0.00"
      : profit.div(revenue).mul(100).toFixed(2);
    return {
      productId: Number(r.productId),
      productName: String(r.productName ?? ""),
      categoryName: r.categoryName ? String(r.categoryName) : null,
      qtySold: String(r.qtySold ?? "0"),
      revenue: toDbMoney(revenue),
      cost: toDbMoney(money(r.cost ?? 0)),
      profit: toDbMoney(profit),
      marginPct,
      invoicesCount: Number(r.invoicesCount ?? 0),
    };
  });
}

export interface SlowMoverRow {
  productId: number;
  productName: string;
  categoryName: string | null;
  qtyInStock: string; // مجموع وحدات الأساس عبر متغيّرات المنتج (وفرع لو حُدِّد)
  lastSaleDate: string | null;
  daysSinceLastSale: number | null;
}

/**
 * بطيئات الحركة — منتجات بمخزون موجب لم تُبَع في النافذة (افتراضياً ٩٠ يوماً).
 * إن حُدِّد فرع: يقتصر المخزون والمبيعات على ذلك الفرع.
 */
export async function getSlowMovers(
  opts: { sinceDays?: number; branchId?: number; limit?: number } = {}
): Promise<SlowMoverRow[]> {
  const db = getDb();
  if (!db) return [];
  const sinceDays = Math.max(1, Math.min(365, opts.sinceDays ?? 90));
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const branchStockFilter = opts.branchId ? sql`AND bs.branchId = ${opts.branchId}` : sql``;
  const branchSalesFilter = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;

  const rows = await db.execute(sql`
    SELECT
      p.id AS productId,
      p.name AS productName,
      c.name AS categoryName,
      CAST(COALESCE(SUM(bs.quantity), 0) AS CHAR) AS qtyInStock,
      DATE_FORMAT(MAX(i.invoiceDate), '%Y-%m-%d') AS lastSaleDate,
      CASE
        WHEN MAX(i.invoiceDate) IS NULL THEN NULL
        ELSE DATEDIFF(CURDATE(), DATE(MAX(i.invoiceDate)))
      END AS daysSinceLastSale
    FROM products p
    LEFT JOIN categories c ON c.id = p.categoryId
    INNER JOIN productVariants v ON v.productId = p.id
    LEFT JOIN branchStock bs ON bs.variantId = v.id ${branchStockFilter}
    LEFT JOIN invoiceItems ii ON ii.variantId = v.id
    LEFT JOIN invoices i
      ON i.id = ii.invoiceId
      AND i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED')
      AND i.invoiceDate >= DATE_SUB(CURDATE(), INTERVAL ${sinceDays} DAY)
      ${branchSalesFilter}
    WHERE p.isActive = TRUE AND v.isActive = TRUE
    GROUP BY p.id, p.name, c.name
    HAVING qtyInStock > 0
       AND (MAX(i.invoiceDate) IS NULL
            OR DATEDIFF(CURDATE(), DATE(MAX(i.invoiceDate))) >= ${sinceDays})
    ORDER BY daysSinceLastSale IS NULL DESC, daysSinceLastSale DESC, qtyInStock DESC
    LIMIT ${limit}
  `);
  const data = (rows as any)[0] ?? rows;
  if (!Array.isArray(data)) return [];
  return (data as any[]).map((r) => ({
    productId: Number(r.productId),
    productName: String(r.productName ?? ""),
    categoryName: r.categoryName ? String(r.categoryName) : null,
    qtyInStock: String(r.qtyInStock ?? "0"),
    lastSaleDate: r.lastSaleDate ? String(r.lastSaleDate) : null,
    daysSinceLastSale: r.daysSinceLastSale == null ? null : Number(r.daysSinceLastSale),
  }));
}

export interface CategoryProfitRow {
  categoryId: number | null;
  categoryName: string;
  revenue: string;
  cost: string;
  profit: string;
  marginPct: string;
  itemsCount: number;
}

/** ربح حسب الفئة — تجميع على categories.id (NULL → «بلا فئة»). */
export async function getProfitByCategory(opts: SalesAnalyticsFilters = {}): Promise<CategoryProfitRow[]> {
  const db = getDb();
  if (!db) return [];
  const fromFilter = opts.from ? sql`AND i.invoiceDate >= ${opts.from + " 00:00:00"}` : sql``;
  const toFilter = opts.to ? sql`AND i.invoiceDate <= ${opts.to + " 23:59:59"}` : sql``;
  const branchFilter = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;

  const rows = await db.execute(sql`
    SELECT
      p.categoryId AS categoryId,
      COALESCE(c.name, 'بلا فئة') AS categoryName,
      CAST(COALESCE(SUM(ii.total), 0) AS CHAR) AS revenue,
      CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
      CAST(COALESCE(SUM(ii.total) - SUM((ii.baseQuantity - ii.returnedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS profit,
      COUNT(*) AS itemsCount
    FROM invoiceItems ii
    INNER JOIN invoices i ON i.id = ii.invoiceId
    INNER JOIN productVariants v ON v.id = ii.variantId
    INNER JOIN products p ON p.id = v.productId
    LEFT JOIN categories c ON c.id = p.categoryId
    WHERE i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED')
      ${fromFilter}
      ${toFilter}
      ${branchFilter}
    GROUP BY p.categoryId, c.name
    ORDER BY SUM(ii.total) DESC
  `);
  const data = (rows as any)[0] ?? rows;
  if (!Array.isArray(data)) return [];
  return (data as any[]).map((r) => {
    const revenue = money(r.revenue ?? 0);
    const profit = money(r.profit ?? 0);
    const marginPct = revenue.isZero()
      ? "0.00"
      : profit.div(revenue).mul(100).toFixed(2);
    return {
      categoryId: r.categoryId == null ? null : Number(r.categoryId),
      categoryName: String(r.categoryName ?? "بلا فئة"),
      revenue: toDbMoney(revenue),
      cost: toDbMoney(money(r.cost ?? 0)),
      profit: toDbMoney(profit),
      marginPct,
      itemsCount: Number(r.itemsCount ?? 0),
    };
  });
}
