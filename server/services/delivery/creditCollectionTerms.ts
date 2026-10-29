import { and, desc, eq, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryEvents } from "../../../drizzle/schema";
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
