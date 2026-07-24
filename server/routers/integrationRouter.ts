import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { channelIntegrations, waHubSettings } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { adminProcedure, managerProcedure, router } from "../trpc";
import {
  deleteIntegration,
  listIntegrations,
  setIntegrationStatus,
  upsertIntegration,
  verifyIntegration,
} from "../services/integrationService";
import { isCryptoReady } from "../services/cryptoService";
import { logAudit } from "../services/auditService";
import {
  getActiveWaTemplateIntegration,
  listTemplates,
  syncTemplatesFromGraph,
} from "../services/whatsapp";
import { withTx } from "../services/tx";

const channelEnum = z.enum(["WHATSAPP", "INSTAGRAM", "STORE"]);
const templateCategoryEnum = z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]);
const templateStatusEnum = z.enum(["PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]);

/** حُقول waHubSettings القابلة للتحديث — كلّها اختيارية (undefined = لا تُغيَّر، نمط upsertIntegration). */
const waHubSettingsUpdateSchema = z.object({
  triageMode: z.enum(["AUTO_ALL", "KEYWORD_ONLY", "MANUAL"]).optional(),
  autoTaskEnabled: z.boolean().optional(),
  businessHoursJson: z.record(z.string(), z.unknown()).nullable().optional(),
  afterHoursReply: z.string().max(2000).nullable().optional(),
  welcomeReply: z.string().max(2000).nullable().optional(),
  throttlePerMinute: z.number().int().min(1).max(1000).optional(),
  optOutKeywords: z.string().max(2000).nullable().optional(),
  campaignApprovalThreshold: z.number().int().min(0).optional(),
  autoReplyAfterHours: z.boolean().optional(),
  autoReplyWelcome: z.boolean().optional(),
  flowArReminder: z.boolean().optional(),
  flowOrderReady: z.boolean().optional(),
  flowPurchaseThanks: z.boolean().optional(),
  flowConsignmentWithdraw: z.boolean().optional(),
  csatOnResolve: z.boolean().optional(),
  killSwitch: z.boolean().optional(),
});

/** عرض افتراضي (نمط openingModeService.DEFAULTS) — القراءة get-or-default بلا كتابة؛ يطابق
 *  DEFAULT الأعمدة في drizzle/schema.ts حرفياً حتى لا ينحرف عرض «قبل أوّل تحديث» عن الحقيقة. */
const WA_HUB_DEFAULTS = {
  id: 1,
  triageMode: "AUTO_ALL" as const,
  autoTaskEnabled: true,
  businessHoursJson: null as unknown,
  afterHoursReply: null as string | null,
  welcomeReply: null as string | null,
  throttlePerMinute: 10,
  optOutKeywords: null as string | null,
  campaignApprovalThreshold: 500,
  autoReplyAfterHours: false,
  autoReplyWelcome: false,
  flowArReminder: false,
  flowOrderReady: false,
  flowPurchaseThanks: false,
  flowConsignmentWithdraw: false,
  csatOnResolve: false,
  killSwitch: false,
  updatedBy: null as number | null,
  createdAt: null as Date | null,
  updatedAt: null as Date | null,
};

/** ensure-row كسول (نمط openingModeService.updateOpeningMode): يضمن وجود صفّ singleton id=1
 *  (احتياط رغم أن seed يبذره) قبل تحديثه — بلا أثر إن كان موجوداً (onDuplicateKeyUpdate بلا تغيير
 *  فعلي على id نفسه). داخل withTx واحدة مع التحديث والقراءة النهائية لضمان الذرّية. */
async function ensureWaHubSettingsRow(tx: Tx) {
  await tx.insert(waHubSettings).values({ id: 1 }).onDuplicateKeyUpdate({ set: { id: 1 } });
}

/**
 * إدارة تَكاملات القَنوات الخارِجية — شَريحة #6.
 *
 * كلها adminProcedure فَقط — لا الكاشير ولا المُدير يَرى/يُعَدّل tokens.
 * كل mutation تُكتَب في auditLogs لِتَتبّع مَن غَيَّر ماذا.
 */

export const integrationRouter = router({
  /** فَحص جاهزية المُفتاح الرَئيسي — لِعَرض warning في الشاشة لو غَير مَضبوط. */
  cryptoReady: adminProcedure.query(() => ({
    ready: isCryptoReady(),
  })),

  /** قائمة كل التَكاملات (admin يَرى كل الفُروع). */
  list: adminProcedure.query(() => listIntegrations()),

  /** إنشاء/تَحديث تَكامل. secrets undefined = لا تُغَيّر؛ null = اِمسح؛ string = اِكتب. */
  upsert: adminProcedure
    .input(z.object({
      branchId: z.number().int().positive(),
      channel: channelEnum,
      displayName: z.string().max(120).nullable().optional(),
      phoneNumberId: z.string().max(80).nullable().optional(),
      verifyToken: z.string().max(500).nullable().optional(),
      appSecret: z.string().max(500).nullable().optional(),
      accessToken: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await upsertIntegration({
        ...input,
        updatedBy: Number(ctx.user.id),
      });
      // ⚠️ لا نُسَجّل قِيَم الـsecrets في الـaudit (سَتُكشَف لِمَن يَرى auditLogs).
      // نُسَجّل فَقط أَيّ الحُقول تَغيَّرت.
      await logAudit(ctx, {
        action: result.isNew ? "integration.create" : "integration.update",
        entityType: "channelIntegration",
        entityId: result.id,
        newValue: {
          branchId: input.branchId,
          channel: input.channel,
          changed: {
            displayName: input.displayName !== undefined,
            phoneNumberId: input.phoneNumberId !== undefined,
            verifyToken: input.verifyToken !== undefined,
            appSecret: input.appSecret !== undefined,
            accessToken: input.accessToken !== undefined,
          },
        },
      });
      return result;
    }),

  /** اِختبار اتصال (يَضرب Meta/Store API فِعلياً) + حِفظ النَتيجة. */
  verify: adminProcedure
    .input(z.object({ integrationId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const result = await verifyIntegration(input.integrationId);
      await logAudit(ctx, {
        action: "integration.verify",
        entityType: "channelIntegration",
        entityId: input.integrationId,
        newValue: { ok: result.ok, message: result.message },
      });
      return result;
    }),

  /** تَعطيل بَلا حَذف (يُحافِظ على audit history). */
  disable: adminProcedure
    .input(z.object({ integrationId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await setIntegrationStatus(input.integrationId, "DISABLED");
      await logAudit(ctx, {
        action: "integration.disable",
        entityType: "channelIntegration",
        entityId: input.integrationId,
      });
      return { ok: true };
    }),

  /** إعادة تَفعيل تَكامل مُعَطَّل (يَنتَقل لـACTIVE فَوراً لو كان نَجَح verify سابقاً). */
  enable: adminProcedure
    .input(z.object({ integrationId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await setIntegrationStatus(input.integrationId, "ACTIVE");
      await logAudit(ctx, {
        action: "integration.enable",
        entityType: "channelIntegration",
        entityId: input.integrationId,
      });
      return { ok: true };
    }),

  /** حَذف نِهائي — حِذرٌ، يَفقد كل secrets. */
  delete: adminProcedure
    .input(z.object({ integrationId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البَيانات غَير مُتاحة" });
      const row = (
        await db.select({ id: channelIntegrations.id }).from(channelIntegrations).where(eq(channelIntegrations.id, input.integrationId)).limit(1)
      )[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "التَكامل غَير مَوجود" });
      await deleteIntegration(input.integrationId);
      await logAudit(ctx, {
        action: "integration.delete",
        entityType: "channelIntegration",
        entityId: input.integrationId,
      });
      return { ok: true };
    }),

  /** يزامن قوالب Meta لتكامل واتساب ACTIVE على فرع مُعطى (WABA ID مطلوب في التكامل — انظر
   *  syncTemplatesFromGraph). إدارية: القوالب تُستهلَك لاحقاً في حملات/تذكيرات آلية (S4/S5). */
  syncTemplates: adminProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const integration = await getActiveWaTemplateIntegration(input.branchId);
      if (!integration) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يوجد تكامل واتساب فعّال (ACTIVE) لهذا الفرع — فعّله من شاشة التكاملات أولاً.",
        });
      }
      const result = await syncTemplatesFromGraph(integration);
      await logAudit(ctx, {
        action: "integration.syncTemplates",
        entityType: "channelIntegration",
        entityId: input.branchId,
        newValue: { branchId: input.branchId, synced: result.synced, approved: result.approved },
      });
      return result;
    }),

  templates: router({
    /** قراءة القوالب — managerProcedure (المدير يحتاج رؤيتها لإرسال حملة/تذكير)؛ المزامنة/الكتابة
     *  تبقى adminProcedure (integrationRouter.syncTemplates أعلاه). */
    list: managerProcedure
      .input(
        z
          .object({
            category: templateCategoryEnum.optional(),
            statusFilter: templateStatusEnum.optional(),
          })
          .optional(),
      )
      .query(({ input }) => listTemplates(input ?? {})),
  }),

  waHubSettings: router({
    /** إعدادات مركز واتساب الأعمال — get-or-default (بلا كتابة؛ نمط openingModeService.getOpeningMode). */
    get: managerProcedure.query(async () => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البَيانات غَير مُتاحة" });
      const row = (await db.select().from(waHubSettings).where(eq(waHubSettings.id, 1)).limit(1))[0];
      return row ?? WA_HUB_DEFAULTS;
    }),

    /** تحديث جزئي (undefined = لا تُغيَّر) — إدارية فقط. ensure-row + تحديث + قراءة نهائية ذرّياً. */
    update: adminProcedure.input(waHubSettingsUpdateSchema).mutation(async ({ input, ctx }) => {
      const row = await withTx(async (tx) => {
        await ensureWaHubSettingsRow(tx);
        await tx.update(waHubSettings).set({ ...input, updatedBy: ctx.user.id }).where(eq(waHubSettings.id, 1));
        const r = (await tx.select().from(waHubSettings).where(eq(waHubSettings.id, 1)).limit(1))[0];
        if (!r) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تحديث إعدادات مركز واتساب الأعمال" });
        return r;
      });
      await logAudit(ctx, {
        action: "waHubSettings.update",
        entityType: "waHubSettings",
        entityId: 1,
        newValue: input,
      });
      return row;
    }),
  }),
});
