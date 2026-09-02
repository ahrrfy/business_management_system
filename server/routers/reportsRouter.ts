import { TRPCError } from "@trpc/server";
import { INVOICE_STATUSES } from "@shared/invoiceStatus";
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { branches, customers, invoices, suppliers } from "../../drizzle/schema";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import { parseBusinessYmd } from "../services/businessDay";
import { maskBankFields } from "../lib/redact";
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
  getFinancialReconciliationDetails,
  toFinancialReconciliationSummary,
} from "../services/reports/reconcileSummary";
import { getCustomerJournalBreakdown } from "../services/reports/customerJournalBreakdown";
import {
  getCashFlow,
  getFinancialPosition,
  getProfitAndLoss,
} from "../services/reportsFinancialService";
import { getGeneralLedger } from "../services/reports/generalLedger";
import {
  getDoubleEntryReportAvailability,
  getTrialBalance,
} from "../services/reports/trialBalance";
import {
  getSalesRegister,
  getSalesByDimension,
} from "../services/reportsSalesService";
import {
  getPurchasesReport,
  getPurchaseRegister,
} from "../services/reportsPurchasesService";
import { getArApAgingDetail } from "../services/reportsAgingDetailService";
import {
  getInventoryValuation,
  getStockStatus,
} from "../services/reportsInventoryService";
import { readValuationAt } from "../services/inventory/valuationSnapshot";
import { withTx } from "../services/tx";
import {
  getItemLedger,
  getAbcAnalysis,
} from "../services/reportsInventoryAnalyticsService";
import {
  getTreasurySummary,
  getExpensesReport,
  getCashOrphansReport,
} from "../services/reportsTreasuryService";
import { getDayCloseReconciliation } from "../services/reportsDayCloseService";
import {
  getProductionReport,
  getProductionReportPage,
  getWorkOrdersReport,
} from "../services/reportsProductionService";
import { workOrderProfitability } from "../services/reports/workOrderProfitability";
import { getMonthCloseReadiness } from "../services/reports/monthCloseReadiness";
import { getMonthlyClosePack } from "../services/reports/monthlyClosePack";
import {
  getConsignmentAging,
  getCourierPerformance,
} from "../services/reports/courierPerformance";
import { getCreditExposure } from "../services/reportsCreditExposureService";
import { getManagementAlerts } from "../services/reportsAlertsService";
import { getAnomalyWatch } from "../services/reports/anomalyWatch";
import {
  getDeadStockValue,
  getNegativeStock,
  getReorderRisk,
  getStocktakeVariance,
} from "../services/reportsInventoryOpsService";
import {
  agentVolumeReport,
  campaignPerformanceReport,
  csatReport,
  taskResponseReport,
} from "../services/reports/whatsappReports";
import { money, toDbMoney } from "../services/money";
import {
  adminProcedure,
  settingsAdminProcedure,
  canViewReports,
  protectedProcedure,
  reportViewerProcedure,
  router,
} from "../trpc";

// RBAC-REPORTS (تدقيق ٢/٧): كل تقارير هذا الراوتر (أرباح، دفتر أستاذ، أعمار ذمم، كشوف حساب، مبيعات)
// قراءةٌ حسّاسة تَخضع لخريطة صلاحية «reports» عبر reportViewerProcedure (manager/accountant/auditor
// + أدوار مخصّصة أساسها أحدها، كلٌّ حسب خريطته). العزل الفرعي مفروض داخل كل معالِج بـscopedBranchId.
const reportsBranchScoped = reportViewerProcedure;
const reportsProcedure = reportViewerProcedure;

/** تاريخ فترة كشف الحساب YYYY-MM-DD — نصّ صريح لا Date (يُمرَّر كما هو لمقارنات SQL). */
const ymdStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ YYYY-MM-DD");
const strictYmdStr = ymdStr.refine((value) => {
  try {
    parseBusinessYmd(value);
    return true;
  } catch {
    return false;
  }
}, "تاريخ تقويمي غير صالح");

/** الشهر المدني المرئي في بغداد؛ لا يُشتق من UTC كي لا ينقلب قرب منتصف الليل المحلي. */
function currentBaghdadMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("تعذّر تحديد شهر الأعمال بتوقيت بغداد");
  return `${year}-${month}`;
}

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
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا فرع مُسنَد لهذا المستخدم",
    });
  }
  return Number(ctx.user.branchId);
}

