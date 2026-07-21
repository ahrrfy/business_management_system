import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, productsManagerProcedure, protectedProcedure, router } from "../trpc";
import {
  getDecryptedRemovebgKey,
  getImageStudioSettings,
  getProConfig,
  updateImageStudioSettings,
  verifyRemovebgConnection,
} from "../services/imageStudioSettingsService";
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
});
