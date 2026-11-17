import crypto from "node:crypto";
import {
  OFFLINE_GRANT_DURATION_MS,
  buildGrantEnvelopeSigningString,
  buildOfflineCaptureProofPreimage,
  type OfflineCaptureProofFields,
  type OfflineShiftCaptureGrant,
} from "../../shared/offlineCaptureProof";

/**
 * Maximum post-expiry sync arrival grace (`24h`) when an unplugged terminal reconnects after
 * capturing a sale BEFORE `expiresAtServerMs`. Note: `capturedAt` MUST still fall within the
 * server-signed `[issuedAtServerMs - 5m, expiresAtServerMs]` window AND `serverNowMs` must not
 * exceed `expiresAtServerMs + MAX_OFFLINE_SYNC_ARRIVAL_GRACE_MS` (defeating client clock rollback!).
 */
export const MAX_OFFLINE_SYNC_ARRIVAL_GRACE_MS = 24 * 60 * 60 * 1000;

export interface OfflineKeyring {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

/**
 * Purpose-isolated, versioned keyring (`OFFLINE_CAPTURE_KEYRING="k2:<secret>,k1:<secret>"`).
 * - Active signing key is the first listed key (`activeKeyId`).
 * - All listed keys remain valid for verification during seamless key rotation or Cloud->Local cutover.
 * - When `OFFLINE_CAPTURE_KEYRING` is unset, derives purpose-isolated key `k1` via HKDF-SHA256
 *   from `JWT_SECRET` so raw `JWT_SECRET` is never directly used as an HMAC key.
 * - NEVER logs secret material.
 */
export function resolveOfflineCaptureKeyring(): OfflineKeyring {
  const configured = process.env.OFFLINE_CAPTURE_KEYRING?.trim();
  if (configured) {
    const entries = configured
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const keys = new Map<string, Buffer>();
    let activeKeyId = "";
    for (const entry of entries) {
      const idx = entry.indexOf(":");
      if (idx <= 0 || idx === entry.length - 1) {
        throw new Error("Malformed OFFLINE_CAPTURE_KEYRING entry (expected keyId:secret)");
      }
      const keyId = entry.slice(0, idx).trim();
      const rawSecret = entry.slice(idx + 1).trim();
      if (!/^[a-zA-Z0-9_-]{1,24}$/.test(keyId) || rawSecret.length < 16) {
        throw new Error("Invalid keyId or short secret in OFFLINE_CAPTURE_KEYRING");
      }
      const derived = Buffer.from(
        crypto.hkdfSync(
          "sha256",
          Buffer.from(rawSecret, "utf8"),
          Buffer.from("alroya.offline.keyring.salt.v4", "utf8"),
          Buffer.from(`alroya.offline.capture_master.v4|${keyId}`, "utf8"),
          32,
        ),
      );
      if (!activeKeyId) activeKeyId = keyId;
      keys.set(keyId, derived);
    }
    if (!activeKeyId || keys.size === 0) {
      throw new Error("OFFLINE_CAPTURE_KEYRING resolved zero usable keys");
    }
    return { activeKeyId, keys };
  }

  const jwtSecret =
    process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16
      ? process.env.JWT_SECRET
      : process.env.NODE_ENV === "test"
        ? "test-only-offline-capture-master-secret-32b!!"
        : "";
  if (!jwtSecret) {
    throw new Error("OFFLINE_CAPTURE_KEYRING or JWT_SECRET is required for offline shift capture grants");
  }
  const k1 = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(jwtSecret, "utf8"),
      Buffer.from("alroya.offline.keyring.salt.v4", "utf8"),
      Buffer.from("alroya.offline.capture_master.v4|k1", "utf8"),
      32,
    ),
  );
  return { activeKeyId: "k1", keys: new Map([["k1", k1]]) };
}

export function deriveGrantSecretsWithMaster(
  masterKey: Buffer,
  params: {
    keyId: string;
    grantId: string;
    userId: number;
    branchId: number;
    shiftId: number;
    issuedAtServerMs: number;
    expiresAtServerMs: number;
  },
): { captureKeyHex: string; grantToken: string } {
  const captureKeyHex = crypto
    .createHmac("sha256", masterKey)
    .update(
      `alroya.offline.shift_capture_key.v4|${params.keyId}|${params.grantId}|${Number(params.userId)}|${Number(params.branchId)}|${Number(params.shiftId)}|${Number(params.issuedAtServerMs)}|${Number(params.expiresAtServerMs)}`,
      "utf8",
    )
    .digest("hex");
  const grantToken = crypto
    .createHmac("sha256", masterKey)
    .update(buildGrantEnvelopeSigningString(params), "utf8")
    .digest("hex");
  return { captureKeyHex, grantToken };
}

