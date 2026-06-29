import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
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

/** فترة كشف الحساب — نصوص YYYY-MM-DD اختيارية. النطاق على المستندات [from، to+يوم). */
export interface StatementPeriod {
  from?: string;
  to?: string;
  /** عزل الفرع (RPT-01/02): مدير الفرع يرى فواتير فرعه فقط؛ admin بلا قيد. */
  branchId?: number;
}

/** اليوم التالي YYYY-MM-DD — حدّ أعلى **حصري** على أعمدة timestamp يشمل كامل يوم `to`
 *  بلا حِيَل 23:59:59.999. الحساب بـUTC ⇒ لا انزياح منطقة زمنية. */
function nextDayStr(ymd: string): string {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

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
  /** الفرق بين الرصيد الجاري والمجموع المُبوَّب (OPENING/شراء أصول خارج دلاء أوامر الشراء، مُوقَّع).
   *  ⇒ d0_30+d31_60+d61_90+d91p + unbucketed === currentBalance (يتّزن دائماً). */
  unbucketed: string;
  oldestPoDate: string | null;
}

/**
 * AP aging — buckets per supplier على أوامر الشراء المستحقّة.
 * DRAFT/SENT لم تُلتزَم مالياً ⇒ تُستبعد؛ CANCELLED تُستبعد؛
 * CONFIRMED/RECEIVED حيث total > paidAmount = مستحق.
 */
export async function getAPAging(opts: { branchId?: number; limit?: number } = {}): Promise<APAgingRow[]> {
  const db = getDb();
  if (!db) return [];
  const branchFilter = opts.branchId ? sql`AND po.branchId = ${opts.branchId}` : sql``;
  // G13: نفس حارس LIMIT في AR aging — يمنع OOM عند نمو الموردين.
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 10000));
  // REP-03: مرساة «اليوم» = UTC_DATE() لا CURDATE() (نفس علّة AR aging أعلاه). orderDate عمود
  // timestamp مخزَّن بـUTC ⇒ DATEDIFF(UTC_DATE(), DATE(po.orderDate)) يحسب الفرق على أساس UTC
  // واحد فلا ينزاح الدلو يوماً عند حدّ اليوم. الحدود ثابتة.
  const rows = await db.execute(sql`
    SELECT
      s.id AS supplierId,
      s.name AS supplierName,
      s.phone,
      CAST(s.currentBalance AS CHAR) AS currentBalance,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) <= 30 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d0_30,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) BETWEEN 31 AND 60 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d31_60,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) BETWEEN 61 AND 90 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d61_90,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) > 90 THEN GREATEST(po.total - po.paidAmount, 0) ELSE 0 END), 0) AS CHAR) AS d91p,
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
    LIMIT ${limit}
  `);
  const data = (rows as any)[0] ?? rows;
  if (!Array.isArray(data)) return [];
  // REP-04 mirror: شراء الأصول/الرصيد الافتتاحي (OPENING) يقعان في currentBalance خارج دلاء أوامر
  // الشراء ⇒ unbucketed = currentBalance − unpaidTotal (مُوقَّع، بلا قصّ) يُغلق الفرق فتتّزن الدلاء.
  return (data as any[]).map((r) => ({
    ...(r as APAgingRow),
    unbucketed: toDbMoney(money(r.currentBalance).sub(money(r.unpaidTotal))),
  }));
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
  /** نوع القيد: PAYMENT_OUT دفعة مورد، PAYMENT_IN استرداد، RETURN مرتجع شراء (إشارة سالبة)، PURCHASE شراء أصل. */
  entryType: string;
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
    /** الرصيد المُرحَّل: قيد OPENING المستورد + (مع from) مشتريات ملتزمة − دفعات قبل from. */
    openingBalance: string;
  };
}

/**
 * الرصيد المُرحَّل لمورد (AP، موجب = ندين له):
 *  - دائماً: مجموع قيود OPENING للمورد (الرصيد الافتتاحي المستورد).
 *  - مع from: + مشترياته الملتزمة قبل from (CONFIRMED/RECEIVED فقط — DRAFT/SENT/CANCELLED
 *    غير ملتزمة مالياً، كما في getAPAging/reconcile) − دفعات PAYMENT_OUT قبل from على entryDate.
 */
