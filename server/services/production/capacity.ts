/**
 * capacity — «كم أستطيع أن أُنتج الآن؟» جواباً صريحاً من الخادم، لا استنتاجاً من الشاشة.
 *
 * ## لماذا endpoint مستقلّ عن `runPreview`
 * `runPreview` يُجيب عن سؤالٍ آخر: «هل هذه الدفعة **بعينها** صالحة؟» — ولذلك **يرمي** عند
 * أوّل مخالفة (استهلاك كسريّ، وصفة معطّلة…). فهو عاجزٌ بنيوياً عن إخبارك بالحدّ الممكن حين
 * تكون دفعتك الحالية غير صالحة — وهي **بالضبط** اللحظة التي تحتاج فيها الجواب.
 * هذه الدالّة لا ترمي على دفعةٍ إطلاقاً: لا تأخذ دفعةً أصلاً، بل تحسب السقف والمضاعف معاً.
 *
 * ## السقف مقيَّدان لا قيدٌ واحد
 *  ١) **الكفاية**: أقلّ `المتاح ÷ معامل المكوّن` عبر كل المكوّنات (المكوّن الحادّ يُسمّى).
 *  ٢) **القابلية للقسمة**: السقف يُقصّ إلى أكبر مضاعفٍ صالح (`shared/batchDivisibility`).
 * وخلطُهما هو ما أربك المالك: مواد وافرة + دفعة مرفوضة. فالنتيجة تفصّلهما صراحةً
 * (`maxByStock` مقابل `maxBatch`) كي يُقرأ السببان منفصلَين.
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  branchStock,
  productUnits,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
} from "../../../drizzle/schema";
import { batchMultipleNote, largestValidBatchAtMost, requiredBatchMultiple } from "../../../shared/batchDivisibility";
import { withTx } from "../tx";

export interface RecipeCapacityComponent {
  variantId: number;
  productName: string | null;
  sku: string | null;
  /** معامل الوصفة: كم وحدة أساس من هذا المكوّن لكل وحدة ناتج. */
  perOutputBase: string;
  /** المتاح في الفرع بالوحدة الأساس. */
  available: number;
  /** أقصى دفعة يسمح بها هذا المكوّن وحده (قبل قصّ المضاعف). */
  maxBatchFromThis: number;
  /** هل هذا المكوّن هو الحادّ (المحدِّد للسقف)؟ */
  isLimiting: boolean;
  /** المضاعف الذي يفرضه معامِل هذا المكوّن وحده (1 = لا قيد). */
  batchMultiple: number;
}

export interface RecipeCapacityResult {
  recipeId: number;
  recipeName: string | null;
  isActive: boolean;
  outputName: string | null;
  outputUnitName: string | null;
  /** المضاعف المطلوب للوصفة كاملةً — الدفعة يجب أن تكون من مضاعفاته. */
  batchMultiple: number;
  /** جملة عربية جاهزة تشرح القيد، أو null حين لا قيد. */
  batchMultipleNote: string | null;
  /** السقف الذي يسمح به المخزون وحده (بلا قصّ على المضاعف). */
  maxByStock: number;
  /** ⭐ الأقصى القابل للإنتاج فعلاً = `maxByStock` مقصوصاً على المضاعف. */
  maxBatch: number;
  /** اسم المكوّن الذي يحدّ السقف — كي يعرف المستعمل ماذا يشتري. */
  limitingComponent: string | null;
  components: RecipeCapacityComponent[];
}

