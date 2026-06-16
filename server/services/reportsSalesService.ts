// خدمة تقارير المبيعات (للقراءة فقط) — تُغذّي مركز التقارير (شريحة المبيعات).
// المصدر: جداول الفواتير invoices + بنودها invoiceItems (لا تخمين).
//
// ⚠️ نمط SQL الخام (يطابق reportsFinancialService): db.execute(sql`…`) + rowsOf لفكّ نتيجة mysql2،
//    CAST(col AS CHAR) لكل مبلغ ثم money()/toDbMoney للجمع (لا parseFloat/Number على المال — §٥)،
//    DATE(invoices.invoiceDate) لمقارنة التاريخ (حدّان شاملان YYYY-MM-DD).
//    أسماء الأعمدة بأسماء DB: invoices.status ⇒ العمود invoiceStatus.
//
// تعريف الربح للسطر = الإجمالي − (الكمية الأساس المُباعة فعلاً) × تكلفة الوحدة،
//   حيث الكمية المُباعة فعلاً = baseQuantity − returnedBaseQuantity ⇒ المرتجع الجزئي يُحيّد تكلفته.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/* ============================ سجلّ المبيعات المفصّل (سطر-سطر) ============================ */

export interface SalesRegisterRow {
  id: number; // معرّف بند الفاتورة
  invoiceId: number;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  customerName: string | null;
  productName: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  total: string;
  profit: string;
}

export interface SalesRegisterResult {
  rows: SalesRegisterRow[];
  total: number; // عدد البنود الكلّي (قبل الترقيم)
  totals: { revenue: string; cost: string; profit: string; qty: string };
}

