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

/**
 * التحقق من اتساق ذمم العملاء (مُحدَّث بعد إصلاحات ٨/٦):
 *
 * نموذج AR الفعلي: currentBalance يُحدَّث بزيادة نسبية في كل عملية ويظلّ المصدر الموقَّع الصحيح
 * (قد يكون سالباً = المتجر يدين للعميل، بسبب دفع زائد أو مرتجع نقدي بلا رصيد كافٍ).
 *
 * المُتوقَّع المُشتقّ يجب أن يطابق هذا — السابق استعمل GREATEST(.,0) واستثنى المرتجعات،
 * فأنتج «انحرافاً وهمياً» في كل حالة مشروعة:
 *   • مرتجع جزئي على فاتورة آجلة (currentBalance يقلّ، invoice.total لا يقلّ).
 *   • دفع زائد (currentBalance سالب، expected=0).
 *
 * الصيغة الصحيحة (موقَّعة، تتطابق مع ما تكتبه الخدمات على currentBalance):
 *   expected = Σ (invoice.total − invoice.paidAmount) على فواتير غير ملغاة
 *            + Σ RETURN.amount على فواتير العميل  (مخزَّن سالباً ⇒ يطرح المرتجع)
 *            + Σ PAYMENT_OUT.amount على فواتير العميل (مرتجع نقدي مَردّه يَزيد paidAmount عبر returnSale)
 *
 * (returnSale ينقص paidAmount بـcashRefund، فـ(total − paidAmount) يَكبر بـcashRefund؛
 *  PAYMENT_OUT.amount = cashRefund موجباً ⇒ نضيفه فيُلغى هذا الكِبَر، وتبقى RETURN.amount السالبة
 *  هي ما يَطرح أثر المرتجع كاملاً على AR.)
 */
export async function reconcileCustomerBalances(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const invSum = await db
    .select({
      customerId: invoices.customerId,
      arGross: sql<string>`
        COALESCE(SUM(CASE
          WHEN ${invoices.status} != 'CANCELLED'
          THEN CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2))
          ELSE 0
        END), 0)
      `,
    })
    .from(invoices)
    .where(sql`${invoices.customerId} IS NOT NULL`)
    .groupBy(invoices.customerId);

  // RETURN.amount مخزَّن سالباً؛ PAYMENT_OUT.amount موجب يُضاف فيُلغي زيادة (total−paid) الناتجة عن نقصان paidAmount.
  const retSum = await db
    .select({
      customerId: accountingEntries.customerId,
      effect: sql<string>`
        COALESCE(SUM(CASE
          WHEN ${accountingEntries.entryType} IN ('RETURN','PAYMENT_OUT')
            AND ${accountingEntries.invoiceId} IS NOT NULL
          THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
          ELSE 0
        END), 0)
      `,
    })
    .from(accountingEntries)
    .where(sql`${accountingEntries.customerId} IS NOT NULL`)
    .groupBy(accountingEntries.customerId);
  const retMap = new Map(retSum.map((r) => [Number(r.customerId), String(r.effect ?? "0")]));

  const actuals = await db
    .select({ id: customers.id, balance: customers.currentBalance })
    .from(customers);
  const actualMap = new Map(actuals.map((c) => [Number(c.id), String(c.balance ?? "0")]));
  const invMap = new Map(invSum.map((r) => [Number(r.customerId), String(r.arGross ?? "0")]));

  // كل عميل له فاتورة أو رصيد غير صفري (لتغطية حالة دفع زائد بلا فاتورة معلّقة).
  const seen = new Set<number>();
  for (const row of invSum) seen.add(Number(row.customerId));
  for (const c of actuals) if (money(c.balance ?? "0").abs().gt(0)) seen.add(Number(c.id));

  const issues: ReconcileResult[] = [];
  for (const customerId of Array.from(seen)) {
    const expected = money(invMap.get(customerId) ?? "0").plus(money(retMap.get(customerId) ?? "0"));
    const actual = money(actualMap.get(customerId) ?? "0");
    const drift = expected.minus(actual).abs();
    if (drift.greaterThan("0.01")) {
      issues.push({
        entity: "customer",
        id: customerId,
        expected: expected.toFixed(2),
        actual: actual.toFixed(2),
        drift: drift.toFixed(2),
      });
    }
  }
  return issues;
}

/**
 * التحقق من سلامة مخزون الفروع: لا رصيد سالب.
 * ملاحظة: setStock يسجّل ADJUST بالقيمة المطلقة (Math.abs(delta)) لا المُوقَّعة،
 * لذا لا يمكن إعادة بناء الرصيد بجمع الحركات — نتحقق من الحالة الحاضرة فقط.
 */
export async function reconcileInventory(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const negativeRows = await db
    .select()
    .from(branchStock)
    .where(sql`${branchStock.quantity} < 0`);

  return negativeRows.map((s) => ({
    entity: "stock",
    id: Number(s.variantId),
    expected: ">=0",
    actual: String(s.quantity),
    drift: String(Math.abs(Number(s.quantity))),
  }));
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
