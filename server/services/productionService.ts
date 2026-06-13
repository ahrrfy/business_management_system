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
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import {
  branchStock,
  branches,
  productUnits,
  productVariants,
  products,
  productionLines,
  productionOrders,
} from "../../drizzle/schema";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { money, round2, toDateStr } from "./money";
import { withTx, type Actor } from "./tx";

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
  inputs: ProductionLineInput[];
  outputs: ProductionLineInput[];
  /** عمالة/تشغيل يدوي تُضاف لكلفة المخرجات (افتراضي 0). */
  laborCost?: string | null;
  notes?: string | null;
  linkedWorkOrderId?: number | null;
  linkedRecipeId?: number | null;
  /** السماح بصنف يكون مدخلاً ومخرجاً في آن (نادر؛ افتراضياً مرفوض لأنه يُفسد WAVG). */
  allowSelfConvert?: boolean;
  /** idempotency: نقرة مزدوجة/إعادة إرسال بنفس المفتاح ⇒ مستند واحد. */
  clientRequestId?: string | null;
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

    // ② تحقّق أساسي.
    if (!input.inputs?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد مدخلاً واحداً على الأقل" });
    if (!input.outputs?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد مخرجاً واحداً على الأقل" });

    const inLines: ResolvedLine[] = [];
    for (const l of input.inputs) inLines.push(await resolveLine(tx, l));
    const outLines: ResolvedLine[] = [];
    for (const l of input.outputs) outLines.push(await resolveLine(tx, l));

    // حارس التحويل الذاتي.
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

    const laborCost = round2(money(input.laborCost ?? "0"));
    if (laborCost.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمالة لا يمكن أن تكون سالبة" });

    // ③ رأس المستند (تكاليف مؤقّتة).
    const docNumber = await nextProductionNumber(tx, input.branchId);
    const insRes = await tx.insert(productionOrders).values({
      docNumber,
      branchId: input.branchId,
      status: "CONFIRMED",
      materialsCost: "0",
      laborCost: laborCost.toFixed(2),
      totalCost: "0",
      notes: input.notes?.trim() || null,
      linkedWorkOrderId: input.linkedWorkOrderId ?? null,
      linkedRecipeId: input.linkedRecipeId ?? null,
      createdBy: actor.userId,
    });
    const productionOrderId = Number((insRes as any)[0]?.insertId ?? (insRes as any).insertId);
    // سجّل مفتاح idempotency فوراً ⇒ طلب متزامن مكرّر يصطدم بالقيد الفريد فيُلغى قبل أي حركة مخزون.
    if (input.clientRequestId) await recordIdempotencyKey(tx, "production.create", input.clientRequestId, productionOrderId);

    // ④ المدخلات: snapshot التكلفة + حركات OUT (تصاعدياً بـvariantId لقفل حتمي).
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
        branchId: input.branchId,
        baseQuantity: l.baseQuantity,
        movementType: "OUT",
        referenceType: "PRODUCTION",
        referenceId: productionOrderId,
        createdBy: actor.userId,
      });
    }
    materialsCost = round2(materialsCost);
    const totalCost = round2(materialsCost.plus(laborCost));
    await tx
      .update(productionOrders)
      .set({ materialsCost: materialsCost.toFixed(2), totalCost: totalCost.toFixed(2) })
      .where(eq(productionOrders.id, productionOrderId));

    // ⑤ المخرجات: توزيع totalCost + WAVG + حركات IN.
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
    await tx.select({ id: branchStock.id }).from(branchStock).where(inArray(branchStock.variantId, outVarList)).for("update");
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
          ? round2(totalCost.times(money(l.manualSharePct ?? "0")).div(100))
          : round2(totalCost.times(l.baseQuantity).div(totalOutBase));
        running = running.plus(share);
      } else {
        share = round2(totalCost.minus(running)); // آخر سطر يمتصّ بقايا التقريب
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
        branchId: input.branchId,
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

    // ⑥ لا قيد محاسبي (تحويل أصل↔أصل محايد).
    return { productionOrderId, docNumber, totalCost: totalCost.toFixed(2) };
  });
}

/** إلغاء مستند إنتاج: يعكس المخرجات (OUT) ثم المدخلات (IN). لا فكّ WAVG. لا قيد محاسبي. */
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
          notes: productionOrders.notes,
          linkedWorkOrderId: productionOrders.linkedWorkOrderId,
          linkedRecipeId: productionOrders.linkedRecipeId,
          createdBy: productionOrders.createdBy,
          createdAt: productionOrders.createdAt,
        })
        .from(productionOrders)
        .leftJoin(branches, eq(productionOrders.branchId, branches.id))
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

    return {
      ...head,
      inputs: lines.filter((l: any) => l.direction === "INPUT"),
      outputs: lines.filter((l: any) => l.direction === "OUTPUT"),
    };
  });
}
