// إنشاء مستند إنتاج: يستهلك المدخلات ويُنتج المخرجات ذرّياً + يُحدّث كلفة المخرجات (بلا قيد محاسبي).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { branchStock, productVariants, productionLines, productionOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement } from "../inventoryService";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
import { spoilageSplit } from "./calc";
import { nextProductionNumber, resolveLine, resolveRunPlan } from "./helpers";
import type { CreateProductionInput, CreateProductionResult, ResolvedLine, SpoilageParams } from "./types";

/** إنشاء مستند إنتاج: يستهلك المدخلات ويُنتج المخرجات ذرّياً + يُحدّث كلفة المخرجات (بلا قيد محاسبي). */
export async function createProduction(input: CreateProductionInput, actor: Actor): Promise<CreateProductionResult> {
  return withTx(async (tx) => {
    // ① إعادة idempotent.
    const replayId = await checkIdempotency(tx, "production.create", input.clientRequestId, idempotencyHash(input));
    if (replayId) {
      const ex = (
        await tx.select({ docNumber: productionOrders.docNumber, totalCost: productionOrders.totalCost })
          .from(productionOrders).where(eq(productionOrders.id, replayId)).limit(1)
      )[0];
      return { productionOrderId: replayId, docNumber: ex?.docNumber ?? "", totalCost: ex?.totalCost ?? "0.00", idempotent: true };
    }

    // ② تحقّق + تحليل الأسطر (تشغيل بوصفة أو مدخلات/مخرجات يدوية) + حارس التحويل الذاتي + وجود الأصناف.
    const { inLines, outLines, laborCost, spoilage, linkedRecipeId } = await resolveAndValidateLines(tx, input);

    // ③ رأس المستند (تكاليف مؤقّتة + حقول الإنتاجية إن كان تشغيلاً بوصفة).
    const docNumber = await nextProductionNumber(tx, input.branchId);
    const insRes = await tx.insert(productionOrders).values({
      docNumber,
      branchId: input.branchId,
      status: "CONFIRMED",
      materialsCost: "0",
      laborCost: laborCost.toFixed(2),
      totalCost: "0",
      batchQty: spoilage ? spoilage.batch : null,
      goodQty: spoilage ? spoilage.good : null,
      scrapQty: spoilage ? spoilage.scrap : 0,
      abnormalLoss: "0",
      wasteStdPct: spoilage ? round2(spoilage.wasteStdPct).toFixed(2) : "0",
      notes: input.notes?.trim() || null,
      linkedWorkOrderId: input.linkedWorkOrderId ?? null,
      linkedRecipeId,
      createdBy: actor.userId,
    });
    const productionOrderId = extractInsertId(insRes);
    // سجّل مفتاح idempotency فوراً ⇒ طلب متزامن مكرّر يصطدم بالقيد الفريد فيُلغى قبل أي حركة مخزون.
    if (input.clientRequestId) await recordIdempotencyKey(tx, "production.create", input.clientRequestId, productionOrderId, idempotencyHash(input));

    // ④ المدخلات: snapshot التكلفة + حركات OUT (تصاعدياً بـvariantId لقفل حتمي).
    const materialsCost = await consumeInputs(tx, input.branchId, productionOrderId, inLines, actor);
    const totalCost = round2(materialsCost.plus(laborCost));

    // تفريق الهدر (مسار الوصفة فقط): الطبيعي يُمتَص في كلفة السليم، غير الطبيعي خسارة منفصلة.
    // allocPool = ما يُحمَّل على المخرجات = totalCost (بلا هدر) أو absorbedCost (= totalCost − abnormalLoss).
    const sp = spoilage ? spoilageSplit(totalCost, spoilage.batch, spoilage.scrap, spoilage.wasteStdPct) : null;
    const allocPool = sp ? sp.absorbedCost : totalCost;

    await tx
      .update(productionOrders)
      .set({
        materialsCost: materialsCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
        abnormalLoss: (sp ? sp.abnormalLoss : new Decimal(0)).toFixed(2),
      })
      .where(eq(productionOrders.id, productionOrderId));

    // ⑤ المخرجات: توزيع allocPool + WAVG + حركات IN.
    await produceOutputs(tx, input.branchId, productionOrderId, outLines, allocPool, actor);

    // ⑤.5 (المرحلة ٦ — ١٩/٦/٢٦): تأكيد حفظ القيمة (WAVG verification).
    //     فاصل تفاضلي: مجموع تكاليف المخرجات يجب أن يطابق allocPool (= totalCost - abnormalLoss).
    //     آخر سطر يمتص بقايا التقريب، فالتساوي مضمون رياضياً. الفحص هنا حارس defensive ضدّ تعديل لاحق.
    const allocatedSumRes = await tx.execute(sql`
      SELECT COALESCE(SUM(CAST(allocatedCost AS DECIMAL(15,2))), 0) AS s
      FROM productionLines WHERE productionOrderId = ${productionOrderId} AND productionLineDirection = 'OUTPUT'
    `);
    const allocRows = (((allocatedSumRes as any)[0] ?? allocatedSumRes) as Array<any>) ?? [];
    const allocSumStr = String(allocRows[0]?.s ?? "0");
    const allocatedTotal = money(allocSumStr);
    const drift = allocatedTotal.minus(allocPool).abs();
    if (drift.gt("0.01")) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `انتهاك حفظ قيمة الإنتاج: مجموع تكاليف المخرجات ${allocatedTotal.toFixed(2)} ≠ allocPool ${allocPool.toFixed(2)} (فرق ${drift.toFixed(2)})`,
      });
    }

    // ⑥ القيد المحاسبي: التحويل أصل↔أصل محايد ⇒ لا قيد على القيمة المُمتَصّة (في المنتج).
    //    الهدر غير الطبيعي فقط ⇒ قيد WASTAGE (خسارة بالكلفة، بلا نقد، **بلا خصم مخزون ثانٍ** — المواد خُصمت
    //    بحركة المدخلات؛ هذا قيد إعادة تصنيف للقيمة من «منتج» إلى «خسارة فترة» يطابق نمط نثرية/تلف المصاريف).
    if (sp && sp.abnormalLoss.gt(0)) {
      await postEntry(tx, {
        entryType: "WASTAGE",
        branchId: input.branchId,
        cost: sp.abnormalLoss,
        amount: sp.abnormalLoss,
        revenue: new Decimal(0),
        profit: round2(new Decimal(0).minus(sp.abnormalLoss)),
        notes: `هدر إنتاج غير طبيعي — ${docNumber} (${sp.abnormalUnits} وحدة)`,
        dedupeKey: `WASTAGE:PROD:${productionOrderId}`,
      });
    }
    return { productionOrderId, docNumber, totalCost: totalCost.toFixed(2) };
  });
}

