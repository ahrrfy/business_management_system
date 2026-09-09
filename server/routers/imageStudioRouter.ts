import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { AI_STUDIO_PROVIDERS, MAX_STUDIO_PROMPT_LEN } from "@shared/imageStudio/aiPrompt";
import { adminProcedure, productStudioWriteProcedure, protectedProcedure, router } from "../trpc";
import {
  getAiImageStudioSettings,
  getAiStudioConfig,
  getDecryptedRemovebgKey,
  getImageStudioSettings,
  getProConfig,
  updateAiImageStudioSettings,
  updateImageStudioSettings,
  verifyAiConnection,
  verifyRemovebgConnection,
} from "../services/imageStudioSettingsService";
import { callRemovebg, RemovebgError, removebgErrorMessageAr } from "../services/removebgService";
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
 * استوديو صور المنتجات — مسار Pro (remove.bg). شريحة ٥.
 *
 * - الإعدادات (settings/updateSettings/verifyConnection): adminProcedure — مفتاح مدفوع = قرار مالك.
 *   لا يُسجَّل المفتاح في auditLogs أبداً (يُكشَف لمن يرى السجلّ) — فقط أيّ الحقول تغيّرت.
 * - proConfig: protectedProcedure — بوليان «هل Pro متاح» لتقرّر الواجهة المحاولة (لا يسرّب المفتاح).
 * - proCutout: productStudioWriteProcedure + taskId إلزامي — يقصّ عبر remove.bg داخل مهمة مسندة فقط.
 *   أمانة صارمة: remove.bg قصٌّ لا توليد (بكسلات المنتج تبقى).
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

  proConfig: protectedProcedure.query(() => getProConfig()),

  proCutout: productStudioWriteProcedure
    .input(z.object({
      imageDataUrl: z.string().min(1).max(6_000_000),
      taskId: z.number().int().positive(),
      adminOverrideReason: z.string().trim().min(5).max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const actor = studioActor(ctx);
      const processingAuthorization = await authorizeStudioProcessing(
        actor, input.taskId, "PRO", input.adminOverrideReason, true,
      );
      let attested = false;
      try {
        // تحقّق أمني: data URL صورة صالحة (سحر البايتات) حتى ٢م.ب — نفس كتّاب صور المنتج.
        assertValidImageDataUrl(input.imageDataUrl, 2_000_000, true);
        const key = await getDecryptedRemovebgKey();
        if (!key) {
          // Pro مطفأ/بلا مفتاح (سباق بعد فحص proConfig) ⇒ الواجهة تتدهور لـFLATTEN.
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مسار Pro غير مُفعَّل." });
        }
        const m = /^data:([^;]+);base64,(.+)$/.exec(input.imageDataUrl);
        if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة الصورة غير مدعومة." });
        const base64 = m[2];
        const result = await runGuardedImageStudioCall({
          service: "REMOVEBG",
          userId: Number(ctx.user.id),
          branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
          run: () => callRemovebg(key, base64),
        });
        const processingReceipt = await attestStudioProcessing(
          actor, input.taskId, "PRO", processingAuthorization, input.adminOverrideReason,
        );
        attested = true;
        return {
          cutoutDataUrl: `data:image/png;base64,${result.cutout.toString("base64")}`,
          creditsCharged: result.creditsCharged,
          isPreview: result.isPreview ?? false,
          processingReceipt,
        };
      } catch (e) {
        if (e instanceof ImageStudioGuardError) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: imageStudioGuardErrorMessageAr(e.kind),
          });
        }
        if (e instanceof RemovebgError) {
          // تصنيف يقود العرض: AUTH/نفاد الرصيد = خلل إعداد (PRECONDITION)؛ الباقي مؤقّت.
          throw new TRPCError({
            code: e.kind === "AUTH" || e.kind === "OUT_OF_CREDITS" ? "PRECONDITION_FAILED" : "INTERNAL_SERVER_ERROR",
            message: removebgErrorMessageAr(e.kind),
          });
        }
        throw e;
      } finally {
        if (!attested) {
          await releaseStudioProcessingAuthorization(input.taskId, "PRO", processingAuthorization).catch(() => undefined);
        }
      }
    }),

  // ── مسار الذكاء الاصطناعي (استوديو موحّد بإعادة تصميم من برومت جاهز) ──
  // aiSettings/updateAiSettings/verifyAiConnection: adminProcedure — مفتاح مزوّد = قرار مالك.
  //   لا يُسجَّل المفتاح ولا نصّ البرومت في auditLogs — فقط أيّ الحقول تغيّرت.
  // aiConfig: protectedProcedure — بوليان «هل AI متاح» لتقرّر الواجهة العرض (لا يسرّب المفتاح).
  // لا يُتاح توليد صور المنتجات: يحافظ الاستوديو على هوية المنتج الحقيقيّة فقط.

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
});