export function issueOfflineShiftCaptureGrant(params: {
  userId: number;
  branchId: number;
  shiftId: number;
  nowMs?: number;
  ttlMs?: number;
}): OfflineShiftCaptureGrant {
  const keyring = resolveOfflineCaptureKeyring();
  const keyId = keyring.activeKeyId;
  const masterKey = keyring.keys.get(keyId)!;
  const issuedAtServerMs =
    params.nowMs != null && Number.isFinite(params.nowMs)
      ? Math.trunc(params.nowMs)
      : Date.now();
  const ttl =
    params.ttlMs != null && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? Math.trunc(params.ttlMs)
      : OFFLINE_GRANT_DURATION_MS;
  const expiresAtServerMs = issuedAtServerMs + ttl;
  const grantId = crypto.randomBytes(16).toString("hex");
  const { captureKeyHex, grantToken } = deriveGrantSecretsWithMaster(masterKey, {
    keyId,
    grantId,
    userId: Number(params.userId),
    branchId: Number(params.branchId),
    shiftId: Number(params.shiftId),
    issuedAtServerMs,
    expiresAtServerMs,
  });
  return {
    version: 4,
    keyId,
    grantId,
    userId: Number(params.userId),
    branchId: Number(params.branchId),
    shiftId: Number(params.shiftId),
    issuedAt: new Date(issuedAtServerMs).toISOString(),
    issuedAtServerMs,
    expiresAtServerMs,
    captureKeyHex,
    grantToken,
  };
}

export type GrantVerificationFailureReason =
  | "MALFORMED_PROOF_OR_TOKEN"
  | "UNKNOWN_KEY_ID"
  | "INVALID_GRANT_TOKEN_SIGNATURE"
  | "INVALID_ROW_HMAC_PROOF"
  | "CLIENT_CLOCK_TAMPER_OR_OUT_OF_GRANT_WINDOW"
  | "LATE_ARRIVAL_BEYOND_OFFLINE_GRACE"
  | "GRANT_PRECEDES_SHIFT_OPEN";