/**
 * تحقّق + تحليل أسطر الإنتاج: «تشغيل بوصفة» (الخادم يوسّع) أو مدخلات/مخرجات يدوية،
 * ثم حارس التحويل الذاتي ووجود كل الأصناف. يُعيد الأسطر المحلولة + العمالة + الهدر + الوصفة المرتبطة.
 */
async function resolveAndValidateLines(
  tx: Tx,
  input: CreateProductionInput,
): Promise<{
  inLines: ResolvedLine[];
  outLines: ResolvedLine[];
  laborCost: Decimal;
  spoilage: SpoilageParams | null;
  linkedRecipeId: number | null;
}> {
  let inLines: ResolvedLine[];
  let outLines: ResolvedLine[];
  let laborCost: Decimal;
  let spoilage: SpoilageParams | null = null;
  let linkedRecipeId: number | null = input.linkedRecipeId ?? null;

  if (input.run) {
    const plan = await resolveRunPlan(tx, input.run);
    inLines = plan.inLines;
    outLines = plan.outLines;
    laborCost = plan.laborCost;
    spoilage = plan.spoilage;
    linkedRecipeId = input.run.recipeId;
  } else {
    if (!input.inputs?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد مدخلاً واحداً على الأقل" });
    if (!input.outputs?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد مخرجاً واحداً على الأقل" });
    inLines = [];
    for (const l of input.inputs) inLines.push(await resolveLine(tx, l));
    outLines = [];
    for (const l of input.outputs) outLines.push(await resolveLine(tx, l));
    laborCost = round2(money(input.laborCost ?? "0"));
    if (laborCost.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمالة لا يمكن أن تكون سالبة" });
  }

  // حارس التحويل الذاتي (مسار الوصفة محصّن أصلاً لأن المخرَج ≠ أي مكوّن عند الإنشاء).
  const inVarIds = new Set(inLines.map((l) => l.variantId));
  if (!input.allowSelfConvert) {
    for (const o of outLines) {
      if (inVarIds.has(o.variantId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "صنف لا يكون مدخلاً ومخرجاً في آنٍ واحد (يُفسد حساب التكلفة)" });
      }
    }
  }

  // وجود كل الأصناف.
  const allVarIds = Array.from(new Set(inLines.concat(outLines).map((l) => l.variantId)));
  const existing = await tx.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, allVarIds));
  const existSet = new Set(existing.map((v: any) => Number(v.id)));
  for (const id of allVarIds) {
    if (!existSet.has(id)) throw new TRPCError({ code: "NOT_FOUND", message: `صنف #${id} غير موجود` });
  }

  return { inLines, outLines, laborCost, spoilage, linkedRecipeId };
}

