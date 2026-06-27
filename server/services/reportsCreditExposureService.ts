// خدمة التعرّض الائتماني للعملاء (للقراءة فقط) — تُغذّي تقرير «التعرّض الائتماني» وتنبيه الخطر في الكوكبِت.
//
// تجيب على سؤال البيع الآجل: من أعطيه آجلاً؟ من أوقف عنه؟ من يحتاج اتصال تحصيل؟
// تجمع من جداول موجودة (بلا جدول جديد):
//  • customers.currentBalance/creditLimit — الرصيد الجاري وحدّ الائتمان.
//  • invoices (PENDING/PARTIALLY_PAID) — شرائح الأعمار + أعلى فاتورة غير مسدّدة + أقدم استحقاق.
//  • receipts (IN COMPLETED) — تاريخ آخر دفعة (سند مرتبط بفاتورة أو سند مستقلّ partyType=CUSTOMER).
//
// ⚠️ أسماء أعمدة DB الخام: invoices.invoiceStatus · receipts.receiptStatus/voucherPartyType.
// مرساة «اليوم» UTC_DATE() (نظير getARAging — تفادي انزياح المنطقة الزمنية). كل الأموال بـdecimal (§٥).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

export type CreditRisk = "high" | "medium" | "low";

export interface CreditExposureRow {
  customerId: number;
  customerName: string;
  phone: string | null;
  customerType: string | null;
  /** الرصيد الجاري (موجب = مدين لنا). */
  currentBalance: string;
  /** حدّ الائتمان إن وُجد (NULL = غير محدّد). */
  creditLimit: string | null;
  /** المتأخّر من الرصيد (فواتير تجاوزت ٣٠ يوماً: 31-60 + 61-90 + 90+). */
  overdueAmount: string;
  /** أعلى فاتورة غير مسدّدة (المتبقّي عليها). */
  highestUnpaid: string;
  /** أقصى أيام تأخّر على أقدم فاتورة مستحقّة (0 إن لا تأخّر). */
  daysOverdue: number;
  /** تاريخ آخر دفعة (YYYY-MM-DD) أو null. */
  lastPaymentDate: string | null;
  /** الائتمان المتاح = الحدّ − الرصيد (null إن لا حدّ). */
  availableCredit: string | null;
  /** نسبة استخدام الحدّ % (null إن لا حدّ). */
  utilizationPct: number | null;
  /** تجاوز الحدّ؟ */
  overLimit: boolean;
  /** مبلغ التجاوز (0 إن لا تجاوز). */
  overLimitAmount: string;
  /** تصنيف الخطر. */
  risk: CreditRisk;
}

export interface CreditExposureResult {
  rows: CreditExposureRow[];
  summary: {
    /** عدد العملاء المدينين. */
    customers: number;
    /** إجمالي التعرّض (مجموع الأرصدة الموجبة). */
    totalExposure: string;
    /** إجمالي المتأخّر (+٣٠ يوم). */
    totalOverdue: string;
    /** عدد المتجاوزين للحدّ. */
    overLimitCount: number;
    /** إجمالي مبالغ التجاوز. */
    overLimitAmount: string;
    /** عدد عالي الخطورة. */
    highRiskCount: number;
  };
}

/**
 * التعرّض الائتماني لكل عميل مدين. الفرع يُصفّي شرائح الفواتير (نظير getARAging)؛ الرصيد الجاري
 * عالميّ على العميل. التصنيف:
 *  - high  : تجاوز الحدّ، أو وجود ذمم +٩٠ يوم.
 *  - medium: ذمم ٦١–٩٠ يوم، أو استخدام >٨٠٪ من الحدّ.
 *  - low   : غير ذلك.
 */
