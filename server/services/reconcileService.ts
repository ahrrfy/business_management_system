import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  branchStock,
  customers,
  inventoryMovements,
  invoices,
  suppliers,
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
 *            + Σ OPENING.amount للعميل (قيد ترسيخ الرصيد الافتتاحي المستورد — import-integration)
 *
 * (returnSale ينقص paidAmount بـcashRefund، فـ(total − paidAmount) يَكبر بـcashRefund؛
 *  PAYMENT_OUT.amount = cashRefund موجباً ⇒ نضيفه فيُلغى هذا الكِبَر، وتبقى RETURN.amount السالبة
 *  هي ما يَطرح أثر المرتجع كاملاً على AR.)
 *
 * (قيد OPENING يكتبه importService عند إنشاء عميل برصيد افتتاحي ⇒ بدونه في الصيغة يصير كل
 *  مستورَدٍ برصيدٍ «انحرافاً» زائفاً دائماً يُغرق هذا التقرير من يوم الاستيراد.)
 */
export async function reconcileCustomerBalances(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  // قيود OPENING للعملاء (الرصيد الافتتاحي المستورد) — تُضاف إلى المُتوقَّع من الفواتير.
  const openingSum = await db
    .select({
      customerId: accountingEntries.customerId,
      opening: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        sql`${accountingEntries.customerId} IS NOT NULL`,
        eq(accountingEntries.entryType, "OPENING")
      )
    )
    .groupBy(accountingEntries.customerId);
  const openingMap = new Map(openingSum.map((r) => [Number(r.customerId), String(r.opening ?? "0")]));

  // مع عمود returnedTotal، الصيغة تبسّطت كثيراً:
  //   AR_per_invoice = total - paidAmount - returnedTotal (موقَّع، لا GREATEST(.,0))
  // الفاتورة CANCELLED تستثنى (التزامها أُلغي).
  const invSum = await db
    .select({
      customerId: invoices.customerId,
      arGross: sql<string>`
        COALESCE(SUM(CASE
          WHEN ${invoices.status} != 'CANCELLED'
          THEN CAST(${invoices.total} AS DECIMAL(15,2))
             - CAST(${invoices.paidAmount} AS DECIMAL(15,2))
             - CAST(${invoices.returnedTotal} AS DECIMAL(15,2))
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
  const invMap = new Map(invSum.map((r) => [Number(r.customerId), String(r.arGross ?? "0")]));

  // كل عميل له فاتورة أو قيد افتتاحي أو رصيد غير صفري (لتغطية حالة دفع زائد بلا فاتورة معلّقة).
  const seen = new Set<number>();
  for (const row of invSum) seen.add(Number(row.customerId));
  for (const row of openingSum) seen.add(Number(row.customerId));
  for (const c of actuals) if (money(c.balance ?? "0").abs().gt(0)) seen.add(Number(c.id));

  const issues: ReconcileResult[] = [];
  for (const customerId of Array.from(seen)) {
    const expected = money(invMap.get(customerId) ?? "0").plus(money(openingMap.get(customerId) ?? "0"));
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
 * التحقّق من اتساق ذمم الموردين (AP). النموذج: suppliers.currentBalance (موجب = ندين للمورد)
 * يُحدَّث بزيادة نسبية ذرّية في كل عملية. المُتوقَّع المُشتقّ من قيود الدفتر للمورد:
 *   AP = Σ PURCHASE.amount − Σ PAYMENT_OUT.amount + Σ PAYMENT_IN.amount + Σ RETURN.amount
 *      + Σ OPENING.amount (قيد ترسيخ الرصيد الافتتاحي المستورد — import-integration)
 *   (RETURN.amount مخزَّن سالباً ⇒ يَطرح المرتجع؛ PAYMENT_IN = استرداد نقدي من المورد يَزيد AP العاكس).
 * يكشف أي انحراف صامت في AP (الذي لم يكن مُتحقَّقاً منه آلياً قبل هذا).
 */
export async function reconcileSupplierBalances(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const entrySum = await db
    .select({
      supplierId: accountingEntries.supplierId,
      ap: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'PURCHASE'    THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN'  THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'RETURN'      THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'OPENING'     THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(sql`${accountingEntries.supplierId} IS NOT NULL`)
    .groupBy(accountingEntries.supplierId);

  const actuals = await db.select({ id: suppliers.id, balance: suppliers.currentBalance }).from(suppliers);
  const apMap = new Map(entrySum.map((r) => [Number(r.supplierId), String(r.ap ?? "0")]));
  const actualMap = new Map(actuals.map((s) => [Number(s.id), String(s.balance ?? "0")]));

  const seen = new Set<number>();
  for (const r of entrySum) seen.add(Number(r.supplierId));
  for (const s of actuals) if (money(s.balance ?? "0").abs().gt(0)) seen.add(Number(s.id));

  const issues: ReconcileResult[] = [];
  for (const supplierId of Array.from(seen)) {
    const expected = money(apMap.get(supplierId) ?? "0");
    const actual = money(actualMap.get(supplierId) ?? "0");
    const drift = expected.minus(actual).abs();
    if (drift.greaterThan("0.01")) {
      issues.push({ entity: "supplier", id: supplierId, expected: expected.toFixed(2), actual: actual.toFixed(2), drift: drift.toFixed(2) });
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
