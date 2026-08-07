import crypto from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { getDb, getPool } from "../db";
import { decryptSecret, encryptSecret } from "./cryptoService";

export const NATIVE_PUSH_ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type NativePushEnvironment = (typeof NATIVE_PUSH_ENVIRONMENTS)[number];
export type NativePushUrgency = "information" | "action";

export interface NativePushPayloadInput {
  notificationId: string;
  kind: string;
  title: string;
  body: string;
  destination: string;
  urgency: NativePushUrgency;
  sensitive: boolean;
}

export interface NormalizedNativePushPayload {
  version: "1";
  notificationId: string;
  kind: string;
  title: string;
  body: string;
  destination: string;
  urgency: NativePushUrgency;
  sensitive: "true" | "false";
}

export class NativePushValidationError extends Error {}
export class NativePushConflictError extends Error {}
export class NativePushConfigurationError extends Error {}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_AUDIENCE = "https://oauth2.googleapis.com/token";
const FID_RE = /^[A-Za-z0-9_-]{20,128}$/;
const DEVICE_THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const KIND_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const MODULES = new Set([
  "crm",
  "campaigns",
  "collections",
  "pos",
  "sales",
  "purchases",
  "inventory",
  "workorders",
  "channels",
  "tasks",
  "store",
  "treasury",
  "suppliers",
  "products",
  "expenses",
  "reports",
  "assets",
  "hr",
  "commissions",
  "consignments",
  "reservations",
  "digital_cards",
  "gifts",
  "catalogAnomalies",
  "courier",
  "users",
  "settings",
]);
const INTENTS = new Set([
  "browse",
  "view",
  "report",
  "create",
  "edit",
  "operate",
  "approve",
]);
const ROOT_DESTINATIONS = new Set([
  "home",
  "modules",
  "tasks",
  "alerts",
  "approvals",
  "profile",
]);

interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

interface DeviceRow extends RowDataPacket {
  id: number;
  userId: number;
  tokenCiphertext: string;
  tokenHash: string;
  revokedAt: Date | null;
}

interface DeliveredTokenRow extends RowDataPacket {
  tokenHash: string;
}

interface AccessTokenCache {
  key: string;
  accessToken: string;
  expiresAtMs: number;
}

let accessTokenCache: AccessTokenCache | null = null;

function requirePool() {
  if (!getDb())
    throw new NativePushConfigurationError("قاعدة البيانات غير متاحة.");
  return getPool();
}

export function validateFcmInstallationId(installationId: string): string {
  const normalized = installationId.trim();
  if (!FID_RE.test(normalized)) {
    throw new NativePushValidationError("معرّف تثبيت الإشعارات غير صالح.");
  }
  return normalized;
}

export function validateDevicePublicKeyHash(value: string): string {
  const normalized = value.trim();
  if (!DEVICE_THUMBPRINT_RE.test(normalized)) {
    throw new NativePushValidationError("بصمة مفتاح الجهاز غير صالحة.");
  }
  return normalized;
}

export function hashFcmInstallationId(installationId: string): string {
  return crypto
    .createHash("sha256")
    .update(validateFcmInstallationId(installationId), "utf8")
    .digest("hex");
}