export function verifyOfflineCaptureProofServer(
  providedProofHex: string,
  fields: OfflineCaptureProofFields,
  options?: {
    serverNowMs?: number;
    shiftOpenedAtMs?: number | null;
  },
): { ok: true } | { ok: false; code: GrantVerificationFailureReason; message: string } {
  if (
    typeof providedProofHex !== "string" ||
    !/^[0-9a-f]{64}$/i.test(providedProofHex) ||
    typeof fields.grantToken !== "string" ||
    !/^[0-9a-f]{64}$/i.test(fields.grantToken) ||
    typeof fields.grantId !== "string" ||
    !/^[0-9a-f]{16,64}$/i.test(fields.grantId) ||
    typeof fields.keyId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,24}$/i.test(fields.keyId) ||
    !Number.isSafeInteger(fields.grantIssuedAtMs) ||
    !Number.isSafeInteger(fields.grantExpiresAtMs) ||
    fields.grantExpiresAtMs <= fields.grantIssuedAtMs ||
    fields.grantExpiresAtMs - fields.grantIssuedAtMs > OFFLINE_GRANT_DURATION_MS + 60_000
  ) {
    return {
      ok: false,
      code: "MALFORMED_PROOF_OR_TOKEN",
      message: "بنية ختم الالتقاط أو رمز المنحة الخادمي غير صالحة",
    };
  }

  const keyring = resolveOfflineCaptureKeyring();
  const masterKey = keyring.keys.get(fields.keyId);
  if (!masterKey) {
    return {
      ok: false,
      code: "UNKNOWN_KEY_ID",
      message: `مفتاح التحقق المرقّم (${fields.keyId}) غير معرّف في حلقة مفاتيح الخادم`,
    };
  }

  const { captureKeyHex, grantToken: expectedGrantToken } = deriveGrantSecretsWithMaster(
    masterKey,
    {
      keyId: fields.keyId,
      grantId: fields.grantId,
      userId: Number(fields.capturedByUserId),
      branchId: Number(fields.branchId),
      shiftId: Number(fields.capturedShiftId),
      issuedAtServerMs: Number(fields.grantIssuedAtMs),
      expiresAtServerMs: Number(fields.grantExpiresAtMs),
    },
  );

  const tokA = Buffer.from(fields.grantToken.toLowerCase(), "hex");
  const tokB = Buffer.from(expectedGrantToken.toLowerCase(), "hex");
  if (tokA.length !== tokB.length || !crypto.timingSafeEqual(tokA, tokB)) {
    return {
      ok: false,
      code: "INVALID_GRANT_TOKEN_SIGNATURE",
      message: "فشل توقيع رمز المنحة الخادمي — رُفض التلاعب بتاريخ الإصدار أو الصلاحية",
    };
  }

  const expectedProofHex = crypto
    .createHmac("sha256", Buffer.from(captureKeyHex, "hex"))
    .update(buildOfflineCaptureProofPreimage(fields), "utf8")
    .digest("hex");
  const prfA = Buffer.from(providedProofHex.toLowerCase(), "hex");
  const prfB = Buffer.from(expectedProofHex.toLowerCase(), "hex");
  if (prfA.length !== prfB.length || !crypto.timingSafeEqual(prfA, prfB)) {
    return {
      ok: false,
      code: "INVALID_ROW_HMAC_PROOF",
      message: "فشل التحقق التشفيري من ختم هوية الالتقاط الأصلي — رُصد تلاعب بالهوية أو الوردية أو الحمولة",
    };
  }

  if (
    options?.shiftOpenedAtMs != null &&
    Number.isFinite(options.shiftOpenedAtMs) &&
    fields.grantIssuedAtMs < options.shiftOpenedAtMs - 60_000
  ) {
    return {
      ok: false,
      code: "GRANT_PRECEDES_SHIFT_OPEN",
      message: "منحة الالتقاط صادرة قبل فتح الوردية الفعلي على الخادم",
    };
  }

  const serverNowMs =
    options?.serverNowMs != null && Number.isFinite(options.serverNowMs)
      ? options.serverNowMs
      : Date.now();
  const capturedAtMs = new Date(fields.capturedAt).getTime();
  // 1) Client `capturedAt` outside server-signed `[grantIssuedAtMs - 5m, grantExpiresAtMs]` or in the future -> clock tamper / invalid capture time!
  if (
    !Number.isFinite(capturedAtMs) ||
    capturedAtMs < fields.grantIssuedAtMs - 5 * 60_000 ||
    capturedAtMs > fields.grantExpiresAtMs ||
    capturedAtMs > serverNowMs + 5 * 60_000
  ) {
    return {
      ok: false,
      code: "CLIENT_CLOCK_TAMPER_OR_OUT_OF_GRANT_WINDOW",
      message:
        "توقيت الالتقاط المبلَّغ يقع خارج نافذة المنحة الخادمية الموقّعة أو في المستقبل — رُصد تلاعب بساعة الجهاز وعُلّقت للمراجعة",
    };
  }

  // 2) Cryptographic `grantToken` + `captureProof` ARE valid and `capturedAt` lies inside `[grantIssuedAtMs - 5m, grantExpiresAtMs]`,
  //    yet `serverNowMs` arrived >24h after grant expiry (long single-PC LAN disconnection). Client clock alone cannot prove wall-clock
  //    capture time, so we quarantine into `offline_recovery_items` WITH cryptographic provenance preserved for audited manager review!
  if (serverNowMs > fields.grantExpiresAtMs + MAX_OFFLINE_SYNC_ARRIVAL_GRACE_MS) {
    return {
      ok: false,
      code: "LATE_ARRIVAL_BEYOND_OFFLINE_GRACE",
      message:
        "وصلت العملية بعد تجاوز مهلة الانقطاع الطويل عن الشبكة المحلية (> ٢٤ ساعة بعد انتهاء المنحة؛ ساعة الجهاز وحدها لا تثبت وقت الالتقاط) — حُفظت بختمها الأصلي في طابور مراجعة واسترداد المدير دون إسقاط",
    };
  }

  return { ok: true };
}
