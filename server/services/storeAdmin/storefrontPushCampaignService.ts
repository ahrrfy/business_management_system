import crypto from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { getDb, getPool } from "../../db";
import { decryptSecret, encryptSecret } from "../cryptoService";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{8,256}\]$/;
const SAFE_PATH_RE = /^\/(?:|search|categories|cart|orders|product\/\d+)$/;
const MAX_DELIVERY_ATTEMPTS = 4;
const STALE_LOCK_SECONDS = 5 * 60;

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
}) {
  const token = validateExpoPushToken(input.expoPushToken);
  const appVersion = text(input.appVersion, "إصدار التطبيق", 64);
  if (input.platform !== "IOS" && input.platform !== "ANDROID") throw new StorefrontPushValidationError("منصة الجهاز غير صالحة.");
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
              revokedAt = NULL, lastSeenAt = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [ciphertext, input.platform, appVersion, input.marketingOptIn, input.transactionalOptIn, existing[0].id],
    );
    return { ok: true as const, deviceId: existing[0].id };
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO storefrontPushDevices
      (tokenHash, tokenCiphertext, platform, appVersion, marketingOptIn, transactionalOptIn)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tokenHash, ciphertext, input.platform, appVersion, input.marketingOptIn, input.transactionalOptIn],
  );
  return { ok: true as const, deviceId: result.insertId };
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
    for (const row of rows) {
      await connection.execute(
        "UPDATE storefrontPushDeliveries SET status = 'PROCESSING', attemptCount = attemptCount + 1, lockedAt = CURRENT_TIMESTAMP, errorCode = NULL WHERE id = ?",
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

async function finishCampaigns(): Promise<void> {
  await requirePool().execute(
    `UPDATE storefrontPushCampaigns c SET status = 'COMPLETED', completedAt = CURRENT_TIMESTAMP
      WHERE c.status = 'RUNNING' AND NOT EXISTS (
        SELECT 1 FROM storefrontPushDeliveries d WHERE d.campaignId = c.id AND d.status IN ('PENDING','PROCESSING','RETRY')
      )`,
  );
}

export async function runStorefrontPushDeliveryBatch(limit = 50) {
  const queuedCampaigns = await queueDueStorefrontPushCampaigns();
  const rows = await claimDeliveries(limit);
  let sent = 0;
  let retried = 0;
  let gone = 0;
  let failed = 0;
  const pool = requirePool();
  for (const row of rows) {
    const attempt = Number(row.attemptCount) + 1;
    let result: Awaited<ReturnType<typeof sendExpoPush>>;
    try {
      const token = decryptSecret(row.tokenCiphertext);
      if (!token) throw new Error("missing token");
      result = await sendExpoPush(token, row);
    } catch {
      result = { status: "FAILED", ticketId: null, errorCode: "DELIVERY_FAILED" };
    }
    if (result.status === "SENT") {
      sent += 1;
      await pool.execute("UPDATE storefrontPushDeliveries SET status = 'SENT', sentAt = CURRENT_TIMESTAMP, lockedAt = NULL, providerTicketId = ? WHERE id = ?", [result.ticketId, row.id]);
      await pool.execute("UPDATE storefrontPushCampaigns SET sentCount = sentCount + 1 WHERE id = ?", [row.campaignId]);
    } else if (result.status === "GONE") {
      gone += 1;
      await pool.execute("UPDATE storefrontPushDeliveries SET status = 'GONE', lockedAt = NULL, errorCode = ? WHERE id = ?", [result.errorCode, row.id]);
      await pool.execute("UPDATE storefrontPushDevices SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND revokedAt IS NULL", [row.deviceId]);
    } else if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      failed += 1;
      await pool.execute("UPDATE storefrontPushDeliveries SET status = 'FAILED', lockedAt = NULL, errorCode = ? WHERE id = ?", [result.errorCode, row.id]);
    } else {
      retried += 1;
      const next = new Date(Date.now() + 15_000 * 2 ** (attempt - 1));
      await pool.execute("UPDATE storefrontPushDeliveries SET status = 'RETRY', availableAt = ?, lockedAt = NULL, errorCode = ? WHERE id = ?", [next, result.errorCode, row.id]);
    }
  }
  await finishCampaigns();
  return { queuedCampaigns, claimed: rows.length, sent, retried, gone, failed };
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

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startStorefrontPushCampaignWorker(): boolean {
  if (process.env.NODE_ENV === "test" || timer) return false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runStorefrontPushDeliveryBatch(); } finally { running = false; }
  };
  // إزاحة طور (فحص الحمل ٣١/٨/٢٦): عاملُ دفع الإشعارات الأصيلة يدقّ كل ٥ث أيضاً وكلاهما يبدأ
  // في اللحظة نفسها من index.ts، فيتصادمان في كل دقّة. نصفُ الدورة (٢.٥ث) يوزّعهما بالتناوب.
  // `timer` يحمل المؤقّت الأوّل ثم الدوريّ — و`clearInterval` في Node يُلغي كليهما، فالإيقاف
  // أثناء نافذة الإزاحة يمنع بدء الدورية أصلاً.
  timer = setTimeout(() => {
    timer = setInterval(() => void tick(), 5_000);
    timer.unref();
    void tick();
  }, 2_500);
  timer.unref();
  return true;
}

export function stopStorefrontPushCampaignWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
