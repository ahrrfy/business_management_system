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
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { requireDb } from "./tx";
import {
  attendance,
  assetCustodyLog,
  auditLogs,
  branchStock,
  bundleComponents,
  creditApprovals,
  customerContractPrices,
  employeePromotions,
  employeeTerminations,
  employees,
  expenseStockItems,
  expenses,
  financialPeriods,
  fixedAssets,
  importBatches,
  inventoryMovements,
  invoiceItemBundleComponents,
  invoiceItems,
  invoices,
  kioskDevices,
  leaveRequests,
  onlineOrderItems,
  payrollItems,
  payrollRuns,
  productUnits,
  productVariants,
  products,
  productionLines,
  productionOrders,
  productionRecipeLines,
  productionRecipes,
  purchaseOrderItems,
  purchaseOrders,
  quotationItems,
  quotations,
  receipts,
  shifts,
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItems,
  stocktakeSessions,
  workOrderItems,
  workOrderMaterials,
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
      "طلبات خدمة",
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

/**
 * ملخّص ارتباطات منتج عبر كل الجداول التي تُشير لمتغيّراته/وحداته (حركات/فواتير/مشتريات/أوامر شغل/
 * جرد/إنتاج/مصاريف/أسعار تعاقدية/بكجات…). منتج «نظيف» = صفر في كل الفئات ⇒ يمكن حذفه نهائياً؛
 * وإلا يُمنع الحذف وتُعرض فئات الارتباط (`usageBlockMessage`). قيود FK (RESTRICT الافتراضي على أغلب
 * هذه الجداول) هي الحارس النهائي ضدّ التيتيم — هذا الملخّص سبب عربي دقيق واستباقي فقط.
 */
export async function getProductUsage(productId: number, conn?: any): Promise<UsageSummary> {
  const db = conn ?? requireDb();
  const variantRows = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, productId));
  const variantIds: number[] = variantRows.map((r: any) => Number(r.id));
  const unitRows = variantIds.length
    ? await db.select({ id: productUnits.id }).from(productUnits).where(inArray(productUnits.variantId, variantIds))
    : [];
  const unitIds: number[] = unitRows.map((r: any) => Number(r.id));

  // شرط زائف بلا نتائج حين لا متغيّرات/وحدات — يتجنّب inArray(col, []) غير الصالحة في drizzle.
  const vCond = (col: any) => (variantIds.length ? inArray(col, variantIds) : sql`1=0`);
  const uCond = (col: any) => (unitIds.length ? inArray(col, unitIds) : sql`1=0`);

  const defs: Array<[string, string, Promise<number>]> = [
    ["movements", "حركات مخزون", countRows(db, inventoryMovements, vCond(inventoryMovements.variantId))],
    [
      "stockOnHand",
      "رصيد مخزون حالي (فروع برصيد ≠ صفر)",
      countRows(db, branchStock, and(vCond(branchStock.variantId), sql`${branchStock.quantity} <> 0`)),
    ],
    ["invoiceItems", "بنود فواتير بيع", countRows(db, invoiceItems, vCond(invoiceItems.variantId))],
    ["quotationItems", "بنود عروض أسعار", countRows(db, quotationItems, vCond(quotationItems.variantId))],
    ["workOrdersBase", "أوامر شغل (منتج أساس)", countRows(db, workOrders, vCond(workOrders.baseVariantId))],
    [
      "workOrderLines",
      "أسطر أوامر شغل (مواد/أصناف)",
      countAny(db, [
        [workOrderMaterials, vCond(workOrderMaterials.variantId)],
        [workOrderItems, vCond(workOrderItems.variantId)],
      ]),
    ],
    ["purchaseOrderItems", "بنود أوامر شراء", countRows(db, purchaseOrderItems, vCond(purchaseOrderItems.variantId))],
    ["onlineOrderItems", "بنود طلبات المتجر الإلكتروني", countRows(db, onlineOrderItems, vCond(onlineOrderItems.variantId))],
    [
      "stocktake",
      "جرد وتسوية",
      countAny(db, [
        [stocktakeItems, vCond(stocktakeItems.variantId)],
        [stocktakeCounts, vCond(stocktakeCounts.variantId)],
        [stocktakeDecisions, vCond(stocktakeDecisions.variantId)],
      ]),
    ],
    [
      "production",
      "وصفات/أسطر إنتاج",
      countAny(db, [
        [productionRecipes, vCond(productionRecipes.outputVariantId)],
        [productionRecipeLines, vCond(productionRecipeLines.inputVariantId)],
        [productionLines, vCond(productionLines.variantId)],
      ]),
    ],
    ["expenseStockItems", "أصناف مصروف مخزون", countRows(db, expenseStockItems, vCond(expenseStockItems.variantId))],
    ["contractPrices", "أسعار تعاقدية لعملاء", countRows(db, customerContractPrices, uCond(customerContractPrices.productUnitId))],
    [
      "bundleComponent",
      "مكوّن في بكج (حالي/تاريخي)",
      countAny(db, [
        [bundleComponents, vCond(bundleComponents.componentVariantId)],
        [invoiceItemBundleComponents, vCond(invoiceItemBundleComponents.componentVariantId)],
      ]),
    ],
    ["childProducts", "منتج أب لمنتجات أخرى (نَسَب)", countRows(db, products, eq(products.parentProductId, productId))],
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
