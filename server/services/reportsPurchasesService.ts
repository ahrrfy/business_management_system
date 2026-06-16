// خدمة تقارير المشتريات (للقراءة فقط) — تُغذّي مركز التقارير. مرآة تقرير المبيعات.
// المصدر: جداول المشتريات purchaseOrders + purchaseOrderItems (لا تخمين).
//
// ⚠️ ملاحظات حاكمة:
//  • أعمدة DB الخام: purchaseOrders.status ⇒ العمود poStatus (الوسيط الأول لـmysqlEnum).
//    باقي الأعمدة على purchaseOrders/purchaseOrderItems تطابق أسماء الحقول (orderDate/total/paidAmount/
//    poNumber/quantity/unitPrice/total) — تحقّق من drizzle/schema.ts.
//  • التصفية الزمنية على DATE(orderDate) BETWEEN from AND to (orderDate عمود timestamp ⇒ DATE() يثبّت اليوم).
//  • للإجماليات المالية (الملخّص حسب المورّد) تُحتسب الحالات الملتزمة فقط: CONFIRMED + RECEIVED
//    (تُستبعَد DRAFT/SENT/CANCELLED). أما سجلّ البنود فيستبعد CANCELLED فقط (يعرض المسوّدات/المرسلة للمتابعة).
//  • كل الأموال عبر decimal.js + money/toDbMoney — ممنوع parseFloat/Number على المال.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/* ============================ ١) ملخّص المشتريات حسب المورّد ============================ */

export interface PurchasesReportRow {
  supplierId: number | null;
  supplierName: string | null;
  orders: number;
  total: string;
  paid: string;
  unpaid: string;
}

export interface PurchasesReportResult {
  rows: PurchasesReportRow[];
  totals: { count: number; total: string; paid: string; unpaid: string };
}

