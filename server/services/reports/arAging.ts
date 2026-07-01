// تقارير مالية للقراءة فقط:
//  - getARAging: شيخوخة الذمم المدينة لكل العملاء، بدلاء 0-30/31-60/61-90/90+.
//  - getCustomerStatement: كشف حساب عميل (فواتير + دفعات + ملخّص).
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { accountingEntries, customers, invoices, receipts } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, sumMoney, toDbMoney } from "../money";
import { nextDayStr, type StatementPeriod } from "./shared";

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
  /** الفرق بين الرصيد الجاري والمجموع المُبوَّب (OPENING/سندات مستقلّة خارج دلاء الفواتير، مُوقَّع).
   *  ⇒ d0_30+d31_60+d61_90+d91p + unbucketed === currentBalance (يتّزن دائماً). */
  unbucketed: string;
  oldestInvoiceDate: string | null;
}

/** AR aging — buckets per customer. Filters: optional branchId.
 *  تُعمَّر الدلاء من **تاريخ الاستحقاق إن وُجد** (`COALESCE(dueDate, invoiceDate)`): فالبيع الآجل
 *  للشركات/الدوائر يُعمَّر من موعد استحقاقه الحقيقي، والفواتير بلا استحقاق تبقى على تاريخ الفاتورة
 *  (متوافق رجعياً). */
export async function getARAging(opts: { branchId?: number; limit?: number } = {}): Promise<ARAgingRow[]> {
  const db = getDb();
  if (!db) return [];
  const branchFilter = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  // G13 (١٩/٦/٢٦): LIMIT حارس ضدّ OOM عند تحميل عشرات الآلاف من العملاء في الذاكرة.
  // ORDER BY unpaidTotal DESC ⇒ أكبر الذمم أولاً (المطلوبة فعلياً في المتابعة).
  // ٥٠٠٠ افتراضياً يفوق سقف عملاء أي متجر منفرد، لكن يمنع تسارع الفشل عند نموّ الجدول.
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 10000));
  // REP-03 (تدقيق ٢٠/٦): مرساة «اليوم» = UTC_DATE() لا CURDATE(). invoiceDate عمود timestamp
  // مخزَّن بـUTC، وdueDate عمود DATE بلا منطقة زمنية؛ CURDATE() يعطي تاريخ خادم MySQL المحلّي ⇒
  // عند حدّ اليوم ينزاح فرق الأيام يوماً واحداً فتقع الفاتورة في دلو خاطئ. UTC_DATE() يوحّد
  // الأساس مع DATE() للطابع الزمني المخزَّن بـUTC (وdueDate الـDATE يُحاذى عليه أيضاً بلا تحويل).
  // حدود الدلاء (<=30 / 31-60 / 61-90 / >90) تبقى كما هي.
  const rows = await db.execute(sql`
    SELECT
      c.id AS customerId,
      c.name AS customerName,
      c.phone,
      c.customerType,
      CAST(c.currentBalance AS CHAR) AS currentBalance,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) <= 30 THEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) ELSE 0 END), 0) AS CHAR) AS d0_30,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) BETWEEN 31 AND 60 THEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) ELSE 0 END), 0) AS CHAR) AS d31_60,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) BETWEEN 61 AND 90 THEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) ELSE 0 END), 0) AS CHAR) AS d61_90,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate))) > 90 THEN GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) ELSE 0 END), 0) AS CHAR) AS d91p,
      CAST(COALESCE(SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0) AS CHAR) AS unpaidTotal,
      DATE_FORMAT(MIN(CASE WHEN i.invoiceStatus IN ('PENDING','PARTIALLY_PAID') THEN DATE(COALESCE(i.dueDate, i.invoiceDate)) END), '%Y-%m-%d') AS oldestInvoiceDate
    FROM customers c
    LEFT JOIN invoices i
      ON i.customerId = c.id
      AND i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
      ${branchFilter}
    WHERE c.isActive = TRUE
    GROUP BY c.id, c.name, c.phone, c.customerType, c.currentBalance
    HAVING unpaidTotal > 0 OR c.currentBalance > 0
    ORDER BY unpaidTotal DESC, c.currentBalance DESC
    LIMIT ${limit}
  `);
  const data = (rows as any)[0] ?? rows;
  if (!Array.isArray(data)) return [];
  // REP-04: الدلاء تُعمَّر من الفواتير المستحقّة فقط؛ الرصيد الافتتاحي (OPENING) والسندات المستقلّة
  // تقع خارجها ⇒ unbucketed = currentBalance − unpaidTotal (مُوقَّع، بلا قصّ) يُغلق الفرق فتتّزن
  // الدلاء مع الرصيد الجاري. بدقّة decimal (§٥).
  return (data as any[]).map((r) => ({
    ...(r as ARAgingRow),
    unbucketed: toDbMoney(money(r.currentBalance).sub(money(r.unpaidTotal))),
  }));
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
  /** سند مستقل (B1): receipt بلا فاتورة بل بطرف partyType=CUSTOMER — دفعة على الحساب/استرداد. */
  isStandalone: boolean;
  voucherNumber: string | null;
  description: string | null;
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
    /** الرصيد المُرحَّل: قيد OPENING المستورد + (مع from) كل النشاط السابق للفترة. */
    openingBalance: string;
  };
}

