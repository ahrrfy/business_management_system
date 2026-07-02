/**
 * productionRouter — الإنتاج/التحويل + الوصفات.
 *  - list/get/create/cancel: managerProcedure (مُكلِّف، يحرّك مخزوناً).
 *  - recipes.*: managerProcedure — تعريف/معاينة وصفات الإنتاج المتكرّرة.
 * كل المسارات مدير فأعلى (الوحدة إشرافية)؛ تدقيق على كل كتابة.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  cancelProduction,
  createProduction,
  getProduction,
  listProductions,
  runPreview,
} from "../services/productionService";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  recipePreview,
  setRecipeActive,
  updateRecipe,
} from "../services/recipeService";
import { logAudit } from "../services/auditService";
import { managerProcedure, router } from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";

const lineInput = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive().nullish(),
  quantity: z.string().optional(),
  baseQuantity: z.number().int().positive().optional(),
});
const outputLineInput = lineInput.extend({ manualSharePct: z.string().nullish() });

const recipeLineInput = z.object({
  inputVariantId: z.number().int().positive(),
  inputProductUnitId: z.number().int().positive().nullish(),
  qtyPerOutputBase: z.string(),
  notes: z.string().nullish(),
});
const recipeInput = z.object({
  name: z.string().min(1).max(150),
  outputVariantId: z.number().int().positive(),
  outputProductUnitId: z.number().int().positive(),
  laborPerOutputBase: z.string().nullish(),
  wasteStdPct: z.string().nullish(),
  notes: z.string().nullish(),
  lines: z.array(recipeLineInput).min(1),
});

/** مسار «التشغيل بوصفة»: الخادم يوسّع الوصفة (نموذج الدفعة تقود الاستهلاك) ⇒ يمنع تلاعب الكلفة. */
const runInput = z.object({
  recipeId: z.number().int().positive(),
  batchQty: z.number().int().positive(),
  scrapQty: z.number().int().min(0).default(0),
  laborPerUnit: z.string().nullish(),
});

export const productionRouter = router({
  list: managerProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          status: z.enum(["CONFIRMED", "CANCELLED"]).optional(),
          limit: z.number().int().positive().max(500).default(200),
        })
        .optional()
    )
    .query(({ input, ctx }) => {
      const branchId = ctx.user.role === "admin" ? input?.branchId : Number(ctx.user.branchId ?? 0) || undefined;
      return listProductions({ branchId, status: input?.status, limit: input?.limit });
    }),

  get: managerProcedure
    .input(z.object({ productionOrderId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getProduction(input.productionOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role })
    ),

  /** معاينة «تشغيل بوصفة» حيّةً (بلا حركة): أشرطة المخزون + تفريق الهدر + أثر WAVG. */
  runPreview: managerProcedure
    .input(
      z.object({
        recipeId: z.number().int().positive(),
        batchQty: z.union([z.number(), z.string()]),
        scrapQty: z.union([z.number(), z.string()]).nullish(),
        laborPerUnit: z.string().nullish(),
        branchId: z.number().int().positive().nullish(),
      })
    )
    .query(({ input }) => runPreview(input)),

  create: managerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        // المدخلات/المخرجات اليدوية اختيارية عند تمرير run (التشغيل بوصفة).
        inputs: z.array(lineInput).optional(),
        outputs: z.array(outputLineInput).optional(),
        laborCost: z.string().nullish(),
        notes: z.string().nullish(),
        linkedWorkOrderId: z.number().int().positive().nullish(),
        linkedRecipeId: z.number().int().positive().nullish(),
        allowSelfConvert: z.boolean().optional(),
        clientRequestId: z.string().min(1).max(80).optional(),
        run: runInput.nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createProduction(input, { userId: ctx.user.id, branchId: Number(ctx.user.branchId) });
          if (!(res as { idempotent?: boolean }).idempotent) {
            await logAudit(ctx, {
              action: "production.create",
              entityType: "production",
              entityId: (res as { productionOrderId?: number })?.productionOrderId,
              newValue: {
                branchId: input.branchId,
                mode: input.run ? "recipe" : "manual",
                inputsCount: input.inputs?.length ?? null,
                outputsCount: input.outputs?.length ?? null,
                batchQty: input.run?.batchQty ?? null,
                scrapQty: input.run?.scrapQty ?? null,
                totalCost: (res as { totalCost?: string })?.totalCost ?? null,
                recipeId: input.run?.recipeId ?? input.linkedRecipeId ?? null,
              },
            });
          }
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء مستند الإنتاج" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إنشاء مستند الإنتاج" });
    }),

  cancel: managerProcedure
    .input(z.object({ productionOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelProduction(input.productionOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "production.cancel", entityType: "production", entityId: input.productionOrderId });
      return res;
    }),

  // ───────────────────────── الوصفات ─────────────────────────
  recipes: router({
    list: managerProcedure
      .input(z.object({ activeOnly: z.boolean().optional() }).optional())
      .query(({ input }) => listRecipes({ activeOnly: input?.activeOnly })),

    get: managerProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getRecipe(input.id)),

    create: managerProcedure.input(recipeInput).mutation(async ({ input, ctx }) => {
      try {
        const res = await createRecipe(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
        await logAudit(ctx, { action: "production.recipe.create", entityType: "productionRecipe", entityId: res.recipeId, newValue: { name: input.name } });
        return res;
      } catch (e: any) {
        if (isDupEntry(e)) throw new TRPCError({ code: "CONFLICT", message: "اسم الوصفة مستعمل سلفاً" });
        throw e;
      }
    }),

    update: managerProcedure.input(recipeInput.extend({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const { id, ...rest } = input;
      try {
        const res = await updateRecipe(id, rest);
        await logAudit(ctx, { action: "production.recipe.update", entityType: "productionRecipe", entityId: id, newValue: { name: input.name } });
        return res;
      } catch (e: any) {
        if (isDupEntry(e)) throw new TRPCError({ code: "CONFLICT", message: "اسم الوصفة مستعمل سلفاً" });
        throw e;
      }
    }),

    setActive: managerProcedure
      .input(z.object({ id: z.number().int().positive(), active: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const res = await setRecipeActive(input.id, input.active);
        await logAudit(ctx, { action: input.active ? "production.recipe.activate" : "production.recipe.deactivate", entityType: "productionRecipe", entityId: input.id });
        return res;
      }),

    remove: managerProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const res = await deleteRecipe(input.id);
      await logAudit(ctx, { action: "production.recipe.delete", entityType: "productionRecipe", entityId: input.id });
      return res;
    }),

    /** معاينة وصفة لكمية ناتج ⇒ أسطر جاهزة للنموذج (بلا حركة مخزون). */
    preview: managerProcedure
      .input(z.object({ recipeId: z.number().int().positive(), outputQuantity: z.string(), branchId: z.number().int().positive().nullish() }))
      .query(({ input }) => recipePreview({ recipeId: input.recipeId, outputQuantity: input.outputQuantity, branchId: input.branchId ?? null })),
  }),
});
