// معاينة «التشغيل بوصفة» حيّةً (بلا أي حركة) — نفس صيغة الحساب وWAVG التي يطبّقها createProduction.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  branchStock,
  productUnits,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
} from "../../../drizzle/schema";
import { money, round2 } from "../money";
import { withTx } from "../tx";
import { computeRunCosts } from "./calc";
import type { RunPreviewResult } from "./types";

/**
 * معاينة «التشغيل بوصفة» حيّةً (بلا أي حركة): تستعمل نفس `computeRunCosts` و**نفس صيغة WAVG** التي يطبّقها
 * `createProduction` ⇒ ما تراه الشاشة = ما يُرحَّل بالضبط (أشرطة مخزون، تفريق الهدر، أثر WAVG قبل الترحيل).
 */
export async function runPreview(args: {
  recipeId: number;
  batchQty: string | number;
  scrapQty?: string | number | null;
  laborPerUnit?: string | null;
  branchId?: number | null;
}): Promise<RunPreviewResult> {
  return withTx(async (tx) => {
    const head = (
      await tx
        .select({
          id: productionRecipes.id,
          name: productionRecipes.name,
          outputVariantId: productionRecipes.outputVariantId,
          outputProductUnitId: productionRecipes.outputProductUnitId,
          outputName: products.name,
          outputSku: productVariants.sku,
          outputUnitName: productUnits.unitName,
          outputCost: productVariants.costPrice,
          laborPerOutputBase: productionRecipes.laborPerOutputBase,
          wasteStdPct: productionRecipes.wasteStdPct,
          isActive: productionRecipes.isActive,
        })
        .from(productionRecipes)
        .leftJoin(productVariants, eq(productionRecipes.outputVariantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(productUnits, eq(productionRecipes.outputProductUnitId, productUnits.id))
        .where(eq(productionRecipes.id, args.recipeId))
        .limit(1)
    )[0];
    if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    if (!head.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة معطّلة" });

    const batch = Math.max(0, Math.trunc(Number(args.batchQty) || 0));
    if (batch <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "عدد الدفعة يجب أن يكون موجباً" });
    const scrap = Math.min(Math.max(0, Math.trunc(Number(args.scrapQty ?? 0) || 0)), batch);
    const good = batch - scrap;
    if (good <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "السليم الناتج يجب أن يكون موجباً" });

    const recLines = await tx
      .select({
        inputVariantId: productionRecipeLines.inputVariantId,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
        productName: products.name,
        sku: productVariants.sku,
        costPrice: productVariants.costPrice, // التكلفة من نفس الانضمام (لا استعلام ثانٍ)
      })
      .from(productionRecipeLines)
      .leftJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productionRecipeLines.recipeId, args.recipeId))
      .orderBy(productionRecipeLines.id);
    if (!recLines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة بلا مكوّنات" });

    const inVarIds = Array.from(new Set(recLines.map((l: any) => Number(l.inputVariantId))));
    const costMap = new Map(recLines.map((l: any) => [Number(l.inputVariantId), l.costPrice]));

    // المتاح بالفرع (للأشرطة وحارس النقص اللّيّن في الواجهة).
    const availMap = new Map<number, number>();
    if (args.branchId) {
      const stockRows = await tx
        .select({ variantId: branchStock.variantId, qty: branchStock.quantity })
        .from(branchStock)
        .where(and(inArray(branchStock.variantId, inVarIds), eq(branchStock.branchId, args.branchId)));
      for (const s of stockRows) availMap.set(Number(s.variantId), Number(s.qty));
    }

    // الحساب النقي (نفس منطق الترحيل).
    const perUnit = args.laborPerUnit != null && String(args.laborPerUnit).trim() !== "" ? money(args.laborPerUnit) : money(head.laborPerOutputBase ?? "0");
    const calc = computeRunCosts({
      recipeLines: recLines.map((l: any) => ({ unitCost: round2(money(costMap.get(Number(l.inputVariantId)) ?? "0")), qtyPerOutputBase: new Decimal(l.qtyPerOutputBase) })),
      laborPerUnit: perUnit,
      wasteStdPct: money(head.wasteStdPct ?? "0"),
      batch,
      scrap,
    });

    const inputs = recLines.map((l: any) => {
      const perOut = new Decimal(l.qtyPerOutputBase);
      const consumedDec = perOut.times(calc.started);
      if (!consumedDec.isInteger()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `استهلاك «${l.productName ?? l.inputVariantId}» (${consumedDec.toString()}) ليس عدداً صحيحاً — عدّل الدفعة أو الوصفة` });
      }
      const consumed = consumedDec.toNumber();
      const unitCost = round2(money(costMap.get(Number(l.inputVariantId)) ?? "0"));
      const available = availMap.has(Number(l.inputVariantId)) ? availMap.get(Number(l.inputVariantId))! : null;
      return {
        variantId: Number(l.inputVariantId),
        productName: l.productName ?? null,
        sku: l.sku ?? null,
        perOutputBase: perOut.toString(),
        consumed,
        available,
        short: available != null && consumed > available,
        unitCost: unitCost.toFixed(2),
        lineCost: round2(unitCost.times(consumed)).toFixed(2),
      };
    });
    const anyShort = inputs.some((i) => i.short);

    // أثر WAVG على المخرَج: الرصيد العالمي القائم + كلفته الحالية (مطابق لمسار الترحيل).
    const sumRow = (
      await tx
        .select({ total: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)` })
        .from(branchStock)
        .where(eq(branchStock.variantId, Number(head.outputVariantId)))
    )[0];
    const oldQty = Math.max(0, Number(sumRow?.total ?? 0));
    const oldCost = money(head.outputCost ?? "0");
    const unitCost = money(calc.unitCost);
    const newQty = oldQty + good;
    const newCost = oldQty > 0 && oldCost.gt(0)
      ? round2(new Decimal(oldQty).times(oldCost).plus(new Decimal(good).times(unitCost)).div(newQty))
      : round2(unitCost);

    return {
      recipeId: Number(head.id),
      recipeName: head.name ?? null,
      outputVariantId: Number(head.outputVariantId),
      outputProductUnitId: Number(head.outputProductUnitId),
      outputName: head.outputName ?? null,
      outputSku: head.outputSku ?? null,
      outputUnitName: head.outputUnitName ?? null,
      batch: calc.started,
      good: calc.good,
      scrap: calc.scrapN,
      yieldPct: calc.yieldPct,
      wasteStdPct: money(head.wasteStdPct ?? "0").toString(),
      normalAllow: calc.normalAllow,
      abnormalUnits: calc.abnormalUnits,
      abnormalLoss: calc.abnormalLoss.toFixed(2),
      absorbedCost: calc.absorbedCost.toFixed(2),
      unitCost: calc.unitCost.toFixed(2),
      materialsCost: calc.materialsCost.toFixed(2),
      laborCost: calc.labor.toFixed(2),
      totalCost: calc.totalCost.toFixed(2),
      anyShort,
      inputs,
      wavg: { oldQty, oldCost: oldCost.toFixed(2), addQty: good, newQty, newCost: newCost.toFixed(2) },
    };
  });
}
