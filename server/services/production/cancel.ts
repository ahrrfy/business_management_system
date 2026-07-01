// إلغاء مستند إنتاج: يعكس المخرجات (OUT) ثم المدخلات (IN). لا فكّ WAVG. يعكس قيد WASTAGE إن وُجد.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { productionLines, productionOrders } from "../../../drizzle/schema";
import { applyMovement } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
import { assertProductionBranch } from "./helpers";

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
