import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { SALES_CONTROL_STATUSES } from "@shared/salesControl";
import { appErrorMessage } from "@shared/errors";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import {
  approveSalesControlRequest,
  claimSalesCorrectionPayment,
  listSalesControlRequests,
  releaseSalesCorrectionPaymentClaim,
  rejectSalesControlRequest,
  requestSalesControl,
  withdrawSalesControlRequest,
} from "../services/sale/controlRequests";
import {
  router,
  salesCorrectionComparisonProcedure,
  salesCorrectionProcedure,
  salesManagerProcedure,
  salesReadProcedure,
} from "../trpc";
import { recordGovernedReturnExecution } from "../services/sale/controlAudit";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { customers, salesControlRequests } from "../../drizzle/schema";
import { getDb } from "../db";
import { listByUnitIds } from "../services/catalogService";

const paymentMethod = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)").nullable();
const requestIdentity = z.object({
  requestKey: z.string().trim().min(1).max(120),
  invoiceId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
});
const correctionLine = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/).refine((value) => Number(value) > 0 && Number(value) <= 1_000_000),
  unitPriceOverride: nonNegMoneyString.optional(),
  discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  discountAmount: nonNegMoneyString.optional(),
  promotionId: z.number().int().positive().optional(),
  isGift: z.boolean().optional(),
});
const correctionPayload = z.object({
  customerId: z.number().int().positive().nullish(),
  contactName: z.string().trim().max(255).nullish(),
  contactPhone: z.string().trim().max(32).nullish(),
  priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
  lines: z.array(correctionLine).min(1),
  invoiceDiscount: nonNegMoneyString.nullish(),
  deliveryFee: nonNegMoneyString.nullish(),
  deliveryFree: z.boolean().optional(),
  deliveryWaivedAmount: nonNegMoneyString.nullish(),
  taxRatePercent: z.string().regex(/^\d+(\.\d{1,2})?$/).nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(5000).nullish(),
  additionalPayment: z.object({
    amount: positiveMoneyString,
    method: paymentMethod,
  }).nullish(),
  overpayHandling: z.enum(["CREDIT", "CASH_REFUND"]).optional(),
});

function actor(ctx: {
  user: { id: number; branchId?: number | null; role: string };
  scopedOwnerId?: number | null;
  invoiceCorrectionScope?: "sales" | "reception";
}) {
  return {
    userId: ctx.user.id,
    branchId: Number(ctx.user.branchId ?? 0),
    role: ctx.user.role,
    scopedOwnerId: ctx.scopedOwnerId,
    invoiceScope: ctx.invoiceCorrectionScope,
  };
}

