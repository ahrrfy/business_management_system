import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { quantityNumber } from "@shared/quantity";
import type { RecipeLineSelection, RecipeLineSelectionWithMeta } from "@shared/recipeVariantSelection";
import { variantDescriptor } from "@shared/variantDisplay";
import { and, eq, inArray } from "drizzle-orm";

import {
  invoiceItemServiceMaterials,
  productionRecipeLines,
  productionRecipes,
  productVariants,
  products,
} from "../../drizzle/schema";
import type { getDb, Tx } from "../db";
import { assertStockedOwnedMaterials } from "./inventory/materialEligibility";
import { money } from "./money";

export const SERVICE_RECIPE_CONSUMPTION_NOTE = "استهلاك مادة خدمة";

export interface ServiceRecipeLine {
  id: number;
  inputVariantId: number;
  qtyPerOutputBase: string;
  allowVariantChoice: boolean;
}

export interface ServiceRecipeDefinition {
  recipeId: number;
  outputVariantId: number;
  lines: ServiceRecipeLine[];
}

export interface ResolvedServiceRecipeLine {
  recipeLineId: number;
  variantId: number;
  qtyPerOutputBase: string;
}

/**
 * يحل وصفة مواد الخدمة حلاً فاشلاً مغلقاً:
 * - لا تاريخ وصفة = خدمة عمالية/رمزية مشروعة.
 * - تاريخ موجود بلا فعالة = إعداد معطّل، لا يتحول بصمت إلى COGS صفر.
 * - أكثر من فعالة أو فعالة بلا أسطر = فساد إعداد يمنع البيع.
 * - كل مكوّن يعاد التحقق من كونه مخزوناً مملوكاً ونشطاً وقت الاستهلاك.
 */
export async function discoverServiceRecipeDefinitions(
  tx: Tx,
  outputVariantIds: readonly number[],
  options: { lock?: boolean } = {},
): Promise<Map<number, ServiceRecipeDefinition>> {
  const outputIds = Array.from(new Set(outputVariantIds.map(Number))).sort((a, b) => a - b);
  if (!outputIds.length) return new Map();

  // قراءة الوصفة لقطة واحدة داخل المعاملة. لا نقفل الرأس قبل المواد: الكاتب يقفل اتحاد
  // output+materials بترتيب variantId، وقفل الرأس أولاً يعكس الترتيب ويصنع deadlock.
  // إن تزامن إنشاء أول وصفة مع هذه المعاملة فهذه العملية تُرتَّب منطقياً قبله وتبقى عمالية.
  const headsQuery = tx
    .select({
      id: productionRecipes.id,
      outputVariantId: productionRecipes.outputVariantId,
      isActive: productionRecipes.isActive,
    })
    .from(productionRecipes)
    .where(inArray(productionRecipes.outputVariantId, outputIds))
    .orderBy(productionRecipes.outputVariantId, productionRecipes.id);
  const heads = options.lock === true ? await headsQuery.for("update") : await headsQuery;

  const historyByOutput = new Map<number, typeof heads>();
  for (const head of heads) {
    const outputId = Number(head.outputVariantId);
    const list = historyByOutput.get(outputId) ?? [];
    list.push(head);
    historyByOutput.set(outputId, list);
  }

  const activeHeads: Array<{ id: number; outputVariantId: number }> = [];
  for (const outputId of outputIds) {
    const history = historyByOutput.get(outputId) ?? [];
    const active = history.filter((head) => head.isActive === true);
    if (active.length > 1) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر بيع الخدمة #${outputId}`,
          why: "مرتبطة بأكثر من وصفة مواد فعّالة",
          doThis: "عطّل الوصفات الزائدة واترك وصفة فعّالة واحدة فقط",
        }),
      });
    }
    if (!active.length && history.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر بيع الخدمة #${outputId}`,
          why: "وصفة مواد الخدمة معطلة حالياً رغم وجود تعريف تاريخي لها",
          doThis: "فعّل وصفة مواد واحدة أو راجع إعداد الخدمة",
        }),
      });
    }
    if (active[0]) {
      activeHeads.push({ id: Number(active[0].id), outputVariantId: outputId });
    }
  }
  if (!activeHeads.length) return new Map();

  const recipeIds = activeHeads.map((head) => head.id);
  const rowsQuery = tx
    .select({
      id: productionRecipeLines.id,
      recipeId: productionRecipeLines.recipeId,
      inputVariantId: productionRecipeLines.inputVariantId,
      qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
      allowVariantChoice: productionRecipeLines.allowVariantChoice,
    })
    .from(productionRecipeLines)
    .where(inArray(productionRecipeLines.recipeId, recipeIds))
    .orderBy(productionRecipeLines.recipeId, productionRecipeLines.id);
  const rows = options.lock === true ? await rowsQuery.for("update") : await rowsQuery;

  const linesByRecipe = new Map<number, ServiceRecipeLine[]>();
  for (const row of rows) {
    const recipeId = Number(row.recipeId);
    const list = linesByRecipe.get(recipeId) ?? [];
    list.push({
      id: Number(row.id),
      inputVariantId: Number(row.inputVariantId),
      qtyPerOutputBase: String(row.qtyPerOutputBase),
      allowVariantChoice: row.allowVariantChoice === true,
    });
    linesByRecipe.set(recipeId, list);
  }

  const definitions = new Map<number, ServiceRecipeDefinition>();
  for (const head of activeHeads) {
    const lines = linesByRecipe.get(head.id) ?? [];
    if (!lines.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `وصفة الخدمة #${head.id} غير قابلة للتنفيذ`,
          why: "وصفة مواد الخدمة فعالة لكنها بلا مواد",
          doThis: "أضف مواد الوصفة أو عطّلها قبل البيع",
        }),
      });
    }
    definitions.set(head.outputVariantId, {
      recipeId: head.id,
      outputVariantId: head.outputVariantId,
      lines,
    });
  }
  return definitions;
}