export async function getPurchasesReport(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<PurchasesReportResult> {
  const db = getDb();
  const empty: PurchasesReportResult = {
    rows: [],
    totals: { count: 0, total: "0", paid: "0", unpaid: "0" },
  };
  if (!db) return empty;

  const branchPo = opts.branchId ? sql`AND po.branchId = ${opts.branchId}` : sql``;

  // ملخّص لكل مورّد على أوامر الشراء الملتزمة (CONFIRMED/RECEIVED) ضمن النطاق.
  // unpaid = SUM(GREATEST(total - paidAmount, 0)) — لا قيم سالبة (الدفع الزائد لا يقلب الذمّة).
  const rawRows = rowsOf(
    await db.execute(sql`
      SELECT
        po.supplierId AS supplierId,
        s.name AS supplierName,
        COUNT(*) AS orders,
        CAST(COALESCE(SUM(po.total), 0) AS CHAR) AS total,
        CAST(COALESCE(SUM(po.paidAmount), 0) AS CHAR) AS paid,
        CAST(COALESCE(SUM(GREATEST(po.total - po.paidAmount, 0)), 0) AS CHAR) AS unpaid
      FROM purchaseOrders po
      JOIN suppliers s ON s.id = po.supplierId
      WHERE po.poStatus IN ('CONFIRMED', 'RECEIVED')
        AND DATE(po.orderDate) >= ${opts.from} AND DATE(po.orderDate) <= ${opts.to}
        ${branchPo}
      GROUP BY po.supplierId, s.name
      ORDER BY SUM(po.total) DESC
    `),
  );

  const rows: PurchasesReportRow[] = rawRows.map((r) => ({
    supplierId: r.supplierId != null ? Number(r.supplierId) : null,
    supplierName: r.supplierName ?? null,
    orders: Number(r.orders ?? 0),
    total: toDbMoney(money(r.total ?? 0)),
    paid: toDbMoney(money(r.paid ?? 0)),
    unpaid: toDbMoney(money(r.unpaid ?? 0)),
  }));

  // الإجماليات بـdecimal (لا parseFloat) — تفادي انجراف 0.01 على آلاف الأوامر.
  const totals = rows.reduce(
    (acc, r) => {
      acc.count += r.orders;
      acc.total = acc.total.add(money(r.total));
      acc.paid = acc.paid.add(money(r.paid));
      acc.unpaid = acc.unpaid.add(money(r.unpaid));
      return acc;
    },
    { count: 0, total: money(0), paid: money(0), unpaid: money(0) },
  );

  return {
    rows,
    totals: {
      count: totals.count,
      total: toDbMoney(totals.total),
      paid: toDbMoney(totals.paid),
      unpaid: toDbMoney(totals.unpaid),
    },
  };
}

/* ============================ ٢) سجلّ المشتريات (تفصيل البنود) ============================ */

export interface PurchaseRegisterRow {
  id: number;
  poId: number;
  poNumber: string | null;
  orderDate: string; // YYYY-MM-DD
  supplierName: string | null;
  productName: string | null;
  quantity: string;
  unitPrice: string;
  total: string;
}

export interface PurchaseRegisterResult {
  rows: PurchaseRegisterRow[];
  total: number; // عدد البنود الكلّي (للترقيم)
  totals: { amount: string };
}

export async function getPurchaseRegister(opts: {
  from: string;
  to: string;
  branchId?: number;
  limit?: number;
  offset?: number;
}): Promise<PurchaseRegisterResult> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, totals: { amount: "0" } };

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const branchPo = opts.branchId ? sql`AND po.branchId = ${opts.branchId}` : sql``;

  // تفصيل بنود أوامر الشراء — كل البنود عدا الملغاة (CANCELLED) ضمن النطاق.
  // الترتيب: الأحدث أولاً (orderDate desc) ثم بند الـid (desc) لاستقرار الترقيم.
  const rawRows = rowsOf(
    await db.execute(sql`
      SELECT
        poi.id AS id,
        po.id AS poId,
        po.poNumber AS poNumber,
        DATE_FORMAT(po.orderDate, '%Y-%m-%d') AS orderDate,
        s.name AS supplierName,
        p.name AS productName,
        CAST(poi.quantity AS CHAR) AS quantity,
        CAST(poi.unitPrice AS CHAR) AS unitPrice,
        CAST(poi.total AS CHAR) AS total
      FROM purchaseOrderItems poi
      JOIN purchaseOrders po ON po.id = poi.purchaseOrderId
      JOIN productVariants pv ON pv.id = poi.variantId
      JOIN products p ON p.id = pv.productId
      LEFT JOIN suppliers s ON s.id = po.supplierId
      WHERE po.poStatus <> 'CANCELLED'
        AND DATE(po.orderDate) >= ${opts.from} AND DATE(po.orderDate) <= ${opts.to}
        ${branchPo}
      ORDER BY po.orderDate DESC, poi.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  );

  const rows: PurchaseRegisterRow[] = rawRows.map((r) => ({
    id: Number(r.id),
    poId: Number(r.poId),
    poNumber: r.poNumber ?? null,
    orderDate: String(r.orderDate ?? ""),
    supplierName: r.supplierName ?? null,
    productName: r.productName ?? null,
    quantity: String(r.quantity ?? "0"),
    unitPrice: toDbMoney(money(r.unitPrice ?? 0)),
    total: toDbMoney(money(r.total ?? 0)),
  }));

  // عدّ كلّي + إجمالي المبلغ على كامل النطاق (لا الصفحة فقط) لـKPI والترقيم.
  const aggRow = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(poi.total), 0) AS CHAR) AS amount
      FROM purchaseOrderItems poi
      JOIN purchaseOrders po ON po.id = poi.purchaseOrderId
      WHERE po.poStatus <> 'CANCELLED'
        AND DATE(po.orderDate) >= ${opts.from} AND DATE(po.orderDate) <= ${opts.to}
        ${branchPo}
    `),
  )[0] ?? { cnt: 0, amount: "0" };

  return {
    rows,
    total: Number(aggRow.cnt ?? 0),
    totals: { amount: toDbMoney(money(aggRow.amount ?? 0)) },
  };
}
