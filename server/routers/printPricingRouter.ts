import { z } from "zod";
import { managerProcedure, router } from "../trpc";
import { nonNegMoneyString, positiveMoneyString, positiveQtyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import {
  COLOR_MODES,
  FINISHING_UNITS,
  PAPER_SIZE_CODES,
  PAPER_UPCHARGE_UNITS,
  PRICING_MODES,
} from "@shared/printPricing";
import {
  createFinishing,
  createPaperUpcharge,
  createWideMedia,
  deleteFacePrice,
  estimatePrint,
  getPrintPricingBundle,
  updateFinishing,
  updatePaperUpcharge,
  updatePrintPricingSettings,
  updateWideMedia,
  upsertFacePrice,
} from "../services/printPricing";

/**
 * محرّك تسعير الطباعة الرقمية (Digital) — البند⑥ الطبقة٢. حاسبة + إعدادات، **محصورة بالمدير**
 * (managerProcedure) بالكامل: الأسعار سياسةٌ تجارية، والحاسبة أداة تسعيرٍ داخلية. v1 مستقلّة
 * (لا ربط بعروض/أوامر شغل بعد). كل حقل ماليّ عبر مخطّطات server/lib/schemas (حارس المال).
 */

// نسبة الهامش (٪) — تسمح بأكثر من ١٠٠٪ (markup مشروع) لكن ضمن decimal(6,3) ≤ ٩٩٩٫٩٩٩.
const marginPercentString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "نسبة هامش غير صالحة")
  .refine((s) => Number(s) <= 999.999, "نسبة الهامش مرتفعة جداً");

const positiveInt = z.number().int().min(1).max(1_000_000);

const commonEstimate = {
  applySetupFee: z.boolean().optional(),
  marginPercentOverride: marginPercentString.nullable().optional(),
};

const estimateInput = z.discriminatedUnion("category", [
  z.object({
    category: z.literal("SMALL"),
    paperSize: z.enum(PAPER_SIZE_CODES),
    colorMode: z.enum(COLOR_MODES),
    sides: z.union([z.literal(1), z.literal(2)]),
    copies: positiveInt,
    pagesPerCopy: positiveInt,
    paperUpchargeId: z.number().int().positive().nullable().optional(),
    finishingIds: z.array(z.number().int().positive()).max(30).optional(),
    ...commonEstimate,
  }),
  z.object({
    category: z.literal("WIDE"),
    mediaId: z.number().int().positive(),
    width: positiveQtyString, // بالمتر (موجب، ٣ منازل)
    height: positiveQtyString,
    quantity: positiveInt,
    finishingIds: z.array(z.number().int().positive()).max(30).optional(),
    ...commonEstimate,
  }),
]);

export const printPricingRouter = router({
  // ─── الحاسبة (قراءة حيّة) ──────────────────────────────────────────────
  estimate: managerProcedure.input(estimateInput).query(({ input }) => estimatePrint(input)),

  // ─── قراءة كل الإعدادات (للحاسبة + شاشة الإعدادات) ─────────────────────
  settings: managerProcedure.query(() => getPrintPricingBundle()),

  // ─── الإعدادات العامّة (وضع/هامش/تجهيز) ───────────────────────────────
  updateSettings: managerProcedure
    .input(
      z.object({
        pricingMode: z.enum(PRICING_MODES).optional(),
        defaultMarginPercent: marginPercentString.optional(),
        setupFee: nonNegMoneyString.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await updatePrintPricingSettings(input, Number(ctx.user.id));
      await logAudit(ctx, { action: "printPricing.updateSettings", entityType: "printPricingSettings", entityId: 1, newValue: input });
      return { ok: true };
    }),

  // ─── سعر الوجه (المقاس × النمط) ───────────────────────────────────────
  upsertFacePrice: managerProcedure
    .input(
      z.object({
        paperSize: z.enum(PAPER_SIZE_CODES),
        colorMode: z.enum(COLOR_MODES),
        pricePerFace: positiveMoneyString,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await upsertFacePrice(input, Number(ctx.user.id));
      await logAudit(ctx, { action: "printPricing.upsertFacePrice", entityType: "printFacePrices", newValue: input });
      return { ok: true };
    }),

  deleteFacePrice: managerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await deleteFacePrice(input.id);
      await logAudit(ctx, { action: "printPricing.deleteFacePrice", entityType: "printFacePrices", entityId: input.id });
      return { ok: true };
    }),

  // ─── الورق المميّز (اختياريّ) ─────────────────────────────────────────
  createPaperUpcharge: managerProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        unit: z.enum(PAPER_UPCHARGE_UNITS),
        upcharge: positiveMoneyString,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createPaperUpcharge(input);
      await logAudit(ctx, { action: "printPricing.createPaperUpcharge", entityType: "printPaperUpcharges", entityId: res.id, newValue: input });
      return res;
    }),

  updatePaperUpcharge: managerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(120).optional(),
        unit: z.enum(PAPER_UPCHARGE_UNITS).optional(),
        upcharge: positiveMoneyString.optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await updatePaperUpcharge(input);
      await logAudit(ctx, { action: "printPricing.updatePaperUpcharge", entityType: "printPaperUpcharges", entityId: input.id, newValue: input });
      return { ok: true };
    }),

  // ─── الوسائط العريضة (فلكس) ───────────────────────────────────────────
  createWideMedia: managerProcedure
    .input(z.object({ name: z.string().trim().min(1).max(120), pricePerSqm: positiveMoneyString }))
    .mutation(async ({ input, ctx }) => {
      const res = await createWideMedia(input);
      await logAudit(ctx, { action: "printPricing.createWideMedia", entityType: "printWideMedia", entityId: res.id, newValue: input });
      return res;
    }),

  updateWideMedia: managerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(120).optional(),
        pricePerSqm: positiveMoneyString.optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await updateWideMedia(input);
      await logAudit(ctx, { action: "printPricing.updateWideMedia", entityType: "printWideMedia", entityId: input.id, newValue: input });
      return { ok: true };
    }),

  // ─── خيارات التشطيب ───────────────────────────────────────────────────
  createFinishing: managerProcedure
    .input(z.object({ name: z.string().trim().min(1).max(120), unit: z.enum(FINISHING_UNITS), price: positiveMoneyString }))
    .mutation(async ({ input, ctx }) => {
      const res = await createFinishing(input);
      await logAudit(ctx, { action: "printPricing.createFinishing", entityType: "printFinishingOptions", entityId: res.id, newValue: input });
      return res;
    }),

  updateFinishing: managerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(120).optional(),
        unit: z.enum(FINISHING_UNITS).optional(),
        price: positiveMoneyString.optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await updateFinishing(input);
      await logAudit(ctx, { action: "printPricing.updateFinishing", entityType: "printFinishingOptions", entityId: input.id, newValue: input });
      return { ok: true };
    }),
});
