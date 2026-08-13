import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { baghdadTodayUtcRange } from "../businessDay";

/**
 * One authoritative definition of today's sales for operational surfaces.
 *
 * The ERP stores timestamps in UTC while this mobile/executive label follows
 * the Baghdad civil date. We therefore compare against the half-open UTC
 * instants enclosing that Baghdad day. Returns reduce revenue without allowing
 * a negative invoice contribution, and cancelled invoices never contribute.
 */
export async function getTodayNetSales(branchId?: number, now: Date = new Date()): Promise<{
  total: string;
  invoiceCount: number;
  generatedAt: string;
}> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const { start, endExclusive } = baghdadTodayUtcRange(now);

  const result = await db.execute(sql`
    SELECT COUNT(*) AS invoiceCount,
      CAST(COALESCE(SUM(GREATEST(total - COALESCE(returnedTotal, 0), 0)), 0) AS CHAR) AS total
    FROM invoices
    WHERE invoiceDate >= ${start}
      AND invoiceDate < ${endExclusive}
      AND invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      ${branchId != null ? sql`AND branchId = ${branchId}` : sql``}
  `);
  const rows = (result as unknown as [Array<Record<string, unknown>>])[0] ?? [];
  return {
    total: toDbMoney(money(String(rows[0]?.total ?? 0))),
    invoiceCount: Number(rows[0]?.invoiceCount ?? 0),
    generatedAt: now.toISOString(),
  };
}
