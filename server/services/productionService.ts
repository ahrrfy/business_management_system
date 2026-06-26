/**
 * productionService — وحدة الإنتاج/التحويل: تستهلك مدخلات (ورق…) وتُنتج مخرجات (دفتر/كتاب/كيس) **ذرّياً**.
 *
 * مبادئ (§٥):
 *  - **لا قيد محاسبي**: التحويل أصل↔أصل محايد على الربح/الخسارة؛ القيمة محفوظة بحركتَي المخزون
 *    (OUT للمدخلات + IN للمخرجات) وتحديث `costPrice` للمخرَج بالمتوسّط المرجّح (WAVG).
 *  - **كلفة المخرَج المُمتصّة** = (كلفة المواد المُستهلَكة + عمالة اختيارية) موزّعةً على المخرجات،
 *    آخر سطر يمتصّ بقايا التقريب ⇒ Σ allocatedCost == totalCost تماماً.
 *  - WAVG على المخرَج بنفس صيغة استلام الشراء (purchaseService): SUM الرصيد العالمي **قبل** الإدخال.
 *  - ذرّية كاملة عبر withTx؛ نقص أي مدخل ⇒ applyMovement يرمي CONFLICT ⇒ ROLLBACK.
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import {
  branchStock,
  branches,
  productUnits,
  productVariants,
  products,
  productionLines,
  productionOrders,
  productionRecipeLines,
  productionRecipes,
} from "../../drizzle/schema";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { postEntry } from "./ledgerService";
import { money, round2, toDateStr } from "./money";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import type { Tx } from "../db";

export interface ProductionLineInput {
  variantId: number;
  /** إن وُجد مع quantity ⇒ يُحوّل لكمية أساس عبر convertToBaseQuantity (يفرض الصحّة). */
  productUnitId?: number | null;
  quantity?: string;
  /** بديل مباشر: كمية أساس (عدد صحيح موجب). */
  baseQuantity?: number;
  /** OUTPUT فقط: نسبة توزيع يدوية اختيارية (كلّها يدوي بمجموع≈100 أو كلّها تناسبي). */
  manualSharePct?: string | null;
}

export interface CreateProductionInput {
  branchId: number;
  /** اختياري عند تمرير run (التشغيل بوصفة) — الخادم يوسّع الوصفة بدلاً منهما. */
  inputs?: ProductionLineInput[];
  outputs?: ProductionLineInput[];
  /** عمالة/تشغيل يدوي تُضاف لكلفة المخرجات (افتراضي 0). */
  laborCost?: string | null;
  notes?: string | null;
  linkedWorkOrderId?: number | null;
  linkedRecipeId?: number | null;
  /** السماح بصنف يكون مدخلاً ومخرجاً في آن (نادر؛ افتراضياً مرفوض لأنه يُفسد WAVG). */
  allowSelfConvert?: boolean;
  /** idempotency: نقرة مزدوجة/إعادة إرسال بنفس المفتاح ⇒ مستند واحد. */
  clientRequestId?: string | null;
  /**
   * مسار «التشغيل بوصفة» (بديل آمن للمدخلات/المخرجات اليدوية): الخادم يوسّع الوصفة بنفسه فيمنع تلاعب الكلفة.
   * نموذج «الدفعة تقود الاستهلاك»: الاستهلاك = qtyPerOutputBase × batch؛ السليم = batch − scrap.
   * عند وجوده تُتجاهل inputs/outputs/laborCost ويُحسب كل شيء من الوصفة + يُسجَّل قيد WASTAGE للهدر غير الطبيعي.
   */
  run?: {
    recipeId: number;
    batchQty: number;
    scrapQty?: number;
    /** عمالة لكل وحدة (تجاوز اختياري لعمالة الوصفة). */
    laborPerUnit?: string | null;
  } | null;
}

