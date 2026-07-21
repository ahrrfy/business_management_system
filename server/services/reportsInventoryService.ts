// خدمة تقارير المخزون (للقراءة فقط) — تُغذّي مركز التقارير.
// المصدر: رصيد المخزون branchStock بالوحدة الأساس (int) × التكلفة costPrice للمتغيّر (لكل وحدة أساس).
//
// ⚠️ قواعد حاكمة (§٥):
//  • branchStock.quantity وحدةٌ أساس صحيحة (int)؛ productVariants.costPrice لكل وحدة أساس.
//    قيمة المخزون = SUM(quantity × costPrice) — كله عبر decimal.js (لا parseFloat/Number على المال).
//  • SQL الخام يستعمل أسماء أعمدة DB الحرفية (variantId/branchId/quantity/costPrice/minStock/categoryId).
//  • CAST(... AS CHAR) لكل مجموع مالي كي يصل نصّاً دقيقاً إلى decimal (لا float ضمنيّ).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/* ============================ تقييم المخزون حسب الفئة ============================ */

export interface InventoryValuationRow {
  categoryId: number | null;
  categoryName: string;
  items: number; // عدد المتغيّرات المميَّزة في الفئة
  totalQty: number; // إجمالي الكمية بالوحدة الأساس
  totalValue: string; // إجمالي القيمة بالتكلفة (نصّ مالي)
}

/** بضاعة الأمانة (ش٤): إجمالي منفصل — ليست أصل المكتبة، تُعرَض سطراً إفصاحياً لا ضمن المجموع. */
export interface ConsignmentValuationTotal { items: number; totalQty: number; totalValue: string }

export interface InventoryValuationResult {
  rows: InventoryValuationRow[];
  totals: { items: number; totalQty: number; totalValue: string };
  /** بضاعة الأمانة لدى المكتبة (بحصص المودِعين) — إفصاح خارج مجموع الأصول. */
  consignment: ConsignmentValuationTotal;
}

/**
 * تقييم المخزون بالتكلفة مجمّعاً حسب الفئة.
 * JOIN branchStock → productVariants → products → categories (LEFT لإظهار «بلا فئة»).
 * القيمة = SUM(quantity × costPrice). الترتيب تنازلياً بالقيمة. فلتر فرع اختياري على branchStock.branchId.
 */
