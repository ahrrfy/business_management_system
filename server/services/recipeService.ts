/**
 * recipeService — وصفات/معايير الإنتاج: تعريف ثابت لمنتج متكرّر (ملزمة/كتاب).
 *
 * المكوّنات تُعرّف **لكل وحدة ناتج أساس واحدة** (مثلاً 30 ورقة/ملزمة). عند طلب إنتاج كمية Q:
 *   outputBase = convertToBaseQuantity(outputUnit, Q)
 *   inputBase  = qtyPerOutputBase × outputBase   (يجب أن يكون عدداً صحيحاً)
 * `recipePreview` يحسب الأسطر الجاهزة (مدخلات + مخرَج) + الكلفة الحيّة ⇒ يملأ نموذج الإنتاج.
 * الترحيل يمرّ بـ`createProduction` نفسه (مسار طفرة واحد آمن) مع linkedRecipeId.
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  branchStock,
  productUnits,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
} from "../../drizzle/schema";
import { convertToBaseQuantity } from "./inventoryService";
import { money, round2 } from "./money";
import { withTx, type Actor } from "./tx";

export interface RecipeLineInput {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  qtyPerOutputBase: string;
  notes?: string | null;
}

export interface CreateRecipeInput {
  name: string;
  outputVariantId: number;
  outputProductUnitId: number;
  laborPerOutputBase?: string | null;
  notes?: string | null;
  lines: RecipeLineInput[];
}

function validateRecipeShape(input: CreateRecipeInput) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الوصفة مطلوب" });
  if (!input.outputVariantId || !input.outputProductUnitId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد المنتج الناتج ووحدته" });
  }
  if (!input.lines?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد مكوّناً واحداً على الأقل" });
  for (const l of input.lines) {
    if (!l.inputVariantId) throw new TRPCError({ code: "BAD_REQUEST", message: "صنف مكوّن غير صالح" });
    if (l.inputVariantId === input.outputVariantId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج الناتج لا يكون مكوّناً من نفسه" });
    }
    if (money(l.qtyPerOutputBase).lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "كمية المكوّن لكل وحدة يجب أن تكون موجبة" });
    }
  }
  return name;
}

/** قائمة الوصفات (اسم المنتج الناتج + عدّاد المكوّنات). */
export async function listRecipes(opts: { activeOnly?: boolean } = {}) {
  return withTx(async (tx) => {
    const where = opts.activeOnly ? eq(productionRecipes.isActive, true) : undefined;
    const rows = await tx
      .select({
        id: productionRecipes.id,
        name: productionRecipes.name,
        outputVariantId: productionRecipes.outputVariantId,
        outputProductName: products.name,
        outputSku: productVariants.sku,
        outputUnitName: productUnits.unitName,
        laborPerOutputBase: productionRecipes.laborPerOutputBase,
        isActive: productionRecipes.isActive,
        createdAt: productionRecipes.createdAt,
      })
      .from(productionRecipes)
      .leftJoin(productVariants, eq(productionRecipes.outputVariantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(productionRecipes.outputProductUnitId, productUnits.id))
      .where(where as any)
      .orderBy(desc(productionRecipes.id));
    return rows.map((r: any) => ({ ...r, isActive: Boolean(r.isActive) }));
  });
}

/** تفاصيل وصفة + مكوّناتها بأسماء الأصناف. */
export async function getRecipe(id: number) {
  return withTx(async (tx) => {
    const head = (
      await tx
        .select({
          id: productionRecipes.id,
          name: productionRecipes.name,
          outputVariantId: productionRecipes.outputVariantId,
          outputProductUnitId: productionRecipes.outputProductUnitId,
          outputProductName: products.name,
          outputSku: productVariants.sku,
          outputUnitName: productUnits.unitName,
          laborPerOutputBase: productionRecipes.laborPerOutputBase,
          notes: productionRecipes.notes,
          isActive: productionRecipes.isActive,
        })
        .from(productionRecipes)
        .leftJoin(productVariants, eq(productionRecipes.outputVariantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(productUnits, eq(productionRecipes.outputProductUnitId, productUnits.id))
        .where(eq(productionRecipes.id, id))
        .limit(1)
    )[0];
    if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    const lines = await tx
      .select({
        id: productionRecipeLines.id,
        inputVariantId: productionRecipeLines.inputVariantId,
        inputProductUnitId: productionRecipeLines.inputProductUnitId,
        inputProductName: products.name,
        inputSku: productVariants.sku,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
        notes: productionRecipeLines.notes,
      })
      .from(productionRecipeLines)
      .leftJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productionRecipeLines.recipeId, id))
      .orderBy(productionRecipeLines.id);
    return { ...head, isActive: Boolean(head.isActive), lines };
  });
}

/** إنشاء وصفة + مكوّناتها (الاسم فريد على مستوى القاعدة ⇒ ER_DUP_ENTRY عند التكرار). */
export async function createRecipe(input: CreateRecipeInput, actor: Actor) {
  return withTx(async (tx) => {
    const name = validateRecipeShape(input);
    // وجود الأصناف.
    const varIds = Array.from(new Set([input.outputVariantId].concat(input.lines.map((l) => l.inputVariantId))));
    const existing = await tx.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, varIds));
    const existSet = new Set(existing.map((v: any) => Number(v.id)));
    for (const id of varIds) if (!existSet.has(id)) throw new TRPCError({ code: "NOT_FOUND", message: `صنف #${id} غير موجود` });

    const insRes = await tx.insert(productionRecipes).values({
      name,
      outputVariantId: input.outputVariantId,
      outputProductUnitId: input.outputProductUnitId,
      laborPerOutputBase: round2(money(input.laborPerOutputBase ?? "0")).toFixed(2),
      notes: input.notes?.trim() || null,
      isActive: true,
      createdBy: actor.userId,
    });
    const recipeId = Number((insRes as any)[0]?.insertId ?? (insRes as any).insertId);
    for (const l of input.lines) {
      await tx.insert(productionRecipeLines).values({
        recipeId,
        inputVariantId: l.inputVariantId,
        inputProductUnitId: l.inputProductUnitId ?? null,
        qtyPerOutputBase: money(l.qtyPerOutputBase).toFixed(4),
        notes: l.notes?.trim() || null,
      });
    }
    return { recipeId };
  });
}

