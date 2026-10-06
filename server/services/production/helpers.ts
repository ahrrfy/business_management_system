import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, inArray, like } from "drizzle-orm";
import { appErrorMessage } from "../../../shared/errors";
import {
  productUnits,
  productVariants,
  products,
  productionOrders,
  productionRecipeLines,
  productionRecipes,
} from "../../../drizzle/schema";
import { convertToBaseQuantity } from "../inventoryService";
import { money, round2, toDateStr } from "../money";
import type { Actor } from "../tx";
import type {
  CreateProductionInput,
  ProductionLineInput,
  ResolvedLine,
  RunPlan,
} from "./types";

/** يحلّ سطراً إلى كمية أساس صحيحة (عبر الوحدة أو مباشرة). */
async function resolveLine(tx: any, line: ProductionLineInput): Promise<ResolvedLine> {
  if (!Number.isInteger(line.variantId) || line.variantId <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صنف غير صالح في أحد الأسطر" });
  }
  let baseQuantity: number;
  let quantity: string;
  if (line.productUnitId != null && line.quantity != null) {
    const conv = await convertToBaseQuantity(tx, line.productUnitId, line.quantity, line.variantId);
    baseQuantity = conv.baseQuantity;
    quantity = money(line.quantity).toFixed(4);
  } else {
    if (line.productUnitId != null) await convertToBaseQuantity(tx, line.productUnitId, "1", line.variantId);
    if (line.baseQuantity == null || !Number.isInteger(line.baseQuantity) || line.baseQuantity <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً" });
    }
    baseQuantity = line.baseQuantity;
    quantity = money(line.baseQuantity).toFixed(4);
  }
  return {
    variantId: line.variantId,
    productUnitId: line.productUnitId ?? null,
    quantity,
    baseQuantity,
    manualSharePct: line.manualSharePct != null && String(line.manualSharePct).trim() !== "" ? money(line.manualSharePct).toFixed(4) : null,
  };
}

