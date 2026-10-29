import { sql } from "drizzle-orm";
import { VOIDED_INVOICE_STATUSES } from "@shared/invoiceStatus";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import {
  componentRightsRawCostSql,
  reportInvoiceDeliveryRevenueSql,
  reportInvoiceGoodsRevenueSql,
  reportWorkOrderCogsSql,
} from "../fulfillment/componentRightsReportSql";

/** Read-only page projection. Frozen original cost is historical, never current COGS. */
export async function loadSalesInvoiceProjection(invoiceIds: readonly number[]) {
  const result = new Map<number, { netRevenue: string; netCOGS: string; profit: string }>();
  if (!invoiceIds.length) return result;
  const db = getDb();
  if (!db) throw new Error("Sales report database unavailable");
  const ids = sql.join(invoiceIds.map(id => sql`${id}`), sql`, `);
  const voided = sql.join(VOIDED_INVOICE_STATUSES.map(status => sql`${status}`), sql`, `);
  const lineCost = componentRightsRawCostSql(sql`CASE
    WHEN ii.baseQuantity <= 0 THEN ii.lineCost
    WHEN ii.returnedRestockedBaseQuantity >= ii.baseQuantity THEN 0
    ELSE ii.lineCost - ROUND(ii.lineCost * ii.returnedRestockedBaseQuantity / ii.baseQuantity, 2) END`);
  // Same invoice revenue and source-linked costs as the canonical sales register.
  // No item weighting is needed at invoice granularity. No-item legacy invoices retain
  // their saved cost; WORKORDER always prefers actual SALE/RETURN material/labour COGS.
  const netRevenue = sql`CASE WHEN i.invoiceStatus IN (${voided}) THEN 0
    ELSE (${reportInvoiceGoodsRevenueSql()}) + (${reportInvoiceDeliveryRevenueSql()}) END`;
  const netCost = sql`CASE WHEN i.invoiceStatus IN (${voided}) THEN 0
    ELSE COALESCE(${reportWorkOrderCogsSql()}, lineCosts.netCost, i.costTotal) END`;
  const [rows] = await db.execute(sql`
    SELECT i.id, CAST(${netRevenue} AS CHAR) AS netRevenue, CAST(${netCost} AS CHAR) AS netCOGS
    FROM invoices i
    LEFT JOIN (
      SELECT ii.invoiceId, SUM(${lineCost}) AS netCost FROM invoiceItems ii
      WHERE ii.invoiceId IN (${ids}) GROUP BY ii.invoiceId
    ) lineCosts ON lineCosts.invoiceId=i.id
    WHERE i.id IN (${ids})
  `);
  for (const row of rows as unknown as { id: number; netRevenue: string; netCOGS: string }[]) {
    const revenue = money(row.netRevenue), cost = money(row.netCOGS);
    result.set(row.id, { netRevenue: toDbMoney(revenue), netCOGS: toDbMoney(cost), profit: toDbMoney(revenue.minus(cost)) });
  }
  return result;
}
