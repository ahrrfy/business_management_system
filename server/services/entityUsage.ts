/* ============================================================================
 * entityUsage — ملخّص ارتباطات المستخدم/الموظف عبر النظام (server/services/entityUsage.ts)
 *
 * الغرض المزدوج:
 *  1) حارس الحذف النهائي: «نظيف» = خلوّ كل الجداول المرجعية ⇒ يُسمح بالحذف، وإلا يُمنع.
 *  2) عرض «البيانات الفعلية» للكيان (ما فعله في النظام) في الواجهة وعند مسح كوده.
 *
 * ملاحظة أمان: قيود FK في القاعدة هي الحارس النهائي ضدّ تيتيم البيانات؛ هذا الملخّص
 * يقدّم سبباً عربياً دقيقاً ويعرض النشاط، لكن محاولة الحذف تبقى محميّة بـ FK أيضاً.
 * ========================================================================== */
import { eq, or, sql } from "drizzle-orm";
import { requireDb } from "./tx";
import {
  attendance,
  assetCustodyLog,
  auditLogs,
  creditApprovals,
  employeePromotions,
  employeeTerminations,
  employees,
  expenses,
  financialPeriods,
  fixedAssets,
  importBatches,
  inventoryMovements,
  invoices,
  kioskDevices,
  leaveRequests,
  payrollItems,
  payrollRuns,
  productionOrders,
  productionRecipes,
  purchaseOrders,
  quotations,
  receipts,
  shifts,
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItems,
  stocktakeSessions,
  workOrders,
  yearEndSnapshots,
} from "../../drizzle/schema";

export interface UsageCategory {
  key: string;
  label: string;
  count: number;
}

export interface UsageSummary {
  clean: boolean;
  total: number;
  categories: UsageCategory[];
}

/** عدّاد صفوف عام (table/cond مرنان لتفادي تعقيد أنواع drizzle). */
async function countRows(db: any, table: any, cond: any): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(table).where(cond);
  return Number(r?.n ?? 0);
}

/** مجموع عدّادات عدّة جداول (لتجميع فئة واحدة تمسّ أكثر من جدول). */
async function countAny(db: any, pairs: Array<[any, any]>): Promise<number> {
  const counts = await Promise.all(pairs.map(([table, cond]) => countRows(db, table, cond)));
  return counts.reduce((a, b) => a + b, 0);
}

/** أخطاء انتهاك مفتاح أجنبي (الصفّ مُشار إليه) — حارس الحذف النهائي على مستوى القاعدة. */
export function isFkBlocked(e: any): boolean {
  const code = e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code;
  const errno = e?.errno ?? e?.cause?.errno ?? e?.cause?.cause?.errno;
  return (
    code === "ER_ROW_IS_REFERENCED_2" ||
    code === "ER_ROW_IS_REFERENCED" ||
    errno === 1451 ||
    errno === 1217
  );
}

/** رسالة منع موحّدة تسرد فئات الارتباط غير الصفرية. */
export function usageBlockMessage(subject: string, usage: UsageSummary): string {
  const parts = usage.categories.filter((c) => c.count > 0).map((c) => `${c.label} (${c.count})`);
  const tail = parts.length ? `: ${parts.join("، ")}` : "";
  return `لا يمكن حذف ${subject} نهائياً لارتباطه بسجلّات${tail}. عطّله/أنهِ خدمته بدل الحذف.`;
}

