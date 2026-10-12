/* ============================================================================
 * كنسة وعاء العمولة الشهري — **مصدر الحقيقة الواحد** لصافي مبيعات كل بائع ومشارك.
 * تُستهلك من: شبكة الأهداف (فعليّ الشهر السابق)، محرّك التشغيلات (S3)،
 * ولوحة الإنجاز/«أدائي» الحيّتين (S5) — استعلام مجمَّع واحد، لا N+1.
 *
 * القواعد المعمارية المحدثة (Milestone 1):
 *  - الإسناد متعدد الأدوار (Multi-Role Attribution): ربط اليسار بـ invoiceAttributions
 *    لقراءة المستفيد ونسبته (sharePct) بدقة متناهية.
 *  - التوافق الرجعي 100%: الفواتير السابقة لإنشاء invoiceAttributions تسقط بأمان
 *    إلى COALESCE(workOrders.createdBy, invoices.createdBy) بحصة 1.0000 (100%).
 *  - المرتجع يتبع الفاتورة الأصلية: يُخصَم من المساهمين الأصليين بنفس نسب مساهمتهم الأصلية.
 *  - بضاعة الأمانة: تُقتطع حصة المودع من الوعاء بنفس نسبة مساهمة البائع/الكاشير.
 *  - مجهزو طلبات المتجر وموظفو الاستقبال: احتساب عدادات التجهيز وأوامر الشغل لدعم
 *    الحوافز المقطوعة ومكافآت الـ SLA (مذكرة COORDINATION_STORE_ORDERS.md).
 * ========================================================================== */
import Decimal from "decimal.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  accountingEntries,
  invoiceAttributions,
  invoices,
  workOrders,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, round2 } from "../money";
import { periodDateRange } from "./period";

export interface UserMonthBase {
  /** Σ إيراد SALE (موجب) المسند للمستخدم بعد تطبيق نسبة التوزيع (sharePct). */
  sales: Decimal;
  /** |Σ إيراد RETURN| (موجب — القيود مخزّنة سالبة) المخصوم من المستخدم بنسبة مساهمته الأصلية. */
  returns: Decimal;
  /** بضاعة الأمانة (ش٣): Σ حصص المودِعين للمبيعات (قيود PURCHASE∧invoiceId∧supplierId) — تُخصَم من
   *  الوعاء (قرار المالك ٤: العمولة على الهامش فقط) موزّعة بنفس نسبة الإسناد. */
  consigDeduction: Decimal;
  /** عدد فواتير/قيود البيع المسندة للمستخدم. */
  saleEntryCount: number;
  /** عدد قيود المرتجعات المخصومة من المستخدم. */
  returnEntryCount: number;
  /** عدد طلبات المتجر التي جهزها المستخدم (role = 'FULFILLER') لدعم حوافز التجهيز المقطوعة. */
  fulfilledOrderCount: number;
  /** عدد أوامر الشغل التي فتحها المستخدم كاستقبال لدعم حوافز الاستقبال المقطوعة. */
  workOrderCount: number;
}

/** صافي وعاء الشهر لكل بائع (users.id) — Map فارغة الشهرَ الخاملَ. */
export async function computeNetSalesByUser(
  runner: DB | Tx,
  period: string,
  branchId?: number,
  targetUserId?: number,
): Promise<Map<number, UserMonthBase>> {
  const { from, toExclusive } = periodDateRange(period);

  const effectiveShare = sql`COALESCE(${invoiceAttributions.sharePct}, 1)`;

  const rows = await runner
    .select({
      sellerId: sql<number | null>`COALESCE(
        ${invoiceAttributions.userId},
        CASE WHEN ${invoices.sourceType} = 'WORKORDER' THEN ${workOrders.createdBy} END,
        ${invoices.createdBy}
      )`.as("sellerId"),
      sales: sql<string>`CAST(COALESCE(SUM(
        CASE
          WHEN ${accountingEntries.entryType} = 'SALE'
          THEN ${accountingEntries.revenue} * ${effectiveShare}
          ELSE 0
        END
      ), 0) AS CHAR)`,
      returnsNeg: sql<string>`CAST(COALESCE(SUM(
        CASE
          WHEN ${accountingEntries.entryType} = 'RETURN'
          THEN ${accountingEntries.revenue} * ${effectiveShare}
          ELSE 0
        END
      ), 0) AS CHAR)`,
      consigDeduction: sql<string>`CAST(COALESCE(SUM(
        CASE
          WHEN ${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.supplierId} IS NOT NULL
          THEN ${accountingEntries.amount} * ${effectiveShare}
          ELSE 0
        END
      ), 0) AS CHAR)`,
      saleEntryCount: sql<number>`SUM(CASE WHEN ${accountingEntries.entryType} = 'SALE' THEN 1 ELSE 0 END)`,
      returnEntryCount: sql<number>`SUM(CASE WHEN ${accountingEntries.entryType} = 'RETURN' THEN 1 ELSE 0 END)`,
      fulfilledOrderCount: sql<number>`SUM(
        CASE
          WHEN ${invoiceAttributions.role} = 'FULFILLER' AND ${accountingEntries.entryType} = 'SALE'
          THEN 1
          ELSE 0
        END
      )`,
      workOrderCount: sql<number>`SUM(
        CASE
          WHEN (${invoiceAttributions.role} = 'RECEPTIONIST' OR ${invoices.sourceType} = 'WORKORDER')
            AND ${accountingEntries.entryType} = 'SALE'
          THEN 1
          ELSE 0
        END
      )`,
    })
    .from(accountingEntries)
    .innerJoin(invoices, eq(invoices.id, accountingEntries.invoiceId))
    .leftJoin(
      invoiceAttributions,
      eq(invoiceAttributions.invoiceId, invoices.id),
    )
    .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
    .where(
      and(
        isNotNull(accountingEntries.invoiceId),
        sql`${accountingEntries.entryDate} >= ${from}`,
        sql`${accountingEntries.entryDate} < ${toExclusive}`,
        branchId != null ? eq(accountingEntries.branchId, branchId) : undefined,
        targetUserId != null
          ? sql`COALESCE(
              ${invoiceAttributions.userId},
              CASE WHEN ${invoices.sourceType} = 'WORKORDER' THEN ${workOrders.createdBy} END,
              ${invoices.createdBy}
            ) = ${targetUserId}`
          : undefined,
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
    if (r.sellerId == null) continue; // بائع غير قابل للإسناد — خارج الوعاء عمداً.
    map.set(Number(r.sellerId), {
      sales: round2(money(r.sales)),
      returns: round2(money(r.returnsNeg).neg()),
      consigDeduction: round2(money(r.consigDeduction)),
      saleEntryCount: Number(r.saleEntryCount),
      returnEntryCount: Number(r.returnEntryCount),
      fulfilledOrderCount: Number(r.fulfilledOrderCount ?? 0),
      workOrderCount: Number(r.workOrderCount ?? 0),
    });
  }
  return map;
}

/** صافي الوعاء (مبيعات − مرتجعات) لمستخدم واحد — يعيد أصفاراً للخامل. */
export async function computeNetSalesForUser(
  runner: DB | Tx,
  period: string,
  userId: number,
  branchId?: number,
): Promise<UserMonthBase> {
  const map = await computeNetSalesByUser(runner, period, branchId);
  return (
    map.get(userId) ?? {
      sales: money(0),
      returns: money(0),
      consigDeduction: money(0),
      saleEntryCount: 0,
      returnEntryCount: 0,
      fulfilledOrderCount: 0,
      workOrderCount: 0,
    }
  );
}
