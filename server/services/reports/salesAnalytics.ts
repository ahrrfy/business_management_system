// تقارير المبيعات التحليلية: أكثر مبيعاً، بطيئات الحركة، الربح حسب الفئة.
//
// النمط: SQL خام بأسماء أعمدة DB الفعلية (راجع [[raw-sql-column-names]]):
//   - invoices.invoiceStatus (لا status)؛ استبعد CANCELLED/RETURNED من إجماليات المبيعات.
//   - invoiceItems.baseQuantity جاهز بالوحدة الأساس ⇒ لا حاجة لحساب quantity×conversionFactor.
//   - الكمية: تخصم returnedBaseQuantity للحصول على صافي البيع (ما بقي مع العميل).
//   - التكلفة (COGS): تخصم returnedRestockedBaseQuantity فقط (المُعاد للرفّ) ⇒ التالف يبقى خسارةً مطابِقةً للدفتر.
//   - الأموال تُعاد كنصوص (CAST AS CHAR) لتمرّ عبر decimal.js على الواجهة بلا فقد دقّة.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";

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
      -- #reports-1 (تدقيق التثبيت): كانت الإيرادات تُجمع gross (بلا تصافي المرتجعات) بينما التكلفة
      -- تُخفَّض بالمُعاد للمخزون ⇒ الربح مبالَغ. الآن نصافي الإيرادات على الوحدات المرتجعة تناسبياً
      -- (guard على baseQuantity=0 للخدمات). التكلفة كما هي — الوحدات غير المُعادة للمخزون
      -- (تالف/استهلاك أمر شغل) تبقى تكلفتها خسارةً مطابقةً لدفتر P&L.
      CAST(COALESCE(SUM(CASE WHEN ii.baseQuantity > 0
        THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
        ELSE ii.total END), 0) AS CHAR) AS revenue,
      CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
      CAST(COALESCE(
        SUM(CASE WHEN ii.baseQuantity > 0
          THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.total END)
        - SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost),
      0) AS CHAR) AS profit,
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

  // REP-02 (تدقيق ٢٠/٦): المخزون وآخر بيع يُجمَّعان في subquery مستقلّ لكلٍّ ⇒ لا تكرار من ضرب
  // branchStock × invoiceItems على نفس المتغيّر. كان SUM(bs.quantity) يُضرَب بعدد صفوف البيع
  // (انضمام شجري) ⇒ مخزون منفوخ N مرّة. الآن كل مصدر يُجمَّع مرّةً ثم يُنضَمّ على productId.
  const rows = await db.execute(sql`
    SELECT
      p.id AS productId,
      p.name AS productName,
      c.name AS categoryName,
      CAST(COALESCE(st.qty, 0) AS CHAR) AS qtyInStock,
      DATE_FORMAT(sa.lastSale, '%Y-%m-%d') AS lastSaleDate,
      CASE WHEN sa.lastSale IS NULL THEN NULL ELSE DATEDIFF(UTC_DATE(), DATE(sa.lastSale)) END AS daysSinceLastSale
    FROM products p
    LEFT JOIN categories c ON c.id = p.categoryId
    LEFT JOIN (
      SELECT v.productId AS pid, SUM(bs.quantity) AS qty
      FROM productVariants v
      JOIN branchStock bs ON bs.variantId = v.id ${branchStockFilter}
      WHERE v.isActive = TRUE
      GROUP BY v.productId
    ) st ON st.pid = p.id
    LEFT JOIN (
      SELECT v.productId AS pid, MAX(i.invoiceDate) AS lastSale
      FROM productVariants v
      JOIN invoiceItems ii ON ii.variantId = v.id
      JOIN invoices i ON i.id = ii.invoiceId
        AND i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED')
        AND i.invoiceDate >= DATE_SUB(UTC_DATE(), INTERVAL ${sinceDays} DAY)
        ${branchSalesFilter}
      WHERE v.isActive = TRUE
      GROUP BY v.productId
    ) sa ON sa.pid = p.id
    WHERE p.isActive = TRUE
      AND COALESCE(st.qty, 0) > 0
      AND (sa.lastSale IS NULL OR DATEDIFF(UTC_DATE(), DATE(sa.lastSale)) >= ${sinceDays})
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
      -- #reports-1 (تدقيق التثبيت): مرآة إصلاح getTopProducts — الإيرادات تُصافى بالمرتجعات
      -- تناسبياً (باقي التفصيل هناك). ضروري لاتّساق تقرير الربح بالفئة مع تقرير المنتجات وP&L.
      CAST(COALESCE(SUM(CASE WHEN ii.baseQuantity > 0
        THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
        ELSE ii.total END), 0) AS CHAR) AS revenue,
      CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
      CAST(COALESCE(
        SUM(CASE WHEN ii.baseQuantity > 0
          THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.total END)
        - SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost),
      0) AS CHAR) AS profit,
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
