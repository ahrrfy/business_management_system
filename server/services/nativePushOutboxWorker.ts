import type { RowDataPacket } from "mysql2";
import { getDb, getPool } from "../db";
import { logger } from "../logger";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../tenancy/backgroundTenants";
import {
  isNativePushConfigured,
  NativePushValidationError,
  normalizeNativePushPayload,
  sendNativePushToUser,
  type NativePushEnvironment,
  type NativePushFamily,
  type NativePushPayloadInput,
} from "./nativePushService";

const MAX_ATTEMPTS = 8;
const STALE_LOCK_SECONDS = 5 * 60;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_INTERVAL_MS = 5_000;

interface NativePushOutboxRow extends RowDataPacket {
  id: number;
  userId: number;
  payload: unknown;
  environment: NativePushEnvironment;
  attemptCount: number;
}

export interface NativePushDeliverySummary {
  sent: number;
  goneRevoked: number;
  failed: number;
}

type DeliverNativePush = (
  userId: number,
  payload: NativePushPayloadInput,
  environment: NativePushEnvironment,
) => Promise<NativePushDeliverySummary>;

export interface NativePushOutboxRunOptions {
  configured?: () => boolean;
  deliver?: DeliverNativePush;
}

export interface NativePushOutboxRunResult {
  configured: boolean;
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

/** تراجع أسّي محدود: 15ث، 30ث، 1د … حتى 6 ساعات. */
export function computeNativePushBackoffMs(attempt: number): number {
  const normalizedAttempt = Math.max(
    1,
    Math.min(Math.trunc(attempt), MAX_ATTEMPTS),
  );
  return Math.min(6 * 60 * 60 * 1_000, 15_000 * 2 ** (normalizedAttempt - 1));
}

function boundedBatchSize(value: number): number {
  return Math.max(1, Math.min(Math.trunc(value) || DEFAULT_BATCH_SIZE, 100));
}

function parsePayload(value: unknown): NativePushPayloadInput {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new NativePushValidationError("حمولة صندوق الإشعار غير صالحة.");
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new NativePushValidationError("حمولة صندوق الإشعار غير صالحة.");
  }
  const raw = parsed as Record<string, unknown>;
  const normalized = normalizeNativePushPayload({
    notificationId:
      typeof raw.notificationId === "string" ? raw.notificationId : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    destination: typeof raw.destination === "string" ? raw.destination : "",
    urgency:
      raw.urgency === "action"
        ? "action"
        : raw.urgency === "information"
          ? "information"
          : ("" as never),
    sensitive: raw.sensitive === true || raw.sensitive === "true",
    family: typeof raw.family === "string" ? raw.family as NativePushFamily : undefined,
  });
  return {
    notificationId: normalized.notificationId,
    kind: normalized.kind,
    title: normalized.title,
    body: normalized.body,
    destination: normalized.destination,
    urgency: normalized.urgency,
    sensitive: normalized.sensitive === "true",
    family: normalized.family,
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof NativePushValidationError) return "INVALID_PAYLOAD";
  const name = error instanceof Error ? error.name : "DELIVERY_FAILED";
  const safe = name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 48);
  return safe || "DELIVERY_FAILED";
}