export async function recipeCapacity(args: {
  recipeId: number;
  branchId: number;
}): Promise<RecipeCapacityResult> {
  return withTx(async (tx) => {
    const head = (
      await tx
        .select({
          id: productionRecipes.id,
          name: productionRecipes.name,
          isActive: productionRecipes.isActive,
          outputName: products.name,
          outputUnitName: productUnits.unitName,
        })
        .from(productionRecipes)
        .leftJoin(productVariants, eq(productionRecipes.outputVariantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(productUnits, eq(productionRecipes.outputProductUnitId, productUnits.id))
        .where(eq(productionRecipes.id, args.recipeId))
        .limit(1)
    )[0];
    if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });

    const recLines = await tx
      .select({
        inputVariantId: productionRecipeLines.inputVariantId,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
        productName: products.name,
        sku: productVariants.sku,
      })
      .from(productionRecipeLines)
      .leftJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productionRecipeLines.recipeId, args.recipeId))
      .orderBy(productionRecipeLines.id);

    const coefficients = recLines.map((l: any) => String(l.qtyPerOutputBase));
    const multiple = requiredBatchMultiple(coefficients);

    // وصفةٌ بلا مكوّنات لا تُنتِج شيئاً — تُعلَن صفراً بدل سقفٍ لا نهائيّ كاذب.
    if (!recLines.length) {
      return {
        recipeId: Number(head.id), recipeName: head.name ?? null, isActive: !!head.isActive,
        outputName: head.outputName ?? null, outputUnitName: head.outputUnitName ?? null,
        batchMultiple: 1, batchMultipleNote: null,
        maxByStock: 0, maxBatch: 0, limitingComponent: null, components: [],
      };
    }

    const inVarIds = Array.from(new Set(recLines.map((l: any) => Number(l.inputVariantId))));
    const availMap = new Map<number, number>();
    const stockRows = await tx
      .select({ variantId: branchStock.variantId, qty: branchStock.quantity })
      .from(branchStock)
      .where(and(inArray(branchStock.variantId, inVarIds), eq(branchStock.branchId, args.branchId)));
    // صفٌّ غائب = رصيد صفر (لا «غير معلوم») — الصنف الذي لم يدخل الفرع قطّ يحدّ السقف بصفر.
    for (const s of stockRows) availMap.set(Number(s.variantId), Number(s.qty));

    let maxByStock = Number.POSITIVE_INFINITY;
    const raw = recLines.map((l: any) => {
      const variantId = Number(l.inputVariantId);
      const perOut = new Decimal(l.qtyPerOutputBase);
      const available = Math.max(0, availMap.get(variantId) ?? 0);
      // معامِلٌ ≤ 0 لا يقيّد شيئاً (لا يُستهلك) — لا يُدخِل قسمةً على صفر.
      const maxFromThis = perOut.gt(0)
        ? Math.floor(new Decimal(available).div(perOut).toNumber())
        : Number.POSITIVE_INFINITY;
      if (maxFromThis < maxByStock) maxByStock = maxFromThis;
      return {
        variantId,
        productName: l.productName ?? null,
        sku: l.sku ?? null,
        perOutputBase: perOut.toString(),
        available,
        maxBatchFromThis: maxFromThis,
        batchMultiple: requiredBatchMultiple([String(l.qtyPerOutputBase)]),
      };
    });

    const stockCap = Number.isFinite(maxByStock) ? Math.max(0, maxByStock) : 0;
    const components: RecipeCapacityComponent[] = raw.map((c) => ({
      ...c,
      maxBatchFromThis: Number.isFinite(c.maxBatchFromThis) ? c.maxBatchFromThis : 0,
      isLimiting: c.maxBatchFromThis === maxByStock,
    }));
    const limiting = components.find((c) => c.isLimiting) ?? null;

    return {
      recipeId: Number(head.id),
      recipeName: head.name ?? null,
      isActive: !!head.isActive,
      outputName: head.outputName ?? null,
      outputUnitName: head.outputUnitName ?? null,
      batchMultiple: multiple,
      batchMultipleNote: batchMultipleNote(multiple),
      maxByStock: stockCap,
      maxBatch: largestValidBatchAtMost(stockCap, multiple),
      limitingComponent: limiting?.productName ?? null,
      components,
    };
  });
}
