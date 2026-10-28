// تفصيل أعمار الذمم (للقراءة فقط) — فاتورةً-بفاتورة (AR) / أمرَ-شراء-بأمر (AP).
// يكمّل تقريرَي الملخّص getARAging/getAPAging في reportsService.ts: نفس الفلاتر والشرائح
// العمرية تماماً، لكن **سرد المستندات المنفردة** بدل التجميع على الطرف ⇒ المحاسب يرى أيّ فاتورة
// تحديداً تأخّرت لا مجموع العميل فقط.
//
// النمط (راجع reportsFinancialService.ts + [[raw-sql-column-names]]):
//   - SQL خام بأسماء أعمدة DB الفعلية: invoices.status ⇒ العمود `invoiceStatus`،
//     purchaseOrders.status ⇒ العمود `poStatus` (التحقّق في drizzle/schema.ts).
//   - الأموال تُعاد نصوصاً (CAST AS CHAR) لتمرّ عبر decimal.js بلا فقد دقّة.
//   - الشرائح بـDATEDIFF(UTC_DATE(), …) لا CURDATE() — مرآة REP-03 في الملخّص:
//     الأعمدة مخزّنة بـUTC، وCURDATE() يعطي تاريخ خادم MySQL المحلّي فينزاح الدلو يوماً.
//     (كان هذا السطر يقول CURDATE() وهو وصفٌ متقادمٌ للشيفرة أدناه.)
//   - المتبقّي/فاتورة AR = مسند «الرصيد المفتوح» المقصوص من `@shared/predicates/openBalance`
//     (وضع `COLLECTIBLE`) — لا مكتوباً بيدٍ هنا.
//   - المتبقّي/أمر AP لا يستعمل ذلك المسند أصلاً: مصدرُه رصيدُ دفتر الأستاذ لكلّ أمر
//     (`gl.balance` المصفّى من `accountingEntries`) لأنّ `purchaseOrders` بلا `returnedTotal`.
//     (كان هذا السطر يقول `GREATEST(total - paidAmount, 0)` وهو وصفٌ متقادمٌ للشيفرة أدناه.)
import { and, inArray, sql } from "drizzle-orm";
import { openBalanceExpr } from "@shared/predicates/openBalance";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";
import { purchaseOrders } from "../../drizzle/schema";
import { getARAging, arAgingDocumentsSql } from "./reports/arAging";
import { getAPAging } from "./reports/apAging";
import { loadPurchaseSettlements } from "./purchase/settlementProjection";
import {
  isSupplierApLedgerEntrySql,
  isSupplierApRecognitionSql,
  supplierApEffectSql,
} from "./ledger/supplierApEffect";

