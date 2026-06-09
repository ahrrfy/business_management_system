import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, invoices, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  getAPAging,
  getARAging,
  getCustomerStatement,
  getDashboardMetrics,
  getProfitByCategory,
  getSlowMovers,
  getSupplierStatement,
  getTopProducts,
} from "../services/reportsService";
import {
  reconcileCustomerBalances,
  reconcileInventory,
  reconcileLedgerProfit,
} from "../services/reconcileService";
import Decimal from "decimal.js";
import { money, toDbMoney } from "../services/money";
import { adminProcedure, managerProcedure, protectedProcedure, router } from "../trpc";

export const reportsRouter = router({
  arAging: managerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => getARAging({ branchId: input?.branchId })),

  customerStatement: managerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => getCustomerStatement(input.customerId)),

  /** Lightweight customer index for the statement picker. */
  customersIndex: managerProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        currentBalance: customers.currentBalance,
      })
      .from(customers)
      .orderBy(asc(customers.name));
  }),

  apAging: managerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => getAPAging({ branchId: input?.branchId })),

  supplierStatement: managerProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .query(async ({ input }) => getSupplierStatement(input.supplierId)),

  /** Lightweight supplier index for the statement picker. */
  suppliersIndex: managerProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        phone: suppliers.phone,
        currentBalance: suppliers.currentBalance,
      })
      .from(suppliers)
      .orderBy(asc(suppliers.name));
  }),

  /**
   * تقرير المبيعات التفصيلي — نطاق زمني اختياري + فلاتر.
   * يُعيد قائمة الفواتير مع ملخّص الإجماليات في النهاية.
   */
  salesReport: managerProcedure
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        branchId: z.number().int().positive().optional(),
        sourceTypes: z
          .array(z.enum(["POS", "ONLINE", "ORDER", "WORKORDER"]))
          .optional(),
        statuses: z
          .array(
            z.enum([
              "PENDING",
              "CONFIRMED",
              "PAID",
              "PARTIALLY_PAID",
              "CANCELLED",
              "RETURNED",
            ])
          )
          .optional(),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return { rows: [], totals: { count: 0, total: "0", paid: "0", unpaid: "0" } };

      const conditions = [];
      if (input.from) {
        conditions.push(sql`${invoices.invoiceDate} >= ${new Date(input.from)}`);
      }
      if (input.to) {
        // نهاية اليوم
        const to = new Date(input.to);
        to.setHours(23, 59, 59, 999);
        conditions.push(sql`${invoices.invoiceDate} <= ${to}`);
      }
      if (input.branchId) {
        conditions.push(eq(invoices.branchId, input.branchId));
      }
      if (input.sourceTypes && input.sourceTypes.length > 0) {
        conditions.push(inArray(invoices.sourceType, input.sourceTypes));
      }
      if (input.statuses && input.statuses.length > 0) {
        conditions.push(inArray(invoices.status, input.statuses));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          invoiceDate: invoices.invoiceDate,
          sourceType: invoices.sourceType,
          status: invoices.status,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          costTotal: invoices.costTotal,
          customerName: customers.name,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(where)
        .orderBy(desc(invoices.invoiceDate));

      // قاعدة §٥: لا parseFloat على المال — كله عبر decimal.js لتفادي انجراف 0.01 على آلاف الفواتير.
      const totals = rows.reduce(
        (acc, r) => {
          const total = money(r.total ?? "0");
          const paid = money(r.paidAmount ?? "0");
          const unpaid = Decimal.max(total.minus(paid), 0);
          acc.total = acc.total.plus(total);
          acc.paid = acc.paid.plus(paid);
          acc.unpaid = acc.unpaid.plus(unpaid);
          acc.count += 1;
          return acc;
        },
        { count: 0, total: new Decimal(0), paid: new Decimal(0), unpaid: new Decimal(0) },
      );

      return {
        rows,
        totals: {
          count: totals.count,
          total: toDbMoney(totals.total),
          paid: toDbMoney(totals.paid),
          unpaid: toDbMoney(totals.unpaid),
        },
      };
    }),

  /**
   * مقاييس لوحة التحكم — عدّاد المخزون المنخفض + الذمم المتأخّرة (> ٣٠ يوماً).
   * مرئيٌّ لكل مستخدم مصادَق (Dashboard متاحة للجميع). عزل الفرع:
   *   - admin/manager يمرّران branchId اختيارياً (أو يحصلان على كامل النظام إن لم يُحدَّد).
   *   - الكاشير/المخزن مقيَّدان دائماً بفرعهما (يتجاهل branchId المُمرَّر).
   * lowStockCount: متغيّرات تحت minStock (minStock > 0).
   * overdueAR: فواتير PENDING/PARTIALLY_PAID أعمارها > ٣٠ يوماً مع مجموع المتبقّي.
   */
  dashboardMetrics: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      // عزل الفرع: غير المرتفعين (cashier/warehouse) يُجبَرون على فرعهم.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const effectiveBranchId: number | null = elevated
        ? input?.branchId ?? null
        : Number(ctx.user.branchId ?? -1);
      return getDashboardMetrics({ branchId: effectiveBranchId });
    }),

  /** تدقيق التوافق المالي — للمشرف فقط. يكشف الانجراف الصامت في الأرصدة/المخزون/الدفتر. */
  reconcile: adminProcedure.query(async () => ({
    customers: await reconcileCustomerBalances(),
    inventory: await reconcileInventory(),
    ledger: await reconcileLedgerProfit(),
    runAt: new Date().toISOString(),
  })),

  /** أكثر المنتجات مبيعاً — ترتيب بالإيراد أو الكمية، فلاتر زمن+فرع. */
  topProducts: managerProcedure
    .input(
      z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(100).default(20),
          by: z.enum(["revenue", "qty"]).default("revenue"),
        })
        .optional()
    )
    .query(async ({ input }) => getTopProducts(input ?? {})),

  /** بطيئات الحركة — منتجات بمخزون موجب بلا بيع في النافذة. */
  slowMovers: managerProcedure
    .input(
      z
        .object({
          sinceDays: z.number().int().positive().max(365).default(90),
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(200).default(50),
        })
        .optional()
    )
    .query(async ({ input }) => getSlowMovers(input ?? {})),

  /** ربح حسب الفئة — تجميع revenue/cost/profit/margin على categoryId. */
  profitByCategory: managerProcedure
    .input(
      z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          branchId: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => getProfitByCategory(input ?? {})),
});
