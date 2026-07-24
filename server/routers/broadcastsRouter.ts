/**
 * البث التسويقي عبر واتساب (S5، T5.1) — راوتر جديد فوق `server/services/whatsapp/{segmentService,
 * broadcastService}.ts`. يعيد استعمال مفتاح صلاحيات `campaigns` القائم (campaignsManagerProcedure/
 * campaignsReadProcedure من `server/trpc.ts`) — لا مفتاح جديد. لا واجهة تستهلكه بعد (T5.3)؛
 * `check:orphans` سيُبلّغ عن يتمٍ متوقَّع حتى ذلك الحين.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { moneyString, nonNegMoneyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import type { Actor } from "../services/tx";
import {
  approveBroadcast,
  cancelBroadcast,
  createBroadcast,
  getBroadcast,
  launchBroadcast,
  listBroadcasts,
  pauseBroadcast,
  previewAudience,
  type SegmentCriteria,
} from "../services/whatsapp";
import { campaignsManagerProcedure, campaignsReadProcedure, router } from "../trpc";

type UserCtx = { user: { id: number; role: string; branchId?: number | null } };

/** نمط `ownBranch` في crmRouter (نفس عالم الحملات): بثّ عامّ (branchId=null) محصور بالأدمن فقط. */
function ownBranch(ctx: UserCtx, requested?: number | null): number | null {
  if (ctx.user.role === "admin") return requested ?? null;
  const branchId = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
  if (branchId == null) throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد فرع مُسنَد للمستخدم" });
  if (requested != null && Number(requested) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إدارة بثٍّ لفرع آخر" });
  }
  return branchId;
}

/**
 * عزل فرع الشريحة (`segment.branchId` — يُستعمَل لحساب جمهور RFM من `invoices`، مستقلٌّ تماماً
 * عن `branchId` الإداري للبثّ أعلاه): كان غير مُصفّى بموازاة فرع المستخدم ⇒ مديرُ فرعٍ ١ يستطيع
 * تمرير `segment.branchId=2` فيُحسَب جمهوره من فواتير فرع ٢ رغم كونه بلا صلاحية إدارته (يمرّ من
 * `ownBranch` أعلاه لأن ذاك الفحص يخصّ حقل `branchId` الإداري المنفصل لا `segment.branchId`).
 * الإصلاح: للأدمن — يُحترَم ما أرسله العميل (بما فيه `null` = كل الفروع)؛ لغير الأدمن — يُستبدَل
 * **دائماً** بفرعه المُحلَّل عبر `ownBranch(ctx)` (بلا تمرير `requested` فلا يَرمي على تعارض — مجرّد
 * استبدال صامت، خلافاً لـ`ownBranch(ctx, requested)` أعلاه التي ترفض صراحةً طلب فرعٍ آخر لحقل
 * `branchId` الإداري). يُستدعى في `preview`/`create` قبل بناء/تخزين المعايير.
 */
function resolveSegmentBranch(ctx: UserCtx, requestedSegmentBranchId?: number | null): number | null {
  if (ctx.user.role === "admin") return requestedSegmentBranchId ?? null;
  return ownBranch(ctx);
}

/** بصمة actor للخدمة — `branchId: 0` بلا فرع مُسنَد (سنتينل آمن: لا فرع حقيقي بمعرّف 0؛ **عمداً
 *  بلا** fallback `?? 1` الموثَّق كمصدر ثغرات IDOR سابقة — راجع CLAUDE.md §٦). admin يتجاوز فحص
 *  الفرع داخل الخدمة أصلاً فلا يتأثّر بالسنتينل. */
function actorOf(ctx: UserCtx): Actor {
  return { userId: ctx.user.id, branchId: ctx.user.branchId == null ? 0 : Number(ctx.user.branchId), role: ctx.user.role };
}