async function supplierOpeningBalance(supplierId: number, from?: string) {
  const db = getDb()!;
  const openRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
    .from(accountingEntries)
    .where(and(eq(accountingEntries.entryType, "OPENING"), eq(accountingEntries.supplierId, supplierId)));
  let opening = money(openRow[0]?.v ?? 0);
  if (!from) return opening;

  const poRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${purchaseOrders.total} AS DECIMAL(15,2))), 0)` })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.supplierId, supplierId),
        inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]),
        sql`${purchaseOrders.orderDate} < ${`${from} 00:00:00`}`
      )
    );
  // صافي تأثير القيود قبل الفترة على AP (مرآة reconcileSupplierBalances):
  //   PAYMENT_OUT يطرح، PAYMENT_IN يضيف (استرداد من مورد)، RETURN.amount مخزَّن سالباً فيطرح المرتجع.
  // كان نظير العميل (customerOpeningBalance) يضمّ الاتجاهين بصحّة، بينما المورد كان PAYMENT_OUT فقط
  // ⇒ كشف حساب لا يتّزن عند استرداد من مورد أو مرتجع شراء.
  // FI-01 (تكامل الأصول↔كشف المورد، تحقيق عدائي ٢٠/٦): اقتناء أصل على ذمّة المورد يُقيَّد PURCHASE
  // (بلا purchaseOrderId) ويَرفع currentBalance؛ كان الكشف يُعيد بناء AP من أوامر الشراء + الدفعات
  // فقط ⇒ شراء الأصل يَغيب فلا يتّزن الرصيد. نُدرج PURCHASE اليتيمة (purchaseOrderId IS NULL) موجبةً
  // على AP (شراء الأصول عبر PO تُحتسَب من purchaseOrders.total ⇒ لا ازدواج).
  const entriesRow = await db
    .select({
      v: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN'  THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'RETURN'      THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PURCHASE'    THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        sql`(${accountingEntries.entryType} IN ('PAYMENT_OUT','PAYMENT_IN','RETURN') OR (${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.purchaseOrderId} IS NULL))`,
        eq(accountingEntries.supplierId, supplierId),
        sql`${accountingEntries.entryDate} < ${from}`
      )
    );
  return opening.plus(money(poRow[0]?.v ?? 0)).plus(money(entriesRow[0]?.v ?? 0));
}

/** كشف حساب مورد: أوامر شراء + دفعات (من accountingEntries.PAYMENT_OUT) + ملخّص.
 *  مع فترة اختيارية: الأوامر على orderDate ضمن [from، to+يوم) والدفعات على entryDate
 *  (عمود date ⇒ ‎≤ to يكافئ < to+يوم). بلا فترة = السلوك القديم نفسه. */
export async function getSupplierStatement(
  supplierId: number,
  period: StatementPeriod = {}
): Promise<SupplierStatementResult | null> {
  const db = getDb();
  if (!db) return null;
  const s = (await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1))[0];
  if (!s) return null;
  const { from, to, branchId } = period;

  const poConds = [eq(purchaseOrders.supplierId, supplierId)];
  if (from) poConds.push(sql`${purchaseOrders.orderDate} >= ${`${from} 00:00:00`}`);
  if (to) poConds.push(sql`${purchaseOrders.orderDate} < ${`${nextDayStr(to)} 00:00:00`}`);
  if (branchId) poConds.push(eq(purchaseOrders.branchId, branchId));
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
    .where(and(...poConds))
    .orderBy(desc(purchaseOrders.orderDate));

  // كل حركات الدفتر المؤثّرة على AP المورد ضمن الفترة (PAYMENT_OUT/PAYMENT_IN/RETURN).
  // كان السابق PAYMENT_OUT فقط ⇒ استرداد المورد ومرتجع الشراء يغيبان عن الكشف فلا يتّزن
  // (الرصيد الجاري ≠ المُرحَّل + مشتريات الفترة − دفعات الفترة المعروضة). الفلترة على تاريخ القيد
  // نفسه: حركة داخل الفترة على أمر أقدم تظهر (الدلالة المحاسبية).
  // FI-01: تشمل الحركة شراء الأصول اليتيم (PURCHASE بلا purchaseOrderId) ليَظهر في الكشف ويتّزن
  // الرصيد مع currentBalance؛ شراء PO يُعرَض من purchaseOrders أعلاه ⇒ نَستثنيه هنا (لا ازدواج).
  const payConds = [
    sql`(${accountingEntries.entryType} IN ('PAYMENT_OUT','PAYMENT_IN','RETURN') OR (${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.purchaseOrderId} IS NULL))`,
    eq(accountingEntries.supplierId, supplierId),
  ];
  if (from) payConds.push(sql`${accountingEntries.entryDate} >= ${from}`);
  if (to) payConds.push(sql`${accountingEntries.entryDate} <= ${to}`);
  const payments = await db
    .select({
      id: accountingEntries.id,
      entryType: accountingEntries.entryType,
      purchaseOrderId: accountingEntries.purchaseOrderId,
      receiptId: accountingEntries.receiptId,
      amount: accountingEntries.amount,
      entryDate: accountingEntries.entryDate,
      notes: accountingEntries.notes,
    })
    .from(accountingEntries)
    .where(and(...payConds))
    .orderBy(asc(accountingEntries.entryDate), asc(accountingEntries.id));

  const openingBalance = await supplierOpeningBalance(supplierId, from);

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
      // entryType جديد: تميّز الواجهة بين دفعة مورد (PAYMENT_OUT)، استرداد من مورد (PAYMENT_IN)،
      // ومرتجع شراء (RETURN، مخزَّن بإشارة سالبة) — لكي يقرأ المحاسب الكشف بإشارته الصحيحة.
      entryType: p.entryType,
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
      openingBalance: toDbMoney(openingBalance),
    },
  };
}

/* ============================ مقاييس لوحة التحكم ============================ */

export interface DashboardMetricsResult {
  lowStockCount: number;
  overdueAR: { count: number; total: string };
}

/**
 * مقاييس البطاقتين المعطّلتين في Dashboard.MetricsBar:
 *  - lowStockCount: متغيّرات تحت minStock (minStock>0) ضمن الفرع المُحدَّد (أو الكل إن null).
 *  - overdueAR: عدد ومجموع المتبقّي على فواتير PENDING/PARTIALLY_PAID أعمارها > ٣٠ يوماً.
 * لا تطبّق صلاحيات/عزل فرع هنا — يقع ذلك على المستدعي (الراوتر) قبل تمرير `branchId`.
 */
export async function getDashboardMetrics(
  opts: { branchId?: number | null } = {}
): Promise<DashboardMetricsResult> {
  const db = getDb();
  if (!db) {
    return { lowStockCount: 0, overdueAR: { count: 0, total: toDbMoney(money(0)) } };
  }
  const branchId = opts.branchId ?? null;
  const branchFilterStock = branchId == null ? sql`` : sql`AND bs.branchId = ${branchId}`;
  const branchFilterInv = branchId == null ? sql`` : sql`AND i.branchId = ${branchId}`;

  const lowRows = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM branchStock bs
    INNER JOIN productVariants v ON v.id = bs.variantId
    WHERE v.minStock > 0
      AND bs.quantity <= v.minStock
      AND v.isActive = TRUE
      ${branchFilterStock}
  `);
  const lowData = (lowRows as any)[0] ?? lowRows;
  const lowStockCount = Number(
    (Array.isArray(lowData) ? lowData[0]?.c : 0) ?? 0
  );

  const arRows = await db.execute(sql`
    SELECT
      COUNT(*) AS c,
      CAST(COALESCE(SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0) AS CHAR) AS t
    FROM invoices i
    WHERE i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
      -- S2 (٢٩/٦/٢٦): مطابق DATEDIFF(NOW(),invoiceDate)>30 تماماً (DATEDIFF يتجاهل الوقت، TZ=UTC) لكنه قابل للفهرسة.
      AND i.invoiceDate < DATE_SUB(UTC_DATE(), INTERVAL 30 DAY)
      ${branchFilterInv}
  `);
  const arData = (arRows as any)[0] ?? arRows;
  const arRow = Array.isArray(arData) ? arData[0] : null;

  return {
    lowStockCount,
    overdueAR: {
      count: Number(arRow?.c ?? 0),
      total: toDbMoney(money(arRow?.t ?? 0)),
    },
  };
}

