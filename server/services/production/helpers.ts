// أدوات إنشاء داخلية: تحليل الأسطر، ترقيم المستند، عزل الفرع، وتوسيع تشغيل بوصفة — غير مُصدَّرة.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, like } from "drizzle-orm";
import {
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


// تصدير داخلي للحزمة فقط (يستهلكه create/cancel/queries) — لا يُعاد تصديره من البرميل
// productionService.ts.
export { resolveLine, nextProductionNumber, assertProductionBranch, resolveRunPlan };