export async function getInventoryValuation(
  opts: { branchId?: number } = {},
): Promise<InventoryValuationResult> {
  const db = getDb();
  if (!db) return { rows: [], totals: { items: 0, totalQty: 0, totalValue: "0" }, consignment: { items: 0, totalQty: 0, totalValue: "0" } };

  const branchCond = opts.branchId ? sql`AND bs.branchId = ${opts.branchId}` : sql``;
  // بضاعة الأمانة (ش٤): التقييم = أصول المكتبة فقط (isConsignment=false)؛ الأمانة سطرٌ منفصل أدناه.
  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        c.id AS categoryId,
        c.name AS categoryName,
        COUNT(DISTINCT bs.variantId) AS items,
        CAST(COALESCE(SUM(bs.quantity), 0) AS CHAR) AS totalQty,
        CAST(COALESCE(SUM(bs.quantity * pv.costPrice), 0) AS CHAR) AS totalValue
      FROM branchStock bs
      JOIN productVariants pv ON pv.id = bs.variantId
      JOIN products p ON p.id = pv.productId
      LEFT JOIN categories c ON c.id = p.categoryId
      WHERE p.isConsignment = false ${branchCond}
      GROUP BY c.id, c.name
      ORDER BY SUM(bs.quantity * pv.costPrice) DESC
    `),
  );

  const rows: InventoryValuationRow[] = raw.map((r) => ({
    categoryId: r.categoryId == null ? null : Number(r.categoryId),
    categoryName: r.categoryName ?? "بلا فئة",
    items: Number(r.items ?? 0),
    totalQty: Number(r.totalQty ?? 0),
    totalValue: toDbMoney(money(r.totalValue ?? 0)),
  }));

  // إجماليات عامّة (المجموع المالي عبر decimal لتفادي الانجراف؛ العدّ بمتغيّرات مميَّزة على مستوى الكل).
  const totalsRow = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(DISTINCT bs.variantId) AS items,
        CAST(COALESCE(SUM(bs.quantity), 0) AS CHAR) AS totalQty,
        CAST(COALESCE(SUM(bs.quantity * pv.costPrice), 0) AS CHAR) AS totalValue
      FROM branchStock bs
      JOIN productVariants pv ON pv.id = bs.variantId
      JOIN products p ON p.id = pv.productId
      WHERE p.isConsignment = false ${branchCond}
    `),
  )[0] ?? { items: 0, totalQty: 0, totalValue: "0" };

  // بضاعة الأمانة لدى المكتبة (بحصص المودِعين) — سطر إفصاحي منفصل.
  const consignRow = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(DISTINCT bs.variantId) AS items,
        CAST(COALESCE(SUM(bs.quantity), 0) AS CHAR) AS totalQty,
        CAST(COALESCE(SUM(bs.quantity * pv.costPrice), 0) AS CHAR) AS totalValue
      FROM branchStock bs
      JOIN productVariants pv ON pv.id = bs.variantId
      JOIN products p ON p.id = pv.productId
      WHERE p.isConsignment = true ${branchCond}
    `),
  )[0] ?? { items: 0, totalQty: 0, totalValue: "0" };

  return {
    rows,
    totals: {
      items: Number(totalsRow.items ?? 0),
      totalQty: Number(totalsRow.totalQty ?? 0),
      totalValue: toDbMoney(money(totalsRow.totalValue ?? 0)),
    },
    consignment: {
      items: Number(consignRow.items ?? 0),
      totalQty: Number(consignRow.totalQty ?? 0),
      totalValue: toDbMoney(money(consignRow.totalValue ?? 0)),
    },
  };
}

/* ============================ حالة المخزون / إعادة الطلب ============================ */

export type StockStatusLevel = "out" | "low" | "ok";

export interface StockStatusRow {
  variantId: number;
  productName: string;
  variantLabel: string;
  branchName: string | null;
  quantity: number;
  minStock: number;
  status: StockStatusLevel;
}

export interface StockStatusResult {
  rows: StockStatusRow[];
  totals: { outCount: number; lowCount: number };
}

/** وسم المتغيّر (لون/قياس/اسم متغيّر/sku) — يبني تسمية مقروءة للصفّ. */
function variantLabel(r: any): string {
  const parts = [r.variantName, r.color, r.size].filter((x) => x != null && String(x).trim() !== "");
  if (parts.length) return parts.join(" · ");
  return r.sku ? String(r.sku) : "—";
}

/**
 * حالة المخزون لكل (متغيّر × فرع) مقابل حدّ إعادة الطلب minStock.
 * JOIN branchStock → productVariants → products، LEFT JOIN branches.
 * status = out (qty<=0) | low (qty<=minStock و minStock>0) | ok.
 * onlyAlerts ⇒ نُعيد out+low فقط. الترتيب: شدّة الحالة (نفد ثم منخفض ثم طبيعي) ثم الكمية تصاعدياً.
 * فلتر فرع اختياري على branchStock.branchId.
 */
export async function getStockStatus(
  opts: { branchId?: number; onlyAlerts?: boolean; limit?: number } = {},
): Promise<StockStatusResult> {
  const db = getDb();
  if (!db) return { rows: [], totals: { outCount: 0, lowCount: 0 } };

  // حدّ مُقيَّد كبقيّة التقارير — يَمنع تحميل جدول (متغيّر×فرع) غير محدود.
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));

  const conds = [sql`1 = 1`];
  if (opts.branchId) conds.push(sql`bs.branchId = ${opts.branchId}`);
  // التنبيهات فقط = نفد أو منخفض ⇒ فلتر صفّيّ في WHERE (لا HAVING لأن لا GROUP BY ⇒
  // HAVING بلا تجميع يطوي النتيجة لصفّ واحد). منخفض = minStock>0 و qty<=minStock.
  if (opts.onlyAlerts) {
    conds.push(sql`(bs.quantity <= 0 OR (COALESCE(pv.minStock, 0) > 0 AND bs.quantity <= pv.minStock))`);
  }
  const where = sql.join(conds, sql` AND `);

  // statusRank: 0=نفد، 1=منخفض، 2=طبيعي — للترتيب بالشدّة. minStock قد يكون NULL ⇒ COALESCE 0.
  // الترتيب بالشدّة أولاً ⇒ أخطر الصفوف تَبقى عند الاقتطاع بـLIMIT.
  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        bs.variantId AS variantId,
        bs.quantity AS quantity,
        COALESCE(pv.minStock, 0) AS minStock,
        pv.variantName AS variantName,
        pv.color AS color,
        pv.size AS size,
        pv.sku AS sku,
        p.name AS productName,
        b.name AS branchName,
        CASE
          WHEN bs.quantity <= 0 THEN 0
          WHEN COALESCE(pv.minStock, 0) > 0 AND bs.quantity <= pv.minStock THEN 1
          ELSE 2
        END AS statusRank
      FROM branchStock bs
      JOIN productVariants pv ON pv.id = bs.variantId
      JOIN products p ON p.id = pv.productId
      LEFT JOIN branches b ON b.id = bs.branchId
      WHERE ${where}
      ORDER BY statusRank ASC, bs.quantity ASC
      LIMIT ${limit}
    `),
  );

  const rows: StockStatusRow[] = raw.map((r) => {
    const rank = Number(r.statusRank ?? 2);
    const status: StockStatusLevel = rank === 0 ? "out" : rank === 1 ? "low" : "ok";
    return {
      variantId: Number(r.variantId),
      productName: r.productName ?? "—",
      variantLabel: variantLabel(r),
      branchName: r.branchName ?? null,
      quantity: Number(r.quantity ?? 0),
      minStock: Number(r.minStock ?? 0),
      status,
    };
  });

  // شارات التنبيه (نفد/منخفض) تُحسَب من تجميع مستقلّ بلا LIMIT بنفس شروط WHERE —
  // وإلّا لانخفضت الأرقام عند اقتطاع الصفوف. (onlyAlerts لا يُغيّر العدّ لأن out/low
  // تُحتسب صراحةً بشرطها هنا، والصفوف ok لا تُعدّ أصلاً.)
  const aggRow = rowsOf(
    await db.execute(sql`
      SELECT
        SUM(CASE WHEN bs.quantity <= 0 THEN 1 ELSE 0 END) AS outCount,
        SUM(CASE WHEN bs.quantity > 0 AND COALESCE(pv.minStock, 0) > 0 AND bs.quantity <= pv.minStock THEN 1 ELSE 0 END) AS lowCount
      FROM branchStock bs
      JOIN productVariants pv ON pv.id = bs.variantId
      JOIN products p ON p.id = pv.productId
      LEFT JOIN branches b ON b.id = bs.branchId
      WHERE ${where}
    `),
  )[0];
  const outCount = Number(aggRow?.outCount ?? 0);
  const lowCount = Number(aggRow?.lowCount ?? 0);

  return { rows, totals: { outCount, lowCount } };
}
