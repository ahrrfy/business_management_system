// تقارير المخزون التشغيلية (للقراءة فقط) — تحويل المخزون من «عرض كميات» إلى «قرارات».
//  • getDeadStockValue: أصناف راكدة (لا بيع منذ N يوماً) بقيمة مخزونها ⇒ رأس مال مجمّد يجب تحريره.
//  • getReorderRisk: مبيعات عالية + مخزون عند/تحت حدّ الطلب ⇒ اطلب عاجلاً قبل النفاد.
//  • getStocktakeVariance: فروقات الجرد المعتمدة (stocktakeDecisions) حسب الفرع/الموظف/التاريخ.
//
// ⚠️ أسماء أعمدة DB الخام: invoices.invoiceStatus · stocktakeSessions.stocktakeStatus.
// مرساة «اليوم» UTC_DATE(). كل الأموال نصّاً decimal (§٥). تسمية المتغيّر: variantName → لون/قياس → sku.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

const VARIANT_LABEL = sql`COALESCE(v.variantName, NULLIF(TRIM(CONCAT_WS(' ', v.color, v.size)), ''), v.sku)`;

/* ============================ المخزون الراكد عالي القيمة ============================ */

export interface DeadStockRow {
  variantId: number;
  productName: string;
  variantLabel: string;
  categoryName: string | null;
  qtyInStock: string;
  costPrice: string;
  stockValue: string;
  lastSaleDate: string | null;
  daysSinceLastSale: number | null;
}

export interface DeadStockResult {
  rows: DeadStockRow[];
  summary: { count: number; totalValue: string };
}

