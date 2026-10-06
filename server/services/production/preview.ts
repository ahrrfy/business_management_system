// معاينة «التشغيل بوصفة» حيّةً (بلا أي حركة) — نفس صيغة الحساب وWAVG التي يطبّقها createProduction.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq, inArray, sql } from "drizzle-orm";
import {
  branchStock,
  productUnits,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
} from "../../../drizzle/schema";
import { batchMultipleNote, requiredBatchMultiple } from "../../../shared/batchDivisibility";
import { appErrorMessage } from "../../../shared/errors";
import type { MaterialSubstitutionItem } from "../../../shared/recipeSubstitutionTypes";
import { loadVariantAvailability } from "../catalog/variantAvailability";
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
  materialSubstitutions?: MaterialSubstitutionItem[] | null;
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
          outputIsService: products.isService,
          outputIsBundle: products.isBundle,
          outputIsConsignment: products.isConsignment,
          outputSku: productVariants.sku,
          outputUnitName: productUnits.unitName,
          outputUnitVariantId: productUnits.variantId,
          outputUnitIsBase: productUnits.isBaseUnit,
          outputUnitIsActive: productUnits.isActive,
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
    if (head.outputIsService) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن تشغيل وصفة خدمة كإنتاج مخزني",
          why: "ناتج الوصفة منتج خدمي لا يُخزَّن — تُستهلك مكوّناته تلقائياً لحظة بيع الخدمة",
          doThis: "استعمل وصفة الخدمة من فاتورة البيع، أو اختر وصفةً ناتجها صنف مخزني",
        }),
      });
    }
    if (head.outputIsBundle) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن تشغيل وصفة بكج كأمر إنتاج",
          why: "البكج تجميعٌ يُوسَّع إلى مكوّناته عند البيع ولا يُخزَّن كناتج تصنيع مستقل",
          doThis: "استعمل البكج من فاتورة البيع، أو اختر وصفةً ناتجها صنف مخزني",
        }),
      });
    }
    if (head.outputIsConsignment) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن تشغيل وصفة بضاعة أمانة كأمر إنتاج",
          why: "ناتج الأمانة أصل غير مملوك للمنشأة ولا يدخل تصنيع المخزون أو WAVG المملوك",
          doThis: "اختر وصفةً ناتجها صنف مخزني مملوك للمنشأة",
        }),
      });
    }
    if (!head.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة معطّلة" });
    if (Number(head.outputUnitVariantId) !== Number(head.outputVariantId) || !head.outputUnitIsBase || !head.outputUnitIsActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "وحدة ناتج الوصفة غير صالحة للإنتاج؛ يجب أن تكون الوحدة الأساسية النشطة للصنف الناتج" });
    }

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

    const substitutions = args.materialSubstitutions ?? [];
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

    let subDetailMap = new Map<number, any>();
    if (substitutions.length > 0) {
      const subVarIds = Array.from(new Set(substitutions.map((s) => Number(s.substituteVariantId))));
      const subRows = await tx
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          costPrice: productVariants.costPrice,
          variantActive: productVariants.isActive,
          productId: products.id,
          productName: products.name,
          productActive: products.isActive,
          isService: products.isService,
          isBundle: products.isBundle,
          isConsignment: products.isConsignment,
        })
        .from(productVariants)
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, subVarIds));

      if (subRows.length !== subVarIds.length) {
        const found = new Set(subRows.map((r: any) => Number(r.id)));
        const missing = subVarIds.find((id) => !found.has(id));
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "المادة البديلة غير موجودة",
            why: `تعذّر العثور على الصنف البديل #${missing}`,
            doThis: "اختر صنفاً معرفاً ونشطاً في كتالوج المنتجات",
          }),
        });
      }

      for (const r of subRows as any[]) {
        if (!r.productActive || !r.variantActive) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: `المادة البديلة «${r.productName ?? r.id}» معطّلة`,
              why: "الصنف البديل أو منتجه ليس نشطاً",
              doThis: "فعّل المنتج ومتغيّره أو اختر مادة بديلة نشطة",
            }),
          });
        }
        if (r.isService || r.isBundle || r.isConsignment) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: `المادة البديلة «${r.productName ?? r.id}» غير صالحة للإنتاج`,
              why: "المادة البديلة يجب أن تكون مخزوناً خاماً مملوكاً (ليست خدمة ولا بكج ولا أمانة)",
              doThis: "اختر صنفاً مخزنياً عادياً مملوكاً",
            }),
          });
        }
      }

      subDetailMap = new Map(subRows.map((r: any) => [Number(r.id), r]));
    }

    const effectiveLines = recLines.map((l: any) => {
      const origId = Number(l.inputVariantId);
      const sub = subMap.get(origId);
      if (!sub) {
        return {
          ...l,
          inputVariantId: origId,
          isSubstituted: false,
          originalVariantId: null,
          originalProductName: null,
          originalSku: null,
        };
      }
      const detail = subDetailMap.get(Number(sub.substituteVariantId));
      if (sub.qtyPerOutputBase) {
        const qtyDec = new Decimal(sub.qtyPerOutputBase);
        if (qtyDec.decimalPlaces() > 4 || qtyDec.lte(0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر استبدال مادة الوصفة",
              why: `كمية المادة البديلة «${detail?.productName ?? sub.substituteVariantId}» غير صالحة (يجب أن تكون رقماً موجباً بأربع منازل عشرية كحد أقصى)`,
              doThis: "عدّل كمية المادة البديلة بحيث لا تتجاوز 4 منازل عشرية وتكون أكبر من صفر",
            }),
          });
        }
      }
      return {
        inputVariantId: Number(sub.substituteVariantId),
        qtyPerOutputBase: sub.qtyPerOutputBase ? String(sub.qtyPerOutputBase) : String(l.qtyPerOutputBase),
        productName: detail?.productName ?? `بديل #${sub.substituteVariantId}`,
        sku: detail?.sku ?? null,
        costPrice: detail?.costPrice ?? "0",
        isSubstituted: true,
        originalVariantId: origId,
        originalProductName: l.productName ?? null,
        originalSku: l.sku ?? null,
      };
    });

    const coefficients = effectiveLines.map((l: any) => String(l.qtyPerOutputBase));
    const inVarIds = Array.from(new Set(effectiveLines.map((l: any) => Number(l.inputVariantId))));
    const costMap = new Map(effectiveLines.map((l: any) => [Number(l.inputVariantId), l.costPrice]));

    // المتاح بالفرع (للأشرطة وحارس النقص اللّيّن في الواجهة).
    const availMap = new Map<number, number>();
    if (args.branchId) {
      const availability = await loadVariantAvailability(
        tx,
        args.branchId,
        inVarIds,
      );
      for (const variantId of inVarIds) {
        availMap.set(
          variantId,
          availability.get(variantId)?.availableBase ?? 0,
        );
      }
    }

    // الحساب النقي (نفس منطق الترحيل).
    const perUnit = args.laborPerUnit != null && String(args.laborPerUnit).trim() !== "" ? money(args.laborPerUnit) : money(head.laborPerOutputBase ?? "0");
    const calc = computeRunCosts({
      recipeLines: effectiveLines.map((l: any) => ({ unitCost: round2(money(costMap.get(Number(l.inputVariantId)) ?? "0")), qtyPerOutputBase: new Decimal(l.qtyPerOutputBase) })),
      laborPerUnit: perUnit,
      wasteStdPct: money(head.wasteStdPct ?? "0"),
      batch,
      scrap,
    });

    /*
     * المضاعف المطلوب يُحسَب مرّةً هنا كي **تحمله رسالة الرفض**: «ليس عدداً صحيحاً» وحدها
     * تُخبر أنّ الدفعة خطأ ولا تقول أيّها صحيح، فيبقى المستعمل يجرّب أرقاماً عشوائية.
     */
    const batchMultiple = requiredBatchMultiple(coefficients);
    const multipleNote = batchMultipleNote(batchMultiple);

    const consumedByVariant = new Map<number, number>();
    for (const line of effectiveLines as any[]) {
      const variantId = Number(line.inputVariantId);
      const consumed = new Decimal(line.qtyPerOutputBase).times(calc.started);
      if (consumed.isInteger()) {
        consumedByVariant.set(
          variantId,
          (consumedByVariant.get(variantId) ?? 0) + consumed.toNumber(),
        );
      }
    }
    const inputs = effectiveLines.map((l: any) => {
      const perOut = new Decimal(l.qtyPerOutputBase);
      const consumedDec = perOut.times(calc.started);
      if (!consumedDec.isInteger()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "استهلاك مادة الإنتاج ليس عدداً صحيحاً",
            why: `استهلاك «${l.productName ?? l.inputVariantId}» (${consumedDec.toString()}) ليس عدداً صحيحاً — المخزون يُخصم بوحدات أساس صحيحة فقط.${multipleNote ? ` ${multipleNote}` : ""}`,
            doThis: "عدّل حجم الدفعة أو معيار المادة في الوصفة ليكون الناتج عدداً صحيحاً",
          }),
        });
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
        short:
          available != null &&
          (consumedByVariant.get(Number(l.inputVariantId)) ?? consumed) >
            available,
        unitCost: unitCost.toFixed(2),
        lineCost: round2(unitCost.times(consumed)).toFixed(2),
        isSubstituted: l.isSubstituted ?? false,
        originalVariantId: l.originalVariantId ?? null,
        originalProductName: l.originalProductName ?? null,
        originalSku: l.originalSku ?? null,
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
