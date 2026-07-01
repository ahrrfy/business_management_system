// ترحيل (D8): خصم الأجرة وتوريد الصافي. gross-up: PAYMENT_IN=COD كامل + DELIVERY_FEE=أجرة ⇒ صافي الدرج=المورَّد.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { deliveryConsignments, deliveryParties, deliveryRemittances, invoices, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { shiftIdForCashTx } from "../shiftService";
import { withTx } from "../tx";
import { nextRemittanceNumber } from "./numbering";
import type { DeliveryTxActor } from "./types";

/** ترحيل (D8): خصم الأجرة وتوريد الصافي. gross-up: PAYMENT_IN=COD كامل + DELIVERY_FEE=أجرة ⇒ صافي الدرج=المورَّد. */
export interface RemittanceLineInput {
  consignmentId: number;
  collectedAmount: string; // المُحصَّل لهذه الإرسالية (0..المتبقّي)
}

export interface RemittanceInput {
  branchId: number;
  partyId: number;
  lines: RemittanceLineInput[];
  shiftType?: "RECEPTION" | "RETAIL";
  clientRequestId?: string | null;
}

export async function recordDeliveryRemittance(input: RemittanceInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.remit", input.clientRequestId);
      if (existingId != null) {
        const rm = (await tx.select().from(deliveryRemittances).where(eq(deliveryRemittances.id, existingId)).limit(1))[0];
        return {
          remittanceId: existingId,
          remittanceNumber: rm?.remittanceNumber ?? "",
          collectedTotal: String(rm?.collectedTotal ?? "0"),
          feesTotal: String(rm?.feesTotal ?? "0"),
          netRemitted: String(rm?.netRemitted ?? "0"),
          shortfallTotal: String(rm?.shortfallTotal ?? "0"),
          status: rm?.status ?? "BALANCED",
          idempotentReplay: true as const,
        };
      }
    }
    if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا إرساليات للتسوية" });

    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });

    // المرور ١: قفل + تحقّق + حساب (بلا كتابة) — ترتيب أقفال الإرساليات تصاعدياً يمنع الجمود.
    type Work = { id: number; invoiceId: number; collected: Decimal; newCollected: Decimal; delivered: boolean; fee: Decimal; remaining: Decimal };
    const work: Work[] = [];
    let collectedTotal = new Decimal(0);
    let feesTotal = new Decimal(0);
    let expectedTotal = new Decimal(0);
    const sortedLines = [...input.lines].sort((a, b) => a.consignmentId - b.consignmentId);
    for (const line of sortedLines) {
      const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, line.consignmentId)).for("update").limit(1))[0];
      if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: `إرسالية ${line.consignmentId} غير موجودة` });
      if (Number(cn.partyId) !== input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "إرسالية لجهة أخرى" });
      if (cn.status !== "DISPATCHED" && cn.status !== "PARTIAL") throw new TRPCError({ code: "BAD_REQUEST", message: `إرسالية ${cn.consignmentNumber} غير قابلة للتسوية` });
      const collected = round2(money(line.collectedAmount));
      if (collected.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ سالب" });
      const remaining = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
      if (collected.gt(remaining)) throw new TRPCError({ code: "BAD_REQUEST", message: `أكثر من المتبقّي للإرسالية ${cn.consignmentNumber}` });
      const newCollected = round2(money(cn.collectedAmount).plus(collected));
      const delivered = newCollected.gte(money(cn.codAmount));
      const fee = delivered ? round2(money(cn.deliveryFee)) : new Decimal(0); // الأجرة تُحقَّق عند التسليم الكامل فقط
      work.push({ id: Number(cn.id), invoiceId: Number(cn.invoiceId), collected, newCollected, delivered, fee, remaining });
      collectedTotal = collectedTotal.plus(collected);
      feesTotal = feesTotal.plus(fee);
      expectedTotal = expectedTotal.plus(remaining);
    }
    collectedTotal = round2(collectedTotal);
    feesTotal = round2(feesTotal);
    const netRemitted = round2(collectedTotal.minus(feesTotal));
    const shortfallTotal = round2(round2(expectedTotal).minus(collectedTotal)); // عجز يبقى عهدة (D4)
    const status: "BALANCED" | "SHORT" | "OVER" = shortfallTotal.gt("0.01") ? "SHORT" : shortfallTotal.lt("-0.01") ? "OVER" : "BALANCED";

    // درج المُستلِم (RECEPTION افتراضياً): صافي النقد (collected − fee) يدخله فعلياً.
    const { shiftId, cashBucket } = await shiftIdForCashTx(tx, { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role }, input.branchId, "توريد مندوب", input.shiftType ?? "RECEPTION");
    const remittanceNumber = await nextRemittanceNumber(tx, input.branchId);

    const rmRes = await tx.insert(deliveryRemittances).values({
      remittanceNumber,
      branchId: input.branchId,
      partyId: input.partyId,
      shiftId,
      collectedTotal: toDbMoney(collectedTotal),
      feesTotal: toDbMoney(feesTotal),
      netRemitted: toDbMoney(netRemitted),
      shortfallTotal: toDbMoney(shortfallTotal.lt(0) ? new Decimal(0) : shortfallTotal),
      status,
      receivedBy: actor.userId,
    });
    const remittanceId = extractInsertId(rmRes);

    // إيصال درج IN = COD المُحصَّل كاملاً (سلامة الفاتورة)، وOUT = الأجور (مصروف) ⇒ صافي الدرج = المورَّد.
    let receiptInId: number | null = null;
    let receiptOutId: number | null = null;
    if (collectedTotal.gt(0)) {
      const rIn = await tx.insert(receipts).values({
        branchId: input.branchId, shiftId, direction: "IN", amount: toDbMoney(collectedTotal),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", referenceNumber: remittanceNumber,
        partyType: "OTHER", description: `توريد تحصيلات مندوب ${remittanceNumber}`, createdBy: actor.userId,
      });
      receiptInId = extractInsertId(rIn);
    }
    if (feesTotal.gt(0)) {
      const rOut = await tx.insert(receipts).values({
        branchId: input.branchId, shiftId, direction: "OUT", amount: toDbMoney(feesTotal),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", referenceNumber: remittanceNumber,
        partyType: "OTHER", description: `أجور توصيل ${remittanceNumber}`, createdBy: actor.userId,
      });
      receiptOutId = extractInsertId(rOut);
    }
    await tx.update(deliveryRemittances).set({ receiptInId, receiptOutId }).where(eq(deliveryRemittances.id, remittanceId));

    // المرور ٢: تطبيق لكل إرسالية.
    for (const w of work) {
      const newStatus = w.delivered ? "DELIVERED" : "PARTIAL";
      await tx.update(deliveryConsignments).set({
        collectedAmount: toDbMoney(w.newCollected),
        status: newStatus,
        remittanceId,
        settledAt: w.delivered ? new Date() : null,
      }).where(eq(deliveryConsignments.id, w.id));

      if (w.collected.gt(0)) {
        // تسوية الفاتورة بالـCOD المُحصَّل كاملاً (PAYMENT_IN) — يربط إيصال IN الدفعة.
        await postEntry(tx, {
          entryType: "PAYMENT_IN", branchId: input.branchId, invoiceId: w.invoiceId, receiptId: receiptInId,
          amount: w.collected, notes: `توريد ${remittanceNumber}`,
        });
        const inv = (await tx.select({ total: invoices.total, paidAmount: invoices.paidAmount }).from(invoices).where(eq(invoices.id, w.invoiceId)).limit(1))[0];
        if (inv) {
          const newPaid = round2(money(inv.paidAmount).plus(w.collected));
          await tx.update(invoices).set({ paidAmount: toDbMoney(newPaid), status: computeInvoiceStatus(String(inv.total), toDbMoney(newPaid)), paymentDate: new Date() }).where(eq(invoices.id, w.invoiceId));
        }
        // خفض العهدة بالـCOD المُحصَّل كاملاً (الأجرة netting لا تَمسّ العهدة).
        await adjustDeliveryBalance(tx, input.partyId, w.collected.neg());
        await postEntry(tx, {
          entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_REMIT:${w.id}:${remittanceId}`,
          branchId: input.branchId, invoiceId: w.invoiceId, deliveryPartyId: input.partyId, amount: w.collected,
        });
      }
      // مصروف الأجرة عند التسليم الكامل (cost-only؛ يربط إيصال OUT الدفعة).
      if (w.fee.gt(0)) {
        await postEntry(tx, {
          entryType: "DELIVERY_FEE", branchId: input.branchId, invoiceId: w.invoiceId, receiptId: receiptOutId,
          deliveryPartyId: input.partyId, amount: w.fee, cost: w.fee, profit: w.fee.neg(),
          notes: `أجرة توصيل ${remittanceNumber}`,
        });
      }
    }

    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.remit", input.clientRequestId, remittanceId);
    return {
      remittanceId, remittanceNumber,
      collectedTotal: collectedTotal.toFixed(2), feesTotal: feesTotal.toFixed(2),
      netRemitted: netRemitted.toFixed(2), shortfallTotal: (shortfallTotal.lt(0) ? new Decimal(0) : shortfallTotal).toFixed(2),
      status,
    };
  });
}
