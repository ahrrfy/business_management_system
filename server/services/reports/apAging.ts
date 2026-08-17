// شيخوخة الذمم الدائنة (AP) + كشف حساب مورد.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { accountingEntries, exchangeHouses, exchangeTransactions, purchaseOrders, receipts, suppliers } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, sumMoney, toDbMoney } from "../money";
import { nextDayStr, type StatementPeriod } from "./shared";

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
  // #AP-aging (تدقيق التثبيت): سابقاً كان unpaid = GREATEST(po.total - po.paidAmount, 0) بلا تصافي
  // مرتجعات الشراء الائتمانية (بخلاف AR الذي يستعمل returnedTotal). purchaseOrders لا يحمل
  // returnedTotal، لكن accountingEntries يحمل قيود RETURN (سالبة) وPAYMENT_IN (استرداد نقدي).
  // net_credit_returned = |Σ RETURN| − Σ PAYMENT_IN لكل PO ⇒ CASH يصفَّر (0)، CREDIT يبقى موجباً.
  const rows = await db.execute(sql`
    SELECT
      s.id AS supplierId,
      s.name AS supplierName,
      s.phone,
      CAST(s.currentBalance AS CHAR) AS currentBalance,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) <= 30 THEN GREATEST(COALESCE(gl.balance, 0), 0) ELSE 0 END), 0) AS CHAR) AS d0_30,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) BETWEEN 31 AND 60 THEN GREATEST(COALESCE(gl.balance, 0), 0) ELSE 0 END), 0) AS CHAR) AS d31_60,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) BETWEEN 61 AND 90 THEN GREATEST(COALESCE(gl.balance, 0), 0) ELSE 0 END), 0) AS CHAR) AS d61_90,
      CAST(COALESCE(SUM(CASE WHEN DATEDIFF(UTC_DATE(), DATE(po.orderDate)) > 90 THEN GREATEST(COALESCE(gl.balance, 0), 0) ELSE 0 END), 0) AS CHAR) AS d91p,
      CAST(COALESCE(SUM(GREATEST(COALESCE(gl.balance, 0), 0)), 0) AS CHAR) AS unpaidTotal,
      DATE_FORMAT(MIN(CASE WHEN COALESCE(gl.balance, 0) > 0 THEN po.orderDate END), '%Y-%m-%d') AS oldestPoDate
    FROM suppliers s
    LEFT JOIN purchaseOrders po
      ON po.supplierId = s.id
      AND po.poStatus IN ('CONFIRMED', 'RECEIVED')
      ${branchFilter}
    LEFT JOIN (
      SELECT ae.purchaseOrderId,
        COALESCE(SUM(CASE
          WHEN ae.entryType = 'PURCHASE' THEN ae.amount
          WHEN ae.entryType = 'RETURN' THEN ae.amount
          WHEN ae.entryType = 'PAYMENT_IN' THEN ae.amount
          WHEN ae.entryType IN ('PAYMENT_OUT','EXCHANGE_SETTLE') THEN -ae.amount
          ELSE 0 END), 0) AS balance
      FROM accountingEntries ae
      WHERE ae.purchaseOrderId IS NOT NULL AND ae.supplierId IS NOT NULL
        AND ae.entryType IN ('PURCHASE','RETURN','PAYMENT_IN','PAYMENT_OUT','EXCHANGE_SETTLE')
      GROUP BY ae.purchaseOrderId
    ) gl ON gl.purchaseOrderId = po.id
    WHERE s.isActive = TRUE
    GROUP BY s.id, s.name, s.phone, s.currentBalance
    -- currentBalance <> 0 (لا > 0): يُظهر أيضاً الرصيد المدين للمورّد (دفعة مقدّمة «لنا عليه»/رصيد
    -- افتتاحيّ) فلا يختفي أيّ طرفٍ له رصيدٌ غير صفريّ من «الذمم». الموجب دائن، السالب مدين (unbucketed موقَّع).
    HAVING unpaidTotal > 0 OR s.currentBalance <> 0
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
  voucherNumber: string | null;
  paymentMethod: string | null;
  referenceNumber: string | null;
  exchangeHouseId: number | null;
  exchangeHouseName: string | null;
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
async function supplierOpeningBalance(supplierId: number, from?: string, branchId?: number) {
  const db = getDb()!;
  const branchCond = branchId ? eq(accountingEntries.branchId, branchId) : undefined;
  // ب-١ (١٦/٨): نظير العميل — «الافتتاحيّ كما في تاريخ س» = مجموع قيود OPENING **حتى س**،
  // لأنّ التصحيح صار قيد فرقٍ مؤرَّخاً لا تعديلاً للأصل.
  const openFromTs = from ? `${from} 00:00:00` : null;
  const openRow = await db
    .select({ v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.entryType, "OPENING"),
        eq(accountingEntries.supplierId, supplierId),
        branchCond,
        openFromTs ? sql`${accountingEntries.entryDate} < ${openFromTs}` : undefined,
      ),
    );
  let opening = money(openRow[0]?.v ?? 0);
  if (!from) return opening;

  // صافي تأثير القيود قبل الفترة على AP (مرآة reconcileSupplierBalances):
  //   PAYMENT_OUT يطرح، PAYMENT_IN يضيف (استرداد من مورد)، RETURN.amount مخزَّن سالباً فيطرح المرتجع.
  // كان نظير العميل (customerOpeningBalance) يضمّ الاتجاهين بصحّة، بينما المورد كان PAYMENT_OUT فقط
  // ⇒ كشف حساب لا يتّزن عند استرداد من مورد أو مرتجع شراء.
  // كل PURCHASE موثّق قبل الفترة يدخل الرصيد المُرحّل، سواء ارتبط بأمر شراء أم كان شراء أصل
  // مستقلاً. لم نعد نجمع purchaseOrders.total هنا، لذلك إدراج القيد المرتبط لا يسبب ازدواجاً؛
  // كما أن branchCond وentryDate يجعلان المصدر دفتر الأستاذ ضمن الفرع والفترة المطلوبين.
  // EXCHANGE-SETTLE (تدقيق ٢/٧): تسديد ذمّة المورد عبر بيت صيرفة يُقيَّد EXCHANGE_SETTLE ويخفّض AP
  // (مرآة reconcileSupplierBalances السطر ١٨٠). كان مُغفَلاً من المُرحَّل ⇒ الكشف لا يتّزن مع الرصيد
  // الجاري عند وجود تسديد صيرفة. نُدرجه بإشارة سالبة هنا وفي حركة الفترة أدناه (متماثلاً فلا انحراف).
  const entriesRow = await db
    .select({
      v: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT'     THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN'      THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'RETURN'          THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PURCHASE'        THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'EXCHANGE_SETTLE' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        inArray(accountingEntries.entryType, ["PURCHASE", "PAYMENT_OUT", "PAYMENT_IN", "RETURN", "EXCHANGE_SETTLE"]),
        eq(accountingEntries.supplierId, supplierId),
        branchCond,
        sql`${accountingEntries.entryDate} < ${from}`
      )
    );
  return opening.plus(money(entriesRow[0]?.v ?? 0));
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
  // تدقيق ١٧/٧: اقصر الكشف على الأوامر الملتزمة مالياً (CONFIRMED/RECEIVED) — مطابقةً لـsupplierOpeningBalance
  // وreconcileSupplierBalances. كان يُدرج DRAFT/SENT/CANCELLED بكامل قيمتها في totalPurchases ودفتر الحركات
  // فلا يتّزن الكشف مع currentBalance بمجرّد وجود أمر ملغى أو مسودّة.
  poConds.push(inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]));
  if (from) poConds.push(sql`${purchaseOrders.orderDate} >= ${`${from} 00:00:00`}`);
  if (to) poConds.push(sql`${purchaseOrders.orderDate} < ${`${nextDayStr(to)} 00:00:00`}`);
  if (branchId) poConds.push(eq(purchaseOrders.branchId, branchId));
  const pos = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      orderDate: purchaseOrders.orderDate,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      // paidAmount هو إجمالي ما نُسب لهذا الأمر، ويُحدَّث ذرياً مع قيد PAYMENT_OUT
      // داخل receivePurchase. استعمال scalar subquery ثانية هنا أعاد صفراً في MySQL/Drizzle
      // رغم وجود القيد المرتبط، فكان صف الأمر وsummary.totalPaid يناقضان حركة الدفعة نفسها.
      // نبقي total من قيود PURCHASE لأنه يمثل المستلم فعلاً عند الاستلام الجزئي، بينما
      // paidAmount هو الحقل التراكمي المرجعي للأمر (والاسترداد يظهر كحركة PAYMENT_IN مستقلة).
      paidAmount: purchaseOrders.paidAmount,
      status: purchaseOrders.status,
    })
    .from(purchaseOrders)
    .where(and(...poConds))
    .orderBy(desc(purchaseOrders.orderDate));

  // نجمع مشتريات كل أمر من GL باستعلام مستقل. الاستعلام الفرعي المرتبط أعاد صفراً
  // في MySQL/Drizzle في بعض الخطط، بينما التجميع الصريح يثبت أن المصدر هو PURCHASE
  // الموثّق ويمنع الرجوع إلى purchaseOrders.total الاسمي.
  const purchaseTotals = pos.length
    ? await db
        .select({
          purchaseOrderId: accountingEntries.purchaseOrderId,
          total: sql<string>`COALESCE(SUM(${accountingEntries.amount}), 0)`,
        })
        .from(accountingEntries)
        .where(
          and(
            eq(accountingEntries.entryType, "PURCHASE"),
            inArray(accountingEntries.purchaseOrderId, pos.map((p) => Number(p.id))),
          ),
        )
        .groupBy(accountingEntries.purchaseOrderId)
    : [];
  const totalByPurchaseOrder = new Map(
    purchaseTotals.map((row) => [Number(row.purchaseOrderId), String(row.total)]),
  );
  const posWithTotals = pos.map((po) => ({
    ...po,
    total: totalByPurchaseOrder.get(Number(po.id)) ?? "0.00",
  }));

  // كل حركات الدفتر المؤثّرة على AP المورد ضمن الفترة (PAYMENT_OUT/PAYMENT_IN/RETURN).
  // كان السابق PAYMENT_OUT فقط ⇒ استرداد المورد ومرتجع الشراء يغيبان عن الكشف فلا يتّزن
  // (الرصيد الجاري ≠ المُرحَّل + مشتريات الفترة − دفعات الفترة المعروضة). الفلترة على تاريخ القيد
  // نفسه: حركة داخل الفترة على أمر أقدم تظهر (الدلالة المحاسبية).
  // FI-01: تشمل الحركة شراء الأصول اليتيم (PURCHASE بلا purchaseOrderId) ليَظهر في الكشف ويتّزن
  // الرصيد مع currentBalance؛ شراء PO يُعرَض من purchaseOrders أعلاه ⇒ نَستثنيه هنا (لا ازدواج).
  // EXCHANGE-SETTLE (تدقيق ٢/٧): تسديد الصيرفة يظهر ضمن حركة الفترة أيضاً (متماثلاً مع المُرحَّل).
  // ب-١ (١٦/٨): OPENING يدخل الحركة **مع وجود فترة فقط** — المُرحَّل صار مقصوراً على ما قبل
  // `from`، فتصحيحٌ داخل الفترة يجب أن يُعرَض حركةً وإلّا اختلّ اتزان الكشف. بلا فترة يبقى
  // مستبعَداً لأنّ المُرحَّل يشمله كاملاً (وإلّا احتُسب مرّتين).
  const openingMoveSql = from
    ? sql` OR ${accountingEntries.entryType} = 'OPENING'`
    : sql``;
  const payConds = [
    sql`(${accountingEntries.entryType} IN ('PAYMENT_OUT','PAYMENT_IN','RETURN','EXCHANGE_SETTLE') OR (${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.purchaseOrderId} IS NULL)${openingMoveSql})`,
    eq(accountingEntries.supplierId, supplierId),
  ];
  if (branchId) payConds.push(eq(accountingEntries.branchId, branchId));
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
      voucherNumber: receipts.voucherNumber,
      paymentMethod: receipts.paymentMethod,
      referenceNumber: receipts.referenceNumber,
      exchangeHouseId: exchangeTransactions.exchangeHouseId,
      exchangeHouseName: exchangeHouses.name,
    })
    .from(accountingEntries)
    .leftJoin(receipts, eq(receipts.id, accountingEntries.receiptId))
    .leftJoin(exchangeTransactions, eq(exchangeTransactions.receiptId, receipts.id))
    .leftJoin(exchangeHouses, eq(exchangeHouses.id, exchangeTransactions.exchangeHouseId))
    .where(and(...payConds))
    .orderBy(asc(accountingEntries.entryDate), asc(accountingEntries.id));

  const openingBalance = await supplierOpeningBalance(supplierId, from, branchId);

  // أموال بدقّة decimal.js (§٥).
  const totalPurchases = sumMoney(posWithTotals.map((p) => p.total ?? 0));
  const totalPaid = sumMoney(posWithTotals.map((p) => p.paidAmount ?? 0));
  const periodEntryEffect = payments.reduce((acc, p) => {
    const amount = money(p.amount);
    if (p.entryType === "PAYMENT_OUT" || p.entryType === "EXCHANGE_SETTLE") return acc.minus(amount);
    return acc.plus(amount); // RETURN is already signed negative; PAYMENT_IN/PURCHASE are positive.
  }, money(0));
  const closingBalance = openingBalance.plus(totalPurchases).plus(periodEntryEffect);
  const unpaid = closingBalance.isPositive() ? closingBalance : money(0);

  return {
    supplier: s,
    purchaseOrders: posWithTotals.map((p) => ({
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
      voucherNumber: p.voucherNumber,
      paymentMethod: p.paymentMethod,
      referenceNumber: p.referenceNumber,
      exchangeHouseId: p.exchangeHouseId ? Number(p.exchangeHouseId) : null,
      exchangeHouseName: p.exchangeHouseName,
    })),
    summary: {
      totalPurchases: toDbMoney(totalPurchases),
      totalPaid: toDbMoney(totalPaid),
      unpaid: toDbMoney(unpaid),
      currentBalance: toDbMoney(branchId ? closingBalance : money(s.currentBalance ?? "0")),
      openingBalance: toDbMoney(openingBalance),
    },
  };
}
