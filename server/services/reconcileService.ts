import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  branchStock,
  customers,
  inventoryMovements,
  invoices,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { money } from "./money";

export interface ReconcileResult {
  entity: string;
  id: number;
  expected: string;
  actual: string;
  drift: string;
}

/** التحقق من اتساق ذمم العملاء: currentBalance == مجموع الفواتير غير المسوّاة. */
export async function reconcileCustomerBalances(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const computed = await db
    .select({
      customerId: invoices.customerId,
      expectedBalance: sql<string>`
        COALESCE(SUM(CASE
          WHEN ${invoices.status} IN ('PENDING','PARTIALLY_PAID')
          THEN GREATEST(CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)), 0)
          ELSE 0
        END), 0)
      `,
    })
    .from(invoices)
    .where(sql`${invoices.customerId} IS NOT NULL`)
    .groupBy(invoices.customerId);

  const actuals = await db
    .select({ id: customers.id, balance: customers.currentBalance })
    .from(customers);
  const actualMap = new Map(actuals.map((c) => [Number(c.id), String(c.balance ?? "0")]));

  const issues: ReconcileResult[] = [];
  for (const row of computed) {
    const actual = actualMap.get(Number(row.customerId)) ?? "0";
    const drift = money(row.expectedBalance).minus(money(actual)).abs();
    if (drift.greaterThan("0.01")) {
      issues.push({
        entity: "customer",
        id: Number(row.customerId),
        expected: row.expectedBalance,
        actual,
        drift: drift.toFixed(2),
      });
    }
  }
  return issues;
}

/** التحقق من اتساق مخزون الفروع: quantity == مجموع الحركات بإشارات IN/OUT. */
export async function reconcileInventory(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const computed = await db
    .select({
      variantId: inventoryMovements.variantId,
      branchId: inventoryMovements.branchId,
      computedQty: sql<number>`SUM(
        CASE ${inventoryMovements.movementType}
          WHEN 'IN'  THEN ${inventoryMovements.quantity}
          WHEN 'OUT' THEN -${inventoryMovements.quantity}
          ELSE 0 END
      )`,
    })
    .from(inventoryMovements)
    .groupBy(inventoryMovements.variantId, inventoryMovements.branchId);

  const actuals = await db.select().from(branchStock);
  const actualMap = new Map(
    actuals.map((s) => [`${Number(s.variantId)}:${Number(s.branchId)}`, Number(s.quantity)])
  );

  return computed
    .filter((r) => {
      const key = `${Number(r.variantId)}:${Number(r.branchId)}`;
      return Math.abs((actualMap.get(key) ?? 0) - Number(r.computedQty)) > 0;
    })
    .map((r) => {
      const key = `${Number(r.variantId)}:${Number(r.branchId)}`;
      const actual = actualMap.get(key) ?? 0;
      return {
        entity: "stock",
        id: Number(r.variantId),
        expected: String(r.computedQty),
        actual: String(actual),
        drift: String(Math.abs(actual - Number(r.computedQty))),
      };
    });
}

/** التحقق من سلامة قيد الأرباح: revenue - cost == profit لكل قيد. */
export async function reconcileLedgerProfit(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const entries = await db
    .select({
      id: accountingEntries.id,
      revenue: accountingEntries.revenue,
      cost: accountingEntries.cost,
      profit: accountingEntries.profit,
    })
    .from(accountingEntries)
    .where(
      and(
        sql`${accountingEntries.revenue} IS NOT NULL`,
        sql`${accountingEntries.cost} IS NOT NULL`,
        sql`${accountingEntries.profit} IS NOT NULL`
      )
    );

  return entries
    .filter((e) => {
      const expected = money(String(e.revenue ?? 0)).minus(money(String(e.cost ?? 0)));
      return money(String(e.profit ?? 0))
        .minus(expected)
        .abs()
        .greaterThan("0.01");
    })
    .map((e) => {
      const expected = money(String(e.revenue ?? 0)).minus(money(String(e.cost ?? 0)));
      return {
        entity: "ledger",
        id: Number(e.id),
        expected: expected.toFixed(2),
        actual: String(e.profit ?? 0),
        drift: money(String(e.profit ?? 0)).minus(expected).abs().toFixed(2),
      };
    });
}
