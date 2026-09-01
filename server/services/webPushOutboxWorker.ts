import type { RowDataPacket } from "mysql2";
import { getDb, getPool } from "../db";
import { logger } from "../logger";
import {
  isBackgroundOperationActive,
  runAcrossActiveTenants,
} from "../tenancy/backgroundTenants";
import {
  isPushEnabled,
  sendPushToUser,
  type AppPushPayload,
} from "./pushService";

const MAX_ATTEMPTS = 8;
const STALE_LOCK_SECONDS = 5 * 60;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_INTERVAL_MS = 5_000;
const ALLOWED_KINDS = new Set([
  "MORNING_BRIEF",
  "ATTENDANCE_CHECK_IN",
  "ATTENDANCE_CHECK_OUT",
  "TASK_ASSIGNED",
  "PAYROLL_READY",
  "LEAVE_STATUS",
  "APPROVAL_REQUIRED",
  "ANNOUNCEMENT",
  "SESSION_EVENT",
  "SYSTEM",
]);

interface WebPushOutboxRow extends RowDataPacket {
  id: number;
  userId: number;
  payload: unknown;
  attemptCount: number;
}

export interface WebPushOutboxRunResult {
  configured: boolean;
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

export interface WebPushOutboxRunOptions {
  configured?: () => boolean;
  deliver?: typeof sendPushToUser;
}

export function computeWebPushBackoffMs(attempt: number): number {
  const normalized = Math.max(1, Math.min(Math.trunc(attempt), MAX_ATTEMPTS));
  return Math.min(6 * 60 * 60 * 1_000, 15_000 * 2 ** (normalized - 1));
}

function parsePayload(value: unknown): AppPushPayload {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("INVALID_PAYLOAD");
    }
  }
  if (!parsed || typeof parsed !== "object") throw new Error("INVALID_PAYLOAD");
  const raw = parsed as Record<string, unknown>;
  if (
    typeof raw.kind !== "string" ||
    !ALLOWED_KINDS.has(raw.kind) ||
    typeof raw.title !== "string" ||
    raw.title.length < 1 ||
    raw.title.length > 90 ||
    typeof raw.body !== "string" ||
    raw.body.length < 1 ||
    raw.body.length > 180 ||
    typeof raw.url !== "string" ||
    !raw.url.startsWith("/") ||
    raw.url.startsWith("//") ||
    raw.url.length > 255
  ) {
    throw new Error("INVALID_PAYLOAD");
  }
  return raw as unknown as AppPushPayload;
}

function boundedBatchSize(value: number): number {
  return Math.max(1, Math.min(Math.trunc(value) || DEFAULT_BATCH_SIZE, 100));
}

