// ردّ أمانة أجرة توصيل أمر الشغل (DLV-FEE-WO) غير المصروفة — مشترك بين الإلغاء وإعادة التصنيف.
//
// مراجعة عدائية نهائية (١٠/٨): أمانة COUNTER تُقبَض في الدرج عند إنشاء أمر الشغل (create.ts)،
// ومبرِّئوها الوحيدون كانا الإرسال (dispatch.ts يصرفها للمندوب) والإلغاء (cancel.ts). لكن
// «إعادة تصنيف الطلب إلى استلام مباشر ثم تسليمه» (updateWorkOrderDeliveryMethod ثم deliverWorkOrder)
// لا يمرّ بأيّهما ⇒ الأمانة تعلق في الدرج للأبد (Σ FEE_HELD موجب دائم + نقد زبونٍ بلا مسار ردّ =
// خرق «لا دينار بلا مسار»). هذا المساعد يُنفَّذ عند الانتقال away-from-delivery فيردّها.
//
// النِّت = Σ(IN − OUT) لإيصالات المرجع DLV-FEE-WO-{id} (القبض عند الإنشاء +؛ ردٌّ سابق −).
// الأمر غير المُرسَل قط (الحالة التي يُستدعى فيها) يبقى نِتُّه = +الأجرة (صرفُ الإرسال بمرجع
// الإرسالية لا DLV-FEE-WO). idempotent بمفتاح فريد ⇒ إعادة التصنيف مرّتين لا تردّ مرّتين.
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { computeExpectedCash, resolveBranchCashShiftTx } from "../shiftService";
import type { Actor } from "../tx";

/** يردّ أمانة أجرة التوصيل غير المصروفة لأمر الشغل نقداً من الدرج. يعيد المبلغ المردود (0 إن لا شيء). */
export async function refundUnspentWorkOrderFeeHeld(
  tx: Tx,
  opts: { workOrderId: number; branchId: number; refundShiftId?: number | null; actor: Actor; reason: string },
): Promise<string> {
  const feeHeldRow = (
    await tx
      .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
      .from(receipts)
      .where(and(
        eq(receipts.workOrderId, opts.workOrderId),
        eq(receipts.referenceNumber, `DLV-FEE-WO-${opts.workOrderId}`),
        eq(receipts.status, "COMPLETED"),
      ))
  )[0];
  const feeHeldNet = round2(money(feeHeldRow?.v ?? "0"));
  if (!feeHeldNet.gt(0)) return "0.00";

  const resolved = await resolveBranchCashShiftTx(tx, opts.branchId, opts.refundShiftId ?? null);
  const drawerNow = await computeExpectedCash(tx, resolved.shiftId, resolved.openingBalance);
  if (feeHeldNet.gt(drawerNow)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `ردّ أمانة أجرة التوصيل (${feeHeldNet.toFixed(2)}) يتجاوز النقد المتوفّر في هذا الدرج (${drawerNow.toFixed(2)}) — اختر درجاً آخر`,
    });
  }
  const feeOut = await tx.insert(receipts).values({
    branchId: opts.branchId, shiftId: resolved.shiftId, workOrderId: opts.workOrderId,
    direction: "OUT", amount: toDbMoney(feeHeldNet), paymentMethod: "CASH", cashBucket: "DRAWER",
    status: "COMPLETED", partyType: "OTHER",
    referenceNumber: `DLV-FEE-WO-${opts.workOrderId}`,
    description: `${opts.reason} — طلب #${opts.workOrderId}`,
    createdBy: opts.actor.userId,
  });
  await postEntry(tx, {
    entryType: "DELIVERY_FEE_HELD",
    dedupeKey: `DELIVERY_FEE_HELD_REFUND:WO:${opts.workOrderId}`,
    branchId: opts.branchId,
    receiptId: extractInsertId(feeOut),
    amount: feeHeldNet.neg(),
    notes: `${opts.reason} — طلب #${opts.workOrderId}`,
  });
  return feeHeldNet.toFixed(2);
}
