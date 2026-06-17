// خدمة تقارير الخزينة والمصروفات (للقراءة فقط) — تُغذّي مركز التقارير.
// المصادر (لا تخمين):
//  • المقبوضات/المدفوعات: جدول receipts المكتمل (receiptStatus='COMPLETED') — أساس نقدي.
//  • فروقات الورديات: جدول shifts في الفترة (DATE(openedAt) BETWEEN).
//  • المصروفات: جدول expenses الفعّال (expenseStatus='ACTIVE') مصنّفاً + أكبر جهات الصرف.
// ⚠️ أسماء أعمدة DB الخام: receipts.receiptStatus · expenses.expenseCategory/expenseStatus/expenseDate
//   · shifts.shiftStatus/variance/countedCash/openedAt. كل الأموال عبر decimal.js (money/toDbMoney).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

const PAY_METHOD_AR: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة",
};

const EXPENSE_CATEGORY_AR: Record<string, string> = {
  RENT: "الإيجار",
  UTILITIES: "الخدمات",
  SUPPLIES: "المستلزمات",
  SALARY: "رواتب",
  TRANSPORT: "النقل",
  MAINTENANCE: "الصيانة",
  MARKETING: "التسويق",
  OTHER: "أخرى",
};

/* ============================ ملخّص الخزينة ============================ */

export interface TreasuryMethodLine {
  key: string;
  label: string;
  in: string;
  out: string;
}

export interface TreasurySummaryResult {
  period: { from: string; to: string };
  methods: TreasuryMethodLine[];
  totalIn: string;
  totalOut: string;
  net: string;
  shifts: { count: number; totalVariance: string; totalCounted: string };
}

export async function getTreasurySummary(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<TreasurySummaryResult> {
  const db = getDb();
  const base: TreasurySummaryResult = {
    period: { from: opts.from, to: opts.to },
    methods: [],
    totalIn: "0",
    totalOut: "0",
    net: "0",
    shifts: { count: 0, totalVariance: "0", totalCounted: "0" },
  };
  if (!db) return base;

  // (أ) المقبوضات/المدفوعات المكتملة مجمّعةً حسب الاتّجاه × طريقة الدفع.
  const recRows = rowsOf(
    await db.execute(sql`
      SELECT r.direction AS direction, r.paymentMethod AS method,
             CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
      FROM receipts r
      WHERE r.receiptStatus = 'COMPLETED'
        AND DATE(r.createdAt) >= ${opts.from} AND DATE(r.createdAt) <= ${opts.to}
        ${opts.branchId ? sql`AND r.branchId = ${opts.branchId}` : sql``}
      GROUP BY r.direction, r.paymentMethod
    `),
  );

  // اجمع IN/OUT لكل طريقة في صفّ واحد. حافظ على ترتيب الظهور.
  const methodMap = new Map<string, { in: ReturnType<typeof money>; out: ReturnType<typeof money> }>();
  let totalIn = money(0);
  let totalOut = money(0);
  for (const r of recRows) {
    const key = String(r.method);
    const amt = money(r.amount ?? 0);
    if (!methodMap.has(key)) methodMap.set(key, { in: money(0), out: money(0) });
    const slot = methodMap.get(key)!;
    if (r.direction === "IN") { slot.in = slot.in.add(amt); totalIn = totalIn.add(amt); }
    else { slot.out = slot.out.add(amt); totalOut = totalOut.add(amt); }
  }

  const methods: TreasuryMethodLine[] = Array.from(methodMap.entries()).map(([key, v]) => ({
    key,
    label: PAY_METHOD_AR[key] ?? key,
    in: toDbMoney(v.in),
    out: toDbMoney(v.out),
  }));

  // (ب) فروقات الورديات في الفترة (حسب openedAt). variance/countedCash قد تكون NULL لوردية مفتوحة.
  const sh = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(s.variance), 0) AS CHAR) AS totalVariance,
        CAST(COALESCE(SUM(s.countedCash), 0) AS CHAR) AS totalCounted
      FROM shifts s
      WHERE DATE(s.openedAt) >= ${opts.from} AND DATE(s.openedAt) <= ${opts.to}
        ${opts.branchId ? sql`AND s.branchId = ${opts.branchId}` : sql``}
    `),
  )[0] ?? { cnt: 0, totalVariance: "0", totalCounted: "0" };

  return {
    period: { from: opts.from, to: opts.to },
    methods,
    totalIn: toDbMoney(totalIn),
    totalOut: toDbMoney(totalOut),
    net: toDbMoney(totalIn.sub(totalOut)),
    shifts: {
      count: Number(sh.cnt ?? 0),
      totalVariance: toDbMoney(money(sh.totalVariance ?? 0)),
      totalCounted: toDbMoney(money(sh.totalCounted ?? 0)),
    },
  };
}

/* ============================ تقرير المصروفات ============================ */

export interface ExpenseCategoryLine {
  key: string;
  label: string;
  amount: string;
  count: number;
}

export interface ExpensePayeeLine {
  payee: string;
  amount: string;
  count: number;
}

export interface ExpensesReportResult {
  period: { from: string; to: string };
  byCategory: ExpenseCategoryLine[];
  byPayee: ExpensePayeeLine[];
  total: string;
}

export async function getExpensesReport(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<ExpensesReportResult> {
  const db = getDb();
  const base: ExpensesReportResult = {
    period: { from: opts.from, to: opts.to },
    byCategory: [],
    byPayee: [],
    total: "0",
  };
  if (!db) return base;

  const branchEx = opts.branchId ? sql`AND e.branchId = ${opts.branchId}` : sql``;

  // المصروفات الفعّالة مصنّفةً حسب الفئة.
  const catRows = rowsOf(
    await db.execute(sql`
      SELECT e.expenseCategory AS category,
             CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount,
             COUNT(*) AS cnt
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate >= ${opts.from} AND e.expenseDate <= ${opts.to}
        ${branchEx}
      GROUP BY e.expenseCategory
      ORDER BY SUM(e.amount) DESC
    `),
  );

  // أكبر ٢٠ جهة صرف (payee قد تكون NULL ⇒ "غير محدّد"). نجمع NULL في مجموعة واحدة.
  const payeeRows = rowsOf(
    await db.execute(sql`
      SELECT e.payee AS payee,
             CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount,
             COUNT(*) AS cnt
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate >= ${opts.from} AND e.expenseDate <= ${opts.to}
        ${branchEx}
      GROUP BY e.payee
      ORDER BY SUM(e.amount) DESC
      LIMIT 20
    `),
  );

  const byCategory: ExpenseCategoryLine[] = catRows.map((r) => ({
    key: String(r.category),
    label: EXPENSE_CATEGORY_AR[String(r.category)] ?? String(r.category),
    amount: toDbMoney(money(r.amount ?? 0)),
    count: Number(r.cnt ?? 0),
  }));

  const byPayee: ExpensePayeeLine[] = payeeRows.map((r) => ({
    payee: r.payee == null || r.payee === "" ? "غير محدّد" : String(r.payee),
    amount: toDbMoney(money(r.amount ?? 0)),
    count: Number(r.cnt ?? 0),
  }));

  // الإجمالي = مجموع الفئات (مرجع واحد متّسق مع byCategory، بلا استعلام ثالث).
  const total = catRows.reduce((acc, r) => acc.add(money(r.amount ?? 0)), money(0));

  return {
    period: { from: opts.from, to: opts.to },
    byCategory,
    byPayee,
    total: toDbMoney(total),
  };
}
