/* ============================================================================
 * كنسة وعاء العمولة الشهري — **مصدر الحقيقة الواحد** لصافي مبيعات كل بائع.
 * تُستهلك من: شبكة الأهداف (فعليّ الشهر السابق)، محرّك التشغيلات (S3)،
 * ولوحة الإنجاز/«أدائي» الحيّتين (S5) — استعلام مجمَّع واحد، لا N+1.
 *
 * القواعد (قرارات المالك ٦/٧/٢٦):
 *  - الوعاء = Σ revenue قيود SALE − |Σ revenue قيود RETURN| (صافٍ بعد الخصم، قبل الضريبة —
 *    دلالة الدفتر §٥). قيود ADJUST (تقريب النقد) وPAYMENT_* مستبعدة بفلتر entryType.
 *  - الإسناد الذكي: فاتورة sourceType='WORKORDER' ⇒ منشئ أمر الشغل (workOrders.createdBy —
 *    join على workOrders.invoiceId العلاقة 1:1 المقسّاة بـuq_wo_invoice)، مع سقوط آمن
 *    لمنشئ الفاتورة إن كان createdBy فارغاً؛ بقية المصادر ⇒ invoices.createdBy.
 *  - المرتجع يتبع invoiceId قيده ⇒ يُخصَم من البائع الأصلي في شهر حدوث الإرجاع.
 *  - مرتجعات الشراء مستبعدة بنيوياً: invoiceId IS NOT NULL AND supplierId IS NULL.
 *  - النطاق sargable على entryDate (عمود DATE): [أول الشهر، أول الشهر التالي) —
 *    يخدمه فهرس idx_entry_type_date (هجرة 0052).
 *
 * ⚠ لا يوجد مسار CANCELLED للفواتير في النظام (تحقّق ٦/٧) — كل التصحيحات تمرّ قيود RETURN
 * فالوعاء يتعافى ذاتياً. إن أُضيف إلغاءٌ يوماً فيجب أن يقيّد عكساً دفترياً وإلا انكسر هذا الاشتقاق.
 * ========================================================================== */
import Decimal from "decimal.js";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { accountingEntries, invoices, workOrders } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money } from "../money";
import { periodDateRange } from "./period";

export interface UserMonthBase {
  /** Σ إيراد SALE (موجب). */
  sales: Decimal;
  /** |Σ إيراد RETURN| (موجب — القيود مخزّنة سالبة). */
  returns: Decimal;
  /** بضاعة الأمانة (ش٣): Σ حصص المودِعين للمبيعات (قيود PURCHASE∧invoiceId∧supplierId) — تُخصَم من
   *  الوعاء (قرار المالك ٤: العمولة على الهامش فقط). موجبٌ صافياً (استحقاق البيع − عكس المرتجع). §٤.١. */
  consigDeduction: Decimal;
  saleEntryCount: number;
  returnEntryCount: number;
}

/** صافي وعاء الشهر لكل بائع (users.id) — Map فارغة الشهرَ الخاملَ. */
export async function computeNetSalesByUser(runner: DB | Tx, period: string): Promise<Map<number, UserMonthBase>> {
  const { from, toExclusive } = periodDateRange(period);

  const rows = await runner
    .select({
      sellerId: sql<number | null>`COALESCE(CASE WHEN ${invoices.sourceType} = 'WORKORDER' THEN ${workOrders.createdBy} END, ${invoices.createdBy})`.as(
        "sellerId",
      ),
      sales: sql<string>`CAST(COALESCE(SUM(CASE WHEN ${accountingEntries.entryType} = 'SALE' THEN ${accountingEntries.revenue} ELSE 0 END), 0) AS CHAR)`,
      returnsNeg: sql<string>`CAST(COALESCE(SUM(CASE WHEN ${accountingEntries.entryType} = 'RETURN' THEN ${accountingEntries.revenue} ELSE 0 END), 0) AS CHAR)`,
      // بضاعة الأمانة (ش٣): خصم حصص المودِعين — قيود PURCHASE بـinvoiceId+supplierId (استحقاق البيع
      // موجب، عكس المرتجع سالب) ⇒ الصافي = حصص البيع القائم. التركيبة (PURCHASE∧invoiceId∧supplierId)
      // فارغة تاريخياً فلا أثر رجعيّ. قيود التلف/الجرد (بلا invoiceId) خارج الفلتر ⇒ لا تمسّ البائع.
      consigDeduction: sql<string>`CAST(COALESCE(SUM(CASE WHEN ${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.supplierId} IS NOT NULL THEN ${accountingEntries.amount} ELSE 0 END), 0) AS CHAR)`,
      saleEntryCount: sql<number>`SUM(CASE WHEN ${accountingEntries.entryType} = 'SALE' THEN 1 ELSE 0 END)`,
      returnEntryCount: sql<number>`SUM(CASE WHEN ${accountingEntries.entryType} = 'RETURN' THEN 1 ELSE 0 END)`,
    })
    .from(accountingEntries)
    .innerJoin(invoices, eq(invoices.id, accountingEntries.invoiceId))
    .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
    .where(
      and(
        isNotNull(accountingEntries.invoiceId),
        sql`${accountingEntries.entryDate} >= ${from}`,
        sql`${accountingEntries.entryDate} < ${toExclusive}`,
        // SALE/RETURN للبائع (supplierId فارغ)، أو قيد أمانة أُسنِد لفاتورته (PURCHASE بـsupplierId).
        sql`(
          (${accountingEntries.entryType} IN ('SALE','RETURN') AND ${accountingEntries.supplierId} IS NULL)
          OR (${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.supplierId} IS NOT NULL)
        )`,
      ),
    )
    .groupBy(sql`sellerId`);

  const map = new Map<number, UserMonthBase>();
  for (const r of rows) {
    if (r.sellerId == null) continue; // بائع غير قابل للإسناد (createdBy فارغ تاريخياً) — خارج الوعاء عمداً.
    map.set(Number(r.sellerId), {
      sales: money(r.sales),
      returns: money(r.returnsNeg).neg(),
      consigDeduction: money(r.consigDeduction),
      saleEntryCount: Number(r.saleEntryCount),
      returnEntryCount: Number(r.returnEntryCount),
    });
  }
  return map;
}

/** صافي الوعاء (مبيعات − مرتجعات) لمستخدم واحد — يعيد أصفاراً للخامل. */
export async function computeNetSalesForUser(runner: DB | Tx, period: string, userId: number): Promise<UserMonthBase> {
  const map = await computeNetSalesByUser(runner, period);
  return map.get(userId) ?? { sales: money(0), returns: money(0), consigDeduction: money(0), saleEntryCount: 0, returnEntryCount: 0 };
}
