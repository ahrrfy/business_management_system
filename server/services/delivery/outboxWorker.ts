import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryEvents, deliveryOutbox, deliveryPartyMembers } from "../../../drizzle/schema";
import { getDb, isMultiTenantModeActive } from "../../db";
import { logger } from "../../logger";
import { getCurrentCompanyId } from "../../tenancy/context";
import { runAcrossActiveTenants } from "../../tenancy/backgroundTenants";
import { createAppNotification } from "../appNotificationService";
import { withTx } from "../tx";

const BATCH_SIZE = 40;

async function claimBatch(): Promise<number[]> {
  return withTx(async (tx) => {
    const rows = await tx.select({ id: deliveryOutbox.id }).from(deliveryOutbox)
      .where(and(isNull(deliveryOutbox.processedAt), lte(deliveryOutbox.availableAt, sql`NOW()`)))
      .orderBy(asc(deliveryOutbox.id)).limit(BATCH_SIZE)
      .for("update", { skipLocked: true });
    const ids = rows.map((r) => Number(r.id));
    if (ids.length) {
      await tx.update(deliveryOutbox).set({
        attempts: sql`${deliveryOutbox.attempts} + 1`,
        availableAt: sql`DATE_ADD(NOW(), INTERVAL 5 MINUTE)`,
      }).where(inArray(deliveryOutbox.id, ids));
    }
    return ids;
  });
}

async function recipientsFor(row: { topic: string; partyId: number; assignedUserId: number | null }): Promise<number[]> {
  if (row.assignedUserId != null && (row.topic === "delivery.assigned" || row.topic === "delivery.reassigned")) {
    return [row.assignedUserId];
  }
  const db = getDb();
  if (!db) return [];
  const roles = row.topic === "delivery.assigned" || row.topic === "delivery.reassigned"
    ? ["DRIVER" as const]
    : row.topic === "delivery.failed"
      ? ["MANAGER" as const]
      : row.topic.includes("money") || row.topic === "delivery.delivered"
        ? ["MANAGER" as const, "ACCOUNTANT" as const]
        : [];
  if (!roles.length) return [];
  const members = await db.select({ userId: deliveryPartyMembers.userId }).from(deliveryPartyMembers)
    .where(and(
      eq(deliveryPartyMembers.partyId, row.partyId),
      eq(deliveryPartyMembers.isActive, true),
      inArray(deliveryPartyMembers.memberRole, roles),
    ));
  return Array.from(new Set(members.map((m) => Number(m.userId))));
}

async function processRow(id: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const row = (await db.select({
      id: deliveryOutbox.id,
      eventId: deliveryOutbox.eventId,
      topic: deliveryOutbox.topic,
      consignmentId: deliveryEvents.consignmentId,
      eventType: deliveryEvents.eventType,
      partyId: deliveryConsignments.partyId,
      assignedUserId: deliveryConsignments.assignedUserId,
      consignmentNumber: deliveryConsignments.consignmentNumber,
    }).from(deliveryOutbox)
      .innerJoin(deliveryEvents, eq(deliveryEvents.id, deliveryOutbox.eventId))
      .innerJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryEvents.consignmentId))
      .where(and(eq(deliveryOutbox.id, id), isNull(deliveryOutbox.processedAt))).limit(1))[0];
    if (!row) return;
    const recipients = await recipientsFor({
      topic: row.topic,
      partyId: Number(row.partyId),
      assignedUserId: row.assignedUserId != null ? Number(row.assignedUserId) : null,
    });
    const title = row.topic === "delivery.failed" ? "تعذر توصيل طرد" : row.topic === "delivery.delivered" ? "تم تسليم طرد" : "تحديث طرد توصيل";
    for (const userId of recipients) {
      await createAppNotification({
        userId,
        kind: row.topic === "delivery.failed" ? "APPROVAL_REQUIRED" : "TASK_ASSIGNED",
        title,
        body: `${row.consignmentNumber} — ${row.eventType}`,
        route: "/my-deliveries",
        eventKey: `delivery-outbox:${row.eventId}:user:${userId}`,
        entityType: "deliveryConsignment",
        entityId: Number(row.consignmentId),
        requiresAction: row.topic === "delivery.failed" || row.topic === "delivery.assigned" || row.topic === "delivery.reassigned",
        push: true,
      });
    }
    await db.update(deliveryOutbox).set({ processedAt: new Date(), lastError: null }).where(eq(deliveryOutbox.id, id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(deliveryOutbox).set({ lastError: message.slice(0, 500) }).where(eq(deliveryOutbox.id, id));
    throw error;
  }
}

export async function sweepDeliveryOutboxOnce(): Promise<{ claimed: number }> {
  if (isMultiTenantModeActive() && getCurrentCompanyId() == null) {
    const runs = await runAcrossActiveTenants("delivery_outbox", sweepDeliveryOutboxOnce);
    return { claimed: runs.reduce((sum, r) => sum + r.claimed, 0) };
  }
  const ids = await claimBatch();
  for (const id of ids) {
    try { await processRow(id); } catch (error) { logger.error({ err: error, outboxId: id }, "delivery outbox processing failed"); }
  }
  return { claimed: ids.length };
}

let task: ScheduledTask | null = null;
let running = false;

export function startDeliveryOutboxWorker(): void {
  if (process.env.NODE_ENV === "test") return;
  task?.stop();
  void sweepDeliveryOutboxOnce().catch((error) => logger.error({ err: error }, "delivery outbox startup sweep failed"));
  task = cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try { await sweepDeliveryOutboxOnce(); } finally { running = false; }
  }, { timezone: "UTC" });
}

export function stopDeliveryOutboxWorker(): void {
  task?.stop();
  task = null;
}
