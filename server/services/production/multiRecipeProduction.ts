import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  branchStock,
  productUnits,
  productVariants,
  productionRecipeLines,
  productionRecipes,
  products,
} from "../../../drizzle/schema";
import { requiredBatchMultiple } from "../../../shared/batchDivisibility";
import type {
  AggregatedMultiRecipeMaterialDto,
  AnalyzeMultiRecipeRequirementsInput,
  MultiRecipeRequirementsAnalysisResult,
  ProduceMultiRecipeInput,
  ProduceMultiRecipeResult,
  RecipeRequirementItemDto,
  RecipeRequirementMaterialLineDto,
} from "../../../shared/multiRecipeProductionTypes";
import { syncBundlesContainingComponents } from "../bundleService";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import { ensureBranchStockRows } from "../inventoryService";
import { money, round2, toDateStr } from "../money";
import type { Actor } from "../tx";
import { withTx } from "../tx";
import { createProductionInTx } from "./create";

/**
 * تحليل احتياجات إنتاج وصفات متعددة دفعة واحدة:
 * - التحقق من وجود الوصفات ونشاطها وأهليتها للإنتاج المخزني.
 * - فحص قيد قابلية القسمة لكل وصفة (batch divisibility).
 * - حساب متطلبات المواد لكل وصفة وتجميعها شاملاً على مستوى الفرع.
 * - فحص رصيد الفرع وتحديد أي نواقص أو عوامل عنق زجاجة (bottleneck).
 * - تقدير تكاليف المواد والعمالة والإجمالي المتوقع.
 */
