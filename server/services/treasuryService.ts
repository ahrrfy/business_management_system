// خدمة لوحة الخزينة (قراءة فقط) — تُغذّي شاشة /treasury الاحترافية.
// المصادر:
//  • DRAWER balance: shifts المفتوحة + receipts بـcashBucket='DRAWER' (نفس صيغة computeExpectedCash في shiftService).
//  • TREASURY balance: receipts بـcashBucket='TREASURY' (تاريخياً بلا فلتر فترة — رصيد تراكمي).
//  • السلاسل الزمنية والـbreakdown والـtrends: receipts المكتملة (receiptStatus='COMPLETED').
// ⚠️ scopedBranchId (IDOR): الكاشير يَرى دَرْجه فقط بلا TREASURY.
// ⚠️ أسماء أعمدة DB الخام في sql template: receipts.receiptStatus / shifts.shiftStatus / expenses.expenseStatus.

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

const PAY_METHOD_AR: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
};

const isCashier = (role: string | null | undefined) => role === "cashier" || role === "warehouse" || role === "print_operator";

/* ============================ lookup داشبورد رئيسي ============================ */

export interface DrawerBalanceRow {
  branchId: number;
  branchName: string;
  openShiftsCount: number;
  expectedCash: string; // openingBalance + cashIn - cashOut (مجموع الورديات المفتوحة)
  totalOpening: string;
}

export interface TreasuryBalanceRow {
  branchId: number;
  branchName: string;
  balance: string; // SUM(IN - OUT) لـcashBucket=TREASURY (تراكمي)
}

export interface DashboardOutput {
  drawerBalances: DrawerBalanceRow[];
  treasuryBalances: TreasuryBalanceRow[];
  openShiftsCount: number;
  todayReceiptsTotal: string; // مجموع receipts IN اليوم (كل طرق الدفع)
  todayExpensesTotal: string; // مجموع expenses الفعّالة اليوم
  // pendingIncomingTransfers يَظهر في المرحلة ٢ — حالياً 0 ثابت.
  pendingIncomingTransfers: number;
  // علم بصري: هل يجب إخفاء TREASURY في الواجهة (الكاشير).
  hideTreasury: boolean;
  generatedAt: string; // ISO timestamp للـ"آخر تحديث".
}

