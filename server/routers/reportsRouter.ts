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
import { workOrderProfitability } from "../services/reports/workOrderProfitability";
import { getMonthlyClosePack } from "../services/reports/monthlyClosePack";
import { getCourierPerformance } from "../services/reports/courierPerformance";
import { getCreditExposure } from "../services/reportsCreditExposureService";
import { getManagementAlerts } from "../services/reportsAlertsService";
import { getAnomalyWatch } from "../services/reports/anomalyWatch";
import { getDeadStockValue, getReorderRisk, getStocktakeVariance } from "../services/reportsInventoryOpsService";
import { money, toDbMoney } from "../services/money";
import { adminProcedure, protectedProcedure, reportViewerProcedure, router } from "../trpc";

// RBAC-REPORTS (تدقيق ٢/٧): كل تقارير هذا الراوتر (أرباح، دفتر أستاذ، أعمار ذمم، كشوف حساب، مبيعات)
// قراءةٌ حسّاسة تَخضع لخريطة صلاحية «reports» عبر reportViewerProcedure (manager/accountant/auditor
// + أدوار مخصّصة أساسها أحدها، كلٌّ حسب خريطته). العزل الفرعي مفروض داخل كل معالِج بـscopedBranchId.
const reportsBranchScoped = reportViewerProcedure;
const reportsProcedure = reportViewerProcedure;

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
  arAging: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getARAging({ branchId });
    }),

  /** مركز تنبيهات الإدارة — قلب الكوكبِت: قائمة متابعة مرتّبة بالخطورة (خطر + فعل). manager + عزل الفرع. */
  managementAlerts: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getManagementAlerts({ branchId, isAdmin: ctx.user.role === "admin" });
    }),

  /** رقيب الشذوذ — ٦ كواشف حتمية لمنع تسرّب الأموال (دون الكلفة/خصومات/مرتجعات/عجوزات/عكوس/تسلسل).
   *  بيانات كلفة وربح ⇒ بوابة reportViewerProcedure الحمراء نفسها + عزل الفرع. */
  anomalyWatch: reportsBranchScoped
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getAnomalyWatch({ from: input.from, to: input.to, branchId });
    }),

  /** التعرّض الائتماني للعملاء — أرصدة/متأخّر/حدّ ائتمان/تصنيف خطر. manager + عزل الفرع. */
  creditExposure: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getCreditExposure({ branchId });
    }),

  /** المخزون الراكد عالي القيمة — لا بيع منذ N يوماً، مرتّب بقيمة التجميد. manager + عزل الفرع. */
  deadStockValue: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional(), sinceDays: z.number().int().min(1).max(730).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getDeadStockValue({ branchId, sinceDays: input?.sinceDays });
    }),

  /** خطر النفاد — مبيعات عالية + رصيد عند/تحت حدّ الطلب. manager + عزل الفرع. */
  reorderRisk: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional(), sinceDays: z.number().int().min(1).max(365).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getReorderRisk({ branchId, sinceDays: input?.sinceDays });
    }),

  /** فروقات الجرد المعتمدة — حسب الفرع/التاريخ (stocktakeDecisions). manager + عزل الفرع. */
  stocktakeVariance: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional(), from: ymdStr.optional(), to: ymdStr.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getStocktakeVariance({ branchId, from: input?.from, to: input?.to });
    }),

  /** WIP (Work-in-Progress) — قيمة المواد المُستهلَكة في أوامر شغل IN_PROGRESS/READY (لم تصل بعد إلى SALE.cost). */
  wipReport: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional(), limit: z.number().int().positive().max(1000).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getWIPReport({ branchId, limit: input?.limit });
    }),

  customerStatement: reportsBranchScoped
    .input(z.object({ customerId: z.number().int().positive(), from: ymdStr.optional(), to: ymdStr.optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = ctx.user.role === "admin" ? undefined : Number(ctx.user.branchId ?? 0) || undefined;
      return getCustomerStatement(input.customerId, { from: input.from, to: input.to, branchId });
    }),

  /** Lightweight customer index for the statement picker. */
  customersIndex: reportsProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
      })
      .from(customers)
      .orderBy(asc(customers.name));
  }),

  apAging: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getAPAging({ branchId });
    }),

  supplierStatement: reportsBranchScoped
    .input(z.object({ supplierId: z.number().int().positive(), from: ymdStr.optional(), to: ymdStr.optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = ctx.user.role === "admin" ? undefined : Number(ctx.user.branchId ?? 0) || undefined;
      return getSupplierStatement(input.supplierId, { from: input.from, to: input.to, branchId });
    }),

  /** Lightweight supplier index for the statement picker. */
  suppliersIndex: reportsProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        phone: suppliers.phone,
      })
      .from(suppliers)
      .orderBy(asc(suppliers.name));
  }),

  /**
   * تقرير المبيعات التفصيلي — نطاق زمني اختياري + فلاتر.
   * يُعيد قائمة الفواتير مع ملخّص الإجماليات في النهاية.
   */
  salesReport: reportsBranchScoped
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
      // فلتر الإجماليات = كامل النطاق (from/to/branch/source/status) بلا مؤشّر الصفحة.
      const filterWhere = conditions.length > 0 ? and(...conditions) : undefined;
      // مؤشّر keyset للصفوف فقط: id < cursor (الترتيب desc(id) ⇒ الصفحة التالية أقدم).
      // keyset بدل offset: lt(id, cursor) يستفيد من فهرس المفتاح الأساسي مباشرةً.
      const rowConditions =
        input.cursor !== undefined ? [...conditions, lt(invoices.id, input.cursor)] : conditions;
      const where = rowConditions.length > 0 ? and(...rowConditions) : undefined;

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

      // الإجماليات على كامل نطاق الفلتر لا الصفحة المجلوبة (تدقيق ١٧/٧، خطر #5): كانت تُحسب بـreduce
      // على صفوف الصفحة (≤ limit) فتُعطي المحاسب إجماليات ناقصة تبدو نهائية لنطاق يتجاوز الحدّ. الآن
      // SUM خادميّ على كل المطابق. قاعدة §٥: CAST AS CHAR ثم decimal.js — لا parseFloat على المال.
      const totalsRow = (
        await db
          .select({
            cnt: sql<number>`COUNT(*)`,
            total: sql<string>`CAST(COALESCE(SUM(${invoices.total}), 0) AS CHAR)`,
            paid: sql<string>`CAST(COALESCE(SUM(${invoices.paidAmount}), 0) AS CHAR)`,
            unpaid: sql<string>`CAST(COALESCE(SUM(GREATEST(${invoices.total} - ${invoices.paidAmount}, 0)), 0) AS CHAR)`,
          })
          .from(invoices)
          .where(filterWhere)
      )[0] ?? { cnt: 0, total: "0", paid: "0", unpaid: "0" };
      const totals = {
        count: Number(totalsRow.cnt ?? 0),
        total: money(totalsRow.total ?? "0"),
        paid: money(totalsRow.paid ?? "0"),
        unpaid: money(totalsRow.unpaid ?? "0"),
      };

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
      // gap-audit ٥/٧ (HIGH): مدينو الرصيد الافتتاحي (openingScope) للأدمن حصراً — مطابقةً لحصر
      // نطاق openingScope نفسه في arRemindersRouter.ts (لا انتماء فرعيّ لهؤلاء المدينين، ولا مسار
      // للمدير للتصرّف بهم أصلاً — راجع openingWriteBranch).
      return getDashboardMetrics({
        branchId: effectiveBranchId,
        includeOpeningBalance: ctx.user.role === "admin",
      });
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
   * reportsBranchScoped تَرفض branchId مختلف عن فرع المدير، و scopedBranchId
   * تَفرض الفرع عند التجميع حتى لو حُذف branchId من الإدخال.
   */
  topProducts: reportsBranchScoped
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
  slowMovers: reportsBranchScoped
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
  profitByCategory: reportsBranchScoped
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
  profitAndLoss: reportsBranchScoped
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
  generalLedger: reportsBranchScoped
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
  financialPosition: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getFinancialPosition({ branchId });
    }),

  /** التدفّق النقدي (أساس نقدي مباشر) — صافي المقبوضات حسب اتّجاه/طريقة الدفع. manager + عزل الفرع. */
  cashFlow: reportsBranchScoped
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getCashFlow({ from: input.from, to: input.to, branchId });
    }),

  /** سجلّ المبيعات المفصّل — بنود الفواتير سطر-سطر + إجماليات + ترقيم. manager + عزل الفرع. */
  salesRegister: reportsBranchScoped
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

  /** المبيعات حسب بُعد (عميل/فرع/طريقة دفع/كاشير/صنف) + إجماليات وربحية. manager + عزل الفرع. */
  salesByDimension: reportsBranchScoped
    .input(z.object({
      from: ymdStr, to: ymdStr,
      branchId: z.number().int().positive().optional(),
      // بند 9 (٧/٧): بُعد «الصنف» — تجميع على مستوى بنود الفواتير بربحية بصيغة سجلّ المبيعات.
      dimension: z.enum(["customer", "branch", "paymentMethod", "cashier", "product"]),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getSalesByDimension({ from: input.from, to: input.to, branchId, dimension: input.dimension });
    }),

  /** بند 11 (٧/٧): حزمة الإقفال الشهري — مبيعات/ربح/مشتريات/مصاريف/خزينة/لقطة ذمم لشهر واحد.
   *  نفس بوّابة التقارير (تكشف ربحاً وتكلفة) + عزل الفرع بـscopedBranchId. */
  monthlyClosePack: reportsBranchScoped
    .input(z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "صيغة الشهر YYYY-MM"),
      branchId: z.number().int().positive().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getMonthlyClosePack({ month: input.month, branchId });
    }),

  /** تقرير المشتريات — ملخّص حسب المورّد (أوامر مؤكَّدة/مستلَمة). manager + عزل الفرع. */
  purchasesReport: reportsBranchScoped
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getPurchasesReport({ from: input.from, to: input.to, branchId });
    }),

  /** سجلّ المشتريات — تفصيل بنود أوامر الشراء (عدا الملغاة) + ترقيم. manager + عزل الفرع. */
  purchaseRegister: reportsBranchScoped
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
  arApAgingDetail: reportsBranchScoped
    .input(z.object({ side: z.enum(["AR", "AP"]), branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getArApAgingDetail({ side: input.side, branchId });
    }),

  /** تقييم المخزون بالتكلفة حسب الفئة (لقطة). manager + عزل الفرع. */
  inventoryValuation: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getInventoryValuation({ branchId });
    }),

  /** حالة المخزون / إعادة الطلب — رصيد كل صنف مقابل minStock. manager + عزل الفرع. */
  stockStatus: reportsBranchScoped
    .input(z.object({ branchId: z.number().int().positive().optional(), onlyAlerts: z.boolean().optional(), limit: z.number().int().positive().max(5000).optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getStockStatus({ branchId, onlyAlerts: input.onlyAlerts, limit: input.limit });
    }),

  /** بطاقة الصنف (Kardex) — حركات متغيّر واحد زمنياً برصيد متحرّك. manager + عزل الفرع. */
  itemLedger: reportsBranchScoped
    .input(z.object({
      variantId: z.number().int().positive(),
      branchId: z.number().int().positive().optional(),
      from: ymdStr.optional(), to: ymdStr.optional(),
      limit: z.number().int().positive().max(500).default(100),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getItemLedger({
        variantId: input.variantId, branchId, from: input.from, to: input.to,
        limit: input.limit, offset: input.offset,
      });
    }),

  /** تحليل ABC — تصنيف المنتجات حسب الإيراد (باريتو). manager + عزل الفرع. */
  abcAnalysis: reportsBranchScoped
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getAbcAnalysis({ from: input.from, to: input.to, branchId });
    }),

  /** ملخّص الخزينة — مقبوضات/مدفوعات حسب طريقة الدفع + فروقات الورديات. manager + عزل الفرع. */
  treasurySummary: reportsBranchScoped
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getTreasurySummary({ from: input.from, to: input.to, branchId });
    }),

  /** تقرير المصروفات — مصنّفةً حسب الفئة + أكبر جهات الصرف. manager + عزل الفرع. */
  expensesReport: reportsBranchScoped
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
  cashOrphans: reportsBranchScoped
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
  productionReport: reportsBranchScoped
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getProductionReport({ from: input.from, to: input.to, branchId });
    }),

  /**
   * ربحية أوامر الشغل (Job Costing) — أمرٌ-أمراً: إيراد (صافٍ قبل الضريبة عبر الفاتورة
   * المرتبطة) − تكلفة مواد − كلفة عملٍ اختيارية بالساعة (workSeconds × laborRatePerHour).
   * تكشف التكلفة/الربح ⇒ نفس بوّابة بقية التقارير (reportViewerProcedure: manager/accountant/
   * auditor + منح صريح — لا requireModule عارٍ، خط أحمر §٦) + عزل الفرع بـscopedBranchId.
   */
  workOrderProfitability: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        laborRatePerHour: z
          .string()
          .trim()
          .regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة (رقم موجب بمنزلتين كحدّ أقصى)")
          .optional(),
        limit: z.number().int().min(1).max(2000).default(500),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return workOrderProfitability({
        from: input.from,
        to: input.to,
        branchId,
        laborRatePerHour: input.laborRatePerHour ?? null,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  /** تقرير أوامر الشغل — توزيع الحالات + القنوات + ربحية المُسلَّم. manager + عزل الفرع. */
  workOrdersReport: reportsBranchScoped
    .input(z.object({ from: ymdStr, to: ymdStr, branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getWorkOrdersReport({ from: input.from, to: input.to, branchId });
    }),

  /**
   * أداء المناديب / جهات التوصيل — لطلبات المتجر الإلكتروني (COD) خلال فترة بتاريخ الطلب:
   * المُسنَد/المُسلَّم/قيد التوصيل/المتعذّر + قيمة المُسلَّم + COD المُحصَّل + معدّل التعذّر + العهدة القائمة.
   * يكشف قيمة/تحصيل النقد ⇒ نفس بوّابة التقارير (reportViewerProcedure) + عزل الفرع بـscopedBranchId.
   */
  courierPerformance: reportsBranchScoped
    .input(z.object({ from: ymdStr.optional(), to: ymdStr.optional(), branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getCourierPerformance({ from: input?.from, to: input?.to, branchId });
    }),
});