/** تحديث وصفة + استبدال مكوّناتها بالكامل. */
export async function updateRecipe(id: number, input: CreateRecipeInput) {
  return withTx(async (tx) => {
    const ex = (await tx.select({ id: productionRecipes.id }).from(productionRecipes).where(eq(productionRecipes.id, id)).limit(1))[0];
    if (!ex) throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    const name = validateRecipeShape(input);
    const varIds = Array.from(new Set([input.outputVariantId].concat(input.lines.map((l) => l.inputVariantId))));
    const existing = await tx.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, varIds));
    const existSet = new Set(existing.map((v: any) => Number(v.id)));
    for (const vid of varIds) if (!existSet.has(vid)) throw new TRPCError({ code: "NOT_FOUND", message: `صنف #${vid} غير موجود` });

    await tx
      .update(productionRecipes)
      .set({
        name,
        outputVariantId: input.outputVariantId,
        outputProductUnitId: input.outputProductUnitId,
        laborPerOutputBase: round2(money(input.laborPerOutputBase ?? "0")).toFixed(2),
        notes: input.notes?.trim() || null,
      })
      .where(eq(productionRecipes.id, id));
    await tx.delete(productionRecipeLines).where(eq(productionRecipeLines.recipeId, id));
    for (const l of input.lines) {
      await tx.insert(productionRecipeLines).values({
        recipeId: id,
        inputVariantId: l.inputVariantId,
        inputProductUnitId: l.inputProductUnitId ?? null,
        qtyPerOutputBase: money(l.qtyPerOutputBase).toFixed(4),
        notes: l.notes?.trim() || null,
      });
    }
    return { recipeId: id };
  });
}

export async function setRecipeActive(id: number, active: boolean) {
  return withTx(async (tx) => {
    const ex = (await tx.select({ id: productionRecipes.id }).from(productionRecipes).where(eq(productionRecipes.id, id)).limit(1))[0];
    if (!ex) throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    await tx.update(productionRecipes).set({ isActive: active }).where(eq(productionRecipes.id, id));
    return { ok: true as const };
  });
}

export async function deleteRecipe(id: number) {
  return withTx(async (tx) => {
    await tx.delete(productionRecipes).where(eq(productionRecipes.id, id));
    return { ok: true as const };
  });
}