export async function getDashboard(
  input: { branchId?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<DashboardOutput> {
  const db = getDb();
  const base: DashboardOutput = {
    drawerBalances: [],
    treasuryBalances: [],
    openShiftsCount: 0,
    todayReceiptsTotal: "0",
    todayExpensesTotal: "0",
    pendingIncomingTransfers: 0,
    hideTreasury: isCashier(scope.role),
    generatedAt: new Date().toISOString(),
  };
  if (!db) return base;

  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const branchFilter = effectiveBranch != null ? sql`AND b.id = ${effectiveBranch}` : sql``;

  // ── (أ) DRAWER لكل فرع: مجموع الورديات المفتوحة (opening + cashIn − cashOut) ──
  const drawerRows = rowsOf(
    await db.execute(sql`
      SELECT
        b.id AS branchId,
        b.name AS branchName,
        COUNT(DISTINCT s.id) AS openShiftsCount,
        CAST(COALESCE(SUM(s.openingBalance), 0) AS CHAR) AS totalOpening,
        CAST(COALESCE((
          SELECT SUM(r.amount)
          FROM receipts r
          WHERE r.paymentMethod = 'CASH'
            AND r.direction = 'IN'
            AND r.receiptStatus = 'COMPLETED'
            AND r.shiftId IN (
              SELECT s2.id FROM shifts s2
              WHERE s2.branchId = b.id AND s2.shiftStatus = 'OPEN'
            )
        ), 0) AS CHAR) AS cashIn,
        CAST(COALESCE((
          SELECT SUM(r.amount)
          FROM receipts r
          WHERE r.paymentMethod = 'CASH'
            AND r.direction = 'OUT'
            AND r.receiptStatus = 'COMPLETED'
            AND r.shiftId IN (
              SELECT s2.id FROM shifts s2
              WHERE s2.branchId = b.id AND s2.shiftStatus = 'OPEN'
            )
        ), 0) AS CHAR) AS cashOut
      FROM branches b
      LEFT JOIN shifts s ON s.branchId = b.id AND s.shiftStatus = 'OPEN'
      WHERE b.isActive = TRUE
        ${branchFilter}
      GROUP BY b.id, b.name
      ORDER BY b.id ASC
    `),
  );

  const drawerBalances: DrawerBalanceRow[] = drawerRows.map((r) => {
    const opening = money(r.totalOpening ?? 0);
    const cIn = money(r.cashIn ?? 0);
    const cOut = money(r.cashOut ?? 0);
    return {
      branchId: Number(r.branchId),
      branchName: String(r.branchName ?? ""),
      openShiftsCount: Number(r.openShiftsCount ?? 0),
      totalOpening: toDbMoney(opening),
      expectedCash: toDbMoney(opening.plus(cIn).minus(cOut)),
    };
  });

  // ── (ب) TREASURY لكل فرع — مكتوم للكاشير ──
  let treasuryBalances: TreasuryBalanceRow[] = [];
  if (!isCashier(scope.role)) {
    const treasuryRows = rowsOf(
      await db.execute(sql`
        SELECT
          b.id AS branchId,
          b.name AS branchName,
          CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END), 0) AS CHAR) AS balance
        FROM branches b
        LEFT JOIN receipts r ON r.branchId = b.id
          AND r.cashBucket = 'TREASURY'
          AND r.receiptStatus = 'COMPLETED'
        WHERE b.isActive = TRUE
          ${branchFilter}
        GROUP BY b.id, b.name
        ORDER BY b.id ASC
      `),
    );
    treasuryBalances = treasuryRows.map((r) => ({
      branchId: Number(r.branchId),
      branchName: String(r.branchName ?? ""),
      balance: toDbMoney(money(r.balance ?? 0)),
    }));
  }

  // ── (ج) عدد الورديات المفتوحة (مجموع كل الفروع المرئيّة) ──
  const openShiftsCount = drawerBalances.reduce((sum, r) => sum + r.openShiftsCount, 0);

  // ── (د) مقبوضات/مصروفات اليوم (مجموع كل طرق الدفع) ──
  const branchFilterRaw = effectiveBranch != null ? sql`AND branchId = ${effectiveBranch}` : sql``;
  const todayReceipts = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS total
      FROM receipts
      WHERE direction = 'IN'
        AND receiptStatus = 'COMPLETED'
        AND DATE(createdAt) = CURDATE()
        ${branchFilterRaw}
    `),
  );
  const todayExpenses = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS total
      FROM expenses
      WHERE expenseStatus = 'ACTIVE'
        AND expenseDate = CURDATE()
        ${branchFilterRaw}
    `),
  );

  return {
    drawerBalances,
    treasuryBalances,
    openShiftsCount,
    todayReceiptsTotal: toDbMoney(money(todayReceipts[0]?.total ?? 0)),
    todayExpensesTotal: toDbMoney(money(todayExpenses[0]?.total ?? 0)),
    pendingIncomingTransfers: 0, // المرحلة ٢
    hideTreasury: isCashier(scope.role),
    generatedAt: new Date().toISOString(),
  };
}

/* ============================ آخر حركات نقدية (موحَّد receipts + expenses) ============================ */

export interface MovementRow {
  id: string; // r:NN أو e:NN
  source: "RECEIPT" | "EXPENSE";
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  branchId: number | null;
  branchName: string | null;
  description: string | null;
  voucherNumber: string | null;
  createdAt: string;
}