/** المدخلات: snapshot التكلفة + حركات OUT (تصاعدياً بـvariantId لقفل حتمي). يُعيد كلفة المواد (round2). */
async function consumeInputs(
  tx: Tx,
  branchId: number,
  productionOrderId: number,
  inLines: ResolvedLine[],
  actor: Actor,
): Promise<Decimal> {
  inLines.sort((a, b) => a.variantId - b.variantId);
  const inVarList = Array.from(new Set(inLines.map((l) => l.variantId)));
  const inCostRows = await tx
    .select({ id: productVariants.id, costPrice: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, inVarList));
  const inCostMap = new Map(inCostRows.map((v: any) => [Number(v.id), v.costPrice]));

  let materialsCost = new Decimal(0);
  for (const l of inLines) {
    const unitCost = round2(money(inCostMap.get(l.variantId) ?? "0"));
    const lineCost = round2(unitCost.times(l.baseQuantity));
    materialsCost = materialsCost.plus(lineCost);
    await tx.insert(productionLines).values({
      productionOrderId,
      direction: "INPUT",
      variantId: l.variantId,
      productUnitId: l.productUnitId,
      quantity: l.quantity,
      baseQuantity: l.baseQuantity,
      unitCost: unitCost.toFixed(2),
      lineCost: lineCost.toFixed(2),
    });
    await applyMovement(tx, {
      variantId: l.variantId,
      branchId,
      baseQuantity: l.baseQuantity,
      movementType: "OUT",
      referenceType: "PRODUCTION",
      referenceId: productionOrderId,
      createdBy: actor.userId,
    });
  }
  return round2(materialsCost);
}

/**
 * المخرجات: تحقّق التوزيع (يدوي كلّه أو لا شيء بمجموع ≈100، أو تناسبي)، ثم قفل رصيد المخرجات
 * وقراءة SUM العالمي **قبل** أي إدخال، ثم توزيع allocPool + WAVG على كلفة كل مخرَج + حركات IN.
 */