export interface RecipePreviewResult {
  recipeId: number;
  outputVariantId: number;
  outputProductUnitId: number;
  outputName: string | null;
  outputBase: number;
  laborCost: string;
  materialsCost: string;
  totalCost: string;
  inputs: Array<{
    variantId: number;
    productName: string | null;
    sku: string | null;
    baseQuantity: number;
    unitCost: string;
    lineCost: string;
    available: number | null;
  }>;
}

/**
 * معاينة وصفة لكمية ناتج معيّنة ⇒ أسطر جاهزة لنموذج الإنتاج (بلا أي حركة مخزون).
 * يفرض أن استهلاك كل مكوّن المُحجَّم عدد صحيح، ويلتقط الكلفة الحيّة من costPrice،
 * والمتاح من رصيد الفرع (إن مُرِّر branchId) لتحذير «المتاح N» اللّيّن في الواجهة.
 */
export async function recipePreview(args: { recipeId: number; outputQuantity: string; branchId?: number | null }): Promise<RecipePreviewResult> {
  return withTx(async (tx) => {
    const head = (
      await tx
        .select({
          id: productionRecipes.id,
          name: productionRecipes.name,
          outputVariantId: productionRecipes.outputVariantId,
          outputProductUnitId: productionRecipes.outputProductUnitId,
          outputName: products.name,
          laborPerOutputBase: productionRecipes.laborPerOutputBase,
          isActive: productionRecipes.isActive,
        })
        .from(productionRecipes)
        .leftJoin(productVariants, eq(productionRecipes.outputVariantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productionRecipes.id, args.recipeId))
        .limit(1)
    )[0];
    if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    if (!head.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة معطّلة" });

    const conv = await convertToBaseQuantity(tx, Number(head.outputProductUnitId), args.outputQuantity, Number(head.outputVariantId));
    const outputBase = conv.baseQuantity;

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
    if (!recLines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة بلا مكوّنات" });

    const inVarIds = Array.from(new Set(recLines.map((l: any) => Number(l.inputVariantId))));
    const costRows = await tx
      .select({ id: productVariants.id, costPrice: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, inVarIds));
    const costMap = new Map(costRows.map((v: any) => [Number(v.id), v.costPrice]));

    // المتاح بالفرع (إن وُجد) للتحذير اللّيّن.
    const availMap = new Map<number, number>();
    if (args.branchId) {
      const stockRows = await tx
        .select({ variantId: branchStock.variantId, qty: branchStock.quantity })
        .from(branchStock)
        .where(and(inArray(branchStock.variantId, inVarIds), eq(branchStock.branchId, args.branchId)));
      for (const s of stockRows) availMap.set(Number(s.variantId), Number(s.qty));
    }

    let materialsCost = new Decimal(0);
    const inputs = recLines.map((l: any) => {
      const perOut = new Decimal(l.qtyPerOutputBase);
      const baseDec = perOut.times(outputBase);
      if (!baseDec.isInteger()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `استهلاك المكوّن «${l.productName ?? l.inputVariantId}» الناتج (${baseDec.toString()}) ليس عدداً صحيحاً — عدّل الكمية أو الوصفة`,
        });
      }
      const baseQuantity = baseDec.toNumber();
      const unitCost = round2(money(costMap.get(Number(l.inputVariantId)) ?? "0"));
      const lineCost = round2(unitCost.times(baseQuantity));
      materialsCost = materialsCost.plus(lineCost);
      return {
        variantId: Number(l.inputVariantId),
        productName: l.productName ?? null,
        sku: l.sku ?? null,
        baseQuantity,
        unitCost: unitCost.toFixed(2),
        lineCost: lineCost.toFixed(2),
        available: availMap.has(Number(l.inputVariantId)) ? availMap.get(Number(l.inputVariantId))! : null,
      };
    });

    materialsCost = round2(materialsCost);
    const laborCost = round2(money(head.laborPerOutputBase ?? "0").times(outputBase));
    const totalCost = round2(materialsCost.plus(laborCost));

    return {
      recipeId: Number(head.id),
      outputVariantId: Number(head.outputVariantId),
      outputProductUnitId: Number(head.outputProductUnitId),
      outputName: head.outputName ?? null,
      outputBase,
      laborCost: laborCost.toFixed(2),
      materialsCost: materialsCost.toFixed(2),
      totalCost: totalCost.toFixed(2),
      inputs,
    };
  });
}
