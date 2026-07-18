// سلسلة تدفّق نقدي زمنية (يومية) — للرسم البياني.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { isCashier, rowsOf } from "./helpers";
import { utcTodayStart } from "../businessDay";

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
  // تدقيق ١٧/٧ (#٧): مفاتيح أيام UTC حتمية (منتصف ليل UTC + إزاحة ثابتة) بدل new Date();setHours المحلي.
  const today = utcTodayStart();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const v = byDay.get(key) ?? { inflow: "0.00", outflow: "0.00" };
    const net = money(v.inflow).minus(money(v.outflow));
    out.push({ day: key, inflow: v.inflow, outflow: v.outflow, net: toDbMoney(net) });
  }
  return out;
}
