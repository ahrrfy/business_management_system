// قراءات الإنتاج: القائمة والتفاصيل (مع الأرقام المشتقّة من نفس محرّك تفريق الهدر).
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  branches,
  productUnits,
  productVariants,
  products,
  productionLines,
  productionOrders,
  productionRecipes,
} from "../../../drizzle/schema";
import { money } from "../money";
import { type Actor, withTx } from "../tx";
import { spoilageSplit } from "./calc";
import { assertProductionBranch } from "./helpers";
import type { ListProductionFilters } from "./types";

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
