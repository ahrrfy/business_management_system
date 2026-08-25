// خدمة القوائم المالية (للقراءة فقط) — تُغذّي مركز التقارير.
// المصدر: جدول القيود accountingEntries + جدول المصروفات expenses (لا تخمين).
//
// ⚠️ افتراضات قائمة الأرباح والخسائر المبسّطة (تُعرض في رأس التقرير):
//  • الإيراد/تكلفة المبيعات: قيود SALE + RETURN (RETURN بقيم سالبة ⇒ صافٍ تلقائياً).
//    التكلفة = كلفة الفاتورة وقت البيع (قرار المالك: آخر تكلفة)، الضريبة 0%.
//  • المصروفات التشغيلية: سجلّ المصروفات (ACTIVE) مصنّفةً + الرواتب المستحقّة عبر حدث اعتماد المسيّر
//    (ACCRUAL/ACCRUAL_REVERSAL). **لا** تشمل صرف صافي الراتب أو تحويل الاستقطاعات؛ تلك تسوية التزام
//    وليست مصروف فترة. كما لا تشمل سداد ذمم الموردين (PAYMENT_OUT بـsupplierId)
//    لأنه تسويةُ التزامٍ لا مصروفُ فترة (تكلفته اعتُرف بها وقت البيع) ⇒ لا ازدواج.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";
import { MATERIALIZED_RECEIPT_STATUS_SQL } from "./cash/cashAvailability";
import {
  reconcileCustomerBalances,
  reconcileSupplierBalances,
} from "./reconcileService";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/** نسبة مئوية بقسمة آمنة (صفر المقام ⇒ "0.00"). */
function marginPct(
  numerator: ReturnType<typeof money>,
  denominator: ReturnType<typeof money>,
): string {
  if (denominator.isZero()) return "0.00";
  return numerator.div(denominator).times(100).toDecimalPlaces(2).toString();
}

// تسمياتٌ خاصّة بهذا التقرير (تشرح السياق: «رواتب (مُسجَّلة كمصروف)» ≠ مسير الأجور).
// تسمية الواجهة العامة للدلو في shared/expenseCategories.ts — لا تُوحَّدا: هذه تحمل معنىً إضافياً.
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

const JOURNAL_REVENUE_ROLES = new Set([
  "SALES_STATIONERY", "SALES_PRINT", "SALES_FLEX", "DELIVERY_REVENUE",
  "OTHER_REVENUE", "EXCHANGE_COMMISSION", "FX_GAIN", "ASSET_DISPOSAL_GAIN",
]);
const JOURNAL_EXPENSE_ROLES = new Set([
  "SALARIES", "SOCIAL_SECURITY_EXPENSE", "EOS_EXPENSE", "RENT", "UTILITIES",
  "OPERATING_EXPENSE", "DELIVERY_EXPENSE", "GIFTS_PROMO", "DEPRECIATION_EXPENSE",
  "FX_LOSS", "ROUNDING_DIFF", "ASSET_DISPOSAL_LOSS", "PURCHASE_PRICE_VARIANCE",
  "LOSSES", "OTHER_EXPENSE",
]);
const JOURNAL_ROLE_AR: Record<string, string> = {
  SALARIES: "الأجور والرواتب المستحقّة",
  SOCIAL_SECURITY_EXPENSE: "حصة الشركة في الضمان الاجتماعي",
  EOS_EXPENSE: "مصروف نهاية الخدمة",
  RENT: "الإيجار",
  UTILITIES: "الخدمات (ماء/كهرباء)",
  OPERATING_EXPENSE: "مصروفات تشغيلية",
  DELIVERY_EXPENSE: "مصروفات التوصيل",
  GIFTS_PROMO: "هدايا وترويج",
  DEPRECIATION_EXPENSE: "إهلاك الأصول الثابتة",
  FX_LOSS: "خسائر فروق الصرف",
  ROUNDING_DIFF: "فروق التقريب",
  ASSET_DISPOSAL_LOSS: "خسائر استبعاد الأصول",
  PURCHASE_PRICE_VARIANCE: "فروق أسعار الشراء",
  LOSSES: "خسائر",
  OTHER_EXPENSE: "مصروفات أخرى",
};

export interface PLLine {
  key: string;
  label: string;
  amount: string;
}

export interface PLSnapshot {
  accountingBasis: "DOUBLE_ENTRY_ACTIVE" | "LEGACY_DERIVED";
  revenue: string;
  cogs: string;
  grossProfit: string;
  grossMarginPct: string;
  expenseLines: PLLine[]; // مصروفات تشغيلية مصنّفة + سطر الرواتب
  totalExpenses: string;
  netProfit: string;
  netMarginPct: string;
}