async function claimDueRows(batchSize: number): Promise<NativePushOutboxRow[]> {
  if (!getDb()) throw new Error("قاعدة البيانات غير متاحة.");
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE nativePushOutbox
          SET status = 'RETRY', lockedAt = NULL, availableAt = CURRENT_TIMESTAMP,
              lastError = 'STALE_LOCK'
        WHERE status = 'PROCESSING'
          AND lockedAt < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${STALE_LOCK_SECONDS} SECOND)`,
    );
    const [rows] = await connection.execute<NativePushOutboxRow[]>(
      `SELECT id, userId, payload, environment, attemptCount
         FROM nativePushOutbox
        WHERE status IN ('PENDING', 'RETRY') AND availableAt <= CURRENT_TIMESTAMP
        ORDER BY availableAt, id
        LIMIT ${boundedBatchSize(batchSize)}
        FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows) {
      await connection.execute(
        `UPDATE nativePushOutbox
            SET status = 'PROCESSING', attemptCount = attemptCount + 1,
                lockedAt = CURRENT_TIMESTAMP, lastError = NULL
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
    `UPDATE nativePushOutbox
        SET status = 'SENT', completedAt = CURRENT_TIMESTAMP, lockedAt = NULL,
            lastError = NULL
      WHERE id = ? AND status = 'PROCESSING'`,
    [id],
  );
}

async function markFailed(
  id: number,
  attempt: number,
  errorCode: string,
  terminal: boolean,
): Promise<"retried" | "dead"> {
  if (terminal || attempt >= MAX_ATTEMPTS) {
    await getPool().execute(
      `UPDATE nativePushOutbox
          SET status = 'DEAD', completedAt = CURRENT_TIMESTAMP, lockedAt = NULL,
              lastError = ?
        WHERE id = ? AND status = 'PROCESSING'`,
      [errorCode.slice(0, 64), id],
    );
    return "dead";
  }
  const availableAt = new Date(
    Date.now() + computeNativePushBackoffMs(attempt),
  );
  await getPool().execute(
    `UPDATE nativePushOutbox
        SET status = 'RETRY', availableAt = ?, lockedAt = NULL, lastError = ?
      WHERE id = ? AND status = 'PROCESSING'`,
    [availableAt, errorCode.slice(0, 64), id],
  );
  return "retried";
}

/**
 * يشغّل دفعة واحدة. عند غياب FCM لا يطالب بأي صف ولا يحوّله إلى نجاح كاذب؛ يبقى PENDING
 * حتى تُثبّت بيانات الاعتماد ويُعاد تشغيل الخدمة.
 */
export async function runNativePushOutboxBatch(
  batchSize = DEFAULT_BATCH_SIZE,
  options: NativePushOutboxRunOptions = {},
): Promise<NativePushOutboxRunResult> {
  if (!isBackgroundOperationActive("native_push_outbox")) {
    const runs = await runAcrossActiveTenants(
      "native_push_outbox",
      () => runNativePushOutboxBatch(batchSize, options),
    );
    return runs.reduce<NativePushOutboxRunResult>(
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
  const configured = options.configured ?? isNativePushConfigured;
  if (!configured())
    return { configured: false, claimed: 0, sent: 0, retried: 0, dead: 0 };

  const deliver = options.deliver ?? sendNativePushToUser;
  const rows = await claimDueRows(batchSize);
  const result: NativePushOutboxRunResult = {
    configured: true,
    claimed: rows.length,
    sent: 0,
    retried: 0,
    dead: 0,
  };
  for (const row of rows) {
    const attempt = Number(row.attemptCount) + 1;
    try {
      const payload = parsePayload(row.payload);
      const delivery = await deliver(row.userId, payload, row.environment);
      if (delivery.failed > 0) {
        const outcome = await markFailed(
          row.id,
          attempt,
          "PARTIAL_DELIVERY",
          false,
        );
        result[outcome] += 1;
      } else {
        await markSent(row.id);
        result.sent += 1;
      }
    } catch (error) {
      const outcome = await markFailed(
        row.id,
        attempt,
        safeErrorCode(error),
        error instanceof NativePushValidationError,
      );
      result[outcome] += 1;
      logger.warn(
        { outboxId: row.id, attempt, errorCode: safeErrorCode(error) },
        "nativePush: تعذر تسليم صف الصندوق",
      );
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startNativePushOutboxWorker(): boolean {
  if (process.env.NODE_ENV === "test" || timer) return false;
  if (!isNativePushConfigured()) {
    logger.warn("nativePush: العامل متوقف حتى تهيئة FCM_SERVICE_ACCOUNT_JSON");
    return false;
  }
  const rawInterval = Number(
    process.env.NATIVE_PUSH_OUTBOX_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  const intervalMs = Math.max(
    1_000,
    Math.min(
      Number.isFinite(rawInterval) ? rawInterval : DEFAULT_INTERVAL_MS,
      60_000,
    ),
  );
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runNativePushOutboxBatch();
    } catch (error) {
      logger.error({ err: error }, "nativePush: فشل تشغيل عامل الصندوق");
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return true;
}

export function stopNativePushOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
