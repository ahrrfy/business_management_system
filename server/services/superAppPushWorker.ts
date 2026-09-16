import type { RowDataPacket } from "mysql2";

import { getDb, getPool } from "../db";
import { logger } from "../logger";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../tenancy/backgroundTenants";
import {
  isSuperAppExpoPushConfigured,
  sendSuperAppExpoPushToUser,
  superAppExpoPushEnvironment,
  SuperAppExpoPushValidationError,
  type SuperAppExpoPushEnvironment,
} from "./superAppPushService";

const MAX_ATTEMPTS = 8;
const STALE_LOCK_SECONDS = 5 * 60;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_INTERVAL_MS = 5_000;

interface OutboxRow extends RowDataPacket {
  id: number;
  userId: number;
  payload: unknown;
  environment: SuperAppExpoPushEnvironment;
  attemptCount: number;
}

export interface SuperAppPushWorkerResult {
  configured: boolean;
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

export function computeSuperAppExpoPushBackoffMs(attempt: number): number {
  const normalized = Math.max(1, Math.min(Math.trunc(attempt), MAX_ATTEMPTS));
  return Math.min(6 * 60 * 60 * 1_000, 15_000 * 2 ** (normalized - 1));
}

function boundedBatchSize(value: number): number {
  return Math.max(1, Math.min(Math.trunc(value) || DEFAULT_BATCH_SIZE, 100));
}

async function claimDueRows(batchSize: number): Promise<OutboxRow[]> {
  if (!getDb()) throw new Error("قاعدة البيانات غير متاحة.");
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE superAppExpoPushOutbox
          SET status = 'RETRY', lockedAt = NULL, availableAt = CURRENT_TIMESTAMP, lastError = 'STALE_LOCK'
        WHERE status = 'PROCESSING'
          AND lockedAt < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${STALE_LOCK_SECONDS} SECOND)`,
    );
    const [rows] = await connection.execute<OutboxRow[]>(
      `SELECT id, userId, payload, environment, attemptCount
         FROM superAppExpoPushOutbox
        WHERE status IN ('PENDING', 'RETRY') AND availableAt <= CURRENT_TIMESTAMP
        ORDER BY availableAt, id
        LIMIT ${boundedBatchSize(batchSize)} FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows) {
      await connection.execute(
        `UPDATE superAppExpoPushOutbox
            SET status = 'PROCESSING', attemptCount = attemptCount + 1, lockedAt = CURRENT_TIMESTAMP, lastError = NULL
          WHERE id = ?`,
        [row.id],
      );
    }
    await connection.commit();
    return rows;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function markOutcome(
  row: OutboxRow,
  outcome: "sent" | "retried" | "dead",
  errorCode: string | null = null,
): Promise<void> {
  if (outcome === "sent") {
    await getPool().execute(
      "UPDATE superAppExpoPushOutbox SET status = 'SENT', completedAt = CURRENT_TIMESTAMP, lockedAt = NULL, lastError = NULL WHERE id = ? AND status = 'PROCESSING'",
      [row.id],
    );
    return;
  }
  if (outcome === "dead") {
    await getPool().execute(
      "UPDATE superAppExpoPushOutbox SET status = 'DEAD', completedAt = CURRENT_TIMESTAMP, lockedAt = NULL, lastError = ? WHERE id = ? AND status = 'PROCESSING'",
      [errorCode?.slice(0, 64) ?? "DELIVERY_FAILED", row.id],
    );
    return;
  }
  await getPool().execute(
    "UPDATE superAppExpoPushOutbox SET status = 'RETRY', availableAt = ?, lockedAt = NULL, lastError = ? WHERE id = ? AND status = 'PROCESSING'",
    [new Date(Date.now() + computeSuperAppExpoPushBackoffMs(Number(row.attemptCount) + 1)), errorCode?.slice(0, 64) ?? "DELIVERY_FAILED", row.id],
  );
}

export async function runSuperAppExpoPushBatch(
  batchSize = DEFAULT_BATCH_SIZE,
  options: {
    configured?: () => boolean;
    deliver?: typeof sendSuperAppExpoPushToUser;
  } = {},
): Promise<SuperAppPushWorkerResult> {
  if (!isBackgroundOperationActive("superapp_expo_push_outbox")) {
    const runs = await runAcrossActiveTenants(
      "superapp_expo_push_outbox",
      () => runSuperAppExpoPushBatch(batchSize, options),
    );
    return runs.reduce<SuperAppPushWorkerResult>(
      (total, item) => ({
        configured: total.configured || item.configured,
        claimed: total.claimed + item.claimed,
        sent: total.sent + item.sent,
        retried: total.retried + item.retried,
        dead: total.dead + item.dead,
      }),
      { configured: false, claimed: 0, sent: 0, retried: 0, dead: 0 },
    );
  }
  const configured = options.configured ?? isSuperAppExpoPushConfigured;
  if (!configured()) return { configured: false, claimed: 0, sent: 0, retried: 0, dead: 0 };
  const deliver = options.deliver ?? sendSuperAppExpoPushToUser;
  const rows = await claimDueRows(batchSize);
  const result: SuperAppPushWorkerResult = { configured: true, claimed: rows.length, sent: 0, retried: 0, dead: 0 };
  for (const row of rows) {
    try {
      const delivery = await deliver(Number(row.userId), row.payload, row.environment);
      if (delivery.failed > 0) {
        await markOutcome(row, Number(row.attemptCount) + 1 >= MAX_ATTEMPTS ? "dead" : "retried", "PARTIAL_DELIVERY");
        result[Number(row.attemptCount) + 1 >= MAX_ATTEMPTS ? "dead" : "retried"] += 1;
      } else {
        await markOutcome(row, "sent");
        result.sent += 1;
      }
    } catch (error) {
      const invalid = error instanceof SuperAppExpoPushValidationError;
      const terminal = invalid || Number(row.attemptCount) + 1 >= MAX_ATTEMPTS;
      const state = terminal ? "dead" : "retried";
      await markOutcome(row, state, invalid ? "INVALID_PAYLOAD" : "DELIVERY_FAILED");
      result[state] += 1;
      logger.warn({ outboxId: row.id, errorCode: invalid ? "INVALID_PAYLOAD" : "DELIVERY_FAILED" }, "superAppExpoPush: تعذر تسليم صف الصندوق");
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startSuperAppExpoPushWorker(): boolean {
  if (process.env.NODE_ENV === "test" || timer || !isSuperAppExpoPushConfigured()) return false;
  // Fail at startup rather than silently mixing dev tokens with a production worker.
  superAppExpoPushEnvironment();
  const raw = Number(process.env.SUPERAPP_EXPO_PUSH_OUTBOX_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Math.max(1_000, Math.min(Number.isFinite(raw) ? raw : DEFAULT_INTERVAL_MS, 60_000));
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSuperAppExpoPushBatch();
    } catch (error) {
      logger.error({ err: error }, "superAppExpoPush: فشل تشغيل عامل الصندوق");
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return true;
}

export function stopSuperAppExpoPushWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