export async function getSalesRegister(opts: {
  from: string;
  to: string;
  branchId?: number;
  limit?: number;
  offset?: number;
}): Promise<SalesRegisterResult> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, totals: { revenue: "0", cost: "0", profit: "0", qty: "0" } };

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const branchCond = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  // الفلتر المشترك: نطاق التاريخ + استبعاد الملغاة + الفرع (اختياري).
  const where = sql`
    DATE(i.invoiceDate) >= ${opts.from} AND DATE(i.invoiceDate) <= ${opts.to}
    AND i.invoiceStatus NOT IN ('CANCELLED')
    ${branchCond}
  `;

  // الربح للسطر: ii.total − (ii.baseQuantity − ii.returnedBaseQuantity) × ii.unitCost.
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        ii.id AS id,
        i.id AS invoiceId,
        i.invoiceNumber AS invoiceNumber,
        DATE_FORMAT(i.invoiceDate, '%Y-%m-%d') AS invoiceDate,
        c.name AS customerName,
        p.name AS productName,
        CAST(ii.quantity AS CHAR) AS quantity,
        CAST(ii.unitPrice AS CHAR) AS unitPrice,
        CAST(ii.unitCost AS CHAR) AS unitCost,
        CAST(ii.total AS CHAR) AS total,
        CAST(ii.total - (ii.baseQuantity - ii.returnedBaseQuantity) * ii.unitCost AS CHAR) AS profit
      FROM invoiceItems ii
      JOIN invoices i ON i.id = ii.invoiceId
      JOIN productVariants pv ON pv.id = ii.variantId
      JOIN products p ON p.id = pv.productId
      LEFT JOIN customers c ON c.id = i.customerId
      LEFT JOIN branches b ON b.id = i.branchId
      WHERE ${where}
      ORDER BY i.invoiceDate DESC, ii.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  ) as SalesRegisterRow[];

  // الإجماليات على كامل النطاق (لا الصفحة فقط) — العدد + الإيراد/التكلفة/الربح/الكمية.
  const totalsRow = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(ii.total), 0) AS CHAR) AS revenue,
        CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
        CAST(COALESCE(SUM(ii.total - (ii.baseQuantity - ii.returnedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS profit,
        CAST(COALESCE(SUM(ii.quantity), 0) AS CHAR) AS qty
      FROM invoiceItems ii
      JOIN invoices i ON i.id = ii.invoiceId
      WHERE ${where}
    `),
  )[0] ?? { cnt: 0, revenue: "0", cost: "0", profit: "0", qty: "0" };

  return {
    rows,
    total: Number(totalsRow.cnt ?? 0),
    totals: {
      revenue: toDbMoney(money(totalsRow.revenue ?? 0)),
      cost: toDbMoney(money(totalsRow.cost ?? 0)),
      profit: toDbMoney(money(totalsRow.profit ?? 0)),
      qty: String(totalsRow.qty ?? "0"),
    },
  };
}

/* ============================ المبيعات حسب بُعد (عميل/فرع/طريقة دفع/كاشير) ============================ */

export type SalesDimension = "customer" | "branch" | "paymentMethod" | "cashier";

export interface SalesByDimensionRow {
  key: string;
  label: string;
  invoices: number;
  revenue: string;
  paid: string;
  unpaid: string;
}

export interface SalesByDimensionResult {
  rows: SalesByDimensionRow[];
  totals: { invoices: number; revenue: string; paid: string; unpaid: string };
}

export async function getSalesByDimension(opts: {
  from: string;
  to: string;
  branchId?: number;
  dimension: SalesDimension;
}): Promise<SalesByDimensionResult> {
  const db = getDb();
  if (!db) return { rows: [], totals: { invoices: 0, revenue: "0", paid: "0", unpaid: "0" } };

  // اختيار محور التجميع + التسمية + الانضمام المطلوب (إن وُجِد).
  // المفتاح key نصّي دائماً (للتمييز في الواجهة)؛ التسمية label معروضة (تتراجع للمفتاح عند NULL).
  let groupKey;
  let labelExpr;
  let joinClause = sql``;
  switch (opts.dimension) {
    case "customer":
      groupKey = sql`i.customerId`;
      labelExpr = sql`COALESCE(c.name, 'عميل نقدي')`;
      joinClause = sql`LEFT JOIN customers c ON c.id = i.customerId`;
      break;
    case "branch":
      groupKey = sql`i.branchId`;
      labelExpr = sql`COALESCE(b.name, CAST(i.branchId AS CHAR))`;
      joinClause = sql`LEFT JOIN branches b ON b.id = i.branchId`;
      break;
    case "paymentMethod":
      groupKey = sql`i.paymentMethod`;
      labelExpr = sql`COALESCE(i.paymentMethod, 'غير محدّد')`;
      break;
    case "cashier":
      groupKey = sql`i.createdBy`;
      labelExpr = sql`COALESCE(u.name, 'غير معروف')`;
      joinClause = sql`LEFT JOIN users u ON u.id = i.createdBy`;
      break;
    default:
      groupKey = sql`i.customerId`;
      labelExpr = sql`COALESCE(c.name, 'عميل نقدي')`;
      joinClause = sql`LEFT JOIN customers c ON c.id = i.customerId`;
  }

  const branchCond = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  const where = sql`
    DATE(i.invoiceDate) >= ${opts.from} AND DATE(i.invoiceDate) <= ${opts.to}
    AND i.invoiceStatus NOT IN ('CANCELLED')
    ${branchCond}
  `;

  // revenue=SUM(total)، paid=SUM(paidAmount)، unpaid=SUM(GREATEST(total-paidAmount-returnedTotal,0)).
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        CAST(COALESCE(${groupKey}, '') AS CHAR) AS \`key\`,
        ${labelExpr} AS label,
        COUNT(*) AS invoices,
        CAST(COALESCE(SUM(i.total), 0) AS CHAR) AS revenue,
        CAST(COALESCE(SUM(i.paidAmount), 0) AS CHAR) AS paid,
        CAST(COALESCE(SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0) AS CHAR) AS unpaid
      FROM invoices i
      ${joinClause}
      WHERE ${where}
      GROUP BY ${groupKey}, label
      ORDER BY SUM(i.total) DESC
    `),
  );

  let invCount = 0;
  let revenue = money(0);
  let paid = money(0);
  let unpaid = money(0);
  const out: SalesByDimensionRow[] = rows.map((r) => {
    const rev = money(r.revenue ?? 0);
    const pd = money(r.paid ?? 0);
    const up = money(r.unpaid ?? 0);
    const cnt = Number(r.invoices ?? 0);
    invCount += cnt;
    revenue = revenue.add(rev);
    paid = paid.add(pd);
    unpaid = unpaid.add(up);
    return {
      key: String(r.key ?? ""),
      label: String(r.label ?? "—"),
      invoices: cnt,
      revenue: toDbMoney(rev),
      paid: toDbMoney(pd),
      unpaid: toDbMoney(up),
    };
  });

  return {
    rows: out,
    totals: {
      invoices: invCount,
      revenue: toDbMoney(revenue),
      paid: toDbMoney(paid),
      unpaid: toDbMoney(unpaid),
    },
  };
}