async function produceOutputs(
  tx: Tx,
  branchId: number,
  productionOrderId: number,
  outLines: ResolvedLine[],
  allocPool: Decimal,
  actor: Actor,
): Promise<void> {
  outLines.sort((a, b) => a.variantId - b.variantId);
  const totalOutBase = outLines.reduce((s, l) => s + l.baseQuantity, 0);
  if (totalOutBase <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "كمية المخرجات يجب أن تكون موجبة" });

  // توزيع يدوي: كلّه أو لا شيء، بمجموع ≈ 100.
  const manualCount = outLines.filter((l) => l.manualSharePct != null).length;
  const useManual = manualCount > 0;
  if (useManual && manualCount !== outLines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "إمّا توزيع يدوي لكل المخرجات أو تناسبي للكل (لا خلط)" });
  }
  if (useManual) {
    const sumPct = outLines.reduce((s, l) => s.plus(money(l.manualSharePct ?? "0")), new Decimal(0));
    if (sumPct.minus(100).abs().gt("0.01")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مجموع نسب التوزيع اليدوي يجب أن يساوي 100%" });
    }
  }

  // اقفل صفوف رصيد المخرجات ثم اقرأ SUM العالمي **قبل** أي إدخال (مطابقة purchaseService).
  const outVarList = Array.from(new Set(outLines.map((l) => l.variantId)));
  await tx.select({ id: branchStock.id }).from(branchStock).where(inArray(branchStock.variantId, outVarList)).orderBy(asc(branchStock.variantId)).for("update");
  const stockRows = await tx
    .select({ variantId: branchStock.variantId, totalQty: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)` })
    .from(branchStock)
    .where(inArray(branchStock.variantId, outVarList))
    .groupBy(branchStock.variantId);
  const stockMap = new Map(stockRows.map((s: any) => [Number(s.variantId), String(s.totalQty)]));
  const outCostRows = await tx
    .select({ id: productVariants.id, cost: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, outVarList))
    .for("update");
  const costMap = new Map(outCostRows.map((v: any) => [Number(v.id), v.cost]));

  let running = new Decimal(0);
  for (let j = 0; j < outLines.length; j++) {
    const l = outLines[j];
    let share: Decimal;
    if (j < outLines.length - 1) {
      share = useManual
        ? round2(allocPool.times(money(l.manualSharePct ?? "0")).div(100))
        : round2(allocPool.times(l.baseQuantity).div(totalOutBase));
      running = running.plus(share);
    } else {
      share = round2(allocPool.minus(running)); // آخر سطر يمتصّ بقايا التقريب
    }
    const allocatedCost = share;
    const costPerBase = round2(allocatedCost.div(l.baseQuantity));

    // WAVG على كلفة المخرَج: الرصيد العالمي القائم **قبل** هذا الإدخال.
    const existingQty = Decimal.max(new Decimal(stockMap.get(l.variantId) ?? "0"), 0);
    const oldCost = money(costMap.get(l.variantId) ?? "0");
    const recvQty = new Decimal(l.baseQuantity);
    const denom = existingQty.plus(recvQty);
    const newCost = denom.lte(0) || oldCost.lte(0)
      ? costPerBase
      : round2(existingQty.times(oldCost).plus(recvQty.times(costPerBase)).div(denom));

    await tx.insert(productionLines).values({
      productionOrderId,
      direction: "OUTPUT",
      variantId: l.variantId,
      productUnitId: l.productUnitId,
      quantity: l.quantity,
      baseQuantity: l.baseQuantity,
      unitCost: costPerBase.toFixed(2),
      lineCost: allocatedCost.toFixed(2),
      allocatedCost: allocatedCost.toFixed(2),
      manualSharePct: l.manualSharePct,
    });
    await applyMovement(tx, {
      variantId: l.variantId,
      branchId,
      baseQuantity: l.baseQuantity,
      movementType: "IN",
      referenceType: "PRODUCTION",
      referenceId: productionOrderId,
      createdBy: actor.userId,
    });
    await tx.update(productVariants).set({ costPrice: newCost.toFixed(2) }).where(eq(productVariants.id, l.variantId));

    // حدّث الخريطتين تسلسلياً للصنف المكرّر في نفس المستند.
    stockMap.set(l.variantId, denom.toString());
    costMap.set(l.variantId, newCost.toFixed(2));
  }
}
