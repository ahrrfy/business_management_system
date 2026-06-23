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
  getWIPReport,
} from "../services/reportsService";
import {
  reconcileCustomerBalances,
  reconcileSupplierBalances,
  reconcileInventory,
  reconcileLedgerProfit,
} from "../services/reconcileService";
import { getCashFlow, getFinancialPosition, getGeneralLedger, getProfitAndLoss } from "../services/reportsFinancialService";
import { getSalesRegister, getSalesByDimension } from "../services/reportsSalesService";
import { getPurchasesReport, getPurchaseRegister } from "../services/reportsPurchasesService";
import { getArApAgingDetail } from "../services/reportsAgingDetailService";
import { getInventoryValuation, getStockStatus } from "../services/reportsInventoryService";
import { getItemLedger, getAbcAnalysis } from "../services/reportsInventoryAnalyticsService";
import { getTreasurySummary, getExpensesReport, getCashOrphansReport } from "../services/reportsTreasuryService";
import { getProductionReport, getWorkOrdersReport } from "../services/reportsProductionService";
import Decimal from "decimal.js";
import { money, toDbMoney } from "../services/money";
import { adminProcedure, managerBranchScopedProcedure, managerProcedure, protectedProcedure, router } from "../trpc";

/** تاريخ فترة كشف الحساب YYYY-MM-DD — نصّ صريح لا Date (يُمرَّر كما هو لمقارنات SQL). */
const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ YYYY-MM-DD");

/**
 * يحلّ فرع التقرير مع عزل صارم: admin يعبُر أي فرع (input.branchId أو الكل)؛ غير-admin يُقيَّد بفرعه.
 * يُرفَض غير-admin بلا فرع مُسنَد بـFORBIDDEN بدل أن يسقط Number(null)=0 falsy فتُسقَط فلترة الفرع
 * وتُكشف بيانات كل الفروع (ثغرة عزل أمسكتها المراجعة العدائية). مرآةٌ لحارس dashboardMetrics/branchScopedProcedure.
 */
