import crypto from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { getDb, getPool } from "../db";
import { decryptSecret, encryptSecret } from "./cryptoService";

export const SUPERAPP_EXPO_PUSH_ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type SuperAppExpoPushEnvironment =
  (typeof SUPERAPP_EXPO_PUSH_ENVIRONMENTS)[number];
export const SUPERAPP_EXPO_PUSH_PLATFORMS = ["ANDROID", "IOS"] as const;
export type SuperAppExpoPushPlatform =
  (typeof SUPERAPP_EXPO_PUSH_PLATFORMS)[number];

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{8,200}\]$/;
const DEVICE_THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
const DESTINATIONS = new Set(["center", "my-day", "account"] as const);

type ExpoDestination = "center" | "my-day" | "account";

export type SuperAppExpoPushPayload = Readonly<{
  version: "1";
  destination: ExpoDestination;
}>;

interface DeviceRow extends RowDataPacket {
  id: number;
  userId: number;
  tokenCiphertext: string;
  revokedAt: Date | null;
}

export class SuperAppExpoPushValidationError extends Error {}
export class SuperAppExpoPushConflictError extends Error {}
export class SuperAppExpoPushConfigurationError extends Error {}

function requirePool() {
  if (!getDb()) {
    throw new SuperAppExpoPushConfigurationError("قاعدة البيانات غير متاحة.");
  }
  return getPool();
}

/** Expo token never becomes a query key or application log value. */
export function validateSuperAppExpoPushToken(value: string): string {
  const normalized = value.trim();
  if (!EXPO_TOKEN_RE.test(normalized)) {
    throw new SuperAppExpoPushValidationError("رمز إشعارات Expo غير صالح.");
  }
  return normalized;
}

export function hashSuperAppExpoPushToken(value: string): string {
  return crypto
    .createHash("sha256")
    .update(validateSuperAppExpoPushToken(value), "utf8")
    .digest("hex");
}

function validateDeviceKeyHash(value: string): string {
  const normalized = value.trim();
  if (!DEVICE_THUMBPRINT_RE.test(normalized)) {
    throw new SuperAppExpoPushValidationError("بصمة مفتاح الجهاز غير صالحة.");
  }
  return normalized;
}

function validateAppVersion(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 64) {
    throw new SuperAppExpoPushValidationError("إصدار التطبيق غير صالح.");
  }
  return normalized;
}

export function superAppExpoPushEnvironment(
  configured = process.env.SUPERAPP_EXPO_PUSH_ENV,
): SuperAppExpoPushEnvironment {
  if (configured === "dev" || configured === "staging" || configured === "prod") {
    return configured;
  }
  if (configured) {
    throw new SuperAppExpoPushConfigurationError("بيئة إشعارات Expo غير صالحة.");
  }
  return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

/**
 * The locked-device payload is intentionally generic. Route selection is a
 * closed dictionary, not a server-supplied URL or a record identifier.
 */
export function buildSuperAppExpoPushPayload(input: {
  kind: string;
}): SuperAppExpoPushPayload {
  const destination: ExpoDestination =
    input.kind === "TASK_ASSIGNED" ||
    input.kind === "PAYROLL_READY" ||
    input.kind === "ATTENDANCE" ||
    input.kind === "LEAVE_STATUS"
      ? "my-day"
      : input.kind === "SESSION_EVENT"
        ? "account"
        : "center";
  return { version: "1", destination };
}

export function parseSuperAppExpoPushPayload(
  value: unknown,
): SuperAppExpoPushPayload {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new SuperAppExpoPushValidationError("حمولة إشعار Expo غير صالحة.");
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SuperAppExpoPushValidationError("حمولة إشعار Expo غير صالحة.");
  }
  const payload = parsed as Record<string, unknown>;
  if (Object.keys(payload).some((key) => key !== "version" && key !== "destination")) {
    throw new SuperAppExpoPushValidationError("حمولة إشعار Expo غير صالحة.");
  }
  if (payload.version !== "1" || typeof payload.destination !== "string" || !DESTINATIONS.has(payload.destination as ExpoDestination)) {
    throw new SuperAppExpoPushValidationError("حمولة إشعار Expo غير صالحة.");
  }
  return { version: "1", destination: payload.destination as ExpoDestination };
}