export function validateNativeDestination(raw: string): string {
  if (raw.length > 256 || raw.includes("%")) {
    throw new NativePushValidationError("وجهة الإشعار غير صالحة.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NativePushValidationError("وجهة الإشعار غير صالحة.");
  }
  if (
    url.protocol !== "alrueya:" ||
    url.hostname !== "app" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new NativePushValidationError("يُسمح بوجهات التطبيق الداخلية فقط.");
  }
  const segments = url.pathname.slice(1).split("/").filter(Boolean);
  if (url.pathname !== `/${segments.join("/")}`) {
    throw new NativePushValidationError("وجهة الإشعار غير صالحة.");
  }
  if (segments.length === 1 && ROOT_DESTINATIONS.has(segments[0])) return raw;
  if (segments[0] !== "module" || segments.length < 2 || segments.length > 4) {
    throw new NativePushValidationError("وجهة الإشعار غير معروفة.");
  }
  if (!MODULES.has(segments[1]))
    throw new NativePushValidationError("وحدة الإشعار غير معروفة.");
  if (segments.length >= 3 && !INTENTS.has(segments[2])) {
    throw new NativePushValidationError("إجراء الإشعار غير معروف.");
  }
  if (segments.length === 4 && !ENTITY_ID_RE.test(segments[3])) {
    throw new NativePushValidationError("معرّف عنصر الإشعار غير صالح.");
  }
  const intent = segments[2];
  const entity = segments[3];
  if (
    (intent === "view" || intent === "edit" || intent === "approve") &&
    !entity
  ) {
    throw new NativePushValidationError("وجهة الإشعار تحتاج معرّف عنصر.");
  }
  if ((intent === "browse" || intent === "create") && entity) {
    throw new NativePushValidationError("وجهة الإشعار لا تقبل معرّف عنصر.");
  }
  return raw;
}

export function normalizeNativePushPayload(
  input: NativePushPayloadInput,
): NormalizedNativePushPayload {
  const notificationId = input.notificationId.trim();
  const kind = input.kind.trim();
  const title = input.title.trim();
  const body = input.body.trim();
  if (!NOTIFICATION_ID_RE.test(notificationId)) {
    throw new NativePushValidationError("معرّف الإشعار غير صالح.");
  }
  if (!KIND_RE.test(kind))
    throw new NativePushValidationError("نوع الإشعار غير صالح.");
  if (!title || title.length > 80)
    throw new NativePushValidationError("عنوان الإشعار غير صالح.");
  if (!body || body.length > 180)
    throw new NativePushValidationError("نص الإشعار غير صالح.");
  if (input.urgency !== "information" && input.urgency !== "action") {
    throw new NativePushValidationError("أولوية الإشعار غير صالحة.");
  }
  const destination = validateNativeDestination(input.destination);
  return {
    version: "1",
    notificationId,
    kind,
    title: input.sensitive ? "تحديث آمن" : title,
    body: input.sensitive ? "افتح سوبر العربية لعرض التفاصيل." : body,
    destination,
    urgency: input.urgency,
    sensitive: input.sensitive ? "true" : "false",
  };
}

export function readFcmCredentials(
  raw = process.env.FCM_SERVICE_ACCOUNT_JSON,
): FcmCredentials {
  if (!raw || raw.length > 32_768) {
    throw new NativePushConfigurationError("بيانات اعتماد FCM غير مهيأة.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NativePushConfigurationError("صيغة بيانات اعتماد FCM غير صالحة.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new NativePushConfigurationError("صيغة بيانات اعتماد FCM غير صالحة.");
  }
  const value = parsed as Record<string, unknown>;
  const projectId =
    typeof value.project_id === "string" ? value.project_id.trim() : "";
  const clientEmail =
    typeof value.client_email === "string" ? value.client_email.trim() : "";
  const privateKey =
    typeof value.private_key === "string" ? value.private_key : "";
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new NativePushConfigurationError("معرّف مشروع FCM غير صالح.");
  }
  if (!/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(clientEmail)) {
    throw new NativePushConfigurationError("حساب خدمة FCM غير صالح.");
  }
  if (
    !privateKey.includes("-----BEGIN PRIVATE KEY-----") ||
    !privateKey.includes("-----END PRIVATE KEY-----")
  ) {
    throw new NativePushConfigurationError("مفتاح حساب خدمة FCM غير صالح.");
  }
  const configuredProject = process.env.FCM_PROJECT_ID?.trim();
  if (configuredProject && configuredProject !== projectId) {
    throw new NativePushConfigurationError(
      "معرّف مشروع FCM لا يطابق حساب الخدمة.",
    );
  }
  return { projectId, clientEmail, privateKey };
}

export function isNativePushConfigured(): boolean {
  try {
    readFcmCredentials();
    return true;
  } catch {
    return false;
  }
}

export async function registerNativePushDevice(input: {
  userId: number;
  installationId: string;
  devicePublicKeyHash: string;
  environment: NativePushEnvironment;
  appVersion: string;
}): Promise<{ id: number; installationIdHash: string }> {
  const installationId = validateFcmInstallationId(input.installationId);
  const tokenHash = hashFcmInstallationId(installationId);
  const devicePublicKeyHash = validateDevicePublicKeyHash(
    input.devicePublicKeyHash,
  );
  if (!NATIVE_PUSH_ENVIRONMENTS.includes(input.environment)) {
    throw new NativePushValidationError("بيئة التطبيق غير صالحة.");
  }
  const appVersion = input.appVersion.trim();
  if (!appVersion || appVersion.length > 64) {
    throw new NativePushValidationError("إصدار التطبيق غير صالح.");
  }
  // Database column names remain token* for migration compatibility; the encrypted value is a
  // Firebase Installation ID and the HTTP v1 sender targets `message.fid`.
  const tokenCiphertext = encryptSecret(installationId);
  if (!tokenCiphertext)
    throw new NativePushConfigurationError("تعذّر تشفير رمز إشعارات الجهاز.");

  const connection = await requirePool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<DeviceRow[]>(
      "SELECT id, userId, tokenCiphertext, tokenHash, revokedAt FROM nativePushDevices WHERE tokenHash = ? FOR UPDATE",
      [tokenHash],
    );
    const existing = rows[0];
    if (
      existing &&
      existing.userId !== input.userId &&
      existing.revokedAt == null
    ) {
      throw new NativePushConflictError("رمز الإشعارات مرتبط بحساب آخر.");
    }
    if (existing) {
      await connection.execute(
        `UPDATE nativePushDevices
           SET userId = ?, tokenCiphertext = ?, devicePublicKeyHash = ?, environment = ?,
               appVersion = ?, revokedAt = NULL, lastSeenAt = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          input.userId,
          tokenCiphertext,
          devicePublicKeyHash,
          input.environment,
          appVersion,
          existing.id,
        ],
      );
      await connection.execute(
        `UPDATE nativePushDevices
            SET revokedAt = CURRENT_TIMESTAMP
          WHERE userId = ? AND BINARY devicePublicKeyHash = ? AND environment = ?
            AND id <> ? AND revokedAt IS NULL`,
        [input.userId, devicePublicKeyHash, input.environment, existing.id],
      );
      await connection.commit();
      return { id: existing.id, installationIdHash: tokenHash };
    }
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO nativePushDevices
        (userId, tokenHash, tokenCiphertext, devicePublicKeyHash, environment, appVersion)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.userId,
        tokenHash,
        tokenCiphertext,
        devicePublicKeyHash,
        input.environment,
        appVersion,
      ],
    );
    await connection.execute(
      `UPDATE nativePushDevices
          SET revokedAt = CURRENT_TIMESTAMP
        WHERE userId = ? AND BINARY devicePublicKeyHash = ? AND environment = ?
          AND id <> ? AND revokedAt IS NULL`,
      [input.userId, devicePublicKeyHash, input.environment, result.insertId],
    );
    await connection.commit();
    return { id: result.insertId, installationIdHash: tokenHash };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function revokeNativePushDevice(
  userId: number,
  devicePublicKeyHash: string,
): Promise<void> {
  const normalizedHash = validateDevicePublicKeyHash(devicePublicKeyHash);
  await requirePool().execute(
    `UPDATE nativePushDevices
        SET revokedAt = CURRENT_TIMESTAMP
      WHERE userId = ? AND BINARY devicePublicKeyHash = ? AND revokedAt IS NULL`,
    [userId, normalizedHash],
  );
}

export async function countActiveNativePushDevices(
  userId: number,
): Promise<number> {
  const [rows] = await requirePool().execute<
    Array<RowDataPacket & { count: number }>
  >(
    "SELECT COUNT(*) AS count FROM nativePushDevices WHERE userId = ? AND revokedAt IS NULL",
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function getFcmAccessToken(
  credentials: FcmCredentials,
  fetchImpl: typeof fetch,
): Promise<string> {
  const key = `${credentials.projectId}:${credentials.clientEmail}`;
  if (
    accessTokenCache?.key === key &&
    accessTokenCache.expiresAtMs > Date.now() + 60_000
  ) {
    return accessTokenCache.accessToken;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: FCM_SCOPE,
      aud: FCM_AUDIENCE,
      iat: nowSeconds - 30,
      exp: nowSeconds + 3_600,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${claims}`;
  let signature: string;
  try {
    signature = crypto
      .sign("RSA-SHA256", Buffer.from(unsigned), credentials.privateKey)
      .toString("base64url");
  } catch {
    throw new NativePushConfigurationError("تعذّر توقيع طلب مصادقة FCM.");
  }
  const assertion = `${unsigned}.${signature}`;
  const response = await fetchImpl(FCM_AUDIENCE, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new NativePushConfigurationError(
      "رفضت Google مصادقة خدمة الإشعارات.",
    );
  const body = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string" || body.access_token.length < 20) {
    throw new NativePushConfigurationError("استجابة مصادقة FCM غير مكتملة.");
  }
  const expiresIn =
    typeof body.expires_in === "number"
      ? Math.max(60, Math.min(body.expires_in, 3_600))
      : 3_600;
  accessTokenCache = {
    key,
    accessToken: body.access_token,
    expiresAtMs: Date.now() + expiresIn * 1_000,
  };
  return body.access_token;
}

interface FcmSendResult {
  status: "SENT" | "GONE" | "FAILED";
  statusCode: number;
  messageId: string | null;
  errorCode: string | null;
}

export async function sendFcmDataMessage(
  installationId: string,
  payload: NormalizedNativePushPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<FcmSendResult> {
  const credentials = readFcmCredentials();
  const accessToken = await getFcmAccessToken(credentials, fetchImpl);
  const response = await fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        message: {
          fid: validateFcmInstallationId(installationId),
          data: payload,
          android: {
            priority: payload.urgency === "action" ? "HIGH" : "NORMAL",
            ttl: "86400s",
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    name?: unknown;
    error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> };
  };
  if (response.ok && typeof body.name === "string") {
    return {
      status: "SENT",
      statusCode: response.status,
      messageId: body.name.slice(0, 255),
      errorCode: null,
    };
  }
  const detailCode = body.error?.details
    ?.map((detail) => detail.errorCode)
    .find((code): code is string => typeof code === "string");
  const status =
    typeof body.error?.status === "string" ? body.error.status : null;
  const gone = detailCode === "UNREGISTERED" || status === "NOT_FOUND";
  return {
    status: gone ? "GONE" : "FAILED",
    statusCode: response.status,
    messageId: null,
    errorCode: (detailCode ?? status ?? "FCM_REQUEST_FAILED").slice(0, 64),
  };
}

export async function sendNativePushToUser(
  userId: number,
  input: NativePushPayloadInput,
  environment: NativePushEnvironment = "prod",
): Promise<{ sent: number; goneRevoked: number; failed: number }> {
  // Validate configuration before reading device tokens: no credentials means an explicit failure,
  // never a false "sent" result.
  readFcmCredentials();
  const payload = normalizeNativePushPayload(input);
  const pool = requirePool();
  const [devices] = await pool.execute<DeviceRow[]>(
    `SELECT id, userId, tokenCiphertext, tokenHash, revokedAt
       FROM nativePushDevices
      WHERE userId = ? AND environment = ? AND revokedAt IS NULL`,
    [userId, environment],
  );
  const [alreadyDelivered] = await pool.execute<DeliveredTokenRow[]>(
    `SELECT tokenHash
       FROM nativePushDeliveryLog
      WHERE notificationId = ? AND status IN ('SENT', 'GONE')`,
    [payload.notificationId],
  );
  const deliveredTokenHashes = new Set(
    alreadyDelivered.map((row) => row.tokenHash),
  );
  let sent = 0;
  let goneRevoked = 0;
  let failed = 0;
  for (const device of devices) {
    // Normal retries must not fan the same logical notification back out to devices that already
    // acknowledged it. A crash between FCM accepting and this log write can still yield at-least-
    // once delivery, which is unavoidable without provider-side idempotency.
    if (deliveredTokenHashes.has(device.tokenHash)) continue;
    let result: FcmSendResult;
    try {
      const token = decryptSecret(device.tokenCiphertext);
      if (!token) throw new Error("missing token");
      result = await sendFcmDataMessage(token, payload);
    } catch (error) {
      if (error instanceof NativePushConfigurationError) throw error;
      result = {
        status: "FAILED",
        statusCode: 0,
        messageId: null,
        errorCode: "DELIVERY_FAILED",
      };
    }
    if (result.status === "SENT") sent += 1;
    else if (result.status === "GONE") {
      goneRevoked += 1;
      await pool.execute(
        "UPDATE nativePushDevices SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND revokedAt IS NULL",
        [device.id],
      );
    } else failed += 1;
    await pool.execute(
      `INSERT INTO nativePushDeliveryLog
        (userId, tokenHash, notificationId, kind, destination, status, statusCode, messageId, errorCode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status), statusCode = VALUES(statusCode), messageId = VALUES(messageId),
         errorCode = VALUES(errorCode), sentAt = CURRENT_TIMESTAMP`,
      [
        userId,
        device.tokenHash,
        payload.notificationId,
        payload.kind,
        payload.destination,
        result.status,
        result.statusCode,
        result.messageId,
        result.errorCode,
      ],
    );
  }
  return { sent, goneRevoked, failed };
}

export function __resetNativePushCachesForTests(): void {
  accessTokenCache = null;
}
