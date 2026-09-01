import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

import {
  storefrontPushCampaigns,
  storefrontPushDeliveries,
  storefrontPushDevices,
} from "../../../drizzle/schema";
import { getDb, getPool } from "../../db";
import type { Tx } from "../../db";
import { logger } from "../../logger";
import { decryptSecret, encryptSecret } from "../cryptoService";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{8,256}\]$/;
const SAFE_PATH_RE = /^\/(?:|search|categories|cart|orders|product\/\d+)$/;
const MAX_DELIVERY_ATTEMPTS = 4;
const STALE_LOCK_SECONDS = 5 * 60;
export const STOREFRONT_PUSH_WORKER_LIMITS = {
  maxConcurrency: 4,
  batchSize: 50,
  intervalMs: 5_000,
} as const;

export const STOREFRONT_PUSH_CAMPAIGN_STATUSES = ["DRAFT", "APPROVED", "SCHEDULED", "RUNNING", "COMPLETED", "CANCELLED"] as const;
export type StorefrontPushCampaignStatus = (typeof STOREFRONT_PUSH_CAMPAIGN_STATUSES)[number];
export type StorefrontPushKind = "MARKETING" | "TRANSACTIONAL";

export class StorefrontPushValidationError extends Error {}
export class StorefrontPushConflictError extends Error {}

interface CampaignRow extends RowDataPacket {
  id: number;
  name: string;
  kind: StorefrontPushKind;
  status: StorefrontPushCampaignStatus;
  title: string;
  body: string;
  destination: string;
  throttlePerMinute: number;
  scheduledAt: Date | null;
  recipientCount: number;
  sentCount: number;
  openedCount: number;
  clickedCount: number;
  createdAt: Date;
}

interface DeliveryRow extends RowDataPacket {
  id: number;
  campaignId: number;
  deviceId: number;
  attemptCount: number;
  tokenCiphertext: string;
  title: string;
  body: string;
  destination: string;
}

function requirePool() {
  if (!getDb()) throw new Error("قاعدة بيانات المتجر غير متاحة.");
  return getPool();
}

export function validateExpoPushToken(value: string): string {
  const normalized = value.trim();
  if (!EXPO_TOKEN_RE.test(normalized)) throw new StorefrontPushValidationError("رمز إشعارات الجهاز غير صالح.");
  return normalized;
}

export function validateStorefrontPushDestination(value: string): string {
  const normalized = value.trim();
  if (!SAFE_PATH_RE.test(normalized)) throw new StorefrontPushValidationError("وجهة الحملة يجب أن تكون صفحة داخلية آمنة من التطبيق.");
  return normalized;
}

function text(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new StorefrontPushValidationError(`${label} غير صالح.`);
  return normalized;
}

