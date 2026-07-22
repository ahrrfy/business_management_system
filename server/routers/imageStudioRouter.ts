import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { AI_STUDIO_PROVIDERS, buildAiStudioPrompt, MAX_STUDIO_PROMPT_LEN, MAX_USER_PROMPT_LEN } from "@shared/imageStudio/aiPrompt";
import { adminProcedure, productsManagerProcedure, protectedProcedure, router } from "../trpc";
import {
  getAiImageStudioSettings,
  getAiStudioConfig,
  getAiStudioRuntime,
  getDecryptedRemovebgKey,
  getImageStudioSettings,
  getProConfig,
  updateAiImageStudioSettings,
  updateImageStudioSettings,
  verifyAiConnection,
  verifyRemovebgConnection,
} from "../services/imageStudioSettingsService";
import { AiImageError, aiImageErrorMessageAr, generateStudioImage } from "../services/aiImageStudioService";
import { callRemovebg, RemovebgError, removebgErrorMessageAr } from "../services/removebgService";
import { assertValidImageDataUrl } from "../lib/imageValidation";
import { logAudit } from "../services/auditService";

/**
 * استوديو صور المنتجات — مسار Pro (remove.bg). شريحة ٥.
 *
 * - الإعدادات (settings/updateSettings/verifyConnection): adminProcedure — مفتاح مدفوع = قرار مالك.
 *   لا يُسجَّل المفتاح في auditLogs أبداً (يُكشَف لمن يرى السجلّ) — فقط أيّ الحقول تغيّرت.
 * - proConfig: protectedProcedure — بوليان «هل Pro متاح» لتقرّر الواجهة المحاولة (لا يسرّب المفتاح).
 * - proCutout: productsManagerProcedure (نفس createProduct) — يقصّ عبر remove.bg؛ أي فشل ⇒ الواجهة
 *   تتدهور لـFLATTEN المجاني. أمانة صارمة: remove.bg قصٌّ لا توليد (بكسلات المنتج تبقى).
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

  proCutout: productsManagerProcedure
    .input(z.object({ imageDataUrl: z.string().min(1).max(6_000_000) }))
    .mutation(async ({ input }) => {
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

      try {
        const result = await callRemovebg(key, base64);
        return {
          cutoutDataUrl: `data:image/png;base64,${result.cutout.toString("base64")}`,
          creditsCharged: result.creditsCharged,
          isPreview: result.isPreview ?? false,
        };
      } catch (e) {
        if (e instanceof RemovebgError) {
          // تصنيف يقود العرض: AUTH/نفاد الرصيد = خلل إعداد (PRECONDITION)؛ الباقي مؤقّت.
          throw new TRPCError({
            code: e.kind === "AUTH" || e.kind === "OUT_OF_CREDITS" ? "PRECONDITION_FAILED" : "INTERNAL_SERVER_ERROR",
            message: removebgErrorMessageAr(e.kind),
          });
        }
        throw e;
      }
    }),

  // ── مسار الذكاء الاصطناعي (استوديو موحّد بإعادة تصميم من برومت جاهز) ──
  // aiSettings/updateAiSettings/verifyAiConnection: adminProcedure — مفتاح مزوّد = قرار مالك.
  //   لا يُسجَّل المفتاح ولا نصّ البرومت في auditLogs — فقط أيّ الحقول تغيّرت.
  // aiConfig: protectedProcedure — بوليان «هل AI متاح» لتقرّر الواجهة العرض (لا يسرّب المفتاح).
  // aiStudioTransform: productsManagerProcedure — يُعيد تصميم الصورة عبر المزوّد. توليديّ ⇒ الواجهة
  //   تعرض قبل/بعد وتطلب اعتماداً بشرياً؛ الأصل لا يُستبدَل إلا بموافقة. البرومت يحمل حارس الحفظ.

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

  aiStudioTransform: productsManagerProcedure
    .input(
      z.object({
        /** صورة المنتج (وضع EDIT). data URL حتى ٦م.ب نصّاً (~٢م.ب خام). */
        imageDataUrl: z.string().min(1).max(6_000_000).optional(),
        /** إضافة اختيارية للبرومت الجاهز (تفضيل تنسيق فقط — لا تتجاوز حارس الحفظ). */
        userPrompt: z.string().max(MAX_USER_PROMPT_LEN).optional(),
        /** EDIT (الافتراضي): يُعيد تصميم صورة مرفوعة. GENERATE: يولّد من نصّ (يلزم userPrompt). */
        mode: z.enum(["EDIT", "GENERATE"]).default("EDIT"),
      }),
    )
    .mutation(async ({ input }) => {
      const mode = input.mode;
      let imageBase64: string | undefined;
      let mimeType: string | undefined;

      if (mode === "EDIT") {
        if (!input.imageDataUrl) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "وضع التعديل يحتاج صورة." });
        }
        // تحقّق أمني: data URL صورة صالحة (سحر البايتات) حتى ٢م.ب — نفس كتّاب صور المنتج.
        assertValidImageDataUrl(input.imageDataUrl, 2_000_000, true);
        const m = /^data:([^;]+);base64,(.+)$/.exec(input.imageDataUrl);
        if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة الصورة غير مدعومة." });
        mimeType = m[1];
        imageBase64 = m[2];
      } else if (!input.userPrompt || !input.userPrompt.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "وضع التوليد يحتاج وصفاً نصّياً." });
      }

      const runtime = await getAiStudioRuntime();
      if (!runtime) {
        // AI مطفأ/بلا مفتاح (سباق بعد فحص aiConfig).
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مسار الذكاء الاصطناعي غير مُفعَّل." });
      }

      const prompt = buildAiStudioPrompt(runtime.basePrompt, input.userPrompt);

      try {
        const result = await generateStudioImage({
          apiKey: runtime.apiKey,
          model: runtime.model,
          prompt,
          imageBase64,
          mimeType,
        });
        return {
          imageDataUrl: `data:${result.mimeType};base64,${result.imageBase64}`,
          provider: runtime.provider,
          model: runtime.model,
        };
      } catch (e) {
        if (e instanceof AiImageError) {
          // AUTH/QUOTA = خلل إعداد/خطّة (PRECONDITION)؛ BLOCKED/BAD_INPUT/NO_IMAGE = مدخل يُعدَّل (BAD_REQUEST)؛
          // SERVICE/NETWORK = مؤقّت (INTERNAL).
          const code =
            e.kind === "AUTH" || e.kind === "QUOTA"
              ? "PRECONDITION_FAILED"
              : e.kind === "BLOCKED" || e.kind === "BAD_INPUT" || e.kind === "NO_IMAGE"
                ? "BAD_REQUEST"
                : "INTERNAL_SERVER_ERROR";
          throw new TRPCError({ code, message: aiImageErrorMessageAr(e.kind) });
        }
        throw e;
      }
    }),
});
