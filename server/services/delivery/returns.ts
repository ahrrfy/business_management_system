// إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { deliveryConsignments, deliveryParties, invoiceItems, invoices, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { applyMovement } from "../inventoryService";
import { adjustDeliveryBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { shiftIdForCashTx } from "../shiftService";
import { withTx } from "../tx";
import type { DeliveryTxActor } from "./types";

/** إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون. مقيَّد بـDISPATCHED (collected==0). */
export async function returnConsignment(consignmentId: number, actor: DeliveryTxActor & { clientRequestId?: string | null }) {
  return withTx(async (tx) => {
    if (actor.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.return", actor.clientRequestId);
      if (existingId != null) return { consignmentId, reversed: true as const, idempotentReplay: true as const };
    }
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, consignmentId)).for("update").limit(1))[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (cn.status !== "DISPATCHED") throw new TRPCError({ code: "BAD_REQUEST", message: "يُرجَع فقط إرسالٌ لم يُحصَّل منه شيء (للجزئي استعمل المرتجعات)" });
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, Number(cn.partyId))).for("update").limit(1))[0];
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });

    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, Number(cn.invoiceId)));
    // إعادة المخزون (حركة IN) لكل بند له صنف.
    // ملاحظة (تدقيق ٢/٧): تمييز «البند الذي خُصم مخزونه فعلاً» عن «منتج مُخصَّص لم يُخصَم» ليس
    // بمجرّد workOrderId (بند أمر شغل بـbaseVariant يُخصَم فعلاً) — يحتاج فحص «هل جرت حركة OUT
    // للصنف على هذه الفاتورة». مؤجَّل لتفادي منع إعادة تخزينٍ مشروع (أمسك CI الحارس الفجّ).
    for (const it of items) {
      await applyMovement(tx, {
        variantId: Number(it.variantId), branchId: Number(cn.branchId), baseQuantity: Number(it.baseQuantity),
        movementType: "IN", referenceType: "DELIVERY_RETURN", referenceId: consignmentId, createdBy: actor.userId,
      });
    }

    // عكس البيع: قيد RETURN بقيم سالبة (لا AR — customerId=NULL على فاتورة COD).
    const total = money(inv.total);
    const costTotal = money(inv.costTotal);
    await postEntry(tx, {
      entryType: "RETURN", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
      revenue: total.neg(), cost: costTotal.neg(), profit: round2(total.minus(costTotal)).neg(), amount: total.neg(),
      notes: `إرجاع إرسالية ${cn.consignmentNumber}`,
    });
    await tx.update(invoices).set({ status: "RETURNED", returnedTotal: toDbMoney(total) }).where(eq(invoices.id, Number(cn.invoiceId)));

    // عكس العهدة بالـCOD القائم (collected==0 ⇒ = codAmount).
    const outstanding = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
    if (outstanding.gt(0)) {
      await adjustDeliveryBalance(tx, Number(cn.partyId), outstanding.neg());
      await postEntry(tx, {
        entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_RETURN:${consignmentId}`,
        branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId), deliveryPartyId: Number(cn.partyId),
        amount: outstanding, notes: `عكس عهدة — إرجاع ${cn.consignmentNumber}`,
      });
    }

    // رد العربون نقداً إن وُجد (paidAmount على فاتورة COD = العربون).
    const deposit = round2(money(inv.paidAmount));
    if (deposit.gt(0)) {
      const { shiftId, cashBucket } = await shiftIdForCashTx(tx, { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role }, Number(cn.branchId), "رد عربون إرجاع", "RECEPTION");
      const rOut = await tx.insert(receipts).values({
        branchId: Number(cn.branchId), shiftId, direction: "OUT", amount: toDbMoney(deposit),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", invoiceId: Number(cn.invoiceId),
        referenceNumber: `RET-${cn.consignmentNumber}`, description: `رد عربون إرجاع ${cn.consignmentNumber}`, createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "PAYMENT_OUT", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        receiptId: extractInsertId(rOut), amount: deposit, notes: `رد عربون ${cn.consignmentNumber}`,
      });
      await tx.update(invoices).set({ paidAmount: "0.00" }).where(eq(invoices.id, Number(cn.invoiceId)));
    }

    await tx.update(deliveryConsignments).set({ status: "RETURNED", settledAt: new Date() }).where(eq(deliveryConsignments.id, consignmentId));
    if (actor.clientRequestId) await recordIdempotencyKey(tx, "delivery.return", actor.clientRequestId, consignmentId);
    void party;
    return { consignmentId, reversed: true as const, invoiceId: Number(cn.invoiceId) };
  });
}