export const reportsRouter = router({
  arAging: reportsBranchScoped
    .input(
      z.object({ branchId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getARAging({ branchId });
    }),

  /** مركز تنبيهات الإدارة — قلب الكوكبِت: قائمة متابعة مرتّبة بالخطورة (خطر + فعل). manager + عزل الفرع. */
  managementAlerts: reportsBranchScoped
    .input(
      z.object({ branchId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getManagementAlerts({
        branchId,
        isAdmin: ctx.user.role === "admin",
      });
    }),

  /** رقيب الشذوذ — ٦ كواشف حتمية لمنع تسرّب الأموال (دون الكلفة/خصومات/مرتجعات/عجوزات/عكوس/تسلسل).
   *  بيانات كلفة وربح ⇒ بوابة reportViewerProcedure الحمراء نفسها + عزل الفرع. */
  anomalyWatch: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getAnomalyWatch({ from: input.from, to: input.to, branchId });
    }),

  /** التعرّض الائتماني للعملاء — أرصدة/متأخّر/حدّ ائتمان/تصنيف خطر. manager + عزل الفرع. */
  creditExposure: reportsBranchScoped
    .input(
      z.object({ branchId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getCreditExposure({ branchId });
    }),

  /** المخزون الراكد عالي القيمة — لا بيع منذ N يوماً، مرتّب بقيمة التجميد. manager + عزل الفرع. */
  deadStockValue: reportsBranchScoped
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          sinceDays: z.number().int().min(1).max(730).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getDeadStockValue({ branchId, sinceDays: input?.sinceDays });
    }),

  /** السوالب — أرصدة تحت الصفر (وضع الافتتاح ١٨/٧): بوصلة أولوية الجرد الافتتاحي. بقيمة التكلفة
   *  ⇒ خلف بوّابة التقارير الحمراء حصراً (خط §٦ — الكاشير/المخزن محجوبان). manager + عزل الفرع. */
  negativeStock: reportsBranchScoped
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(2000).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getNegativeStock({ branchId, limit: input?.limit });
    }),

  /** خطر النفاد — مبيعات عالية + رصيد عند/تحت حدّ الطلب. manager + عزل الفرع. */
  reorderRisk: reportsBranchScoped
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          sinceDays: z.number().int().min(1).max(365).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getReorderRisk({ branchId, sinceDays: input?.sinceDays });
    }),

  /** فروقات الجرد المعتمدة — حسب الفرع/التاريخ (stocktakeDecisions). manager + عزل الفرع. */
  stocktakeVariance: reportsBranchScoped
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          from: ymdStr.optional(),
          to: ymdStr.optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getStocktakeVariance({
        branchId,
        from: input?.from,
        to: input?.to,
      });
    }),

  /** WIP (Work-in-Progress) — قيمة المواد المُستهلَكة في أوامر شغل IN_PROGRESS/READY (لم تصل بعد إلى SALE.cost). */
  wipReport: reportsBranchScoped
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(1000).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getWIPReport({ branchId, limit: input?.limit });
    }),

  customerStatement: reportsBranchScoped
    .input(
      z.object({
        customerId: z.number().int().positive(),
        from: ymdStr.optional(),
        to: ymdStr.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع (تدقيق ١٧/٧): النمط القديم Number(branchId ?? 0) || undefined كان يمنح غير الأدمن
      // بلا فرعٍ مُسنَد كشفاً بكل الفروع صامتاً. نوحّده مع بقية التقارير عبر scopedBranchId (FORBIDDEN
      // لغير الأدمن بلا فرع). ملاحظة مالك مؤجَّلة (§٧.٣): الكشف الفرعيّ للطرف ذي الرصيد العالميّ
      // غير متّزن بنيوياً (الدفعات/المُرحَّل عالميّة) — قرار العزل عبر الفروع بيد المالك.
      const branchId = scopedBranchId(ctx);
      return getCustomerStatement(input.customerId, {
        from: input.from,
        to: input.to,
        branchId,
      });
    }),

  /**
   * Tier-3 #6 (٢٧/٨): تفصيل حساب العميل بالحسابات المحاسبيّة من الدفتر المزدوج.
   * يستهلك أبعاد Tier-3 #2 (`journalLines.customerId + accountId`). في وضع OFF
   * الافتراضيّ يعود فارغاً — لا كذبٌ. نفس عزل الفرع كـcustomerStatement.
   */
  customerJournalBreakdown: reportsBranchScoped
    .input(
      z.object({
        customerId: z.number().int().positive(),
        from: ymdStr.optional(),
        to: ymdStr.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx);
      return getCustomerJournalBreakdown({
        customerId: input.customerId,
        from: input.from,
        to: input.to,
        branchId,
      });
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
    .input(
      z.object({ branchId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getAPAging({ branchId });
    }),

  supplierStatement: reportsBranchScoped
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        from: ymdStr.optional(),
        to: ymdStr.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع (تدقيق ١٧/٧): توحيدٌ مع scopedBranchId (كان النمط القديم يُسرّب كل الفروع لغير
      // الأدمن بلا فرع). رصيد المورّد عالميّ ⇒ الكشف الفرعيّ غير متّزن (ملاحظة مالك §٧.٣ مؤجَّلة).
      const branchId = scopedBranchId(ctx);
      const res = await getSupplierStatement(input.supplierId, {
        from: input.from,
        to: input.to,
        branchId,
      });
      // حجب الحقول المصرفية (iban/bankName/swift) عن غير المرتفعين (محاسب/مدقّق) — الكشف كان يُرجع
      // صفّ المورّد كاملاً خاماً، التفافاً على الحجب المطبَّق في suppliers.get (تدقيق ١٧/٧).
      return (
        res && { ...res, supplier: maskBankFields(res.supplier, ctx.user.role) }
      );
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
        // `SUPERSEDED` كانت غائبةً هنا وعن خيارات الشاشة معاً ⇒ حالةٌ موجودةٌ في البيانات
        // وغير موجودةٍ في أيّ فلتر: لا تُعرَض ولا تُستبعَد، بينما التقرير **بلا استثناءٍ أساسيّ
        // للحالة** فتدخل الإجمالي وغير المدفوع بقيمتها كاملة (الأصل المُستبدَل يبقى بـtotal
        // كاملاً وreturnedTotal مُصفَّراً). صارت قابلةً للفلترة والاستبعاد صراحةً.
        statuses: z.array(z.enum(INVOICE_STATUSES)).optional(),
        // فلتر طريقة الدفع على invoices.paymentMethod نفسه الذي يعرضه التقرير عموداً —
        // "NONE" = فاتورة بلا طريقة مسجَّلة (آجل/تاريخية قبل بدء التسجيل) أي IS NULL.
        paymentMethods: z
          .array(
            z.enum([
              "CASH",
              "CARD",
              "CHECK",
              "TRANSFER",
              "WALLET",
              "TELECOM",
              "MIXED",
              "NONE",
            ]),
          )
          .optional(),
        // فلتر الكاشير/البائع — الإسناد بمُنشئ الفاتورة (createdBy)، يستفيد من فهرس
        // idx_invoice_salesperson_date.
        // ١٩/٨: صار هذا صحيحاً لفواتير أوامر الشغل أيضاً — `createdBy` يُختَم الآن بمنشئ
        // الطلب لا بالمُسلِّم (deliver.ts/dispatch.ts)، فالتقرير ينسب البيع لبائعه الحقيقيّ.
        // الفواتير التاريخية تبقى منسوبةً للمُسلِّم (append-only — لا إعادة ترحيل بلا قرار).
        salespersonId: z.number().int().positive().optional(),
        // الفجوة ١٦: حدّ صفحة افتراضي ١٠٠٠ بحدٍّ أعلى ٥٠٠٠ ⇒ يمنع DoS صامت
        // عند طلب مدير لنطاق سنوي يستنفد pool الاتصالات. الكاتب فجواتٍ في الواجهة
        // يجمع الصفحات عبر nextCursor.
        limit: z.number().int().min(1).max(5000).default(1000),
        // cursor: آخر invoice.id من الصفحة السابقة. غيابه = أول صفحة.
        // الترتيب desc(id) ⇒ الصفحة التالية = id أصغر من المؤشّر.
        cursor: z.number().int().positive().optional(),
      }),
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
        conditions.push(
          sql`${invoices.invoiceDate} >= ${localDayStart(input.from)}`,
        );
      }
      if (input.to) {
        conditions.push(
          sql`${invoices.invoiceDate} < ${localNextDayStart(input.to)}`,
        );
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
      } else {
        // بلا فلترٍ صريح: تُستبعَد **المستبدلة وحدها** — مرآةً حرفيةً لعقد `sales.listSummary`
        // («المجاميع التاريخية تبقي الملغاة كما في العقد القائم؛ المستبدلة وحدها تُستبعَد لأنّ
        // البديلة تمثّل نفس العملية»). كان التقرير بلا أيّ استثناءٍ أساسيّ فيحتسب الأصل الميت
        // والبديلة معاً في «الإجمالي» و«غير المدفوع». من يريدها صراحةً يطلبها في `statuses`.
        conditions.push(ne(invoices.status, "SUPERSEDED"));
      }
      if (input.paymentMethods && input.paymentMethods.length > 0) {
        const withCredit = input.paymentMethods.includes("NONE");
        const methods = input.paymentMethods.filter((m) => m !== "NONE");
        const parts = [];
        if (methods.length > 0)
          parts.push(inArray(invoices.paymentMethod, methods));
        if (withCredit) parts.push(isNull(invoices.paymentMethod));
        conditions.push(parts.length === 1 ? parts[0] : or(...parts)!);
      }
      if (input.salespersonId) {
        conditions.push(eq(invoices.createdBy, input.salespersonId));
      }
      // فلتر الإجماليات = كامل النطاق (from/to/branch/source/status/طريقة الدفع/البائع) بلا مؤشّر الصفحة.
      const filterWhere =
        conditions.length > 0 ? and(...conditions) : undefined;
      // مؤشّر keyset للصفوف فقط: id < cursor (الترتيب desc(id) ⇒ الصفحة التالية أقدم).
      // keyset بدل offset: lt(id, cursor) يستفيد من فهرس المفتاح الأساسي مباشرةً.
      const rowConditions =
        input.cursor !== undefined
          ? [...conditions, lt(invoices.id, input.cursor)]
          : conditions;
      const where =
        rowConditions.length > 0 ? and(...rowConditions) : undefined;

      const rows = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          invoiceDate: invoices.invoiceDate,
          sourceType: invoices.sourceType,
          sourceId: invoices.sourceId,
          status: invoices.status,
          branchId: invoices.branchId,
          branchName: branches.name,
          shiftId: invoices.shiftId,
          posDeviceId: invoices.posDeviceId,
          salespersonName: invoices.salespersonNameSnapshot,
          paymentMethod: invoices.paymentMethod,
          priceTier: invoices.priceTier,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          returnedTotal: invoices.returnedTotal,
          costTotal: invoices.costTotal,
          customerName: customers.name,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .leftJoin(branches, eq(invoices.branchId, branches.id))
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
            unpaid: sql<string>`CAST(COALESCE(SUM(GREATEST(${invoices.total} - ${invoices.paidAmount} - ${invoices.returnedTotal}, 0)), 0) AS CHAR)`,
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
      const nextCursor =
        rows.length === input.limit && lastRow ? lastRow.id : null;

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
   *   - الأدمن يمرّر branchId اختيارياً (أو يحصل على كامل النظام إن لم يُحدَّد).
   *   - المدير وبقيّة الأدوار مقيَّدون دائماً بفرعهم (يتجاهل branchId المُمرَّر).
   * lowStockCount: متغيّرات تحت minStock (minStock > 0).
   * overdueAR: فواتير PENDING/PARTIALLY_PAID أعمارها > ٣٠ يوماً مع مجموع المتبقّي.
   */
  dashboardMetrics: protectedProcedure
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        includeTodaySales: z.boolean().optional(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع (قرار المالك ١٢/٨: عزل مدير الفرع): المالك/الأدمن وحدهما يعبُران الفروع (branchId
      // اختياريّ لهما)؛ مدير الفرع وغيره يُجبَرون على فرعهم المُسنَد — كان `|| manager` يُريه كلَّ الفروع.
      // G3 (تدقيق ١٤/٦/٢٦): استبدل `?? -1` برميٍ صريح (تجنّب الأصفار الصامتة).
      const elevated = ctx.user.role === "admin";
      let effectiveBranchId: number | null;
      if (elevated) {
        effectiveBranchId = input?.branchId ?? null;
      } else {
        if (ctx.user.branchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "لا فرع مُسنَد لهذا المستخدم",
          });
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      // gap-audit ٥/٧ (HIGH): مدينو الرصيد الافتتاحي (openingScope) للأدمن حصراً — مطابقةً لحصر
      // نطاق openingScope نفسه في arRemindersRouter.ts (لا انتماء فرعيّ لهؤلاء المدينين، ولا مسار
      // للمدير للتصرّف بهم أصلاً — راجع openingWriteBranch).
      //
      // تسريب dashboardMetrics (تدقيق ١٧/٧): الـendpoint على protectedProcedure ليبقى عدّاد
      // lowStock التشغيليّ متاحاً للجميع، لكنّ الأرقام المالية (overdueAR/salesPulse/عدّادا AR في
      // برنامج اليوم) تُحجب عن أدوار reports=NONE عبر نفس بوّابة reportViewerProcedure.
      return getDashboardMetrics({
        branchId: effectiveBranchId,
        includeOpeningBalance: ctx.user.role === "admin",
        includeFinancials: canViewReports(ctx.user),
        includeTodaySales: input?.includeTodaySales === true,
        userId: ctx.user.id,
      });
    }),

  // مطابقة الدفتر المزدوج والتحكم بوضعه في نهاية الراوتر لإبقاء جرد الصلاحيات مستقراً.
  // النقل تنظيمي فقط؛ كلا الإجرائين يظلان ضمن reportsRouter وخلف adminProcedure.

  /** إسقاط ملخّص للموبايل: نفس الفحص الشامل، بلا معرّفات أو أرصدة أو ملاحظات تفصيلية. */
  reconcileSummary: adminProcedure.query(async () =>
    toFinancialReconciliationSummary(await getFinancialReconciliationDetails()),
  ),

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
          // رُفع من ١٠٠ (تدقيق التقارير): الكتالوج قد يتجاوز عدد المنتجات المُباعة السقف القديم صامتاً.
          limit: z.number().int().positive().max(2000).default(20),
          by: z.enum(["revenue", "qty"]).default("revenue"),
        })
        .optional(),
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
        .optional(),
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
        .optional(),
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
      }),
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

  /** ميزان مراجعة رسمي من أسطر الدفتر المزدوج — لا اشتقاق لحقوق الملكية ولا موازنة مصطنعة. */
  /**
   * نافذة إتاحة تقارير الدفتر بعد القطع. القراءة تتبع بوابة التقارير الحمراء،
   * ولا تكشف موانع التفعيل أو اعتماد السياسة أو تفاصيل لقطة الافتتاح.
   */
  doubleEntryReportAvailability: reportsBranchScoped.query(async () =>
    getDoubleEntryReportAvailability(),
  ),

  trialBalance: reportsBranchScoped
    .input(
      z
        .object({
          from: strictYmdStr,
          to: strictYmdStr,
          branchId: z.number().int().positive().optional(),
        })
        .refine((value) => value.from <= value.to, {
          message: "تاريخ البداية يجب ألا يكون بعد تاريخ النهاية",
          path: ["to"],
        }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getTrialBalance({ from: input.from, to: input.to, branchId });
    }),

  /**
   * دفتر أستاذ حساب واحد من journalEntries/journalLines، برصيد افتتاحي وجارٍ وربط بالمستند المصدر.
   * reportViewerProcedure + scopedBranchId يفرضان بوابة التقارير وعزل الفرع (س٩).
   */
  generalLedger: reportsBranchScoped
    .input(
      z
        .object({
          accountId: z.number().int().positive(),
          from: strictYmdStr,
          to: strictYmdStr,
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(2000).default(200),
          offset: z.number().int().min(0).default(0),
        })
        .refine((value) => value.from <= value.to, {
          message: "تاريخ البداية يجب ألا يكون بعد تاريخ النهاية",
          path: ["to"],
        }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getGeneralLedger({
        accountId: input.accountId,
        from: input.from,
        to: input.to,
        branchId,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  /**
   * المركز المالي (لقطة) — يُغذّي ميزان المراجعة والميزانية العمومية المبسّطة.
   * يكشف الأرصدة/المخزون ⇒ manager فأعلى + عزل الفرع (النقد/المخزون حسب الفرع؛ الذمم على مستوى الشركة).
   */
  financialPosition: reportsBranchScoped
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          // «كما في تاريخ» — اختياري، افتراضياً اللقطة الحيّة الآن (بلا تغيير سلوكيّ إن غاب).
          asOf: ymdStr.optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getFinancialPosition({ branchId, asOf: input?.asOf });
    }),

  /**
   * تقييمُ المخزون كما كان في تاريخٍ معيّن (P1-#2، ٢٥/٨). يفضّل لقطةً محفوظة في
   * `inventoryValuationSnapshots` إن وُجدت للفترة المُقفَلة (source=SNAPSHOT)، وإلّا يعود
   * إلى الحالة الحيّة موسومةً بـLIVE (fallback للفترات ما قبل هجرة 0266). المستدعي يرى
   * المصدر صراحةً كي لا يُعرَض LIVE بوصفه تاريخياً.
   */
  inventoryValuationAt: reportsBranchScoped
    .input(z.object({ cutoffDate: ymdStr }))
    .query(async ({ input }) => {
      return withTx((tx) => readValuationAt(tx, input.cutoffDate));
    }),

  /** التدفّق النقدي (أساس نقدي مباشر) — صافي المقبوضات حسب اتّجاه/طريقة الدفع. manager + عزل الفرع. */
  cashFlow: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getCashFlow({ from: input.from, to: input.to, branchId });
    }),

  /** سجلّ المبيعات المفصّل — بنود الفواتير سطر-سطر + إجماليات + ترقيم. manager + عزل الفرع. */
  salesRegister: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        // بحث نصّي حرّ (رقم فاتورة/عميل/منتج) — اختياري، لا يمسّ العزل/الفلاتر القائمة.
        q: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(2000).default(200),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getSalesRegister({
        from: input.from,
        to: input.to,
        branchId,
        q: input.q,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  /** المبيعات حسب بُعد (عميل/فرع/طريقة دفع/كاشير/صنف) + إجماليات وربحية. manager + عزل الفرع. */
  salesByDimension: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        // بند 9 (٧/٧): بُعد «الصنف» — تجميع على مستوى بنود الفواتير بربحية بصيغة سجلّ المبيعات.
        dimension: z.enum([
          "customer",
          "branch",
          "paymentMethod",
          "cashier",
          "product",
        ]),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getSalesByDimension({
        from: input.from,
        to: input.to,
        branchId,
        dimension: input.dimension,
      });
    }),

  /** بند 11 (٧/٧): حزمة الإقفال الشهري — مبيعات/ربح/مشتريات/مصاريف/خزينة/لقطة ذمم لشهر واحد.
   *  نفس بوّابة التقارير (تكشف ربحاً وتكلفة) + عزل الفرع بـscopedBranchId. */
  monthlyClosePack: reportsBranchScoped
    .input(
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "صيغة الشهر YYYY-MM"),
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getMonthlyClosePack({ month: input.month, branchId });
    }),

  /** ش٥ (١١/٨): جاهزية الإقفال الشهري — البنود الحاجزة والتنبيهية التي تحكم زرّ الإقفال.
   *  قراءةٌ محضة. نفس بوّابة حزمة الإقفال وعزلها (تُعرَض بجانبها في الشاشة نفسها).
   *  تصنيف المالك: وردياتٌ مفتوحة وسنداتٌ معلَّقة تحجب؛ الباقي تنبيه. */
  monthCloseReadiness: reportsBranchScoped
    .input(
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "صيغة الشهر YYYY-MM"),
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getMonthCloseReadiness({ month: input.month, branchId });
    }),

  /** تقرير المشتريات — ملخّص حسب المورّد (أوامر مؤكَّدة/مستلَمة). manager + عزل الفرع. */
  purchasesReport: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getPurchasesReport({ from: input.from, to: input.to, branchId });
    }),

  /** سجلّ المشتريات — تفصيل بنود أوامر الشراء (عدا الملغاة) + ترقيم. manager + عزل الفرع. */
  purchaseRegister: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        supplierId: z.number().int().positive().optional(),
        // بحث نصّي حرّ (رقم أمر/مورّد/منتج) — اختياري.
        q: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(2000).default(200),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getPurchaseRegister({
        from: input.from,
        to: input.to,
        branchId,
        supplierId: input.supplierId,
        q: input.q,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  /** تفصيل أعمار الذمم — مستندٌ بمستند (AR فواتير / AP أوامر شراء). manager + عزل الفرع. */
  arApAgingDetail: reportsBranchScoped
    .input(
      z.object({
        side: z.enum(["AR", "AP"]),
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getArApAgingDetail({ side: input.side, branchId });
    }),

  /** تقييم المخزون بالتكلفة حسب الفئة (لقطة). manager + عزل الفرع. */
  inventoryValuation: reportsBranchScoped
    .input(
      z.object({ branchId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getInventoryValuation({ branchId });
    }),

  /** حالة المخزون / إعادة الطلب — رصيد كل صنف مقابل minStock. manager + عزل الفرع. */
  stockStatus: reportsBranchScoped
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        onlyAlerts: z.boolean().optional(),
        limit: z.number().int().positive().max(5000).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getStockStatus({
        branchId,
        onlyAlerts: input.onlyAlerts,
        limit: input.limit,
      });
    }),

  /** بطاقة الصنف (Kardex) — حركات متغيّر واحد زمنياً برصيد متحرّك. manager + عزل الفرع. */
  itemLedger: reportsBranchScoped
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
        from: ymdStr.optional(),
        to: ymdStr.optional(),
        limit: z.number().int().positive().max(500).default(100),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getItemLedger({
        variantId: input.variantId,
        branchId,
        from: input.from,
        to: input.to,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  /** تحليل ABC — تصنيف المنتجات حسب الإيراد (باريتو). manager + عزل الفرع. */
  abcAnalysis: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getAbcAnalysis({ from: input.from, to: input.to, branchId });
    }),

  /** ملخّص الخزينة — مقبوضات/مدفوعات حسب طريقة الدفع + فروقات الورديات. manager + عزل الفرع. */
  treasurySummary: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getTreasurySummary({ from: input.from, to: input.to, branchId });
    }),

  /** تقرير المصروفات — مصنّفةً حسب الفئة + أكبر جهات الصرف. manager + عزل الفرع. */
  expensesReport: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        // حدّ جهات الصرف المُعادة — افتراضي ٢٠ (كالسابق)، حتى ٢٠٠.
        payeeLimit: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getExpensesReport({
        from: input.from,
        to: input.to,
        branchId,
        payeeLimit: input.payeeLimit,
      });
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

  /**
   * مطابقة إقفال اليوم للنقد — لكل وردية في يومٍ (UTC) وفرع: المتوقَّع (من الدفتر، مطابقٌ لصيغة
   * computeExpectedCash) مقابل المعدود (نقد الإغلاق) مقابل الفرق (drift = variance الوردية). يكشف
   * قيمة/تحصيل النقد ⇒ نفس بوّابة التقارير (reportViewerProcedure) + عزل الفرع بـscopedBranchId.
   */
  dayCloseReconciliation: reportsBranchScoped
    .input(
      z.object({
        date: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getDayCloseReconciliation({
        date: input.date,
        branchId,
        actor: {
          userId: ctx.user.id,
          role: ctx.user.role,
          branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
        },
      });
    }),

  /** تقرير الإنتاج — مستندات الإنتاج المؤكَّدة + تفصيل الكلفة. manager + عزل الفرع. */
  productionReport: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getProductionReport({ from: input.from, to: input.to, branchId });
    }),

  /**
   * Native/mobile production report — bounded rows plus authoritative totals.
   * The legacy productionReport remains unchanged for the desktop client.
   */
  productionReportPage: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
        cursor: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return getProductionReportPage({
        from: input.from,
        to: input.to,
        branchId,
        limit: input.limit,
        offset: input.offset,
        cursor: input.cursor,
      });
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
          .regex(
            /^\d+(\.\d{1,2})?$/,
            "قيمة مالية غير صالحة (رقم موجب بمنزلتين كحدّ أقصى)",
          )
          .optional(),
        limit: z.number().int().min(1).max(2000).default(500),
        offset: z.number().int().min(0).default(0),
      }),
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
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
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
    .input(
      z
        .object({
          from: ymdStr.optional(),
          to: ymdStr.optional(),
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getCourierPerformance({
        from: input?.from,
        to: input?.to,
        branchId,
      });
    }),

  /** أعمار الإرساليات المفتوحة (١٠/٨) — نظير أعمار الذمم لعُهد المناديب: دلاء زمنية من تاريخ
   *  الإرسال بقيمة متبقّي COD لكل جهة. نفس بوّابة التقارير + عزل الفرع. */
  consignmentAging: reportsBranchScoped
    .input(
      z.object({ branchId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input?.branchId);
      return getConsignmentAging({ branchId });
    }),

  // ─────────────────────── تقارير مركز واتساب (S6، T6.1) ───────────────────────
  // الأربعة خلف reportViewerProcedure + عزل الفرع (بيانات أداء موظفين/كلفة حملات — خط §٦ الأحمر).
  // لا واجهة تستهلكها بعد (T6.2) — check:orphans سيُبلّغ عن يتمٍ متوقَّع حتى ذلك الحين.

  /** زمن أول رد P50/P90 + زمن الحل P50/P90 + التزام SLA + الحل من أول تواصل + معدّل إعادة الفتح،
   *  إجمالاً وتجميعاً حسب نوع المهمة (taskKind). الفترة = تاريخ إنشاء المهمة (createdAt). */
  whatsappTaskResponse: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return taskResponseReport({ from: input.from, to: input.to, branchId });
    }),

  /** أحجام العمل لكل موظف مُسنَد — **حِمل عمل لا مراقبة أداء** (لا عدّ رسائل/زمن اتصال، فقط
   *  إسناد/إنجاز/CSAT). الفترة = تاريخ إنشاء المهمة (createdAt). */
  whatsappAgentVolume: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return agentVolumeReport({ from: input.from, to: input.to, branchId });
    }),

  /** توزيع درجات CSAT (١-٥) + المتوسط + معدّل الاستجابة. الفترة = تاريخ طلب التقييم
   *  (csatRequestedAt) — عمداً لا createdAt، راجع تعليق whatsappReports.ts أعلى الملف. */
  whatsappCsat: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return csatReport({ from: input.from, to: input.to, branchId });
    }),

  /** قمع أداء الحملات التسويقية (أُرسل→سُلّم→قُرئ) لكل حملة ضمن الفترة + الكلفة التقديرية مقابل
   *  الفعلية. الفترة = تاريخ إنشاء الحملة (waBroadcasts.createdAt). */
  whatsappCampaignPerformance: reportsBranchScoped
    .input(
      z.object({
        from: ymdStr,
        to: ymdStr,
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = scopedBranchId(ctx, input.branchId);
      return campaignPerformanceReport({
        from: input.from,
        to: input.to,
        branchId,
      });
    }),

  /** مطابقة شهر/فرع + حالة بوابة ACTIVE الحيّة. التحميل الكسول يبقي هذا الراوتر الضخم مستقراً. */
  reconcile: adminProcedure
    .input(
      z
        .object({
          month: z
            .string()
            .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "صيغة الشهر YYYY-MM")
            .optional(),
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const [{ reconcileDoubleEntry }, { canActivate }] = await Promise.all([
        import("../services/reconcileService"),
        import("../services/accounting/activationGate"),
      ]);
      const month = input?.month ?? currentBaghdadMonth();
      const [details, doubleEntry, activation] = await Promise.all([
        getFinancialReconciliationDetails(),
        reconcileDoubleEntry({ month, branchId: input?.branchId ?? null }),
        canActivate({ requireStatutoryCompliance: true }),
      ]);
      return { ...details, doubleEntry, activation };
    }),

  /** الانتقالات كلها مدققة؛ ACTIVE حصراً عبر البوابة، وOFF طوارئ بسببٍ إلزامي بلا حذف اليومية. */
  prepareDoubleEntryShadow: settingsAdminProcedure
    .input(
      z.object({
        allocations: z
          .array(
            z.object({
              role: z.enum([
                "CAPITAL",
                "RETAINED_EARNINGS",
                "OWNER_CURRENT",
                "LOAN_PAYABLE",
              ]),
              branchId: z.number().int().positive().nullable(),
              debit: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
              credit: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
            }),
          )
          .max(400)
          .default([]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { prepareDoubleEntryShadowOpening } = await import(
        "../services/accounting/doubleEntrySettings"
      );
      return prepareDoubleEntryShadowOpening({
        actorId: ctx.user.id,
        allocations: input.allocations,
      });
    }),

  setDoubleEntryMode: settingsAdminProcedure
    .input(
      z.discriminatedUnion("target", [
        z.object({
          target: z.literal("SHADOW"),
          preparationToken: z.string().min(40).max(100_000),
          expectedOpeningHash: z.string().regex(/^[a-f0-9]{64}$/),
          allocations: z
            .array(
              z.object({
                role: z.enum([
                  "CAPITAL",
                  "RETAINED_EARNINGS",
                  "OWNER_CURRENT",
                  "LOAN_PAYABLE",
                ]),
                branchId: z.number().int().positive().nullable(),
                debit: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
                credit: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
              }),
            )
            .max(400),
        }),
        z.object({ target: z.literal("ACTIVE") }),
        z.object({
          target: z.literal("OFF"),
          reason: z.string().trim().min(10, "سبب الإيقاف مطلوب (10 أحرف على الأقل)").max(500),
        }),
      ]),
    )
    .mutation(async ({ input, ctx }) => {
      const [{ withTx }, { activateDoubleEntry, startDoubleEntryShadow, stopDoubleEntry }] =
        await Promise.all([
          import("../services/tx"),
          import("../services/accounting/doubleEntrySettings"),
        ]);
      return withTx(async (tx) => {
        if (input.target === "SHADOW") {
          return startDoubleEntryShadow(tx, {
            actorId: ctx.user.id,
            preparationToken: input.preparationToken,
            expectedOpeningHash: input.expectedOpeningHash,
            allocations: input.allocations,
            auditContext: ctx,
          });
        }
        if (input.target === "ACTIVE") {
          return activateDoubleEntry(tx, {
            actorId: ctx.user.id,
            auditContext: ctx,
          });
        }
        return stopDoubleEntry(tx, {
          actorId: ctx.user.id,
          reason: input.reason,
          auditContext: ctx,
        });
      });
    }),

  /** مرجع مصادقة محاسب بشري على سياسات الخرائط الملتبسة؛ حوكمة داخلية لا ادعاء معياري. */
  setDoubleEntryPolicyApproval: settingsAdminProcedure
    .input(
      z.discriminatedUnion("action", [
        z.object({
          action: z.literal("APPROVE"),
          reference: z.string().trim().min(10).max(255),
          accountantName: z.string().trim().min(3).max(150),
        }),
        z.object({
          action: z.literal("CLEAR"),
          reason: z.string().trim().min(10).max(500),
        }),
      ]),
    )
    .mutation(async ({ input, ctx }) => {
      const [txModule, settingsModule] = await Promise.all([
        import("../services/tx"),
        import("../services/accounting/doubleEntrySettings"),
      ]);
      return txModule.withTx(async (tx) =>
        input.action === "APPROVE"
          ? settingsModule.approveDoubleEntryPolicy(tx, {
              actorId: ctx.user.id,
              reference: input.reference,
              accountantName: input.accountantName,
              auditContext: ctx,
            })
          : settingsModule.clearDoubleEntryPolicyApproval(tx, {
              actorId: ctx.user.id,
              reason: input.reason,
              auditContext: ctx,
            }),
      );
    }),
});
