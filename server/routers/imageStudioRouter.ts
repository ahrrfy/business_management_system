import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { AI_STUDIO_PROVIDERS, buildAiStudioPrompt, MAX_STUDIO_PROMPT_LEN } from "@shared/imageStudio/aiPrompt";
import { adminProcedure, productStudioWriteProcedure, protectedProcedure, router } from "../trpc";
import {
  getAiImageStudioSettings,
  getAiStudioConfig,
  getAiStudioRuntime,
  getImageStudioSettings,
  updateAiImageStudioSettings,
  updateImageStudioSettings,
  verifyAiConnection,
  verifyRemovebgConnection,
} from "../services/imageStudioSettingsService";
import { AiImageError, aiImageErrorMessageAr, generateStudioImage } from "../services/aiImageStudioService";
import {
  ImageStudioGuardError,
  imageStudioGuardErrorMessageAr,
  runGuardedImageStudioCall,
} from "../services/imageStudioUsageGuard";
import { assertValidImageDataUrl } from "../lib/imageValidation";
import { logAudit } from "../services/auditService";
import {
  attestStudioProcessing,
  authorizeStudioProcessing,
  releaseStudioProcessingAuthorization,
  type ProductStudioActor,
} from "../services/productStudioService";

function studioActor(ctx: { user: { id: number; branchId?: number | null; role: string; isOwner?: boolean } }): ProductStudioActor {
  return {
    userId: Number(ctx.user.id),
    branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
    role: ctx.user.role,
    isOwner: ctx.user.isOwner === true,
  };
}

/**
 * استوديو صور المنتجات.
 *
 * - الإعدادات (settings/updateSettings/verifyConnection): adminProcedure — مفتاح مدفوع = قرار مالك.
 *   لا يُسجَّل المفتاح في auditLogs أبداً (يُكشَف لمن يرى السجلّ) — فقط أيّ الحقول تغيّرت.
 * - تكامل remove.bg يبقى قابلاً للإدارة والفحص من الإعدادات، لكنه ليس مسار مهمة المصوّر.
 * - مسار المهمة الوحيد هو الذكاء الاصطناعي التعديلي، كي لا تختلط النتيجة الاحترافية بخيارات يدوية
 *   أو توليد من نصّ قد يغيّر هوية المنتج.
 */
