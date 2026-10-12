/**
 * productionRouter — الإنتاج/التحويل + الوصفات.
 *  - list/get/create/cancel: inventoryManagerProcedure (مُكلِّف، يحرّك مخزوناً).
 *  - recipes.*: inventoryManagerProcedure — تعريف/معاينة وصفات الإنتاج المتكرّرة.
 * كل المسارات مدير فأعلى (الوحدة إشرافية)؛ تدقيق على كل كتابة.
 */
import { TRPCError } from "@trpc/server";
import { failOpaque } from "../lib/opaqueFailure";
import { z } from "zod";
import { appErrorMessage } from "@shared/errors";
import { and, asc, desc, eq, exists, gte, inArray, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { branches, productUnits, productVariants, productionLines, productionOrders, productionRecipes, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import {
  cancelProduction,
  createProduction,
  getProduction,
  recipeCapacity,
  runPreview,
  analyzeBundleRequirements,
  produceBundleComponents,
  analyzeMultiRecipeRequirements,
  produceMultiRecipeBatches,
} from "../services/productionService";
import {
  analyzeBundleRequirementsInputSchema,
  produceBundleComponentsInputSchema,
} from "@shared/bundleProductionTypes";
import {
  analyzeMultiRecipeRequirementsInputSchema,
  produceMultiRecipeInputSchema,
} from "@shared/multiRecipeProductionTypes";
import {
  checkRecipeMaterialsAvailability,
  createRecipe,
  deleteRecipe,
  getRecipe,
  getRecipeForProduct,
  listRecipes,
  listRecipesForImport,
  listRunnableRecipes,
  recipePreview,
  setRecipeActive,
  substituteRecipeMaterial,
  suggestSimilarRecipes,
  updateRecipe,
} from "../services/recipeService";
import {
  materialSubstitutionItemSchema,
  substituteRecipeMaterialInputSchema,
} from "@shared/recipeSubstitutionTypes";
import { logAudit } from "../services/auditService";
import { listMaterialsForRecipe } from "../services/catalog/productExtras";
import { inventoryManagerProcedure, productsReadProcedure, router } from "../trpc";
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
  isActive: z.boolean().optional(),
  lines: z.array(recipeLineInput).min(1),
});

