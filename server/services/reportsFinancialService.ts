// خدمة القوائم المالية (للقراءة فقط) — تُغذّي مركز التقارير.
// المصدر: جدول القيود accountingEntries + جدول المصروفات expenses (لا تخمين).
//
// ⚠️ افتراضات قائمة الأرباح والخسائر المبسّطة (تُعرض في رأس التقرير):
//  • الإيراد/تكلفة المبيعات: قيود SALE + RETURN (RETURN بقيم سالبة ⇒ صافٍ تلقائياً).
//    التكلفة = كلفة الفاتورة وقت البيع (قرار المالك: آخر تكلفة)، الضريبة 0%.
//  • المصروفات التشغيلية: سجلّ المصروفات (ACTIVE) مصنّفةً + الرواتب المدفوعة عبر مسيّر الرواتب
//    (قيود PAYMENT_OUT بمفتاح PAYROLL:%). **لا** تشمل سداد ذمم الموردين (PAYMENT_OUT بـsupplierId)
//    لأنه تسويةُ التزامٍ لا مصروفُ فترة (تكلفته اعتُرف بها وقت البيع) ⇒ لا ازدواج.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/** نسبة مئوية بقسمة آمنة (صفر المقام ⇒ "0.00"). */
function marginPct(numerator: ReturnType<typeof money>, denominator: ReturnType<typeof money>): string {
  if (denominator.isZero()) return "0.00";
  return numerator.div(denominator).times(100).toDecimalPlaces(2).toString();
}

const EXPENSE_CATEGORY_AR: Record<string, string> = {
  RENT: "الإيجار",
  UTILITIES: "الخدمات (ماء/كهرباء)",
  SUPPLIES: "المستلزمات",
  SALARY: "رواتب (مُسجَّلة كمصروف)",
  TRANSPORT: "النقل",
  MAINTENANCE: "الصيانة",
  MARKETING: "التسويق",
  OTHER: "أخرى",
};

export interface PLLine {
  key: string;
  label: string;
  amount: string;
}

export interface PLSnapshot {
  revenue: string;
  cogs: string;
  grossProfit: string;
  grossMarginPct: string;
  expenseLines: PLLine[]; // مصروفات تشغيلية مصنّفة + سطر الرواتب
  totalExpenses: string;
  netProfit: string;
  netMarginPct: string;
}

export interface ProfitLossResult {
  period: { from: string; to: string };
  current: PLSnapshot;
  comparePeriod?: { from: string; to: string };
  previous?: PLSnapshot;
}