/** بارامترات تفريق الهدر لتشغيل بوصفة (تُملأ من resolveRunPlan ثم يُحسب abnormalLoss في القلب بعد معرفة الكلفة). */
interface SpoilageParams {
  batch: number;
  scrap: number;
  good: number;
  wasteStdPct: Decimal;
}

interface ResolvedLine {
  variantId: number;
  productUnitId: number | null;
  quantity: string;
  baseQuantity: number;
  manualSharePct: string | null;
}

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

/**
 * تفريق الهدر الطبيعي/غير الطبيعي على كلفة تشغيل كلية — **نقي وقابل للاختبار وحده**.
 * - هدر طبيعي (ضمن المعيار wasteStdPct) ⇒ يُمتَص في كلفة الوحدة السليمة (كلفة منتج، أصل↔أصل).
 * - هدر غير طبيعي (يتجاوز المعيار) ⇒ خسارة منفصلة (قيد WASTAGE) لا تضخّم كلفة السليم.
 * حفظ القيمة: absorbedCost + abnormalLoss = totalCost دائماً.
 */
export function spoilageSplit(totalCost: Decimal, started: number, scrapN: number, wasteStdPct: Decimal) {
  const normalAllow = Math.floor(Math.max(0, wasteStdPct.toNumber()) * started);
  const abnormalUnits = Math.max(0, scrapN - normalAllow);
  const good = started - scrapN;
  const abnormalLoss = started > 0 ? round2(totalCost.div(started).times(abnormalUnits)) : new Decimal(0);
  const absorbedCost = round2(totalCost.minus(abnormalLoss)); // يُحمَّل على الوحدات السليمة
  const unitCost = good > 0 ? round2(absorbedCost.div(good)) : new Decimal(0);
  return { normalAllow, abnormalUnits, good, abnormalLoss, absorbedCost, unitCost };
}

/**
 * الحساب الكامل لتشغيل بوصفة (نقي) — يطابق `computeProductionRun` في المواصفة.
 * **مُدخَل واحد يقود الاستهلاك = الدفعة (started)**؛ الوحدة التالفة استهلكت موادها أيضاً ⇒ لا تضاعف.
 * materialsCost يطابق حرفياً ما يحسبه createProduction (round2 لكل سطر) ⇒ المعاينة = الترحيل.
 */
export function computeRunCosts(args: {
  recipeLines: Array<{ unitCost: Decimal; qtyPerOutputBase: Decimal }>;
  laborPerUnit: Decimal;
  wasteStdPct: Decimal;
  batch: number;
  scrap: number;
}) {
  const started = Math.max(0, Math.trunc(args.batch));
  const scrapN = Math.min(Math.max(0, Math.trunc(args.scrap)), started); // التالف لا يتجاوز الدفعة
  const good = started - scrapN;
  const materialsCost = round2(
    args.recipeLines.reduce(
      (s, l) => s.plus(round2(l.unitCost.times(l.qtyPerOutputBase).times(started))),
      new Decimal(0)
    )
  );
  const labor = round2(args.laborPerUnit.times(started));
  const totalCost = round2(materialsCost.plus(labor));
  const sp = spoilageSplit(totalCost, started, scrapN, args.wasteStdPct); // sp.good = started − scrapN
  const yieldPct = started > 0 ? good / started : 0;
  return { started, scrapN, materialsCost, labor, totalCost, yieldPct, ...sp };
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

/** عزل الفرع: غير المدير/الأدمن يُجبر فرعه. */
function assertProductionBranch(po: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(po.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "المستند لا يخصّ فرعك" });
  }
}

interface RunPlan {
  inLines: ResolvedLine[];
  outLines: ResolvedLine[];
  laborCost: Decimal;
  spoilage: SpoilageParams;
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

