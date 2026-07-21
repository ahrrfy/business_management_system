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
import { reconcileCustomerBalances, reconcileSupplierBalances } from "./reconcileService";

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

// مُصدَّرة (تدقيق ١٧/٧): مصدر الحقيقة الوحيد لصيغة الربح — يستعملها الإقفال السنوي (yearEndService)
// كي لا تنحرف أرقام الإقفال عن قائمة الدخل المعروضة للمالك.
export async function plSnapshot(from: string, to: string, branchId?: number): Promise<PLSnapshot> {
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
        -- PURCHASE-RETURN (تدقيق ٢/٧): مرتجع الشراء يُقيَّد أيضاً بنوع RETURN لكن بـsupplierId (لا
        -- invoiceId/customerId)، وقيمته على cost سالبة ⇒ كان يُخفِّض COGS ويَنفخ الربح بلا أي بيع.
        -- COGS = تكلفة المُباع فقط ⇒ نستثني مرتجعات الشراء (supplierId NOT NULL) ونُبقي مرتجعات البيع.
        AND (ae.entryType <> 'RETURN' OR ae.supplierId IS NULL)
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

  // FA-02 (تكامل الأصول↔P&L، تحقيق عدائي ٢٠/٦): ربح/خسارة التصرّف بالأصول قيدُ ADJUST بمفتاح
  // ASSET_DISP_PL، revenue=الربح موقَّعاً (موجب ربح/سالب خسارة). كان يُهمَل في P&L (يَجمع SALE/RETURN
  // فقط) ⇒ صافي الربح لا يَعكس بيع الأصول. نَجمعه هنا ونُدرجه سطراً غير تشغيليّ في صافي الربح.
  const dpl = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.revenue), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'ADJUST' AND ae.dedupeKey LIKE 'ASSET_DISP_PL:%'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // FI-02: مصروف الإهلاك المُرحَّل (ADJUST بمفتاح DEPR، cost=الإهلاك الشهريّ) — مصروف غير نقديّ.
  const dep = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'ADJUST' AND ae.dedupeKey LIKE 'DEPR:%'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // delivery-cod: أجور التوصيل (DELIVERY_FEE، netting من التحصيل) + شطب عجز العهدة (DELIVERY_WRITEOFF،
  // بلا نقد) — خسائر بالكلفة تَخفض صافي الربح. (DELIVERY_DISPATCH/REMIT حركات عهدة revenue=cost=0 ⇒ لا أثر.)
  const dl = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType IN ('DELIVERY_FEE', 'DELIVERY_WRITEOFF')
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // exchange-house: عمولات الصيرفة (EXCHANGE_FEE، cost) — مصروف تشغيليّ يَخفض صافي الربح.
  const xf = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'EXCHANGE_FEE'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // exchange-house: فرق صرف محقَّق (EXCHANGE_FX_DIFF، amount موقَّع: موجب=مكسب/سالب=خسارة) — بند غير تشغيليّ.
  // معزول عن إيراد البيع (SALE/RETURN فقط)، لكنه يُؤثّر في صافي الربح (مكسب/خسارة مالية حقيقية).
  const xfx = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.amount), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'EXCHANGE_FX_DIFF'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // STOCKTAKE (تدقيق ٢/٧): فروقات الجرد تُقيَّد ADJUST بمفتاح STOCKTAKE:%، profit موقَّع
  // (سالب=عجز/خسارة، موجب=زيادة/مكسب). كانت مُغفَلة كلياً من قائمة الدخل ⇒ خسائر الجرد لا تُخفض الربح.
  const stk = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.profit), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'ADJUST' AND ae.dedupeKey LIKE 'STOCKTAKE:%'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // IQD-ROUND (تدقيق ٢/٧): تقريب النقد العراقي يُقيَّد ADJUST بمفتاح ADJUST:IQD:%، profit موقَّع
  // (موجب=مكسب تقريب لأعلى، سالب=تنازل عند التقريب لأسفل). كان مُغفَلاً ⇒ الإيراد/الربح ينحرفان بمجموع التقريب.
  const iqd = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.profit), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'ADJUST' AND ae.dedupeKey LIKE 'ADJUST:IQD:%'
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

  // FI-02: مصروف إهلاك الأصول الثابتة (غير نقديّ) — سطر مستقلّ يَخفض صافي الربح.
  const depExpense = money(dep.amount ?? 0);
  if (depExpense.gt(0)) {
    expenseLines.push({ key: "DEPRECIATION", label: "إهلاك الأصول الثابتة", amount: toDbMoney(depExpense) });
    totalExpenses = totalExpenses.add(depExpense);
  }

  // delivery-cod: أجور توصيل وعجز مناديب — سطر مستقلّ يَخفض صافي الربح (وإلا يُبالَغ في الربح).
  const deliveryLoss = money(dl.amount ?? 0);
  if (deliveryLoss.gt(0)) {
    expenseLines.push({ key: "DELIVERY_COST", label: "أجور توصيل وعجز مناديب", amount: toDbMoney(deliveryLoss) });
    totalExpenses = totalExpenses.add(deliveryLoss);
  }

  // FA-02: أثر صافٍ على الربح — الخسارة مصروفٌ موجب يَرفع totalExpenses، والربح سالبٌ (دخل) يَخفضه؛
  // وفي الحالتين netProfit = grossProfit − totalExpenses يَعكس ربح/خسارة الأصل صحيحاً.
  const disposalPL = money(dpl.amount ?? 0); // موجب=ربح، سالب=خسارة
  if (!disposalPL.isZero()) {
    const expenseEffect = disposalPL.neg();
    expenseLines.push({ key: "ASSET_DISPOSAL_PL", label: "صافي ربح/خسارة بيع أصول", amount: toDbMoney(expenseEffect) });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // exchange-house: عمولات صيرفة — سطر مصروف مستقلّ.
  const exchangeFee = money(xf.amount ?? 0);
  if (exchangeFee.gt(0)) {
    expenseLines.push({ key: "EXCHANGE_FEE", label: "عمولات صيرفة", amount: toDbMoney(exchangeFee) });
    totalExpenses = totalExpenses.add(exchangeFee);
  }

  // exchange-house: صافي فرق صرف العملات — موجب=مكسب (دخل يَخفض المصروفات)، سالب=خسارة (يَرفعها). نمط ASSET_DISP_PL.
  const exchangeFx = money(xfx.amount ?? 0); // موجب=مكسب
  if (!exchangeFx.isZero()) {
    const expenseEffect = exchangeFx.neg();
    expenseLines.push({ key: "EXCHANGE_FX_DIFF", label: "صافي فرق صرف العملات", amount: toDbMoney(expenseEffect) });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // STOCKTAKE: أثر فروقات الجرد على الربح — profit موقَّع (سالب=عجز)؛ التأثير كمصروف = −profit
  // (عجز ⇒ مصروف موجب يَخفض الربح، زيادة ⇒ مصروف سالب يَرفعه). نمط ASSET_DISP_PL/EXCHANGE_FX.
  const stocktakePL = money(stk.amount ?? 0);
  if (!stocktakePL.isZero()) {
    const expenseEffect = stocktakePL.neg();
    expenseLines.push({ key: "STOCKTAKE_ADJUST", label: "تسويات الجرد (عجز/زيادة)", amount: toDbMoney(expenseEffect) });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // IQD-ROUND: أثر تقريب النقد على الربح — profit موقَّع؛ التأثير كمصروف = −profit.
  const iqdRoundPL = money(iqd.amount ?? 0);
  if (!iqdRoundPL.isZero()) {
    const expenseEffect = iqdRoundPL.neg();
    expenseLines.push({ key: "IQD_ROUNDING", label: "تقريب النقد العراقي", amount: toDbMoney(expenseEffect) });
    totalExpenses = totalExpenses.add(expenseEffect);
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
  "DELIVERY_DISPATCH", "DELIVERY_REMIT", "DELIVERY_FEE", "DELIVERY_WRITEOFF",
  "EXCHANGE_DEPOSIT", "EXCHANGE_WITHDRAW", "EXCHANGE_FX_BUY", "EXCHANGE_SETTLE", "EXCHANGE_FEE", "EXCHANGE_FX_DIFF",
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
// الميزانية تتوازن بناءً. النقد تقديريّ (صافي المقبوضات COMPLETED). الأصول بصافي القيمة الدفترية
// NBV (التكلفة − الإهلاك المتراكم المُرحَّل، FI-02).

export interface FinancialPosition {
  cash: string;
  arDebit: string; // ذمم مدينة (عملاء يدينون لنا)
  arCredit: string; // سُلف العملاء (دفعوا زيادة)
  inventory: string;
  fixedAssets: string;
  apCredit: string; // ذمم دائنة (نحن نَدين للموردين)
  apDebit: string; // سُلف للموردين
  // FIN-05: سُلف العملاء على أوامر الشغل غير المُسلَّمة (عرابين مقبوضة نقداً لكن الإيراد لم يُعترف به بعد) —
  // التزامٌ على الشركة (خدمةٌ لم تُنجَز)، يقابل النقدَ الداخل فلا تتضخّم حقوق الملكية.
  customerAdvances: string;
  // exchange-house: صافي رصيدنا لدى الصرّافين (دينار + دولار×متوسط الكلفة) — موجب=أصل، سالب=خصم.
  exchangeDebit: string;
  exchangeCredit: string;
  totalAssets: string;
  totalLiabilities: string;
  equity: string;
  branchScoped: boolean;
  // FI-02: حارس انحراف مرئي — AR/AP يُقرآن من currentBalance القابل للتحوّل؛ نطابقه (قراءة فقط)
  // مع المُتوقَّع المُشتقّ عبر reconcile* فيظهر أيّ انحراف صامت بدل أن يُمرَّر بصمت في القوائم.
  arReconciled: boolean;
  apReconciled: boolean;
  arDriftCount: number;
  apDriftCount: number;
}

export async function getFinancialPosition(
  opts: { branchId?: number; verify?: boolean } = {}
): Promise<FinancialPosition> {
  const db = getDb();
  const zero = "0";
  const empty: FinancialPosition = {
    cash: zero, arDebit: zero, arCredit: zero, inventory: zero, fixedAssets: zero,
    apCredit: zero, apDebit: zero, customerAdvances: zero,
    exchangeDebit: zero, exchangeCredit: zero,
    totalAssets: zero, totalLiabilities: zero, equity: zero,
    branchScoped: !!opts.branchId,
    arReconciled: true, apReconciled: true, arDriftCount: 0, apDriftCount: 0,
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

  // بضاعة الأمانة (ش٤): تُستبعَد من أصول المخزون — ليست ملك المكتبة (تظهر التزاماً في AP بعد البيع فقط).
  const inv = rowsOf(await db.execute(sql`
    SELECT CAST(COALESCE(SUM(bs.quantity * pv.costPrice), 0) AS CHAR) AS v
    FROM branchStock bs
      JOIN productVariants pv ON pv.id = bs.variantId
      JOIN products p ON p.id = pv.productId
    WHERE p.isConsignment = false ${bId ? sql`AND bs.branchId = ${bId}` : sql``}
  `))[0] ?? { v: "0" };

  const cashRow = rowsOf(await db.execute(sql`
    SELECT CAST(COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0) AS CHAR) AS v
    FROM receipts WHERE receiptStatus = 'COMPLETED' ${bId ? sql`AND branchId = ${bId}` : sql``}
  `))[0] ?? { v: "0" };

  // FI-02: الأصول بصافي القيمة الدفترية NBV = التكلفة − الإهلاك المتراكم المُرحَّل (postMonthlyDepreciation).
  // #2 (تدقيق التثبيت): استبعاد 'retired' أيضاً — الأصل المشطوب سُجِّلت قيمته الدفترية المتبقّية خسارةً
  // في P&L عند الشطب، فبقاؤه في مجموع الأصول بـNBV يضخّم الأصول ويناقض الخسارة المُعترَف بها.
  const fa = rowsOf(await db.execute(sql`
    SELECT CAST(COALESCE(SUM(purchaseValue - accumulatedDepreciation), 0) AS CHAR) AS v
    FROM fixedAssets WHERE assetStatus NOT IN ('disposed', 'retired') ${bId ? sql`AND branchId = ${bId}` : sql``}
  `))[0] ?? { v: "0" };

  // FIN-05 (تدقيق ٢٠/٦ — نظير FI-01 لأوامر الشغل): العربون المقبوض على أمر شغل غير مُسلَّم يَرفع النقد
  // (أصل) عند الإنشاء عبر receipt(IN)+PAYMENT_IN، لكنه ليس إيراداً بعد (الخدمة لم تُنجَز) ⇒ بلا التزام
  // مقابل، كانت حقوق الملكية تتضخّم بمقدار العرابين المعلّقة. نحتسب التزام «سُلف العملاء» = مجموع
  // deposit على أوامر الشغل المفتوحة فقط: status IN (RECEIVED, IN_PROGRESS, READY) — أي ليست DELIVERED
  // (عندها يُضمّ العربون لـinvoice.paidAmount ويُعترَف إيراداً عبر قيد SALE) ولا CANCELLED (عندها
  // يُسترَدّ العربون نقداً receipt(OUT) فيخرج من النقد). شرط invoiceId IS NULL حارسٌ مزدوج ضدّ احتساب
  // عربون رُبِط بفاتورة مُسلَّمة (لا ازدواج). نطابق عمود workOrders.deposit الحقيقيّ. عزل الفرع كباقي البنود.
  const wa = rowsOf(await db.execute(sql`
    SELECT CAST(COALESCE(SUM(deposit), 0) AS CHAR) AS v
    FROM workOrders
    WHERE workOrderStatus IN ('RECEIVED', 'IN_PROGRESS', 'READY')
      AND invoiceId IS NULL
      ${bId ? sql`AND branchId = ${bId}` : sql``}
  `))[0] ?? { v: "0" };

  // exchange-house: صافي أرصدتنا لدى الصرّافين على مستوى الشركة (دينار + دولار مُقيَّماً بمتوسط الكلفة).
  // موجب لكل صيرفة ⇒ أصل (أموالنا لديها)، سالب ⇒ خصم (نَدين لها). نظير AR/AP — بلا عزل فرع.
  const ex = rowsOf(await db.execute(sql`
    SELECT
      CAST(COALESCE(SUM(CASE WHEN net > 0 THEN net ELSE 0 END), 0) AS CHAR) AS d,
      CAST(COALESCE(SUM(CASE WHEN net < 0 THEN -net ELSE 0 END), 0) AS CHAR) AS c
    FROM (SELECT (balanceIqd + balanceUsd * usdCostRate) AS net FROM exchangeHouses WHERE isActive = TRUE) t
  `))[0] ?? { d: "0", c: "0" };

  const cash = money(cashRow.v ?? 0);
  const arDebit = money(ar.d ?? 0);
  const arCredit = money(ar.c ?? 0);
  const inventory = money(inv.v ?? 0);
  const fixedAssets = money(fa.v ?? 0);
  const apCredit = money(ap.c ?? 0);
  const apDebit = money(ap.d ?? 0);
  const customerAdvances = money(wa.v ?? 0); // FIN-05: عرابين أوامر الشغل غير المُسلَّمة (التزام).
  const exchangeDebit = money(ex.d ?? 0); // أموالنا لدى الصرّافين (أصل).
  const exchangeCredit = money(ex.c ?? 0); // ما نَدين به للصرّافين (خصم).

  // الأصول = نقد + مدينون + سُلف للموردين (ذمة لنا) + مخزون + أصول ثابتة + رصيدنا لدى الصرّافين.
  const totalAssets = cash.add(arDebit).add(apDebit).add(inventory).add(fixedAssets).add(exchangeDebit);
  // الخصوم = دائنون + سُلف العملاء على الذمم + عرابين أوامر الشغل (FIN-05) + ما نَدين به للصرّافين.
  const totalLiabilities = apCredit.add(arCredit).add(customerAdvances).add(exchangeCredit);
  const equity = totalAssets.sub(totalLiabilities);

  // FI-02: حارس انحراف مرئي (قراءة فقط). الأرقام أعلاه تبقى من currentBalance؛ هذه إشارةٌ فقط.
  // verify=true افتراضياً؛ يَستطيع المستدعي تعطيلها للأداء (verify:false) فتُعتبر متّسقة بلا فحص.
  const verify = opts.verify ?? true;
  let arDrift: { length: number } = { length: 0 };
  let apDrift: { length: number } = { length: 0 };
  if (verify) {
    arDrift = await reconcileCustomerBalances();
    apDrift = await reconcileSupplierBalances();
  }

  return {
    cash: toDbMoney(cash),
    arDebit: toDbMoney(arDebit),
    arCredit: toDbMoney(arCredit),
    inventory: toDbMoney(inventory),
    fixedAssets: toDbMoney(fixedAssets),
    apCredit: toDbMoney(apCredit),
    apDebit: toDbMoney(apDebit),
    customerAdvances: toDbMoney(customerAdvances),
    exchangeDebit: toDbMoney(exchangeDebit),
    exchangeCredit: toDbMoney(exchangeCredit),
    totalAssets: toDbMoney(totalAssets),
    totalLiabilities: toDbMoney(totalLiabilities),
    equity: toDbMoney(equity),
    branchScoped: !!bId,
    arReconciled: arDrift.length === 0,
    apReconciled: apDrift.length === 0,
    arDriftCount: arDrift.length,
    apDriftCount: apDrift.length,
  };
}

/* ============================ التدفّق النقدي (أساس نقدي مباشر) ============================ */

const PAY_METHOD_AR: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة",
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

  // FIN-04 (تدقيق ٢٠/٦): توحيد أساس التاريخ. كانت هذه الدالة تُبوّب وتُرشّح على DATE(r.createdAt)
  // — وهو timestamp بتوقيت خادم MySQL المحليّ — بينما كل القوائم الأخرى (P&L/الأستاذ/المصروفات)
  // تُفتاح على entryDate (عمود DATE)، فينشأ أساسٌ مزدوج وانحراف عند حدود UTC. الإصلاح: نشتقّ تاريخ
  // العمل من قيد الدفتر المرتبط بالإيصال (ae.receiptId → ae.entryDate) — نفس الأساس الذي يفتاح عليه
  // الباقي — مع COALESCE احتياطيٍّ على DATE(r.createdAt) لأي إيصال نادر بلا قيد دفتر مرتبط (لا يُسقَط
  // صفّ أبداً، فلا يتغيّر مجموع النقد، بل يتّسق التبويب الزمنيّ فقط). LEFT JOIN يحفظ مجموعة الإيصالات
  // كما هي تماماً (قائدةً)، والربط على entryType النقديّ (PAYMENT_IN/OUT) يطابق قيد الإيصال الوحيد.
  const rows = rowsOf(await db.execute(sql`
    SELECT r.direction AS direction, r.paymentMethod AS method, CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
    FROM receipts r
    LEFT JOIN accountingEntries ae
      ON ae.receiptId = r.id AND ae.entryType IN ('PAYMENT_IN', 'PAYMENT_OUT')
    WHERE r.receiptStatus = 'COMPLETED'
      AND COALESCE(ae.entryDate, DATE(r.createdAt)) >= ${opts.from}
      AND COALESCE(ae.entryDate, DATE(r.createdAt)) <= ${opts.to}
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
