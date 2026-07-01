// تسوية عهدة نقداً + شطب عجز عهدة كمصروف (مدير فقط، بلا نقد).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { deliveryParties, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustDeliveryBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { shiftIdForCashTx } from "../shiftService";
import { withTx } from "../tx";
import type { DeliveryTxActor } from "./types";

/** تسوية عهدة: الجهة تدفع نقداً لخفض رصيدها (مثل عجز سُوّي لاحقاً). */
export interface SettleInput {
  branchId: number;
  partyId: number;
  amount: string;
  shiftType?: "RECEPTION" | "RETAIL";
  notes?: string | null;
  clientRequestId?: string | null;
}

export async function settleDeliveryBalance(input: SettleInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.settle", input.clientRequestId);
      if (existingId != null) return { receiptId: existingId, idempotentReplay: true as const };
    }
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    const amount = round2(money(input.amount));
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    const { shiftId, cashBucket } = await shiftIdForCashTx(tx, { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role }, input.branchId, "تسوية عهدة مندوب", input.shiftType ?? "RECEPTION");
    const rIn = await tx.insert(receipts).values({
      branchId: input.branchId, shiftId, direction: "IN", amount: toDbMoney(amount),
      paymentMethod: "CASH", cashBucket, status: "COMPLETED", partyType: "OTHER",
      referenceNumber: `DLV-SETTLE-${input.partyId}`, description: input.notes ?? `تسوية عهدة جهة توصيل #${input.partyId}`, createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rIn);
    await adjustDeliveryBalance(tx, input.partyId, amount.neg());
    await postEntry(tx, {
      entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_SETTLE:${receiptId}`,
      branchId: input.branchId, deliveryPartyId: input.partyId, receiptId, amount, notes: "تسوية عهدة جهة توصيل",
    });
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.settle", input.clientRequestId, receiptId);
    return { receiptId, partyBalanceAfter: round2(money(party.currentBalance).minus(amount)).toFixed(2) };
  });
}

/** شطب عجز عهدة كمصروف (مدير فقط، بلا نقد). */
export interface WriteOffInput {
  branchId: number;
  partyId: number;
  amount: string;
  reason: string;
  clientRequestId?: string | null;
}

export async function writeOffDeliveryShortfall(input: WriteOffInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.writeoff", input.clientRequestId);
      if (existingId != null) return { partyId: input.partyId, idempotentReplay: true as const };
    }
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    const amount = round2(money(input.amount));
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });
    if (amount.gt(round2(money(party.currentBalance)))) throw new TRPCError({ code: "BAD_REQUEST", message: "الشطب يتجاوز العهدة القائمة" });
    if (!input.reason || input.reason.trim().length < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الشطب مطلوب" });

    await adjustDeliveryBalance(tx, input.partyId, amount.neg());
    // شطبٌ بلا نقد: خسارة فقط (cost-only) ⇒ لا إيصال درج (Z-report والصندوق لا يتأثّران).
    await postEntry(tx, {
      entryType: "DELIVERY_WRITEOFF", branchId: input.branchId, deliveryPartyId: input.partyId,
      amount, cost: amount, profit: amount.neg(), notes: `شطب عهدة: ${input.reason.trim()}`,
    });
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.writeoff", input.clientRequestId, input.partyId);
    return { partyId: input.partyId, partyBalanceAfter: round2(money(party.currentBalance).minus(amount)).toFixed(2) };
  });
}