/* ============================ تقارير المبيعات التحليلية ============================ */
//
// النمط: SQL خام بأسماء أعمدة DB الفعلية (راجع [[raw-sql-column-names]]):
//   - invoices.invoiceStatus (لا status)؛ استبعد CANCELLED/RETURNED من إجماليات المبيعات.
//   - invoiceItems.baseQuantity جاهز بالوحدة الأساس ⇒ لا حاجة لحساب quantity×conversionFactor.
//   - الكمية: تخصم returnedBaseQuantity للحصول على صافي البيع (ما بقي مع العميل).
//   - التكلفة (COGS): تخصم returnedRestockedBaseQuantity فقط (المُعاد للرفّ) ⇒ التالف يبقى خسارةً مطابِقةً للدفتر.
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
      CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
      CAST(COALESCE(SUM(ii.total) - SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS profit,
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
      CAST(COALESCE(SUM(ii.total), 0) AS CHAR) AS revenue,
      CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
      CAST(COALESCE(SUM(ii.total) - SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS profit,
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

/* ============== تقرير WIP (Work-in-Progress) ==============
 *
 * المواد المستهلَكة في أوامر شغل IN_PROGRESS/READY ليست بعد ضمن SALE.cost
 * (يصل عند DELIVERED). تقرير WIP يعرض القيمة المعلَّقة بنياً لا محاسبياً.
 * يُستخدم في الميزانية: قيمة المخزون الحقيقية = branchStock + WIP.
 *
 * المرحلة ٦ (١٩/٦/٢٦): جعل WIP مرئياً يعالج بند «WIP غير معلَن» في جدول المخاطر.
 */
export interface WIPRow {
  workOrderId: number;
  orderNumber: string;
  branchId: number | null;
  customerId: number | null;
  customerName: string | null;
  status: "IN_PROGRESS" | "READY";
  materialsCost: string; // decimal
  createdAt: Date;
}

export interface WIPReport {
  rows: WIPRow[];
  totalCount: number;
  totalMaterialsCost: string; // مجموع الـmaterialsCost بـDecimal
}

export async function getWIPReport(opts: { branchId?: number; limit?: number } = {}): Promise<WIPReport> {
  const db = getDb();
  if (!db) return { rows: [], totalCount: 0, totalMaterialsCost: "0.00" };
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const { workOrders } = await import("../../drizzle/schema");
  const branchFilter = opts.branchId ? sql`AND wo.branchId = ${opts.branchId}` : sql``;
  const rows = await db.execute(sql`
    SELECT
      wo.id AS workOrderId,
      wo.orderNumber AS orderNumber,
      wo.branchId AS branchId,
      wo.customerId AS customerId,
      c.name AS customerName,
      wo.workOrderStatus AS status,
      COALESCE(wo.materialsCost, 0) AS materialsCost,
      wo.createdAt AS createdAt
    FROM workOrders wo
    LEFT JOIN customers c ON c.id = wo.customerId
    WHERE wo.workOrderStatus IN ('IN_PROGRESS', 'READY')
    ${branchFilter}
    ORDER BY wo.id DESC
    LIMIT ${limit}
  `);
  const data = ((rows as any)[0] ?? rows) as Array<any>;
  const wipRows: WIPRow[] = (Array.isArray(data) ? data : []).map((r) => ({
    workOrderId: Number(r.workOrderId),
    orderNumber: String(r.orderNumber),
    branchId: r.branchId != null ? Number(r.branchId) : null,
    customerId: r.customerId != null ? Number(r.customerId) : null,
    customerName: r.customerName ?? null,
    status: String(r.status) as "IN_PROGRESS" | "READY",
    materialsCost: String(r.materialsCost ?? "0"),
    createdAt: new Date(r.createdAt),
  }));
  const totalMaterialsCost = sumMoney(wipRows.map((r) => r.materialsCost)).toFixed(2);
  return {
    rows: wipRows,
    totalCount: wipRows.length,
    totalMaterialsCost,
  };
}
