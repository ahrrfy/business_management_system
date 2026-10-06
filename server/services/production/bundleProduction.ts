import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  branchStock,
  bundleComponents,
  productUnits,
  productVariants,
  productionRecipeLines,
  productionRecipes,
  products,
} from "../../../drizzle/schema";
import { requiredBatchMultiple } from "../../../shared/batchDivisibility";
import type {
  AggregatedMaterialDto,
  AnalyzeBundleRequirementsInput,
  BundleRequirementsAnalysisResult,
  ComponentRequirementDto,
  ProduceBundleComponentsInput,
  ProduceBundleComponentsResult,
} from "../../../shared/bundleProductionTypes";
import type { MaterialSubstitutionItem } from "../../../shared/recipeSubstitutionTypes";
import { loadBundleUnitCosts, syncBundlesContainingComponents } from "../bundleService";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import { ensureBranchStockRows } from "../inventoryService";
import { money, round2, toDateStr } from "../money";
import type { Actor } from "../tx";
import { withTx } from "../tx";
import { createProductionInTx } from "./create";

/**
 * تحليل احتياجات إنتاج مكونات البكج:
 * - قراءة مكوّنات البكج والوصفات النشطة لكل مكوّن.
 * - فحص رصيد الفرع واحتساب العجز الصافي.
 * - جبر الدفعة لمضاعف القسمة الشرعي (batch divisibility).
 * - تجميع المواد الخام المشتركة واحتساب عنق الزجاجة الحاكم (bottleneck).
 */
