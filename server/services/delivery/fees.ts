import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryLedgerEntries, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { computeExpectedCash, resolveBranchCashShiftTx } from "../shiftService";
import { withTx } from "../tx";
import { appendDeliveryLedgerEntry } from "./lifecycle";
import type { DeliveryTxActor } from "./types";

export async function payDeliveryFee(
  input: {
    consignmentId: number;
    shiftId: number;
    amount?: string | null;
    clientRequestId: string;
  },
  actor: DeliveryTxActor,
) {
  const hash = idempotencyHash(input);
  return withTx(async (tx) => {
    const replay = await checkIdempotency(tx, "delivery.payFee", input.clientRequestId, hash);
    if (replay != null) return { receiptId: replay, replay: true };
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.consignmentId)).for("update").limit(1))[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (cn.parcelStatus !== "DELIVERED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا تستحق الأجرة قبل نجاح التوصيل" });
    if (actor.role !== "admin" && actor.branchId != null && Number(cn.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخص فرعاً آخر" });
    }
    const sums = (await tx.select({
      earned: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} = 'FEE_REFUNDED' THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
      paid: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET') THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
    }).from(deliveryLedgerEntries).where(eq(deliveryLedgerEntries.consignmentId, input.consignmentId)))[0];
    const due = round2(money(sums?.earned ?? "0").minus(money(sums?.paid ?? "0")));
    const amount = round2(money(input.amount ?? due));
    if (amount.lte(0) || amount.gt(due)) throw new TRPCError({ code: "BAD_REQUEST", message: `المبلغ يجب أن يكون ضمن المستحق ${due.toFixed(2)}` });

    const resolved = await resolveBranchCashShiftTx(tx, Number(cn.branchId), input.shiftId);
    const drawer = await computeExpectedCash(tx, resolved.shiftId, resolved.openingBalance);
    if (amount.gt(drawer)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `نقد الدرج ${drawer.toFixed(2)} لا يغطي الأجرة ${amount.toFixed(2)}` });
    const inserted = await tx.insert(receipts).values({
      branchId: Number(cn.branchId),
      shiftId: resolved.shiftId,
      invoiceId: Number(cn.invoiceId),
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      partyType: "OTHER",
      referenceNumber: cn.consignmentNumber,
      description: `دفع أجرة توصيل ${cn.consignmentNumber}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(inserted);
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${cn.id}:FEE_PAID:${input.clientRequestId}`,
      partyId: Number(cn.partyId),
      consignmentId: Number(cn.id),
      branchId: Number(cn.branchId),
      entryType: "FEE_PAID",
      amount: toDbMoney(amount),
      actorUserId: actor.userId,
    });
    await postEntry(tx, {
      entryType: cn.feeCollection === "COUNTER" ? "DELIVERY_FEE_HELD" : "DELIVERY_FEE",
      dedupeKey: `DELIVERY_FEE_PAID:${cn.id}:${input.clientRequestId}`,
      branchId: Number(cn.branchId),
      invoiceId: Number(cn.invoiceId),
      deliveryPartyId: Number(cn.partyId),
      receiptId,
      amount: cn.feeCollection === "COUNTER" ? amount.neg() : amount,
      ...(cn.feeCollection === "SHOP" ? { cost: amount, profit: amount.neg() } : {}),
      notes: `دفع أجرة ${cn.consignmentNumber}`,
    });
    if (amount.eq(due)) await tx.update(deliveryConsignments).set({ feeSettledAt: new Date() }).where(eq(deliveryConsignments.id, Number(cn.id)));
    await recordIdempotencyKey(tx, "delivery.payFee", input.clientRequestId, receiptId, hash);
    return { receiptId, paid: amount.toFixed(2), remaining: due.minus(amount).toFixed(2), replay: false };
  });
}