/** مسار «التشغيل بوصفة»: الخادم يوسّع الوصفة (نموذج الدفعة تقود الاستهلاك) ⇒ يمنع تلاعب الكلفة. */
const runInput = z.object({
  recipeId: z.number().int().positive(),
  batchQty: z.number().int().positive(),
  scrapQty: z.number().int().min(0).default(0),
  laborPerUnit: z.string().nullish(),
  materialSubstitutions: z.array(materialSubstitutionItemSchema).nullish(),
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
  const recipeOutputVariant = alias(productVariants, "recipeOutputVariant");
  const recipeOutputProduct = alias(products, "recipeOutputProduct");

  const conds = [] as any[];
  if (f.branchId) conds.push(eq(productionOrders.branchId, f.branchId));
  if (f.status) conds.push(eq(productionOrders.status, f.status));
  if (f.from) conds.push(gte(productionOrders.createdAt, localDayStart(f.from)));
  if (f.to) conds.push(lt(productionOrders.createdAt, localNextDayStart(f.to)));
  const term = f.q?.trim();
  if (term) {
    const likePat = `%${escLike(term)}%`;
    // البحث برقم المستند، ملاحظات، اسم الوصفة، أو اسم المنتج/الرمز الناتج — EXISTS على أسطر OUTPUT أو ناتج الوصفة.
    conds.push(
      or(
        sql`${productionOrders.docNumber} LIKE ${likePat} ESCAPE '!'`,
        sql`${productionOrders.notes} LIKE ${likePat} ESCAPE '!'`,
        exists(
          db
            .select({ one: sql`1` })
            .from(productionRecipes)
            .leftJoin(recipeOutputVariant, eq(recipeOutputVariant.id, productionRecipes.outputVariantId))
            .leftJoin(recipeOutputProduct, eq(recipeOutputProduct.id, recipeOutputVariant.productId))
            .where(
              and(
                eq(productionRecipes.id, productionOrders.linkedRecipeId),
                or(
                  sql`${productionRecipes.name} LIKE ${likePat} ESCAPE '!'`,
                  sql`${recipeOutputProduct.name} LIKE ${likePat} ESCAPE '!'`,
                  sql`${recipeOutputVariant.sku} LIKE ${likePat} ESCAPE '!'`,
                  sql`${recipeOutputVariant.variantName} LIKE ${likePat} ESCAPE '!'`,
                ),
              ),
            ),
        ),
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
                or(
                  sql`${products.name} LIKE ${likePat} ESCAPE '!'`,
                  sql`${productVariants.sku} LIKE ${likePat} ESCAPE '!'`,
                  sql`${productVariants.variantName} LIKE ${likePat} ESCAPE '!'`,
                ),
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
      batchQty: productionOrders.batchQty,
      goodQty: productionOrders.goodQty,
      scrapQty: productionOrders.scrapQty,
      notes: productionOrders.notes,
      linkedWorkOrderId: productionOrders.linkedWorkOrderId,
      linkedRecipeId: productionOrders.linkedRecipeId,
      recipeName: productionRecipes.name,
      recipeOutputProductName: recipeOutputProduct.name,
      recipeOutputVariantName: recipeOutputVariant.variantName,
      recipeOutputSku: recipeOutputVariant.sku,
      createdAt: productionOrders.createdAt,
    })
    .from(productionOrders)
    .leftJoin(branches, eq(productionOrders.branchId, branches.id))
    .leftJoin(productionRecipes, eq(productionOrders.linkedRecipeId, productionRecipes.id))
    .leftJoin(recipeOutputVariant, eq(productionRecipes.outputVariantId, recipeOutputVariant.id))
    .leftJoin(recipeOutputProduct, eq(recipeOutputVariant.productId, recipeOutputProduct.id))
    .where(where as any)
    .orderBy(desc(productionOrders.id))
    .limit(f.limit + 1)
    .offset(f.offset);
  const hasMore = heads.length > f.limit;
  const rows = hasMore ? heads.slice(0, f.limit) : heads;
  if (!rows.length) return { rows: [] as any[], hasMore };

  // جلب كافة أسطر المخرجات لهذه الأوامر
  const ids = rows.map((r: any) => Number(r.id));
  const outLines = await db
    .select({
      orderId: productionLines.productionOrderId,
      variantId: productionLines.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      unitName: productUnits.unitName,
      quantity: productionLines.quantity,
      baseQuantity: productionLines.baseQuantity,
    })
    .from(productionLines)
    .innerJoin(productVariants, eq(productionLines.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(productionLines.productUnitId, productUnits.id))
    .where(
      and(
        inArray(productionLines.productionOrderId, ids),
        eq(productionLines.direction, "OUTPUT"),
      ),
    )
    .orderBy(asc(productionLines.id));

  // تجميع المخرجات لكل مستند
  const outputsByOrder = new Map<number, Array<{
    variantId: number;
    productName: string;
    variantName: string | null;
    sku: string | null;
    unitName: string | null;
    quantity: string;
    baseQuantity: number;
  }>>();

  for (const l of outLines) {
    const orderId = Number(l.orderId);
    let list = outputsByOrder.get(orderId);
    if (!list) {
      list = [];
      outputsByOrder.set(orderId, list);
    }
    list.push({
      variantId: Number(l.variantId),
      productName: l.productName ?? "",
      variantName: l.variantName ?? null,
      sku: l.sku ?? null,
      unitName: l.unitName ?? null,
      quantity: String(l.quantity),
      baseQuantity: Number(l.baseQuantity),
    });
  }

  // استخراج معرّفات البكج من الملاحظات إن وُجدت للبحث عن أسماء البكجات في قاعدة البيانات
  const bundleVariantIdsToFetch = new Set<number>();
  for (const r of rows) {
    if (r.notes && (r.notes.includes("حزمة") || r.notes.includes("بكج") || /BND-/i.test(r.notes))) {
      const match = r.notes.match(/(?:بكج\s*(?:#|رقم\s*)|\(#)(\d+)/);
      if (match && match[1]) {
        bundleVariantIdsToFetch.add(Number(match[1]));
      }
    }
  }

  const bundleNamesMap = new Map<number, string>();
  if (bundleVariantIdsToFetch.size > 0) {
    const bundleRows = await db
      .select({
        variantId: productVariants.id,
        productName: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, Array.from(bundleVariantIdsToFetch)));
    for (const b of bundleRows) {
      bundleNamesMap.set(Number(b.variantId), b.productName);
    }
  }

  const enrichedRows = rows.map((r: any) => {
    const outs = outputsByOrder.get(Number(r.id)) ?? [];
    const totalOutQty = outs.reduce((sum, o) => sum + o.baseQuantity, 0);
    const primaryOut = outs[0] ?? null;

    let bundleInfo: {
      isBundlePart: boolean;
      bundleVariantId?: number;
      bundleName?: string;
      groupRef?: string;
    } | null = null;

    let multiRecipeInfo: {
      isMultiRecipe: boolean;
      groupRef?: string;
    } | null = null;

    const notes = r.notes as string | null | undefined;
    if (notes) {
      const bndRefMatch = notes.match(/BND-\d+-\d+-[a-f0-9]+/i);
      const bndVarMatch = (notes.includes("حزمة") || notes.includes("بكج") || bndRefMatch)
        ? notes.match(/(?:بكج\s*(?:#|رقم\s*)|\(#)(\d+)/)
        : null;
      const bndNameInlineMatch = notes.match(/بكج:\s*([^\(\]\[\n\r]+)/);

      if (bndRefMatch || bndVarMatch || notes.includes("لحزمة بكج")) {
        const vId = bndVarMatch ? Number(bndVarMatch[1]) : undefined;
        const nameFromMap = vId ? bundleNamesMap.get(vId) : undefined;
        const nameFromInline = bndNameInlineMatch ? bndNameInlineMatch[1].trim() : undefined;
        bundleInfo = {
          isBundlePart: true,
          bundleVariantId: vId,
          bundleName: nameFromMap || nameFromInline || undefined,
          groupRef: bndRefMatch ? bndRefMatch[0] : undefined,
        };
      }

      const mltRefMatch = notes.match(/MLT-\d+-\d+-[a-f0-9]+/i);
      if (mltRefMatch || notes.includes("إنتاج متعدد")) {
        multiRecipeInfo = {
          isMultiRecipe: true,
          groupRef: mltRefMatch ? mltRefMatch[0] : undefined,
        };
      }
    }

    return {
      ...r,
      outputQty: totalOutQty,
      outputs: outs,
      outputCount: outs.length,
      primaryProductName: primaryOut?.productName ?? r.recipeOutputProductName ?? null,
      primaryVariantName: primaryOut?.variantName ?? r.recipeOutputVariantName ?? null,
      primarySku: primaryOut?.sku ?? r.recipeOutputSku ?? null,
      primaryUnitName: primaryOut?.unitName ?? null,
      recipeName: r.recipeName ?? null,
      bundleInfo,
      multiRecipeInfo,
    };
  });

  return { rows: enrichedRows, hasMore };
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
        materialSubstitutions: z.array(materialSubstitutionItemSchema).nullish(),
      })
    )
    .query(({ input, ctx }) => {
      // عزل مدير الفرع (قرار المالك ١٢/٨) — كان هذا المسار يمرّر branchId خامّاً، فيكشف
      // **أرصدة فرعٍ آخر** في أشرطة المتاح لمدير فرعٍ يبدّل الرقم بطلبٍ مباشر. نفس تعبير
      // `elevated` المستعمل في list/create أعلاه كي لا تنحرف السياسة داخل الراوتر الواحد.
      const elevated = ctx.user.role === "admin";
      const branchId = elevated
        ? Number(input.branchId ?? ctx.user.branchId ?? 0) || null
        : Number(ctx.user.branchId ?? 0) || null;
      return runPreview({ ...input, branchId });
    }),

  /**
   * سقفُ الإنتاج الممكن الآن + المضاعف المطلوب — **لا يأخذ دفعةً ولا يرمي عليها**.
   * `runPreview` يرمي عند أوّل دفعةٍ غير صالحة، فيعجز عن قول «كم أستطيع؟» في اللحظة
   * التي يُسأل فيها. هذا المسار يُجيب دائماً كي لا تبقى الشاشة بلا رقمٍ تقترحه.
   */
  recipeCapacity: inventoryManagerProcedure
    .input(
      z.object({
        recipeId: z.number().int().positive(),
        // يُحترَم للأدمن وحده (اختيار فرعٍ صريح)؛ غيرُه مقصورٌ بفرعه المُسنَد مهما أرسل.
        branchId: z.number().int().positive().optional(),
      })
    )
    .query(({ input, ctx }) => {
      const elevated = ctx.user.role === "admin";
      const branchId = elevated
        ? Number(input.branchId ?? ctx.user.branchId ?? 0)
        : Number(ctx.user.branchId ?? 0);
      if (!branchId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لا فرع مُسنَد لحسابك",
            why: "المستخدم الحالي لا يملك فرعاً مسنداً ولم يتم تمرير معرّف الفرع",
            doThis: "اختر الفرع أولاً من شاشة العمل ثم أعد المحاولة",
          }),
        });
      }
      return recipeCapacity({ recipeId: input.recipeId, branchId });
    }),

  create: inventoryManagerProcedure
    .input(
      z.object({
        // م٤ (الاستنتاج قبل السؤال): اختياريّ — يُشتقّ من الفاعل حين يغيب؛ الأدمن يمرّره لفرعٍ
        // آخر بقصدٍ صريح، وغيرُه يُثبَّت على فرعه مهما أرسل.
        branchId: z.number().int().positive().optional(),
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
      const assignedBranchId = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
      if (!elevated && assignedBranchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "لا فرع مُسنَد لهذا المستخدم",
            why: "المستخدم الحالي لا يملك صلاحية عابرة للفروع ولا يملك فرعاً مسنداً لحسابه",
            doThis: "اطلب من مدير النظام إسناد فرع لحسابك قبل تشغيل أمر الإنتاج",
          }),
        });
      }
      const effectiveBranchId = elevated ? (input.branchId ?? assignedBranchId) : assignedBranchId;
      if (effectiveBranchId == null) {
        // أدمنٌ بلا فرعٍ مُسنَد لم يُرسل فرعاً: لا فرعَ افتراضيّ (حارس check:branch) — اختيارٌ صريح.
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر تحديد فرع الإنتاج",
            why: "حسابك بلا فرعٍ مُسنَد ولم تُرسل الشاشة فرعاً",
            doThis: "اختر الفرع من القائمة في شاشة الإنتاج ثم أعِد الترحيل",
          }),
        });
      }
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
                branchId: effectiveBranchId,
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
          failOpaque(e, {
            op: "production.create",
            userMessage: "تعذّر إنشاء مستند الإنتاج",
            context: { userId: ctx.user.id },
          });
        }
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إنشاء مستند الإنتاج",
          why: "حدث تعارض متكرر في قيد المعاملة أو تضارب في معالجة الطلب",
          doThis: "حدّث الصفحة وتحقق من قائمة مستندات الإنتاج قبل إعادة الإرسال",
        }),
      });
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

    /** وصفات الإنتاج المخزني الجاهزة للتشغيل فقط؛ وصفات الخدمة تبقى في القائمة الإدارية. */
    listRunnable: inventoryManagerProcedure.query(() => listRunnableRecipes()),

    get: inventoryManagerProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getRecipe(input.id)),

    /** بحث المواد الخام المتاحة للاستخدام في الوصفة لمنشئي ومعدلي الوصفات والمخزون */
    materials: inventoryManagerProcedure
      .input(
        z.object({
          query: z.string().optional(),
          limit: z.number().int().positive().max(200).default(100),
        }),
      )
      .query(({ input }) => listMaterialsForRecipe(input.query, input.limit)),

    /** وصفة منتج محدد (خدمة أو مادي) مع متغيّره الأساس ووحدته للعرض المباشر في بطاقة المنتج */
    forProduct: productsReadProcedure
      .input(z.object({ productId: z.number().int().positive() }))
      .query(({ input }) => getRecipeForProduct(input.productId)),

    /** اقتراحات تنبؤية للوصفات المشابهة بناءً على الصنف والاسم وتطابق الكلمات الدلالية */
    suggestSimilar: productsReadProcedure
      .input(
        z.object({
          productId: z.number().int().positive(),
          limit: z.number().int().min(1).max(20).optional(),
        }),
      )
      .query(({ input }) => suggestSimilarRecipes(input.productId, input.limit)),

    /** قائمة وبحث الوصفات المتاحة للاستيراد كقالب تشغيلي */
    listForImport: productsReadProcedure
      .input(
        z.object({
          query: z.string().optional(),
          excludeProductId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      )
      .query(({ input }) => listRecipesForImport(input)),

    /** فحص فوري لتوفر مواد الوصفة في مخزن الفرع وحساب الطاقة الإنتاجية الفورية */
    checkStockAvailability: productsReadProcedure
      .input(
        z.object({
          branchId: z.number().int().positive().nullish(),
          lines: z.array(
            z.object({
              inputVariantId: z.number().int().positive(),
              qtyPerOutputBase: z.string(),
            }),
          ),
        }),
      )
      .query(({ input, ctx }) => {
        const elevated = ctx.user.role === "admin";
        const effectiveBranchId = elevated
          ? Number(input.branchId ?? ctx.user.branchId ?? 0) || null
          : Number(ctx.user.branchId ?? 0) || null;
        return checkRecipeMaterialsAvailability({ branchId: effectiveBranchId ?? 0, lines: input.lines });
      }),

    create: inventoryManagerProcedure.input(recipeInput).mutation(async ({ input, ctx }) => {
      try {
        const res = await createRecipe(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
        await logAudit(ctx, { action: "production.recipe.create", entityType: "productionRecipe", entityId: res.recipeId, newValue: { name: input.name } });
        return res;
      } catch (e: any) {
        if (isDupEntry(e)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "اسم الوصفة مستعمل سلفاً",
              why: "توجد وصفة إنتاج مسجلة مسبقاً بنفس هذا الاسم",
              doThis: "اختر اسماً مميزاً للوصفة ثم أعد الحفظ",
            }),
          });
        }
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
        if (isDupEntry(e)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "اسم الوصفة مستعمل سلفاً",
              why: "توجد وصفة إنتاج مسجلة مسبقاً بنفس هذا الاسم",
              doThis: "اختر اسماً مميزاً للوصفة ثم أعد الحفظ",
            }),
          });
        }
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

    /** استبدال مادة خام ببديل مع الحفظ الذري للوصفة وإعادة حساب تكاليف البكجات (مقصور على دور مدير فأعلى). */
    substituteMaterial: inventoryManagerProcedure
      .input(substituteRecipeMaterialInputSchema)
      .mutation(async ({ input, ctx }) => {
        const userRole = String(ctx.user.role ?? "").toUpperCase();
        if (!["ADMIN", "MANAGER"].includes(userRole)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "غير مصرح باعتماد تعديل الوصفة الدائم",
              why: "تحديث شجرة المواد الدائمة في الوصفة مقصور على دور مدير فأعلى لحماية التكاليف والتسعير",
              doThis: "استخدم الاستبدال المؤقت للدفعة الحالية فقط، أو اطلب من مدير النظام اعتماد التعديل",
            }),
          });
        }
        const res = await substituteRecipeMaterial(input, {
          userId: ctx.user.id,
          role: ctx.user.role,
          branchId: ctx.user.branchId ?? null,
        });
        await logAudit(ctx, {
          action: "production.recipe.substitute_material",
          entityType: "productionRecipe",
          entityId: res.recipeId,
          newValue: {
            originalVariantId: input.originalVariantId,
            substituteVariantId: input.substituteVariantId,
            qtyPerOutputBase: res.qtyPerOutputBase,
            reason: input.reason ?? "استبدال مادة نافذة",
          },
        });
        return res;
      }),

    /** معاينة وصفة لكمية ناتج ⇒ أسطر جاهزة للنموذج (بلا حركة مخزون). */
    preview: inventoryManagerProcedure
      .input(z.object({ recipeId: z.number().int().positive(), outputQuantity: z.string(), branchId: z.number().int().positive().nullish() }))
      .query(({ input, ctx }) => {
        const elevated = ctx.user.role === "admin";
        const branchId = elevated
          ? Number(input.branchId ?? ctx.user.branchId ?? 0) || null
          : Number(ctx.user.branchId ?? 0) || null;
        return recipePreview({ recipeId: input.recipeId, outputQuantity: input.outputQuantity, branchId });
      }),

    analyzeMultiRecipe: inventoryManagerProcedure
      .input(analyzeMultiRecipeRequirementsInputSchema)
      .query(async ({ input, ctx }) => {
        const elevated = ctx.user.role === "admin";
        const assignedBranchId = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
        if (!elevated && assignedBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا فرع مُسنَد لهذا المستخدم",
              why: "المستخدم الحالي لا يملك صلاحية عابرة للفروع ولا يملك فرعاً مسنداً لحسابه",
              doThis: "اطلب من مدير النظام إسناد فرع لحسابك قبل تشغيل أمر التحليل",
            }),
          });
        }
        const effectiveBranchId = elevated ? (input.branchId ?? assignedBranchId) : assignedBranchId;
        if (effectiveBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر تحديد فرع الإنتاج",
              why: "حسابك بلا فرعٍ مُسنَد ولم تُرسل الشاشة فرعاً",
              doThis: "اختر الفرع من القائمة في شاشة الإنتاج ثم أعِد المحاولة",
            }),
          });
        }
        return analyzeMultiRecipeRequirements({
          ...input,
          branchId: effectiveBranchId,
        });
      }),

    produceMultiRecipe: inventoryManagerProcedure
      .input(produceMultiRecipeInputSchema)
      .mutation(async ({ input, ctx }) => {
        const elevated = ctx.user.role === "admin";
        const assignedBranchId = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
        if (!elevated && assignedBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا فرع مُسنَد لهذا المستخدم",
              why: "المستخدم الحالي لا يملك صلاحية عابرة للفروع ولا يملك فرعاً مسنداً لحسابه",
              doThis: "اطلب من مدير النظام إسناد فرع لحسابك قبل تشغيل أمر الإنتاج",
            }),
          });
        }
        const effectiveBranchId = elevated ? (input.branchId ?? assignedBranchId) : assignedBranchId;
        if (effectiveBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر تحديد فرع الإنتاج",
              why: "حسابك بلا فرعٍ مُسنَد ولم تُرسل الشاشة فرعاً",
              doThis: "اختر الفرع من القائمة في شاشة الإنتاج ثم أعِد الترحيل",
            }),
          });
        }
        const res = await produceMultiRecipeBatches(
          {
            ...input,
            branchId: effectiveBranchId,
          },
          { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role }
        );
        await logAudit(ctx, {
          action: "production.multi_recipe.produce",
          entityType: "productionOrder",
          entityId: res.orders[0]?.productionOrderId ?? 0,
          newValue: {
            multiRecipeDocGroupRef: res.multiRecipeDocGroupRef,
            orderCount: res.orders.length,
            totalCost: res.totalCostAllOrders,
          },
        });
        return res;
      }),
  }),

  // ───────────────────────── إنتاج مكونات البكج ─────────────────────────
  bundles: router({
    list: inventoryManagerProcedure.query(async () => {
      const db = getDb();
      if (!db) return [];
      return db
        .select({
          bundleVariantId: productVariants.id,
          productId: products.id,
          name: products.name,
          sku: productVariants.sku,
          costPrice: productVariants.costPrice,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(
          and(
            eq(products.isBundle, true),
            eq(products.isActive, true),
            eq(productVariants.isActive, true),
          ),
        )
        .orderBy(asc(products.name));
    }),

    analyzeRequirements: inventoryManagerProcedure
      .input(analyzeBundleRequirementsInputSchema)
      .query(async ({ input, ctx }) => {
        const elevated = ctx.user.role === "admin";
        const assignedBranchId = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
        if (!elevated && assignedBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا فرع مُسنَد لهذا المستخدم",
              why: "المستخدم الحالي لا يملك صلاحية عابرة للفروع ولا يملك فرعاً مسنداً لحسابه",
              doThis: "اطلب من مدير النظام إسناد فرع لحسابك قبل تشغيل أمر التحليل",
            }),
          });
        }
        const effectiveBranchId = elevated ? (input.branchId ?? assignedBranchId) : assignedBranchId;
        if (effectiveBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر تحديد فرع الإنتاج",
              why: "حسابك بلا فرعٍ مُسنَد ولم تُرسل الشاشة فرعاً",
              doThis: "اختر الفرع من القائمة في شاشة الإنتاج ثم أعِد المحاولة",
            }),
          });
        }
        return analyzeBundleRequirements({
          ...input,
          branchId: effectiveBranchId,
        });
      }),

    produceComponents: inventoryManagerProcedure
      .input(produceBundleComponentsInputSchema)
      .mutation(async ({ input, ctx }) => {
        const elevated = ctx.user.role === "admin";
        const assignedBranchId = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
        if (!elevated && assignedBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا فرع مُسنَد لهذا المستخدم",
              why: "المستخدم الحالي لا يملك صلاحية عابرة للفروع ولا يملك فرعاً مسنداً لحسابه",
              doThis: "اطلب من مدير النظام إسناد فرع لحسابك قبل تشغيل أمر الإنتاج",
            }),
          });
        }
        const effectiveBranchId = elevated ? (input.branchId ?? assignedBranchId) : assignedBranchId;
        if (effectiveBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر تحديد فرع الإنتاج",
              why: "حسابك بلا فرعٍ مُسنَد ولم تُرسل الشاشة فرعاً",
              doThis: "اختر الفرع من القائمة في شاشة الإنتاج ثم أعِد الترحيل",
            }),
          });
        }
        const res = await produceBundleComponents(
          {
            ...input,
            branchId: effectiveBranchId,
          },
          { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role }
        );
        await logAudit(ctx, {
          action: "production.bundle.produce",
          entityType: "bundle",
          entityId: input.bundleVariantId,
          newValue: {
            bundleDocGroupRef: res.bundleDocGroupRef,
            orderCount: res.orders.length,
            totalCost: res.totalCostAllOrders,
          },
        });
        return res;
      }),
  }),
});