/** أصناف لها رصيد موجب بلا بيع منذ `sinceDays` يوماً، مرتّبة بقيمة المخزون (الأعلى تجميداً أولاً). */
export async function getDeadStockValue(
  opts: { branchId?: number; sinceDays?: number; limit?: number } = {},
): Promise<DeadStockResult> {
  const empty: DeadStockResult = { rows: [], summary: { count: 0, totalValue: "0" } };
  const db = getDb();
  if (!db) return empty;
  const sinceDays = Math.max(1, Math.min(730, opts.sinceDays ?? 90));
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 300));
  const branchStk = opts.branchId ? sql`AND bs.branchId = ${opts.branchId}` : sql``;
  const branchSale = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;

  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        v.id AS variantId,
        p.name AS productName,
        ${VARIANT_LABEL} AS variantLabel,
        c.name AS categoryName,
        CAST(COALESCE(stk.qty, 0) AS CHAR) AS qtyInStock,
        CAST(v.costPrice AS CHAR) AS costPrice,
        CAST(COALESCE(stk.qty, 0) * v.costPrice AS CHAR) AS stockValue,
        DATE_FORMAT(sa.lastSale, '%Y-%m-%d') AS lastSaleDate,
        CASE WHEN sa.lastSale IS NULL THEN NULL ELSE DATEDIFF(UTC_DATE(), DATE(sa.lastSale)) END AS daysSinceLastSale
      FROM productVariants v
      JOIN products p ON p.id = v.productId
      LEFT JOIN categories c ON c.id = p.categoryId
      LEFT JOIN (
        SELECT bs.variantId, SUM(bs.quantity) AS qty
        FROM branchStock bs WHERE 1 = 1 ${branchStk} GROUP BY bs.variantId
      ) stk ON stk.variantId = v.id
      LEFT JOIN (
        SELECT ii.variantId, MAX(i.invoiceDate) AS lastSale
        FROM invoiceItems ii
        JOIN invoices i ON i.id = ii.invoiceId AND i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED') ${branchSale}
        GROUP BY ii.variantId
      ) sa ON sa.variantId = v.id
      WHERE v.isActive = TRUE AND COALESCE(stk.qty, 0) > 0
        AND (sa.lastSale IS NULL OR DATEDIFF(UTC_DATE(), DATE(sa.lastSale)) >= ${sinceDays})
      ORDER BY (COALESCE(stk.qty, 0) * v.costPrice) DESC
      LIMIT ${limit}
    `),
  );

  let totalValue = money(0);
  const rows: DeadStockRow[] = raw.map((r) => {
    totalValue = totalValue.add(money(r.stockValue ?? 0));
    return {
      variantId: Number(r.variantId),
      productName: String(r.productName ?? ""),
      variantLabel: String(r.variantLabel ?? ""),
      categoryName: r.categoryName ?? null,
      qtyInStock: String(r.qtyInStock ?? "0"),
      costPrice: toDbMoney(money(r.costPrice ?? 0)),
      stockValue: toDbMoney(money(r.stockValue ?? 0)),
      lastSaleDate: r.lastSaleDate ?? null,
      daysSinceLastSale: r.daysSinceLastSale == null ? null : Number(r.daysSinceLastSale),
    };
  });

  return { rows, summary: { count: rows.length, totalValue: toDbMoney(totalValue) } };
}

/* ============================ خطر النفاد (مبيعات عالية + مخزون منخفض) ============================ */

export interface ReorderRiskRow {
  variantId: number;
  productName: string;
  variantLabel: string;
  categoryName: string | null;
  qtyInStock: string;
  threshold: number;
  qtySoldRecent: string;
  /** أيام التغطية المتوقّعة بالرصيد الحالي (الرصيد ÷ معدّل البيع اليومي)؛ 0 إن نفد. */
  coverDays: number | null;
}

export interface ReorderRiskResult {
  rows: ReorderRiskRow[];
  summary: { count: number };
}

/** أصناف بِيعت بكثرة خلال `sinceDays` ورصيدها عند/تحت حدّ الطلب ⇒ مرشّحة لإعادة طلب عاجل. */
export async function getReorderRisk(
  opts: { branchId?: number; sinceDays?: number; limit?: number } = {},
): Promise<ReorderRiskResult> {
  const db = getDb();
  if (!db) return { rows: [], summary: { count: 0 } };
  const sinceDays = Math.max(1, Math.min(365, opts.sinceDays ?? 30));
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 300));
  const branchStk = opts.branchId ? sql`AND bs.branchId = ${opts.branchId}` : sql``;
  const branchSale = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;

  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        v.id AS variantId,
        p.name AS productName,
        ${VARIANT_LABEL} AS variantLabel,
        c.name AS categoryName,
        CAST(COALESCE(stk.qty, 0) AS CHAR) AS qtyInStock,
        GREATEST(COALESCE(v.minStock, 0), COALESCE(v.reorderPoint, 0)) AS threshold,
        CAST(COALESCE(sold.qty, 0) AS CHAR) AS qtySoldRecent
      FROM productVariants v
      JOIN products p ON p.id = v.productId
      LEFT JOIN categories c ON c.id = p.categoryId
      LEFT JOIN (
        SELECT bs.variantId, SUM(bs.quantity) AS qty
        FROM branchStock bs WHERE 1 = 1 ${branchStk} GROUP BY bs.variantId
      ) stk ON stk.variantId = v.id
      JOIN (
        SELECT ii.variantId, SUM(ii.baseQuantity - ii.returnedBaseQuantity) AS qty
        FROM invoiceItems ii
        JOIN invoices i ON i.id = ii.invoiceId
          AND i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED')
          AND i.invoiceDate >= DATE_SUB(UTC_DATE(), INTERVAL ${sinceDays} DAY) ${branchSale}
        GROUP BY ii.variantId
        HAVING qty > 0
      ) sold ON sold.variantId = v.id
      WHERE v.isActive = TRUE
        AND COALESCE(stk.qty, 0) <= GREATEST(COALESCE(v.minStock, 0), COALESCE(v.reorderPoint, 0))
      ORDER BY sold.qty DESC
      LIMIT ${limit}
    `),
  );

  const rows: ReorderRiskRow[] = raw.map((r) => {
    const stock = Number(r.qtyInStock ?? 0);
    const sold = Number(r.qtySoldRecent ?? 0);
    const dailyRate = sold > 0 ? sold / sinceDays : 0;
    const coverDays = dailyRate > 0 ? Math.round(stock / dailyRate) : null;
    return {
      variantId: Number(r.variantId),
      productName: String(r.productName ?? ""),
      variantLabel: String(r.variantLabel ?? ""),
      categoryName: r.categoryName ?? null,
      qtyInStock: String(r.qtyInStock ?? "0"),
      threshold: Number(r.threshold ?? 0),
      qtySoldRecent: String(r.qtySoldRecent ?? "0"),
      coverDays,
    };
  });

  return { rows, summary: { count: rows.length } };
}