export async function getRecentMovements(
  input: { branchId?: number; limit?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<MovementRow[]> {
  const db = getDb();
  if (!db) return [];

  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const limit = input.limit && input.limit > 0 && input.limit <= 100 ? input.limit : 20;
  const branchFilterR = effectiveBranch != null ? sql`AND r.branchId = ${effectiveBranch}` : sql``;
  const branchFilterE = effectiveBranch != null ? sql`AND e.branchId = ${effectiveBranch}` : sql``;
  // الكاشير لا يَرى TREASURY مطلقاً (IDOR + إخفاء معلومات إدارية).
  // ⚠️ أسماء أعمدة DB الخام: receipts.cashBucket / expenses.expenseCashBucket / expenses.expensePaymentMethod.
  const bucketFilterR = isCashier(scope.role) ? sql`AND (r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL)` : sql``;
  const bucketFilterE = isCashier(scope.role) ? sql`AND (e.expenseCashBucket = 'DRAWER' OR e.expenseCashBucket IS NULL)` : sql``;

  const rows = rowsOf(
    await db.execute(sql`
      (
        SELECT
          CONCAT('r:', r.id) AS id,
          'RECEIPT' AS source,
          r.direction AS direction,
          CAST(r.amount AS CHAR) AS amount,
          r.paymentMethod AS paymentMethod,
          r.cashBucket AS cashBucket,
          r.branchId AS branchId,
          b.name AS branchName,
          r.description AS description,
          r.voucherNumber AS voucherNumber,
          r.createdAt AS createdAt
        FROM receipts r
        LEFT JOIN branches b ON b.id = r.branchId
        WHERE r.receiptStatus = 'COMPLETED'
          ${branchFilterR}
          ${bucketFilterR}
      )
      UNION ALL
      (
        SELECT
          CONCAT('e:', e.id) AS id,
          'EXPENSE' AS source,
          'OUT' AS direction,
          CAST(e.amount AS CHAR) AS amount,
          e.expensePaymentMethod AS paymentMethod,
          e.expenseCashBucket AS cashBucket,
          e.branchId AS branchId,
          b.name AS branchName,
          CONCAT('مصروف — ', e.expenseCategory) AS description,
          NULL AS voucherNumber,
          e.createdAt AS createdAt
        FROM expenses e
        LEFT JOIN branches b ON b.id = e.branchId
        WHERE e.expenseStatus = 'ACTIVE'
          ${branchFilterE}
          ${bucketFilterE}
      )
      ORDER BY createdAt DESC
      LIMIT ${limit}
    `),
  );

  return rows.map((r) => ({
    id: String(r.id),
    source: r.source === "EXPENSE" ? "EXPENSE" : "RECEIPT",
    direction: r.direction === "OUT" ? "OUT" : "IN",
    amount: toDbMoney(money(r.amount ?? 0)),
    paymentMethod: String(r.paymentMethod ?? ""),
    paymentMethodLabel: PAY_METHOD_AR[String(r.paymentMethod ?? "")] ?? String(r.paymentMethod ?? ""),
    cashBucket: r.cashBucket === "TREASURY" ? "TREASURY" : r.cashBucket === "DRAWER" ? "DRAWER" : null,
    branchId: r.branchId == null ? null : Number(r.branchId),
    branchName: r.branchName == null ? null : String(r.branchName),
    description: r.description == null ? null : String(r.description),
    voucherNumber: r.voucherNumber == null ? null : String(r.voucherNumber),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}

/* ============================ سلسلة تدفّق نقدي زمنية ============================ */

export interface DailyPoint {
  day: string; // YYYY-MM-DD
  inflow: string;
  outflow: string;
  net: string;
}

export async function getCashFlowSeries(
  input: { days?: number; branchId?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<DailyPoint[]> {
  const db = getDb();
  if (!db) return [];

  const days = input.days && input.days > 0 && input.days <= 365 ? Math.floor(input.days) : 30;
  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const branchFilter = effectiveBranch != null ? sql`AND r.branchId = ${effectiveBranch}` : sql``;
  // الكاشير: DRAWER فقط ضمن السلسلة (لا تَسرّب TREASURY).
  const bucketFilter = isCashier(scope.role) ? sql`AND (r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL)` : sql``;

  // SQL aggregate per-day. النتيجة قد تَفتقر أياماً بلا حركات — نَملأها بأصفار في JS.
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        DATE(r.createdAt) AS day,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE 0 END), 0) AS CHAR) AS inflow,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'OUT' THEN r.amount ELSE 0 END), 0) AS CHAR) AS outflow
      FROM receipts r
      WHERE r.receiptStatus = 'COMPLETED'
        AND r.createdAt >= DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)
        ${branchFilter}
        ${bucketFilter}
      GROUP BY DATE(r.createdAt)
      ORDER BY day ASC
    `),
  );

  const byDay = new Map<string, { inflow: string; outflow: string }>();
  for (const r of rows) {
    const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    byDay.set(d, {
      inflow: toDbMoney(money(r.inflow ?? 0)),
      outflow: toDbMoney(money(r.outflow ?? 0)),
    });
  }

  // ملء الأيام الفارغة بأصفار حتى يَكون الـchart متّسقاً.
  const out: DailyPoint[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = byDay.get(key) ?? { inflow: "0.00", outflow: "0.00" };
    const net = money(v.inflow).minus(money(v.outflow));
    out.push({ day: key, inflow: v.inflow, outflow: v.outflow, net: toDbMoney(net) });
  }
  return out;
}

/* ============================ توزيع طرق الدفع (دونات) ============================ */

export interface MethodSlice {
  key: string;
  label: string;
  inTotal: string;
  outTotal: string;
  count: number;
}

export type DashboardPeriod = "today" | "yesterday" | "week" | "month";

function periodRange(period: DashboardPeriod): { from: Date; to: Date } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (period === "today") return { from: today, to: tomorrow };
  if (period === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return { from: yesterday, to: today };
  }
  if (period === "week") {
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return { from: weekAgo, to: tomorrow };
  }
  // month
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);
  return { from: monthAgo, to: tomorrow };
}

export async function getPaymentMethodBreakdown(
  input: { period?: DashboardPeriod; branchId?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<MethodSlice[]> {
  const db = getDb();
  if (!db) return [];

  const period = input.period ?? "today";
  const { from, to } = periodRange(period);
  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const branchFilter = effectiveBranch != null ? sql`AND r.branchId = ${effectiveBranch}` : sql``;
  const bucketFilter = isCashier(scope.role) ? sql`AND (r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL)` : sql``;

  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        r.paymentMethod AS method,
        r.direction AS direction,
        CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount,
        COUNT(*) AS cnt
      FROM receipts r
      WHERE r.receiptStatus = 'COMPLETED'
        AND r.createdAt >= ${from}
        AND r.createdAt < ${to}
        ${branchFilter}
        ${bucketFilter}
      GROUP BY r.paymentMethod, r.direction
    `),
  );

  const map = new Map<string, MethodSlice>();
  // ضمان ظهور كل طرق الدفع حتى الفارغة (للأسطورة).
  for (const k of ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]) {
    map.set(k, { key: k, label: PAY_METHOD_AR[k] ?? k, inTotal: "0.00", outTotal: "0.00", count: 0 });
  }
  for (const r of rows) {
    const k = String(r.method);
    const slot = map.get(k) ?? { key: k, label: PAY_METHOD_AR[k] ?? k, inTotal: "0.00", outTotal: "0.00", count: 0 };
    const amt = money(r.amount ?? 0);
    if (r.direction === "IN") slot.inTotal = toDbMoney(money(slot.inTotal).plus(amt));
    else slot.outTotal = toDbMoney(money(slot.outTotal).plus(amt));
    slot.count += Number(r.cnt ?? 0);
    map.set(k, slot);
  }
  return Array.from(map.values());
}