export async function analyzeMultiRecipeRequirements(
  input: AnalyzeMultiRecipeRequirementsInput & { branchId: number }
): Promise<MultiRecipeRequirementsAnalysisResult> {
  if (!input.items || input.items.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "قائمة الوصفات فارغة",
        why: "يجب اختيار وصفة واحدة على الأقل لتحليل متطلبات الإنتاج",
        doThis: "حدد وصفة واحدة أو أكثر من صفحة الوصفات ثم أعد المحاولة",
      }),
    });
  }

  const seenRecipes = new Set<number>();
  for (const it of input.items) {
    if (seenRecipes.has(it.recipeId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تكرار في الوصفات المحددة",
          why: `تم تمرير الوصفة #${it.recipeId} أكثر من مرة في طلب التحليل`,
          doThis: "أزل التكرار من قائمة الوصفات وأعد المحاولة",
        }),
      });
    }
    seenRecipes.add(it.recipeId);

    if (it.batchQty <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "كمية دفعة غير صالحة",
          why: `كمية الدفعة للوصفة #${it.recipeId} يجب أن تكون أكبر من الصفر`,
          doThis: "أدخل كمية صحيحة موجبة لكل وصفة مطلوبة",
        }),
      });
    }

    const scrap = it.scrapQty ?? 0;
    if (scrap < 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "كمية هدر سالبة",
          why: `كمية الهدر للوصفة #${it.recipeId} لا يمكن أن تكون سالبة`,
          doThis: "أدخل كمية هدر صفر أو موجبة",
        }),
      });
    }

    if (scrap >= it.batchQty) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "كمية الهدر تتجاوز حجم الدفعة",
          why: `كمية الهدر للوصفة #${it.recipeId} لا يمكن أن تساوي أو تتجاوز حجم الدفعة`,
          doThis: "عدّل كمية الهدر لتكون أقل قطعيّاً من حجم الدفعة",
        }),
      });
    }
  }

  return withTx(async (tx) => {
    const recipeIds = input.items.map((it) => it.recipeId);

    // ① جلب بيانات الوصفات والمنتجات الناتجة
    const recipeRows = await tx
      .select({
        recipeId: productionRecipes.id,
        recipeName: productionRecipes.name,
        outputVariantId: productionRecipes.outputVariantId,
        outputProductUnitId: productionRecipes.outputProductUnitId,
        laborPerOutputBase: productionRecipes.laborPerOutputBase,
        wasteStdPct: productionRecipes.wasteStdPct,
        isActive: productionRecipes.isActive,
        productId: products.id,
        productName: products.name,
        isBundle: products.isBundle,
        isService: products.isService,
        productActive: products.isActive,
        sku: productVariants.sku,
        variantCostPrice: productVariants.costPrice,
        variantActive: productVariants.isActive,
      })
      .from(productionRecipes)
      .innerJoin(productVariants, eq(productionRecipes.outputVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productionRecipes.id, recipeIds))
      .orderBy(asc(productionRecipes.id));

    const recipeMap = new Map<number, (typeof recipeRows)[0]>();
    for (const r of recipeRows) {
      recipeMap.set(r.recipeId, r);
    }

    for (const rId of recipeIds) {
      const r = recipeMap.get(rId);
      if (!r) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "الوصفة المطلوبة غير موجودة",
            why: `لم يتم العثور على الوصفة برقم التعريف #${rId}`,
            doThis: "تحقق من اختيار الوصفات أو حدّث الصفحة",
          }),
        });
      }

      if (!r.isActive || !r.productActive || !r.variantActive) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "الوصفة أو المنتج معطّل",
            why: `الوصفة «${r.recipeName}» أو المنتج المرتبط بها معطّل في النظام`,
            doThis: "فعّل الوصفة والمنتج أولاً أو استبعدها من قائمة الإنتاج",
          }),
        });
      }

      if (r.isService) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "وصفة خدمة غير قابلة للإنتاج المخزني",
            why: `الوصفة «${r.recipeName}» مخصصة لاستهلاك الخدمات تلقائياً عند البيع`,
            doThis: "استبعد وصفات الخدمات من أمر الإنتاج المباشر",
          }),
        });
      }

      if (r.isBundle) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "الوصفة تنتج بكجاً",
            why: `الوصفة «${r.recipeName}» مخرجاتها بكج، والبكجات تُنتج عبر حوار إنتاج مكونات البكج`,
            doThis: "استخدم زر «إنتاج مكونات بكج» المخصص للباندل",
          }),
        });
      }
    }

    // ② جلب أسماء وحدات القياس للمنتجات الناتجة
    const unitIds = recipeRows.map((r) => r.outputProductUnitId);
    const unitRows =
      unitIds.length > 0
        ? await tx
            .select({
              id: productUnits.id,
              unitName: productUnits.unitName,
            })
            .from(productUnits)
            .where(inArray(productUnits.id, unitIds))
            .orderBy(asc(productUnits.id))
        : [];
    const unitNameMap = new Map<number, string>(unitRows.map((u) => [u.id, u.unitName]));

    // ③ جلب خطوط الوصفات (المواد الخام الداخلة)
    const lineRows = await tx
      .select({
        recipeId: productionRecipeLines.recipeId,
        inputVariantId: productionRecipeLines.inputVariantId,
        inputProductUnitId: productionRecipeLines.inputProductUnitId,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
        productName: products.name,
        sku: productVariants.sku,
        costPrice: productVariants.costPrice,
      })
      .from(productionRecipeLines)
      .innerJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productionRecipeLines.recipeId, recipeIds))
      .orderBy(asc(productionRecipeLines.recipeId), asc(productionRecipeLines.id));

    const linesByRecipe = new Map<number, typeof lineRows>();
    for (const l of lineRows) {
      const list = linesByRecipe.get(l.recipeId) ?? [];
      list.push(l);
      linesByRecipe.set(l.recipeId, list);
    }

    for (const rId of recipeIds) {
      const lines = linesByRecipe.get(rId) ?? [];
      if (lines.length === 0) {
        const rName = recipeMap.get(rId)?.recipeName ?? `#${rId}`;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "الوصفة بلا مكوّنات",
            why: `الوصفة «${rName}» لا تحتوي على أي بنود مدخلات`,
            doThis: "أضف مكوّنات للوصفة أولاً ثم أعد طلب التحليل",
          }),
        });
      }
    }

    // ④ جلب وحدات القياس للمواد الخام الداخلة
    const inputUnitIds = lineRows
      .map((l) => l.inputProductUnitId)
      .filter((id): id is number => id != null);
    const inputUnitRows =
      inputUnitIds.length > 0
        ? await tx
            .select({
              id: productUnits.id,
              unitName: productUnits.unitName,
            })
            .from(productUnits)
            .where(inArray(productUnits.id, inputUnitIds))
            .orderBy(asc(productUnits.id))
        : [];
    const inputUnitNameMap = new Map<number, string>(inputUnitRows.map((u) => [u.id, u.unitName]));

    const allSubs = [
      ...(input.materialSubstitutions ?? []),
      ...input.items.flatMap((it) => it.materialSubstitutions ?? []),
    ];

    const subDetailsMap = new Map<
      number,
      { name: string; sku: string; unitName: string; costPrice: string }
    >();
    const extraUnitNameMap = new Map<number, string>();

    if (allSubs.length > 0) {
      const subVarIds = Array.from(new Set(allSubs.map((s) => Number(s.substituteVariantId))));
      const subUnitIds = allSubs
        .map((s) => s.substituteProductUnitId)
        .filter((id): id is number => id != null);

      const [subVarRows, subUnitRows] = await Promise.all([
        tx
          .select({
            variantId: productVariants.id,
            productName: products.name,
            sku: productVariants.sku,
            costPrice: productVariants.costPrice,
            baseUnitName: productUnits.unitName,
          })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .leftJoin(
            productUnits,
            and(
              eq(productUnits.variantId, productVariants.id),
              eq(productUnits.isBaseUnit, true)
            )
          )
          .where(inArray(productVariants.id, subVarIds)),
        subUnitIds.length > 0
          ? tx
              .select({
                id: productUnits.id,
                unitName: productUnits.unitName,
              })
              .from(productUnits)
              .where(inArray(productUnits.id, subUnitIds))
          : Promise.resolve([]),
      ]);

      for (const u of subUnitRows) {
        extraUnitNameMap.set(Number(u.id), u.unitName);
      }

      for (const row of subVarRows) {
        subDetailsMap.set(Number(row.variantId), {
          name: row.productName,
          sku: row.sku,
          unitName: row.baseUnitName ?? "وحدة",
          costPrice: row.costPrice ?? "0",
        });
      }
    }

    // ⑤ جلب الأرصدة المتاحة للفرع (ATP) لجميع المواد الخام
    const allInputVariantIds = Array.from(
      new Set([
        ...lineRows.map((l) => l.inputVariantId),
        ...allSubs.map((s) => Number(s.substituteVariantId)),
      ])
    ).sort((a, b) => a - b);
    const availabilityMap = await loadVariantAvailability(
      tx,
      input.branchId,
      allInputVariantIds
    );

    // ⑥ احتساب متطلبات كل وصفة وتجميع المواد المشتركة
    interface AggMaterialAccumulator {
      materialVariantId: number;
      materialName: string;
      sku: string;
      unitName: string;
      totalRequiredBase: Decimal;
      costPrice: string;
      recipeId?: number | null;
      recipeName?: string | null;
      qtyPerOutputBase?: string | null;
      isSubstituted?: boolean;
      originalVariantId?: number | null;
      originalMaterialName?: string | null;
      originalSku?: string | null;
    }
    const aggregatedMap = new Map<number, AggMaterialAccumulator>();

    let grandLaborCost = new Decimal(0);
    let grandMaterialsCost = new Decimal(0);

    const recipeResults: RecipeRequirementItemDto[] = [];

    for (const it of input.items) {
      const r = recipeMap.get(it.recipeId)!;
      const lines = linesByRecipe.get(it.recipeId)!;

      const itemSubs = [
        ...(input.materialSubstitutions ?? []),
        ...(it.materialSubstitutions ?? []),
      ].filter((s) => s.recipeId == null || Number(s.recipeId) === it.recipeId);
      const itemSubMap = new Map(itemSubs.map((s) => [Number(s.originalVariantId), s]));

      const compCoeffs = lines.map((l) => {
        const sub = itemSubMap.get(l.inputVariantId);
        return sub ? String(sub.qtyPerOutputBase) : l.qtyPerOutputBase;
      });
      const reqMultiple = requiredBatchMultiple(compCoeffs);
      const isMultipleValid = it.batchQty % reqMultiple === 0;

      const rawLabor = it.laborPerUnit != null ? String(it.laborPerUnit).trim() : null;
      const effectiveLaborPerUnit =
        rawLabor && rawLabor !== "" ? rawLabor : String(r.laborPerOutputBase ?? "0.00");
      const estLabor = round2(new Decimal(effectiveLaborPerUnit).times(it.batchQty));
      grandLaborCost = grandLaborCost.plus(estLabor);

      let recipeMaterialsCost = new Decimal(0);
      const recipeMaterials: RecipeRequirementMaterialLineDto[] = [];

      for (const l of lines) {
        const sub = itemSubMap.get(l.inputVariantId);
        const effectiveVarId = sub ? Number(sub.substituteVariantId) : l.inputVariantId;
        const subDetails = sub ? subDetailsMap.get(effectiveVarId) : null;
        const effectiveQtyPerOutput = sub ? String(sub.qtyPerOutputBase) : l.qtyPerOutputBase;
        const effectiveCostPrice = sub
          ? (subDetails?.costPrice ?? "0.00")
          : (l.costPrice || "0.00");
        const effectiveName = sub
          ? (subDetails?.name ?? `بديل #${effectiveVarId}`)
          : l.productName;
        const effectiveSku = sub ? (subDetails?.sku ?? "") : l.sku;
        const effectiveUnitName = sub
          ? ((sub.substituteProductUnitId
              ? extraUnitNameMap.get(Number(sub.substituteProductUnitId))
              : null) ??
            subDetails?.unitName ??
            "أساس")
          : ((l.inputProductUnitId ? inputUnitNameMap.get(l.inputProductUnitId) : null) || "أساس");

        const lineRequired = new Decimal(effectiveQtyPerOutput).times(it.batchQty);
        const lineCost = round2(lineRequired.times(new Decimal(effectiveCostPrice)));
        recipeMaterialsCost = recipeMaterialsCost.plus(lineCost);

        const available = Math.max(
          0,
          availabilityMap.get(effectiveVarId)?.availableBase ?? 0
        );

        recipeMaterials.push({
          variantId: effectiveVarId,
          productName: effectiveName,
          sku: effectiveSku,
          unitName: effectiveUnitName,
          qtyPerOutputBase: effectiveQtyPerOutput,
          totalRequiredBase: lineRequired.toFixed(4),
          availableInBranch: available,
          isSufficient: new Decimal(available).gte(lineRequired),
          isSubstituted: Boolean(sub),
          originalVariantId: sub ? l.inputVariantId : null,
          originalProductName: sub ? l.productName : null,
        });

        // تراكم المواد الشاملة
        const existing = aggregatedMap.get(effectiveVarId);
        if (existing) {
          existing.totalRequiredBase = existing.totalRequiredBase.plus(lineRequired);
          if (sub) {
            existing.isSubstituted = true;
            existing.originalVariantId = l.inputVariantId;
            existing.originalMaterialName = l.productName;
            existing.originalSku = l.sku;
          }
        } else {
          aggregatedMap.set(effectiveVarId, {
            materialVariantId: effectiveVarId,
            materialName: effectiveName,
            sku: effectiveSku,
            unitName: effectiveUnitName,
            totalRequiredBase: lineRequired,
            costPrice: effectiveCostPrice,
            recipeId: it.recipeId,
            recipeName: r.recipeName,
            qtyPerOutputBase: effectiveQtyPerOutput,
            isSubstituted: Boolean(sub),
            originalVariantId: sub ? l.inputVariantId : null,
            originalMaterialName: sub ? l.productName : null,
            originalSku: sub ? l.sku : null,
          });
        }
      }

      grandMaterialsCost = grandMaterialsCost.plus(recipeMaterialsCost);
      const estTotal = round2(recipeMaterialsCost.plus(estLabor));
      const scrap = it.scrapQty ?? 0;
      const goodQty = it.batchQty - scrap;

      recipeResults.push({
        recipeId: r.recipeId,
        recipeName: r.recipeName,
        outputVariantId: r.outputVariantId,
        outputProductName: r.productName,
        outputSku: r.sku,
        outputUnitName: unitNameMap.get(r.outputProductUnitId) ?? "وحدة",
        batchQty: it.batchQty,
        scrapQty: scrap,
        goodQty,
        requiredBatchMultiple: reqMultiple,
        isMultipleValid,
        laborPerUnit: effectiveLaborPerUnit,
        wasteStdPct: String(r.wasteStdPct ?? "0.00"),
        estimatedLaborCost: estLabor.toFixed(2),
        estimatedMaterialsCost: recipeMaterialsCost.toFixed(2),
        estimatedTotalCost: estTotal.toFixed(2),
        materials: recipeMaterials,
      });
    }

    // ⑦ بناء قائمة المواد المجمعة وتحديد عوامل النقص
    const aggregatedMaterials: AggregatedMultiRecipeMaterialDto[] = [];
    const limitingFactors: MultiRecipeRequirementsAnalysisResult["limitingFactors"] = [];

    const sortedAggregated = Array.from(aggregatedMap.values()).sort(
      (a, b) => a.materialVariantId - b.materialVariantId
    );

    for (const agg of sortedAggregated) {
      const available = Math.max(
        0,
        availabilityMap.get(agg.materialVariantId)?.availableBase ?? 0
      );
      const isSufficient = new Decimal(available).gte(agg.totalRequiredBase);
      const deficitBase = isSufficient
        ? "0"
        : agg.totalRequiredBase.minus(available).toFixed(4);

      if (!isSufficient) {
        limitingFactors.push({
          materialVariantId: agg.materialVariantId,
          materialName: agg.materialName,
          totalRequiredBase: agg.totalRequiredBase.toFixed(4),
          availableInBranch: available,
          deficitBase,
        });
      }

      aggregatedMaterials.push({
        materialVariantId: agg.materialVariantId,
        materialName: agg.materialName,
        sku: agg.sku,
        unitName: agg.unitName,
        totalRequiredBase: agg.totalRequiredBase.toFixed(4),
        availableInBranch: available,
        isSufficient,
        deficitBase,
        recipeId: agg.recipeId,
        recipeName: agg.recipeName,
        qtyPerOutputBase: agg.qtyPerOutputBase,
        costPrice: agg.costPrice,
        isSubstituted: agg.isSubstituted,
        originalVariantId: agg.originalVariantId,
        originalMaterialName: agg.originalMaterialName,
        originalSku: agg.originalSku,
      });
    }

    const canProduceAll =
      aggregatedMaterials.every((m) => m.isSufficient) &&
      recipeResults.every((r) => r.isMultipleValid);

    const grandTotalEstimatedCost = round2(grandMaterialsCost.plus(grandLaborCost));

    return {
      recipes: recipeResults,
      aggregatedMaterials,
      totalLaborCost: grandLaborCost.toFixed(2),
      totalMaterialsCost: grandMaterialsCost.toFixed(2),
      totalEstimatedCost: grandTotalEstimatedCost.toFixed(2),
      canProduceAll,
      limitingFactors,
    };
  });
}