/* ============================ فروقات الجرد المعتمدة ============================ */

const REASON_AR: Record<string, string> = {
  UNSPECIFIED: "غير محدّد",
  DAMAGE: "تلف",
  LOSS_THEFT: "فقد/سرقة",
  ENTRY_ERROR: "خطأ إدخال",
  PRINT_WASTE: "هدر طباعة",
};

export interface StocktakeVarianceRow {
  sessionId: number;
  sessionCode: string;
  branchName: string | null;
  approvedDate: string | null;
  approvedByName: string | null;
  productName: string;
  variantLabel: string;
  diffQty: number;
  value: string;
  reason: string;
}

export interface StocktakeVarianceResult {
  rows: StocktakeVarianceRow[];
  summary: { count: number; netValue: string; absValue: string };
}

/** فروقات الجرد المُسوّاة (ADJUST) لجلسات معتمدة — حسب الفرع/التاريخ. value = الفرق × تكلفة اللقطة. */
export async function getStocktakeVariance(
  opts: { branchId?: number; from?: string; to?: string; limit?: number } = {},
): Promise<StocktakeVarianceResult> {
  const db = getDb();
  if (!db) return { rows: [], summary: { count: 0, netValue: "0", absValue: "0" } };
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 500));
  const branchCond = opts.branchId ? sql`AND s.branchId = ${opts.branchId}` : sql``;
  const fromCond = opts.from ? sql`AND s.approvedAt >= ${opts.from + " 00:00:00"}` : sql``;
  const toCond = opts.to ? sql`AND s.approvedAt <= ${opts.to + " 23:59:59"}` : sql``;

  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        s.id AS sessionId,
        s.code AS sessionCode,
        b.name AS branchName,
        DATE_FORMAT(s.approvedAt, '%Y-%m-%d') AS approvedDate,
        u.name AS approvedByName,
        p.name AS productName,
        ${VARIANT_LABEL} AS variantLabel,
        d.diffQty AS diffQty,
        CAST(COALESCE(d.value, 0) AS CHAR) AS value,
        d.reason AS reason
      FROM stocktakeDecisions d
      JOIN stocktakeSessions s ON s.id = d.sessionId AND s.stocktakeStatus = 'APPROVED'
      JOIN productVariants v ON v.id = d.variantId
      JOIN products p ON p.id = v.productId
      LEFT JOIN branches b ON b.id = s.branchId
      LEFT JOIN users u ON u.id = s.approvedBy
      WHERE d.action = 'ADJUST' AND d.diffQty IS NOT NULL AND d.diffQty <> 0
        ${branchCond} ${fromCond} ${toCond}
      ORDER BY s.approvedAt DESC, ABS(COALESCE(d.value, 0)) DESC
      LIMIT ${limit}
    `),
  );

  let net = money(0);
  let abs = money(0);
  const rows: StocktakeVarianceRow[] = raw.map((r) => {
    const v = money(r.value ?? 0);
    net = net.add(v);
    abs = abs.add(v.abs());
    return {
      sessionId: Number(r.sessionId),
      sessionCode: String(r.sessionCode ?? ""),
      branchName: r.branchName ?? null,
      approvedDate: r.approvedDate ?? null,
      approvedByName: r.approvedByName ?? null,
      productName: String(r.productName ?? ""),
      variantLabel: String(r.variantLabel ?? ""),
      diffQty: Number(r.diffQty ?? 0),
      value: toDbMoney(v),
      reason: REASON_AR[String(r.reason ?? "UNSPECIFIED")] ?? String(r.reason ?? ""),
    };
  });

  return { rows, summary: { count: rows.length, netValue: toDbMoney(net), absValue: toDbMoney(abs) } };
}
