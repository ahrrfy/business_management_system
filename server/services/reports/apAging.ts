// شيخوخة الذمم الدائنة (AP) + كشف حساب مورد.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { accountingEntries, purchaseOrders, suppliers } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, sumMoney, toDbMoney } from "../money";
import { nextDayStr, positiveDiff, type StatementPeriod } from "./shared";

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

  // AP-OPENING (تدقيق ٢/٧): كان الرصيد المُرحَّل يُبنى من purchaseOrders.total لأوامر CONFIRMED/RECEIVED
  // ⇒ (١) أمر مؤكَّد لم يُستلَم بعد يُحتسَب بكامل قيمته بينما AP الفعلي (currentBalance) لا يلتزم إلا
  // عند الاستلام؛ (٢) أمر مُستلَم جزئياً يُحتسَب بكامله لا بالمستلَم؛ (٣) تسديدات الصيرفة EXCHANGE_SETTLE
  // مُغفَلة ⇒ الكشف لا يتّزن مع الرصيد الجاري. الحلّ: نبني الالتزام من **قيود الدفتر** حرفياً كما يفعل
  // reconcileSupplierBalances (المصدر الأصحّ): PURCHASE (بالقيمة المُستلَمة فعلاً، PO-linked واليتيمة معاً)
  // − PAYMENT_OUT + PAYMENT_IN + RETURN (سالب) − EXCHANGE_SETTLE. لا purchaseOrders ⇒ لا تضخيم بأوامر
  // غير مستلمة، ولا ازدواج (PURCHASE يُقيَّد عند الاستلام لا عند التأكيد).
  const entriesRow = await db
    .select({
      v: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'PURCHASE'        THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT'     THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN'      THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'RETURN'          THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'EXCHANGE_SETTLE' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        inArray(accountingEntries.entryType, ["PURCHASE", "PAYMENT_OUT", "PAYMENT_IN", "RETURN", "EXCHANGE_SETTLE"]),
        eq(accountingEntries.supplierId, supplierId),
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
