// إلغاء مستند إنتاج: يعكس المخرجات (OUT) ثم المدخلات (IN)، ويفك مساهمة دفعة الإنتاج من WAVG.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { branchStock, productVariants, productionLines, productionOrders } from "../../../drizzle/schema";
import { applyMovement } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { postEntry } from "../ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
} from "../accounting/postingEngine";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
import { assertProductionBranch } from "./helpers";

/** إلغاء مستند إنتاج: يعكس المخزون، يفك مساهمة المخرجات من WAVG، ويعكس قيد WASTAGE إن وُجد. */
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
    await lockInventoryVariants(tx, outs.concat(ins).map((line: any) => Number(line.variantId)));

    // اجمع مساهمة كل مخرَج في وعاء WAVG. الصيغة العكسية:
    // oldValue = currentQty*currentCost - producedAllocatedCost؛ oldCost = oldValue/(currentQty-producedQty).
    // تبقى صحيحة بعد مبيعات لاحقة (لا تغيّر WAVG) وبعد استلامات WAVG لاحقة، ما دام المخرَج نفسه متاحاً للإلغاء.
    const byVariant = new Map<number, { qty: number; value: Decimal }>();
    for (const l of outs) {
      const variantId = Number(l.variantId);
      const prev = byVariant.get(variantId) ?? { qty: 0, value: new Decimal(0) };
      prev.qty += Number(l.baseQuantity);
      prev.value = prev.value.plus(money(l.allocatedCost ?? l.lineCost ?? "0"));
      byVariant.set(variantId, prev);
    }
    const outVariantIds = Array.from(byVariant.keys()).sort((a, b) => a - b);
    if (outVariantIds.length) {
      await tx
        .select({ id: branchStock.id })
        .from(branchStock)
        .where(inArray(branchStock.variantId, outVariantIds))
        .orderBy(asc(branchStock.variantId))
        .for("update");
    }
    const qtyRows = outVariantIds.length
      ? await tx
          .select({ variantId: branchStock.variantId, qty: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)` })
          .from(branchStock)
          .where(inArray(branchStock.variantId, outVariantIds))
          .groupBy(branchStock.variantId)
      : [];
    const qtyMap = new Map(qtyRows.map((row) => [Number(row.variantId), money(row.qty)]));
    const costRows = outVariantIds.length
      ? await tx
          .select({ id: productVariants.id, costPrice: productVariants.costPrice })
          .from(productVariants)
          .where(inArray(productVariants.id, outVariantIds))
          .orderBy(asc(productVariants.id))
          .for("update")
      : [];
    const currentCost = new Map(costRows.map((row) => [Number(row.id), money(row.costPrice ?? "0")]));
    const restoredCosts = new Map<number, Decimal>();
    for (const [variantId, produced] of Array.from(byVariant.entries())) {
      const currentQty = qtyMap.get(variantId) ?? new Decimal(0);
      const remainingQty = currentQty.minus(produced.qty);
      if (remainingQty.lt(0)) {
        throw new TRPCError({ code: "CONFLICT", message: `لا يمكن إلغاء الإنتاج: رصيد الصنف #${variantId} لا يغطي الكمية المنتَجة` });
      }
      if (remainingQty.isZero()) {
        restoredCosts.set(variantId, new Decimal(0));
        continue;
      }
      const remainingValue = currentQty.times(currentCost.get(variantId) ?? new Decimal(0)).minus(produced.value);
      if (remainingValue.lt(0)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `لا يمكن فك متوسط تكلفة الصنف #${variantId} بأمان — راجع حركات التكلفة اللاحقة`,
        });
      }
      restoredCosts.set(variantId, round2(remainingValue.div(remainingQty)));
    }

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
    for (const [variantId, restoredCost] of Array.from(restoredCosts.entries())) {
      await tx.update(productVariants).set({ costPrice: restoredCost.toFixed(2) }).where(eq(productVariants.id, variantId));
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
        postingIntent: createPostingIntent(
          "WASTAGE_INVENTORY",
          "WASTAGE",
          signedPostingLines("LOSSES", "INVENTORY", abnormalLoss.neg()),
        ),
        notes: `عكس هدر إنتاج غير طبيعي — إلغاء ${po.docNumber}`,
        dedupeKey: null,
      });
    }

    await tx.update(productionOrders).set({ status: "CANCELLED" }).where(eq(productionOrders.id, productionOrderId));
    return { productionOrderId, status: "CANCELLED" as const };
  });
}
