// توزيع طرق الدفع (مخطّط دونات) حسب الفترة.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { PAY_METHOD_AR, isCashier, rowsOf } from "./helpers";
import { utcTodayStart } from "../businessDay";

export interface MethodSlice {
  key: string;
  label: string;
  inTotal: string;
  outTotal: string;
  count: number;
}

export type DashboardPeriod = "today" | "yesterday" | "week" | "month";

function periodRange(period: DashboardPeriod): { from: Date; to: Date } {
  // تدقيق ١٧/٧ (#٧): منتصف ليل UTC حتميّ + إزاحات UTC ثابتة (بدل new Date();setHours/setDate المحلي
  // التابع لمنطقة Node). مطابقٌ تماماً تحت TZ=UTC، وصحيحٌ على أي جهاز.
  const today = utcTodayStart();
  const addDays = (base: Date, n: number) => new Date(base.getTime() + n * 86_400_000);
  const tomorrow = addDays(today, 1);
  if (period === "today") return { from: today, to: tomorrow };
  if (period === "yesterday") return { from: addDays(today, -1), to: today };
  if (period === "week") return { from: addDays(today, -7), to: tomorrow };
  // month
  return { from: addDays(today, -30), to: tomorrow };
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
