// تفصيل أعمار الذمم (للقراءة فقط) — فاتورةً-بفاتورة (AR) / أمرَ-شراء-بأمر (AP).
// يكمّل تقريرَي الملخّص getARAging/getAPAging في reportsService.ts: نفس الفلاتر والشرائح
// العمرية تماماً، لكن **سرد المستندات المنفردة** بدل التجميع على الطرف ⇒ المحاسب يرى أيّ فاتورة
// تحديداً تأخّرت لا مجموع العميل فقط.
//
// النمط (راجع reportsFinancialService.ts + [[raw-sql-column-names]]):
//   - SQL خام بأسماء أعمدة DB الفعلية: invoices.status ⇒ العمود `invoiceStatus`،
//     purchaseOrders.status ⇒ العمود `poStatus` (التحقّق في drizzle/schema.ts).
//   - الأموال تُعاد نصوصاً (CAST AS CHAR) لتمرّ عبر decimal.js بلا فقد دقّة.
//   - الشرائح بـDATEDIFF(CURDATE(), DATE(COALESCE(dueDate, invoiceDate))) لـAR
//     و DATEDIFF(CURDATE(), DATE(orderDate)) لـAP — مرآة الملخّص.
//   - المتبقّي/فاتورة AR = GREATEST(total - paidAmount - returnedTotal, 0)
//     المتبقّي/أمر AP = GREATEST(total - paidAmount, 0).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

export type AgingSide = "AR" | "AP";
export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

export interface AgingDetailRow {
  id: number;
  number: string;
  partyName: string;
  date: string; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD (AR فقط؛ AP دائماً null)
  daysOverdue: number;
  bucket: AgingBucket;
  unpaid: string;
}

export interface AgingDetailResult {
  rows: AgingDetailRow[];
  totals: {
    count: number;
    unpaid: string;
    d0_30: string;
    d31_60: string;
    d61_90: string;
    d91p: string;
  };
}

/** شريحة عمرية من عدد الأيام (مرآة حدود الملخّص: ‎≤30 / 31-60 / 61-90 / ‎>90). */
function bucketOf(days: number): AgingBucket {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/**
 * تفصيل أعمار الذمم — مستندٌ بمستند، مرتّبٌ تنازلياً بأيّام التأخّر.
 *  - AR: كل فاتورة غير مسدّدة (invoiceStatus IN ('PENDING','PARTIALLY_PAID')).
 *  - AP: كل أمر شراء مستحقّ (poStatus IN ('CONFIRMED','RECEIVED') AND total > paidAmount).
 * branchId اختياري (يُمرّره الراوتر بعد عزل الفرع حسب الدور).
 */
export async function getArApAgingDetail(opts: {
  side: AgingSide;
  branchId?: number;
}): Promise<AgingDetailResult> {
  const empty: AgingDetailResult = {
    rows: [],
    totals: { count: 0, unpaid: "0", d0_30: "0", d31_60: "0", d61_90: "0", d91p: "0" },
  };
  const db = getDb();
  if (!db) return empty;

  const isAR = opts.side === "AR";
  const branchId = opts.branchId;

  const raw = isAR
    ? rowsOf(
        await db.execute(sql`
          SELECT
            i.id AS id,
            i.invoiceNumber AS number,
            c.name AS partyName,
            DATE_FORMAT(i.invoiceDate, '%Y-%m-%d') AS date,
            DATE_FORMAT(i.dueDate, '%Y-%m-%d') AS dueDate,
            DATEDIFF(CURDATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) AS daysOverdue,
            CAST(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) AS CHAR) AS unpaid
          FROM invoices i
          LEFT JOIN customers c ON c.id = i.customerId
          WHERE i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
            AND GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) > 0
            ${branchId ? sql`AND i.branchId = ${branchId}` : sql``}
          ORDER BY daysOverdue DESC, i.id DESC
        `),
      )
    : rowsOf(
        await db.execute(sql`
          SELECT
            po.id AS id,
            po.poNumber AS number,
            s.name AS partyName,
            DATE_FORMAT(po.orderDate, '%Y-%m-%d') AS date,
            NULL AS dueDate,
            DATEDIFF(CURDATE(), DATE(po.orderDate)) AS daysOverdue,
            CAST(GREATEST(po.total - po.paidAmount, 0) AS CHAR) AS unpaid
          FROM purchaseOrders po
          LEFT JOIN suppliers s ON s.id = po.supplierId
          WHERE po.poStatus IN ('CONFIRMED', 'RECEIVED')
            AND po.total > po.paidAmount
            ${branchId ? sql`AND po.branchId = ${branchId}` : sql``}
          ORDER BY daysOverdue DESC, po.id DESC
        `),
      );

  // أموال بدقّة decimal.js (§٥) — لا Number/parseFloat على المال.
  let totalUnpaid = money(0);
  let d0_30 = money(0);
  let d31_60 = money(0);
  let d61_90 = money(0);
  let d91p = money(0);

  const rows: AgingDetailRow[] = raw.map((r) => {
    const daysOverdue = Number(r.daysOverdue ?? 0);
    const bucket = bucketOf(daysOverdue);
    const unpaid = money(r.unpaid ?? 0);
    totalUnpaid = totalUnpaid.plus(unpaid);
    if (bucket === "0-30") d0_30 = d0_30.plus(unpaid);
    else if (bucket === "31-60") d31_60 = d31_60.plus(unpaid);
    else if (bucket === "61-90") d61_90 = d61_90.plus(unpaid);
    else d91p = d91p.plus(unpaid);
    return {
      id: Number(r.id),
      number: String(r.number ?? `#${r.id}`),
      partyName: String(r.partyName ?? "—"),
      date: String(r.date ?? ""),
      dueDate: r.dueDate ? String(r.dueDate) : null,
      daysOverdue,
      bucket,
      unpaid: toDbMoney(unpaid),
    };
  });

  return {
    rows,
    totals: {
      count: rows.length,
      unpaid: toDbMoney(totalUnpaid),
      d0_30: toDbMoney(d0_30),
      d31_60: toDbMoney(d31_60),
      d61_90: toDbMoney(d61_90),
      d91p: toDbMoney(d91p),
    },
  };
}
