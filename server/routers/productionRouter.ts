/**
 * productionRouter — الإنتاج/التحويل + الوصفات.
 *  - list/get/create/cancel: inventoryManagerProcedure (مُكلِّف، يحرّك مخزوناً).
 *  - recipes.*: inventoryManagerProcedure — تعريف/معاينة وصفات الإنتاج المتكرّرة.
 * كل المسارات مدير فأعلى (الوحدة إشرافية)؛ تدقيق على كل كتابة.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, exists, gte, inArray, lt, or, sql } from "drizzle-orm";
import { branches, productVariants, productionLines, productionOrders, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import {
  cancelProduction,
  createProduction,
  getProduction,
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
import { inventoryManagerProcedure, router } from "../trpc";
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

/**
 * قائمة الإنتاج المفلترة (فرع/حالة/نطاق تاريخ/بحث + ترقيم hasMore) — استعلام محليّ للراوتر
 * (ملكية ملفات حملة الفلاتر ٣/٨ تقصر التعديل على الراوتر؛ خدمة listProductions القديمة بلا هذه الفلاتر).
 */
async function listProductionsFiltered(f: {
  branchId?: number;
  status?: "CONFIRMED" | "CANCELLED";
  from?: string;
  to?: string;
  q?: string;
  limit: number;
  offset: number;
}) {
  const db = getDb();
  if (!db) return { rows: [] as any[], hasMore: false };
  const conds = [] as any[];
  if (f.branchId) conds.push(eq(productionOrders.branchId, f.branchId));
  if (f.status) conds.push(eq(productionOrders.status, f.status));
  if (f.from) conds.push(gte(productionOrders.createdAt, localDayStart(f.from)));
  if (f.to) conds.push(lt(productionOrders.createdAt, localNextDayStart(f.to)));
  const term = f.q?.trim();
  if (term) {
    const likePat = `%${escLike(term)}%`;
    // البحث برقم المستند أو باسم المنتج الناتج — EXISTS على أسطر OUTPUT كي لا تتكرّر رؤوس المستندات.
    conds.push(
      or(
        sql`${productionOrders.docNumber} LIKE ${likePat} ESCAPE '!'`,
        exists(
          db
            .select({ one: sql`1` })
            .from(productionLines)
            .innerJoin(productVariants, eq(productVariants.id, productionLines.variantId))
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(
              and(
                eq(productionLines.productionOrderId, productionOrders.id),
                eq(productionLines.direction, "OUTPUT"),
                sql`${products.name} LIKE ${likePat} ESCAPE '!'`,
              ),
            ),
        ),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  // limit+1 لاستنتاج hasMore بلا COUNT مكلف (نمط hasMore القائم في بقية القوائم).
  const heads = await db
    .select({
      id: productionOrders.id,
      docNumber: productionOrders.docNumber,
      branchId: productionOrders.branchId,
      branchName: branches.name,
      status: productionOrders.status,
      materialsCost: productionOrders.materialsCost,
      laborCost: productionOrders.laborCost,
      totalCost: productionOrders.totalCost,
      notes: productionOrders.notes,
      createdAt: productionOrders.createdAt,
    })
    .from(productionOrders)
    .leftJoin(branches, eq(productionOrders.branchId, branches.id))
    .where(where as any)
    .orderBy(desc(productionOrders.id))
    .limit(f.limit + 1)
    .offset(f.offset);
  const hasMore = heads.length > f.limit;
  const rows = hasMore ? heads.slice(0, f.limit) : heads;
  if (!rows.length) return { rows: [] as any[], hasMore };

  // كمية المخرجات الإجمالية لكل مستند (نفس تجميع الخدمة الأصلية).
  const ids = rows.map((r: any) => Number(r.id));
  const outAgg = await db
    .select({ orderId: productionLines.productionOrderId, qty: sql<string>`COALESCE(SUM(${productionLines.baseQuantity}), 0)` })
    .from(productionLines)
    .where(and(inArray(productionLines.productionOrderId, ids), eq(productionLines.direction, "OUTPUT")))
    .groupBy(productionLines.productionOrderId);
  const outMap = new Map(outAgg.map((a: any) => [Number(a.orderId), Number(a.qty)]));
  return { rows: rows.map((r: any) => ({ ...r, outputQty: outMap.get(Number(r.id)) ?? 0 })), hasMore };
}

export const productionRouter = router({
  list: inventoryManagerProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          status: z.enum(["CONFIRMED", "CANCELLED"]).optional(),
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          q: z.string().max(100).optional(),
          limit: z.number().int().positive().max(500).default(200),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(({ input, ctx }) => {
      // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن وحدهما يحترمان branchId المُرسَل (تقارير عبر-الفروع)؛
      // مدير الفرع وغيره مقصورون بفرعهم المُسنَد.
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      const branchId = elevated ? input?.branchId : Number(ctx.user.branchId ?? 0) || undefined;
      return listProductionsFiltered({
        branchId,
        status: input?.status,
        from: input?.from,
        to: input?.to,
        q: input?.q,
        limit: input?.limit ?? 200,
        offset: input?.offset ?? 0,
      });
    }),

  get: inventoryManagerProcedure
    .input(z.object({ productionOrderId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getProduction(input.productionOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role })
    ),

  /** معاينة «تشغيل بوصفة» حيّةً (بلا حركة): أشرطة المخزون + تفريق الهدر + أثر WAVG. */
  runPreview: inventoryManagerProcedure
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

  create: inventoryManagerProcedure
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
        clientRequestId: z.string().min(1).max(80).optional(),
        run: runInput.nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع (تدقيق ١٧/٧): createProduction كان يستعمل input.branchId مباشرةً (ترقيم/استهلاك/إنتاج)
      // ⇒ دورٌ مُنح inventory=FULL (غير مدير) يُنتج/يستهلك في فرعٍ آخر. غير admin/manager يُجبَر على فرعه.
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const effectiveBranchId = elevated ? input.branchId : Number(ctx.user.branchId);
      const enforcedInput = { ...input, branchId: effectiveBranchId };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createProduction(enforcedInput, { userId: ctx.user.id, branchId: effectiveBranchId });
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

  cancel: inventoryManagerProcedure
    .input(z.object({ productionOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelProduction(input.productionOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "production.cancel", entityType: "production", entityId: input.productionOrderId });
      return res;
    }),

  // ───────────────────────── الوصفات ─────────────────────────
  recipes: router({
    list: inventoryManagerProcedure
      .input(z.object({ activeOnly: z.boolean().optional() }).optional())
      .query(({ input }) => listRecipes({ activeOnly: input?.activeOnly })),

    get: inventoryManagerProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getRecipe(input.id)),

    create: inventoryManagerProcedure.input(recipeInput).mutation(async ({ input, ctx }) => {
      try {
        const res = await createRecipe(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
        await logAudit(ctx, { action: "production.recipe.create", entityType: "productionRecipe", entityId: res.recipeId, newValue: { name: input.name } });
        return res;
      } catch (e: any) {
        if (isDupEntry(e)) throw new TRPCError({ code: "CONFLICT", message: "اسم الوصفة مستعمل سلفاً" });
        throw e;
      }
    }),

    update: inventoryManagerProcedure.input(recipeInput.extend({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
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

    setActive: inventoryManagerProcedure
      .input(z.object({ id: z.number().int().positive(), active: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const res = await setRecipeActive(input.id, input.active);
        await logAudit(ctx, { action: input.active ? "production.recipe.activate" : "production.recipe.deactivate", entityType: "productionRecipe", entityId: input.id });
        return res;
      }),

    remove: inventoryManagerProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const res = await deleteRecipe(input.id);
      await logAudit(ctx, { action: "production.recipe.delete", entityType: "productionRecipe", entityId: input.id });
      return res;
    }),

    /** معاينة وصفة لكمية ناتج ⇒ أسطر جاهزة للنموذج (بلا حركة مخزون). */
    preview: inventoryManagerProcedure
      .input(z.object({ recipeId: z.number().int().positive(), outputQuantity: z.string(), branchId: z.number().int().positive().nullish() }))
      .query(({ input }) => recipePreview({ recipeId: input.recipeId, outputQuantity: input.outputQuantity, branchId: input.branchId ?? null })),
  }),
});