export const imageStudioRouter = router({
  settings: adminProcedure.query(() => getImageStudioSettings()),

  updateSettings: adminProcedure
    .input(
      z.object({
        proEnabled: z.boolean().optional(),
        /** undefined=لا تُغيّر؛ null=امسح؛ string=مفتاح جديد. */
        removebgKey: z.string().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await updateImageStudioSettings(input, Number(ctx.user.id));
      // ⚠️ لا نُسجّل قيمة المفتاح — فقط ما تغيّر.
      await logAudit(ctx, {
        action: "imageStudio.updateSettings",
        entityType: "imageStudioSettings",
        entityId: 1,
        newValue: { proEnabled: input.proEnabled, keyChanged: input.removebgKey !== undefined },
      });
      return { ok: true };
    }),

  verifyConnection: adminProcedure.mutation(async ({ ctx }) => {
    const result = await verifyRemovebgConnection();
    await logAudit(ctx, {
      action: "imageStudio.verifyConnection",
      entityType: "imageStudioSettings",
      entityId: 1,
      newValue: { ok: result.ok },
    });
    return result;
  }),

  // ── مسار الذكاء الاصطناعي (استوديو موحّد بإعادة تصميم من برومت جاهز) ──
  // aiSettings/updateAiSettings/verifyAiConnection: adminProcedure — مفتاح مزوّد = قرار مالك.
  //   لا يُسجَّل المفتاح ولا نصّ البرومت في auditLogs — فقط أيّ الحقول تغيّرت.
  // aiConfig: protectedProcedure — حالة آمنة للواجهة، تفسّر العطل من دون كشف مفتاح.
  // aiStudioTransform: productStudioWriteProcedure + taskId إلزامي — تعديل صورة ملتقطة فقط.

  aiSettings: adminProcedure.query(() => getAiImageStudioSettings()),

  updateAiSettings: adminProcedure
    .input(
      z.object({
        aiEnabled: z.boolean().optional(),
        /** undefined=لا تُغيّر؛ null=امسح؛ string=مفتاح جديد. */
        aiKey: z.string().max(400).nullable().optional(),
        /** undefined=لا تُغيّر؛ null/''=افتراضي؛ string=عيّن. */
        aiModel: z.string().max(80).nullable().optional(),
        /** undefined=لا تُغيّر؛ null/''=البرومت الافتراضي؛ string=عيّن. */
        aiStudioPrompt: z.string().max(MAX_STUDIO_PROMPT_LEN).nullable().optional(),
        aiProvider: z.enum(AI_STUDIO_PROVIDERS).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await updateAiImageStudioSettings(input, Number(ctx.user.id));
      // ⚠️ لا نُسجّل قيمة المفتاح ولا نصّ البرومت — فقط ما تغيّر.
      await logAudit(ctx, {
        action: "imageStudio.updateAiSettings",
        entityType: "imageStudioSettings",
        entityId: 1,
        newValue: {
          aiEnabled: input.aiEnabled,
          keyChanged: input.aiKey !== undefined,
          modelChanged: input.aiModel !== undefined,
          promptChanged: input.aiStudioPrompt !== undefined,
          aiProvider: input.aiProvider,
        },
      });
      return { ok: true };
    }),

  verifyAiConnection: adminProcedure.mutation(async ({ ctx }) => {
    const result = await verifyAiConnection();
    await logAudit(ctx, {
      action: "imageStudio.verifyAiConnection",
      entityType: "imageStudioSettings",
      entityId: 1,
      newValue: { ok: result.ok },
    });
    return result;
  }),

  aiConfig: protectedProcedure.query(() => getAiStudioConfig()),

  aiStudioTransform: productStudioWriteProcedure
    .input(
      z.object({
        /** صورة المنتج الملتقطة. data URL حتى ٦م.ب نصّاً (~٢م.ب خام). */
        imageDataUrl: z.string().min(1).max(6_000_000),
        taskId: z.number().int().positive(),
        adminOverrideReason: z.string().trim().min(5).max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = studioActor(ctx);
      const processingAuthorization = await authorizeStudioProcessing(
        actor, input.taskId, "AI", input.adminOverrideReason, true,
      );
      let attested = false;
      try {
        assertValidImageDataUrl(input.imageDataUrl, 2_000_000, true);
        const match = /^data:([^;]+);base64,(.+)$/.exec(input.imageDataUrl);
        if (!match) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة الصورة غير مدعومة." });
        }
        const runtime = await getAiStudioRuntime();
        if (!runtime) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مسار الذكاء الاصطناعي غير مُفعَّل." });
        }
        const result = await generateStudioImage({
          apiKey: runtime.apiKey,
          model: runtime.model,
          prompt: buildAiStudioPrompt(runtime.basePrompt),
          imageBase64: match[2],
          mimeType: match[1],
        }, {
          runAttempt: (run) => runGuardedImageStudioCall({
            service: "AI",
            userId: Number(ctx.user.id),
            branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
            run,
          }),
        });
        const processingReceipt = await attestStudioProcessing(
          actor, input.taskId, "AI", processingAuthorization, input.adminOverrideReason,
        );
        attested = true;
        return {
          imageDataUrl: `data:${result.mimeType};base64,${result.imageBase64}`,
          provider: runtime.provider,
          model: runtime.model,
          processingReceipt,
        };
      } catch (e) {
        if (e instanceof ImageStudioGuardError) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: imageStudioGuardErrorMessageAr(e.kind),
          });
        }
        if (e instanceof AiImageError) {
          const code =
            e.kind === "AUTH" || e.kind === "QUOTA"
              ? "PRECONDITION_FAILED"
              : e.kind === "BLOCKED" || e.kind === "BAD_INPUT" || e.kind === "NO_IMAGE"
                ? "BAD_REQUEST"
                : "INTERNAL_SERVER_ERROR";
          const showDetail = e.kind === "NO_IMAGE" || e.kind === "BLOCKED";
          const message =
            showDetail && e.message && !e.message.startsWith("HTTP ")
              ? `${aiImageErrorMessageAr(e.kind)} — ${e.message}`
              : aiImageErrorMessageAr(e.kind);
          throw new TRPCError({ code, message });
        }
        throw e;
      } finally {
        if (!attested) {
          await releaseStudioProcessingAuthorization(input.taskId, "AI", processingAuthorization).catch(() => undefined);
        }
      }
    }),
});