  const batch = Math.trunc(Number(run.batchQty));
  if (!Number.isFinite(batch) || batch <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "عدد الدفعة يجب أن يكون عدداً صحيحاً موجباً" });
  const scrap = Math.min(Math.max(0, Math.trunc(Number(run.scrapQty ?? 0))), batch);
  const good = batch - scrap;
  if (good <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "السليم الناتج يجب أن يكون موجباً (التالف لا يساوي الدفعة كلّها)" });

  const recLines = await tx
    .select({ inputVariantId: productionRecipeLines.inputVariantId, qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase, productName: products.name })
    .from(productionRecipeLines)
    .leftJoin(productVariants, eq(productionRecipeLines.inputVariantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productionRecipeLines.recipeId, run.recipeId))
    .orderBy(productionRecipeLines.id);
  if (!recLines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة بلا مكوّنات" });

  const inLines: ResolvedLine[] = recLines.map((l: any) => {
    const consumed = new Decimal(l.qtyPerOutputBase).times(batch);
    if (!consumed.isInteger()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `استهلاك «${l.productName ?? l.inputVariantId}» (${consumed.toString()}) ليس عدداً صحيحاً — عدّل الدفعة أو الوصفة` });
    }
    return { variantId: Number(l.inputVariantId), productUnitId: null, quantity: consumed.toFixed(4), baseQuantity: consumed.toNumber(), manualSharePct: null };
  });

  const outLines: ResolvedLine[] = [
    { variantId: Number(head.outputVariantId), productUnitId: Number(head.outputProductUnitId), quantity: money(good).toFixed(4), baseQuantity: good, manualSharePct: null },
  ];

  const perUnit = run.laborPerUnit != null && String(run.laborPerUnit).trim() !== "" ? money(run.laborPerUnit) : money(head.laborPerOutputBase ?? "0");
  if (perUnit.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمالة لا يمكن أن تكون سالبة" });
  const laborCost = round2(perUnit.times(batch));

  return { inLines, outLines, laborCost, spoilage: { batch, scrap, good, wasteStdPct: money(head.wasteStdPct ?? "0") } };
}

export interface CreateProductionResult {
  productionOrderId: number;
  docNumber: string;
  totalCost: string;
  idempotent?: boolean;
}

/** إنشاء مستند إنتاج: يستهلك المدخلات ويُنتج المخرجات ذرّياً + يُحدّث كلفة المخرجات (بلا قيد محاسبي). */
export async function createProduction(input: CreateProductionInput, actor: Actor): Promise<CreateProductionResult> {
  return withTx(async (tx) => {
    // ① إعادة idempotent.
    const replayId = await findIdempotentRefId(tx, "production.create", input.clientRequestId);
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
    if (input.clientRequestId) await recordIdempotencyKey(tx, "production.create", input.clientRequestId, productionOrderId);

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

/** إلغاء مستند إنتاج: يعكس المخرجات (OUT) ثم المدخلات (IN). لا فكّ WAVG. يعكس قيد WASTAGE إن وُجد. */
export async function cancelProduction(productionOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const rows = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId)).for("update").limit(1);
    const po = rows[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "المستند غير موجود" });
    assertProductionBranch(po, actor);
    if (po.status !== "CONFIRMED") throw new TRPCError({ code: "BAD_REQUEST", message: "المستند مُلغى سلفاً" });

    const lines = await tx.select().from(productionLines).where(eq(productionLines.productionOrderId, productionOrderId));
    const outs = lines.filter((l: any) => l.direction === "OUTPUT").sort((a: any, b: any) => Number(a.variantId) - Number(b.variantId));
    const ins = lines.filter((l: any) => l.direction === "INPUT").sort((a: any, b: any) => Number(a.variantId) - Number(b.variantId));

    // اعكس المخرجات أولاً (سحب المنتَج) — قد يرمي CONFLICT إن بِيع/استُهلك ⇒ يمنع الإلغاء بحقّ.
    for (const l of outs) {
      await applyMovement(tx, {
        variantId: Number(l.variantId),
        branchId: Number(po.branchId),
        baseQuantity: l.baseQuantity,
        movementType: "OUT",
        referenceType: "PRODUCTION_CANCEL",
        referenceId: productionOrderId,
        createdBy: actor.userId,
      });
    }
    // استرجع المدخلات.
    for (const l of ins) {
      await applyMovement(tx, {
        variantId: Number(l.variantId),
        branchId: Number(po.branchId),
        baseQuantity: l.baseQuantity,
        movementType: "IN",
        referenceType: "PRODUCTION_CANCEL",
        referenceId: productionOrderId,
        createdBy: actor.userId,
      });
    }

    // اعكس قيد الهدر غير الطبيعي (إن وُجد) ⇒ قيد WASTAGE معاكس صافيه صفر (dedupeKey=NULL لأنه قيد متكرّر مشروع).
    const abnormalLoss = round2(money(po.abnormalLoss ?? "0"));
    if (abnormalLoss.gt(0)) {
      await postEntry(tx, {
        entryType: "WASTAGE",
        branchId: Number(po.branchId),
        cost: abnormalLoss.neg(),
        amount: abnormalLoss.neg(),
        revenue: new Decimal(0),
        profit: abnormalLoss,
        notes: `عكس هدر إنتاج غير طبيعي — إلغاء ${po.docNumber}`,
        dedupeKey: null,
      });
    }

    await tx.update(productionOrders).set({ status: "CANCELLED" }).where(eq(productionOrders.id, productionOrderId));
    return { productionOrderId, status: "CANCELLED" as const };
  });
}