/** شرط «دفعات هذا العميل»: receipts مرتبطة بفواتيره (عبر join) **أو** سندات مستقلّة
 *  (بلا invoiceId، partyType=CUSTOMER) — إصلاح علّة: السندات المستقلّة كانت غائبة عن الكشف
 *  فيظهر الرصيد الجاري «منحرفاً» بلا تفسير في الحركة المعروضة. */
function customerPaymentLink(customerId: number) {
  return or(
    eq(invoices.customerId, customerId),
    and(isNull(receipts.invoiceId), eq(receipts.partyType, "CUSTOMER"), eq(receipts.partyId, customerId))
  );
}

/**
 * الرصيد المُرحَّل لعميل:
 *  - دائماً: مجموع قيود OPENING (ترسيخ الرصيد الافتتاحي المستورد — import-integration).
 *  - مع from: + مجموع فواتيره الملتزمة قبل from (CANCELLED مُستثناة — التزامها أُلغي، كما في reconcile)
 *             − صافي دفعاته قبل from (IN ينقص ذمته، OUT يزيدها؛ COMPLETED فقط — REVERSED أثره معكوس).
 * كل الجمع بدقّة decimal (§٥).
 */
async function customerOpeningBalance(customerId: number, from?: string) {
  const db = getDb()!;
  const openRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
    .from(accountingEntries)
    .where(and(eq(accountingEntries.entryType, "OPENING"), eq(accountingEntries.customerId, customerId)));
  let opening = money(openRow[0]?.v ?? 0);
  if (!from) return opening;

  const fromTs = `${from} 00:00:00`;
  const invRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${invoices.total} AS DECIMAL(15,2))), 0)` })
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        ne(invoices.status, "CANCELLED"),
        sql`${invoices.invoiceDate} < ${fromTs}`
      )
    );
  const payRow = await db
    .select({
      v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN CAST(${receipts.amount} AS DECIMAL(15,2)) ELSE -CAST(${receipts.amount} AS DECIMAL(15,2)) END), 0)`,
    })
    .from(receipts)
    .leftJoin(invoices, eq(receipts.invoiceId, invoices.id))
    .where(
      and(
        customerPaymentLink(customerId),
        eq(receipts.status, "COMPLETED"),
        sql`${receipts.createdAt} < ${fromTs}`
      )
    );
  return opening.plus(money(invRow[0]?.v ?? 0)).minus(money(payRow[0]?.v ?? 0));
}

/** Customer account statement: invoices + payments + running summary.
 *  مع فترة اختيارية: الفواتير على invoiceDate والدفعات على createdAt ضمن [from، to+يوم)،
 *  والملخّص يعكس مستندات الفترة المعروضة. بلا فترة = السلوك القديم نفسه. */