export async function analyzeBundleRequirements(
  input: AnalyzeBundleRequirementsInput & { branchId: number }
): Promise<BundleRequirementsAnalysisResult> {
  return withTx(async (tx) => {
    // ① فحص وجود البكج وأهليته
    const [bundleRow] = await tx
      .select({
        variantId: productVariants.id,
        productId: products.id,
        productName: products.name,
        sku: productVariants.sku,
        isBundle: products.isBundle,
        isActive: products.isActive,
        variantActive: productVariants.isActive,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productVariants.id, input.bundleVariantId))
      .limit(1);

    if (!bundleRow) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "البكج المطلوب غير موجود",
          why: `لم يتم العثور على الصنف برقم التعريف ${input.bundleVariantId}`,
          doThis: "تحقق من اختيار الصنف أو حدّث الصفحة",
        }),
      });
    }

    if (!bundleRow.isBundle) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "المنتج المحدد ليس بكجاً مركّباً",
          why: "هذه العملية مخصصة حصراً للأصناف المركبة (البكجات)",
          doThis: "اختر منتجاً مُعرّفاً كـ بكج، أو افتح صفحة إنتاج الوصفات العادية",
        }),
      });
    }

    if (!bundleRow.isActive || !bundleRow.variantActive) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "البكج المطلوب معطّل",
          why: "منتج البكج أو متغيّره ليس نشطاً في النظام",
          doThis: "فعّل البكج أولاً في بطاقة المنتج قبل طلب تحليله أو إنتاجه",
        }),
      });
    }

    // ② قراءة مكونات البكج
    const compRows = await tx
      .select({
        id: bundleComponents.id,
        componentVariantId: bundleComponents.componentVariantId,
        componentBaseQuantity: bundleComponents.componentBaseQuantity,
        productName: products.name,
        sku: productVariants.sku,
        costPrice: productVariants.costPrice,
        isBundle: products.isBundle,
        isService: products.isService,
        productActive: products.isActive,
        variantActive: productVariants.isActive,
      })
      .from(bundleComponents)
      .innerJoin(productVariants, eq(bundleComponents.componentVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(bundleComponents.bundleVariantId, input.bundleVariantId))
      .orderBy(asc(bundleComponents.sortOrder), asc(bundleComponents.id));

    if (!compRows.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "البكج لا يحتوي على أي مكونات معرّفة",
          why: "لا يمكن تحليل احتياجات أو إنتاج بكج بدون مكوّنات في وصفته",
          doThis: "قم بتعريف مكوّنات البكج أولاً في بطاقة المنتج",
        }),
      });
    }

    for (const c of compRows) {
      if (!c.productActive || !c.variantActive) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "مكوّن معطّل في البكج",
            why: `المكوّن «${c.productName}» أو متغيّره معطّل في النظام`,
            doThis: "فعّل المكوّن أولاً في بطاقة المنتج أو أزله من تركيبة البكج",
          }),
        });
      }
    }

    const compVariantIds = compRows.map((c) => c.componentVariantId);

    // ③ استعلام الوصفات النشطة للمكونات
    const activeRecipes = await tx
      .select({
        id: productionRecipes.id,
        name: productionRecipes.name,
        outputVariantId: productionRecipes.outputVariantId,
        laborPerOutputBase: productionRecipes.laborPerOutputBase,
        wasteStdPct: productionRecipes.wasteStdPct,
        isActive: productionRecipes.isActive,
      })
      .from(productionRecipes)
      .where(
        and(
          inArray(productionRecipes.outputVariantId, compVariantIds),
          eq(productionRecipes.isActive, true),
        )
      )
      .orderBy(asc(productionRecipes.id));

    const recipeByVariantId = new Map<number, (typeof activeRecipes)[number]>();
    for (const r of activeRecipes) {
      if (!recipeByVariantId.has(Number(r.outputVariantId))) {
        recipeByVariantId.set(Number(r.outputVariantId), r);
      }
    }

    const recipeIds = activeRecipes.map((r) => r.id);
    let recipeLines: Array<{
      recipeId: number;
      inputVariantId: number;
      qtyPerOutputBase: string;
      materialName: string | null;
      sku: string | null;
      unitName: string | null;
      materialCostPrice: string;
    }> = [];

    if (recipeIds.length > 0) {
      recipeLines = await tx
        .select({
          recipeId: productionRecipeLines.recipeId,
          inputVariantId: productionRecipeLines.inputVariantId,
          qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
          materialName: products.name,
          sku: productVariants.sku,
          unitName: productUnits.unitName,
          materialCostPrice: productVariants.costPrice,
        })
        .from(productionRecipeLines)
        .innerJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
        .innerJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(productUnits, eq(productionRecipeLines.inputProductUnitId, productUnits.id))
        .where(inArray(productionRecipeLines.recipeId, recipeIds))
        .orderBy(asc(productionRecipeLines.recipeId), asc(productionRecipeLines.id));
    }

    const substitutions = input.materialSubstitutions ?? [];

    const subDetailsMap = new Map<
      number,
      { name: string; sku: string; unitName: string; costPrice: string }
    >();
    const unitNameById = new Map<number, string>();

    if (substitutions.length > 0) {
      const subVarIds = Array.from(new Set(substitutions.map((s) => Number(s.substituteVariantId))));
      const subUnitIds = substitutions
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
        unitNameById.set(Number(u.id), u.unitName);
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

    const effectiveRecipeLines = recipeLines.map((l) => {
      const origId = Number(l.inputVariantId);
      const sub =
        substitutions.find(
          (s) =>
            Number(s.originalVariantId) === origId &&
            s.recipeId != null &&
            Number(s.recipeId) === Number(l.recipeId)
        ) ??
        substitutions.find(
          (s) => Number(s.originalVariantId) === origId && s.recipeId == null
        );
      if (!sub) {
        return {
          ...l,
          isSubstituted: false,
          originalVariantId: null as number | null,
          originalMaterialName: null as string | null,
          originalSku: null as string | null,
        };
      }
      const subDetails = subDetailsMap.get(Number(sub.substituteVariantId));
      const effectiveUnitName =
        (sub.substituteProductUnitId != null
          ? unitNameById.get(Number(sub.substituteProductUnitId))
          : null) ??
        subDetails?.unitName ??
        l.unitName ??
        "وحدة";

      return {
        recipeId: l.recipeId,
        inputVariantId: Number(sub.substituteVariantId),
        qtyPerOutputBase:
          sub.recipeId != null
            ? String(sub.qtyPerOutputBase)
            : String(l.qtyPerOutputBase),
        materialName: subDetails?.name ?? `بديل #${sub.substituteVariantId}`,
        sku: subDetails?.sku ?? "",
        unitName: effectiveUnitName,
        materialCostPrice: subDetails?.costPrice ?? "0",
        isSubstituted: true,
        originalVariantId: origId,
        originalMaterialName: l.materialName,
        originalSku: l.sku,
      };
    });

    const linesByRecipeId = new Map<number, typeof effectiveRecipeLines>();
    for (const l of effectiveRecipeLines) {
      const rid = Number(l.recipeId);
      const arr = linesByRecipeId.get(rid) ?? [];
      arr.push(l);
      linesByRecipeId.set(rid, arr);
    }

    // التحقق من أن كل وصفة مكوّن نشطة تحتوي على بنود مدخلات
    for (const r of activeRecipes) {
      const lines = linesByRecipeId.get(r.id) ?? [];
      if (lines.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "وصفة مكوّن بلا مدخلات",
            why: `الوصفة «${r.name}» لا تحتوي على أي بنود مواد خام`,
            doThis: "أضف مكوّنات للوصفة أولاً في شاشة وصفات الإنتاج أو عطّلها",
          }),
        });
      }
    }

    // ④ استعلام الأرصدة المتاحة للفرع (للمكونات والمواد الخام الأصلية والبديلة)
    const allVariantIdsToProbe = Array.from(
      new Set([
        ...compVariantIds,
        ...recipeLines.map((l) => Number(l.inputVariantId)),
        ...effectiveRecipeLines.map((l) => Number(l.inputVariantId)),
      ])
    ).sort((a, b) => a - b);

    const availabilityMap = await loadVariantAvailability(
      tx,
      input.branchId,
      allVariantIdsToProbe
    );

    // ⑤ بناء مصفوفة المكونات واحتساب العجز وجبر المضاعف
    const components: ComponentRequirementDto[] = [];
    for (const c of compRows) {
      const variantId = c.componentVariantId;
      const avail = availabilityMap.get(variantId);
      const onHandStock = Math.max(0, avail?.availableBase ?? 0);
      const totalRequiredQty = input.bundleQuantity * c.componentBaseQuantity;

      let shortageQty: number;
      if (input.mode === "FULL_QUANTITY") {
        shortageQty = totalRequiredQty;
      } else {
        shortageQty = Math.max(0, totalRequiredQty - onHandStock);
      }

      const recipe = recipeByVariantId.get(variantId);
      const isManufactured = Boolean(recipe);
      const recLines = recipe ? (linesByRecipeId.get(recipe.id) ?? []) : [];
      const coefficients = recLines.map((l) => String(l.qtyPerOutputBase));
      const requiredMultiple = isManufactured ? requiredBatchMultiple(coefficients) : 1;

      let suggestedBatchQty = 0;
      let surplusBufferQty = 0;

      if (isManufactured && shortageQty > 0) {
        suggestedBatchQty =
          requiredMultiple > 1
            ? Math.ceil(shortageQty / requiredMultiple) * requiredMultiple
            : shortageQty;
        surplusBufferQty = Math.max(0, suggestedBatchQty - shortageQty);
      }

      const laborPerUnit = recipe ? String(recipe.laborPerOutputBase ?? "0.00") : "0.00";
      const wasteStdPct = recipe ? String(recipe.wasteStdPct ?? "0.00") : "0.00";

      components.push({
        variantId,
        productName: c.productName,
        sku: c.sku,
        componentBaseQuantity: c.componentBaseQuantity,
        totalRequiredQty,
        onHandStock,
        shortageQty,
        suggestedBatchQty,
        isManufactured,
        recipeId: recipe ? recipe.id : null,
        recipeName: recipe ? recipe.name : null,
        requiredBatchMultiple: requiredMultiple,
        surplusBufferQty,
        laborPerUnit,
        wasteStdPct,
      });
    }

    // ⑥ تجميع المواد الخام واحتساب الاحتياج الكلي
    interface MaterialAccumulator {
      materialVariantId: number;
      materialName: string;
      sku: string;
      unitName: string;
      totalRequiredBase: Decimal;
      recipeId?: number | null;
      recipeName?: string | null;
      qtyPerOutputBase?: string | null;
      costPrice?: string | null;
      isSubstituted?: boolean;
      originalVariantId?: number | null;
      originalMaterialName?: string | null;
      originalSku?: string | null;
    }

    const materialMap = new Map<number, MaterialAccumulator>();

    for (const comp of components) {
      if (!comp.isManufactured || !comp.recipeId) continue;
      const lines = linesByRecipeId.get(comp.recipeId) ?? [];
      const batchQty = comp.suggestedBatchQty;
      for (const l of lines) {
        const matVarId = Number(l.inputVariantId);
        const needed = new Decimal(l.qtyPerOutputBase).times(batchQty);
        const existing = materialMap.get(matVarId);
        if (existing) {
          existing.totalRequiredBase = existing.totalRequiredBase.plus(needed);
          if (l.isSubstituted) {
            existing.isSubstituted = true;
            existing.originalVariantId = l.originalVariantId;
            existing.originalMaterialName = l.originalMaterialName;
            existing.originalSku = l.originalSku;
          }
        } else {
          materialMap.set(matVarId, {
            materialVariantId: matVarId,
            materialName: l.materialName ?? `#${matVarId}`,
            sku: l.sku ?? "",
            unitName: l.unitName ?? "وحدة",
            totalRequiredBase: needed,
            recipeId: comp.recipeId,
            recipeName: comp.recipeName,
            qtyPerOutputBase: l.qtyPerOutputBase,
            costPrice: l.materialCostPrice,
            isSubstituted: l.isSubstituted,
            originalVariantId: l.originalVariantId,
            originalMaterialName: l.originalMaterialName,
            originalSku: l.originalSku,
          });
        }
      }
    }

    const aggregatedMaterials: AggregatedMaterialDto[] = [];
    for (const [matId, item] of Array.from(materialMap.entries())) {
      const avail = availabilityMap.get(matId)?.availableBase ?? 0;
      const reqNum = item.totalRequiredBase.toNumber();
      const isSufficient = avail >= reqNum;
      const deficitBase = isSufficient
        ? "0"
        : item.totalRequiredBase.minus(avail).toFixed(4);

      aggregatedMaterials.push({
        materialVariantId: matId,
        materialName: item.materialName,
        sku: item.sku,
        unitName: item.unitName,
        totalRequiredBase: item.totalRequiredBase.toFixed(4),
        availableInBranch: avail,
        isSufficient,
        deficitBase,
        recipeId: item.recipeId,
        recipeName: item.recipeName,
        qtyPerOutputBase: item.qtyPerOutputBase,
        costPrice: item.costPrice,
        isSubstituted: item.isSubstituted,
        originalVariantId: item.originalVariantId,
        originalMaterialName: item.originalMaterialName,
        originalSku: item.originalSku,
      });
    }

    // ⑦ احتساب السقف الممكن وعنق الزجاجة الحاكم (Governing Bottleneck)
    let maxBundlesPossible = Infinity;
    let limitingFactorName: string | null = null;
    let limitingFactorType: "RAW_MATERIAL" | "COMMERCIAL_COMPONENT" | null = null;

    // المكونات التجارية غير المصنعة
    for (const comp of components) {
      if (!comp.isManufactured) {
        const baseQty = Math.max(1, comp.componentBaseQuantity);
        const limit = Math.max(0, Math.floor(comp.onHandStock / baseQty));
        if (limit < maxBundlesPossible) {
          maxBundlesPossible = limit;
          limitingFactorName = comp.productName;
          limitingFactorType = "COMMERCIAL_COMPONENT";
        }
      }
    }

    // المواد الخام المستهلكة عبر كل مكونات البكج
    const rawMaterialUsagePerBundle = new Map<number, { name: string; usage: Decimal }>();
    for (const comp of components) {
      if (!comp.isManufactured || !comp.recipeId) continue;
      const lines = linesByRecipeId.get(comp.recipeId) ?? [];
      for (const l of lines) {
        const matId = Number(l.inputVariantId);
        const unitUsage = new Decimal(l.qtyPerOutputBase).times(comp.componentBaseQuantity);
        const current = rawMaterialUsagePerBundle.get(matId);
        if (current) {
          current.usage = current.usage.plus(unitUsage);
        } else {
          rawMaterialUsagePerBundle.set(matId, {
            name: l.materialName ?? `#${matId}`,
            usage: unitUsage,
          });
        }
      }
    }

    for (const [matId, entry] of Array.from(rawMaterialUsagePerBundle.entries())) {
      if (entry.usage.gt(0)) {
        const avail = Math.max(0, availabilityMap.get(matId)?.availableBase ?? 0);
        const limit = Math.max(0, new Decimal(avail).div(entry.usage).floor().toNumber());
        if (limit < maxBundlesPossible) {
          maxBundlesPossible = limit;
          limitingFactorName = entry.name;
          limitingFactorType = "RAW_MATERIAL";
        }
      }
    }

    if (!Number.isFinite(maxBundlesPossible)) {
      maxBundlesPossible = input.bundleQuantity;
    } else {
      maxBundlesPossible = Math.max(0, maxBundlesPossible);
    }

    // ⑧ تقدير التكاليف الإجمالية للدفعة المقترحة
    let estLabor = new Decimal(0);
    let estMaterials = new Decimal(0);

    for (const comp of components) {
      if (!comp.isManufactured || !comp.recipeId || comp.suggestedBatchQty <= 0) continue;
      const lab = money(comp.laborPerUnit).times(comp.suggestedBatchQty);
      estLabor = estLabor.plus(lab);

      const lines = linesByRecipeId.get(comp.recipeId) ?? [];
      for (const l of lines) {
        const needed = new Decimal(l.qtyPerOutputBase).times(comp.suggestedBatchQty);
        const cost = needed.times(money(l.materialCostPrice ?? "0"));
        estMaterials = estMaterials.plus(cost);
      }
    }

    const estimatedTotalLaborCost = round2(estLabor).toFixed(2);
    const estimatedTotalMaterialsCost = round2(estMaterials).toFixed(2);
    const estimatedTotalCost = round2(estLabor.plus(estMaterials)).toFixed(2);

    return {
      bundleVariantId: input.bundleVariantId,
      bundleName: bundleRow.productName,
      bundleSku: bundleRow.sku,
      branchId: input.branchId,
      requestedBundleQty: input.bundleQuantity,
      mode: input.mode,
      components,
      aggregatedMaterials,
      maxBundlesPossible,
      limitingFactorName,
      limitingFactorType,
      estimatedTotalLaborCost,
      estimatedTotalMaterialsCost,
      estimatedTotalCost,
    };
  });
}