async function plSnapshot(from: string, to: string, branchId?: number): Promise<PLSnapshot> {
  const db = getDb();
  const empty: PLSnapshot = {
    revenue: "0", cogs: "0", grossProfit: "0", grossMarginPct: "0.00",
    expenseLines: [], totalExpenses: "0", netProfit: "0", netMarginPct: "0.00",
  };
  if (!db) return empty;

  const branchAe = branchId ? sql`AND ae.branchId = ${branchId}` : sql``;
  const branchEx = branchId ? sql`AND e.branchId = ${branchId}` : sql``;

  // الإيراد/التكلفة الصافيان (SALE + RETURN). entryDate عمود DATE ⇒ حدّان شاملان.
  const rc = rowsOf(
    await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(ae.revenue), 0) AS CHAR) AS revenue,
        CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS cogs
      FROM accountingEntries ae
      WHERE ae.entryType IN ('SALE','RETURN')
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { revenue: "0", cogs: "0" };

  // المصروفات التشغيلية النقدية مصنّفةً من سجلّ المصروفات (ACTIVE + source=CASH فقط).
  // صرف المخزون (source=STOCK: نثرية/تلف) يُحتسَب من الدفتر أدناه (سطر خسائر المخزون) لتفادي الازدواج.
  const exRows = rowsOf(
    await db.execute(sql`
      SELECT e.expenseCategory AS category, CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE' AND e.expenseSource = 'CASH'
        AND e.expenseDate >= ${from} AND e.expenseDate <= ${to}
        ${branchEx}
      GROUP BY e.expenseCategory
      ORDER BY SUM(e.amount) DESC
    `),
  );

  // الرواتب المدفوعة عبر مسيّر الرواتب — PAYMENT_OUT بمفتاح يبدأ بـPAYROLL. نطابق 'PAYROLL%' (لا ':')
  // ليشمل قيد العكس عند إلغاء مسيّر مدفوع (PAYROLL-REV:..) فيتصافر المبلغ الموقَّع صحيحاً.
  const pr = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.amount), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'PAYMENT_OUT' AND ae.dedupeKey LIKE 'PAYROLL%'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // خسائر المخزون (نثرية + تلف) بالكلفة من الدفتر — تشمل صرف المخزون (expenseService) **وهدر الإنتاج**
  // (productionService يقيّد WASTAGE بلا صفّ مصروفات) معاً وبلا ازدواج (المصروفات أعلاه نقدية فقط).
  const sl = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType IN ('INTERNAL_USE', 'WASTAGE')
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  const revenue = money(rc.revenue ?? 0);
  const cogs = money(rc.cogs ?? 0);
  const grossProfit = revenue.sub(cogs);

  const expenseLines: PLLine[] = exRows.map((r) => ({
    key: String(r.category),
    label: EXPENSE_CATEGORY_AR[String(r.category)] ?? String(r.category),
    amount: toDbMoney(money(r.amount ?? 0)),
  }));
  let totalExpenses = exRows.reduce((acc, r) => acc.add(money(r.amount ?? 0)), money(0));

  const payroll = money(pr.amount ?? 0);
  if (payroll.gt(0)) {
    expenseLines.push({ key: "PAYROLL", label: "رواتب (مسيّر الرواتب)", amount: toDbMoney(payroll) });
    totalExpenses = totalExpenses.add(payroll);
  }

  // خسائر المخزون (نثرية + تلف إنتاج) — سطر مستقلّ يضمن عدم تضخيم صافي الربح بإغفالها.
  const stockLoss = money(sl.amount ?? 0);
  if (stockLoss.gt(0)) {
    expenseLines.push({ key: "STOCK_LOSS", label: "نثرية وتلف (مخزون)", amount: toDbMoney(stockLoss) });
    totalExpenses = totalExpenses.add(stockLoss);
  }

  const netProfit = grossProfit.sub(totalExpenses);

  return {
    revenue: toDbMoney(revenue),
    cogs: toDbMoney(cogs),
    grossProfit: toDbMoney(grossProfit),
    grossMarginPct: marginPct(grossProfit, revenue),
    expenseLines,
    totalExpenses: toDbMoney(totalExpenses),
    netProfit: toDbMoney(netProfit),
    netMarginPct: marginPct(netProfit, revenue),
  };
}

export async function getProfitAndLoss(opts: {
  from: string;
  to: string;
  branchId?: number;
  compareFrom?: string;
  compareTo?: string;
}): Promise<ProfitLossResult> {
  const current = await plSnapshot(opts.from, opts.to, opts.branchId);
  const result: ProfitLossResult = {
    period: { from: opts.from, to: opts.to },
    current,
  };
  if (opts.compareFrom && opts.compareTo) {
    result.comparePeriod = { from: opts.compareFrom, to: opts.compareTo };
    result.previous = await plSnapshot(opts.compareFrom, opts.compareTo, opts.branchId);
  }
  return result;
}

/* ============================ دفتر اليومية / الأستاذ ============================ */

export interface LedgerRow {
  id: number;
  entryDate: string;
  entryType: string;
  branchName: string | null;
  revenue: string;
  cost: string;
  profit: string;
  amount: string;
  partyName: string | null;
  invoiceId: number | null;
  invoiceNumber: string | null;
  purchaseOrderId: number | null;
  notes: string | null;
}

export interface GeneralLedgerResult {
  rows: LedgerRow[];
  total: number;
  totals: { revenue: string; cost: string; profit: string; amount: string };
}

const LEDGER_ENTRY_TYPES = [
  "SALE", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "RETURN", "ADJUST", "OPENING", "INTERNAL_USE", "WASTAGE",
] as const;