export interface ListProductionFilters {
  branchId?: number | null;
  status?: "CONFIRMED" | "CANCELLED" | null;
  limit?: number;
}

/** قائمة مستندات الإنتاج (رأس + اسم الفرع + المنشئ + كمية المخرجات الإجمالية). */
export async function listProductions(filters: ListProductionFilters = {}) {
  return withTx(async (tx) => {
    const conds = [] as any[];
    if (filters.branchId) conds.push(eq(productionOrders.branchId, filters.branchId));
    if (filters.status) conds.push(eq(productionOrders.status, filters.status));
    const where = conds.length ? and(...conds) : undefined;
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);

    const rows = await tx
      .select({
        id: productionOrders.id,
        docNumber: productionOrders.docNumber,
        branchId: productionOrders.branchId,
        branchName: branches.name,
        status: productionOrders.status,
        materialsCost: productionOrders.materialsCost,
        laborCost: productionOrders.laborCost,
        totalCost: productionOrders.totalCost,
        notes: productionOrders.notes,
        createdAt: productionOrders.createdAt,
      })
      .from(productionOrders)
      .leftJoin(branches, eq(productionOrders.branchId, branches.id))
      .where(where as any)
      .orderBy(desc(productionOrders.id))
      .limit(limit);

    if (!rows.length) return [] as any[];
    const ids = rows.map((r: any) => Number(r.id));
    const outAgg = await tx
      .select({ orderId: productionLines.productionOrderId, qty: sql<string>`COALESCE(SUM(${productionLines.baseQuantity}), 0)` })
      .from(productionLines)
      .where(and(inArray(productionLines.productionOrderId, ids), eq(productionLines.direction, "OUTPUT")))
      .groupBy(productionLines.productionOrderId);
    const outMap = new Map(outAgg.map((a: any) => [Number(a.orderId), Number(a.qty)]));
    return rows.map((r: any) => ({ ...r, outputQty: outMap.get(Number(r.id)) ?? 0 }));
  });
}