export async function getCreditExposure(opts: { branchId?: number; limit?: number } = {}): Promise<CreditExposureResult> {
  const empty: CreditExposureResult = {
    rows: [],
    summary: { customers: 0, totalExposure: "0", totalOverdue: "0", overLimitCount: 0, overLimitAmount: "0", highRiskCount: 0 },
  };
  const db = getDb();
  if (!db) return empty;

  const branchFilter = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 10000));

  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        c.id AS customerId,
        c.name AS customerName,
        c.phone,
        c.customerType,
        CAST(c.currentBalance AS CHAR) AS currentBalance,
        CASE WHEN c.creditLimit IS NULL THEN NULL ELSE CAST(c.creditLimit AS CHAR) END AS creditLimit,
        CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) BETWEEN 31 AND 60 THEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) ELSE 0 END), 0) AS CHAR) AS d31_60,
        CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) BETWEEN 61 AND 90 THEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) ELSE 0 END), 0) AS CHAR) AS d61_90,
        CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) > 90 THEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) ELSE 0 END), 0) AS CHAR) AS d91p,
        CAST(COALESCE(MAX(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0) AS CHAR) AS highestUnpaid,
        COALESCE(MAX(CASE WHEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) > 0 THEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) END), 0) AS daysOverdue
      FROM customers c
      LEFT JOIN invoices i
        ON i.customerId = c.id
        AND i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
        ${branchFilter}
      WHERE c.isActive = TRUE
      GROUP BY c.id, c.name, c.phone, c.customerType, c.currentBalance, c.creditLimit
      HAVING c.currentBalance > 0 OR SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)) > 0
      ORDER BY c.currentBalance DESC
      LIMIT ${limit}
    `),
  );

  // آخر دفعة لكل عميل: receipts IN COMPLETED — مرتبطة بفاتورته (عبر invoiceId→customerId) أو سند مستقلّ.
  const payRows = rowsOf(
    await db.execute(sql`
      SELECT cid, DATE_FORMAT(MAX(createdAt), '%Y-%m-%d') AS lastPaymentDate
      FROM (
        SELECT COALESCE(iv.customerId, r.partyId) AS cid, r.createdAt
        FROM receipts r
        LEFT JOIN invoices iv ON iv.id = r.invoiceId
        WHERE r.direction = 'IN' AND r.receiptStatus = 'COMPLETED'
          AND (iv.customerId IS NOT NULL OR (r.voucherPartyType = 'CUSTOMER' AND r.partyId IS NOT NULL))
      ) t
      WHERE cid IS NOT NULL
      GROUP BY cid
    `),
  );
  const lastPayBy = new Map<number, string>();
  for (const p of payRows) lastPayBy.set(Number(p.cid), p.lastPaymentDate ?? null);

  let totalExposure = money(0);
  let totalOverdue = money(0);
  let overLimitAmount = money(0);
  let overLimitCount = 0;
  let highRiskCount = 0;

  const rows: CreditExposureRow[] = raw.map((r) => {
    const balance = money(r.currentBalance ?? 0);
    const limitVal = r.creditLimit == null ? null : money(r.creditLimit);
    const overdue = money(r.d31_60 ?? 0).add(money(r.d61_90 ?? 0)).add(money(r.d91p ?? 0));
    const d91p = money(r.d91p ?? 0);
    const d61_90 = money(r.d61_90 ?? 0);
    const days = Number(r.daysOverdue ?? 0) || 0;

    const overLimit = !!limitVal && limitVal.greaterThan(0) && balance.greaterThan(limitVal);
    const overAmt = overLimit && limitVal ? balance.sub(limitVal) : money(0);
    const available = limitVal ? limitVal.sub(balance) : null;
    const utilizationPct =
      limitVal && limitVal.greaterThan(0)
        ? Number(balance.div(limitVal).times(100).toDecimalPlaces(1))
        : null;

    let risk: CreditRisk = "low";
    if (overLimit || d91p.greaterThan(0)) risk = "high";
    else if (d61_90.greaterThan(0) || (utilizationPct != null && utilizationPct > 80)) risk = "medium";

    if (balance.greaterThan(0)) totalExposure = totalExposure.add(balance);
    totalOverdue = totalOverdue.add(overdue);
    if (overLimit) { overLimitCount++; overLimitAmount = overLimitAmount.add(overAmt); }
    if (risk === "high") highRiskCount++;

    return {
      customerId: Number(r.customerId),
      customerName: String(r.customerName ?? "—"),
      phone: r.phone ?? null,
      customerType: r.customerType ?? null,
      currentBalance: toDbMoney(balance),
      creditLimit: limitVal ? toDbMoney(limitVal) : null,
      overdueAmount: toDbMoney(overdue),
      highestUnpaid: toDbMoney(money(r.highestUnpaid ?? 0)),
      daysOverdue: days,
      lastPaymentDate: lastPayBy.get(Number(r.customerId)) ?? null,
      availableCredit: available ? toDbMoney(available) : null,
      utilizationPct,
      overLimit,
      overLimitAmount: toDbMoney(overAmt),
      risk,
    };
  });

  // ترتيب: الخطر الأعلى أولاً، ثم الأكبر رصيداً.
  const riskOrder: Record<CreditRisk, number> = { high: 0, medium: 1, low: 2 };
  rows.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || Number(money(b.currentBalance).sub(money(a.currentBalance))));

  return {
    rows,
    summary: {
      customers: rows.length,
      totalExposure: toDbMoney(totalExposure),
      totalOverdue: toDbMoney(totalOverdue),
      overLimitCount,
      overLimitAmount: toDbMoney(overLimitAmount),
      highRiskCount,
    },
  };
}
