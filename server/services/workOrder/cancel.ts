// إلغاء أمر شغل: يعيد المواد المُستهلَكة للمخزون ويسترد العربون المقبوض (إن وُجد).
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { receipts, workOrderMaterials, workOrders } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { openShiftIdTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

/** Cancel: restocks consumed materials if status was IN_PROGRESS/READY. */
export async function cancelWorkOrder(workOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء أمر مُسلَّم أو مُلغى" });
    if (wo.status === "IN_PROGRESS" || wo.status === "READY") {
      const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
      mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));
      for (const m of mats) {
        await applyMovement(tx, {
          variantId: Number(m.variantId),
          branchId: Number(wo.branchId),
          baseQuantity: m.baseQuantity,
          movementType: "IN",
          referenceType: "WORK_ORDER_CANCEL",
          referenceId: workOrderId,
          createdBy: actor.userId,
        });
      }
    }
    // استرداد العربون المقبوض (إن وُجد ولم يُربَط بفاتورة): نقدٌ يخرج من الدُرج الآن ⇒ receipt(OUT)+PAYMENT_OUT
    // يعكس قيد PAYMENT_IN المُسجَّل عند الإنشاء (صافي الدفتر = صفر)، ويظهر خروجاً في Z-report يوم الإلغاء.
    // نعكس فقط ما قُبِض فعلاً (إيصال موجود) — لا نختلق استرداداً لأوامر قديمة لم تُسجِّل العربون كقيد.
    const refundD = round2(money(wo.deposit ?? "0"));
    if (refundD.gt(0)) {
      const depRcpt = (
        await tx
          .select({ amount: receipts.amount, paymentMethod: receipts.paymentMethod })
          .from(receipts)
          .where(and(eq(receipts.workOrderId, workOrderId), eq(receipts.direction, "IN"), isNull(receipts.invoiceId)))
          .limit(1)
      )[0];
      if (depRcpt) {
        const refundAmt = round2(money(depRcpt.amount));
        const refundMethod = depRcpt.paymentMethod ?? "CASH";
        const shiftId = await openShiftIdTx(tx, actor.userId, Number(wo.branchId), "RECEPTION");
        if (refundMethod === "CASH" && shiftId == null)
          throw new TRPCError({ code: "CONFLICT", message: "افتح وردية أولاً لاسترداد العربون النقدي" });
        const rRes = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId,
          workOrderId,
          direction: "OUT",
          amount: toDbMoney(refundAmt),
          paymentMethod: refundMethod,
          // cashBucket='DRAWER' للاسترداد النقدي ⇒ يَخصم من تسوية الدرج/Z-report (مرآة العربون عند القبض).
          cashBucket: refundMethod === "CASH" ? "DRAWER" : null,
          status: "COMPLETED",
          referenceNumber: `WO-CANCEL-REFUND-${workOrderId}`,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(rRes);
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: Number(wo.branchId),
          receiptId: refundReceiptId,
          customerId: wo.customerId ?? null,
          amount: refundAmt,
          notes: `استرداد عربون طلب خدمة ملغى #${workOrderId}`,
        });
      }
    }

    await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "CANCELLED" };
  });
}
