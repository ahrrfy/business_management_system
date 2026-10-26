import { and, inArray } from "drizzle-orm";
import { deliveryEvents } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * In this business, committing assignment is itself the carrier-custody event.
 * Cancellation is allowed only after the full shipment physically returns to
 * the library, making the source free for reassignment without reversing sale
 * or stock. A later courier/staff pickup/out event requires the declared-return
 * and physical-receipt workflow instead of a direct deassignment.
 */
export async function physicalHandoverConsignmentIdsTx(
  tx: Tx,
  consignmentIds: number[],
) {
  const ids = Array.from(new Set(consignmentIds.map(Number))).filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  if (!ids.length) return new Set<number>();
  const events = await tx
    .select({
      id: deliveryEvents.id,
      consignmentId: deliveryEvents.consignmentId,
      eventType: deliveryEvents.eventType,
      eventKey: deliveryEvents.eventKey,
    })
    .from(deliveryEvents)
    .where(
      and(
        inArray(deliveryEvents.consignmentId, ids),
        inArray(deliveryEvents.eventType, [
          "ASSIGNED",
          "ASSIGNMENT_REACTIVATED",
          "PICKED_UP",
          "OUT_FOR_DELIVERY",
        ]),
      ),
    )
    .for("share");
  const result = new Set<number>();
  const latestAssignmentEvent = new Map<number, number>();
  for (const event of events) {
    const consignmentId = Number(event.consignmentId);
    const legacyAssignmentKey = `CN:${consignmentId}:OUT_FOR_DELIVERY`;
    if (
      event.eventType === "ASSIGNED" ||
      event.eventType === "ASSIGNMENT_REACTIVATED" ||
      (event.eventType === "OUT_FOR_DELIVERY" &&
        event.eventKey === legacyAssignmentKey)
    ) {
      latestAssignmentEvent.set(
        consignmentId,
        Math.max(latestAssignmentEvent.get(consignmentId) ?? 0, Number(event.id)),
      );
    }
  }
  for (const event of events) {
    const consignmentId = Number(event.consignmentId);
    const legacyAssignmentKey = `CN:${consignmentId}:OUT_FOR_DELIVERY`;
    if (Number(event.id) <= (latestAssignmentEvent.get(consignmentId) ?? 0))
      continue;
    if (
      event.eventType === "PICKED_UP" ||
      (event.eventType === "OUT_FOR_DELIVERY" &&
        event.eventKey !== legacyAssignmentKey)
    )
      result.add(consignmentId);
  }
  return result;
}