/** أعمدة القيد بالاسم المستعار `ae` (SQL خام) — أثر AP الموحَّد: القديم PURCHASE + الحديث GRNI. */
const AE = {
  entryType: sql`ae.entryType`,
  amount: sql`ae.amount`,
  liabilityAccount: sql`ae.purchaseLiabilityAccount`,
  dedupeKey: sql`ae.dedupeKey`,
} as const;

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
  documentType: "INVOICE" | "FULFILLMENT_CHARGE" | "PURCHASE_ORDER";
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
    /** Display-only FIFO offsets; source invoice balances and BOOK allocations are unchanged. */
    unallocatedCredit: string;
    documentUnpaid: string;
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
    totals: { count: 0, unpaid: "0", d0_30: "0", d31_60: "0", d61_90: "0", d91p: "0", unallocatedCredit: "0", documentUnpaid: "0" },
  };
  const db = getDb();
  if (!db) return empty;

  const isAR = opts.side === "AR";
  const branchId = opts.branchId;
  // مسند AR الواحد (موضعان: عمود `unpaid` وشرط الاستبعاد `> 0`) — كتابتُه مرّتين في استعلامٍ
  // واحد هي بعينها الطريقة التي ينحرف بها العمودُ عن فلترِه فتظهر صفوفٌ بمتبقٍّ صفر.
  const openBalance = openBalanceExpr(
    { total: sql`i.total`, paidAmount: sql`i.paidAmount`, returnedTotal: sql`i.returnedTotal` },
    "COLLECTIBLE",
  );

  const raw = isAR
    ? rowsOf(
        await db.execute(sql`
          SELECT
            i.id AS id,
            i.number AS number,
            i.customerId AS partyId,
            i.documentType AS documentType,
            c.name AS partyName,
            DATE_FORMAT(i.invoiceDate, '%Y-%m-%d') AS date,
            DATE_FORMAT(i.dueDate, '%Y-%m-%d') AS dueDate,
            DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) AS daysOverdue,
            CAST(${openBalance} AS CHAR) AS unpaid
          FROM (${arAgingDocumentsSql()}) i
          LEFT JOIN customers c ON c.id = i.customerId
          WHERE i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
            AND ${openBalance} > 0
            ${branchId ? sql`AND i.branchId = ${branchId}` : sql``}
          ORDER BY daysOverdue DESC, i.id DESC
        `),
      )
    : rowsOf(
        await db.execute(sql`
          SELECT
            po.id AS id,
            po.poNumber AS number,
            po.supplierId AS partyId,
            'PURCHASE_ORDER' AS documentType,
            s.name AS partyName,
            DATE_FORMAT(gl.recognitionDate, '%Y-%m-%d') AS date,
            NULL AS dueDate,
            DATEDIFF(UTC_DATE(), DATE(gl.recognitionDate)) AS daysOverdue,
            CAST(GREATEST(COALESCE(gl.balance, 0), 0) AS CHAR) AS unpaid
          FROM purchaseOrders po
          LEFT JOIN suppliers s ON s.id = po.supplierId
          LEFT JOIN (
            SELECT ae.purchaseOrderId,
              MIN(CASE WHEN ${isSupplierApRecognitionSql(AE)} THEN ae.entryDate END) AS recognitionDate,
              COALESCE(SUM(${supplierApEffectSql(AE, { includeOpening: false })}), 0) AS balance
            FROM accountingEntries ae
            WHERE ae.purchaseOrderId IS NOT NULL
              AND ae.supplierId IS NOT NULL
              AND ${isSupplierApLedgerEntrySql(AE, { includeOpening: false })}
            GROUP BY ae.purchaseOrderId
          ) gl ON gl.purchaseOrderId = po.id
          WHERE po.poStatus IN ('CONFIRMED', 'RECEIVED')
            AND GREATEST(COALESCE(gl.balance, 0), 0) > 0
            ${branchId ? sql`AND po.branchId = ${branchId}` : sql``}
          ORDER BY daysOverdue DESC, po.id DESC
        `),
      );

  // BOOK allocations deliberately preserve original ledger rows. Read the same
  // settlement projection used by AP summary rather than inventing new payments.
  if (!isAR && raw.length) {
    const orders = await db.select().from(purchaseOrders).where(and(
      inArray(purchaseOrders.id, raw.map(r => Number(r.id))),
      sql`EXISTS (SELECT 1 FROM supplierBookSettlementSources book
        WHERE book.supplierId = ${purchaseOrders.supplierId}
          ${branchId ? sql`AND book.branchId = ${branchId}` : sql``})`,
    ));
    const projection = await loadPurchaseSettlements(db, orders);
    for (const row of raw) {
      const settled = projection.get(Number(row.id));
      if (settled) row.unpaid = settled.remainingAmountIqd;
    }
  }

  // Summary owns the existing net/FIFO presentation of unallocated credits.
  // Cap each party/bucket to that same view, preserving document identity and
  // removing the oldest amounts first. This changes reporting only, not allocation.
  const summaries = isAR
    ? await getARAging({ branchId, limit: null })
    : await getAPAging({ branchId, limit: null });
  const caps = new Map(summaries.map(row => [
    "customerId" in row ? row.customerId : row.supplierId,
    row,
  ]));
  const documentUnpaid = raw.reduce((sum, row) => sum.plus(money(row.unpaid)), money(0));
  const grouped = new Map<string, typeof raw>();
  for (const row of raw) {
    const key = `${row.partyId}:${bucketOf(Number(row.daysOverdue ?? 0))}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  for (const rows of Array.from(grouped.values())) {
    const first = rows[0];
    const summary = caps.get(Number(first.partyId));
    const bucket = bucketOf(Number(first.daysOverdue ?? 0));
    const field = bucket === "0-30" ? "d0_30" : bucket === "31-60" ? "d31_60" : bucket === "61-90" ? "d61_90" : "d91p";
    const cap = money(summary?.[field] ?? 0);
    let excess = rows.reduce((total, row) => total.plus(money(row.unpaid)), money(0)).minus(cap);
    for (const row of rows) {
      if (excess.lte(0)) break;
      const amount = money(row.unpaid);
      const deduction = amount.lessThan(excess) ? amount : excess;
      row.unpaid = toDbMoney(amount.minus(deduction));
      excess = excess.minus(deduction);
    }
  }

  // أموال بدقّة decimal.js (§٥) — لا Number/parseFloat على المال.
  let totalUnpaid = money(0);
  let d0_30 = money(0);
  let d31_60 = money(0);
  let d61_90 = money(0);
  let d91p = money(0);

  const rows: AgingDetailRow[] = raw.filter(r => money(r.unpaid).gt(0)).map((r) => {
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
      documentType: r.documentType as AgingDetailRow["documentType"],
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
      documentUnpaid: toDbMoney(documentUnpaid),
      unallocatedCredit: toDbMoney(documentUnpaid.minus(totalUnpaid)),
    },
  };
}
