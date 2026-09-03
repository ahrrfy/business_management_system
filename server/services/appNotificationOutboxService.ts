import { and, asc, eq, inArray, lt, lte, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { appNotificationOutbox, appNotifications } from "../../drizzle/schema";
import type { Tx } from "../db";
import { logger } from "../logger";
import {
  APP_NOTIFICATION_EVENT_KEY_MAX_LENGTH,
  APP_NOTIFICATION_FAMILIES,
  APP_NOTIFICATION_KINDS,
  createAppNotification,
  type AppNotificationKind,
  type AppNotificationFamily,
  type CreateAppNotificationInput,
} from "./appNotificationService";
import { withTx } from "./tx";

const MAX_BATCH_SIZE = 200;
const DELIVERY_CONCURRENCY = 8;
const MAX_CLAIM_ROUNDS = 8;

const APP_NOTIFICATION_KIND_SET = new Set<string>(APP_NOTIFICATION_KINDS);
const APP_NOTIFICATION_FAMILY_SET = new Set<string>(APP_NOTIFICATION_FAMILIES);

export type AppNotificationWriter = (
  input: CreateAppNotificationInput,
) => Promise<{ created: boolean }>;

export interface AppNotificationOutboxIntent {
  branchId: number | null;
  /** Ordered delivery stream; a later intent never overtakes an earlier PENDING row. */
  streamKey: string;
  occurrenceId: string;
  notification: CreateAppNotificationInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNotificationPayload(value: unknown): CreateAppNotificationInput | null {
  if (!isRecord(value)) return null;
  if (
    !Number.isSafeInteger(value.userId) ||
    Number(value.userId) <= 0 ||
    typeof value.kind !== "string" ||
    !APP_NOTIFICATION_KIND_SET.has(value.kind) ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.route !== "string" ||
    typeof value.eventKey !== "string" ||
    value.eventKey.length < 1 ||
    value.eventKey.length > APP_NOTIFICATION_EVENT_KEY_MAX_LENGTH
  ) return null;
  if (value.entityType != null && typeof value.entityType !== "string") return null;
  if (value.family != null && (typeof value.family !== "string" || !APP_NOTIFICATION_FAMILY_SET.has(value.family))) return null;
  if (value.entityId != null && (!Number.isSafeInteger(value.entityId) || Number(value.entityId) <= 0)) return null;
  if (value.requiresAction != null && typeof value.requiresAction !== "boolean") return null;
  if (value.lockScreenSafe != null && typeof value.lockScreenSafe !== "boolean") return null;
  if (value.push != null && typeof value.push !== "boolean") return null;
  return {
    userId: Number(value.userId),
    kind: value.kind as AppNotificationKind,
    family: value.family as AppNotificationFamily | undefined,
    title: value.title,
    body: value.body,
    route: value.route,
    eventKey: value.eventKey,
    entityType: value.entityType == null ? null : value.entityType,
    entityId: value.entityId == null ? null : Number(value.entityId),
    requiresAction: value.requiresAction as boolean | undefined,
    lockScreenSafe: value.lockScreenSafe as boolean | undefined,
    push: value.push as boolean | undefined,
  };
}

/** Write notification intents beside the domain change; delivery is deliberately post-commit. */
export async function enqueueAppNotificationOutbox(
  tx: Tx,
  intents: AppNotificationOutboxIntent[],
): Promise<void> {
  if (intents.length === 0) return;
  await tx.insert(appNotificationOutbox).values(intents.map((intent) => ({
    branchId: intent.branchId,
    recipientUserId: intent.notification.userId,
    streamKey: intent.streamKey,
    occurrenceId: intent.occurrenceId,
    eventKey: intent.notification.eventKey,
    payload: intent.notification,
  })));
}

async function claimBatch(options: {
  branchId?: number;
  occurrenceId?: string;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? MAX_BATCH_SIZE), MAX_BATCH_SIZE));
  return withTx(async (tx) => {
    const earlierInStream = alias(appNotificationOutbox, "earlierAppNotificationOutbox");
    const conditions = [
      eq(appNotificationOutbox.status, "PENDING"),
      lte(appNotificationOutbox.availableAt, sql`NOW()`),
      notExists(
        tx
          .select({ id: earlierInStream.id })
          .from(earlierInStream)
          .where(and(
            eq(earlierInStream.streamKey, appNotificationOutbox.streamKey),
            eq(earlierInStream.status, "PENDING"),
            lt(earlierInStream.id, appNotificationOutbox.id),
          )),
      ),
    ];
    if (options.branchId != null) conditions.push(eq(appNotificationOutbox.branchId, options.branchId));
    if (options.occurrenceId) conditions.push(eq(appNotificationOutbox.occurrenceId, options.occurrenceId));
    const rows = await tx
      .select({
        id: appNotificationOutbox.id,
        recipientUserId: appNotificationOutbox.recipientUserId,
        eventKey: appNotificationOutbox.eventKey,
        payload: appNotificationOutbox.payload,
      })
      .from(appNotificationOutbox)
      .where(and(...conditions))
      .orderBy(asc(appNotificationOutbox.availableAt), asc(appNotificationOutbox.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    const ids = rows.map((row) => Number(row.id));
    if (ids.length > 0) {
      // Lease first. A process crash leaves the row pending and eligible again after five minutes.
      await tx
        .update(appNotificationOutbox)
        .set({
          attemptCount: sql`${appNotificationOutbox.attemptCount} + 1`,
          // Exponential retry prevents one full failed batch from becoming due on every five-minute
          // pulse and starving newer streams forever. Retries remain unbounded, capped at one hour.
          // MySQL evaluates single-table SET assignments left-to-right, so CASE sees attemptCount
          // after the increment above (first claim = 1).
          availableAt: sql`CASE
            WHEN ${appNotificationOutbox.attemptCount} = 1 THEN DATE_ADD(NOW(), INTERVAL 5 MINUTE)
            WHEN ${appNotificationOutbox.attemptCount} = 2 THEN DATE_ADD(NOW(), INTERVAL 10 MINUTE)
            WHEN ${appNotificationOutbox.attemptCount} = 3 THEN DATE_ADD(NOW(), INTERVAL 20 MINUTE)
            WHEN ${appNotificationOutbox.attemptCount} = 4 THEN DATE_ADD(NOW(), INTERVAL 40 MINUTE)
            ELSE DATE_ADD(NOW(), INTERVAL 60 MINUTE)
          END`,
        })
        .where(and(
          inArray(appNotificationOutbox.id, ids),
          eq(appNotificationOutbox.status, "PENDING"),
        ));
    }
    return rows;
  }, { gate: "NONE" });
}

async function processClaimedRow(
  row: Awaited<ReturnType<typeof claimBatch>>[number],
  notificationWriter: AppNotificationWriter,
): Promise<{ created: number; failed: number }> {
  const notification = parseNotificationPayload(row.payload);
  if (
    !notification ||
    notification.userId !== Number(row.recipientUserId) ||
    notification.eventKey !== row.eventKey
  ) {
    await withTx(async (tx) => {
      await tx
        .update(appNotificationOutbox)
        .set({ status: "INVALID", processedAt: new Date(), lastError: "invalid notification payload" })
        .where(and(eq(appNotificationOutbox.id, row.id), eq(appNotificationOutbox.status, "PENDING")));
    }, { gate: "NONE" });
    logger.error({ outboxId: row.id, eventKey: row.eventKey }, "app_notification_outbox.invalid_payload");
    return { created: 0, failed: 1 };
  }
  try {
    const result = await notificationWriter(notification);
    await withTx(async (tx) => {
      // Never acknowledge from the writer's return value alone. createAppNotification returns
      // created:false for a duplicate anywhere in its transaction; a stray native-push duplicate
      // (or a broken adapter returning true) must not become a false delivery acknowledgement.
      const [existing] = await tx
        .select({
          id: appNotifications.id,
          userId: appNotifications.userId,
          kind: appNotifications.kind,
          entityType: appNotifications.entityType,
          entityId: appNotifications.entityId,
        })
        .from(appNotifications)
        .where(eq(appNotifications.eventKey, notification.eventKey))
        .limit(1);
      if (
        !existing ||
        Number(existing.userId) !== notification.userId ||
        existing.kind !== notification.kind ||
        existing.entityType !== (notification.entityType ?? null) ||
        (existing.entityId == null ? null : Number(existing.entityId)) !== (notification.entityId ?? null)
      ) {
        throw new Error("writer result without matching durable app notification");
      }
      await tx
        .update(appNotificationOutbox)
        .set({ status: "DELIVERED", processedAt: new Date(), lastError: null })
        .where(and(eq(appNotificationOutbox.id, row.id), eq(appNotificationOutbox.status, "PENDING")));
    }, { gate: "NONE" });
    return { created: result.created ? 1 : 0, failed: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withTx(async (tx) => {
      await tx
        .update(appNotificationOutbox)
        .set({ lastError: message.slice(0, 500) })
        .where(and(eq(appNotificationOutbox.id, row.id), eq(appNotificationOutbox.status, "PENDING")));
    }, { gate: "NONE" });
    logger.warn({ err: error, outboxId: row.id, eventKey: row.eventKey }, "app_notification_outbox.delivery_failed");
    return { created: 0, failed: 1 };
  }
}

/**
 * Reconcile due intents with bounded concurrency. Failed writes stay PENDING indefinitely; the
 * lease advances them out of the current batch, so one outage cannot starve later notifications.
 */
export async function reconcileAppNotificationOutbox(options: {
  branchId?: number;
  occurrenceId?: string;
  limit?: number;
  notificationWriter?: AppNotificationWriter;
} = {}): Promise<{ createdCount: number; claimedCount: number; failedCount: number }> {
  const writer = options.notificationWriter ?? createAppNotification;
  let createdCount = 0;
  let claimedCount = 0;
  let failedCount = 0;
  let claimRounds = 0;
  const maxRows = Math.max(1, Math.min(Math.trunc(options.limit ?? MAX_BATCH_SIZE), MAX_BATCH_SIZE));
  // More than one round lets a successful older row unblock the next event in its stream during
  // the same pulse. A failed older row remains PENDING and therefore continues to block overtaking.
  while (claimedCount < maxRows && claimRounds < MAX_CLAIM_ROUNDS) {
    claimRounds++;
    const rows = await claimBatch({ ...options, limit: maxRows - claimedCount });
    if (rows.length === 0) break;
    claimedCount += rows.length;
    for (let offset = 0; offset < rows.length; offset += DELIVERY_CONCURRENCY) {
      const results = await Promise.all(
        rows.slice(offset, offset + DELIVERY_CONCURRENCY).map((row) => processClaimedRow(row, writer)),
      );
      for (const result of results) {
        createdCount += result.created;
        failedCount += result.failed;
      }
    }
  }
  return { createdCount, claimedCount, failedCount };
}
