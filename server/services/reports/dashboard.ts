// مقاييس لوحة التحكم (بطاقات المخزون المنخفض والذمم المتأخّرة).
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";

export interface DashboardMetricsResult {
  lowStockCount: number;
  overdueAR: { count: number; total: string };
}

/**
 * مقاييس البطاقتين المعطّلتين في Dashboard.MetricsBar:
 *  - lowStockCount: متغيّرات تحت minStock (minStock>0) ضمن الفرع المُحدَّد (أو الكل إن null).
 *  - overdueAR: عدد ومجموع المتبقّي على فواتير PENDING/PARTIALLY_PAID أعمارها > ٣٠ يوماً.
 * لا تطبّق صلاحيات/عزل فرع هنا — يقع ذلك على المستدعي (الراوتر) قبل تمرير `branchId`.
 */
export async function getDashboardMetrics(
  opts: { branchId?: number | null } = {}
): Promise<DashboardMetricsResult> {
  const db = getDb();
  if (!db) {
    return { lowStockCount: 0, overdueAR: { count: 0, total: toDbMoney(money(0)) } };
  }
  const branchId = opts.branchId ?? null;
  const branchFilterStock = branchId == null ? sql`` : sql`AND bs.branchId = ${branchId}`;
  const branchFilterInv = branchId == null ? sql`` : sql`AND i.branchId = ${branchId}`;

  const lowRows = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM branchStock bs
    INNER JOIN productVariants v ON v.id = bs.variantId
    WHERE v.minStock > 0
      AND bs.quantity <= v.minStock
      AND v.isActive = TRUE
      ${branchFilterStock}
  `);
  const lowData = (lowRows as any)[0] ?? lowRows;
  const lowStockCount = Number(
    (Array.isArray(lowData) ? lowData[0]?.c : 0) ?? 0
  );

  const arRows = await db.execute(sql`
    SELECT
      COUNT(*) AS c,
      CAST(COALESCE(SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0) AS CHAR) AS t
    FROM invoices i
    WHERE i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
      -- S2 (٢٩/٦/٢٦): مطابق DATEDIFF(NOW(),invoiceDate)>30 تماماً (DATEDIFF يتجاهل الوقت، TZ=UTC) لكنه قابل للفهرسة.
      AND i.invoiceDate < DATE_SUB(UTC_DATE(), INTERVAL 30 DAY)
      ${branchFilterInv}
  `);
  const arData = (arRows as any)[0] ?? arRows;
  const arRow = Array.isArray(arData) ? arData[0] : null;

  return {
    lowStockCount,
    overdueAR: {
      count: Number(arRow?.c ?? 0),
      total: toDbMoney(money(arRow?.t ?? 0)),
    },
  };
}
