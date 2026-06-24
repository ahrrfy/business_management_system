import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { channelIntegrations } from "../../drizzle/schema";
import { getDb } from "../db";
import { adminProcedure, router } from "../trpc";
import {
  deleteIntegration,
  listIntegrations,
  setIntegrationStatus,
  upsertIntegration,
  verifyIntegration,
} from "../services/integrationService";
import { isCryptoReady } from "../services/cryptoService";
import { logAudit } from "../services/auditService";

const channelEnum = z.enum(["WHATSAPP", "INSTAGRAM", "STORE"]);

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
});