/**
 * إنتاج وصفات متعددة دفعة واحدة داخل معاملة ذرية موحدة:
 * - ترتيب الدفعات تصاعدياً بـ recipeId لضمان ترتيب قفل متطابق ومنع الـ Deadlock.
 * - تنفيذ أمر إنتاج لكل وصفة مع تشعيب مفتاح Idempotency قطعي `${clientRequestId}:recipe:${recipeId}`.
 * - تخطي مزامنة البكج الفردية أثناء الحلقة لتسريع الإنجاز.
 * - تشغيل مزامنة موحدة واحدة لجميع المخرجات في ختام المعاملة.
 */
export async function produceMultiRecipeBatches(
  input: ProduceMultiRecipeInput & { branchId: number },
  actor: Actor
): Promise<ProduceMultiRecipeResult> {
  if (!input.batches || input.batches.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "قائمة الدفعات فارغة",
        why: "يجب تمرير دفعة واحدة على الأقل لترحيل الإنتاج المتعدد",
        doThis: "اختر الوصفات وحدد الكميات ثم أعد الترحيل",
      }),
    });
  }

  const seenRecipes = new Set<number>();
  for (const b of input.batches) {
    if (seenRecipes.has(b.recipeId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تكرار في دفعات الوصفة",
          why: `تم إرسال أكثر من دفعة للوصفة #${b.recipeId} في نفس الطلب`,
          doThis: "ادمج كميات الوصفة في دفعة واحدة وأعد المحاولة",
        }),
      });
    }
    seenRecipes.add(b.recipeId);

    if (b.batchQty <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "كمية دفعة غير صالحة",
          why: `كمية الدفعة للوصفة #${b.recipeId} يجب أن تكون أكبر من الصفر`,
          doThis: "أدخل كمية صحيحة موجبة لكل دفعة إنتاج",
        }),
      });
    }

    const scrap = b.scrapQty ?? 0;
    if (scrap < 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "كمية هدر سالبة",
          why: `كمية الهدر للوصفة #${b.recipeId} لا يمكن أن تكون سالبة`,
          doThis: "أدخل كمية هدر صفر أو موجبة",
        }),
      });
    }

    if (scrap >= b.batchQty) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "كمية الهدر تتجاوز حجم الدفعة",
          why: `كمية الهدر للوصفة #${b.recipeId} لا يمكن أن تساوي أو تتجاوز حجم الدفعة`,
          doThis: "عدّل كمية الهدر لتكون أقل قطعيّاً من حجم الدفعة الكلي",
        }),
      });
    }
  }

  return withTx(async (tx) => {
    const recipeIds = input.batches.map((b) => b.recipeId);

    // ① جلب والتحقق من الوصفات وأهليتها
    const recipeRows = await tx
      .select({
        recipeId: productionRecipes.id,
        recipeName: productionRecipes.name,
        outputVariantId: productionRecipes.outputVariantId,
        isActive: productionRecipes.isActive,
        productId: products.id,
        productName: products.name,
        isBundle: products.isBundle,
        isService: products.isService,
        productActive: products.isActive,
        variantActive: productVariants.isActive,
      })
      .from(productionRecipes)
      .innerJoin(productVariants, eq(productionRecipes.outputVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productionRecipes.id, recipeIds))
      .orderBy(asc(productionRecipes.id));

    const recipeMap = new Map<number, (typeof recipeRows)[0]>();
    for (const r of recipeRows) {
      recipeMap.set(r.recipeId, r);
    }

    for (const rId of recipeIds) {
      const r = recipeMap.get(rId);
      if (!r) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "الوصفة غير موجودة",
            why: `لم يتم العثور على الوصفة برقم التعريف #${rId}`,
            doThis: "تحقق من اختيار الوصفات أو حدّث الصفحة",
          }),
        });
      }

      if (!r.isActive || !r.productActive || !r.variantActive) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "الوصفة أو المنتج معطّل",
            why: `الوصفة «${r.recipeName}» أو المنتج المرتبط بها معطّل في النظام`,
            doThis: "فعّل الوصفة والمنتج أولاً أو استبعدها من قائمة الإنتاج",
          }),
        });
      }

      if (r.isService || r.isBundle) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نوع وصفة غير مدعوم للإنتاج المباشر",
            why: `الوصفة «${r.recipeName}» مخصصة للخدمات أو البكجات ولا تقبل الإنتاج المخزني المباشر`,
            doThis: "استبعد الوصفة غير المؤهلة ثم أعد المحاولة",
          }),
        });
      }
    }

    // التحقق المسبق من سطور الوصفات وقابلية قسمة الدفعات لضمان سلامة كامل الحزمة
    const prodLines = await tx
      .select({
        recipeId: productionRecipeLines.recipeId,
        inputVariantId: productionRecipeLines.inputVariantId,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
      })
      .from(productionRecipeLines)
      .where(inArray(productionRecipeLines.recipeId, recipeIds))
      .orderBy(asc(productionRecipeLines.recipeId), asc(productionRecipeLines.id));

    const linesByRecipe = new Map<number, typeof prodLines>();
    for (const l of prodLines) {
      const list = linesByRecipe.get(l.recipeId) ?? [];
      list.push(l);
      linesByRecipe.set(l.recipeId, list);
    }

    for (const b of input.batches) {
      const r = recipeMap.get(b.recipeId)!;
      const lines = linesByRecipe.get(b.recipeId) ?? [];
      if (lines.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "الوصفة بلا مكوّنات",
            why: `الوصفة «${r.recipeName}» لا تحتوي على أي بنود مدخلات`,
            doThis: "أضف مكوّنات للوصفة أولاً ثم أعد طلب الإنتاج",
          }),
        });
      }
      const batchInputIds = new Set(lines.map((l) => Number(l.inputVariantId)));
      const relevantSubs = [
        ...(input.materialSubstitutions ?? []),
        ...(b.materialSubstitutions ?? []),
      ].filter(
        (s) =>
          batchInputIds.has(Number(s.originalVariantId)) &&
          (s.recipeId == null || Number(s.recipeId) === b.recipeId)
      );
      const subMap = new Map(relevantSubs.map((s) => [Number(s.originalVariantId), s]));
      const compCoeffs = lines.map((l) => {
        const sub = subMap.get(Number(l.inputVariantId));
        return sub ? String(sub.qtyPerOutputBase) : l.qtyPerOutputBase;
      });
      const reqMultiple = requiredBatchMultiple(compCoeffs);
      if (b.batchQty % reqMultiple !== 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "كمية دفعة غير متوافقة مع مضاعفات الوصفة",
            why: `الوصفة «${r.recipeName}» تقبل فقط مضاعفات الرقم ${reqMultiple} (الكمية المطلوبة: ${b.batchQty})`,
            doThis: `عدّل كمية الدفعة لتكون من مضاعفات ${reqMultiple} (مثل: ${Math.ceil(b.batchQty / reqMultiple) * reqMultiple})`,
          }),
        });
      }
    }

    // ② تجهيز مرجع الحزمة الموحد وترتيب الدفعات حتمياً
    const dateStr = toDateStr().replace(/-/g, "");
    const reqHash = createHash("sha256").update(input.clientRequestId).digest("hex").slice(0, 8);
    const multiRecipeDocGroupRef = `MULTI-${input.branchId}-${dateStr}-${reqHash}`;

    // ترتيب الدفعات تصاعدياً بـ outputVariantId ثم recipeId لضمان ترتيب قفل متطابق ومنع الـ Deadlock
    const sortedBatches = [...input.batches].sort((a, b) => {
      const varA = Number(recipeMap.get(a.recipeId)?.outputVariantId ?? 0);
      const varB = Number(recipeMap.get(b.recipeId)?.outputVariantId ?? 0);
      if (varA !== varB) return varA - varB;
      return a.recipeId - b.recipeId;
    });

    const subVariantIds = [
      ...(input.materialSubstitutions ?? []).map((s) => Number(s.substituteVariantId)),
      ...input.batches.flatMap((b) => (b.materialSubstitutions ?? []).map((s) => Number(s.substituteVariantId))),
    ];

    // جمع كافة المتغيرات المشتركة في العملية وقفلها حتمياً بالترتيب الحاكم لمنع الـ Deadlock
    const allVariantIdsToLock = Array.from(
      new Set([
        ...sortedBatches.map((b) => recipeMap.get(b.recipeId)!.outputVariantId),
        ...prodLines.map((l) => Number(l.inputVariantId)),
        ...subVariantIds,
      ])
    ).sort((a, b) => a - b);

    const variantProdRows = await tx
      .select({ id: productVariants.id, productId: productVariants.productId })
      .from(productVariants)
      .where(inArray(productVariants.id, allVariantIdsToLock))
      .orderBy(asc(productVariants.id));

    const allProductIdsToLock = Array.from(
      new Set(variantProdRows.map((r) => Number(r.productId)))
    ).sort((a, b) => a - b);

    // ١. قفل المنتجات تصاعدياً
    if (allProductIdsToLock.length > 0) {
      await tx
        .select({ id: products.id })
        .from(products)
        .where(inArray(products.id, allProductIdsToLock))
        .orderBy(asc(products.id))
        .for("update");
    }

    // ٢. قفل المتغيرات تصاعدياً
    if (allVariantIdsToLock.length > 0) {
      await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(inArray(productVariants.id, allVariantIdsToLock))
        .orderBy(asc(productVariants.id))
        .for("update");

      // ٣. ضمان وقفل أرصدة الفرع تصاعدياً (variantId ASC, branchId ASC)
      await ensureBranchStockRows(tx, allVariantIdsToLock, input.branchId);
      await tx
        .select({ id: branchStock.id })
        .from(branchStock)
        .where(
          and(
            eq(branchStock.branchId, input.branchId),
            inArray(branchStock.variantId, allVariantIdsToLock)
          )
        )
        .orderBy(asc(branchStock.variantId), asc(branchStock.branchId))
        .for("update");
    }

    // ③ تنفيذ أوامر الإنتاج تسلسلياً داخل نفس المعاملة
    const orders: ProduceMultiRecipeResult["orders"] = [];
    let totalCostAccumulator = new Decimal(0);
    const affectedOutputVariantIds: number[] = [];

    for (const batch of sortedBatches) {
      const r = recipeMap.get(batch.recipeId)!;
      const subRequestId = `${input.clientRequestId}:recipe:${batch.recipeId}`;
      const batchNotes = input.notes?.trim()
        ? `${input.notes.trim()} [حزمة إنتاج متعدد ${multiRecipeDocGroupRef} - وصفة «${r.recipeName}»]`
        : `إنتاج متعدد ${multiRecipeDocGroupRef} - وصفة «${r.recipeName}»`;

      const rawLabor = batch.laborPerUnit != null ? String(batch.laborPerUnit).trim() : undefined;
      const cleanLabor = rawLabor && rawLabor !== "" ? rawLabor : undefined;

      const batchLines = linesByRecipe.get(batch.recipeId) ?? [];
      const batchInputIds = new Set(batchLines.map((l) => Number(l.inputVariantId)));
      const relevantSubs = [
        ...(input.materialSubstitutions ?? []),
        ...(batch.materialSubstitutions ?? []),
      ].filter(
        (s) =>
          batchInputIds.has(Number(s.originalVariantId)) &&
          (s.recipeId == null || Number(s.recipeId) === batch.recipeId)
      );

      const prodResult = await createProductionInTx(
        tx,
        {
          branchId: input.branchId,
          clientRequestId: subRequestId,
          notes: batchNotes,
          linkedWorkOrderId: input.linkedWorkOrderId ?? null,
          run: {
            recipeId: batch.recipeId,
            batchQty: batch.batchQty,
            scrapQty: batch.scrapQty ?? 0,
            laborPerUnit: cleanLabor,
            materialSubstitutions: relevantSubs.length > 0 ? relevantSubs : undefined,
          },
        },
        actor,
        { skipBundleSync: true },
      );

      const scrap = batch.scrapQty ?? 0;
      const goodQty = batch.batchQty - scrap;

      orders.push({
        productionOrderId: prodResult.productionOrderId,
        docNumber: prodResult.docNumber,
        recipeId: batch.recipeId,
        recipeName: r.recipeName,
        outputVariantId: r.outputVariantId,
        outputProductName: r.productName,
        batchQty: batch.batchQty,
        goodQty,
        scrapQty: scrap,
        totalCost: prodResult.totalCost,
      });

      totalCostAccumulator = totalCostAccumulator.plus(money(prodResult.totalCost));
      affectedOutputVariantIds.push(r.outputVariantId);
    }

    // ④ مزامنة ختامية موحدة لكافة البكجات التي تستخدم أي من هذه المخرجات
    const distinctOutputVariantIds = Array.from(new Set(affectedOutputVariantIds));
    await syncBundlesContainingComponents(tx, distinctOutputVariantIds);

    return {
      multiRecipeDocGroupRef,
      orders,
      totalCostAllOrders: round2(totalCostAccumulator).toFixed(2),
      orderCount: orders.length,
    };
  });
}
