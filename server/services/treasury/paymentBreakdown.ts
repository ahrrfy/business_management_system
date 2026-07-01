// توزيع طرق الدفع (مخطّط دونات) حسب الفترة.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { PAY_METHOD_AR, isCashier, rowsOf } from "./helpers";

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