/** بصمة حتمية تغلق نافذة تغيّر رأس/أسطر وصفة الخدمة بين الاكتشاف وقفل الأصناف. */
export function serviceRecipeDefinitionsFingerprint(
  definitions: Map<number, ServiceRecipeDefinition>,
): string {
  return JSON.stringify(
    Array.from(definitions.entries())
      .sort(([a], [b]) => a - b)
      .map(([outputVariantId, definition]) => [
        outputVariantId,
        definition.recipeId,
        [...definition.lines]
          .sort(
            (a, b) =>
              a.id - b.id ||
              a.inputVariantId - b.inputVariantId ||
              a.qtyPerOutputBase.localeCompare(b.qtyPerOutputBase),
          )
          .map((line) => [line.id, line.inputVariantId, line.qtyPerOutputBase, line.allowVariantChoice]),
      ]),
  );
}

export function assertNoUnexpectedRecipeSelections(
  selections: readonly RecipeLineSelection[] | null | undefined,
  label = "البند",
): void {
  if (!selections?.length) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what: `اختيارات مواد غير صالحة على ${label}`,
      why: "هذا البند لا يملك وصفة خدمة نشطة تدعم اختيار متغيّر المادة عند الطلب",
      doThis: "أزل اختيارات المتغيّر من السطر أو راجع تعريف وصفة الخدمة",
    }),
  });
}

/**
 * يتحقق من اختيارات متغيّرات/ألوان مواد الوصفة ويُبدّل inputVariantId الفعلي لكل سطر وصفة (بمفتاح recipeLineId).
 * - يرفض غياب الاختيار لأي سطر يحمل allowVariantChoice=true.
 * - يرفض التكرار، أو سطر وصفة غير تابع للخدمة، أو تبديل سطر ثابت، أو التزوير عبر منتج مختلف.
 */