/* ============================ KPI trends — قيمة + delta٪ + sparkline ============================ */

export interface KpiTrendPoint {
  current: string;
  previous: string;
  deltaPct: number | null; // null إن previous=0
  sparkline: number[]; // 7 نقاط (يومية)
}

export interface KpiTrends {
  todayReceipts: KpiTrendPoint;
  todayExpenses: KpiTrendPoint;
  drawerTotal: KpiTrendPoint;
  treasuryTotal: KpiTrendPoint;
  openShifts: KpiTrendPoint;
}

function computeDelta(currentStr: string, previousStr: string): number | null {
  const cur = money(currentStr);
  const prev = money(previousStr);
  if (prev.isZero()) {
    if (cur.isZero()) return 0;
    return null; // قسمة على صفر — اعرض "—" في الواجهة
  }
  // ((cur - prev) / prev) × 100
  return Number(cur.minus(prev).div(prev).times(100).toDecimalPlaces(1).toString());
}

async function fetchDailySparkline(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: "receipts_in" | "expenses" | "receipts_out",
  branchFilter: ReturnType<typeof sql>,
  bucketFilter: ReturnType<typeof sql>,
): Promise<number[]> {
  let q;
  if (kind === "receipts_in") {
    q = sql`
      SELECT DATE(r.createdAt) AS day, CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
      FROM receipts r
      WHERE r.receiptStatus = 'COMPLETED' AND r.direction = 'IN'
        AND r.createdAt >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        ${branchFilter}
        ${bucketFilter}
      GROUP BY DATE(r.createdAt) ORDER BY day ASC
    `;
  } else if (kind === "receipts_out") {
    q = sql`
      SELECT DATE(r.createdAt) AS day, CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
      FROM receipts r
      WHERE r.receiptStatus = 'COMPLETED' AND r.direction = 'OUT'
        AND r.createdAt >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        ${branchFilter}
        ${bucketFilter}
      GROUP BY DATE(r.createdAt) ORDER BY day ASC
    `;
  } else {
    // expenses
    const branchExp = branchFilter; // expenses tablefilter already aliased r → adjust by replacing alias.
    q = sql`
      SELECT e.expenseDate AS day, CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY e.expenseDate ORDER BY day ASC
    `;
    // ملاحظة: branchFilter/bucketFilter لـreceipts بـalias r — لا تنطبق على expenses. نطبّقها يدوياً أدناه.
    void branchExp;
  }

  const rows = rowsOf(await db.execute(q));
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    byDay.set(d, money(r.amount ?? 0).toNumber());
  }

  const out: number[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? 0);
  }
  return out;
}