function parseOptionalDateTime(raw: string | null | undefined, fieldLabel: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${fieldLabel} غير صالح` });
  }
  return d;
}

const rfmPresetEnum = z.enum(["VIP", "AT_RISK", "DORMANT", "NEW"]);
const customerTypeEnum = z.enum(["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]);
const priceTierEnum = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);

const rfmCriteriaSchema = z
  .object({
    recencyDays: z.number().int().positive().max(3650).optional(),
    minInvoices: z.number().int().positive().max(100000).optional(),
    // غير سالبة (nonNegMoneyString لا moneyString الموقَّع): عتبة إنفاق سالبة بلا معنى وتُفرِغ
    // الفلتر صامتاً (كل الفواتير ≥ سالب دائماً).
    minSpend: nonNegMoneyString.optional(),
    preset: rfmPresetEnum.optional(),
  })
  .strict();

const segmentCriteriaSchema = z
  .object({
    customerTypes: z.array(customerTypeEnum).max(10).optional(),
    priceTiers: z.array(priceTierEnum).max(5).optional(),
    branchId: z.number().int().positive().nullish(),
    balanceMin: moneyString.optional(),
    balanceMax: moneyString.optional(),
    rfm: rfmCriteriaSchema.optional(),
    requireOptIn: z.boolean().optional(),
  })
  .strict();

function toCriteria(input: z.infer<typeof segmentCriteriaSchema>): SegmentCriteria {
  return input as SegmentCriteria;
}

export const broadcastsRouter = router({
  /** معاينة العدد والكلفة التقديرية قبل الإنشاء — بلا حفظ. عزل فرع الشريحة عبر resolveSegmentBranch
   *  (راجع تعليقها أعلاه) — لغير الأدمن يُستبدَل segment.branchId بفرعه دائماً. */
  preview: campaignsManagerProcedure
    .input(z.object({ segment: segmentCriteriaSchema }))
    .query(async ({ input, ctx }) => {
      const branchId = resolveSegmentBranch(ctx, input.segment.branchId);
      return previewAudience(toCriteria({ ...input.segment, branchId }));
    }),

  create: campaignsManagerProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(160),
        branchId: z.number().int().positive().nullish(),
        crmCampaignId: z.number().int().positive().nullish(),
        templateId: z.number().int().positive(),
        varsMapJson: z.record(z.string(), z.string().max(200)).nullish(),
        segment: segmentCriteriaSchema,
        throttlePerMinute: z.number().int().min(1).max(120).optional(),
        scheduledAt: z.string().trim().min(10).max(40).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = ownBranch(ctx, input.branchId);
      // عزل فرع الشريحة (segment.branchId) — مستقلّ عن branchId الإداري أعلاه؛ راجع تعليق
      // resolveSegmentBranch. يُطبَّق قبل التخزين في segmentJson فلا يُحفَظ فرعٌ آخر لغير الأدمن.
      const segmentBranchId = resolveSegmentBranch(ctx, input.segment.branchId);
      const scheduledAt = parseOptionalDateTime(input.scheduledAt, "تاريخ الجدولة");
      const res = await createBroadcast(
        {
          name: input.name,
          branchId,
          crmCampaignId: input.crmCampaignId ?? null,
          templateId: input.templateId,
          varsMapJson: input.varsMapJson ?? null,
          segment: toCriteria({ ...input.segment, branchId: segmentBranchId }),
          throttlePerMinute: input.throttlePerMinute,
          scheduledAt,
        },
        actorOf(ctx),
      );
      await logAudit(ctx, {
        action: "broadcast.create",
        entityType: "waBroadcast",
        entityId: res.broadcastId,
        newValue: { name: input.name, branchId, templateId: input.templateId, audienceCount: res.audienceCount, costEstimate: res.costEstimate },
      });
      return res;
    }),

  launch: campaignsManagerProcedure
    .input(z.object({ broadcastId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await launchBroadcast(input.broadcastId, actorOf(ctx));
      await logAudit(ctx, {
        action: "broadcast.launch",
        entityType: "waBroadcast",
        entityId: input.broadcastId,
        newValue: res,
      });
      return res;
    }),

  approve: campaignsManagerProcedure
    .input(z.object({ broadcastId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await approveBroadcast(input.broadcastId, actorOf(ctx));
      await logAudit(ctx, {
        action: "broadcast.approve",
        entityType: "waBroadcast",
        entityId: input.broadcastId,
        newValue: res,
      });
      return res;
    }),

  pause: campaignsManagerProcedure
    .input(z.object({ broadcastId: z.number().int().positive(), reason: z.string().trim().min(1).max(200) }))
    .mutation(async ({ input, ctx }) => {
      const res = await pauseBroadcast(input.broadcastId, input.reason, actorOf(ctx));
      await logAudit(ctx, {
        action: "broadcast.pause",
        entityType: "waBroadcast",
        entityId: input.broadcastId,
        newValue: { reason: input.reason },
      });
      return res;
    }),

  cancel: campaignsManagerProcedure
    .input(z.object({ broadcastId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelBroadcast(input.broadcastId, actorOf(ctx));
      await logAudit(ctx, { action: "broadcast.cancel", entityType: "waBroadcast", entityId: input.broadcastId });
      return res;
    }),

  list: campaignsReadProcedure.query(async ({ ctx }) => {
    return listBroadcasts({ branchId: ctx.scopedBranchId ?? null });
  }),

  get: campaignsReadProcedure
    .input(z.object({ broadcastId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const res = await getBroadcast(input.broadcastId, { branchId: ctx.scopedBranchId ?? null });
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "البثّ غير موجود" });
      return res;
    }),
});