export async function registerStorefrontPushDevice(input: {
  expoPushToken: string;
  marketingOptIn: boolean;
  transactionalOptIn: boolean;
  platform: "IOS" | "ANDROID";
  appVersion: string;
  /** هوية موثوقة حُلّت من جلسة العميل خادمياً؛ لا تُقبل مباشرةً من التطبيق. */
  customerId?: number;
}) {
  const token = validateExpoPushToken(input.expoPushToken);
  const appVersion = text(input.appVersion, "إصدار التطبيق", 64);
  if (input.platform !== "IOS" && input.platform !== "ANDROID") throw new StorefrontPushValidationError("منصة الجهاز غير صالحة.");
  const customerId = input.customerId;
  if (customerId != null && (!Number.isInteger(customerId) || customerId <= 0)) {
    throw new StorefrontPushValidationError("هوية العميل غير صالحة.");
  }
  const ciphertext = encryptSecret(token);
  if (!ciphertext) throw new Error("تعذر تأمين رمز إشعارات الجهاز.");
  const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const pool = requirePool();
  const [existing] = await pool.execute<Array<RowDataPacket & { id: number }>>(
    "SELECT id FROM storefrontPushDevices WHERE tokenHash = ? LIMIT 1",
    [tokenHash],
  );
  if (existing[0]) {
    await pool.execute(
      `UPDATE storefrontPushDevices
          SET tokenCiphertext = ?, platform = ?, appVersion = ?, marketingOptIn = ?, transactionalOptIn = ?,
              customerId = COALESCE(?, customerId),
              revokedAt = NULL, lastSeenAt = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [ciphertext, input.platform, appVersion, input.marketingOptIn, input.transactionalOptIn, customerId ?? null, existing[0].id],
    );
    return { ok: true as const, deviceId: existing[0].id };
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO storefrontPushDevices
      (customerId, tokenHash, tokenCiphertext, platform, appVersion, marketingOptIn, transactionalOptIn)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [customerId ?? null, tokenHash, ciphertext, input.platform, appVersion, input.marketingOptIn, input.transactionalOptIn],
  );
  return { ok: true as const, deviceId: result.insertId };
}

export type StorefrontOrderPushStatus = "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED";

const ORDER_STATUS_PUSH_COPY: Record<StorefrontOrderPushStatus, { title: string; body: (orderNumber: string) => string }> = {
  CONFIRMED: { title: "تم تأكيد طلبك", body: (number) => `تم تأكيد الطلب ${number} وسنبدأ تجهيزه قريباً.` },
  PROCESSING: { title: "طلبك قيد التجهيز", body: (number) => `بدأ فريق مكتبة العربية تجهيز الطلب ${number}.` },
  SHIPPED: { title: "طلبك في الطريق", body: (number) => `تم إرسال الطلب ${number} مع جهة التوصيل.` },
  DELIVERED: { title: "تم تسليم طلبك", body: (number) => `اكتمل تسليم الطلب ${number}. شكراً لاختيارك مكتبة العربية.` },
  CANCELLED: { title: "تحديث على طلبك", body: (number) => `أُلغي الطلب ${number}. افتح التطبيق للاطلاع على التفاصيل.` },
};

/**
 * يكتب حدث حالة الطلب وصندوق أجهزة مالكه في معاملة المجال نفسها.
 * eventKey الفريد يجعل إعادة المحاولة آمنة، ولا تُضمّن الرسالة مبلغاً أو هاتفاً أو سبب إلغاء.
 */
export async function enqueueStorefrontOrderStatusPush(
  tx: Tx,
  input: { orderId: number; orderNumber: string; customerId: number | null; status: StorefrontOrderPushStatus },
): Promise<{ campaignId: number; recipientCount: number }> {
  const copy = ORDER_STATUS_PUSH_COPY[input.status];
  const eventKey = `storefront-order:${input.orderId}:status:${input.status}`;
  const title = text(copy.title, "عنوان إشعار الطلب", 80);
  const body = text(copy.body(input.orderNumber), "نص إشعار الطلب", 180);

  await tx
    .insert(storefrontPushCampaigns)
    .values({
      eventKey,
      name: `حالة الطلب ${input.orderNumber}: ${input.status}`,
      kind: "TRANSACTIONAL",
      status: "RUNNING",
      title,
      body,
      destination: "/orders",
      throttlePerMinute: 240,
      launchedAt: new Date(),
    })
    .onDuplicateKeyUpdate({ set: { eventKey } });

  const campaign = (await tx
    .select({ id: storefrontPushCampaigns.id })
    .from(storefrontPushCampaigns)
    .where(eq(storefrontPushCampaigns.eventKey, eventKey))
    .limit(1))[0];
  if (!campaign) throw new Error("تعذر إنشاء حدث إشعار حالة الطلب.");

  if (input.customerId != null) {
    await tx.execute(sql`
      INSERT IGNORE INTO storefrontPushDeliveries (campaignId, deviceId)
      SELECT ${campaign.id}, ${storefrontPushDevices.id}
      FROM ${storefrontPushDevices}
      WHERE ${storefrontPushDevices.customerId} = ${input.customerId}
        AND ${storefrontPushDevices.transactionalOptIn} = TRUE
        AND ${storefrontPushDevices.revokedAt} IS NULL
    `);
  }
  const recipient = (await tx
    .select({ count: sql<number>`COUNT(*)` })
    .from(storefrontPushDeliveries)
    .where(eq(storefrontPushDeliveries.campaignId, campaign.id)))[0];
  const recipientCount = Number(recipient?.count ?? 0);
  await tx
    .update(storefrontPushCampaigns)
    .set({ recipientCount })
    .where(eq(storefrontPushCampaigns.id, campaign.id));
  return { campaignId: Number(campaign.id), recipientCount };
}

export async function listStorefrontPushCampaigns(limit = 50) {
  const [rows] = await requirePool().execute<CampaignRow[]>(
    `SELECT id, name, kind, status, title, body, destination, throttlePerMinute, scheduledAt,
            recipientCount, sentCount, openedCount, clickedCount, createdAt
       FROM storefrontPushCampaigns ORDER BY createdAt DESC, id DESC LIMIT ?`,
    [Math.max(1, Math.min(limit, 100))],
  );
  return rows;
}

export async function createStorefrontPushCampaign(input: {
  name: string;
  kind: StorefrontPushKind;
  title: string;
  body: string;
  destination: string;
  throttlePerMinute: number;
}, createdBy: number) {
  const name = text(input.name, "اسم الحملة", 160);
  const title = text(input.title, "عنوان الحملة", 80);
  const body = text(input.body, "نص الحملة", 180);
  const destination = validateStorefrontPushDestination(input.destination);
  if (input.kind !== "MARKETING" && input.kind !== "TRANSACTIONAL") throw new StorefrontPushValidationError("نوع الحملة غير صالح.");
  const throttlePerMinute = Math.max(10, Math.min(Math.trunc(input.throttlePerMinute) || 120, 240));
  const [result] = await requirePool().execute<ResultSetHeader>(
    `INSERT INTO storefrontPushCampaigns (name, kind, title, body, destination, throttlePerMinute, createdBy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, input.kind, title, body, destination, throttlePerMinute, createdBy],
  );
  return { campaignId: result.insertId };
}

export async function approveStorefrontPushCampaign(campaignId: number, approvedBy: number) {
  const [result] = await requirePool().execute<ResultSetHeader>(
    "UPDATE storefrontPushCampaigns SET status = 'APPROVED', approvedBy = ? WHERE id = ? AND status = 'DRAFT'",
    [approvedBy, campaignId],
  );
  if (!result.affectedRows) throw new StorefrontPushConflictError("لا يمكن اعتماد الحملة في حالتها الحالية.");
  return { ok: true as const };
}

export async function scheduleStorefrontPushCampaign(campaignId: number, scheduledAt: Date) {
  if (Number.isNaN(scheduledAt.getTime())) throw new StorefrontPushValidationError("موعد الحملة غير صالح.");
  const [result] = await requirePool().execute<ResultSetHeader>(
    "UPDATE storefrontPushCampaigns SET status = 'SCHEDULED', scheduledAt = ? WHERE id = ? AND status = 'APPROVED'",
    [scheduledAt, campaignId],
  );
  if (!result.affectedRows) throw new StorefrontPushConflictError("لا يمكن جدولة الحملة قبل اعتمادها.");
  return { ok: true as const };
}

export async function cancelStorefrontPushCampaign(campaignId: number) {
  const [result] = await requirePool().execute<ResultSetHeader>(
    "UPDATE storefrontPushCampaigns SET status = 'CANCELLED' WHERE id = ? AND status IN ('DRAFT','APPROVED','SCHEDULED')",
    [campaignId],
  );
  if (!result.affectedRows) throw new StorefrontPushConflictError("لا يمكن إلغاء حملة بدأت بالإرسال أو اكتملت.");
  return { ok: true as const };
}

/** ينقل الحملات المعتمدة المستحقة إلى صندوق التسليم بشكل ذري، مع تصفية الموافقة الخادمية فقط. */
export async function queueDueStorefrontPushCampaigns(limit = 8): Promise<number> {
  const connection = await requirePool().getConnection();
  try {
    await connection.beginTransaction();
    const [campaigns] = await connection.execute<CampaignRow[]>(
      `SELECT id, kind FROM storefrontPushCampaigns
        WHERE status = 'SCHEDULED' AND scheduledAt <= CURRENT_TIMESTAMP
        ORDER BY scheduledAt, id LIMIT ${Math.max(1, Math.min(limit, 20))} FOR UPDATE SKIP LOCKED`,
    );
    for (const campaign of campaigns) {
      await connection.execute(
        "UPDATE storefrontPushCampaigns SET status = 'RUNNING', launchedAt = CURRENT_TIMESTAMP WHERE id = ?",
        [campaign.id],
      );
      const optInField = campaign.kind === "MARKETING" ? "marketingOptIn" : "transactionalOptIn";
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT IGNORE INTO storefrontPushDeliveries (campaignId, deviceId)
         SELECT ?, d.id FROM storefrontPushDevices d
          WHERE d.revokedAt IS NULL AND d.${optInField} = 1`,
        [campaign.id],
      );
      await connection.execute(
        "UPDATE storefrontPushCampaigns SET recipientCount = ? WHERE id = ?",
        [insert.affectedRows, campaign.id],
      );
    }
    await connection.commit();
    return campaigns.length;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function claimDeliveries(limit: number): Promise<DeliveryRow[]> {
  const connection = await requirePool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE storefrontPushDeliveries SET status = 'RETRY', lockedAt = NULL, availableAt = CURRENT_TIMESTAMP, errorCode = 'STALE_LOCK'
        WHERE status = 'PROCESSING' AND lockedAt < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${STALE_LOCK_SECONDS} SECOND)`,
    );
    const [rows] = await connection.execute<DeliveryRow[]>(
      `SELECT d.id, d.campaignId, d.deviceId, d.attemptCount, p.tokenCiphertext, c.title, c.body, c.destination
         FROM storefrontPushDeliveries d
         JOIN storefrontPushDevices p ON p.id = d.deviceId AND p.revokedAt IS NULL
         JOIN storefrontPushCampaigns c ON c.id = d.campaignId AND c.status = 'RUNNING'
        WHERE d.status IN ('PENDING','RETRY') AND d.availableAt <= CURRENT_TIMESTAMP
        ORDER BY d.availableAt, d.id LIMIT ${Math.max(1, Math.min(limit, 100))} FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length) {
      const placeholders = rows.map(() => "?").join(",");
      await connection.execute(
        `UPDATE storefrontPushDeliveries
            SET status = 'PROCESSING', lockedAt = CURRENT_TIMESTAMP, errorCode = NULL
          WHERE id IN (${placeholders}) AND status IN ('PENDING','RETRY')`,
        rows.map((row) => row.id),
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

async function sendExpoPush(token: string, row: DeliveryRow): Promise<{ status: "SENT" | "GONE" | "FAILED"; ticketId: string | null; errorCode: string | null }> {
  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ to: validateExpoPushToken(token), title: row.title, body: row.body, sound: "default", channelId: "store_updates", data: { path: row.destination, campaignId: row.campaignId, deliveryId: row.id } }),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = await response.json().catch(() => ({})) as { data?: Array<{ status?: string; id?: string; details?: { error?: string } }> };
  const ticket = parsed.data?.[0];
  if (response.ok && ticket?.status === "ok") return { status: "SENT", ticketId: ticket.id ?? null, errorCode: null };
  const errorCode = ticket?.details?.error ?? `EXPO_HTTP_${response.status}`;
  return { status: errorCode === "DeviceNotRegistered" ? "GONE" : "FAILED", ticketId: null, errorCode: errorCode.slice(0, 64) };
}

/** allSettled على موجات محدودة؛ الفشل في عنصر لا يوقف بقية الموجة ولا يفتح التزامن بلا سقف. */
export async function runStorefrontPushSettled<T, TResult>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<TResult>,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const boundedConcurrency = Math.max(1, Math.min(Math.trunc(concurrency) || 1, STOREFRONT_PUSH_WORKER_LIMITS.maxConcurrency));
  const results: Array<PromiseSettledResult<TResult>> = [];
  for (let offset = 0; offset < items.length; offset += boundedConcurrency) {
    const wave = items.slice(offset, offset + boundedConcurrency);
    results.push(...await Promise.allSettled(wave.map((item) => worker(item))));
  }
  return results;
}

async function finishCampaigns(): Promise<void> {
  await requirePool().execute(
    `UPDATE storefrontPushCampaigns c SET status = 'COMPLETED', completedAt = CURRENT_TIMESTAMP
      WHERE c.status = 'RUNNING' AND NOT EXISTS (
        SELECT 1 FROM storefrontPushDeliveries d WHERE d.campaignId = c.id AND d.status IN ('PENDING','PROCESSING','RETRY')
      )`,
  );
}

type StorefrontPushDeliveryOutcome = "sent" | "retried" | "gone" | "failed" | "ignored";

async function finishClaimedDelivery(row: DeliveryRow): Promise<StorefrontPushDeliveryOutcome> {
  const pool = requirePool();
  let attempted = false;
  let result: Awaited<ReturnType<typeof sendExpoPush>>;
  try {
    const token = decryptSecret(row.tokenCiphertext);
    if (!token) {
      result = { status: "GONE", ticketId: null, errorCode: "TOKEN_UNAVAILABLE" };
    } else {
      // التحقق قبل ضبط attempted: token تالف/غير قابل للإرسال لا يستهلك محاولة مزوّد.
      validateExpoPushToken(token);
      attempted = true;
      result = await sendExpoPush(token, row);
    }
  } catch {
    result = attempted
      ? { status: "FAILED", ticketId: null, errorCode: "DELIVERY_FAILED" }
      : { status: "GONE", ticketId: null, errorCode: "TOKEN_UNAVAILABLE" };
  }

  const incrementAttempt = attempted ? "attemptCount = attemptCount + 1," : "";
  const attempt = Number(row.attemptCount) + (attempted ? 1 : 0);
  if (result.status === "SENT") {
    const [transition] = await pool.execute<ResultSetHeader>(
      `UPDATE storefrontPushDeliveries
          SET status = 'SENT', ${incrementAttempt} sentAt = CURRENT_TIMESTAMP,
              lockedAt = NULL, providerTicketId = ?, errorCode = NULL
        WHERE id = ? AND status = 'PROCESSING'`,
      [result.ticketId, row.id],
    );
    if (!transition.affectedRows) return "ignored";
    await pool.execute("UPDATE storefrontPushCampaigns SET sentCount = sentCount + 1 WHERE id = ?", [row.campaignId]);
    return "sent";
  }
  if (result.status === "GONE") {
    const [transition] = await pool.execute<ResultSetHeader>(
      `UPDATE storefrontPushDeliveries
          SET status = 'GONE', ${incrementAttempt} lockedAt = NULL, errorCode = ?
        WHERE id = ? AND status = 'PROCESSING'`,
      [result.errorCode, row.id],
    );
    if (!transition.affectedRows) return "ignored";
    await pool.execute("UPDATE storefrontPushDevices SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND revokedAt IS NULL", [row.deviceId]);
    return "gone";
  }
  if (attempt >= MAX_DELIVERY_ATTEMPTS) {
    const [transition] = await pool.execute<ResultSetHeader>(
      `UPDATE storefrontPushDeliveries
          SET status = 'FAILED', ${incrementAttempt} lockedAt = NULL, errorCode = ?
        WHERE id = ? AND status = 'PROCESSING'`,
      [result.errorCode, row.id],
    );
    return transition.affectedRows ? "failed" : "ignored";
  }
  const next = new Date(Date.now() + 15_000 * 2 ** Math.max(0, attempt - 1));
  const [transition] = await pool.execute<ResultSetHeader>(
    `UPDATE storefrontPushDeliveries
        SET status = 'RETRY', ${incrementAttempt} availableAt = ?, lockedAt = NULL, errorCode = ?
      WHERE id = ? AND status = 'PROCESSING'`,
    [next, result.errorCode, row.id],
  );
  return transition.affectedRows ? "retried" : "ignored";
}

export async function runStorefrontPushDeliveryBatch(
  limit = STOREFRONT_PUSH_WORKER_LIMITS.batchSize,
  options: { shouldStop?: () => boolean } = {},
) {
  const queuedCampaigns = await queueDueStorefrontPushCampaigns();
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || STOREFRONT_PUSH_WORKER_LIMITS.batchSize, 100));
  const summary = { queuedCampaigns, claimed: 0, sent: 0, retried: 0, gone: 0, failed: 0, errored: 0 };
  while (summary.claimed < boundedLimit && !options.shouldStop?.()) {
    // لا نطالب إلا موجة ستبدأ الآن؛ stop بين الموجات لا يترك عشرات الصفوف PROCESSING بلا إرسال.
    const wave = await claimDeliveries(Math.min(
      STOREFRONT_PUSH_WORKER_LIMITS.maxConcurrency,
      boundedLimit - summary.claimed,
    ));
    if (!wave.length) break;
    summary.claimed += wave.length;
    const settled = await runStorefrontPushSettled(
      wave,
      STOREFRONT_PUSH_WORKER_LIMITS.maxConcurrency,
      finishClaimedDelivery,
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        summary.errored += 1;
        logger.error({ err: outcome.reason }, "storefront push: delivery finalization failed");
      } else if (outcome.value !== "ignored") {
        summary[outcome.value] += 1;
      }
    }
  }
  await finishCampaigns();
  return summary;
}

export async function trackStorefrontPushInteraction(input: { deliveryId: number; event: "OPEN" | "CLICK" }) {
  const field = input.event === "CLICK" ? "clickedAt" : "openedAt";
  const [result] = await requirePool().execute<ResultSetHeader>(
    `UPDATE storefrontPushDeliveries SET ${field} = COALESCE(${field}, CURRENT_TIMESTAMP)
      WHERE id = ? AND status = 'SENT'`,
    [input.deliveryId],
  );
  if (result.affectedRows) {
    const countField = input.event === "CLICK" ? "clickedCount" : "openedCount";
    await requirePool().execute(
      `UPDATE storefrontPushCampaigns c JOIN storefrontPushDeliveries d ON d.campaignId = c.id
        SET c.${countField} = c.${countField} + 1 WHERE d.id = ?`,
      [input.deliveryId],
    );
  }
  return { ok: true as const };
}

export interface StorefrontPushWorkerRuntime {
  start(): boolean;
  runNow(): Promise<void>;
  stop(): Promise<void>;
}

export function createStorefrontPushWorkerRuntime(options: {
  intervalMs: number;
  initialDelayMs?: number;
  runBatch: (shouldStop: () => boolean) => Promise<unknown>;
  onError: (error: unknown) => void;
}): StorefrontPushWorkerRuntime {
  const intervalMs = Math.max(1_000, Math.min(Math.trunc(options.intervalMs) || STOREFRONT_PUSH_WORKER_LIMITS.intervalMs, 60_000));
  const initialDelayMs = Math.max(0, Math.min(Math.trunc(options.initialDelayMs ?? 0), intervalMs));
  let timer: NodeJS.Timeout | null = null;
  let activeTick: Promise<void> | null = null;
  let stopping = true;

  const runNow = async (): Promise<void> => {
    if (activeTick) return activeTick;
    if (stopping) return;
    const task = (async () => {
      try {
        await options.runBatch(() => stopping);
      } catch (error) {
        options.onError(error);
      }
    })();
    activeTick = task;
    try {
      await task;
    } finally {
      if (activeTick === task) activeTick = null;
    }
  };

  return {
    start() {
      if (timer || activeTick) return false;
      stopping = false;
      const begin = () => {
        if (stopping) return;
        timer = setInterval(() => void runNow(), intervalMs);
        timer.unref();
        void runNow();
      };
      timer = initialDelayMs > 0 ? setTimeout(begin, initialDelayMs) : setInterval(() => void runNow(), intervalMs);
      timer.unref();
      if (initialDelayMs === 0) void runNow();
      return true;
    },
    runNow,
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (activeTick) await activeTick;
    },
  };
}

let workerRuntime: StorefrontPushWorkerRuntime | null = null;

export function startStorefrontPushCampaignWorker(): boolean {
  if (process.env.NODE_ENV === "test" || workerRuntime) return false;
  const runtime = createStorefrontPushWorkerRuntime({
    intervalMs: STOREFRONT_PUSH_WORKER_LIMITS.intervalMs,
    // إزاحة نصف دورة عن عامل native push الذي يدق كل 5ث أيضاً، مع إبقاء stop الرشيق مسؤولاً
    // عن إلغاء مؤقت البدء أو انتظار الدورة الجارية من runtime نفسه.
    initialDelayMs: STOREFRONT_PUSH_WORKER_LIMITS.intervalMs / 2,
    runBatch: (shouldStop) => runStorefrontPushDeliveryBatch(STOREFRONT_PUSH_WORKER_LIMITS.batchSize, { shouldStop }),
    onError: (error) => logger.error({ err: error }, "storefront push: worker tick failed"),
  });
  if (!runtime.start()) return false;
  workerRuntime = runtime;
  return true;
}

export async function stopStorefrontPushCampaignWorker(): Promise<void> {
  const runtime = workerRuntime;
  if (!runtime) return;
  await runtime.stop();
  if (workerRuntime === runtime) workerRuntime = null;
}