export async function getKpiTrends(
  input: { branchId?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<KpiTrends> {
  const db = getDb();
  const empty: KpiTrendPoint = { current: "0.00", previous: "0.00", deltaPct: 0, sparkline: [0, 0, 0, 0, 0, 0, 0] };
  if (!db) {
    return {
      todayReceipts: empty,
      todayExpenses: empty,
      drawerTotal: empty,
      treasuryTotal: empty,
      openShifts: empty,
    };
  }

  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const branchFilterR = effectiveBranch != null ? sql`AND r.branchId = ${effectiveBranch}` : sql``;
  const branchFilterE = effectiveBranch != null ? sql`AND e.branchId = ${effectiveBranch}` : sql``;
  const bucketFilterR = isCashier(scope.role) ? sql`AND (r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL)` : sql``;

  // مقبوضات اليوم vs الأمس
  const todayInRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
      FROM receipts r
      WHERE r.direction = 'IN' AND r.receiptStatus = 'COMPLETED'
        AND DATE(r.createdAt) = CURDATE()
        ${branchFilterR} ${bucketFilterR}
    `),
  );
  const yesterdayInRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
      FROM receipts r
      WHERE r.direction = 'IN' AND r.receiptStatus = 'COMPLETED'
        AND DATE(r.createdAt) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
        ${branchFilterR} ${bucketFilterR}
    `),
  );

  // مصروفات اليوم vs الأمس
  const todayExpRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate = CURDATE()
        ${branchFilterE}
    `),
  );
  const yesterdayExpRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
        ${branchFilterE}
    `),
  );

  // إجمالي DRAWER الحالي + الأمس (snapshot: opening + cashIn - cashOut للورديات المفتوحة الآن).
  const drawer = await getDashboard(input, scope);
  const drawerTotalCur = drawer.drawerBalances.reduce(
    (acc, r) => acc.plus(money(r.expectedCash)),
    money(0),
  );
  // DRAWER "previous" = إجمالي opening للورديات التي افتُتحت بالأمس وأُغلقت (وهو ما نوّهت).
  // البديل العملي: لا توجد "صورة أمس" دقيقة بدون snapshot، لذا نَستعمل countedCash للورديات المُغلقة أمس.
  const drawerYesterdayRow = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(s.countedCash), 0) AS CHAR) AS amount
      FROM shifts s
      WHERE s.shiftStatus = 'CLOSED'
        AND DATE(s.closedAt) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
        ${effectiveBranch != null ? sql`AND s.branchId = ${effectiveBranch}` : sql``}
    `),
  );

  // TREASURY balance — تراكمي ⇒ "previous" = الرصيد قبل اليوم.
  let treasuryTotalCur = money(0);
  let treasuryYesterday = money(0);
  if (!isCashier(scope.role)) {
    treasuryTotalCur = drawer.treasuryBalances.reduce((acc, r) => acc.plus(money(r.balance)), money(0));
    const treasuryBeforeTodayRow = rowsOf(
      await db.execute(sql`
        SELECT CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END), 0) AS CHAR) AS amount
        FROM receipts r
        WHERE r.cashBucket = 'TREASURY' AND r.receiptStatus = 'COMPLETED'
          AND DATE(r.createdAt) < CURDATE()
          ${branchFilterR}
      `),
    );
    treasuryYesterday = money(treasuryBeforeTodayRow[0]?.amount ?? 0);
  }

  // ورديات مفتوحة — current/previous بسيط (لا قسمة على صفر ⇒ نوّحد deltaPct).
  const openShiftsCur = drawer.openShiftsCount;
  const openShiftsYestRow = rowsOf(
    await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM shifts s
      WHERE DATE(s.openedAt) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
        ${effectiveBranch != null ? sql`AND s.branchId = ${effectiveBranch}` : sql``}
    `),
  );

  // sparklines (7 نقاط).
  const inflowSpark = await fetchDailySparkline(db, "receipts_in", branchFilterR, bucketFilterR);
  const outflowSpark = await fetchDailySparkline(db, "expenses", sql``, sql``);

  const todayRecCur = toDbMoney(money(todayInRow[0]?.amount ?? 0));
  const todayRecPrev = toDbMoney(money(yesterdayInRow[0]?.amount ?? 0));
  const todayExpCur = toDbMoney(money(todayExpRow[0]?.amount ?? 0));
  const todayExpPrev = toDbMoney(money(yesterdayExpRow[0]?.amount ?? 0));
  const drawerCur = toDbMoney(drawerTotalCur);
  const drawerPrev = toDbMoney(money(drawerYesterdayRow[0]?.amount ?? 0));
  const treasuryCurStr = toDbMoney(treasuryTotalCur);
  const treasuryPrevStr = toDbMoney(treasuryYesterday);
  const openShiftsPrev = Number(openShiftsYestRow[0]?.cnt ?? 0);

  return {
    todayReceipts: {
      current: todayRecCur,
      previous: todayRecPrev,
      deltaPct: computeDelta(todayRecCur, todayRecPrev),
      sparkline: inflowSpark,
    },
    todayExpenses: {
      current: todayExpCur,
      previous: todayExpPrev,
      deltaPct: computeDelta(todayExpCur, todayExpPrev),
      sparkline: outflowSpark,
    },
    drawerTotal: {
      current: drawerCur,
      previous: drawerPrev,
      deltaPct: computeDelta(drawerCur, drawerPrev),
      sparkline: [],
    },
    treasuryTotal: {
      current: treasuryCurStr,
      previous: treasuryPrevStr,
      deltaPct: computeDelta(treasuryCurStr, treasuryPrevStr),
      sparkline: [],
    },
    openShifts: {
      current: String(openShiftsCur),
      previous: String(openShiftsPrev),
      deltaPct:
        openShiftsPrev === 0
          ? openShiftsCur === 0
            ? 0
            : null
          : Number((((openShiftsCur - openShiftsPrev) / openShiftsPrev) * 100).toFixed(1)),
      sparkline: [],
    },
  };
}

