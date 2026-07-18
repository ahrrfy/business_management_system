// مؤشّرات KPI مع نسبة التغيّر والاتجاه اليومي (sparkline).
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { isCashier, rowsOf } from "./helpers";
import { getDashboard } from "./dashboard";
import { utcTodayStart } from "../businessDay";

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
    // expenses — KPI-SPARK-BRANCH (تدقيق ٢/٧): كان يُمرَّر فلتر فرعٍ فارغ ⇒ مخطّط المصروفات يعرض كل
    // الفروع بينما الرقم الرئيس بجانبه مفلتر. الآن نستقبل الفلتر المُؤلَّف على alias e ونطبّقه.
    q = sql`
      SELECT e.expenseDate AS day, CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        ${branchFilter}
      GROUP BY e.expenseDate ORDER BY day ASC
    `;
  }

  const rows = rowsOf(await db.execute(q));
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    byDay.set(d, money(r.amount ?? 0).toNumber());
  }

  const out: number[] = [];
  // تدقيق ١٧/٧ (#٧): مفاتيح أيام UTC حتمية بدل new Date();setHours المحلي.
  const today = utcTodayStart();
  for (let i = 6; i >= 0; i--) {
    const key = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? 0);
  }
  return out;
}

// scope يحمل userId لتمريره لـgetDashboard (عزل درج الكاشير).
export async function getKpiTrends(
  input: { branchId?: number },
  scope: { scopedBranchId: number | null; role: string; userId: number },
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
  const outflowSpark = await fetchDailySparkline(db, "expenses", branchFilterE, sql``);

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