/**
 * إنتاج مكونات البكج دفعة واحدة داخل معاملة ذرية موحدة:
 * - ترتيب المكونات تصاعدياً بـ variantId لمنع الـ Deadlock.
 * - تنفيذ أمر إنتاج لكل مكوّن مع تشعيب مفتاح Idempotency قطعي.
 * - تخطي مزامنة البكج الفردية أثناء الحلقة.
 * - تشغيل مزامنة موحدة واحدة لجميع المخرجات في ختام المعاملة.
 */
export async function produceBundleComponents(
  input: ProduceBundleComponentsInput & { branchId: number },
  actor: Actor
): Promise<ProduceBundleComponentsResult> {
  return withTx(async (tx) => {
    // ① التحقق من البكج
    const [bundle] = await tx
      .select({
        id: productVariants.id,
        isBundle: products.isBundle,
        isActive: products.isActive,
        variantActive: productVariants.isActive,
        name: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productVariants.id, input.bundleVariantId))
      .limit(1);

    if (!bundle || !bundle.isBundle) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "المنتج المحدد ليس بكجاً",
          why: "أمر إنتاج مكونات البكج يجب أن يستهدف صنفاً مركباً",
          doThis: "اختر بكجاً صالحاً وأعد المحاولة",
        }),
      });
    }

    if (!bundle.isActive || !bundle.variantActive) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "البكج المطلوب معطّل",
          why: "منتج البكج أو متغيّره ليس نشطاً في النظام",
          doThis: "فعّل البكج أولاً في بطاقة المنتج قبل طلب ترحيل أمر الإنتاج",
        }),
      });
    }

    // التحقق من مكوّنات البكج المعتمدة لمنع تمرير أصناف دخيلة أو مكررة
    const compRows = await tx
      .select({
        componentVariantId: bundleComponents.componentVariantId,
        productName: products.name,
        productActive: products.isActive,
        variantActive: productVariants.isActive,
      })
      .from(bundleComponents)
      .innerJoin(productVariants, eq(bundleComponents.componentVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(bundleComponents.bundleVariantId, input.bundleVariantId))
      .orderBy(asc(bundleComponents.sortOrder), asc(bundleComponents.id));

    for (const c of compRows) {
      if (!c.productActive || !c.variantActive) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "مكوّن معطّل في البكج",
            why: `المكوّن «${c.productName}» أو متغيّره معطّل في النظام`,
            doThis: "فعّل المكوّن أولاً في بطاقة المنتج أو أزله من تركيبة البكج",
          }),
        });
      }
    }

    const validComponentVariantIds = new Set(compRows.map((c) => c.componentVariantId));

    const seenVariants = new Set<number>();
    for (const b of input.batches) {
      if (seenVariants.has(b.variantId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تكرار في أصناف الدفعات",
            why: `تم إرسال أكثر من دفعة للصنف #${b.variantId} في نفس الطلب`,
            doThis: "ادمج كميات الصنف في دفعة واحدة وأعد المحاولة",
          }),
        });
      }
      seenVariants.add(b.variantId);

      if (!validComponentVariantIds.has(b.variantId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "صنف غير منتمٍ للبكج",
            why: `المتغيّر #${b.variantId} ليس من مكوّنات البكج المطلوب #${input.bundleVariantId}`,
            doThis: "أزل الصنف الدخيل من قائمة الدفعات ثم أعد المحاولة",
          }),
        });
      }

      if (b.batchQty <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "كمية دفعة غير صالحة",
            why: `كمية الدفعة للصنف #${b.variantId} يجب أن تكون أكبر من الصفر`,
            doThis: "أدخل كمية صحيحة موجبة لكل دفعة إنتاج",
          }),
        });
      }

      const scrap = b.scrapQty ?? 0;
      if (scrap >= b.batchQty) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "كمية التالف تساوي أو تتجاوز حجم الدفعة",
            why: `لا يمكن إنتاج دفعة سليمها صفر أو سالب للصنف #${b.variantId}`,
            doThis: "عدّل كمية التالف لتكون أقل قطعيّاً من حجم الدفعة الكلي",
          }),
        });
      }
    }

    // التحقق المسبق من سطور وصفات الدفعات وقابلية قسمة الكميات
    const batchRecipeIds = Array.from(new Set(input.batches.map((b) => b.recipeId)));
    const batchRecipeLines = await tx
      .select({
        recipeId: productionRecipeLines.recipeId,
        inputVariantId: productionRecipeLines.inputVariantId,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
      })
      .from(productionRecipeLines)
      .where(inArray(productionRecipeLines.recipeId, batchRecipeIds))
      .orderBy(asc(productionRecipeLines.recipeId), asc(productionRecipeLines.id));

    const linesByRecipeId = new Map<number, typeof batchRecipeLines>();
    for (const l of batchRecipeLines) {
      const arr = linesByRecipeId.get(l.recipeId) ?? [];
      arr.push(l);
      linesByRecipeId.set(l.recipeId, arr);
    }

    for (const b of input.batches) {
      const lines = linesByRecipeId.get(b.recipeId) ?? [];
      if (lines.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "الوصفة بلا مكوّنات",
            why: `الوصفة #${b.recipeId} للصنف #${b.variantId} لا تحتوي على أي بنود مدخلات`,
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
        return sub
          ? sub.recipeId != null
            ? String(sub.qtyPerOutputBase)
            : String(l.qtyPerOutputBase)
          : String(l.qtyPerOutputBase);
      });
      const reqMultiple = requiredBatchMultiple(compCoeffs);
      if (b.batchQty % reqMultiple !== 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "كمية دفعة غير متوافقة مع مضاعفات الوصفة",
            why: `دفعة الصنف #${b.variantId} تقبل فقط مضاعفات الرقم ${reqMultiple} (الكمية المطلوبة: ${b.batchQty})`,
            doThis: `عدّل كمية الدفعة لتكون من مضاعفات ${reqMultiple}`,
          }),
        });
      }
    }

    const dateStr = toDateStr().replace(/-/g, "");
    const reqHash = createHash("sha256").update(input.clientRequestId).digest("hex").slice(0, 8);
    const bundleDocGroupRef = `BND-${input.branchId}-${dateStr}-${reqHash}`;

    // ② ترتيب الدفعات تصاعدياً بـ variantId لضمان ترتيب قفل متطابق ومنع الـ Deadlock
    const sortedBatches = [...input.batches].sort((a, b) => a.variantId - b.variantId);

    const subVariantIds = [
      ...(input.materialSubstitutions ?? []).map((s) => Number(s.substituteVariantId)),
      ...input.batches.flatMap((b) => (b.materialSubstitutions ?? []).map((s) => Number(s.substituteVariantId))),
    ];

    // جمع كافة المتغيرات المشتركة في العملية وقفلها حتمياً بالترتيب الحاكم لمنع الـ Deadlock
    const allVariantIdsToLock = Array.from(
      new Set([
        input.bundleVariantId,
        ...sortedBatches.map((b) => b.variantId),
        ...batchRecipeLines.map((l) => Number(l.inputVariantId)),
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

    // استخراج أسماء المنتجات للعرض والتوثيق
    const variantIds = sortedBatches.map((b) => b.variantId);
    const prodVariants = await tx
      .select({
        variantId: productVariants.id,
        productName: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds))
      .orderBy(asc(productVariants.id));

    const variantNameMap = new Map<number, string>(
      prodVariants.map((v) => [v.variantId, v.productName])
    );

    // ③ تنفيذ أوامر الإنتاج تسلسلياً داخل نفس المعاملة مع تخطي مزامنة البكج
    const orders: ProduceBundleComponentsResult["orders"] = [];
    let totalCostAccumulator = new Decimal(0);

    for (const batch of sortedBatches) {
      const subRequestId = `${input.clientRequestId}:comp:${batch.variantId}`;
      const prodName = variantNameMap.get(batch.variantId) ?? `#${batch.variantId}`;
      const batchNotes = input.notes?.trim()
        ? `${input.notes.trim()} [حزمة ${bundleDocGroupRef} - بكج: ${bundle.name} (#${input.bundleVariantId})]`
        : `إنتاج مكوّن ${prodName} لحزمة بكج: ${bundle.name} [حزمة ${bundleDocGroupRef} - بكج #${input.bundleVariantId}]`;

      const rawLabor = batch.laborPerUnit != null ? String(batch.laborPerUnit).trim() : undefined;
      const cleanLabor = rawLabor && rawLabor !== "" ? rawLabor : undefined;

      const batchLines = linesByRecipeId.get(batch.recipeId) ?? [];
      const batchInputIds = new Set(batchLines.map((l) => Number(l.inputVariantId)));
      const rawSubs = [
        ...(input.materialSubstitutions ?? []),
        ...(batch.materialSubstitutions ?? []),
      ].filter(
        (s) =>
          batchInputIds.has(Number(s.originalVariantId)) &&
          (s.recipeId == null || Number(s.recipeId) === batch.recipeId)
      );

      const relevantSubs: MaterialSubstitutionItem[] = rawSubs.map((s) => {
        const line = batchLines.find((l) => Number(l.inputVariantId) === Number(s.originalVariantId));
        return {
          recipeId: batch.recipeId,
          originalVariantId: Number(s.originalVariantId),
          substituteVariantId: Number(s.substituteVariantId),
          substituteProductUnitId: s.substituteProductUnitId ?? null,
          qtyPerOutputBase:
            s.recipeId != null
              ? String(s.qtyPerOutputBase)
              : line
              ? String(line.qtyPerOutputBase)
              : String(s.qtyPerOutputBase),
        };
      });

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

      const goodQty = batch.batchQty - (batch.scrapQty ?? 0);
      orders.push({
        productionOrderId: prodResult.productionOrderId,
        docNumber: prodResult.docNumber,
        variantId: batch.variantId,
        productName: prodName,
        goodQty,
        totalCost: prodResult.totalCost,
      });

      totalCostAccumulator = totalCostAccumulator.plus(money(prodResult.totalCost));
    }

    // ④ مزامنة ختامية موحدة لكافة البكجات المتأثرة
    await syncBundlesContainingComponents(tx, variantIds);

    // ⑤ قراءة التكلفة المحدثة للبكج الناتج
    const costMap = await loadBundleUnitCosts(tx, [input.bundleVariantId]);
    const updatedBundleUnitCost = costMap.get(input.bundleVariantId) ?? "0.00";

    return {
      bundleVariantId: input.bundleVariantId,
      bundleDocGroupRef,
      orders,
      totalCostAllOrders: round2(totalCostAccumulator).toFixed(2),
      updatedBundleUnitCost,
    };
  });
}
