import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { inArray } from "drizzle-orm";

import { productionRecipeLines, productionRecipes } from "../../drizzle/schema";
import type { Tx } from "../db";
import { assertStockedOwnedMaterials } from "./inventory/materialEligibility";
import { money } from "./money";

export const SERVICE_RECIPE_CONSUMPTION_NOTE = "استهلاك مادة خدمة";

export interface ServiceRecipeLine {
  inputVariantId: number;
  qtyPerOutputBase: string;
}

export interface ServiceRecipeDefinition {
  recipeId: number;
  outputVariantId: number;
  lines: ServiceRecipeLine[];
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
      recipeId: productionRecipeLines.recipeId,
      inputVariantId: productionRecipeLines.inputVariantId,
      qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
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
      inputVariantId: Number(row.inputVariantId),
      qtyPerOutputBase: String(row.qtyPerOutputBase),
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
              a.inputVariantId - b.inputVariantId ||
              a.qtyPerOutputBase.localeCompare(b.qtyPerOutputBase),
          )
          .map((line) => [line.inputVariantId, line.qtyPerOutputBase]),
      ]),
  );
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
 * المخزون محفوظ بوحدات أساس صحيحة. التقريب الصامت كان يجعل 0.4×1 صفراً و0.6×1 واحداً؛
 * لذلك نرفض أي تحجيم لا ينتج عدداً صحيحاً ونطلب اختيار كمية/وحدة وصفة قابلة للتتبع.
 */
export function exactRecipeMaterialQuantity(
  qtyPerOutputBase: string,
  outputBaseQuantity: number,
  label = "مادة الوصفة",
): number {
  const quantity = money(qtyPerOutputBase).times(outputBaseQuantity);
  if (!quantity.isInteger()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر احتساب ${label}`,
        why: `نتجت كمية كسرية (${quantity.toString()}) لا يمكن تتبعها بوحدة الأساس`,
        doThis: "عدّل معامل الوصفة أو كمية الخدمة لتنتج عدداً صحيحاً من وحدات الأساس",
      }),
    });
  }
  if (quantity.lte(0) || quantity.gt(Number.MAX_SAFE_INTEGER)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر احتساب ${label}`,
        why: "الكمية الناتجة غير موجبة أو تتجاوز الحد الآمن",
        doThis: "راجع كمية الخدمة ومعامل استهلاك المادة في الوصفة",
      }),
    });
  }
  return quantity.toNumber();
}