export async function resolveRecipeLineSelections(
  tx: Tx,
  recipeLines: readonly ServiceRecipeLine[],
  selections?: readonly RecipeLineSelection[] | null,
): Promise<ResolvedServiceRecipeLine[]> {
  const lineById = new Map<number, ServiceRecipeLine>(
    recipeLines.map((line) => [Number(line.id), line]),
  );
  const selectionByLineId = new Map<number, number>();
  for (const sel of selections ?? []) {
    const recipeLineId = Number(sel.recipeLineId);
    const variantId = Number(sel.variantId);
    if (!Number.isInteger(recipeLineId) || recipeLineId <= 0 || !Number.isInteger(variantId) || variantId <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "اختيار متغيّر مادة الوصفة غير صالح",
          why: "معرّف سطر الوصفة أو المتغيّر غير صحيح",
          doThis: "أعد اختيار لون/متغيّر المادة من الشاشة ثم أعد المحاولة",
        }),
      });
    }
    if (selectionByLineId.has(recipeLineId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعارض في اختيارات مواد الوصفة",
          why: `تكرر الاختيار لسطر الوصفة #${recipeLineId}`,
          doThis: "أرسل اختياراً واحداً فقط لكل سطر وصفة قابل للتخصيص",
        }),
      });
    }
    const matchedLine = lineById.get(recipeLineId);
    if (!matchedLine) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "اختيار مادة لا يخص وصفة الخدمة",
          why: `سطر الوصفة #${recipeLineId} غير موجود ضمن الوصفة النشطة لهذه الخدمة`,
          doThis: "حدّث الشاشة وأعد اختيار متغيّرات الوصفة الحالية",
        }),
      });
    }
    if (!matchedLine.allowVariantChoice && variantId !== matchedLine.inputVariantId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يُسمح بتغيير مادة ثابتة في الوصفة",
          why: `سطر الوصفة #${recipeLineId} غير مفعّل لاختيار اللون/المتغيّر عند الطلب`,
          doThis: "فعّل خيار «تحديد اللون/المتغير عند الطلب» في الوصفة أو التزم بالمادة الأصلية",
        }),
      });
    }
    selectionByLineId.set(recipeLineId, variantId);
  }

  const chosenChecks: Array<{ line: ServiceRecipeLine; chosenVariantId: number }> = [];
  for (const line of recipeLines) {
    if (!line.allowVariantChoice) continue;
    const chosenVariantId = selectionByLineId.get(line.id);
    if (chosenVariantId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "يلزم تحديد اللون/المتغيّر لمادة الوصفة",
          why: `سطر الوصفة #${line.id} يتطلب اختيار متغيّر/لون عند الطلب`,
          doThis: "اختر اللون أو المتغيّر المطلوب لكل مادة ثم أعد الإرسال",
        }),
      });
    }
    chosenChecks.push({ line, chosenVariantId });
  }

  if (chosenChecks.length > 0) {
    const variantIdsToVerify = Array.from(
      new Set([
        ...chosenChecks.map((c) => c.line.inputVariantId),
        ...chosenChecks.map((c) => c.chosenVariantId),
      ]),
    ).sort((a, b) => a - b);
    const variantRows = await tx
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        variantActive: productVariants.isActive,
        productActive: products.isActive,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIdsToVerify));
    const variantMap = new Map(variantRows.map((r) => [Number(r.id), r]));
    for (const { line, chosenVariantId } of chosenChecks) {
      const defVar = variantMap.get(line.inputVariantId);
      const chosenVar = variantMap.get(chosenVariantId);
      if (!defVar || !chosenVar) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "متغيّر المادة المختار غير موجود",
            why: `تعذّر العثور على المتغيّر #${chosenVariantId} في الكتالوج`,
            doThis: "حدّث الشاشة واختر متغيّراً نشطاً من القائمة",
          }),
        });
      }
      if (chosenVar.variantActive !== true || chosenVar.productActive !== true) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "متغيّر المادة المختار معطّل",
            why: `المتغيّر #${chosenVariantId} أو منتجه غير نشط حالياً`,
            doThis: "اختر لوناً أو متغيّراً نشطاً آخر",
          }),
        });
      }
      if (Number(chosenVar.productId) !== Number(defVar.productId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "المتغيّر المختار لا يتبع مادة الوصفة نفسها",
            why: `المتغيّر #${chosenVariantId} يتبع منتجاً مختلفاً عن مادة سطر الوصفة #${line.id}`,
            doThis: "اختر متغيّراً أو لوناً من نفس المنتج المحدد في الوصفة",
          }),
        });
      }
    }
    await assertStockedOwnedMaterials(
      tx,
      Array.from(new Set(chosenChecks.map((c) => c.chosenVariantId))).sort((a, b) => a - b),
      "متغيّر مادة الوصفة المختار",
    );
  }

  return recipeLines.map((line) => ({
    recipeLineId: line.id,
    variantId: line.allowVariantChoice
      ? selectionByLineId.get(line.id)!
      : line.inputVariantId,
    qtyPerOutputBase: line.qtyPerOutputBase,
  }));
}