async function activeJournalPlSnapshot(
  db: NonNullable<ReturnType<typeof getDb>>,
  cycleId: string,
  from: string,
  to: string,
  branchId?: number,
): Promise<PLSnapshot> {
  const branch = branchId ? sql`AND je.branchId = ${branchId}` : sql``;
  const rows = rowsOf(await db.execute(sql`
    SELECT
      jl.role AS role,
      CAST(COALESCE(SUM(jl.debit), 0) AS CHAR) AS debit,
      CAST(COALESCE(SUM(jl.credit), 0) AS CHAR) AS credit
    FROM journalLines jl
    INNER JOIN journalEntries je ON je.id = jl.journalId
    WHERE je.status = 'POSTED'
      AND (je.sourceType IS NULL OR je.sourceType <> 'SHADOW_OPENING')
      AND je.cycleId = ${cycleId}
      AND je.entryDate >= ${from} AND je.entryDate <= ${to}
      ${branch}
    GROUP BY jl.role
  `)) as Array<{ role: string; debit: string; credit: string }>;

  let revenue = money(0);
  let cogs = money(0);
  let totalExpenses = money(0);
  const expenseLines: PLLine[] = [];
  for (const row of rows) {
    const role = String(row.role);
    const debit = money(row.debit ?? 0);
    const credit = money(row.credit ?? 0);
    if (JOURNAL_REVENUE_ROLES.has(role)) revenue = revenue.add(credit.sub(debit));
    if (role === "COGS") cogs = cogs.add(debit.sub(credit));
    if (JOURNAL_EXPENSE_ROLES.has(role)) {
      const amount = debit.sub(credit);
      if (!amount.isZero()) {
        expenseLines.push({ key: role, label: JOURNAL_ROLE_AR[role] ?? role, amount: toDbMoney(amount) });
      }
      totalExpenses = totalExpenses.add(amount);
    }
  }
  const grossProfit = revenue.sub(cogs);
  const netProfit = grossProfit.sub(totalExpenses);
  return {
    accountingBasis: "DOUBLE_ENTRY_ACTIVE",
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

export interface ProfitLossResult {
  period: { from: string; to: string };
  current: PLSnapshot;
  comparePeriod?: { from: string; to: string };
  previous?: PLSnapshot;
}

// مُصدَّرة (تدقيق ١٧/٧): مصدر الحقيقة الوحيد لصيغة الربح — يستعملها الإقفال السنوي (yearEndService)
// كي لا تنحرف أرقام الإقفال عن قائمة الدخل المعروضة للمالك.
export async function plSnapshot(
  from: string,
  to: string,
  branchId?: number,
): Promise<PLSnapshot> {
  const db = getDb();
  const empty: PLSnapshot = {
    accountingBasis: "LEGACY_DERIVED",
    revenue: "0",
    cogs: "0",
    grossProfit: "0",
    grossMarginPct: "0.00",
    expenseLines: [],
    totalExpenses: "0",
    netProfit: "0",
    netMarginPct: "0.00",
  };
  if (!db) return empty;

  // بعد تفعيل الدفتر يصبح journalEntries/journalLines المصدر المحاسبي الوحيد. في OFF/SHADOW
  // نبقي التقرير المشتق القديم صراحةً كي لا تختلط قيود الظل مع أرقام التشغيل قبل الاعتماد.
  const modeRow = rowsOf(await db.execute(sql`
    SELECT mode, shadowCycleId AS cycleId FROM doubleEntrySettings WHERE id = 1 LIMIT 1
  `))[0] as { mode?: string; cycleId?: string | null } | undefined;
  if (modeRow?.mode === "ACTIVE" && modeRow.cycleId) {
    return activeJournalPlSnapshot(db, modeRow.cycleId, from, to, branchId);
  }

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

  // الرواتب على أساس الاستحقاق: حدث الاعتماد يحمل الأجر المكتسب + حصة الشركة في الضمان +
  // استحقاق نهاية الخدمة، ويُؤرَّخ بنهاية فترة الخدمة. إعادة المسيّر للمسودة تنشئ ACCRUAL_REVERSAL
  // سالباً **بتاريخ الاستحقاق نفسه لا بيوم الضغط** ([`payroll/obligations.ts`](payroll/obligations.ts)
  // — «العكس يصحّح فترة الخدمة نفسها»): فالفترة التي حملت التكلفة هي التي تتخلّص منها، ولا تبقى
  // مُحمَّلةً بمصروفٍ سُحب. وأمانُ ذلك من `assertPeriodOpen` على تاريخ الاستحقاق: شهرٌ مُقفَل يمنع
  // العكس كلّياً (FORBIDDEN) بدل أن يُعدّل أرقامه بأثرٍ رجعيّ.
  // ⚠️ كان هذا التعليق يقول «في تاريخ العكس» — عكسَ ما تفعله الشيفرة، وهو ما ولّد وصفاً خاطئاً
  // لعلّةٍ غير موجودة في ورقة الإصلاحات (ب-٢). يحرس العقدَ الآن `payrollReversalExpense.test.ts`.
  // لا نقرأ PAYMENT_OUT إطلاقاً: صافي الراتب
  // وتحويل الضريبة/الضمان تسويات لالتزامات سبق الاعتراف بها، وضمّها هنا يكرر المصروف ويحوّله لأساس نقدي.
  const pr = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.amount), 0) AS CHAR) AS amount
      FROM payrollAccountingEvents pae
      INNER JOIN accountingEntries ae ON ae.id = pae.accountingEntryId
      WHERE pae.payrollAccountingEventKind IN (
        'ACCRUAL', 'ACCRUAL_REVERSAL', 'EOS_SETTLEMENT', 'EOS_SETTLEMENT_REVERSAL'
      )
        AND ae.entryType = 'ADJUST'
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

  // landed-cost على مرتجعات الشراء (متابعة #311، قرار المالك ٢٢/٧/٢٦): الشحن/الكمرك الوارد **غير مسترد**
  // عند إرجاع البضاعة للمورّد ⇒ نصيبُه من المرتجَع يُقيَّد خسارةً (ADJUST بمفتاح PURCHRET_LANDED، cost موجب).
  // سطرٌ مستقلّ خارج SALE/RETURN فلا يمسّ إيراد/تكلفة المبيعات، ويَخفض صافي الربح صحيحاً (حيّاً وفي إقفال السنة).
  const prl = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'ADJUST' AND ae.dedupeKey LIKE 'PURCHRET_LANDED:%'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // فرق سعر مرتجع الشراء عن WAVG الحالي محفوظ على قيد RETURN القانوني نفسه؛
  // profit موجب=مكسب، سالب=خسارة. لا ADJUST ثانياً كي لا يتكرر خط PPV في دفتر القيد المزدوج.
  const prv = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.profit), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'RETURN' AND ae.supplierId IS NOT NULL
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

  // INVENTORY-REVALUATION (تدقيق ٢٧/٧ — H3): إعادة تقييم المخزون عند تعديل التكلفة يدوياً تُقيَّد
  // ADJUST بمفتاح REVAL:%، profit موقَّع (موجب=مكسب لأن التكلفة ارتفعت، سالب=خسارة). لولا ضمّها هنا
  // لتحرّكت حقوق الملكية (المخزون الحيّ) دون أن تُفسَّر في قائمة الدخل — فخّ «قيد جديد يختفي من الربح».
  const revalRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.profit), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'ADJUST' AND ae.dedupeKey LIKE 'REVAL:%'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // GIFT_OUT (G-م٢، ٢٧/٧): هدايا صادرة للعملاء بالكلفة — مصروف ترويجيّ يَخفض صافي الربح. بلا invoiceId
  // (خارج وعاء العمولة). فخّ «قيد جديد يختفي من الربح» (خطر §٦ #1): يجب ضمّه هنا صراحةً وإلا حرّك حقوق
  // الملكية (المخزون الحيّ) دون أن يُفسَّر في قائمة الدخل.
  const gf = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'GIFT_OUT'
        AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
        ${branchAe}
    `),
  )[0] ?? { amount: "0" };

  // شطب البطاقة الرقمية يُثبت خسارةً فعلية حين استهلك المزوّد الرصيد وتعذّر إثبات البيع.
  const digitalWriteoff = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(ae.cost), 0) AS CHAR) AS amount
      FROM accountingEntries ae
      WHERE ae.entryType = 'DIGITAL_WRITEOFF'
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
  let totalExpenses = exRows.reduce(
    (acc, r) => acc.add(money(r.amount ?? 0)),
    money(0),
  );

  const payroll = money(pr.amount ?? 0);
  // العكس في فترة لاحقة يجب أن يظهر كتخفيض مصروف، لا أن يختفي لأن صافي الفترة سالب.
  if (!payroll.isZero()) {
    expenseLines.push({
      key: "PAYROLL",
      label: "تكلفة الرواتب المستحقّة",
      amount: toDbMoney(payroll),
    });
    totalExpenses = totalExpenses.add(payroll);
  }

  // خسائر المخزون (نثرية + تلف إنتاج) — سطر مستقلّ يضمن عدم تضخيم صافي الربح بإغفالها.
  const stockLoss = money(sl.amount ?? 0);
  if (stockLoss.gt(0)) {
    expenseLines.push({
      key: "STOCK_LOSS",
      label: "نثرية وتلف (مخزون)",
      amount: toDbMoney(stockLoss),
    });
    totalExpenses = totalExpenses.add(stockLoss);
  }

  // GIFT_OUT (G-م٢): هدايا وترويج للعملاء بالكلفة — سطر مصروف مستقلّ يَخفض صافي الربح.
  const giftExpense = money(gf.amount ?? 0);
  if (giftExpense.gt(0)) {
    expenseLines.push({
      key: "GIFTS",
      label: "هدايا وترويج",
      amount: toDbMoney(giftExpense),
    });
    totalExpenses = totalExpenses.add(giftExpense);
  }

  const digitalWriteoffExpense = money(digitalWriteoff.amount ?? 0);
  if (!digitalWriteoffExpense.isZero()) {
    expenseLines.push({
      key: "DIGITAL_CARD_WRITEOFF",
      label: "خسائر بطاقات رقمية غير مثبتة",
      amount: toDbMoney(digitalWriteoffExpense),
    });
    totalExpenses = totalExpenses.add(digitalWriteoffExpense);
  }

  // خسائر شحن/كمرك مرتجعات الشراء — سطر مستقلّ يَخفض صافي الربح (الشحن الوارد غير مسترد عند الإرجاع).
  const purchReturnLandedLoss = money(prl.amount ?? 0);
  if (purchReturnLandedLoss.gt(0)) {
    expenseLines.push({
      key: "PURCH_RETURN_LANDED",
      label: "خسائر شحن/كمرك مرتجعات الشراء",
      amount: toDbMoney(purchReturnLandedLoss),
    });
    totalExpenses = totalExpenses.add(purchReturnLandedLoss);
  }

  const purchaseReturnPriceVariance = money(prv.amount ?? 0); // موجب=مكسب
  if (!purchaseReturnPriceVariance.isZero()) {
    const expenseEffect = purchaseReturnPriceVariance.neg();
    expenseLines.push({
      key: "PURCH_RETURN_PRICE_VARIANCE",
      label: "فرق سعر مرتجع الشراء عن متوسط المخزون",
      amount: toDbMoney(expenseEffect),
    });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // FI-02: مصروف إهلاك الأصول الثابتة (غير نقديّ) — سطر مستقلّ يَخفض صافي الربح.
  const depExpense = money(dep.amount ?? 0);
  if (depExpense.gt(0)) {
    expenseLines.push({
      key: "DEPRECIATION",
      label: "إهلاك الأصول الثابتة",
      amount: toDbMoney(depExpense),
    });
    totalExpenses = totalExpenses.add(depExpense);
  }

  // delivery-cod: أجور توصيل وعجز مناديب — سطر مستقلّ يَخفض صافي الربح (وإلا يُبالَغ في الربح).
  const deliveryLoss = money(dl.amount ?? 0);
  if (deliveryLoss.gt(0)) {
    expenseLines.push({
      key: "DELIVERY_COST",
      label: "أجور توصيل وعجز مناديب",
      amount: toDbMoney(deliveryLoss),
    });
    totalExpenses = totalExpenses.add(deliveryLoss);
  }

  // FA-02: أثر صافٍ على الربح — الخسارة مصروفٌ موجب يَرفع totalExpenses، والربح سالبٌ (دخل) يَخفضه؛
  // وفي الحالتين netProfit = grossProfit − totalExpenses يَعكس ربح/خسارة الأصل صحيحاً.
  const disposalPL = money(dpl.amount ?? 0); // موجب=ربح، سالب=خسارة
  if (!disposalPL.isZero()) {
    const expenseEffect = disposalPL.neg();
    expenseLines.push({
      key: "ASSET_DISPOSAL_PL",
      label: "صافي ربح/خسارة بيع أصول",
      amount: toDbMoney(expenseEffect),
    });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // exchange-house: عمولات صيرفة — سطر مصروف مستقلّ.
  const exchangeFee = money(xf.amount ?? 0);
  if (exchangeFee.gt(0)) {
    expenseLines.push({
      key: "EXCHANGE_FEE",
      label: "عمولات صيرفة",
      amount: toDbMoney(exchangeFee),
    });
    totalExpenses = totalExpenses.add(exchangeFee);
  }

  // exchange-house: صافي فرق صرف العملات — موجب=مكسب (دخل يَخفض المصروفات)، سالب=خسارة (يَرفعها). نمط ASSET_DISP_PL.
  const exchangeFx = money(xfx.amount ?? 0); // موجب=مكسب
  if (!exchangeFx.isZero()) {
    const expenseEffect = exchangeFx.neg();
    expenseLines.push({
      key: "EXCHANGE_FX_DIFF",
      label: "صافي فرق صرف العملات",
      amount: toDbMoney(expenseEffect),
    });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // STOCKTAKE: أثر فروقات الجرد على الربح — profit موقَّع (سالب=عجز)؛ التأثير كمصروف = −profit
  // (عجز ⇒ مصروف موجب يَخفض الربح، زيادة ⇒ مصروف سالب يَرفعه). نمط ASSET_DISP_PL/EXCHANGE_FX.
  const stocktakePL = money(stk.amount ?? 0);
  if (!stocktakePL.isZero()) {
    const expenseEffect = stocktakePL.neg();
    expenseLines.push({
      key: "STOCKTAKE_ADJUST",
      label: "تسويات الجرد (عجز/زيادة)",
      amount: toDbMoney(expenseEffect),
    });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // IQD-ROUND: أثر تقريب النقد على الربح — profit موقَّع؛ التأثير كمصروف = −profit.
  const iqdRoundPL = money(iqd.amount ?? 0);
  if (!iqdRoundPL.isZero()) {
    const expenseEffect = iqdRoundPL.neg();
    expenseLines.push({
      key: "IQD_ROUNDING",
      label: "تقريب النقد العراقي",
      amount: toDbMoney(expenseEffect),
    });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  // INVENTORY-REVALUATION (H3): أثر إعادة تقييم المخزون على الربح — profit موقَّع؛ التأثير كمصروف
  // = −profit (مكسب ⇒ مصروف سالب يَرفع الربح، خسارة ⇒ مصروف موجب يَخفضه). نمط STOCKTAKE/IQD.
  const revalPL = money(revalRow.amount ?? 0);
  if (!revalPL.isZero()) {
    const expenseEffect = revalPL.neg();
    expenseLines.push({
      key: "INVENTORY_REVALUATION",
      label: "إعادة تقييم المخزون",
      amount: toDbMoney(expenseEffect),
    });
    totalExpenses = totalExpenses.add(expenseEffect);
  }

  const netProfit = grossProfit.sub(totalExpenses);

  return {
    accountingBasis: "LEGACY_DERIVED",
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
    result.previous = await plSnapshot(
      opts.compareFrom,
      opts.compareTo,
      opts.branchId,
    );
  }
  return result;
}

/* ============================ دفتر اليومية / الأستاذ ============================ */

export interface LedgerRow {
  id: number;
  entryDate: string;
  entryType: string;
  branchId: number | null;
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
  receiptId: number | null;
  voucherNumber: string | null;
  receiptReferenceNumber: string | null;
  receiptDirection: "IN" | "OUT" | null;
  paymentMethod: string | null;
  cashBucket: "DRAWER" | "TREASURY" | null;
  receiptStatus: string | null;
  receiptApprovalStatus: string | null;
  receiptBranchId: number | null;
  shiftId: number | null;
  shiftOwnerName: string | null;
  createdBy: number | null;
  createdByName: string | null;
  receiptCreatedBy: number | null;
  receiptCreatedByName: string | null;
  approvedBy: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
  dedupeKey: string | null;
  integrityWarnings: string[];
}

export interface GeneralLedgerResult {
  rows: LedgerRow[];
  total: number;
  totals: { revenue: string; cost: string; profit: string; amount: string };
}

const LEDGER_ENTRY_TYPES = [
  "SALE",
  "PURCHASE",
  "PAYMENT_IN",
  "PAYMENT_OUT",
  "RETURN",
  "ADJUST",
  "OPENING",
  "INTERNAL_USE",
  "WASTAGE",
  "GIFT_OUT",
  "CASH_HANDOVER",
  "CASH_TRANSFER_OUT",
  "CASH_TRANSFER_IN",
  "SHIFT_FLOAT_OUT",
  "TREASURY_FUNDING",
  "DELIVERY_DISPATCH",
  "DELIVERY_REMIT",
  "DELIVERY_FEE",
  "DELIVERY_WRITEOFF",
  "EXCHANGE_DEPOSIT",
  "EXCHANGE_WITHDRAW",
  "EXCHANGE_FX_BUY",
  "EXCHANGE_SETTLE",
  "EXCHANGE_FEE",
  "EXCHANGE_FX_DIFF",
  "DIGITAL_WALLET_DEPOSIT",
  "DIGITAL_WALLET_WITHDRAWAL",
  "DIGITAL_WALLET_CONSUMPTION",
  "DIGITAL_WALLET_REVERSAL",
  "DIGITAL_WALLET_ADJUSTMENT",
  "DIGITAL_WRITEOFF",
] as const;

export async function getGeneralLedger(opts: {
  from: string;
  to: string;
  branchId?: number;
  entryTypes?: string[];
  /** بحث نصّي حرّ — الطرف (عميل/مورّد)/الملاحظات/رقم الفاتورة المرتبطة. */
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<GeneralLedgerResult> {
  const db = getDb();
  if (!db)
    return {
      rows: [],
      total: 0,
      totals: { revenue: "0", cost: "0", profit: "0", amount: "0" },
    };

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conds = [
    sql`ae.entryDate >= ${opts.from}`,
    sql`ae.entryDate <= ${opts.to}`,
  ];
  if (opts.branchId) conds.push(sql`ae.branchId = ${opts.branchId}`);
  const types = (opts.entryTypes ?? []).filter((t) =>
    (LEDGER_ENTRY_TYPES as readonly string[]).includes(t),
  );
  if (types.length) {
    conds.push(
      sql`ae.entryType IN (${sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  }
  const q = opts.q?.trim();
  if (q) {
    // EXISTS بدل الاعتماد على أسماء أعمدة الجداول المُنضَمّة — الاستعلامان (الصفوف والإجماليات)
    // لا يشتركان بنفس الـJOINs (الإجماليات على accountingEntries وحدها)، فالبحث يجب أن يعمل من
    // customerId/supplierId/invoiceId الخام مباشرةً بلا افتراض وجود alias الجدول المُنضَمّ.
    const like = `%${q}%`;
    conds.push(sql`(
      ae.notes LIKE ${like}
      OR EXISTS (SELECT 1 FROM customers c2 WHERE c2.id = ae.customerId AND c2.name LIKE ${like})
      OR EXISTS (SELECT 1 FROM suppliers s2 WHERE s2.id = ae.supplierId AND s2.name LIKE ${like})
      OR EXISTS (SELECT 1 FROM invoices i2 WHERE i2.id = ae.invoiceId AND i2.invoiceNumber LIKE ${like})
    )`);
  }
  const where = sql.join(conds, sql` AND `);

  const rawRows = rowsOf(
    await db.execute(sql`
      SELECT
        ae.id AS id,
        DATE_FORMAT(ae.entryDate, '%Y-%m-%d') AS entryDate,
        ae.entryType AS entryType,
        ae.branchId AS branchId,
        b.name AS branchName,
        CAST(ae.revenue AS CHAR) AS revenue,
        CAST(ae.cost AS CHAR) AS cost,
        CAST(ae.profit AS CHAR) AS profit,
        CAST(ae.amount AS CHAR) AS amount,
        COALESCE(c.name, s.name) AS partyName,
        ae.invoiceId AS invoiceId,
        i.invoiceNumber AS invoiceNumber,
        ae.purchaseOrderId AS purchaseOrderId,
        ae.notes AS notes,
        ae.receiptId AS receiptId,
        r.voucherNumber AS voucherNumber,
        r.referenceNumber AS receiptReferenceNumber,
        r.direction AS receiptDirection,
        r.paymentMethod AS paymentMethod,
        r.cashBucket AS cashBucket,
        r.receiptStatus AS receiptStatus,
        r.receiptApprovalStatus AS receiptApprovalStatus,
        r.branchId AS receiptBranchId,
        r.shiftId AS shiftId,
        shiftOwner.name AS shiftOwnerName,
        ae.createdBy AS createdBy,
        COALESCE(ae.createdByNameSnapshot, entryUser.name, entryUser.username) AS createdByName,
        r.createdBy AS receiptCreatedBy,
        COALESCE(receiptUser.name, receiptUser.username) AS receiptCreatedByName,
        r.approvedBy AS approvedBy,
        COALESCE(approver.name, approver.username) AS approvedByName,
        DATE_FORMAT(r.approvedAt, '%Y-%m-%d %H:%i:%s') AS approvedAt,
        DATE_FORMAT(ae.createdAt, '%Y-%m-%d %H:%i:%s') AS createdAt,
        ae.dedupeKey AS dedupeKey
      FROM accountingEntries ae
      LEFT JOIN branches b ON b.id = ae.branchId
      LEFT JOIN customers c ON c.id = ae.customerId
      LEFT JOIN suppliers s ON s.id = ae.supplierId
      LEFT JOIN invoices i ON i.id = ae.invoiceId
      LEFT JOIN receipts r ON r.id = ae.receiptId
      LEFT JOIN users entryUser ON entryUser.id = ae.createdBy
      LEFT JOIN users receiptUser ON receiptUser.id = r.createdBy
      LEFT JOIN users approver ON approver.id = r.approvedBy
      LEFT JOIN shifts sh ON sh.id = r.shiftId
      LEFT JOIN users shiftOwner ON shiftOwner.id = sh.userId
      WHERE ${where}
      ORDER BY ae.entryDate DESC, ae.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  ) as Array<Omit<LedgerRow, "integrityWarnings">>;

  const rows: LedgerRow[] = rawRows.map((row) => {
    const integrityWarnings: string[] = [];
    if (!row.createdBy && !row.createdByName && !row.receiptCreatedBy)
      integrityWarnings.push("ACTOR_MISSING");
    if (row.receiptId && !row.receiptStatus)
      integrityWarnings.push("RECEIPT_MISSING");
    if (
      row.paymentMethod === "CASH" &&
      row.cashBucket === "DRAWER" &&
      !row.shiftId
    ) {
      integrityWarnings.push("DRAWER_SHIFT_MISSING");
    }
    if (row.receiptApprovalStatus && row.receiptApprovalStatus !== "APPROVED") {
      integrityWarnings.push("APPROVAL_INCOMPLETE");
    }
    if (
      row.branchId &&
      row.receiptBranchId &&
      row.branchId !== row.receiptBranchId
    ) {
      integrityWarnings.push("BRANCH_MISMATCH");
    }
    return { ...row, integrityWarnings };
  });

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
  card: string;
  check: string;
  transfer: string;
  wallet: string;
  /**
   * مراجعة PR #495 — **رصيد زين (TELECOM)**: طريقة دفعٍ خامسة أدخلتها منظومة الاستقبال، ورصيدها
   * أصلٌ حقيقيّ مشتقّ (نفس تعريف `cardAccountService`: Σ الإيصالات المعتمدة الموقَّعة). كانت
   * التجميعات تعدّ CASH/CARD/CHECK/TRANSFER/WALLET فقط ⇒ كلّ قبضِ رصيدٍ يرفع النقدَ صفراً
   * ويُبخَس به إجمالي الأصول وحقوق الملكية بكامل الرصيد المستحقّ لدى زين.
   */
  telecom: string;
  digitalWalletAsset: string; // رصيدنا النقدي لدى مزوّدي البطاقات مسبقة الدفع
  arDebit: string; // ذمم مدينة (عملاء يدينون لنا)
  arCredit: string; // سُلف العملاء (دفعوا زيادة)
  inventory: string;
  fixedAssets: string;
  apCredit: string; // ذمم دائنة (نحن نَدين للموردين)
  apDebit: string; // سُلف للموردين
  /** صافي حساب تسوية الشراء النقدي حين يكون مديناً (مبلغ واجب الاسترداد من المورد). */
  cashPurchaseClearingDebit: string;
  /** صافي حساب تسوية الشراء النقدي حين يكون دائناً (صرف نقدي معلّق بلا ذمة مورد). */
  cashPurchaseClearingCredit: string;
  // FIN-05: سُلف العملاء على أوامر الشغل غير المُسلَّمة (عرابين مقبوضة نقداً لكن الإيراد لم يُعترف به بعد) —
  // التزامٌ على الشركة (خدمةٌ لم تُنجَز)، يقابل النقدَ الداخل فلا تتضخّم حقوق الملكية.
  // مراجعة PR #495: يشمل الآن **عرابين الطلبات المحفوظة المفتوحة** (`draftAdvances` أدناه).
  customerAdvances: string;
  /**
   * مراجعة PR #495 — عرابين المسوّدات المفتوحة (ش٤): القبض يُنشئ إيصال IN وقيد PAYMENT_IN فيرتفع
   * النقد فوراً، وعمداً لا يمسّ ذمّة العميل (المسوّدة ليست فاتورةً بعد). فبلا التزامٍ مقابل كانت
   * كلّ مسوّدةٍ ممولّة تضخّم حقوق الملكية حتى تُثبَّت أو يُردّ عربونها. = Σ(COLLECTION − REFUND)
   * على مسوّدات `OPEN` (المُثبَّتة صارت `paidAmount` على فواتيرها، والملغاة رُدّت نقداً).
   * مُفصَحٌ عنه مستقلاً **وداخلٌ** في `customerAdvances` (تبويبٌ لا تكرار).
   */
  draftAdvances: string;
  // exchange-house: صافي رصيدنا لدى الصرّافين (دينار + دولار×متوسط الكلفة) — موجب=أصل، سالب=خصم.
  exchangeDebit: string;
  exchangeCredit: string;
  /**
   * تدقيق ٦/٨ (ث٨) — **عهدة مناديب التوصيل**: مالُ فواتيرَ خرجت بضاعتُها واعتُرف بإيرادها
   * لحظة الإرسال، والنقد بيد المندوب حتى يورّده. كان **غائباً عن الأصول كلّها**: لا نقد (لا
   * إيصال بعد) ولا ذمّة عميل (فاتورة COD) ⇒ نقصٌ صامت في الأصول تبتلعه حقوق الملكية. أصلٌ
   * صريح الآن (Σ أرصدة الجهات الموجبة) — لا دينار بلا تبويب.
   */
  deliveryFloat: string;
  /**
   * مراجعة PR #495 — **الجزء المدعوم بعميلٍ مسجَّل من عهدة المناديب** (مُستبعَدٌ من الأصول أعلاه):
   * فاتورة COD بعميلٍ مسجَّل ترفع `customers.currentBalance` لحظة البيع (ذمّة مدينة) ثم يرفع
   * الإسنادُ نفسَ المبلغ في `deliveryParties.currentBalance` ⇒ جمعُهما معاً يحتسب **ذمّةً واحدة
   * مرّتين** طوال وجودها بالطريق (والتوريد يخفض الاثنين). `deliveryFloat` صار صافي العهدة **غير**
   * المدعومة بذمّةٍ (فواتير أوامر الشغل/الزبون العابر — customerId=NULL)، وهذا الحقل يُفصح عن
   * المستبعَد كي يبقى لكل دينارٍ تبويبٌ ظاهر لا حذفٌ صامت.
   */
  deliveryFloatCustomerBacked: string;
  /** ١٠/٨ — أمانات أجور توصيل قُبضت في الدرج ولم تُصرف للمندوب بعد (خصم؛ نقدها ضمن «النقد»). */
  deliveryFeeHeldLiability: string;
  /** أجور توصيل مكتسبة لجهات التوصيل ولم تُدفع بعد (SHOP؛ COUNTER ضمن الأمانات أعلاه). */
  deliveryFeeDueLiability: string;
  /** صافي دائن أجر الموظفين المستحق من الدفتر المزدوج (الدائن − المدين). */
  accruedSalaryLiability: string;
  /** صافي دائن ضريبة الرواتب المطلوب تحويلها. */
  payrollTaxPayable: string;
  /** صافي دائن ضمان الموظف ورب العمل المطلوب تحويله. */
  socialSecurityPayable: string;
  /** صافي مخصص نهاية الخدمة القائم. */
  eosProvision: string;
  /** رصيد السلف المستحق على الموظفين (طبيعة مدينة). */
  employeeAdvanceReceivable: string;
  dueFromBranches: string;
  dueToBranches: string;
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
  /** تاريخ اللقطة المطلوب (YYYY-MM-DD) — null يعني «الآن» (الافتراضي القديم بلا تغيير). */
  asOf: string | null;
  /** يُملأ فقط حين asOf ماضٍ — يوضّح أنّ بعض البنود تبقى حاليةً (انظر تعليق asOf أدناه). */
  historicalNote: string | null;
  interbranchNote: string | null;
}

export async function getFinancialPosition(
  opts: { branchId?: number; verify?: boolean; asOf?: string } = {},
): Promise<FinancialPosition> {
  const db = getDb();
  const zero = "0";
  const empty: FinancialPosition = {
    cash: zero,
    card: zero,
    check: zero,
    transfer: zero,
    wallet: zero,
    telecom: zero,
    digitalWalletAsset: zero,
    arDebit: zero,
    arCredit: zero,
    inventory: zero,
    fixedAssets: zero,
    apCredit: zero,
    apDebit: zero,
    cashPurchaseClearingDebit: zero,
    cashPurchaseClearingCredit: zero,
    customerAdvances: zero,
    draftAdvances: zero,
    exchangeDebit: zero,
    exchangeCredit: zero,
    deliveryFloat: zero,
    deliveryFloatCustomerBacked: zero,
    deliveryFeeHeldLiability: zero,
    deliveryFeeDueLiability: zero,
    accruedSalaryLiability: zero,
    payrollTaxPayable: zero,
    socialSecurityPayable: zero,
    eosProvision: zero,
    employeeAdvanceReceivable: zero,
    dueFromBranches: zero,
    dueToBranches: zero,
    totalAssets: zero,
    totalLiabilities: zero,
    equity: zero,
    branchScoped: !!opts.branchId,
    arReconciled: true,
    apReconciled: true,
    arDriftCount: 0,
    apDriftCount: 0,
    asOf: opts.asOf ?? null,
    historicalNote: null,
    interbranchNote: null,
  };
  if (!db) return empty;

  const bId = opts.branchId;
  const asOf = opts.asOf;

  // asOf (متابعة §٩): النقد/الذمم يُعادان بناؤهما من الدفتر (accountingEntries، مؤرَّخٌ فعلياً) حتى
  // تاريخ اللقطة — مطابقةً لصيَغ reconcileCustomerBalances/reconcileSupplierBalances الثابتتَي الصحّة،
  // لكن بحدٍّ زمنيّ entryDate<=asOf بدل قراءة currentBalance الحيّ (الذي يشمل كل شيء حتى الآن دائماً).
  // ⚠️ المخزون/الأصول الثابتة/عرابين أوامر الشغل/رصيد الصيرفة **تبقى حاليةً دائماً**: لا جدول تاريخ
  // تكلفة (`costPrice` قيمة حيّة وحيدة — التكلفة «آخر تكلفة» بقرار المالك §٩)، ولا جدول حالة أوامر شغل
  // تاريخية ⇒ لا يمكن إعادة بنائها لتاريخٍ ماضٍ بلا تخمين. مطابقٌ لقرار MonthlyClosePack السابق
  // («لقطة الذمم الحالية... لا يمكن إعادة بنائها تاريخياً») — نفس الأصول تنطبق هنا؛ الفرق أنّ AR/AP/النقد
  // *يمكن* بناؤها من الدفتر فبُنيت، وما تبقّى مُفصَحٌ عنه بـhistoricalNote بدل أن يُعرَض بصمت كأنه تاريخيّ.
  const isHistorical = !!asOf;

  let ar: { d?: string; c?: string };
  let ap: { c?: string; d?: string };
  let cashRow: {
    cash?: string;
    card?: string;
    cheque?: string;
    transfer?: string;
    wallet?: string;
    telecom?: string;
  };

  if (isHistorical) {
    ar = rowsOf(
      await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN t.net > 0 THEN t.net ELSE 0 END), 0) AS CHAR) AS d,
        CAST(COALESCE(SUM(CASE WHEN t.net < 0 THEN -t.net ELSE 0 END), 0) AS CHAR) AS c
      FROM (
        SELECT ae.customerId AS customerId, SUM(CASE
          WHEN ae.entryType = 'SALE' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'RETURN' AND ae.supplierId IS NULL THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'ADJUST' AND ae.dedupeKey LIKE 'ADJUST:IQD:%' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'PAYMENT_IN' THEN -CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'PAYMENT_OUT' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'OPENING' THEN CAST(ae.amount AS DECIMAL(15,2))
          ELSE 0 END) AS net
        FROM accountingEntries ae
        WHERE ae.customerId IS NOT NULL AND ae.entryDate <= ${asOf}
          -- عربون أمر الشغل (WO deposit) لا يَمسّ AR وقت القبض (نظير استثناء reconcileCustomerBalances)
          AND (ae.receiptId IS NULL OR ae.receiptId NOT IN (
            SELECT id FROM receipts WHERE workOrderId IS NOT NULL
          ))
        GROUP BY ae.customerId
      ) t
    `),
    )[0] ?? { d: "0", c: "0" };

    ap = rowsOf(
      await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN t.net > 0 THEN t.net ELSE 0 END), 0) AS CHAR) AS c,
        CAST(COALESCE(SUM(CASE WHEN t.net < 0 THEN -t.net ELSE 0 END), 0) AS CHAR) AS d
      FROM (
        SELECT ae.supplierId AS supplierId, SUM(CASE
          WHEN ae.purchaseLiabilityAccount = 'CASH_CLEARING' THEN 0
          WHEN ae.entryType = 'PURCHASE' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'PAYMENT_OUT' THEN -CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'PAYMENT_IN' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'RETURN' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'OPENING' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'EXCHANGE_SETTLE' THEN -CAST(ae.amount AS DECIMAL(15,2))
          ELSE 0 END) AS net
        FROM accountingEntries ae
        WHERE ae.supplierId IS NOT NULL AND ae.entryDate <= ${asOf}
        GROUP BY ae.supplierId
      ) t
    `),
    )[0] ?? { c: "0", d: "0" };

    cashRow = rowsOf(
      await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN r.paymentMethod = 'CASH' THEN CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END ELSE 0 END), 0) AS CHAR) AS cash,
        CAST(COALESCE(SUM(CASE WHEN r.paymentMethod = 'CARD' THEN CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END ELSE 0 END), 0) AS CHAR) AS card,
        CAST(COALESCE(SUM(CASE WHEN r.paymentMethod = 'CHECK' THEN CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END ELSE 0 END), 0) AS CHAR) AS cheque,
        CAST(COALESCE(SUM(CASE WHEN r.paymentMethod = 'TRANSFER' THEN CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END ELSE 0 END), 0) AS CHAR) AS transfer,
        CAST(COALESCE(SUM(CASE WHEN r.paymentMethod = 'WALLET' THEN CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END ELSE 0 END), 0) AS CHAR) AS wallet,
        -- مراجعة PR #495: رصيد زين أصلٌ مثل بقية الوسائل (كان غائباً كلّياً عن اللقطة).
        CAST(COALESCE(SUM(CASE WHEN r.paymentMethod = 'TELECOM' THEN CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END ELSE 0 END), 0) AS CHAR) AS telecom
      FROM receipts r
      -- FIN-04: أساس التاريخ = تاريخ قيد الدفتر المرتبط (نفس أساس getCashFlow)، لا createdAt الخام.
      LEFT JOIN accountingEntries ae ON ae.receiptId = r.id AND ae.entryType IN ('PAYMENT_IN', 'PAYMENT_OUT')
      WHERE r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL} AND r.receiptApprovalStatus = 'APPROVED'
        AND COALESCE(ae.entryDate, DATE(r.createdAt)) <= ${asOf}
        ${bId ? sql`AND r.branchId = ${bId}` : sql``}
    `),
    )[0] ?? {
      cash: "0",
      card: "0",
      cheque: "0",
      transfer: "0",
      wallet: "0",
      telecom: "0",
    };
  } else {
    ar = rowsOf(
      await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN currentBalance > 0 THEN currentBalance ELSE 0 END), 0) AS CHAR) AS d,
        CAST(COALESCE(SUM(CASE WHEN currentBalance < 0 THEN -currentBalance ELSE 0 END), 0) AS CHAR) AS c
      FROM customers
    `),
    )[0] ?? { d: "0", c: "0" };

    ap = rowsOf(
      await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN currentBalance > 0 THEN currentBalance ELSE 0 END), 0) AS CHAR) AS c,
        CAST(COALESCE(SUM(CASE WHEN currentBalance < 0 THEN -currentBalance ELSE 0 END), 0) AS CHAR) AS d
      FROM suppliers
    `),
    )[0] ?? { c: "0", d: "0" };

    cashRow = rowsOf(
      await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'CASH' THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END ELSE 0 END), 0) AS CHAR) AS cash,
        CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'CARD' THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END ELSE 0 END), 0) AS CHAR) AS card,
        CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'CHECK' THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END ELSE 0 END), 0) AS CHAR) AS cheque,
        CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'TRANSFER' THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END ELSE 0 END), 0) AS CHAR) AS transfer,
        CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'WALLET' THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END ELSE 0 END), 0) AS CHAR) AS wallet,
        -- مراجعة PR #495: رصيد زين (نفس تعريف cardAccountService: الموقَّع المعتمَد).
        CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'TELECOM' THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END ELSE 0 END), 0) AS CHAR) AS telecom
      FROM receipts
      WHERE receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL} AND receiptApprovalStatus = 'APPROVED'
        ${bId ? sql`AND branchId = ${bId}` : sql``}
    `),
    )[0] ?? {
      cash: "0",
      card: "0",
      cheque: "0",
      transfer: "0",
      wallet: "0",
      telecom: "0",
    };
  }

  // رصيد محافظ المزوّد أصل نقدي مستقل عن وسيلة دفع العملاء المسماة WALLET أعلاه.
  // لا نستبعد المحافظ المعطلة: التعطيل لا يمحو أصلاً قائماً. وعند اللقطة التاريخية
  // نعيد بناء الرصيد من الحركات المعتمدة بدلاً من قراءة الرصيد الحي.
  const digitalWalletRow = isHistorical
    ? (rowsOf(
        await db.execute(sql`
        SELECT CAST(COALESCE(SUM(
          CASE WHEN dwt.direction = 'IN' THEN dwt.amount ELSE -dwt.amount END
        ), 0) AS CHAR) AS v
        FROM digitalWalletTransactions dwt
        INNER JOIN digitalWallets dw ON dw.id = dwt.walletId
        WHERE dwt.status = 'ACTIVE'
          AND DATE(COALESCE(dwt.approvedAt, dwt.createdAt)) <= ${asOf}
          ${bId ? sql`AND dw.branchId = ${bId}` : sql``}
      `),
      )[0] ?? { v: "0" })
    : (rowsOf(
        await db.execute(sql`
        SELECT CAST(COALESCE(SUM(dw.currentBalance), 0) AS CHAR) AS v
        FROM digitalWallets dw
        WHERE 1 = 1 ${bId ? sql`AND dw.branchId = ${bId}` : sql``}
      `),
      )[0] ?? { v: "0" });

  // الشراء النقدي لا يمرّ بذمة المورد. يبقى بين إثبات المخزون واعتماد الصرف في حساب
  // تسوية مستقل، وقد ينقلب مديناً عند مرتجع لم يُستردّ نقده بعد.
  const cashPurchaseClearingRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(CASE
        WHEN ae.entryType = 'PAYMENT_OUT'
          THEN -CAST(ae.amount AS DECIMAL(15,2))
        ELSE CAST(ae.amount AS DECIMAL(15,2))
      END), 0) AS CHAR) AS v
      FROM accountingEntries ae
      WHERE ae.purchaseLiabilityAccount = 'CASH_CLEARING'
      ${bId ? sql`AND ae.branchId = ${bId}` : sql``}
      ${asOf ? sql`AND ae.entryDate <= ${asOf}` : sql``}
    `),
  )[0] ?? { v: "0" };

  // بضاعة الأمانة (ش٤): تُستبعَد من أصول المخزون — ليست ملك المكتبة (تظهر التزاماً في AP بعد البيع فقط).
  // P1-#1 (تقرير المراجعة ٢٥/٨، مراجعة Codex): الميزانية = المستقرّ في branchStock + الحمل بالطريق.
  // كانت هذه القراءة تستثني in-transit فيَنخفض الأصل زوراً طوال فترة النقل ثمّ يعود عند الاستلام.
  // نفس منطق `readInventoryValuation` — نُبقيه SQL خامّاً هنا كي يحترم فلترَ الفرع/التاريخ نفسه (bId).
  // فلترُ الفرع على in-transit = فرعُ المصدر (البضاعةُ في عهدته حتى تسلَّمها الوجهة، نمطُ قيد «عجز النقل»).
  const inv = rowsOf(
    await db.execute(sql`
    SELECT CAST(
      COALESCE(SUM(bs.quantity * pv.costPrice), 0)
      + COALESCE((
          SELECT SUM((stl.quantitySent - COALESCE(stl.quantityReceived, 0)) * pv2.costPrice)
          FROM stockTransfers st
          JOIN stockTransferLines stl ON stl.transferId = st.id
          JOIN productVariants pv2 ON pv2.id = stl.variantId
          JOIN products p2 ON p2.id = pv2.productId
          WHERE st.transferStatus = 'IN_TRANSIT'
            AND p2.isConsignment = false
            ${bId ? sql`AND st.fromBranchId = ${bId}` : sql``}
        ), 0)
    AS CHAR) AS v
    FROM branchStock bs
      JOIN productVariants pv ON pv.id = bs.variantId
      JOIN products p ON p.id = pv.productId
    WHERE p.isConsignment = false ${bId ? sql`AND bs.branchId = ${bId}` : sql``}
  `),
  )[0] ?? { v: "0" };

  // FI-02: الأصول بصافي القيمة الدفترية NBV = التكلفة − الإهلاك المتراكم المُرحَّل (postMonthlyDepreciation).
  // #2 (تدقيق التثبيت): استبعاد 'retired' أيضاً — الأصل المشطوب سُجِّلت قيمته الدفترية المتبقّية خسارةً
  // في P&L عند الشطب، فبقاؤه في مجموع الأصول بـNBV يضخّم الأصول ويناقض الخسارة المُعترَف بها.
  const fa = rowsOf(
    await db.execute(sql`
    SELECT CAST(COALESCE(SUM(purchaseValue - accumulatedDepreciation), 0) AS CHAR) AS v
    FROM fixedAssets WHERE isActive = TRUE AND assetStatus NOT IN ('disposed', 'retired') ${bId ? sql`AND branchId = ${bId}` : sql``}
  `),
  )[0] ?? { v: "0" };

  // FIN-05 (تدقيق ٢٠/٦ — نظير FI-01 لأوامر الشغل): العربون المقبوض على أمر شغل غير مُسلَّم يَرفع النقد
  // (أصل) عند الإنشاء عبر receipt(IN)+PAYMENT_IN، لكنه ليس إيراداً بعد (الخدمة لم تُنجَز) ⇒ بلا التزام
  // مقابل، كانت حقوق الملكية تتضخّم بمقدار العرابين المعلّقة. نحتسب التزام «سُلف العملاء» = مجموع
  // deposit على أوامر الشغل المفتوحة فقط: status IN (RECEIVED, IN_PROGRESS, READY) — أي ليست DELIVERED
  // (عندها يُضمّ العربون لـinvoice.paidAmount ويُعترَف إيراداً عبر قيد SALE) ولا CANCELLED (عندها
  // يُسترَدّ العربون نقداً receipt(OUT) فيخرج من النقد). شرط invoiceId IS NULL حارسٌ مزدوج ضدّ احتساب
  // عربون رُبِط بفاتورة مُسلَّمة (لا ازدواج). نطابق عمود workOrders.deposit الحقيقيّ. عزل الفرع كباقي البنود.
  const wa = rowsOf(
    await db.execute(sql`
    SELECT CAST(COALESCE(SUM(deposit), 0) AS CHAR) AS v
    FROM workOrders
    WHERE workOrderStatus IN ('RECEIVED', 'IN_PROGRESS', 'READY')
      AND invoiceId IS NULL
      ${bId ? sql`AND branchId = ${bId}` : sql``}
  `),
  )[0] ?? { v: "0" };

  // مراجعة PR #495 (ش٤ — عرابين الطلبات المحفوظة): صافي المحتجَز على مسوّدات **مفتوحة**
  // = Σ(COLLECTION) − Σ(REFUND). المال في الدرج/البطاقة فعلاً (أصلٌ مُحتسَب أعلاه) والخدمة لم
  // تُقدَّم ⇒ التزامُ «سُلفة عميل» تماماً كعربون أمر الشغل (FIN-05). المسوّدة المُثبَّتة تخرج
  // تلقائياً (صار المال `paidAmount` على فاتورتها فالإيراد اعتُرف به)، والملغاة رُدَّ عربونها نقداً.
  // أسماء أعمدة DB الحرفية (mysqlEnum أوّل معامل = اسم العمود): orderPayKind / draftStatus.
  const da = rowsOf(
    await db.execute(sql`
    SELECT CAST(COALESCE(SUM(CASE WHEN op.orderPayKind = 'COLLECTION' THEN op.amount ELSE -op.amount END), 0) AS CHAR) AS v
    FROM orderPayments op
      JOIN receptionDrafts d ON d.id = op.draftId
    WHERE d.draftStatus = 'OPEN' AND op.orderPayKind IN ('COLLECTION', 'REFUND')
      ${bId ? sql`AND op.branchId = ${bId}` : sql``}
  `),
  )[0] ?? { v: "0" };

  // exchange-house: صافي أرصدتنا لدى الصرّافين على مستوى الشركة (دينار + دولار مُقيَّماً بمتوسط الكلفة).
  // موجب لكل صيرفة ⇒ أصل (أموالنا لديها)، سالب ⇒ خصم (نَدين لها). نظير AR/AP — بلا عزل فرع.
  const ex = rowsOf(
    await db.execute(sql`
    SELECT
      CAST(COALESCE(SUM(CASE WHEN net > 0 THEN net ELSE 0 END), 0) AS CHAR) AS d,
      CAST(COALESCE(SUM(CASE WHEN net < 0 THEN -net ELSE 0 END), 0) AS CHAR) AS c
    FROM (SELECT (balanceIqd + balanceUsd * usdCostRate) AS net FROM exchangeHouses WHERE isActive = TRUE) t
  `),
  )[0] ?? { d: "0", c: "0" };

  const cash = money(cashRow.cash ?? 0);
  const card = money(cashRow.card ?? 0);
  const cheque = money(cashRow.cheque ?? 0);
  const transfer = money(cashRow.transfer ?? 0);
  const wallet = money(cashRow.wallet ?? 0);
  const telecom = money(cashRow.telecom ?? 0); // مراجعة PR #495: رصيد زين المستحقّ (أصل).
  const digitalWalletAsset = money(digitalWalletRow.v ?? 0);
  const arDebit = money(ar.d ?? 0);
  const arCredit = money(ar.c ?? 0);
  const inventory = money(inv.v ?? 0);
  const fixedAssets = money(fa.v ?? 0);
  const apCredit = money(ap.c ?? 0);
  const apDebit = money(ap.d ?? 0);
  const cashPurchaseClearingNet = money(cashPurchaseClearingRow.v ?? 0);
  const cashPurchaseClearingCredit = cashPurchaseClearingNet.gt(0)
    ? cashPurchaseClearingNet
    : money(0);
  const cashPurchaseClearingDebit = cashPurchaseClearingNet.lt(0)
    ? cashPurchaseClearingNet.abs()
    : money(0);
  // FIN-05 + مراجعة PR #495: عرابين أوامر الشغل غير المُسلَّمة **وعرابين المسوّدات المفتوحة**.
  const draftAdvancesRaw = money(da.v ?? 0);
  const draftAdvances = draftAdvancesRaw.gt(0) ? draftAdvancesRaw : money(0); // صافٍ سالب مستحيلٌ بنيوياً (I2) — حزام أمان
  const customerAdvances = money(wa.v ?? 0).add(draftAdvances);
  const exchangeDebit = money(ex.d ?? 0); // أموالنا لدى الصرّافين (أصل).
  const exchangeCredit = money(ex.c ?? 0); // ما نَدين به للصرّافين (خصم).
  // عهدة مناديب التوصيل من الدفتر التشغيلي المؤرَّخ؛ لا snapshot حالي في تقرير تاريخي،
  // ولا تكرار كامل رصيد الجهة المشتركة في كل فرع.
  const dfRow = rowsOf(
    await db.execute(sql`
    SELECT CAST(COALESCE(SUM(CASE
      WHEN entryType = 'COD_COLLECTED' THEN amount
      WHEN entryType IN ('COD_REMITTED','COD_WRITTEN_OFF') THEN -amount
      ELSE 0 END), 0) AS CHAR) AS v
    FROM deliveryLedgerEntries
    WHERE 1=1
      ${bId ? sql`AND branchId = ${bId}` : sql``}
      ${asOf ? sql`AND DATE(occurredAt) <= ${asOf}` : sql``}
  `),
  )[0] ?? { v: "0" };
  // مراجعة PR #495 (ازدواج): الجزء المدعوم بعميلٍ مسجَّل من عهدة المناديب محسوبٌ سلفاً في
  // `arDebit` (البيع الآجل رفع `customers.currentBalance` بنفس المبلغ، والتوريد يخفض الاثنين
  // معاً). المتبقّي على الإرساليات الحيّة (DISPATCHED/PARTIAL) لفواتيرَ ذاتِ عميلٍ مسجَّل
  // يُستبعَد من الأصل هنا فلا يُحتسب ديناران لدينارٍ واحد بالطريق.
  const dfDupRow = rowsOf(
    await db.execute(sql`
    SELECT CAST(COALESCE(SUM(CASE
      WHEN dle.entryType = 'COD_COLLECTED' THEN dle.amount
      WHEN dle.entryType IN ('COD_REMITTED','COD_WRITTEN_OFF') THEN -dle.amount
      ELSE 0 END), 0) AS CHAR) AS v
    FROM deliveryLedgerEntries dle
      JOIN deliveryConsignments dc ON dc.id = dle.consignmentId
      JOIN invoices i ON i.id = dc.invoiceId
    WHERE i.customerId IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM accountingEntries ae
        WHERE ae.dedupeKey = CONCAT('PAYMENT_IN:COURIER_DELIVERY:', dc.id)
      )
      ${bId ? sql`AND dle.branchId = ${bId}` : sql``}
      ${asOf ? sql`AND DATE(dle.occurredAt) <= ${asOf}` : sql``}
  `),
  )[0] ?? { v: "0" };
  const deliveryFloatGross = money(dfRow.v ?? 0);
  const deliveryFloatCustomerBackedRaw = money(dfDupRow.v ?? 0);
  // الحدّ الأدنى صفر: العهدة قد تشمل عجزاً/تحصيلاً لطلبات متجرٍ لا يقابله صفٌّ هنا، والطرح
  // لا يصحّ أن ينقلب أصلاً سالباً. نُفصح عن المُستبعَد فعلياً (المقصوص) لا عن الخام.
  const deliveryFloat = deliveryFloatGross
    .sub(deliveryFloatCustomerBackedRaw)
    .gt(0)
    ? deliveryFloatGross.sub(deliveryFloatCustomerBackedRaw)
    : money(0);
  const deliveryFloatCustomerBacked = deliveryFloatGross.sub(deliveryFloat);
  // ١٠/٨ — أمانات أجور التوصيل المعلّقة (خصم): أجرةٌ قُبضت في الدرج أمانةً للمندوب ولم تُصرف
  // له بعد. النقد ضمن أصل «النقد» بلا التزامٍ مقابل ⇒ كانت حقوق الملكية تنتفخ بمقدارها مؤقتاً.
  // = Σ(DELIVERY_FEE_HELD) الموجبة صافياً (القبض + والصرف/الردّ − ⇒ الصافي = المعلّق)، بحدّ
  // أدنى صفر (بياناتٌ قديمة قبل توحيد الإشارة قد تُسوّي سالباً — لا خصم سالب).
  const feeHeldRow = rowsOf(
    await db.execute(sql`
    SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS v
    FROM accountingEntries
    WHERE entryType = 'DELIVERY_FEE_HELD'
    ${bId ? sql`AND branchId = ${bId}` : sql``}
    ${asOf ? sql`AND entryDate <= ${asOf}` : sql``}
  `),
  )[0] ?? { v: "0" };
  const feeHeldNet = money(feeHeldRow.v ?? 0);
  const deliveryFeeHeldLiability = feeHeldNet.gt(0) ? feeHeldNet : money(0);
  const feeDueRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(CASE
        WHEN dle.entryType = 'FEE_EARNED' THEN dle.amount
        WHEN dle.entryType IN ('FEE_PAID','FEE_OFFSET','FEE_REFUNDED') THEN -dle.amount
        ELSE 0 END), 0) AS CHAR) AS v
      FROM deliveryLedgerEntries dle
        JOIN deliveryConsignments dc ON dc.id = dle.consignmentId
      WHERE dc.consignmentFeeCollection = 'SHOP'
        ${bId ? sql`AND dle.branchId = ${bId}` : sql``}
        ${asOf ? sql`AND DATE(dle.occurredAt) <= ${asOf}` : sql``}
    `),
  )[0] ?? { v: "0" };
  const feeDueNet = money(feeDueRow.v ?? 0);
  const deliveryFeeDueLiability = feeDueNet.gt(0) ? feeDueNet : money(0);

  // خصوم الرواتب: من أدوار دورة اليومية في ACTIVE/SHADOW (الرصيد الطبيعي = الدائن − المدين)،
  // ومن remainingAmount في دفتر الالتزامات التشغيلي عند OFF حيث لا توجد يومية أصلاً.
  // اعتماد المسيّر يدائن الأدوار، والدفع/التحويل يدينها، وإعادة الدفع تدائنها مجدداً؛ لذلك تعكس
  // اللقطة التسديد الجزئي والعكس بلا استنتاج من حالة المسيّر. ربط الدورة الحالية يمنع خلط دورات SHADOW.
  const payrollMode = rowsOf(await db.execute(sql`
    SELECT mode, shadowCycleId AS cycleId FROM doubleEntrySettings WHERE id = 1 LIMIT 1
  `))[0] as { mode?: string; cycleId?: string | null } | undefined;
  const payrollLiabilityRows = payrollMode?.cycleId && (payrollMode.mode === "ACTIVE" || payrollMode.mode === "SHADOW")
    ? rowsOf(await db.execute(sql`
        SELECT
          jl.role AS role,
          CAST(COALESCE(SUM(jl.credit - jl.debit), 0) AS CHAR) AS balance
        FROM journalLines jl
        INNER JOIN journalEntries je ON je.id = jl.journalId
        WHERE je.status = 'POSTED'
          AND je.cycleId = ${payrollMode.cycleId}
          AND jl.role IN (
            'ACCRUED_SALARY', 'PAYROLL_TAX_PAYABLE',
            'SOCIAL_SECURITY_PAYABLE', 'EOS_PROVISION'
          )
          ${bId ? sql`AND je.branchId = ${bId}` : sql``}
          ${asOf ? sql`AND je.entryDate <= ${asOf}` : sql``}
        GROUP BY jl.role
      `)) as Array<{ role: string; balance: string }>
    : asOf
      ? rowsOf(await db.execute(sql`
          SELECT historical.role, CAST(COALESCE(SUM(historical.balance), 0) AS CHAR) AS balance
          FROM (
            SELECT
              CASE po.payrollObligationKind
                WHEN 'SALARY_NET' THEN 'ACCRUED_SALARY'
                WHEN 'INCOME_TAX' THEN 'PAYROLL_TAX_PAYABLE'
                WHEN 'SOCIAL_SECURITY' THEN 'SOCIAL_SECURITY_PAYABLE'
                ELSE 'EOS_PROVISION'
              END AS role,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM payrollAccountingEvents reversal
                  WHERE reversal.payrollAccountingEventKind IN ('ACCRUAL_REVERSAL', 'EOS_SETTLEMENT_REVERSAL')
                    AND DATE(reversal.occurredAt) <= ${asOf}
                    AND (
                      (po.runId IS NOT NULL AND reversal.runId = po.runId AND reversal.revisionNo = po.revisionNo)
                      OR (po.terminationId IS NOT NULL AND reversal.terminationId = po.terminationId)
                    )
                ) THEN 0
                ELSE po.originalAmount - COALESCE((
                  SELECT SUM(CASE
                    WHEN allocation.payrollAllocationDirection = 'APPLY' THEN allocation.amount
                    ELSE -allocation.amount
                  END)
                  FROM payrollObligationAllocations allocation
                  WHERE allocation.obligationId = po.id
                    AND DATE(allocation.occurredAt) <= ${asOf}
                ), 0)
              END AS balance
            FROM payrollObligations po
            WHERE COALESCE(po.dueDate, DATE(po.createdAt)) <= ${asOf}
              ${bId ? sql`AND po.branchIdSnapshot = ${bId}` : sql``}
          ) historical
          WHERE historical.balance <> 0
          GROUP BY historical.role
        `)) as Array<{ role: string; balance: string }>
      : rowsOf(await db.execute(sql`
          SELECT
            CASE payrollObligationKind
              WHEN 'SALARY_NET' THEN 'ACCRUED_SALARY'
              WHEN 'INCOME_TAX' THEN 'PAYROLL_TAX_PAYABLE'
              WHEN 'SOCIAL_SECURITY' THEN 'SOCIAL_SECURITY_PAYABLE'
              ELSE 'EOS_PROVISION'
            END AS role,
            CAST(COALESCE(SUM(remainingAmount), 0) AS CHAR) AS balance
          FROM payrollObligations
          WHERE payrollObligationStatus IN ('OPEN', 'PARTIAL')
            ${bId ? sql`AND branchIdSnapshot = ${bId}` : sql``}
          GROUP BY payrollObligationKind
        `)) as Array<{ role: string; balance: string }>;
  const payrollLiabilityByRole = new Map(
    payrollLiabilityRows.map((row) => [String(row.role), money(row.balance ?? 0)]),
  );
  const accruedSalaryLiability = payrollLiabilityByRole.get("ACCRUED_SALARY") ?? money(0);
  const payrollTaxPayable = payrollLiabilityByRole.get("PAYROLL_TAX_PAYABLE") ?? money(0);
  const socialSecurityPayable = payrollLiabilityByRole.get("SOCIAL_SECURITY_PAYABLE") ?? money(0);
  const eosProvision = payrollLiabilityByRole.get("EOS_PROVISION") ?? money(0);
  const employeeAdvanceRow = payrollMode?.cycleId && (payrollMode.mode === "ACTIVE" || payrollMode.mode === "SHADOW")
    ? rowsOf(await db.execute(sql`
        SELECT CAST(COALESCE(SUM(jl.debit - jl.credit), 0) AS CHAR) AS balance
        FROM journalLines jl
        INNER JOIN journalEntries je ON je.id = jl.journalId
        WHERE je.status = 'POSTED'
          AND je.cycleId = ${payrollMode.cycleId}
          AND jl.role = 'EMPLOYEE_ADVANCES'
          ${bId ? sql`AND je.branchId = ${bId}` : sql``}
          ${asOf ? sql`AND je.entryDate <= ${asOf}` : sql``}
      `))[0] as { balance?: string } | undefined
    : asOf
      ? rowsOf(await db.execute(sql`
          SELECT CAST(COALESCE(SUM(
            CASE
              WHEN ea.advanceStatus = 'CANCELLED' AND DATE(ea.updatedAt) <= ${asOf} THEN 0
              ELSE ea.amount
            - COALESCE((
                SELECT SUM(CASE WHEN aset.advanceSettlementDirection = 'APPLY' THEN aset.amount ELSE -aset.amount END)
                FROM advanceSettlements aset
                WHERE aset.advanceId = ea.id
                  AND DATE(aset.occurredAt) <= ${asOf}
              ), 0)
            - COALESCE((
                SELECT SUM(CASE WHEN taa.terminationAdvanceDirection = 'APPLY' THEN taa.amount ELSE -taa.amount END)
                FROM terminationAdvanceAllocations taa
                WHERE taa.advanceId = ea.id
                  AND DATE(taa.occurredAt) <= ${asOf}
              ), 0)
            - COALESCE((
                SELECT SUM(CASE WHEN ara.advanceRepaymentAllocationDirection = 'APPLY' THEN ara.amount ELSE -ara.amount END)
                FROM employeeAdvanceRepaymentAllocations ara
                WHERE ara.advanceId = ea.id
                  AND DATE(ara.occurredAt) <= ${asOf}
              ), 0)
            END
          ), 0) AS CHAR) AS balance
          FROM employeeAdvances ea
          WHERE DATE(ea.grantedAt) <= ${asOf}
            ${bId ? sql`AND ea.branchId = ${bId}` : sql``}
        `))[0] as { balance?: string } | undefined
      : rowsOf(await db.execute(sql`
          SELECT CAST(COALESCE(SUM(remaining), 0) AS CHAR) AS balance
          FROM employeeAdvances
          WHERE advanceStatus = 'ACTIVE'
            ${bId ? sql`AND branchId = ${bId}` : sql``}
        `))[0] as { balance?: string } | undefined;
  const employeeAdvanceReceivable = money(employeeAdvanceRow?.balance ?? 0);
  const interbranchRow = payrollMode?.cycleId && (payrollMode.mode === "ACTIVE" || payrollMode.mode === "SHADOW")
    ? rowsOf(await db.execute(sql`
        SELECT CAST(COALESCE(SUM(jl.debit - jl.credit), 0) AS CHAR) AS balance
        FROM journalLines jl
        INNER JOIN journalEntries je ON je.id = jl.journalId
        WHERE je.status = 'POSTED'
          AND je.cycleId = ${payrollMode.cycleId}
          AND jl.role = 'INTERBRANCH_CLEARING'
          ${bId ? sql`AND je.branchId = ${bId}` : sql``}
          ${asOf ? sql`AND je.entryDate <= ${asOf}` : sql``}
      `))[0] as { balance?: string } | undefined
    : undefined;
  const interbranchNet = money(interbranchRow?.balance ?? 0);
  const dueFromBranches = interbranchNet.gt(0) ? interbranchNet : money(0);
  const dueToBranches = interbranchNet.lt(0) ? interbranchNet.abs() : money(0);

  // الأصول = نقد + مدينون + سُلف للموردين (ذمة لنا) + مخزون + أصول ثابتة + رصيدنا لدى الصرّافين
  //          + عهدة مناديب التوصيل (مالُ فواتيرَ بالطريق).
  const totalAssets = cash
    .add(card)
    .add(cheque)
    .add(transfer)
    .add(wallet)
    .add(telecom)
    .add(digitalWalletAsset)
    .add(arDebit)
    .add(apDebit)
    .add(cashPurchaseClearingDebit)
    .add(inventory)
    .add(fixedAssets)
    .add(exchangeDebit)
    .add(deliveryFloat)
    .add(employeeAdvanceReceivable)
    .add(dueFromBranches);
  // الخصوم = دائنون + سُلف العملاء على الذمم + عرابين أوامر الشغل (FIN-05) + ما نَدين به للصرّافين
  //          + أمانات أجور توصيل معلّقة (١٠/٨ — نقدها داخل «النقد» والتزامها للمندوب).
  const totalLiabilities = apCredit
    .add(cashPurchaseClearingCredit)
    .add(arCredit)
    .add(customerAdvances)
    .add(exchangeCredit)
    .add(deliveryFeeHeldLiability)
    .add(deliveryFeeDueLiability)
    .add(accruedSalaryLiability)
    .add(payrollTaxPayable)
    .add(socialSecurityPayable)
    .add(eosProvision)
    .add(dueToBranches);
  const equity = totalAssets.sub(totalLiabilities);

  // FI-02: حارس انحراف مرئي (قراءة فقط). الأرقام أعلاه تبقى من currentBalance؛ هذه إشارةٌ فقط.
  // verify=true افتراضياً؛ يَستطيع المستدعي تعطيلها للأداء (verify:false) فتُعتبر متّسقة بلا فحص.
  // asOf (لقطة تاريخية): reconcile* يقارنان الدفتر بالرصيد الحيّ **الآن** فقط — لا معنى لتشغيلهما على
  // لقطةٍ ماضية (سيُبلّغان بانحرافٍ زائف دائماً لأن الحيّ يشمل حركات بعد asOf). نُعطَّل الفحص حينها.
  const verify = !isHistorical && (opts.verify ?? true);
  let arDrift: { length: number } = { length: 0 };
  let apDrift: { length: number } = { length: 0 };
  if (verify) {
    arDrift = await reconcileCustomerBalances();
    apDrift = await reconcileSupplierBalances();
  }

  const historicalNote = isHistorical
    ? `النقد ورصيد زين والذمم وعهدة التوصيل وأجورها مبنيّة من دفاتر مؤرخة حتى هذا التاريخ. المخزون والأصول الثابتة وعرابين أوامر الشغل والطلبات المحفوظة ورصيد الصيرفة تبقى بقيمتها الحالية لغياب سجل تاريخ تكلفة كامل.${payrollMode?.cycleId ? " خصوم الرواتب وسلف الموظفين مبنيّة من اليومية حتى تاريخ اللقطة." : " وفي وضع OFF تُعاد خصوم الرواتب وسلف الموظفين تاريخياً من أصل دفاترها وتخصيصات السداد/الاسترداد وعكوسها المؤرخة حتى اللقطة."}`
    : null;
  const interbranchNote = bId && !payrollMode?.cycleId
    ? "مقاصة الفروع لا تُقاس في وضع OFF لغياب يومية مزدوجة؛ فعّل SHADOW/ACTIVE قبل الاعتماد على مركز الفرع، بينما تظل قائمة الشركة المجمعة غير متأثرة بالمقاصة الداخلية."
    : null;

  return {
    cash: toDbMoney(cash),
    card: toDbMoney(card),
    check: toDbMoney(cheque),
    transfer: toDbMoney(transfer),
    wallet: toDbMoney(wallet),
    telecom: toDbMoney(telecom),
    digitalWalletAsset: toDbMoney(digitalWalletAsset),
    arDebit: toDbMoney(arDebit),
    arCredit: toDbMoney(arCredit),
    inventory: toDbMoney(inventory),
    fixedAssets: toDbMoney(fixedAssets),
    apCredit: toDbMoney(apCredit),
    apDebit: toDbMoney(apDebit),
    cashPurchaseClearingDebit: toDbMoney(cashPurchaseClearingDebit),
    cashPurchaseClearingCredit: toDbMoney(cashPurchaseClearingCredit),
    customerAdvances: toDbMoney(customerAdvances),
    draftAdvances: toDbMoney(draftAdvances),
    exchangeDebit: toDbMoney(exchangeDebit),
    exchangeCredit: toDbMoney(exchangeCredit),
    deliveryFloat: toDbMoney(deliveryFloat),
    deliveryFloatCustomerBacked: toDbMoney(deliveryFloatCustomerBacked),
    deliveryFeeHeldLiability: toDbMoney(deliveryFeeHeldLiability),
    deliveryFeeDueLiability: toDbMoney(deliveryFeeDueLiability),
    accruedSalaryLiability: toDbMoney(accruedSalaryLiability),
    payrollTaxPayable: toDbMoney(payrollTaxPayable),
    socialSecurityPayable: toDbMoney(socialSecurityPayable),
    eosProvision: toDbMoney(eosProvision),
    employeeAdvanceReceivable: toDbMoney(employeeAdvanceReceivable),
    dueFromBranches: toDbMoney(dueFromBranches),
    dueToBranches: toDbMoney(dueToBranches),
    totalAssets: toDbMoney(totalAssets),
    totalLiabilities: toDbMoney(totalLiabilities),
    equity: toDbMoney(equity),
    branchScoped: !!bId,
    arReconciled: arDrift.length === 0,
    apReconciled: apDrift.length === 0,
    arDriftCount: arDrift.length,
    apDriftCount: apDrift.length,
    asOf: asOf ?? null,
    historicalNote,
    interbranchNote,
  };
}

/* ============================ التدفّق النقدي (أساس نقدي مباشر) ============================ */

const PAY_METHOD_AR: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  TELECOM: "رصيد زين",
};

export interface CashFlowLine {
  key: string;
  label: string;
  amount: string;
}
export interface CashFlowResult {
  period: { from: string; to: string };
  inflows: CashFlowLine[];
  outflows: CashFlowLine[];
  totalIn: string;
  totalOut: string;
  net: string;
}

export async function getCashFlow(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<CashFlowResult> {
  const db = getDb();
  const base: CashFlowResult = {
    period: { from: opts.from, to: opts.to },
    inflows: [],
    outflows: [],
    totalIn: "0",
    totalOut: "0",
    net: "0",
  };
  if (!db) return base;

  // FIN-04 (تدقيق ٢٠/٦): توحيد أساس التاريخ. كانت هذه الدالة تُبوّب وتُرشّح على DATE(r.createdAt)
  // — وهو timestamp بتوقيت خادم MySQL المحليّ — بينما كل القوائم الأخرى (P&L/الأستاذ/المصروفات)
  // تُفتاح على entryDate (عمود DATE)، فينشأ أساسٌ مزدوج وانحراف عند حدود UTC. الإصلاح: نشتقّ تاريخ
  // العمل من قيد الدفتر المرتبط بالإيصال (ae.receiptId → ae.entryDate) — نفس الأساس الذي يفتاح عليه
  // الباقي — مع COALESCE احتياطيٍّ على DATE(r.createdAt) لأي إيصال نادر بلا قيد دفتر مرتبط (لا يُسقَط
  // صفّ أبداً، فلا يتغيّر مجموع النقد، بل يتّسق التبويب الزمنيّ فقط). LEFT JOIN يحفظ مجموعة الإيصالات
  // كما هي تماماً (قائدةً)، والربط على entryType النقديّ (PAYMENT_IN/OUT) يطابق قيد الإيصال الوحيد.
  const rows = rowsOf(
    await db.execute(sql`
    SELECT r.direction AS direction, r.paymentMethod AS method, CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
    FROM receipts r
    LEFT JOIN accountingEntries ae
      ON ae.receiptId = r.id AND ae.entryType IN ('PAYMENT_IN', 'PAYMENT_OUT')
    WHERE r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
      AND r.receiptApprovalStatus = 'APPROVED'
      AND COALESCE(ae.entryDate, DATE(r.createdAt)) >= ${opts.from}
      AND COALESCE(ae.entryDate, DATE(r.createdAt)) <= ${opts.to}
      ${opts.branchId ? sql`AND r.branchId = ${opts.branchId}` : sql``}
    GROUP BY r.direction, r.paymentMethod
  `),
  );

  const inflows: CashFlowLine[] = [];
  const outflows: CashFlowLine[] = [];
  let totalIn = money(0);
  let totalOut = money(0);
  for (const r of rows) {
    const amt = money(r.amount ?? 0);
    const line: CashFlowLine = {
      key: String(r.method),
      label: PAY_METHOD_AR[String(r.method)] ?? String(r.method),
      amount: toDbMoney(amt),
    };
    if (r.direction === "IN") {
      inflows.push(line);
      totalIn = totalIn.add(amt);
    } else {
      outflows.push(line);
      totalOut = totalOut.add(amt);
    }
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