export async function getGeneralLedger(opts: {
  from: string;
  to: string;
  branchId?: number;
  entryTypes?: string[];
  limit?: number;
  offset?: number;
}): Promise<GeneralLedgerResult> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, totals: { revenue: "0", cost: "0", profit: "0", amount: "0" } };

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conds = [sql`ae.entryDate >= ${opts.from}`, sql`ae.entryDate <= ${opts.to}`];
  if (opts.branchId) conds.push(sql`ae.branchId = ${opts.branchId}`);
  const types = (opts.entryTypes ?? []).filter((t) => (LEDGER_ENTRY_TYPES as readonly string[]).includes(t));
  if (types.length) {
    conds.push(sql`ae.entryType IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})`);
  }
  const where = sql.join(conds, sql` AND `);

  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        ae.id AS id,
        DATE_FORMAT(ae.entryDate, '%Y-%m-%d') AS entryDate,
        ae.entryType AS entryType,
        b.name AS branchName,
        CAST(ae.revenue AS CHAR) AS revenue,
        CAST(ae.cost AS CHAR) AS cost,
        CAST(ae.profit AS CHAR) AS profit,
        CAST(ae.amount AS CHAR) AS amount,
        COALESCE(c.name, s.name) AS partyName,
        ae.invoiceId AS invoiceId,
        i.invoiceNumber AS invoiceNumber,
        ae.purchaseOrderId AS purchaseOrderId,
        ae.notes AS notes
      FROM accountingEntries ae
      LEFT JOIN branches b ON b.id = ae.branchId
      LEFT JOIN customers c ON c.id = ae.customerId
      LEFT JOIN suppliers s ON s.id = ae.supplierId
      LEFT JOIN invoices i ON i.id = ae.invoiceId
      WHERE ${where}
      ORDER BY ae.entryDate DESC, ae.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  ) as LedgerRow[];

  const totalsRow = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(ae.revenue), 0) AS CHAR) AS revenue,
        CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS cost,
        CAST(COALESCE(SUM(ae.profit), 0) AS CHAR) AS profit,
        CAST(COALESCE(SUM(ae.amount), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ${where}
    `),
  )[0] ?? { cnt: 0, revenue: "0", cost: "0", profit: "0", amount: "0" };

  return {
    rows,
    total: Number(totalsRow.cnt ?? 0),
    totals: {
      revenue: toDbMoney(money(totalsRow.revenue ?? 0)),
      cost: toDbMoney(money(totalsRow.cost ?? 0)),
      profit: toDbMoney(money(totalsRow.profit ?? 0)),
      amount: toDbMoney(money(totalsRow.amount ?? 0)),
    },
  };
}

/* ============================ المركز المالي (ميزان مراجعة + ميزانية) ============================ */
// لقطة أرصدة مبسّطة/مشتقّة. ⚠️ الأرصدة (مدينون/دائنون) على مستوى الشركة (الحقل company-wide في
// customers/suppliers)؛ النقد والمخزون حسب الفرع المحدّد. حقوق الملكية مشتقّة (أصول − خصوم) ⇒
// الميزانية تتوازن بناءً. النقد تقديريّ (صافي المقبوضات COMPLETED). الأصول بالتكلفة (بلا إهلاك متراكم).

export interface FinancialPosition {
  cash: string;
  arDebit: string; // ذمم مدينة (عملاء يدينون لنا)
  arCredit: string; // سُلف العملاء (دفعوا زيادة)
  inventory: string;
  fixedAssets: string;
  apCredit: string; // ذمم دائنة (نحن نَدين للموردين)
  apDebit: string; // سُلف للموردين
  totalAssets: string;
  totalLiabilities: string;
  equity: string;
  branchScoped: boolean;
}

export async function getFinancialPosition(opts: { branchId?: number } = {}): Promise<FinancialPosition> {
  const db = getDb();
  const zero = "0";
  const empty: FinancialPosition = {
    cash: zero, arDebit: zero, arCredit: zero, inventory: zero, fixedAssets: zero,
    apCredit: zero, apDebit: zero, totalAssets: zero, totalLiabilities: zero, equity: zero,
    branchScoped: !!opts.branchId,
  };
  if (!db) return empty;

  const bId = opts.branchId;

  const ar = rowsOf(await db.execute(sql`
    SELECT
      CAST(COALESCE(SUM(CASE WHEN currentBalance > 0 THEN currentBalance ELSE 0 END), 0) AS CHAR) AS d,
      CAST(COALESCE(SUM(CASE WHEN currentBalance < 0 THEN -currentBalance ELSE 0 END), 0) AS CHAR) AS c
    FROM customers WHERE isActive = TRUE
  `))[0] ?? { d: "0", c: "0" };

  const ap = rowsOf(await db.execute(sql`
    SELECT
      CAST(COALESCE(SUM(CASE WHEN currentBalance > 0 THEN currentBalance ELSE 0 END), 0) AS CHAR) AS c,
      CAST(COALESCE(SUM(CASE WHEN currentBalance < 0 THEN -currentBalance ELSE 0 END), 0) AS CHAR) AS d
    FROM suppliers WHERE isActive = TRUE
  `))[0] ?? { c: "0", d: "0" };

  const inv = rowsOf(await db.execute(sql`
    SELECT CAST(COALESCE(SUM(bs.quantity * pv.costPrice), 0) AS CHAR) AS v
    FROM branchStock bs JOIN productVariants pv ON pv.id = bs.variantId
    ${bId ? sql`WHERE bs.branchId = ${bId}` : sql``}
  `))[0] ?? { v: "0" };

  const cashRow = rowsOf(await db.execute(sql`
    SELECT CAST(COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0) AS CHAR) AS v
    FROM receipts WHERE receiptStatus = 'COMPLETED' ${bId ? sql`AND branchId = ${bId}` : sql``}
  `))[0] ?? { v: "0" };

  const fa = rowsOf(await db.execute(sql`
    SELECT CAST(COALESCE(SUM(purchaseValue), 0) AS CHAR) AS v
    FROM fixedAssets WHERE assetStatus <> 'disposed' ${bId ? sql`AND branchId = ${bId}` : sql``}
  `))[0] ?? { v: "0" };

  const cash = money(cashRow.v ?? 0);
  const arDebit = money(ar.d ?? 0);
  const arCredit = money(ar.c ?? 0);
  const inventory = money(inv.v ?? 0);
  const fixedAssets = money(fa.v ?? 0);
  const apCredit = money(ap.c ?? 0);
  const apDebit = money(ap.d ?? 0);

  // الأصول = نقد + مدينون + سُلف للموردين (ذمة لنا) + مخزون + أصول ثابتة.
  const totalAssets = cash.add(arDebit).add(apDebit).add(inventory).add(fixedAssets);
  // الخصوم = دائنون + سُلف العملاء (ذمة علينا).
  const totalLiabilities = apCredit.add(arCredit);
  const equity = totalAssets.sub(totalLiabilities);

  return {
    cash: toDbMoney(cash),
    arDebit: toDbMoney(arDebit),
    arCredit: toDbMoney(arCredit),
    inventory: toDbMoney(inventory),
    fixedAssets: toDbMoney(fixedAssets),
    apCredit: toDbMoney(apCredit),
    apDebit: toDbMoney(apDebit),
    totalAssets: toDbMoney(totalAssets),
    totalLiabilities: toDbMoney(totalLiabilities),
    equity: toDbMoney(equity),
    branchScoped: !!bId,
  };
}

/* ============================ التدفّق النقدي (أساس نقدي مباشر) ============================ */

const PAY_METHOD_AR: Record<string, string> = {
  CASH: "نقد", CARD: "بطاقة", CHECK: "صكّ", TRANSFER: "تحويل", WALLET: "محفظة",
};

export interface CashFlowLine { key: string; label: string; amount: string }
export interface CashFlowResult {
  period: { from: string; to: string };
  inflows: CashFlowLine[];
  outflows: CashFlowLine[];
  totalIn: string;
  totalOut: string;
  net: string;
}

export async function getCashFlow(opts: { from: string; to: string; branchId?: number }): Promise<CashFlowResult> {
  const db = getDb();
  const base: CashFlowResult = {
    period: { from: opts.from, to: opts.to }, inflows: [], outflows: [], totalIn: "0", totalOut: "0", net: "0",
  };
  if (!db) return base;

  const rows = rowsOf(await db.execute(sql`
    SELECT r.direction AS direction, r.paymentMethod AS method, CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
    FROM receipts r
    WHERE r.receiptStatus = 'COMPLETED'
      AND DATE(r.createdAt) >= ${opts.from} AND DATE(r.createdAt) <= ${opts.to}
      ${opts.branchId ? sql`AND r.branchId = ${opts.branchId}` : sql``}
    GROUP BY r.direction, r.paymentMethod
  `));

  const inflows: CashFlowLine[] = [];
  const outflows: CashFlowLine[] = [];
  let totalIn = money(0);
  let totalOut = money(0);
  for (const r of rows) {
    const amt = money(r.amount ?? 0);
    const line: CashFlowLine = { key: String(r.method), label: PAY_METHOD_AR[String(r.method)] ?? String(r.method), amount: toDbMoney(amt) };
    if (r.direction === "IN") { inflows.push(line); totalIn = totalIn.add(amt); }
    else { outflows.push(line); totalOut = totalOut.add(amt); }
  }

  return {
    period: { from: opts.from, to: opts.to },
    inflows,
    outflows,
    totalIn: toDbMoney(totalIn),
    totalOut: toDbMoney(totalOut),
    net: toDbMoney(totalIn.sub(totalOut)),
  };
}