/** تفاصيل مستند إنتاج: الرأس + أسطر المدخلات/المخرجات بأسماء الأصناف. */
export async function getProduction(productionOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const head = (
      await tx
        .select({
          id: productionOrders.id,
          docNumber: productionOrders.docNumber,
          branchId: productionOrders.branchId,
          branchName: branches.name,
          status: productionOrders.status,
          materialsCost: productionOrders.materialsCost,
          laborCost: productionOrders.laborCost,
          totalCost: productionOrders.totalCost,
          batchQty: productionOrders.batchQty,
          goodQty: productionOrders.goodQty,
          scrapQty: productionOrders.scrapQty,
          abnormalLoss: productionOrders.abnormalLoss,
          wasteStdPct: productionOrders.wasteStdPct,
          notes: productionOrders.notes,
          linkedWorkOrderId: productionOrders.linkedWorkOrderId,
          linkedRecipeId: productionOrders.linkedRecipeId,
          recipeName: productionRecipes.name,
          createdBy: productionOrders.createdBy,
          createdAt: productionOrders.createdAt,
        })
        .from(productionOrders)
        .leftJoin(branches, eq(productionOrders.branchId, branches.id))
        .leftJoin(productionRecipes, eq(productionOrders.linkedRecipeId, productionRecipes.id))
        .where(eq(productionOrders.id, productionOrderId))
        .limit(1)
    )[0];
    if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "المستند غير موجود" });
    assertProductionBranch(head, actor);

    const lines = await tx
      .select({
        id: productionLines.id,
        direction: productionLines.direction,
        variantId: productionLines.variantId,
        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
        unitName: productUnits.unitName,
        quantity: productionLines.quantity,
        baseQuantity: productionLines.baseQuantity,
        unitCost: productionLines.unitCost,
        lineCost: productionLines.lineCost,
        allocatedCost: productionLines.allocatedCost,
      })
      .from(productionLines)
      .leftJoin(productVariants, eq(productionLines.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(productionLines.productUnitId, productUnits.id))
      .where(eq(productionLines.productionOrderId, productionOrderId))
      .orderBy(productionLines.id);

    // أرقام الإنتاجية المشتقّة من اللقطة المخزّنة — تُحسب بـ`spoilageSplit` نفسها (مصدر حقيقة واحد:
    // لا يعيد العميل اشتقاق الدكترين). NULL للمستندات اليدوية/القديمة (بلا batchQty).
    const batch = head.batchQty == null ? null : Number(head.batchQty);
    let derived: { normalAllow: number; abnormalUnits: number; yieldPct: number } | null = null;
    if (batch != null && batch > 0) {
      const sp = spoilageSplit(money(head.totalCost), batch, Number(head.scrapQty ?? 0), money(head.wasteStdPct ?? "0"));
      derived = { normalAllow: sp.normalAllow, abnormalUnits: sp.abnormalUnits, yieldPct: Number(head.goodQty ?? 0) / batch };
    }

    return {
      ...head,
      normalAllow: derived?.normalAllow ?? null,
      abnormalUnits: derived?.abnormalUnits ?? null,
      yieldPct: derived?.yieldPct ?? null,
      inputs: lines.filter((l: any) => l.direction === "INPUT"),
      outputs: lines.filter((l: any) => l.direction === "OUTPUT"),
    };
  });
}

export interface RunPreviewResult {
  recipeId: number;
  recipeName: string | null;
  outputVariantId: number;
  outputProductUnitId: number;
  outputName: string | null;
  outputSku: string | null;
  outputUnitName: string | null;
  batch: number;
  good: number;
  scrap: number;
  yieldPct: number; // 0..1
  wasteStdPct: string; // كسر
  normalAllow: number;
  abnormalUnits: number;
  abnormalLoss: string;
  absorbedCost: string;
  unitCost: string; // كلفة الوحدة السليمة
  materialsCost: string;
  laborCost: string;
  totalCost: string;
  anyShort: boolean;
  inputs: Array<{
    variantId: number;
    productName: string | null;
    sku: string | null;
    perOutputBase: string;
    consumed: number;
    available: number | null;
    short: boolean;
    unitCost: string;
    lineCost: string;
  }>;
  wavg: { oldQty: number; oldCost: string; addQty: number; newQty: number; newCost: string };
}

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