export async function registerSuperAppExpoPushDevice(input: {
  userId: number;
  expoPushToken: string;
  devicePublicKeyHash: string;
  platform: SuperAppExpoPushPlatform;
  environment: SuperAppExpoPushEnvironment;
  appVersion: string;
}): Promise<{ id: number; tokenHash: string }> {
  const expoPushToken = validateSuperAppExpoPushToken(input.expoPushToken);
  const tokenHash = hashSuperAppExpoPushToken(expoPushToken);
  const devicePublicKeyHash = validateDeviceKeyHash(input.devicePublicKeyHash);
  if (!SUPERAPP_EXPO_PUSH_PLATFORMS.includes(input.platform)) {
    throw new SuperAppExpoPushValidationError("منصة إشعارات Expo غير صالحة.");
  }
  if (!SUPERAPP_EXPO_PUSH_ENVIRONMENTS.includes(input.environment)) {
    throw new SuperAppExpoPushValidationError("بيئة التطبيق غير صالحة.");
  }
  const appVersion = validateAppVersion(input.appVersion);
  const tokenCiphertext = encryptSecret(expoPushToken);
  if (!tokenCiphertext) {
    throw new SuperAppExpoPushConfigurationError("تعذر تشفير رمز إشعارات الجهاز.");
  }

  const connection = await requirePool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<DeviceRow[]>(
      "SELECT id, userId, tokenCiphertext, revokedAt FROM superAppExpoPushDevices WHERE tokenHash = ? FOR UPDATE",
      [tokenHash],
    );
    const existing = rows[0];
    if (existing && existing.userId !== input.userId && existing.revokedAt == null) {
      throw new SuperAppExpoPushConflictError("رمز الإشعارات مرتبط بحساب آخر.");
    }

    let id: number;
    if (existing) {
      id = Number(existing.id);
      await connection.execute(
        `UPDATE superAppExpoPushDevices
            SET userId = ?, tokenCiphertext = ?, devicePublicKeyHash = ?, platform = ?,
                environment = ?, appVersion = ?, revokedAt = NULL, lastSeenAt = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [input.userId, tokenCiphertext, devicePublicKeyHash, input.platform, input.environment, appVersion, id],
      );
    } else {
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO superAppExpoPushDevices
          (userId, tokenHash, tokenCiphertext, devicePublicKeyHash, platform, environment, appVersion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.userId, tokenHash, tokenCiphertext, devicePublicKeyHash, input.platform, input.environment, appVersion],
      );
      id = Number(result.insertId);
    }
    // A protected native key represents one device/session boundary. Replacing
    // its Expo token revokes the prior token before the transaction commits.
    await connection.execute(
      `UPDATE superAppExpoPushDevices
          SET revokedAt = CURRENT_TIMESTAMP
        WHERE userId = ? AND BINARY devicePublicKeyHash = ? AND environment = ?
          AND id <> ? AND revokedAt IS NULL`,
      [input.userId, devicePublicKeyHash, input.environment, id],
    );
    await connection.commit();
    return { id, tokenHash };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function revokeSuperAppExpoPushDevice(
  userId: number,
  devicePublicKeyHash: string,
): Promise<void> {
  await requirePool().execute(
    `UPDATE superAppExpoPushDevices
        SET revokedAt = CURRENT_TIMESTAMP
      WHERE userId = ? AND BINARY devicePublicKeyHash = ? AND revokedAt IS NULL`,
    [userId, validateDeviceKeyHash(devicePublicKeyHash)],
  );
}

export async function revokeAllSuperAppExpoPushDevicesForUser(
  userId: number,
): Promise<number> {
  const [result] = await requirePool().execute<ResultSetHeader>(
    "UPDATE superAppExpoPushDevices SET revokedAt = CURRENT_TIMESTAMP WHERE userId = ? AND revokedAt IS NULL",
    [userId],
  );
  return Number(result.affectedRows ?? 0);
}

export async function countActiveSuperAppExpoPushDevices(userId: number): Promise<number> {
  const [rows] = await requirePool().execute<Array<RowDataPacket & { count: number }>>(
    "SELECT COUNT(*) AS count FROM superAppExpoPushDevices WHERE userId = ? AND revokedAt IS NULL",
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

export function isSuperAppExpoPushConfigured(): boolean {
  return process.env.SUPERAPP_EXPO_PUSH_ENABLED === "true";
}

type ExpoSendResult = "SENT" | "GONE" | "FAILED";

async function sendToken(
  token: string,
  payload: SuperAppExpoPushPayload,
): Promise<ExpoSendResult> {
  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      to: validateSuperAppExpoPushToken(token),
      title: "تحديث آمن",
      body: "افتح سوبر العربية لعرض التفاصيل.",
      sound: "default",
      data: payload,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = await response.json().catch(() => ({})) as {
    data?: Array<{ status?: string; details?: { error?: string } }>;
  };
  const ticket = parsed.data?.[0];
  if (response.ok && ticket?.status === "ok") return "SENT";
  return ticket?.details?.error === "DeviceNotRegistered" ? "GONE" : "FAILED";
}

export async function sendSuperAppExpoPushToUser(
  userId: number,
  rawPayload: unknown,
  environment: SuperAppExpoPushEnvironment,
): Promise<{ sent: number; goneRevoked: number; failed: number }> {
  const payload = parseSuperAppExpoPushPayload(rawPayload);
  const [devices] = await requirePool().execute<DeviceRow[]>(
    `SELECT id, userId, tokenCiphertext, revokedAt
       FROM superAppExpoPushDevices
      WHERE userId = ? AND environment = ? AND revokedAt IS NULL`,
    [userId, environment],
  );
  let sent = 0;
  let goneRevoked = 0;
  let failed = 0;
  for (const device of devices) {
    try {
      const token = decryptSecret(device.tokenCiphertext);
      const outcome = token ? await sendToken(token, payload) : "GONE";
      if (outcome === "SENT") {
        sent += 1;
      } else if (outcome === "GONE") {
        goneRevoked += 1;
        await requirePool().execute(
          "UPDATE superAppExpoPushDevices SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND revokedAt IS NULL",
          [device.id],
        );
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { sent, goneRevoked, failed };
}