/**
 * واجهة الاستهلاك العامة: تقرأ التعريف ثم تقفل/تتحقق موادَه كأصناف مخزنية مملوكة.
 * المسارات التي تحتاج قفل اتحاد أكبر (بيع مختلط/بكج) تستخدم discover أولاً، تقفل الاتحاد،
 * تعيد discover وتقارن البصمة، ثم تستدعي assertStockedOwnedMaterials على المواد الحالية.
 */
export async function loadServiceRecipeDefinitions(
  tx: Tx,
  outputVariantIds: readonly number[],
): Promise<Map<number, ServiceRecipeDefinition>> {
  const definitions = await discoverServiceRecipeDefinitions(
    tx,
    outputVariantIds,
  );
  const materialIds = Array.from(definitions.values()).flatMap((definition) =>
    definition.lines.map((line) => line.inputVariantId),
  );
  await assertStockedOwnedMaterials(tx, materialIds, "مكوّن وصفة الخدمة");
  return definitions;
}

/**
 * استهلاك فعلي دقيق حتى أربع منازل، بلا تقريب إلى وحدة كاملة أو إلى دقة التخزين.
 */
export function exactRecipeMaterialQuantity(
  qtyPerOutputBase: string,
  outputBaseQuantity: number,
  label = "مادة الوصفة",
): number {
  const quantity = money(qtyPerOutputBase).times(outputBaseQuantity);
  if (!quantity.isFinite() || quantity.decimalPlaces() > 4) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر احتساب ${label}`,
        why: `الكمية الناتجة (${quantity.toString()}) تتجاوز دقة الأربع منازل العشرية`,
        doThis: "أدخل معامل وصفة وكمية خدمة ينتجان كمية قابلة للحفظ بأربع منازل عشرية أو أقل",
      }),
    });
  }
  if (quantity.lte(0) || quantity.gt("99999999999.9999")) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر احتساب ${label}`,
        why: "الكمية الناتجة غير موجبة أو تتجاوز الحد الآمن",
        doThis: "راجع كمية الخدمة ومعامل استهلاك المادة في الوصفة",
      }),
    });
  }
  return quantityNumber(quantity);
}

/**
 * تحميل اختيارات سطور الوصفة الصريحة لسطور فواتير POS مع توافق رجعي للطلبات التاريخية.
 */