/** رقم مستند إنتاج تسلسلي لكل فرع/يوم (مثل WO): PRD-<branch>-<YYYYMMDD>-<seq>. */
async function nextProductionNumber(tx: any, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `PRD-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: productionOrders.docNumber })
    .from(productionOrders)
    .where(like(productionOrders.docNumber, `${prefix}%`))
    .orderBy(desc(productionOrders.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** عزل الفرع (قرار المالك ١٢/٨: عزل مدير الفرع): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛
 *  المدير مقيَّدٌ بفرعه المُسنَد. */
function assertProductionBranch(po: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin";
  if (elevated) return;
  if (Number(po.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "المستند لا يخصّ فرعك" });
  }
}

/**
 * يوسّع وصفة إلى خطة تشغيل مُحلّلة (مدخلات/مخرَج + عمالة + بارامترات الهدر) — **خادمياً** (لا ثقة بالعميل).
 * الاستهلاك = qtyPerOutputBase × batch (يفرض عدداً صحيحاً)؛ المخرَج = good = batch − scrap.
 */
async function resolveRunPlan(tx: any, run: NonNullable<CreateProductionInput["run"]>): Promise<RunPlan> {
  const head = (
    await tx
      .select({
        outputVariantId: productionRecipes.outputVariantId,
        outputProductUnitId: productionRecipes.outputProductUnitId,
        laborPerOutputBase: productionRecipes.laborPerOutputBase,
        wasteStdPct: productionRecipes.wasteStdPct,
        isActive: productionRecipes.isActive,
      })
      .from(productionRecipes)
      .where(eq(productionRecipes.id, run.recipeId))
      .limit(1)
  )[0];
  if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
  if (!head.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة معطّلة" });
  const outputUnit = (await tx.select({ variantId: productUnits.variantId, isBaseUnit: productUnits.isBaseUnit, isActive: productUnits.isActive })
    .from(productUnits).where(eq(productUnits.id, Number(head.outputProductUnitId))).limit(1))[0];
  if (!outputUnit || Number(outputUnit.variantId) !== Number(head.outputVariantId) || !outputUnit.isBaseUnit || !outputUnit.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وحدة ناتج الوصفة غير صالحة للإنتاج؛ يجب أن تكون الوحدة الأساسية النشطة للصنف الناتج" });
  }

  const batch = Number(run.batchQty);
  if (!Number.isSafeInteger(batch) || batch <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "عدد الدفعة يجب أن يكون عدداً صحيحاً موجباً" });
  const scrap = Number(run.scrapQty ?? 0);
  if (!Number.isSafeInteger(scrap) || scrap < 0 || scrap > batch) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "كمية التالف يجب أن تكون عدداً صحيحاً بين صفر وحجم الدفعة" });
  }
  const good = batch - scrap;
  if (good <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "السليم الناتج يجب أن يكون موجباً (التالف لا يساوي الدفعة كلّها)" });

  const recLines = await tx
    .select({
      inputVariantId: productionRecipeLines.inputVariantId,
      inputProductUnitId: productionRecipeLines.inputProductUnitId,
      qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
      productName: products.name,
    })
    .from(productionRecipeLines)
    .leftJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productionRecipeLines.recipeId, run.recipeId))
    .orderBy(productionRecipeLines.id);
  if (!recLines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة بلا مكوّنات" });

  const substitutions = run.materialSubstitutions ?? [];
  const recInputIds = new Set(recLines.map((l: any) => Number(l.inputVariantId)));
  const seenOriginals = new Set<number>();
  for (const s of substitutions) {
    const origId = Number(s.originalVariantId);
    if (!recInputIds.has(origId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر استبدال مادة الوصفة",
          why: `الصنف الأصلي #${origId} ليس مكوّناً مسجلاً في الوصفة`,
          doThis: "حدّث بيانات التشغيل وتأكد من اختيار مكوّن موجود في الوصفة",
        }),
      });
    }
    if (seenOriginals.has(origId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تكرار استبدال المادة",
          why: `تم إرسال أكثر من بديل لنفس المادة الأصلية #${origId}`,
          doThis: "حدد بديلاً واحداً لكل مادة أصلية",
        }),
      });
    }
    seenOriginals.add(origId);
    if (Number(s.substituteVariantId) === origId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر استبدال مادة الوصفة",
          why: `المادة البديلة للصنف #${origId} مطابقة للمادة الأصلية — لا يمكن استبدال المادة بنفسها`,
          doThis: "اختر صنفاً بديلاً مختلفاً عن المادة الأصلية",
        }),
      });
    }
    if (Number(s.substituteVariantId) === Number(head.outputVariantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر استبدال مادة الوصفة",
          why: "المنتج الناتج لا يمكن أن يكون مادة بديلة لنفسه",
          doThis: "اختر صنفاً خاماً مختلفاً عن ناتج الوصفة",
        }),
      });
    }
  }

  const subUnitsToValidate = substitutions
    .filter((s) => s.substituteProductUnitId != null)
    .map((s) => ({
      unitId: Number(s.substituteProductUnitId),
      variantId: Number(s.substituteVariantId),
    }));
  if (subUnitsToValidate.length > 0) {
    const unitRows = await tx
      .select({
        id: productUnits.id,
        variantId: productUnits.variantId,
        isActive: productUnits.isActive,
      })
      .from(productUnits)
      .where(inArray(productUnits.id, subUnitsToValidate.map((u) => u.unitId)));
    const unitMap = new Map<number, any>(unitRows.map((r: any) => [Number(r.id), r]));
    for (const u of subUnitsToValidate) {
      const row = unitMap.get(u.unitId);
      if (!row || Number(row.variantId) !== u.variantId || !row.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر استبدال مادة الوصفة",
            why: `وحدة القياس المحددة للمادة البديلة #${u.variantId} لا تخص الصنف أو معطّلة`,
            doThis: "اختر وحدة قياس صحيحة ونشطة تابعة للمادة البديلة",
          }),
        });
      }
    }
  }

  const subMap = new Map(substitutions.map((s) => [Number(s.originalVariantId), s]));

  let subNameMap = new Map<number, string>();
  if (substitutions.length > 0) {
    const subVarIds = Array.from(new Set(substitutions.map((s) => Number(s.substituteVariantId))));
    const subVarRows = await tx
      .select({ variantId: productVariants.id, productName: products.name })
      .from(productVariants)
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, subVarIds));
    subNameMap = new Map(subVarRows.map((r: any) => [Number(r.variantId), String(r.productName ?? `#${r.variantId}`)]));
  }

  const inLines: ResolvedLine[] = recLines.map((l: any) => {
    const origId = Number(l.inputVariantId);
    const sub = subMap.get(origId);
    const effectiveVariantId = sub ? Number(sub.substituteVariantId) : origId;
    const effectiveProductUnitId = sub
      ? (sub.substituteProductUnitId ?? null)
      : (l.inputProductUnitId != null ? Number(l.inputProductUnitId) : null);
    const effectiveQtyPerOutputBase = sub?.qtyPerOutputBase ? String(sub.qtyPerOutputBase) : String(l.qtyPerOutputBase);
    const displayName = sub ? subNameMap.get(effectiveVariantId) ?? `بديل #${effectiveVariantId}` : l.productName ?? origId;

    const qtyDec = new Decimal(effectiveQtyPerOutputBase);
    if (qtyDec.decimalPlaces() > 4 || qtyDec.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر استبدال مادة الوصفة",
          why: `كمية المادة البديلة «${displayName}» غير صالحة (يجب أن تكون رقماً موجباً بأربع منازل عشرية كحد أقصى)`,
          doThis: "عدّل كمية المادة البديلة بحيث لا تتجاوز 4 منازل عشرية وتكون أكبر من صفر",
        }),
      });
    }

    const consumed = qtyDec.times(batch);
    if (!consumed.isInteger()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `استهلاك «${displayName}» (${consumed.toString()}) ليس عدداً صحيحاً — عدّل الدفعة أو الوصفة` });
    }
    return {
      variantId: effectiveVariantId,
      productUnitId: effectiveProductUnitId,
      quantity: consumed.toFixed(4),
      baseQuantity: consumed.toNumber(),
      manualSharePct: null,
    };
  });

  const outLines: ResolvedLine[] = [
    { variantId: Number(head.outputVariantId), productUnitId: Number(head.outputProductUnitId), quantity: money(good).toFixed(4), baseQuantity: good, manualSharePct: null },
  ];

  const perUnit = run.laborPerUnit != null && String(run.laborPerUnit).trim() !== "" ? money(run.laborPerUnit) : money(head.laborPerOutputBase ?? "0");
  if (perUnit.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمالة لا يمكن أن تكون سالبة" });
  const laborCost = round2(perUnit.times(batch));

  return { inLines, outLines, laborCost, spoilage: { batch, scrap, good, wasteStdPct: money(head.wasteStdPct ?? "0") } };
}


// تصدير داخلي للحزمة فقط (يستهلكه create/cancel/queries) — لا يُعاد تصديره من البرميل
// productionService.ts.
export { resolveLine, nextProductionNumber, assertProductionBranch, resolveRunPlan };
