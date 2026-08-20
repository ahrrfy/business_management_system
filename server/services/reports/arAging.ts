// تقارير مالية للقراءة فقط:
//  - getARAging: شيخوخة الذمم المدينة لكل العملاء، بدلاء 0-30/31-60/61-90/90+.
//  - getCustomerStatement: كشف حساب عميل (فواتير + دفعات + ملخّص).
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { accountingEntries, customers, invoices, orderPayments, receipts, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, sumMoney, toDbMoney } from "../money";
import { isPreInvoiceHoldReceiptCond } from "../reception/holdReceipts";
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
  // بطاقة العميل currentBalance على مستوى الشركة. عند تقرير فرع نعيد بناء رصيده من
  // القيود ذات المصدر الفرعي، مع fallback لمتبقي الفواتير للبيانات التاريخية السابقة للدفتر.
  const branchBalanceJoin = opts.branchId
    ? sql`LEFT JOIN (
        SELECT ae.customerId,
          SUM(CASE
            WHEN ae.entryType IN ('SALE','RETURN','OPENING') THEN ae.amount
            WHEN ae.entryType = 'PAYMENT_IN' THEN -ae.amount
            WHEN ae.entryType = 'PAYMENT_OUT' THEN ae.amount
            ELSE 0 END) AS balance
        FROM accountingEntries ae
        WHERE ae.customerId IS NOT NULL
          AND ae.branchId = ${opts.branchId}
          AND ae.entryType IN ('SALE','RETURN','OPENING','PAYMENT_IN','PAYMENT_OUT')
        GROUP BY ae.customerId
      ) cb ON cb.customerId = c.id`
    : sql``;
  const currentBalanceExpr = opts.branchId
    ? sql`COALESCE(cb.balance, COALESCE(SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0))`
    : sql`c.currentBalance`;
  const branchGroup = opts.branchId ? sql`, cb.balance` : sql``;
  const balanceHaving = opts.branchId
    ? sql`unpaidTotal > 0 OR currentBalance <> 0`
    : sql`unpaidTotal > 0 OR c.currentBalance <> 0`;
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
      CAST(${currentBalanceExpr} AS CHAR) AS currentBalance,
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
    ${branchBalanceJoin}
    GROUP BY c.id, c.name, c.phone, c.customerType, c.currentBalance ${branchGroup}
    -- الطرف غير النشط لا يعني أن رصيده سقط محاسبياً. في نطاق الشركة نظهر كل رصيد
    -- غير صفري؛ وفي نطاق الفرع لا نُدخل رصيد بطاقة العميل العمومي غير القابل للتوزيع.
    HAVING ${balanceHaving}
    ORDER BY unpaidTotal DESC, c.currentBalance DESC
    LIMIT ${limit}
  `);
  const data = (rows as any)[0] ?? rows;
  if (!Array.isArray(data)) return [];
  // REP-04: الدلاء تُعمَّر من الفواتير المستحقّة فقط؛ الرصيد الافتتاحي (OPENING) والسندات المستقلّة
  // تقع خارجها ⇒ unbucketed = currentBalance − unpaidTotal (مُوقَّع، بلا قصّ) يُغلق الفرق فتتّزن
  // الدلاء مع الرصيد الجاري. بدقّة decimal (§٥).
  return (data as any[]).map((r) => {
    const scopedBalance = money(r.currentBalance);
    return {
      ...(r as ARAgingRow),
      currentBalance: toDbMoney(scopedBalance),
      unbucketed: toDbMoney(scopedBalance.sub(money(r.unpaidTotal))),
    };
  });
}

export interface CustomerStatementInvoice {
  id: number;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date | null;
  total: string;
  paidAmount: string;
  // REP-06: إجمالي المُرتجَع على الفاتورة — يلزم لحساب المتبقّي الصحيح في الواجهة
  // (total − paidAmount − returnedTotal). إغفاله كان يُظهر متبقّياً موجباً لفاتورة سُدِّد صافيها.
  returnedTotal: string;
  status: string;
  sourceType: string;
  createdBy: number | null;
  createdByName: string | null;
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
  createdBy: number | null;
  createdByName: string | null;
}

export interface CustomerStatementResult {
  customer: Pick<typeof customers.$inferSelect, "id" | "name" | "phone" | "customerType" | "creditLimit" | "defaultPriceTier" | "currentBalance">;
  invoices: CustomerStatementInvoice[];
  payments: CustomerStatementPayment[];
  summary: {
    totalSales: string;
    totalPaid: string;
    unpaid: string;
    currentBalance: string;
    /** الرصيد المُرحَّل: قيد OPENING المستورد + (مع from) كل النشاط السابق للفترة. */
    openingBalance: string;
    /** ش٤ (I11): صافي عرابين المسوّدات المحتجزة (غير المطبَّقة على فاتورة) — سطر إفصاح. */
    heldDepositsTotal: string;
  };
}

/** شرط «دفعات هذا العميل»: receipts مرتبطة بفواتيره (عبر join) **أو** سندات مستقلّة
 *  (بلا invoiceId، partyType=CUSTOMER) — إصلاح علّة: السندات المستقلّة كانت غائبة عن الكشف
 *  فيظهر الرصيد الجاري «منحرفاً» بلا تفسير في الحركة المعروضة. */
function customerPaymentLink(customerId: number) {
  return or(
    and(
      eq(invoices.customerId, customerId),
      // تدقيق ٦/٨ (ث٢/ث٦/ث١٤): إيصالُ أمانة أجرة التوصيل مختومٌ بالفاتورة لأسبابٍ تشغيلية
      // (ربطُ الأمانة بمستندها) لا لأنّه دفعةٌ من العميل — مالُ طرفٍ ثالث لم يمسّ paidAmount
      // ولا currentBalance. عرضُه دفعةً كان يُظهر العميل دائناً بقيمة الأجرة ويُنقص رصيده
      // المُرحَّل بلا سند. البصمة البنيوية: إيصالات التمرير وحدها تحمل partyType='OTHER'،
      // ودفعاتُ العميل الحقيقية تتركه NULL أو 'CUSTOMER'.
      sql`(${receipts.partyType} IS NULL OR ${receipts.partyType} <> 'OTHER')`,
    ),
    and(
      isNull(receipts.invoiceId),
      eq(receipts.partyType, "CUSTOMER"),
      eq(receipts.partyId, customerId),
      // ش٤ (V5 دفاعيّ): إيصال احتجازٍ سابق للفاتورة (عربون WO/مسوّدة) ليس «سنداً مستقلاً» —
      // لم يمسّ currentBalance، وعرضه دفعةً على الحساب يجعل الكشف يكذب (I11). إيصالات
      // الاحتجاز لا تكتب partyType أصلاً (نمط WO القائم) — الشرط صمّام أمانٍ بنيويّ.
      sql`NOT (${isPreInvoiceHoldReceiptCond()})`,
    )
  );
}

/**
 * الرصيد المُرحَّل لعميل:
 *  - دائماً: مجموع قيود OPENING (ترسيخ الرصيد الافتتاحي المستورد — import-integration).
 *  - مع from: + مجموع فواتيره الملتزمة قبل from (CANCELLED مُستثناة — التزامها أُلغي، كما في reconcile)
 *             − صافي دفعاته قبل from (IN ينقص ذمته، OUT يزيدها؛ فقط الإيصالات التي أثّرت على الرصيد:
 *               approvalStatus=APPROVED و status ∈ {COMPLETED، REVERSED} — انظر payRow/F5).
 * كل الجمع بدقّة decimal (§٥).
 */
async function customerOpeningBalance(customerId: number, from?: string) {
  const db = getDb()!;
  // ب-١ (١٦/٨): تصحيح الرصيد الافتتاحيّ صار **قيد فرقٍ مؤرَّخاً** لا تعديلاً للأصل. لذا
  // «الافتتاحيّ كما في تاريخ س» = مجموع قيود OPENING **حتى س** لا مجموعها كلّها: تصحيحٌ وقع
  // اليوم لا يجوز أن يدخل رصيد كشفٍ بدأ الشهر الماضي — وإلّا تغيّر كشفٌ ماضٍ بلا حركةٍ تفسّره.
  const fromTs = from ? `${from} 00:00:00` : null;
  const openRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.entryType, "OPENING"),
        eq(accountingEntries.customerId, customerId),
        fromTs ? sql`${accountingEntries.entryDate} < ${fromTs}` : undefined,
      ),
    );
  let opening = money(openRow[0]?.v ?? 0);
  if (!fromTs) return opening;
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
        // F5 (تدقيق ٢/٧): الإيصالات التي أثّرت فعلاً على currentBalance (مرّت عبر adjustCustomerBalance) =
        //   approvalStatus=APPROVED و status ∈ (COMPLETED للنشطة + REVERSED للأصل المُعتمَد ثم الملغى، ليوازن
        //   تعويضَه COMPLETED فيصير أثر السند الملغى صفراً). المعلّق/المرفوض (approvalStatus≠APPROVED) لم يمسّ
        //   الرصيد ⇒ يُستبعَد. (سابقاً: COMPLETED فقط ⇒ الأصل REVERSED يُستبعَد بينما تعويضه يُحتسَب = ساق واحدة.)
        sql`${receipts.status} IN ('COMPLETED','REVERSED')`,
        eq(receipts.approvalStatus, "APPROVED"),
        sql`${receipts.createdAt} < ${fromTs}`
      )
    );
  // AR-OPENING-RETURN (تدقيق ٢/٧): الرصيد المُرحَّل كان يجمع كامل total الفاتورة (الفاتورة المُرتجَعة
  // كلياً تبقى status='RETURNED' لا CANCELLED) وينقص الدفعات فقط — دون طرح المرتجعات ⇒ رصيد مُرحَّل
  // منفوخ بمقدار كل مرتجع سابق للفترة (يُطالَب العميل بدينٍ أسقطه مرتجعٌ موثَّق، ولا يتّزن الكشف مع
  // currentBalance). قيد RETURN يُخزَّن بمبلغ سالب (=returnedTotal الكامل)؛ الاسترداد النقدي مُلتقَط
  // أصلاً في payRow (receipt OUT مربوط بالفاتورة) فلا ازدواج — نُضيف مبلغ المرتجعات (سالباً) هنا.
  const retRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.entryType, "RETURN"),
        eq(accountingEntries.customerId, customerId),
        isNull(accountingEntries.supplierId),
        sql`${accountingEntries.entryDate} < ${from}`
      )
    );
  // COD-COURIER (مراجعة عدائية ١٢/٧ + ٩/٨): تحصيلات المندوب تسدّد الذمّة دون أن يلتقطها payRow:
  //   (أ) تحصيل طلب متجر — قيد PAYMENT_IN **بلا إيصال** إطلاقاً (النقد بعهدة المندوب).
  //   (ب) توريد إرسالية استقبال (recordDeliveryRemittance) — قيد PAYMENT_IN مربوطٌ بإيصال درجٍ
  //       **مجمَّع** (invoiceId=NULL، partyType=OTHER) لا يطابقه customerPaymentLink أبداً.
  // بدونهما يُرحَّل كامل total الفاتورة فيظهر العميل مديناً بما سدّده للمندوب. البصمة المشتركة:
  // قيد PAYMENT_IN بفاتورةٍ لكن **بلا إيصالٍ مربوطٍ بفاتورة** (دفعات البيع العادية إيصالها يحمل
  // invoiceId فيلتقطها payRow) ⇒ لا ازدواج مع payRow بالبناء.
  const codReceipts = alias(receipts, "codReceipts");
  const codPayRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
    .from(accountingEntries)
    .leftJoin(codReceipts, eq(accountingEntries.receiptId, codReceipts.id))
    .where(
      and(
        eq(accountingEntries.entryType, "PAYMENT_IN"),
        eq(accountingEntries.customerId, customerId),
        sql`${accountingEntries.invoiceId} IS NOT NULL`,
        sql`${codReceipts.invoiceId} IS NULL`,
        sql`${accountingEntries.entryDate} < ${fromTs}`
      )
    );
  return opening
    .plus(money(invRow[0]?.v ?? 0))
    .minus(money(payRow[0]?.v ?? 0))
    .minus(money(codPayRow[0]?.v ?? 0))
    .plus(money(retRow[0]?.v ?? 0));
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
  const c = (await db.select({
    id: customers.id,
    name: customers.name,
    phone: customers.phone,
    customerType: customers.customerType,
    creditLimit: customers.creditLimit,
    defaultPriceTier: customers.defaultPriceTier,
    currentBalance: customers.currentBalance,
  }).from(customers).where(eq(customers.id, customerId)).limit(1))[0];
  if (!c) return null;
  const { from, to, branchId } = period;

  const invConds = [eq(invoices.customerId, customerId)];
  if (from) invConds.push(sql`${invoices.invoiceDate} >= ${`${from} 00:00:00`}`);
  if (to) invConds.push(sql`${invoices.invoiceDate} < ${`${nextDayStr(to)} 00:00:00`}`);
  if (branchId) invConds.push(eq(invoices.branchId, branchId));
  const invoiceActor = alias(users, "customerStatementInvoiceActor");
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
      createdBy: invoices.createdBy,
      createdByName: sql<string | null>`COALESCE(${invoiceActor.name}, ${invoiceActor.username})`,
    })
    .from(invoices)
    .leftJoin(invoiceActor, eq(invoiceActor.id, invoices.createdBy))
    .where(and(...invConds))
    .orderBy(desc(invoices.invoiceDate));

  // الدفعات تُفلتَر على تاريخها هي (createdAt) لا على فواتيرها: دفعةٌ داخل الفترة على
  // فاتورة أقدم منها يجب أن تظهر — هذا جوهر الدلالة المحاسبية للكشف بفترة.
  const payConds = [customerPaymentLink(customerId)];
  // لا تدخل الحركة إلا إذا أثرت مالياً فعلاً. السند المعلّق/المرفوض لا قيد له،
  // وREVERSED يبقى ليتصافي مع الإيصال التعويضي.
  payConds.push(eq(receipts.approvalStatus, "APPROVED"));
  payConds.push(sql`${receipts.status} IN ('COMPLETED', 'REVERSED')`);
  if (from) payConds.push(sql`${receipts.createdAt} >= ${`${from} 00:00:00`}`);
  if (to) payConds.push(sql`${receipts.createdAt} < ${`${nextDayStr(to)} 00:00:00`}`);
  const receiptActor = alias(users, "customerStatementReceiptActor");
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
      createdBy: receipts.createdBy,
      createdByName: sql<string | null>`COALESCE(${receiptActor.name}, ${receiptActor.username})`,
    })
    .from(receipts)
    .leftJoin(invoices, eq(receipts.invoiceId, invoices.id))
    .leftJoin(receiptActor, eq(receiptActor.id, receipts.createdBy))
    .where(and(...payConds))
    .orderBy(asc(receipts.createdAt), asc(receipts.id));

  // COD-COURIER (مراجعة عدائية ١٢/٧ + ٩/٨): تحصيلات المندوب كدفعات مرئية في الكشف كي يظهر
  // السداد كمستندٍ متتبَّع (لا فاتورة PAID بلا دفعة) — تشمل تحصيل المتجر (بلا إيصال) **وتوريد
  // إرسالية الاستقبال** (إيصاله مجمَّع بلا فاتورة فلا يظهر في payments؛ نفس بصمة codPayRow
  // أعلاه حرفياً وإلا انحرف الكشف عن الرصيد المُرحَّل). المعرّف سالبٌ لتمييزه عن الإيصالات.
  const codStmtReceipts = alias(receipts, "codStmtReceipts");
  const codPayConds = [
    eq(accountingEntries.entryType, "PAYMENT_IN"),
    eq(accountingEntries.customerId, customerId),
    sql`${accountingEntries.invoiceId} IS NOT NULL`,
    sql`${codStmtReceipts.invoiceId} IS NULL`,
  ];
  if (from) codPayConds.push(sql`${accountingEntries.entryDate} >= ${`${from} 00:00:00`}`);
  if (to) codPayConds.push(sql`${accountingEntries.entryDate} < ${`${nextDayStr(to)} 00:00:00`}`);
  const codPayments = await db
    .select({ id: accountingEntries.id, invoiceId: accountingEntries.invoiceId, amount: accountingEntries.amount, createdAt: accountingEntries.entryDate, notes: accountingEntries.notes, createdBy: accountingEntries.createdBy, createdByName: accountingEntries.createdByNameSnapshot })
    .from(accountingEntries)
    .leftJoin(codStmtReceipts, eq(accountingEntries.receiptId, codStmtReceipts.id))
    .where(and(...codPayConds));

  // مرتجع البيع الائتماني يخفض ذمة العميل بلا receipt. نعرض قيد RETURN نفسه
  // كدائن، ويظل رد النقد (receipt OUT) مديناً؛ فيتطابق صافي الكشف مع currentBalance.
  const returnConds = [
    eq(accountingEntries.entryType, "RETURN"),
    eq(accountingEntries.customerId, customerId),
    isNull(accountingEntries.supplierId),
  ];
  if (from) returnConds.push(sql`${accountingEntries.entryDate} >= ${from}`);
  if (to) returnConds.push(sql`${accountingEntries.entryDate} <= ${to}`);
  if (branchId) returnConds.push(eq(accountingEntries.branchId, branchId));
  const returnPayments = await db
    .select({
      id: accountingEntries.id,
      invoiceId: accountingEntries.invoiceId,
      amount: accountingEntries.amount,
      createdAt: accountingEntries.entryDate,
      notes: accountingEntries.notes,
      createdBy: accountingEntries.createdBy,
      createdByName: accountingEntries.createdByNameSnapshot,
    })
    .from(accountingEntries)
    .where(and(...returnConds));

  // ب-١ (١٦/٨): قيود تصحيح الرصيد الافتتاحيّ **الواقعة داخل الفترة** حركةٌ في الكشف لا رصيدٌ
  // مُرحَّل (المُرحَّل صار مقصوراً على ما قبل `from`). بدون هذا السطر يفقد الكشف اتزانه:
  // المُرحَّل يستبعدها والحركة لا تعرضها ⇒ الختاميّ ≠ الرصيد الجاري بمقدار التصحيح.
  const openingMoveConds = [
    eq(accountingEntries.entryType, "OPENING"),
    eq(accountingEntries.customerId, customerId),
  ];
  if (from) openingMoveConds.push(sql`${accountingEntries.entryDate} >= ${`${from} 00:00:00`}`);
  if (to) openingMoveConds.push(sql`${accountingEntries.entryDate} < ${`${nextDayStr(to)} 00:00:00`}`);
  // بلا فترة: المُرحَّل يشمل كلّ القيود أصلاً ⇒ لا نُكرّرها حركةً.
  const openingAdjustments = from
    ? await db
        .select({
          id: accountingEntries.id,
          amount: accountingEntries.amount,
          createdAt: accountingEntries.entryDate,
          notes: accountingEntries.notes,
          createdBy: accountingEntries.createdBy,
          createdByName: accountingEntries.createdByNameSnapshot,
        })
        .from(accountingEntries)
        .where(and(...openingMoveConds))
    : [];

  const openingBalance = await customerOpeningBalance(customerId, from);

  // ش٤ (I11): عرابين المسوّدات المحتجزة للعميل — **سطر إفصاحٍ منفصل** لا حركة كشف: المال
  // مقبوضٌ فعلاً (إيصال + قيد) لكنه لم يُطبَّق على فاتورةٍ ولم يمسّ الرصيد الجاري. بدونه
  // يسأل العميل «أين عربوني؟» والكشف صامت. الصافي = Σ COLLECTION(HELD) − ردودها الجزئية.
  const heldRows = await db
    .select({
      id: orderPayments.id,
      amount: orderPayments.amount,
      kind: orderPayments.kind,
      parentPaymentId: orderPayments.parentPaymentId,
      status: orderPayments.status,
    })
    .from(orderPayments)
    .where(and(eq(orderPayments.customerId, customerId), sql`${orderPayments.kind} IN ('COLLECTION','REFUND')`));
  let heldDeposits = money(0);
  const heldCollectionIds = new Set<number>();
  for (const r of heldRows) {
    if (r.kind === "COLLECTION" && r.status === "HELD") {
      heldDeposits = heldDeposits.plus(money(r.amount));
      heldCollectionIds.add(Number(r.id));
    }
  }
  for (const r of heldRows) {
    if (r.kind === "REFUND" && r.parentPaymentId != null && heldCollectionIds.has(Number(r.parentPaymentId))) {
      heldDeposits = heldDeposits.minus(money(r.amount));
    }
  }

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
      returnedTotal: String(i.returnedTotal ?? "0"),
      status: i.status,
      sourceType: i.sourceType,
      createdBy: i.createdBy ? Number(i.createdBy) : null,
      createdByName: i.createdByName,
    })),
    payments: [
      ...payments.map((p) => ({
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
        createdBy: p.createdBy ? Number(p.createdBy) : null,
        createdByName: p.createdByName,
      })),
      ...codPayments.map((e) => ({
        id: -Number(e.id),
        invoiceId: e.invoiceId ? Number(e.invoiceId) : null,
        direction: "IN" as const,
        amount: String(e.amount),
        paymentMethod: "COD",
        status: "COMPLETED",
        createdAt: e.createdAt,
        isStandalone: false,
        voucherNumber: null,
        description: e.notes ? String(e.notes) : "تحصيل مندوب التوصيل",
        createdBy: e.createdBy ? Number(e.createdBy) : null,
        createdByName: e.createdByName,
      })),
      ...returnPayments.map((e) => ({
        id: -1_000_000_000 - Number(e.id),
        invoiceId: e.invoiceId ? Number(e.invoiceId) : null,
        direction: "IN" as const,
        amount: money(e.amount).abs().toFixed(2),
        paymentMethod: "RETURN",
        status: "COMPLETED",
        createdAt: e.createdAt,
        isStandalone: false,
        voucherNumber: null,
        description: e.notes ? String(e.notes) : "مرتجع مبيعات",
        createdBy: e.createdBy ? Number(e.createdBy) : null,
        createdByName: e.createdByName,
      })),
      // تصحيح رصيد افتتاحيّ داخل الفترة: الإشارة بدلالة أعمار AR نفسها (موجب يزيد ما علينا
      // تحصيله = أثر PAYMENT_OUT، وسالب يخفّضه = أثر PAYMENT_IN) فيتّسق الرصيد الجاري للكشف.
      ...openingAdjustments.map((e) => ({
        id: -2_000_000_000 - Number(e.id),
        invoiceId: null as number | null,
        direction: (money(e.amount).isNegative() ? "IN" : "OUT") as "IN" | "OUT",
        amount: money(e.amount).abs().toFixed(2),
        paymentMethod: "OPENING_ADJ",
        status: "COMPLETED",
        createdAt: e.createdAt,
        isStandalone: true,
        voucherNumber: null,
        description: e.notes ? String(e.notes) : "تصحيح رصيد افتتاحي",
        createdBy: e.createdBy ? Number(e.createdBy) : null,
        createdByName: e.createdByName,
      })),
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    summary: {
      totalSales: toDbMoney(totalSales),
      totalPaid: toDbMoney(totalPaid),
      unpaid: toDbMoney(unpaid),
      currentBalance: String(c.currentBalance ?? "0"),
      openingBalance: toDbMoney(openingBalance),
      heldDepositsTotal: toDbMoney(heldDeposits),
    },
  };
}
