import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { deliveryConsignments, deliveryEvents, invoices } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { appendDeliveryEvent } from "./lifecycle";

/** An append-only operational instruction; it never creates a receipt or changes invoice terms. */
export const CREDIT_COLLECTION_TERMS = "CREDIT_COLLECTION_TERMS";

export const consignmentCreditCollectionSql = sql<boolean>`COALESCE((SELECT
  JSON_UNQUOTE(JSON_EXTRACT(cct.payload, '$.collectCreditOnDelivery')) = 'true'
  FROM deliveryEvents cct WHERE cct.consignmentId = ${deliveryConsignments.id}
  AND cct.eventType = 'CREDIT_COLLECTION_TERMS' ORDER BY cct.id DESC LIMIT 1), 0)`.mapWith(Boolean);

export async function creditCollectionChoiceTx(tx: Tx, consignmentId: number): Promise<boolean> {
  const [event] = await tx.select({ payload: deliveryEvents.payload }).from(deliveryEvents)
    .where(and(eq(deliveryEvents.consignmentId, consignmentId), eq(deliveryEvents.eventType, CREDIT_COLLECTION_TERMS)))
    .orderBy(desc(deliveryEvents.id)).limit(1);
  const payload = event?.payload;
  return payload != null && typeof payload === "object" && "collectCreditOnDelivery" in payload
    && payload.collectCreditOnDelivery === true;
}

/** Reassigning the carrier preserves the accepted instruction; it cannot silently choose again. */
export async function preservedCreditCollectionChoiceTx(tx: Tx,
  members: Array<{ id: number; invoiceId: number | null }>): Promise<boolean> {
  const ids = members.flatMap(row => row.invoiceId == null ? [] : [row.invoiceId]);
  if (!ids.length) return false;
  const creditRows = await tx.select({ id: invoices.id }).from(invoices)
    .where(and(inArray(invoices.id, ids), eq(invoices.paymentMode, "CREDIT"))).for("share");
  const creditIds = new Set(creditRows.map(row => row.id));
  const choices = new Set<boolean>();
  for (const member of members) if (member.invoiceId != null && creditIds.has(member.invoiceId))
    choices.add(await creditCollectionChoiceTx(tx, member.id));
  if (choices.size > 1) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
    what: "تعذرت إعادة إسناد الشحنة", why: "مستندات الآجل تحمل تعليمات تحصيل مختلفة",
    doThis: "راجع تعليمات المستندات الأصلية قبل إعادة الإسناد؛ لم تتغير مطالبة أي عميل أو مندوب",
  }) });
  return choices.has(true);
}

export async function recordCreditCollectionChoiceTx(tx: Tx, input: {
  consignmentId: number; collectCreditOnDelivery: boolean; actorUserId: number;
  eventKey: string; reason?: string; claimVersion?: number;
}) {
  return appendDeliveryEvent(tx, {
    eventKey: input.eventKey, consignmentId: input.consignmentId,
    eventType: CREDIT_COLLECTION_TERMS, actorUserId: input.actorUserId,
    payload: { collectCreditOnDelivery: input.collectCreditOnDelivery,
      ...(input.reason ? { reason: input.reason } : {}), ...(input.claimVersion ? { claimVersion: input.claimVersion } : {}) },
  });
}