async function claimDueRows(batchSize: number): Promise<WebPushOutboxRow[]> {
  if (!getDb()) throw new Error("قاعدة البيانات غير متاحة.");
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE webPushOutbox
          SET status = 'RETRY', lockedAt = NULL, availableAt = CURRENT_TIMESTAMP,
              lastError = 'STALE_LOCK'
        WHERE status = 'PROCESSING'
          AND lockedAt < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${STALE_LOCK_SECONDS} SECOND)`,
    );
    const [rows] = await connection.execute<WebPushOutboxRow[]>(
      `SELECT id, userId, payload, attemptCount
         FROM webPushOutbox
        WHERE status IN ('PENDING','RETRY') AND availableAt <= CURRENT_TIMESTAMP
        ORDER BY availableAt, id
        LIMIT ${boundedBatchSize(batchSize)}
        FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows) {
      await connection.execute(
        `UPDATE webPushOutbox
            SET status = 'PROCESSING', lockedAt = CURRENT_TIMESTAMP, lastError = NULL
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

async function markSent(id: number): Promise<void> {
  await getPool().execute(
    `UPDATE webPushOutbox
        SET status = 'SENT', attemptCount = attemptCount + 1,
            completedAt = CURRENT_TIMESTAMP, lockedAt = NULL, lastError = NULL
      WHERE id = ? AND status = 'PROCESSING'`,
    [id],
  );
}

async function markFailed(
  id: number,
  attempt: number,
  code: string,
  terminal: boolean,
): Promise<"retried" | "dead"> {
  if (terminal || attempt >= MAX_ATTEMPTS) {
    await getPool().execute(
      `UPDATE webPushOutbox
          SET status = 'DEAD', attemptCount = attemptCount + 1,
              completedAt = CURRENT_TIMESTAMP, lockedAt = NULL, lastError = ?
        WHERE id = ? AND status = 'PROCESSING'`,
      [code.slice(0, 64), id],
    );
    return "dead";
  }
  await getPool().execute(
    `UPDATE webPushOutbox
        SET status = 'RETRY', attemptCount = attemptCount + 1,
            availableAt = ?, lockedAt = NULL, lastError = ?
      WHERE id = ? AND status = 'PROCESSING'`,
    [new Date(Date.now() + computeWebPushBackoffMs(attempt)), code.slice(0, 64), id],
  );
  return "retried";
}

export async function runWebPushOutboxBatch(
  batchSize = DEFAULT_BATCH_SIZE,
  options: WebPushOutboxRunOptions = {},
): Promise<WebPushOutboxRunResult> {
  if (!isBackgroundOperationActive("web_push_outbox")) {
    const runs = await runAcrossActiveTenants(
      "web_push_outbox",
      () => runWebPushOutboxBatch(batchSize, options),
    );
    return runs.reduce<WebPushOutboxRunResult>(
      (sum, run) => ({
        configured: sum.configured || run.configured,
        claimed: sum.claimed + run.claimed,
        sent: sum.sent + run.sent,
        retried: sum.retried + run.retried,
        dead: sum.dead + run.dead,
      }),
      { configured: false, claimed: 0, sent: 0, retried: 0, dead: 0 },
    );
  }
  const configured = options.configured ?? isPushEnabled;
  if (!configured()) {
    return { configured: false, claimed: 0, sent: 0, retried: 0, dead: 0 };
  }
  const deliver = options.deliver ?? sendPushToUser;
  const rows = await claimDueRows(batchSize);
  const result: WebPushOutboxRunResult = {
    configured: true,
    claimed: rows.length,
    sent: 0,
    retried: 0,
    dead: 0,
  };
  for (const row of rows) {
    const attempt = Number(row.attemptCount) + 1;
    try {
      const delivery = await deliver(Number(row.userId), parsePayload(row.payload));
      if (delivery.failed > 0) {
        const outcome = await markFailed(row.id, attempt, "PARTIAL_DELIVERY", false);
        result[outcome] += 1;
      } else {
        await markSent(row.id);
        result.sent += 1;
      }
    } catch (error) {
      const terminal = error instanceof Error && error.message === "INVALID_PAYLOAD";
      const code = terminal ? "INVALID_PAYLOAD" : "DELIVERY_FAILED";
      const outcome = await markFailed(row.id, attempt, code, terminal);
      result[outcome] += 1;
      logger.warn({ outboxId: row.id, attempt, errorCode: code }, "webPush: تعذر تسليم صف الصندوق");
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startWebPushOutboxWorker(): boolean {
  if (process.env.NODE_ENV === "test" || timer) return false;
  if (!isPushEnabled()) {
    logger.warn("webPush: العامل متوقف حتى تهيئة مفاتيح VAPID");
    return false;
  }
  const raw = Number(process.env.WEB_PUSH_OUTBOX_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Math.max(1_000, Math.min(Number.isFinite(raw) ? raw : DEFAULT_INTERVAL_MS, 60_000));
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runWebPushOutboxBatch();
    } catch (error) {
      logger.error({ err: error }, "webPush: فشل تشغيل عامل الصندوق");
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return true;
}

export function stopWebPushOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