export const salesControlRouter = router({
  /** أسماء/وحدات سطور مقارنة التصحيح للمراجع، بلا اشتراط products:READ أو كشف تكلفة. */
  correctionCatalog: salesCorrectionComparisonProcedure
    .input(z.object({ requestId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], targetCustomerName: null };
      const request = (
        await db
          .select({
            branchId: salesControlRequests.branchId,
            requestedBy: salesControlRequests.requestedBy,
            requestType: salesControlRequests.requestType,
            status: salesControlRequests.status,
            payload: salesControlRequests.payload,
          })
          .from(salesControlRequests)
          .where(eq(salesControlRequests.id, input.requestId))
          .limit(1)
      )[0];
      if (!request) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر فتح مقارنة التعديل",
            why: "طلب التعديل المحدد غير موجود أو أزيل",
            doThis: "حدّث قائمة الاعتمادات واختر طلباً ظاهراً فيها",
          }),
        });
      }
      if (ctx.user.role !== "admin" && Number(request.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر فتح مقارنة التعديل",
            why: "طلب التعديل لا يخص الفرع المسند لك",
            doThis: "اختر طلباً من فرعك أو اطلب من مدير الفرع المعني مراجعته",
          }),
        });
      }
      if (ctx.scopedOwnerId != null && Number(request.requestedBy) !== Number(ctx.scopedOwnerId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر فتح مقارنة التعديل",
            why: "الطلب أنشأه موظف آخر ولا تسمح صلاحيتك بعرض تفاصيله",
            doThis: "افتح طلباً أنشأته أنت أو اطلب من المدير مراجعته",
          }),
        });
      }
      if (request.status !== "PENDING" || !["SALES_REISSUE", "SALES_EXCHANGE"].includes(request.requestType)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر فتح مقارنة التعديل",
            why: "الطلب ليس تعديل فاتورة معلقاً أو سبق اتخاذ القرار فيه",
            doThis: "حدّث القائمة وافتح طلب تعديل ما زال بانتظار الاعتماد",
          }),
        });
      }
      const payload = request.payload as z.infer<typeof correctionPayload>;
      const unitIds = Array.from(new Set((payload.lines ?? []).map((line) => Number(line.productUnitId))));
      const rows = await listByUnitIds(
        unitIds,
        Number(request.branchId),
        payload.priceTier ?? "RETAIL",
      );
      if (rows.length !== unitIds.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تجهيز مقارنة التعديل",
            why: "صنف أو وحدة ضمن الطلب لم يعد متاحاً بعد تقديمه",
            doThis: "ارفض الطلب واطلب من الموظف إنشاء تعديل جديد بالأصناف المتاحة",
          }),
        });
      }
      const targetCustomer = payload.customerId == null ? null : (
        await db.select({ name: customers.name }).from(customers)
          .where(eq(customers.id, Number(payload.customerId))).limit(1)
      )[0] ?? null;
      return {
        targetCustomerName: targetCustomer?.name ?? null,
        rows: rows.map((row) => ({
          productUnitId: row.productUnitId,
          productName: row.productName,
          variantName: row.variantName,
          unitName: row.unitName,
          price: row.price,
        })),
      };
    }),

  requestDueDateChange: salesManagerProcedure
    .input(requestIdentity.extend({ dueDate }))
    .mutation(({ input, ctx }) => requestSalesControl({
      requestKey: input.requestKey,
      invoiceId: input.invoiceId,
      requestType: "SALES_DUE_DATE_CHANGE",
      reason: input.reason,
      payload: { dueDate: input.dueDate },
    }, actor(ctx))),

  requestExchange: salesCorrectionProcedure
    .input(requestIdentity.extend({ payload: correctionPayload }))
    .mutation(({ input, ctx }) => requestSalesControl({
      ...input,
      requestType: "SALES_EXCHANGE",
    }, actor(ctx))),

  list: salesReadProcedure
    .input(z.object({
      status: z.enum(SALES_CONTROL_STATUSES).optional(),
      mine: z.boolean().optional(),
    }).optional())
    .query(({ input, ctx }) => {
      const canReview = moduleAccessAllowed(
        ctx.user.role as RoleKey,
        (ctx.user.permissionsOverride ?? null) as PermissionMap | null,
        "sales",
        "FULL",
        ["manager"],
      );
      return listSalesControlRequests(actor(ctx), {
        status: input?.status,
        mine: canReview ? input?.mine : true,
      });
    }),

  /** يحجز طلب فرق البطاقة لمراجع واحد قبل توجيهه إلى جهاز الدفع؛ لا أثر مالي هنا. */
  claimCorrectionPayment: salesManagerProcedure
    .input(z.object({ requestId: z.number().int().positive() }))
    .mutation(({ input, ctx }) => claimSalesCorrectionPayment(input.requestId, actor(ctx))),

  /** تحرير الحجز مسموح قبل وجود دليل قبض مؤكد فقط. */
  releaseCorrectionPaymentClaim: salesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      confirmation: z.literal("NO_EXTERNAL_PAYMENT_EXECUTED"),
    }))
    .mutation(({ input, ctx }) => releaseSalesCorrectionPaymentClaim(
      input.requestId,
      actor(ctx),
      input.confirmation,
    )),

  approve: salesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reviewNote: z.string().trim().max(500).nullish(),
      /**
       * توجيهُ خروج النقد لحظة الاعتماد. `shiftId`/`clearShift` لمرتجع البيع وحده (الدرج
       * المختار وقت **الطلب** قد يكون أُقفل قبل الاعتماد ⇒ التنفيذ يفشل بلا مخرج؛ المُعتمِد
       * يختار درجاً مفتوحاً الآن). `reference` يخدم المرتجع **وإلغاء البيع ببطاقة** معاً
       * (مراجعة Codex على PR #988): مرجع جهاز الدفع قرارُ **لحظة الاعتماد** لا لحظة الطلب —
       * وإلّا اضطُرّ الطالب لتنفيذ الاسترداد الفعليّ على الجهاز قبل أن يبتّ أحدٌ في طلبه أصلاً.
       * ⛔ لا مبلغ ولا طريقة هنا: الاعتماد موافقةٌ على ما عُرِض، لا فرصةٌ لتغييره.
       */
      cashRouting: z.object({
        shiftId: z.number().int().positive().optional(),
        /** امسح الدرج المُجمَّد ليُعاد اشتقاق المصدر (درجٌ مفتوح وإلّا خزينةُ الفرع للإداريّ). */
        clearShift: z.boolean().optional(),
        // ⛔ `null` صراحةً (لا فقط الغياب) مقبولةٌ عمداً: مسحُ المُعتمِد مرجعاً معروضاً — لا
        // يطابق قسيمة الجهاز — يجب أن يصل الخدمة override إلى null فتُرفض CARD حتماً، لا أن
        // يُطوى بصمتٍ إلى «لم يُرسَل شيء» فيبقى مرجع الطلب الأصليّ نافذاً (Codex على PR #997).
        reference: z.string().trim().min(1).max(100).nullable().optional(),
        deviceId: z.string().trim().min(1).max(64).nullable().optional(),
      }).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await approveSalesControlRequest(
        input.requestId,
        actor(ctx),
        input.reviewNote,
        input.cashRouting ?? null,
      );
      /**
       * اعتمادُ مرتجعٍ محكوم **ينفّذ الأثر** — فيجب أن يحمل فعلَ التنفيذ نفسه الذي يقرأه
       * رقيبُ الشذوذ D3-ب. التدقيقُ التلقائيّ يكتب `rpc.salesControl.approve` لكلّ الأنواع
       * معاً (إلغاء/استبدال/استحقاق) فلا يُميّز المرتجع؛ وتركيزُ المرتجعات على شخصٍ بعينه
       * لا يُقاس بفعلٍ يخلط أربع عملياتٍ مختلفة.
       *
       * الكتابةُ في `sale/controlAudit.ts` **مشتركةٌ** مع صندوق القرارات (`decisions.decide`):
       * كان هذا الراوتر وحده يكتبها فيتخطّاها اعتمادُ الصندوق (Codex على #1004).
       */
      await recordGovernedReturnExecution(ctx, { requestId: input.requestId, result, cashRouting: input.cashRouting ?? null });
      return result;
    }),

  reject: salesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(({ input, ctx }) => rejectSalesControlRequest(
      input.requestId,
      input.reason,
      actor(ctx),
    )),

  /**
   * سحبُ الطالب لطلبه — المخرج من الطريق المسدود حين لا يوجد مراجعٌ مستقلّ.
   * ⚠️ البوّابة `salesCashierProcedure` لا `salesManagerProcedure`: مَن استطاع **إنشاء** الطلب
   * يجب أن يستطيع **سحبه**، وإلّا بقي كاشيرُ الاستبدال حبيسَ طلبٍ لا يملك إغلاقه.
   * والخدمة تحصر السحب بصاحب الطلب حصراً، فالبوّابة الأوسع لا توسّع الأثر.
   */
  withdraw: salesCorrectionProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(({ input, ctx }) => withdrawSalesControlRequest(
      input.requestId,
      input.reason,
      actor(ctx),
    )),
});
