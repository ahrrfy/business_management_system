import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, invoices, suppliers } from "../../drizzle/schema";
import { localDayStart, localNextDayStart } from "../services/dateRange";
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
  reconcileSupplierBalances,
  reconcileInventory,
  reconcileLedgerProfit,
} from "../services/reconcileService";
import Decimal from "decimal.js";
import { money, toDbMoney } from "../services/money";
import { adminProcedure, managerBranchScopedProcedure, managerProcedure, protectedProcedure, router } from "../trpc";

/** تاريخ فترة كشف الحساب YYYY-MM-DD — نصّ صريح لا Date (يُمرَّر كما هو لمقارنات SQL). */
const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ YYYY-MM-DD");

export const reportsRouter = router({
  arAging: managerBranchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = ctx.user.role === "admin" ? input?.branchId : Number(ctx.user.branchId);
      return getARAging({ branchId });
    }),

  customerStatement: managerBranchScopedProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        from: ymdStr.optional(),
        to: ymdStr.optional(),
      })
    )
    .query(async ({ input }) =>
      getCustomerStatement(input.customerId, { from: input.from, to: input.to })
    ),

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

  apAging: managerBranchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = ctx.user.role === "admin" ? input?.branchId : Number(ctx.user.branchId);
      return getAPAging({ branchId });
    }),

  supplierStatement: managerBranchScopedProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        from: ymdStr.optional(),
        to: ymdStr.optional(),
      })
    )
    .query(async ({ input }) =>
      getSupplierStatement(input.supplierId, { from: input.from, to: input.to })
    ),

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
  salesReport: managerBranchScopedProcedure
    .input(
      z.object({
        // ymdStr يرفض صيغاً غير YYYY-MM-DD برسالة عربية بدل localDayStart("abc") = Invalid Date
        // (الذي كان يبني SQL ينتج تقريراً فارغاً صامتاً ⇒ يُضلّل المحاسب).
        from: ymdStr.optional(),
        to: ymdStr.optional(),
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
        // الفجوة ١٦: حدّ صفحة افتراضي ١٠٠٠ بحدٍّ أعلى ٥٠٠٠ ⇒ يمنع DoS صامت
        // عند طلب مدير لنطاق سنوي يستنفد pool الاتصالات. الكاتب فجواتٍ في الواجهة
        // يجمع الصفحات عبر nextCursor.
        limit: z.number().int().min(1).max(5000).default(1000),
        // cursor: آخر invoice.id من الصفحة السابقة. غيابه = أول صفحة.
        // الترتيب desc(id) ⇒ الصفحة التالية = id أصغر من المؤشّر.
        cursor: z.number().int().positive().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db)
        return {
          rows: [],
          nextCursor: null as number | null,
          totals: { count: 0, total: "0", paid: "0", unpaid: "0" },
        };

      const conditions = [];
      // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
      if (input.from) {
        conditions.push(sql`${invoices.invoiceDate} >= ${localDayStart(input.from)}`);
      }
      if (input.to) {
        conditions.push(sql`${invoices.invoiceDate} < ${localNextDayStart(input.to)}`);
      }
      const effectiveBranchId = ctx.user.role === "admin" ? input.branchId : Number(ctx.user.branchId);
      if (effectiveBranchId) {
        conditions.push(eq(invoices.branchId, effectiveBranchId));
      }
      if (input.sourceTypes && input.sourceTypes.length > 0) {
        conditions.push(inArray(invoices.sourceType, input.sourceTypes));
      }
      if (input.statuses && input.statuses.length > 0) {
        conditions.push(inArray(invoices.status, input.statuses));
      }
      // مؤشّر keyset: id < cursor (الترتيب desc(id) ⇒ الصفحة التالية أقدم).
      // اخترنا keyset بدل offset لأن offset كبير على جدول الفواتير = مسح كامل ثم رمي،
      // أما lt(id, cursor) فيستفيد من فهرس المفتاح الأساسي مباشرةً.
      if (input.cursor !== undefined) {
        conditions.push(lt(invoices.id, input.cursor));
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
        // الترتيب الأساسي بالـid (desc) ليكون keyset cursor متّسقاً
        // (invoiceDate يبقى مرتبطاً بـid لأن الفواتير تُنشأ بالترتيب الزمني).
        .orderBy(desc(invoices.id))
        .limit(input.limit);

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

      // nextCursor = آخر id في الصفحة إن امتلأت ⇒ ربما بعدها المزيد.
      // أقل من limit ⇒ نهاية النتائج.
      const lastRow = rows[rows.length - 1];
      const nextCursor = rows.length === input.limit && lastRow ? lastRow.id : null;

      return {
        rows,
        nextCursor,
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
      // G3 (تدقيق ١٤/٦/٢٦): استبدل `?? -1` برميٍ صريح. كان -1 يجعل المؤشّرات تُحسب بـ
      // WHERE branchId=-1 فترجع أصفاراً صامتاً (المستخدم يرى لوحة فارغة بدل «ممنوع»).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let effectiveBranchId: number | null;
      if (elevated) {
        effectiveBranchId = input?.branchId ?? null;
      } else {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      return getDashboardMetrics({ branchId: effectiveBranchId });
    }),

  /** تدقيق التوافق المالي — للمشرف فقط. يكشف الانجراف الصامت في الأرصدة/المخزون/الدفتر. */
  reconcile: adminProcedure.query(async () => ({
    customers: await reconcileCustomerBalances(),
    suppliers: await reconcileSupplierBalances(),
    inventory: await reconcileInventory(),
    ledger: await reconcileLedgerProfit(),
    runAt: new Date().toISOString(),
  })),

  /** أكثر المنتجات مبيعاً — ترتيب بالإيراد أو الكمية، فلاتر زمن+فرع. */
  topProducts: managerProcedure
    .input(
      z
        .object({
          from: ymdStr.optional(),
          to: ymdStr.optional(),
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
          from: ymdStr.optional(),
          to: ymdStr.optional(),
          branchId: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => getProfitByCategory(input ?? {})),
});