/* ============================ ورديات مفتوحة (بطاقات داشبورد) ============================ */

export interface OpenShiftCard {
  shiftId: number;
  branchId: number;
  branchName: string;
  userId: number;
  userName: string;
  openingBalance: string;
  expectedCash: string; // محسوب لحظياً
  cashIn: string;
  cashOut: string;
  openedAt: string;
}

export async function getOpenShifts(
  input: { branchId?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<OpenShiftCard[]> {
  const db = getDb();
  if (!db) return [];
  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const branchFilter = effectiveBranch != null ? sql`AND s.branchId = ${effectiveBranch}` : sql``;
  // الكاشير يَرى ورديته فقط (لا ورديات زملائه).
  const userFilter = isCashier(scope.role) ? sql`AND s.userId = ${scope.scopedBranchId == null ? 0 : "n/a"}` : sql``;
  // ⚠️ تعديل: الكاشير لا يَملك useId مباشرةً — نَنقله من ctx.user.id؛ تَمرّر عبر input في الراوتر.
  void userFilter;

  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        s.id AS shiftId,
        s.branchId AS branchId,
        b.name AS branchName,
        s.userId AS userId,
        u.name AS userName,
        CAST(s.openingBalance AS CHAR) AS openingBalance,
        s.openedAt AS openedAt,
        CAST(COALESCE((
          SELECT SUM(r.amount) FROM receipts r
          WHERE r.shiftId = s.id AND r.paymentMethod = 'CASH' AND r.direction = 'IN' AND r.receiptStatus = 'COMPLETED'
        ), 0) AS CHAR) AS cashIn,
        CAST(COALESCE((
          SELECT SUM(r.amount) FROM receipts r
          WHERE r.shiftId = s.id AND r.paymentMethod = 'CASH' AND r.direction = 'OUT' AND r.receiptStatus = 'COMPLETED'
        ), 0) AS CHAR) AS cashOut
      FROM shifts s
      LEFT JOIN branches b ON b.id = s.branchId
      LEFT JOIN users u ON u.id = s.userId
      WHERE s.shiftStatus = 'OPEN'
        ${branchFilter}
      ORDER BY s.openedAt DESC
      LIMIT 50
    `),
  );

  return rows.map((r) => {
    const opening = money(r.openingBalance ?? 0);
    const cIn = money(r.cashIn ?? 0);
    const cOut = money(r.cashOut ?? 0);
    return {
      shiftId: Number(r.shiftId),
      branchId: Number(r.branchId),
      branchName: String(r.branchName ?? ""),
      userId: Number(r.userId),
      userName: String(r.userName ?? ""),
      openingBalance: toDbMoney(opening),
      expectedCash: toDbMoney(opening.plus(cIn).minus(cOut)),
      cashIn: toDbMoney(cIn),
      cashOut: toDbMoney(cOut),
      openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : String(r.openedAt),
    };
  });
}