/** ملخّص ارتباطات مستخدم عبر جداول الأعمال + الربط (createdBy/userId/approvedBy…). */
export async function getUserUsage(userId: number, conn?: any): Promise<UsageSummary> {
  const db = conn ?? requireDb();
  const defs: Array<[string, string, Promise<number>]> = [
    ["invoices", "فواتير", countRows(db, invoices, eq(invoices.createdBy, userId))],
    ["inventory", "حركات مخزون", countRows(db, inventoryMovements, eq(inventoryMovements.createdBy, userId))],
    ["shifts", "ورديات", countRows(db, shifts, eq(shifts.userId, userId))],
    ["expenses", "مصروفات", countRows(db, expenses, eq(expenses.createdBy, userId))],
    ["purchaseOrders", "طلبات شراء", countRows(db, purchaseOrders, eq(purchaseOrders.createdBy, userId))],
    [
      "workOrders",
      "أوامر شغل",
      countRows(db, workOrders, or(eq(workOrders.createdBy, userId), eq(workOrders.assignedTo, userId))),
    ],
    ["quotations", "عروض أسعار", countRows(db, quotations, eq(quotations.createdBy, userId))],
    ["receipts", "سندات قبض/صرف", countRows(db, receipts, eq(receipts.createdBy, userId))],
    [
      "payroll",
      "رواتب",
      countRows(
        db,
        payrollRuns,
        or(eq(payrollRuns.createdBy, userId), eq(payrollRuns.approvedBy, userId), eq(payrollRuns.paidBy, userId)),
      ),
    ],
    ["audit", "سجلّ تدقيق/دخول", countRows(db, auditLogs, eq(auditLogs.userId, userId))],
    ["employeeLink", "حساب موظف مرتبط", countRows(db, employees, eq(employees.userId, userId))],
    ["import", "دفعات استيراد", countRows(db, importBatches, eq(importBatches.createdBy, userId))],
    ["kiosk", "أجهزة كشك", countRows(db, kioskDevices, eq(kioskDevices.createdBy, userId))],
    [
      "production",
      "إنتاج (وصفات/أوامر)",
      countAny(db, [
        [productionRecipes, eq(productionRecipes.createdBy, userId)],
        [productionOrders, eq(productionOrders.createdBy, userId)],
      ]),
    ],
    [
      "stocktake",
      "جرد وتسوية",
      countAny(db, [
        [
          stocktakeSessions,
          or(
            eq(stocktakeSessions.createdBy, userId),
            eq(stocktakeSessions.firstSignBy, userId),
            eq(stocktakeSessions.approvedBy, userId),
            eq(stocktakeSessions.cancelledBy, userId),
          ),
        ],
        [stocktakeAssignments, eq(stocktakeAssignments.userId, userId)],
        [stocktakeItems, eq(stocktakeItems.recountRequestedBy, userId)],
        [stocktakeCounts, or(eq(stocktakeCounts.countedByUserId, userId), eq(stocktakeCounts.resolvedBy, userId))],
        [stocktakeDecisions, eq(stocktakeDecisions.decidedBy, userId)],
      ]),
    ],
    [
      "approvals",
      "موافقات وإقفال مالي",
      countAny(db, [
        [creditApprovals, eq(creditApprovals.approvedBy, userId)],
        [financialPeriods, eq(financialPeriods.lockedBy, userId)],
        [yearEndSnapshots, eq(yearEndSnapshots.closedBy, userId)],
        [employeePromotions, eq(employeePromotions.approvedBy, userId)],
        [leaveRequests, eq(leaveRequests.decidedBy, userId)],
      ]),
    ],
  ];
  const counts = await Promise.all(defs.map((d) => d[2]));
  const categories = defs.map((d, i) => ({ key: d[0], label: d[1], count: counts[i] }));
  const total = categories.reduce((a, c) => a + c.count, 0);
  return { clean: total === 0, total, categories };
}

/** ملخّص ارتباطات موظف (حضور/عُهد/رواتب/إجازات/ترقيات/إنهاءات). */
export async function getEmployeeUsage(employeeId: number, conn?: any): Promise<UsageSummary> {
  const db = conn ?? requireDb();
  const defs: Array<[string, string, Promise<number>]> = [
    ["attendance", "سجلّات حضور", countRows(db, attendance, eq(attendance.employeeId, employeeId))],
    ["assetCustodyCurrent", "عُهد حالية", countRows(db, fixedAssets, eq(fixedAssets.custodianId, employeeId))],
    ["assetCustodyLog", "سجلّ عُهد", countRows(db, assetCustodyLog, eq(assetCustodyLog.employeeId, employeeId))],
    ["payroll", "مفردات رواتب", countRows(db, payrollItems, eq(payrollItems.employeeId, employeeId))],
    ["leaves", "إجازات", countRows(db, leaveRequests, eq(leaveRequests.employeeId, employeeId))],
    ["promotions", "ترقيات", countRows(db, employeePromotions, eq(employeePromotions.employeeId, employeeId))],
    ["terminations", "إنهاءات خدمة", countRows(db, employeeTerminations, eq(employeeTerminations.employeeId, employeeId))],
  ];
  const counts = await Promise.all(defs.map((d) => d[2]));
  const categories = defs.map((d, i) => ({ key: d[0], label: d[1], count: counts[i] }));
  const total = categories.reduce((a, c) => a + c.count, 0);
  return { clean: total === 0, total, categories };
}