export async function loadLineRecipeSelections(
  db: Pick<NonNullable<ReturnType<typeof getDb>>, "select">,
  items: ReadonlyArray<{
    id: number;
    variantId: number;
    recipeSelections?: RecipeLineSelection[] | null;
  }>,
): Promise<Map<number, RecipeLineSelectionWithMeta[]>> {
  const byItem = new Map<number, RecipeLineSelectionWithMeta[]>();
  if (items.length === 0) return byItem;

  const explicitVariantIds = new Set<number>();
  const legacyItems: Array<{ id: number; variantId: number }> = [];
  for (const item of items) {
    if (Array.isArray(item.recipeSelections) && item.recipeSelections.length > 0) {
      for (const sel of item.recipeSelections) {
        explicitVariantIds.add(Number(sel.variantId));
      }
    } else {
      legacyItems.push({ id: Number(item.id), variantId: Number(item.variantId) });
    }
  }

  if (explicitVariantIds.size > 0) {
    const variantMetaRows = await db
      .select({
        variantId: productVariants.id,
        materialName: products.name,
        variantName: productVariants.variantName,
        color: productVariants.color,
        colorHex: productVariants.colorHex,
        size: productVariants.size,
        variantKind: productVariants.variantKind,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, Array.from(explicitVariantIds)));
    const metaByVariantId = new Map(variantMetaRows.map((row) => [Number(row.variantId), row]));
    for (const item of items) {
      if (!Array.isArray(item.recipeSelections) || item.recipeSelections.length === 0) continue;
      const hydrated: RecipeLineSelectionWithMeta[] = item.recipeSelections.map((sel) => {
        const vid = Number(sel.variantId);
        const meta = metaByVariantId.get(vid);
        const label = meta
          ? variantDescriptor({
              variantName: meta.variantName,
              color: meta.color,
              size: meta.size,
              variantKind: meta.variantKind,
              sku: meta.sku,
            })
          : "";
        return {
          recipeLineId: Number(sel.recipeLineId),
          variantId: vid,
          materialName: meta?.materialName,
          label: label || `#${vid}`,
          color: meta?.color ?? null,
          colorHex: meta?.colorHex ?? null,
        };
      });
      byItem.set(Number(item.id), hydrated);
    }
  }

  if (legacyItems.length === 0) return byItem;

  const itemIds = legacyItems.map((i) => i.id);
  const serviceVariantIds = Array.from(new Set(legacyItems.map((i) => i.variantId)));

  const usedMaterials = await db
    .select({
      invoiceItemId: invoiceItemServiceMaterials.invoiceItemId,
      materialVariantId: invoiceItemServiceMaterials.materialVariantId,
      materialProductId: productVariants.productId,
      materialName: products.name,
      variantName: productVariants.variantName,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      size: productVariants.size,
      variantKind: productVariants.variantKind,
      sku: productVariants.sku,
    })
    .from(invoiceItemServiceMaterials)
    .innerJoin(productVariants, eq(invoiceItemServiceMaterials.materialVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(invoiceItemServiceMaterials.invoiceItemId, itemIds));

  if (usedMaterials.length === 0) return byItem;

  const customizableLines = await db
    .select({
      outputVariantId: productionRecipes.outputVariantId,
      recipeLineId: productionRecipeLines.id,
      inputProductId: productVariants.productId,
    })
    .from(productionRecipes)
    .innerJoin(productionRecipeLines, eq(productionRecipeLines.recipeId, productionRecipes.id))
    .innerJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
    .where(
      and(
        inArray(productionRecipes.outputVariantId, serviceVariantIds),
        eq(productionRecipes.isActive, true),
        eq(productionRecipeLines.allowVariantChoice, true),
      ),
    );

  if (customizableLines.length === 0) return byItem;

  const customLinesByService = new Map<number, typeof customizableLines>();
  for (const line of customizableLines) {
    const ov = Number(line.outputVariantId);
    const list = customLinesByService.get(ov) ?? [];
    list.push(line);
    customLinesByService.set(ov, list);
  }

  const matsByItem = new Map<number, typeof usedMaterials>();
  for (const m of usedMaterials) {
    const ii = Number(m.invoiceItemId);
    const list = matsByItem.get(ii) ?? [];
    list.push(m);
    matsByItem.set(ii, list);
  }

  for (const item of legacyItems) {
    const customLines = customLinesByService.get(item.variantId);
    const itemMats = matsByItem.get(item.id);
    if (!customLines?.length || !itemMats?.length) continue;

    const remainingMats = [...itemMats];
    const selections: RecipeLineSelectionWithMeta[] = [];
    for (const cl of customLines) {
      const idx = remainingMats.findIndex((m) => Number(m.materialProductId) === Number(cl.inputProductId));
      if (idx < 0) continue;
      const [chosen] = remainingMats.splice(idx, 1);
      const label = variantDescriptor({
        variantName: chosen.variantName,
        color: chosen.color,
        size: chosen.size,
        variantKind: chosen.variantKind,
        sku: chosen.sku,
      });
      selections.push({
        recipeLineId: Number(cl.recipeLineId),
        variantId: Number(chosen.materialVariantId),
        materialName: chosen.materialName,
        label: label || `#${chosen.materialVariantId}`,
        color: chosen.color,
        colorHex: chosen.colorHex,
      });
    }
    if (selections.length > 0) {
      byItem.set(item.id, selections);
    }
  }
  return byItem;
}