export async function getCustomerStatement(
  customerId: number,
  period: StatementPeriod = {}
): Promise<CustomerStatementResult | null> {
  const db = getDb();
  if (!db) return null;
  const c = (await db.select().from(customers).where(eq(customers.id, customerId)).limit(1))[0];
  if (!c) return null;
  const { from, to, branchId } = period;

  const invConds = [eq(invoices.customerId, customerId)];
  if (from) invConds.push(sql`${invoices.invoiceDate} >= ${`${from} 00:00:00`}`);
  if (to) invConds.push(sql`${invoices.invoiceDate} < ${`${nextDayStr(to)} 00:00:00`}`);
  if (branchId) invConds.push(eq(invoices.branchId, branchId));
  const invs = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      returnedTotal: invoices.returnedTotal,
      status: invoices.status,
      sourceType: invoices.sourceType,
    })
    .from(invoices)
    .where(and(...invConds))
    .orderBy(desc(invoices.invoiceDate));

  // الدفعات تُفلتَر على تاريخها هي (createdAt) لا على فواتيرها: دفعةٌ داخل الفترة على
  // فاتورة أقدم منها يجب أن تظهر — هذا جوهر الدلالة المحاسبية للكشف بفترة.
  const payConds = [customerPaymentLink(customerId)];
  if (from) payConds.push(sql`${receipts.createdAt} >= ${`${from} 00:00:00`}`);
  if (to) payConds.push(sql`${receipts.createdAt} < ${`${nextDayStr(to)} 00:00:00`}`);
  const payments = await db
    .select({
      id: receipts.id,
      invoiceId: receipts.invoiceId,
      direction: receipts.direction,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      status: receipts.status,
      createdAt: receipts.createdAt,
      voucherNumber: receipts.voucherNumber,
      description: receipts.description,
    })
    .from(receipts)
    .leftJoin(invoices, eq(receipts.invoiceId, invoices.id))
    .where(and(...payConds))
    .orderBy(asc(receipts.createdAt), asc(receipts.id));

  const openingBalance = await customerOpeningBalance(customerId, from);

  // أموال بدقّة decimal.js (§٥) — لا Number/toFixed على الأموال.
  // REP-01: الإجماليات المالية تُحسَب على غير الملغاة فقط، اتّساقاً مع customerOpeningBalance الذي
  // يستثني CANCELLED (التزامها أُلغي) ⇒ totalSales/totalPaid لا يخالفان الرصيد المُرحَّل. الصفوف
  // المعروضة تبقى شاملةً كل الفواتير (بما فيها CANCELLED) للعرض. لا يُطرَح RETURNED من totalSales.
  const nonCancelled = invs.filter((i) => i.status !== "CANCELLED");
  const totalSales = sumMoney(nonCancelled.map((i) => i.total ?? 0));
  const totalPaid = sumMoney(nonCancelled.map((i) => i.paidAmount ?? 0));
  // REP-06: المتبقّي على الفاتورة المستحقّة = total − paidAmount − returnedTotal (مقصوص ≥ 0)؛
  // إغفال returnedTotal كان يضخّم المتبقّي بعد مرتجع جزئي على فاتورة آجلة.
  const unpaid = sumMoney(
    invs
      .filter((i) => i.status === "PENDING" || i.status === "PARTIALLY_PAID")
      .map((i) => {
        const d = money(i.total ?? 0).sub(money(i.paidAmount ?? 0)).sub(money(i.returnedTotal ?? 0));
        return d.isNegative() ? money(0) : d;
      })
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
      isStandalone: p.invoiceId == null,
      voucherNumber: p.voucherNumber ? String(p.voucherNumber) : null,
      description: p.description ? String(p.description) : null,
    })),
    summary: {
      totalSales: toDbMoney(totalSales),
      totalPaid: toDbMoney(totalPaid),
      unpaid: toDbMoney(unpaid),
      currentBalance: String(c.currentBalance ?? "0"),
      openingBalance: toDbMoney(openingBalance),
    },
  };
}