function scopedBranchId(
  ctx: { user: { role: string; branchId?: number | null } },
  inputBranchId?: number,
): number | undefined {
  if (ctx.user.role === "admin") return inputBranchId;
  if (ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  return Number(ctx.user.branchId);
}

export const reportsRouter = router({
  arAging: managerBranchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getARAging({ branchId });
    }),

  /** WIP (Work-in-Progress) — قيمة المواد المُستهلَكة في أوامر شغل IN_PROGRESS/READY (لم تصل بعد إلى SALE.cost). */
  wipReport: managerBranchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional(), limit: z.number().int().positive().max(1000).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getWIPReport({ branchId, limit: input?.limit });
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
      const branchId = scopedBranchId(ctx, input?.branchId);
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
      const effectiveBranchId = scopedBranchId(ctx, input.branchId);
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

  /**
   * أكثر المنتجات مبيعاً — ترتيب بالإيراد أو الكمية، فلاتر زمن+فرع.
   *
   * **عزل الفرع (تدقيق ٢٣/٦/٢٦):** كانت managerProcedure تُسرّب هامش الربح وقائمة منتجات
   * فرعٍ آخر إلى مدير الفرع الحالي ⇒ كَسر حاجز السلطة المالية بين الفروع. الآن
   * managerBranchScopedProcedure تَرفض branchId مختلف عن فرع المدير، و scopedBranchId
   * تَفرض الفرع عند التجميع حتى لو حُذف branchId من الإدخال.
   */
  topProducts: managerBranchScopedProcedure
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
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getTopProducts({ ...(input ?? {}), branchId });
    }),

  /** بطيئات الحركة — منتجات بمخزون موجب بلا بيع في النافذة. عزل الفرع: مدير الفرع لا يَرى
   *  حركة فرعٍ آخر (انظر شرح topProducts). */
  slowMovers: managerBranchScopedProcedure
    .input(
      z
        .object({
          sinceDays: z.number().int().positive().max(365).default(90),
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(200).default(50),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getSlowMovers({ ...(input ?? {}), branchId });
    }),

  /** ربح حسب الفئة — تجميع revenue/cost/profit/margin على categoryId.
   *  عزل الفرع: مدير الفرع لا يَرى ربح فرعٍ آخر (انظر شرح topProducts). */
  profitByCategory: managerBranchScopedProcedure
    .input(
      z
        .object({
          from: ymdStr.optional(),
          to: ymdStr.optional(),
          branchId: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getProfitByCategory({ ...(input ?? {}), branchId });
    }),

  /**
   * قائمة الأرباح والخسائر المبسّطة — إيراد صافٍ − تكلفة المبيعات − مصروفات تشغيلية.
   * تكشف التكلفة/الربح ⇒ manager فأعلى + عزل الفرع. مقارنة فترة اختيارية (compareFrom/To).
   */
  profitAndLoss: managerBranchScopedProcedure
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        compareFrom: ymdStr.optional(),
        compareTo: ymdStr.optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getProfitAndLoss({
        from: input.from,
        to: input.to,
        branchId,
        compareFrom: input.compareFrom,
        compareTo: input.compareTo,
      });
    }),

  /**
   * دفتر اليومية / الأستاذ — تصفّح قيود accountingEntries بفلاتر (تاريخ/فرع/نوع) + إجماليات.
   * يكشف الإيراد/التكلفة/الربح ⇒ manager فأعلى + عزل الفرع.
   */
  generalLedger: managerBranchScopedProcedure
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        entryTypes: z
          .array(
            z.enum([
              "SALE", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "RETURN", "ADJUST", "OPENING", "INTERNAL_USE", "WASTAGE",
            ])
          )
          .optional(),
        limit: z.number().int().min(1).max(2000).default(200),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getGeneralLedger({
        from: input.from,
        to: input.to,
        branchId,
        entryTypes: input.entryTypes,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  /**
   * المركز المالي (لقطة) — يُغذّي ميزان المراجعة والميزانية العمومية المبسّطة.
   * يكشف الأرصدة/المخزون ⇒ manager فأعلى + عزل الفرع (النقد/المخزون حسب الفرع؛ الذمم على مستوى الشركة).
   */
  financialPosition: managerBranchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getFinancialPosition({ branchId });
    }),

  /** التدفّق النقدي (أساس نقدي مباشر) — صافي المقبوضات حسب اتّجاه/طريقة الدفع. manager + عزل الفرع. */
  cashFlow: managerBranchScopedProcedure
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getCashFlow({ from: input.from, to: input.to, branchId });
    }),

  /** سجلّ المبيعات المفصّل — بنود الفواتير سطر-سطر + إجماليات + ترقيم. manager + عزل الفرع. */
  salesRegister: managerBranchScopedProcedure
    .input(z.object({
      from: ymdStr, to: ymdStr,
      branchId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(2000).default(200),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getSalesRegister({ from: input.from, to: input.to, branchId, limit: input.limit, offset: input.offset });
    }),

  /** المبيعات حسب بُعد (عميل/فرع/طريقة دفع/كاشير) + إجماليات. manager + عزل الفرع. */
  salesByDimension: managerBranchScopedProcedure
    .input(z.object({
      from: ymdStr, to: ymdStr,
      branchId: z.number().int().positive().optional(),
      dimension: z.enum(["customer", "branch", "paymentMethod", "cashier"]),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getSalesByDimension({ from: input.from, to: input.to, branchId, dimension: input.dimension });
    }),

  /** تقرير المشتريات — ملخّص حسب المورّد (أوامر مؤكَّدة/مستلَمة). manager + عزل الفرع. */
  purchasesReport: managerBranchScopedProcedure
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getPurchasesReport({ from: input.from, to: input.to, branchId });
    }),

  /** سجلّ المشتريات — تفصيل بنود أوامر الشراء (عدا الملغاة) + ترقيم. manager + عزل الفرع. */
  purchaseRegister: managerBranchScopedProcedure
    .input(z.object({
      from: ymdStr, to: ymdStr,
      branchId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(2000).default(200),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getPurchaseRegister({ from: input.from, to: input.to, branchId, limit: input.limit, offset: input.offset });
    }),

  /** تفصيل أعمار الذمم — مستندٌ بمستند (AR فواتير / AP أوامر شراء). manager + عزل الفرع. */
  arApAgingDetail: managerBranchScopedProcedure
    .input(z.object({ side: z.enum(["AR", "AP"]), branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getArApAgingDetail({ side: input.side, branchId });
    }),

  /** تقييم المخزون بالتكلفة حسب الفئة (لقطة). manager + عزل الفرع. */
  inventoryValuation: managerBranchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getInventoryValuation({ branchId });
    }),

  /** حالة المخزون / إعادة الطلب — رصيد كل صنف مقابل minStock. manager + عزل الفرع. */
  stockStatus: managerBranchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional(), onlyAlerts: z.boolean().optional(), limit: z.number().int().positive().max(5000).optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getStockStatus({ branchId, onlyAlerts: input.onlyAlerts, limit: input.limit });
    }),

  /** بطاقة الصنف (Kardex) — حركات متغيّر واحد زمنياً برصيد متحرّك. manager + عزل الفرع. */
  itemLedger: managerBranchScopedProcedure
    .input(z.object({
      variantId: z.number().int().positive(),
      branchId: z.number().int().positive().optional(),
      from: ymdStr.optional(), to: ymdStr.optional(),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getItemLedger({ variantId: input.variantId, branchId, from: input.from, to: input.to });
    }),

  /** تحليل ABC — تصنيف المنتجات حسب الإيراد (باريتو). manager + عزل الفرع. */
  abcAnalysis: managerBranchScopedProcedure
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getAbcAnalysis({ from: input.from, to: input.to, branchId });
    }),

  /** ملخّص الخزينة — مقبوضات/مدفوعات حسب طريقة الدفع + فروقات الورديات. manager + عزل الفرع. */
  treasurySummary: managerBranchScopedProcedure
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getTreasurySummary({ from: input.from, to: input.to, branchId });
    }),

  /** تقرير المصروفات — مصنّفةً حسب الفئة + أكبر جهات الصرف. manager + عزل الفرع. */
  expensesReport: managerBranchScopedProcedure
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getExpensesReport({ from: input.from, to: input.to, branchId });
    }),

  /**
   * المعاملات النقدية اليتيمة — receipts بـshiftId IS NULL وpaymentMethod='CASH'.
   * هذه المعاملات تختفي من Z-report (computeExpectedCash يفلتر بـeq(receipts.shiftId, shiftId))
   * فيظهر فرق صامت في تسوية الصندوق. التقرير لقراءة فقط ليرصدها المالك تاريخياً
   * ويسوّيها يدوياً. بعد تفعيل إنفاذ الوردية للمعاملات النقدية، لن تُكتب أي معاملة جديدة في
   * هذه الحالة (الخدمات ترمي PRECONDITION_FAILED قبل الكتابة). manager + عزل الفرع.
   */
  cashOrphans: managerBranchScopedProcedure
    .input(
      z
        .object({
          from: ymdStr.optional(),
          to: ymdStr.optional(),
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(5000).optional(),
          category: z.enum(["TREASURY", "TRUE_ORPHAN"]).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getCashOrphansReport({
        from: input?.from,
        to: input?.to,
        branchId,
        limit: input?.limit,
        category: input?.category,
      });
    }),

  /** تقرير الإنتاج — مستندات الإنتاج المؤكَّدة + تفصيل الكلفة. manager + عزل الفرع. */
  productionReport: managerBranchScopedProcedure
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getProductionReport({ from: input.from, to: input.to, branchId });
    }),

  /** تقرير أوامر الشغل — توزيع الحالات + القنوات + ربحية المُسلَّم. manager + عزل الفرع. */
  workOrdersReport: managerBranchScopedProcedure
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getWorkOrdersReport({ from: input.from, to: input.to, branchId });
    }),
});
