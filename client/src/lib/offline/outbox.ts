// طابور المبيعات الأوفلاينية — الشريحة ٣ من خطة الأوفلاين (تعميم نمط countQueue على Dexie).
//
// الالتقاط: بيع نقدي كامل يُحفظ محلياً بعنصر يحمل clientRequestId الثابت نفسه الذي كان
// سيستعمله البيع أونلاين ⇒ الترحيل عبر offline.replaySale يمرّ بفحص uq_invoice_source
// وبصمة السلة في createSale — التكرار آمن دائماً حتى مع بيعٍ نصف-ناجح قبل الانقطاع.
//
// التفريغ: FIFO بترتيب الالتقاط، طلب واحد بالطيران، تراجع أُسّي 1ث→60ث على فشل النقل.
// رفض الأعمال (فترة مقفلة/تحت التكلفة/وردية مغلقة/نافذة الالتقاط) ⇒ العنصر يُعلَّق PARKED
// ويُكمل التفريغ للعنصر التالي — عنصر معطوب لا يحجب النقود التي بعده. UNAUTHORIZED يوقف
// التفريغ كله (يلزم دخول) بلا تعليق العناصر — الطابور مربوط بالجهاز لا بالجلسة.
//
// صماما أمان (نهج Square): سقف قيمة للطابور (حدّ أقصى معلوم للمبالغ خارج الدفاتر لحظةً)
// وسقف عمر للكاش المحلي (أسعار أقدم من ٤٨ ساعة ⇒ قراءة فقط بلا بيع).

import { getLastSyncAt } from "./catalogSync";
import { D } from "../money";
import { decryptJson, encryptJson, isEncryptedEnvelope, isLegacyZeroIvEnvelope } from "./crypto";
import { getMeta, offlineDb, setMeta, type OfflineOutboxItem, type OfflineOutboxKind } from "./db";
import {
  OFFLINE_AUTH_BROADCAST_CHANNEL,
  OFFLINE_REVOKE_EPOCH_STORAGE_KEY,
  OFFLINE_SESSION_EPOCH_STORAGE_KEY,
  broadcastCrossTabOfflineRevocation,
  clearOfflinePermSnapshot,
  getOfflineProfile,
  readCrossTabRevokedAtMs,
  readCrossTabSessionEpoch,
  resolveOfflinePermSnapshot,
} from "./pinLock";
import { LEGACY_OUTBOX_REVIEW_MESSAGE, partitionOutboxByIdentity } from "./outboxIdentity";
import {
  computeOfflineCaptureProofHex,
  computeSaleSemanticPayloadSha256,
  type OfflineShiftCaptureGrant,
} from "@shared/offlineCaptureProof";
import type { RecipeLineSelection } from "@shared/recipeVariantSelection";

export const OFFLINE_QUEUE_CAP_IQD = 5_000_000;
export const OFFLINE_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const OFFLINE_SHIFT_GRANT_TTL_MS = OFFLINE_CACHE_MAX_AGE_MS;
export const ENCRYPTED_SHIFT_GRANT_META_KEY = "encryptedShiftCaptureGrant";
export const LEGACY_DEVICE_CODE_META_KEY = "legacyDeviceCode";
export const PREFLIGHT_INTENTS_META_KEY = "preflightSaleIntentsV4";
export const PREFLIGHT_INTENT_IDB_KEY_PREFIX = "preflightIntentV4:";
export const PREFLIGHT_INTENT_LS_KEY_PREFIX = "alroya.preflightIntent.v4:";
export const PREFLIGHT_LOCK_IDB_KEY_PREFIX = "preflightLockV4:";
export const PREFLIGHT_LOCK_LS_KEY_PREFIX = "alroya.preflightLock.v4:";
export const PREFLIGHT_LIVE_LEASE_TTL_MS = 15_000;
export const PREFLIGHT_TOMBSTONE_RETENTION_MS = 72 * 60 * 60 * 1000;
export const OFFLINE_LOCAL_ONLY_STATUS_LABEL =
  "محفوظ على هذا الجهاز وبانتظار المزامنة";

export class OfflineCounterCorruptError extends Error {
  readonly code = "OFFLINE_COUNTER_CORRUPT";
  constructor(message: string) {
    super(message);
    this.name = "OfflineCounterCorruptError";
  }
}

export class OfflineIdentityTamperError extends Error {
  readonly code = "OFFLINE_OUTBOX_IDENTITY_TAMPERED";
  constructor(message: string) {
    super(message);
    this.name = "OfflineIdentityTamperError";
  }
}

export class PreflightCrossTabLockContentionError extends Error {
  readonly code = "PREFLIGHT_CROSS_TAB_LOCK_CONTENTION";
  constructor(message: string) {
    super(message);
    this.name = "PreflightCrossTabLockContentionError";
  }
}

export interface CaptureGrantCheckContext {
  branchId?: number | null;
  shiftId?: number | null;
  capturedByUserId?: number | null;
  enforceOfflinePermPolicy?: boolean;
}

export interface PreflightSaleIntentV4 {
  clientRequestId: string;
  tabId: number;
  branchId: number;
  shiftId: number;
  capturedByUserId: number;
  total: string;
  hadManagerApprovalAtSubmit: boolean;
  semanticPayloadSha256: string;
  saleInput: Record<string, unknown>;
  receiptContext?: Record<string, unknown> | null;
  ownerTabInstanceId?: string;
  liveLeaseUntilMs?: number | null;
  commercialPayloadUnavailable?: boolean;
  createdAtIso: string;
  updatedAtMs: number;
  revision: number;
  status: "IN_FLIGHT" | "UNCONFIRMED_SERVER_OUTCOME" | "CLEARED";
  clearedAtMs?: number | null;
  failureReason?: string | null;
}

export interface RecoverablePreflightIntentsResult {
  intents: PreflightSaleIntentV4[];
  foreignOwnerPendingCount: number;
  activeInOtherTabCount: number;
  earliestOtherTabLeaseExpiryMs?: number | null;
}

export interface PreUpgradeOutboxAuditReport {
  totalRows: number;
  unsentLegacyWithoutProofCount: number;
  unsentLegacyClientRequestIds: string[];
  unsentVerifiedV4Count: number;
  parkedCount: number;
  sentCount: number;
  safeForCleanUpgradeWithoutQuarantine: boolean;
}

interface PersistedShiftGrantPlaintextV4 {
  __shiftGrantV4: 1;
  grant: OfflineShiftCaptureGrant;
  savedAtClientMs: number;
  expiresAtClientMs: number;
}

interface SerializedMetaCipherV4 {
  __metaCipherV4: 1;
  userId: number;
  branchId: number;
  shiftId: number;
  ivHex: string;
  dataHex: string;
}

function buildShiftGrantAad(userId: number, branchId: number, shiftId: number): Uint8Array {
  return new TextEncoder().encode(
    `alroya.shift_grant.v4|${Number(userId)}|${Number(branchId)}|${Number(shiftId)}`,
  );
}

function buildPreflightIntentAad(
  clientRequestId: string,
  capturedByUserId: number,
  branchId: number,
): Uint8Array {
  return new TextEncoder().encode(
    `alroya.preflight_intent.v4|${clientRequestId}|${Number(capturedByUserId)}|${Number(branchId)}`,
  );
}

function buildOutboxItemAad(params: {
  clientRequestId: string;
  kind: string;
  capturedByUserId: number;
  branchId: number;
  capturedShiftId: number | null;
}): Uint8Array {
  return new TextEncoder().encode(
    `alroya.outbox_item.v4|${params.clientRequestId}|${params.kind}|${Number(params.capturedByUserId)}|${Number(params.branchId)}|${params.capturedShiftId ?? 0}`,
  );
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytesLocal(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isValidShiftCaptureGrant(
  grant: OfflineShiftCaptureGrant | null | undefined,
): grant is OfflineShiftCaptureGrant {
  if (!grant || grant.version !== 4) return false;
  if (!Number.isSafeInteger(grant.userId) || grant.userId <= 0) return false;
  if (!Number.isSafeInteger(grant.branchId) || grant.branchId <= 0) return false;
  if (!Number.isSafeInteger(grant.shiftId) || grant.shiftId <= 0) return false;
  if (typeof grant.keyId !== "string" || !/^[a-zA-Z0-9_-]{1,24}$/.test(grant.keyId)) return false;
  if (typeof grant.grantId !== "string" || !/^[0-9a-f]{16,64}$/i.test(grant.grantId)) return false;
  if (!Number.isSafeInteger(grant.issuedAtServerMs) || !Number.isSafeInteger(grant.expiresAtServerMs)) return false;
  if (grant.expiresAtServerMs <= grant.issuedAtServerMs) return false;
  if (typeof grant.captureKeyHex !== "string" || !/^[0-9a-f]{64}$/i.test(grant.captureKeyHex)) return false;
  if (typeof grant.grantToken !== "string" || !/^[0-9a-f]{64}$/i.test(grant.grantToken)) return false;
  return true;
}

let activeShiftCaptureGrant: OfflineShiftCaptureGrant | null = null;
let activeShiftGrantSavedAtMs = 0;
let activeShiftGrantExpiresAtMs = 0;
let grantMutationEpoch = 0;

function wipeInMemoryGrantOnly(): void {
  ++grantMutationEpoch;
  activeShiftCaptureGrant = null;
  activeShiftGrantSavedAtMs = 0;
  activeShiftGrantExpiresAtMs = 0;
}

if (typeof window !== "undefined") {
  try {
    window.addEventListener("storage", (ev) => {
      if (
        ev.key === OFFLINE_REVOKE_EPOCH_STORAGE_KEY ||
        ev.key === OFFLINE_SESSION_EPOCH_STORAGE_KEY ||
        ev.key === "alroya.offlineRevokeSignal.v4"
      ) {
        wipeInMemoryGrantOnly();
      }
    });
  } catch {
    /* noop */
  }
}

if (typeof BroadcastChannel !== "undefined") {
  try {
    const grantBc = new BroadcastChannel(OFFLINE_AUTH_BROADCAST_CHANNEL);
    grantBc.onmessage = (ev) => {
      if (ev?.data?.type === "REVOKE_ALL") {
        wipeInMemoryGrantOnly();
      }
    };
  } catch {
    /* noop */
  }
}

export async function setActiveOfflineCaptureGrant(
  grant: OfflineShiftCaptureGrant | null | undefined,
  opts?: { expectedSessionEpoch?: number; expectedUserId?: number | null },
): Promise<boolean> {
  if (!isValidShiftCaptureGrant(grant)) {
    await clearActiveOfflineCaptureGrant();
    return false;
  }
  const currentSessionEpoch = readCrossTabSessionEpoch();
  if (
    opts?.expectedSessionEpoch !== undefined &&
    opts.expectedSessionEpoch !== currentSessionEpoch
  ) {
    return false;
  }
  if (opts?.expectedUserId != null && Number(opts.expectedUserId) !== Number(grant.userId)) {
    return false;
  }
  const revokedAtMs = readCrossTabRevokedAtMs();
  if (revokedAtMs > 0 && grant.issuedAtServerMs <= revokedAtMs) {
    return false;
  }

  const epoch = ++grantMutationEpoch;
  const now = Math.max(Date.now(), revokedAtMs + 1);
  const serverRemainingMs = Math.max(0, grant.expiresAtServerMs - grant.issuedAtServerMs);
  const expiresAtClientMs = Math.min(
    grant.expiresAtServerMs,
    now + Math.min(serverRemainingMs, OFFLINE_SHIFT_GRANT_TTL_MS),
  );
  activeShiftCaptureGrant = { ...grant };
  activeShiftGrantSavedAtMs = now;
  activeShiftGrantExpiresAtMs = expiresAtClientMs;
  try {
    const payload: PersistedShiftGrantPlaintextV4 = {
      __shiftGrantV4: 1,
      grant: { ...grant },
      savedAtClientMs: now,
      expiresAtClientMs,
    };
    const aad = buildShiftGrantAad(grant.userId, grant.branchId, grant.shiftId);
    const env = await encryptJson(payload, aad);
    if (
      epoch !== grantMutationEpoch ||
      (opts?.expectedSessionEpoch !== undefined &&
        opts.expectedSessionEpoch !== readCrossTabSessionEpoch())
    ) {
      wipeInMemoryGrantOnly();
      return false;
    }
    const serialized: SerializedMetaCipherV4 = {
      __metaCipherV4: 1,
      userId: grant.userId,
      branchId: grant.branchId,
      shiftId: grant.shiftId,
      ivHex: bytesToHexLocal(env.iv),
      dataHex: bytesToHexLocal(env.data),
    };
    await setMeta(ENCRYPTED_SHIFT_GRANT_META_KEY, JSON.stringify(serialized));
  } catch {
    /* keep validated RAM grant if IndexedDB unavailable */
  }
  return true;
}

/**
 * Revokes the shift capture grant AND cached offline permissions across ALL open browser tabs
 * immediately (`BroadcastChannel` + monotonic `localStorage` revocation & session epochs), even if
 * `setMeta` fails or throws in IndexedDB! Never deletes `offlineDb.outbox` rows.
 */
export async function clearActiveOfflineCaptureGrant(reason = "grant_cleared"): Promise<void> {
  wipeInMemoryGrantOnly();
  if (reason === "no_open_shift_on_server") {
    await setMeta(ENCRYPTED_SHIFT_GRANT_META_KEY, "");
    return;
  }
  broadcastCrossTabOfflineRevocation(reason);
  await Promise.allSettled([
    setMeta(ENCRYPTED_SHIFT_GRANT_META_KEY, ""),
    clearOfflinePermSnapshot(),
  ]);
}

type ShiftGrantResolution =
  | { ok: true; grant: OfflineShiftCaptureGrant }
  | {
      ok: false;
      code: "CRYPTO_UNAVAILABLE" | "MISSING" | "EXPIRED" | "MISMATCH";
      reason: string;
    };

const EXPIRED_GRANT_MESSAGE =
  "انتهت صلاحية منحة الالتقاط دون اتصال لهذه الوردية (تجاوز الانقطاع ٤٨ ساعة أو عُدِّلت ساعة الجهاز) — أعد الاتصال بخادم الفرع لتجديد الوردية قبل تسجيل مبيعات جديدة. المبيعات المحفوظة سابقاً باقية للمزامنة.";
const MISSING_GRANT_MESSAGE =
  "لا تتوفر منحة التقاط مشفّرة صالحة لهذه الوردية على هذا الجهاز — اتصل بخادم الفرع لفتح/تأكيد الوردية قبل البيع دون اتصال.";
const MISMATCH_GRANT_MESSAGE =
  "منحة الوردية المحلية لا تطابق الموظف أو الفرع أو الوردية الحالية — أعد الاتصال بخادم الفرع لتحديث الجلسة قبل البيع دون اتصال.";
const PERM_DENIED_OFFLINE_MESSAGE =
  "لا تتوفر صلاحية بيع موثّقة وسارية لهذا الحساب دون اتصال — يُمنع الحفظ المحلي حتى إعادة الاتصال والتحقق من الصلاحيات.";

async function resolveShiftCaptureGrantForCapture(params: {
  userId: number;
  branchId: number;
  shiftId: number;
}): Promise<ShiftGrantResolution> {
  if (!globalThis.crypto?.subtle) {
    return {
      ok: false,
      code: "CRYPTO_UNAVAILABLE",
      reason:
        "واجهة التشفير المحلي (WebCrypto) غير متاحة — لا يمكن إصدار ختم إثبات البيع دون اتصال.",
    };
  }
  if (
    !Number.isSafeInteger(params.userId) ||
    params.userId <= 0 ||
    !Number.isSafeInteger(params.branchId) ||
    params.branchId <= 0 ||
    !Number.isSafeInteger(params.shiftId) ||
    params.shiftId <= 0
  ) {
    return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
  }

  const now = Date.now();
  const revokedAtMs = readCrossTabRevokedAtMs();

  if (activeShiftCaptureGrant) {
    if (
      revokedAtMs > 0 &&
      (activeShiftGrantSavedAtMs <= revokedAtMs ||
        activeShiftCaptureGrant.issuedAtServerMs <= revokedAtMs)
    ) {
      wipeInMemoryGrantOnly();
      return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
    }
    if (
      activeShiftCaptureGrant.userId === params.userId &&
      activeShiftCaptureGrant.branchId === params.branchId &&
      activeShiftCaptureGrant.shiftId === params.shiftId
    ) {
      if (
        (activeShiftGrantExpiresAtMs > 0 && now > activeShiftGrantExpiresAtMs) ||
        now > activeShiftCaptureGrant.expiresAtServerMs ||
        now < activeShiftCaptureGrant.issuedAtServerMs - 5 * 60_000
      ) {
        wipeInMemoryGrantOnly();
        return { ok: false, code: "EXPIRED", reason: EXPIRED_GRANT_MESSAGE };
      }
      return { ok: true, grant: activeShiftCaptureGrant };
    }
  }

  const rawCipher = await getMeta(ENCRYPTED_SHIFT_GRANT_META_KEY);
  if (!rawCipher) {
    return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
  }

  const lastOpenShiftRaw = await getMeta("lastOpenShift");
  if (lastOpenShiftRaw !== null && lastOpenShiftRaw !== "" && lastOpenShiftRaw.startsWith("{")) {
    try {
      const parsedShift = JSON.parse(lastOpenShiftRaw) as { id?: number; branchId?: number };
      if (
        (parsedShift.id != null && Number(parsedShift.id) !== params.shiftId) ||
        (parsedShift.branchId != null && Number(parsedShift.branchId) !== params.branchId)
      ) {
        return { ok: false, code: "MISMATCH", reason: MISMATCH_GRANT_MESSAGE };
      }
    } catch {
      return { ok: false, code: "MISMATCH", reason: MISMATCH_GRANT_MESSAGE };
    }
  }

  try {
    const parsedCipher = JSON.parse(rawCipher) as Partial<SerializedMetaCipherV4>;
    if (parsedCipher?.__metaCipherV4 !== 1) {
      return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
    }
    if (
      Number(parsedCipher.userId) !== params.userId ||
      Number(parsedCipher.branchId) !== params.branchId ||
      Number(parsedCipher.shiftId) !== params.shiftId
    ) {
      return { ok: false, code: "MISMATCH", reason: MISMATCH_GRANT_MESSAGE };
    }
    const iv = hexToBytesLocal(parsedCipher.ivHex ?? "");
    const data = hexToBytesLocal(parsedCipher.dataHex ?? "");
    if (!iv || iv.byteLength !== 12 || !data || data.byteLength === 0) {
      return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
    }
    const aad = buildShiftGrantAad(params.userId, params.branchId, params.shiftId);
    const decoded = await decryptJson<PersistedShiftGrantPlaintextV4>(
      { enc: true, v: 1, iv, data },
      aad,
    );
    if (
      !decoded ||
      decoded.__shiftGrantV4 !== 1 ||
      !isValidShiftCaptureGrant(decoded.grant) ||
      !Number.isFinite(decoded.expiresAtClientMs) ||
      !Number.isFinite(decoded.savedAtClientMs)
    ) {
      return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
    }
    if (
      revokedAtMs > 0 &&
      (decoded.savedAtClientMs <= revokedAtMs || decoded.grant.issuedAtServerMs <= revokedAtMs)
    ) {
      return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
    }
    if (
      decoded.grant.userId !== params.userId ||
      decoded.grant.branchId !== params.branchId ||
      decoded.grant.shiftId !== params.shiftId
    ) {
      return { ok: false, code: "MISMATCH", reason: MISMATCH_GRANT_MESSAGE };
    }
    const hardDeadlineMs = Math.min(
      decoded.expiresAtClientMs,
      decoded.grant.expiresAtServerMs,
    );
    if (now > hardDeadlineMs || now < decoded.grant.issuedAtServerMs - 5 * 60_000) {
      return { ok: false, code: "EXPIRED", reason: EXPIRED_GRANT_MESSAGE };
    }
    activeShiftCaptureGrant = { ...decoded.grant };
    activeShiftGrantSavedAtMs = decoded.savedAtClientMs;
    activeShiftGrantExpiresAtMs = hardDeadlineMs;
    return { ok: true, grant: activeShiftCaptureGrant };
  } catch {
    return { ok: false, code: "MISSING", reason: MISSING_GRANT_MESSAGE };
  }
}

// ── v4: Per-Intent Atomic Encrypted Preflight Sale Intent (`IndexedDB` + `localStorage` AES-256-GCM,
//        explicit schema-bound credential sanitization, cross-tab live IN_FLIGHT lease, CLEARED tombstones) ──

const ALLOWED_TOP_LEVEL_SALE_FIELDS = new Set([
  "branchId",
  "shiftId",
  "sourceType",
  "clientRequestId",
  "deviceId",
  "trackingNumber",
  "siblingIndex",
  "customerId",
  "contactName",
  "contactPhone",
  "priceTier",
  "lines",
  "invoiceDiscount",
  "deliveryFee",
  "deliveryFree",
  "deliveryWaivedAmount",
  "freeShippingPromotionId",
  "taxRatePercent",
  "payment",
  "payments",
  "preCollected",
  "salesRepId",
  "attribution",
  "attributionMode",
  "assistedByUserId",
  "couponCode",
  "notes",
  "dueDate",
  "cashRoundIQD",
  "cashRoundingBasketOthers",
  "delivery",
  "deliveryFeeHeld",
  "deliveryFeeTender",
  "extraCharges",
  "creditApproved",
  "priceOverrideApproved",
]);

const ALLOWED_SALE_LINE_FIELDS = new Set([
  "variantId",
  "productUnitId",
  "quantity",
  "unitPriceOverride",
  "discountPercent",
  "discountAmount",
  "promotionId",
  "promotionDiscount",
  "cashierDiscountAmount",
  "unitCostOverride",
  "isGift",
  "sku",
  "barcode",
  "productName",
]);

const ALLOWED_PAYMENT_LEG_FIELDS = new Set([
  "amount",
  "method",
  "reference",
  "externalPaymentAttemptId",
]);

function sanitizePaymentLegContract(rawLeg: unknown): Record<string, unknown> {
  if (!rawLeg || typeof rawLeg !== "object") return {};
  const src = rawLeg as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Array.from(ALLOWED_PAYMENT_LEG_FIELDS)) {
    if (k in src && src[k] !== undefined) {
      out[k] = structuredClone(src[k]);
    }
  }
  return out;
}

function sanitizeSaleLineContract(rawLine: unknown): Record<string, unknown> {
  if (!rawLine || typeof rawLine !== "object") return {};
  const src = rawLine as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Array.from(ALLOWED_SALE_LINE_FIELDS)) {
    if (k in src && src[k] !== undefined) {
      out[k] = structuredClone(src[k]);
    }
  }
  return out;
}

function collectApprovalSecretStrings(rawApproval: unknown): string[] {
  if (!rawApproval || typeof rawApproval !== "object") return [];
  const rec = rawApproval as Record<string, unknown>;
  const secrets: string[] = [];
  for (const k of ["pin", "password", "barcode", "secret", "passcode", "token"]) {
    const v = rec[k];
    if (typeof v === "string" && v.trim().length > 0) {
      secrets.push(v);
      secrets.push(v.trim());
    }
  }
  return Array.from(new Set(secrets));
}

function assertNoManagerApprovalLeak(
  sanitizedSaleInput: Record<string, unknown>,
  rawApproval?: unknown,
): void {
  if ("managerApproval" in sanitizedSaleInput) {
    throw new Error("SECURITY_POLICY_VIOLATION: managerApproval key survived sanitization");
  }
  const secretValues = collectApprovalSecretStrings(rawApproval);
  if (secretValues.length > 0) {
    const serialized = JSON.stringify(sanitizedSaleInput);
    for (const secretVal of secretValues) {
      if (secretVal.length >= 3 && serialized.includes(secretVal)) {
        throw new Error("SECURITY_POLICY_VIOLATION: managerApproval secret value survived sanitization");
      }
    }
  }
}

export async function sanitizeSaleInputForPreflightPersistence(
  rawSaleInput: Record<string, unknown>,
): Promise<{
  sanitizedSaleInput: Record<string, unknown>;
  hadManagerApprovalAtSubmit: boolean;
  semanticPayloadSha256: string;
}> {
  const rawApproval =
    rawSaleInput && typeof rawSaleInput === "object"
      ? (rawSaleInput as Record<string, unknown>).managerApproval
      : undefined;
  const hadManagerApprovalAtSubmit = Boolean(rawApproval != null);
  const sanitizedSaleInput: Record<string, unknown> = {};
  if (rawSaleInput && typeof rawSaleInput === "object") {
    for (const [k, v] of Object.entries(rawSaleInput)) {
      if (k === "managerApproval" || !ALLOWED_TOP_LEVEL_SALE_FIELDS.has(k) || v === undefined) {
        continue;
      }
      if (k === "lines" && Array.isArray(v)) {
        sanitizedSaleInput.lines = v.map((l) => sanitizeSaleLineContract(l));
      } else if (k === "payment" && v && typeof v === "object") {
        sanitizedSaleInput.payment = sanitizePaymentLegContract(v);
      } else if (k === "payments" && Array.isArray(v)) {
        sanitizedSaleInput.payments = v.map((leg) => sanitizePaymentLegContract(leg));
      } else {
        sanitizedSaleInput[k] = structuredClone(v);
      }
    }
  }
  assertNoManagerApprovalLeak(sanitizedSaleInput, rawApproval);
  const semanticPayloadSha256 = computeSaleSemanticPayloadSha256(sanitizedSaleInput);
  return { sanitizedSaleInput, hadManagerApprovalAtSubmit, semanticPayloadSha256 };
}

interface EncryptedCommercialPreflightBodyV4 {
  __commercialBodyV4: 1;
  clientRequestId: string;
  total: string;
  saleInput: Record<string, unknown>;
}

interface SerializedPreflightCipherEnvelopeV4 {
  __preflightCipherV4: 1;
  status: "IN_FLIGHT" | "UNCONFIRMED_SERVER_OUTCOME" | "CLEARED";
  clientRequestId: string;
  tabId: number;
  branchId: number;
  shiftId: number;
  capturedByUserId: number;
  hadManagerApprovalAtSubmit: boolean;
  semanticPayloadSha256: string;
  ownerTabInstanceId: string;
  liveLeaseUntilMs: number;
  createdAtIso: string;
  revision: number;
  updatedAtMs: number;
  clearedAtMs?: number | null;
  failureReason?: string | null;
  ivHex?: string;
  dataHex?: string;
}

interface CrossTabPreflightLockLeaseV4 {
  ownerTabInstanceId: string;
  token: string;
  expiresAtMs: number;
}

function generateRandomHexId(byteLen = 16): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("WebCrypto getRandomValues is required for secure offline identifiers");
  }
  const buf = new Uint8Array(byteLen);
  globalThis.crypto.getRandomValues(buf);
  return bytesToHexLocal(buf);
}

let currentTabInstanceId = generateRandomHexId(16);
const seenTabIdsInProcess = new Set<string>([currentTabInstanceId]);
const crashedSimulatedTabIds = new Set<string>();
const activeInMemoryPreflightIds = new Set<string>();
const preflightKeyChains = new Map<string, Promise<unknown>>();
let liveLeaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function getTabInstanceId(): string {
  return currentTabInstanceId;
}

/** Test-only helper allowing multi-tab simulation inside single-process Vitest tests. */
export function setSimulatedTabInstanceIdForTest(tabInstanceId: string): void {
  if (tabInstanceId && tabInstanceId.trim()) {
    const id = tabInstanceId.trim();
    currentTabInstanceId = id;
    crashedSimulatedTabIds.delete(id);
    seenTabIdsInProcess.add(id);
  }
}

function ensureLiveLeaseHeartbeatLoop(): void {
  if (liveLeaseHeartbeatTimer || activeInMemoryPreflightIds.size === 0) return;
  liveLeaseHeartbeatTimer = setInterval(() => {
    if (activeInMemoryPreflightIds.size === 0) {
      if (liveLeaseHeartbeatTimer) {
        clearInterval(liveLeaseHeartbeatTimer);
        liveLeaseHeartbeatTimer = null;
      }
      return;
    }
    for (const reqId of Array.from(activeInMemoryPreflightIds)) {
      void renewLivePreflightIntentLease(reqId);
    }
  }, 4_000);
  const maybeTimer = liveLeaseHeartbeatTimer as unknown as { unref?: () => void };
  if (typeof maybeTimer?.unref === "function") {
    maybeTimer.unref();
  }
}

export function markPreflightIntentLiveInMemory(clientRequestId: string): void {
  if (!clientRequestId) return;
  activeInMemoryPreflightIds.add(clientRequestId);
  ensureLiveLeaseHeartbeatLoop();
  void renewLivePreflightIntentLease(clientRequestId);
}

export function unmarkPreflightIntentLiveInMemory(clientRequestId: string): void {
  if (!clientRequestId) return;
  activeInMemoryPreflightIds.delete(clientRequestId);
  if (activeInMemoryPreflightIds.size === 0 && liveLeaseHeartbeatTimer) {
    clearInterval(liveLeaseHeartbeatTimer);
    liveLeaseHeartbeatTimer = null;
  }
}

export function isPreflightIntentLiveInMemory(clientRequestId: string): boolean {
  return activeInMemoryPreflightIds.has(clientRequestId);
}

/**
 * Test-only helper simulating full browser process crash / hard restart:
 * wipes in-memory set, rotates to a fresh `currentTabInstanceId`, and marks prior crashed leases expired.
 */
export function simulateBrowserReloadResetInMemoryPreflightSet(): void {
  activeInMemoryPreflightIds.clear();
  if (liveLeaseHeartbeatTimer) {
    clearInterval(liveLeaseHeartbeatTimer);
    liveLeaseHeartbeatTimer = null;
  }
  for (const tabId of Array.from(seenTabIdsInProcess)) {
    crashedSimulatedTabIds.add(tabId);
  }
  seenTabIdsInProcess.clear();
  currentTabInstanceId = generateRandomHexId(16);
  seenTabIdsInProcess.add(currentTabInstanceId);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFallbackCrossTabLease(
  clientRequestId: string,
): Promise<() => Promise<void>> {
  const token = generateRandomHexId(12);
  const ttlMs = 5_000;
  const deadlineMs = Date.now() + 1_500;
  const idbKey = `${PREFLIGHT_LOCK_IDB_KEY_PREFIX}${clientRequestId}`;
  const lsKey = `${PREFLIGHT_LOCK_LS_KEY_PREFIX}${clientRequestId}`;

  while (Date.now() < deadlineMs) {
    const now = Date.now();
    // 1) Try serializable IndexedDB `rw` transaction lease first
    if (
      offlineDb.meta &&
      typeof offlineDb.transaction === "function" &&
      typeof offlineDb.meta.get === "function" &&
      typeof offlineDb.meta.put === "function"
    ) {
      try {
        let acquired = false;
        await offlineDb.transaction("rw", offlineDb.meta, async () => {
          const existingRow = await offlineDb.meta.get(idbKey);
          let existingLease: CrossTabPreflightLockLeaseV4 | null = null;
          if (existingRow?.value) {
            try {
              existingLease = JSON.parse(existingRow.value) as CrossTabPreflightLockLeaseV4;
            } catch {
              existingLease = null;
            }
          }
          if (
            existingLease &&
            existingLease.ownerTabInstanceId !== currentTabInstanceId &&
            existingLease.expiresAtMs > now
          ) {
            acquired = false;
            return;
          }
          const myLease: CrossTabPreflightLockLeaseV4 = {
            ownerTabInstanceId: currentTabInstanceId,
            token,
            expiresAtMs: now + ttlMs,
          };
          await offlineDb.meta.put({ key: idbKey, value: JSON.stringify(myLease) });
          acquired = true;
        });
        if (acquired) {
          return async () => {
            try {
              await offlineDb.transaction("rw", offlineDb.meta, async () => {
                const cur = await offlineDb.meta.get(idbKey);
                if (cur?.value) {
                  const parsed = JSON.parse(cur.value) as Partial<CrossTabPreflightLockLeaseV4>;
                  if (parsed.token === token) {
                    if (typeof offlineDb.meta.delete === "function") {
                      await offlineDb.meta.delete(idbKey);
                    } else {
                      await offlineDb.meta.put({ key: idbKey, value: "" });
                    }
                  }
                }
              });
            } catch {
              /* ignore release I/O error */
            }
          };
        }
        await sleepMs(25);
        continue;
      } catch {
        // IndexedDB I/O unavailable -> fall through to verified `localStorage` CAS lease
      }
    }

    // 2) Secondary cross-tab CAS lease in `localStorage` when IDB is unavailable
    if (typeof localStorage !== "undefined") {
      try {
        const rawCur = localStorage.getItem(lsKey);
        if (rawCur) {
          try {
            const parsed = JSON.parse(rawCur) as CrossTabPreflightLockLeaseV4;
            if (
              parsed &&
              parsed.ownerTabInstanceId !== currentTabInstanceId &&
              parsed.expiresAtMs > now
            ) {
              await sleepMs(25);
              continue;
            }
          } catch {
            /* overwrite corrupt lock entry */
          }
        }
        const candidate: CrossTabPreflightLockLeaseV4 = {
          ownerTabInstanceId: currentTabInstanceId,
          token,
          expiresAtMs: now + ttlMs,
        };
        localStorage.setItem(lsKey, JSON.stringify(candidate));
        await Promise.resolve();
        const verifyRaw = localStorage.getItem(lsKey);
        const verified = verifyRaw
          ? (JSON.parse(verifyRaw) as Partial<CrossTabPreflightLockLeaseV4>)
          : null;
        if (verified?.token === token) {
          return async () => {
            try {
              const cur = localStorage.getItem(lsKey);
              if (cur) {
                const p = JSON.parse(cur) as Partial<CrossTabPreflightLockLeaseV4>;
                if (p.token === token) {
                  localStorage.removeItem(lsKey);
                }
              }
            } catch {
              /* noop */
            }
          };
        }
      } catch {
        throw new PreflightCrossTabLockContentionError(
          "تعذّر تأمين قفل التزامن المحلي لنية البيع عند غياب Web Locks",
        );
      }
    } else {
      throw new PreflightCrossTabLockContentionError(
        "لا تتوفر آلية قفل مشتركة بين التبويبات لحماية نية البيع",
      );
    }
    await sleepMs(25);
  }
  throw new PreflightCrossTabLockContentionError(
    `قفل نية البيع (${clientRequestId}) محجوز حالياً من تبويب نشط آخر`,
  );
}

async function withPreflightIntentLock<T>(
  clientRequestId: string,
  task: () => Promise<T>,
): Promise<T> {
  const runInTabSerialized = () => {
    const prev = preflightKeyChains.get(clientRequestId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    preflightKeyChains.set(clientRequestId, settled);
    return next;
  };
  const locks = (
    globalThis as unknown as {
      navigator?: {
        locks?: {
          request?: <R>(name: string, cb: () => Promise<R>) => Promise<R>;
        };
      };
    }
  ).navigator?.locks;
  if (locks && typeof locks.request === "function") {
    return locks.request(`alroya-preflight-intent:${clientRequestId}`, runInTabSerialized);
  }
  return runInTabSerialized().then(
    async (res) => res,
    async (err) => {
      throw err;
    },
  );
}

async function withCrossTabPreflightLock<T>(
  clientRequestId: string,
  task: () => Promise<T>,
): Promise<T> {
  const locks = (
    globalThis as unknown as {
      navigator?: {
        locks?: {
          request?: <R>(name: string, cb: () => Promise<R>) => Promise<R>;
        };
      };
    }
  ).navigator?.locks;
  if (locks && typeof locks.request === "function") {
    return withPreflightIntentLock(clientRequestId, task);
  }
  return withPreflightIntentLock(clientRequestId, async () => {
    const release = await acquireFallbackCrossTabLease(clientRequestId);
    try {
      return await task();
    } finally {
      await release();
    }
  });
}

function statusPrecedence(s: PreflightSaleIntentV4["status"]): number {
  if (s === "CLEARED") return 3;
  if (s === "UNCONFIRMED_SERVER_OUTCOME") return 2;
  return 1;
}

function mergePreflightRecords(
  a: PreflightSaleIntentV4 | null,
  b: PreflightSaleIntentV4 | null,
): PreflightSaleIntentV4 | null {
  if (!a) return b;
  if (!b) return a;
  if (b.revision !== a.revision) {
    return b.revision > a.revision ? b : a;
  }
  const pa = statusPrecedence(a.status);
  const pb = statusPrecedence(b.status);
  if (pb !== pa) {
    return pb > pa ? b : a;
  }
  return (b.updatedAtMs ?? 0) >= (a.updatedAtMs ?? 0) ? b : a;
}

async function buildSerializedCipherEnvelope(
  record: PreflightSaleIntentV4,
): Promise<string | null> {
  assertNoManagerApprovalLeak(record.saleInput);
  if (record.status === "CLEARED") {
    const clearedEnv: SerializedPreflightCipherEnvelopeV4 = {
      __preflightCipherV4: 1,
      status: "CLEARED",
      clientRequestId: record.clientRequestId,
      tabId: record.tabId,
      branchId: record.branchId,
      shiftId: record.shiftId,
      capturedByUserId: record.capturedByUserId,
      hadManagerApprovalAtSubmit: false,
      semanticPayloadSha256: "",
      ownerTabInstanceId: record.ownerTabInstanceId ?? currentTabInstanceId,
      liveLeaseUntilMs: 0,
      createdAtIso: record.createdAtIso,
      revision: record.revision,
      updatedAtMs: record.updatedAtMs,
      clearedAtMs: record.clearedAtMs ?? record.updatedAtMs,
      failureReason: null,
    };
    return JSON.stringify(clearedEnv);
  }
  // Fail-closed WebCrypto policy: NEVER store commercial payload in plaintext in `localStorage` or `IndexedDB`!
  if (!globalThis.crypto?.subtle) {
    return null;
  }
  try {
    const aad = buildPreflightIntentAad(
      record.clientRequestId,
      record.capturedByUserId,
      record.branchId,
    );
    const body: EncryptedCommercialPreflightBodyV4 = {
      __commercialBodyV4: 1,
      clientRequestId: record.clientRequestId,
      total: record.total,
      saleInput: record.saleInput,
    };
    const enc = await encryptJson(body, aad);
    const cipherEnv: SerializedPreflightCipherEnvelopeV4 = {
      __preflightCipherV4: 1,
      status: record.status,
      clientRequestId: record.clientRequestId,
      tabId: record.tabId,
      branchId: record.branchId,
      shiftId: record.shiftId,
      capturedByUserId: record.capturedByUserId,
      hadManagerApprovalAtSubmit: record.hadManagerApprovalAtSubmit,
      semanticPayloadSha256: record.semanticPayloadSha256,
      ownerTabInstanceId: record.ownerTabInstanceId ?? currentTabInstanceId,
      liveLeaseUntilMs: Number(record.liveLeaseUntilMs ?? 0),
      createdAtIso: record.createdAtIso,
      revision: record.revision,
      updatedAtMs: record.updatedAtMs,
      clearedAtMs: null,
      failureReason: record.failureReason ?? null,
      ivHex: bytesToHexLocal(enc.iv),
      dataHex: bytesToHexLocal(enc.data),
    };
    return JSON.stringify(cipherEnv);
  } catch {
    return null;
  }
}

async function decodeSerializedCipherEnvelope(
  expectedClientRequestId: string,
  raw: string | null | undefined,
): Promise<PreflightSaleIntentV4 | null> {
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as Partial<SerializedPreflightCipherEnvelopeV4>;
    if (!env || env.__preflightCipherV4 !== 1 || env.clientRequestId !== expectedClientRequestId) {
      return null;
    }
    if (env.status === "CLEARED") {
      return {
        clientRequestId: expectedClientRequestId,
        tabId: Number(env.tabId ?? 0),
        branchId: Number(env.branchId ?? 0),
        shiftId: Number(env.shiftId ?? 0),
        capturedByUserId: Number(env.capturedByUserId ?? 0),
        total: "0",
        hadManagerApprovalAtSubmit: false,
        semanticPayloadSha256: "",
        saleInput: {},
        ownerTabInstanceId: String(env.ownerTabInstanceId ?? ""),
        liveLeaseUntilMs: 0,
        createdAtIso: String(env.createdAtIso ?? new Date(Number(env.updatedAtMs ?? Date.now())).toISOString()),
        updatedAtMs: Number(env.updatedAtMs ?? Date.now()),
        revision: Number(env.revision ?? 1),
        status: "CLEARED",
        clearedAtMs: Number(env.clearedAtMs ?? env.updatedAtMs ?? Date.now()),
        failureReason: null,
      };
    }
    if (!env.ivHex || !env.dataHex) {
      return null;
    }
    const iv = hexToBytesLocal(env.ivHex);
    const data = hexToBytesLocal(env.dataHex);
    if (!iv || iv.byteLength !== 12 || !data || data.byteLength === 0) {
      return null;
    }
    const aad = buildPreflightIntentAad(
      expectedClientRequestId,
      Number(env.capturedByUserId),
      Number(env.branchId),
    );
    try {
      const decoded = await decryptJson<EncryptedCommercialPreflightBodyV4>(
        { enc: true, v: 1, iv, data },
        aad,
      );
      if (
        !decoded ||
        decoded.__commercialBodyV4 !== 1 ||
        decoded.clientRequestId !== expectedClientRequestId
      ) {
        return null;
      }
      assertNoManagerApprovalLeak(decoded.saleInput);
      return {
        clientRequestId: expectedClientRequestId,
        tabId: Number(env.tabId ?? 1),
        branchId: Number(env.branchId),
        shiftId: Number(env.shiftId),
        capturedByUserId: Number(env.capturedByUserId),
        total: String(decoded.total ?? "0"),
        hadManagerApprovalAtSubmit: Boolean(env.hadManagerApprovalAtSubmit),
        semanticPayloadSha256: String(env.semanticPayloadSha256 ?? ""),
        saleInput: decoded.saleInput ?? {},
        ownerTabInstanceId: String(env.ownerTabInstanceId ?? ""),
        liveLeaseUntilMs: Number(env.liveLeaseUntilMs ?? 0),
        commercialPayloadUnavailable: false,
        createdAtIso: String(env.createdAtIso ?? new Date(Number(env.updatedAtMs ?? Date.now())).toISOString()),
        updatedAtMs: Number(env.updatedAtMs ?? Date.now()),
        revision: Number(env.revision ?? 1),
        status: env.status === "UNCONFIRMED_SERVER_OUTCOME" ? "UNCONFIRMED_SERVER_OUTCOME" : "IN_FLIGHT",
        clearedAtMs: null,
        failureReason: env.failureReason ?? null,
      };
    } catch {
      // If `offlineDb.keys` non-extractable CryptoKey is temporarily unreadable while `localStorage` cipher
      // survives, preserve non-commercial reconciliation identity (`clientRequestId`, `semanticPayloadSha256`)
      // fail-closed (`commercialPayloadUnavailable: true`) so the warning banner & server lookup STILL protect against duplicates!
      if (!globalThis.crypto?.subtle) {
        return null;
      }
      return {
        clientRequestId: expectedClientRequestId,
        tabId: Number(env.tabId ?? 1),
        branchId: Number(env.branchId),
        shiftId: Number(env.shiftId),
        capturedByUserId: Number(env.capturedByUserId),
        total: "0",
        hadManagerApprovalAtSubmit: Boolean(env.hadManagerApprovalAtSubmit),
        semanticPayloadSha256: String(env.semanticPayloadSha256 ?? ""),
        saleInput: {},
        ownerTabInstanceId: String(env.ownerTabInstanceId ?? ""),
        liveLeaseUntilMs: Number(env.liveLeaseUntilMs ?? 0),
        commercialPayloadUnavailable: true,
        createdAtIso: String(env.createdAtIso ?? new Date(Number(env.updatedAtMs ?? Date.now())).toISOString()),
        updatedAtMs: Number(env.updatedAtMs ?? Date.now()),
        revision: Number(env.revision ?? 1),
        status: env.status === "UNCONFIRMED_SERVER_OUTCOME" ? "UNCONFIRMED_SERVER_OUTCOME" : "IN_FLIGHT",
        clearedAtMs: null,
        failureReason: env.failureReason ?? "مفتاح فك تشفير تفاصيل السلة غير متاح مؤقتاً",
      };
    }
  } catch {
    return null;
  }
}

async function readSinglePreflightFromLocalStorage(
  clientRequestId: string,
): Promise<PreflightSaleIntentV4 | null> {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(`${PREFLIGHT_INTENT_LS_KEY_PREFIX}${clientRequestId}`);
    return await decodeSerializedCipherEnvelope(clientRequestId, raw);
  } catch {
    return null;
  }
}

function writeRawEnvelopeToLocalStorage(clientRequestId: string, serializedEnv: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const key = `${PREFLIGHT_INTENT_LS_KEY_PREFIX}${clientRequestId}`;
    localStorage.setItem(key, serializedEnv);
    const verifyRaw = localStorage.getItem(key);
    return typeof verifyRaw === "string" && verifyRaw.length > 0;
  } catch {
    return false;
  }
}

async function readSinglePreflightFromIdb(clientRequestId: string): Promise<PreflightSaleIntentV4 | null> {
  try {
    const key = `${PREFLIGHT_INTENT_IDB_KEY_PREFIX}${clientRequestId}`;
    let raw: string | null = null;
    if (offlineDb.meta && typeof offlineDb.meta.get === "function") {
      const row = await offlineDb.meta.get(key);
      raw = row?.value ?? null;
    } else {
      raw = await getMeta(key);
    }
    return await decodeSerializedCipherEnvelope(clientRequestId, raw);
  } catch {
    return null;
  }
}

async function writeRawEnvelopeToIdb(clientRequestId: string, serializedEnv: string): Promise<boolean> {
  try {
    const key = `${PREFLIGHT_INTENT_IDB_KEY_PREFIX}${clientRequestId}`;
    if (offlineDb.meta && typeof offlineDb.transaction === "function") {
      await offlineDb.transaction("rw", offlineDb.meta, async () => {
        await offlineDb.meta.put({ key, value: serializedEnv });
      });
    } else {
      await offlineDb.meta.put({ key, value: serializedEnv });
    }
    return true;
  } catch {
    return false;
  }
}

async function readMergedSinglePreflightIntent(
  clientRequestId: string,
): Promise<PreflightSaleIntentV4 | null> {
  const [lsRec, idbRec] = await Promise.all([
    readSinglePreflightFromLocalStorage(clientRequestId),
    readSinglePreflightFromIdb(clientRequestId),
  ]);
  return mergePreflightRecords(idbRec, lsRec);
}

async function persistSinglePreflightRecord(record: PreflightSaleIntentV4): Promise<boolean> {
  const serializedEnv = await buildSerializedCipherEnvelope(record);
  if (!serializedEnv) {
    return false;
  }
  const lsOk = writeRawEnvelopeToLocalStorage(record.clientRequestId, serializedEnv);
  const idbOk = await writeRawEnvelopeToIdb(record.clientRequestId, serializedEnv);
  return lsOk || idbOk;
}

export async function renewLivePreflightIntentLease(clientRequestId: string): Promise<boolean> {
  if (!clientRequestId || !activeInMemoryPreflightIds.has(clientRequestId)) return false;
  try {
    return await withCrossTabPreflightLock(clientRequestId, async () => {
      if (!activeInMemoryPreflightIds.has(clientRequestId)) return false;
      const cur = await readMergedSinglePreflightIntent(clientRequestId);
      if (!cur || cur.status !== "IN_FLIGHT") return false;
      const nowMs = Date.now();
      const renewed: PreflightSaleIntentV4 = {
        ...cur,
        ownerTabInstanceId: currentTabInstanceId,
        liveLeaseUntilMs: nowMs + PREFLIGHT_LIVE_LEASE_TTL_MS,
        updatedAtMs: nowMs,
        revision: cur.revision + 1,
      };
      return persistSinglePreflightRecord(renewed);
    });
  } catch {
    return false;
  }
}

export async function recordPreflightSaleIntent(input: {
  clientRequestId: string;
  tabId: number;
  branchId: number;
  shiftId: number;
  capturedByUserId: number;
  total: string;
  saleInput: Record<string, unknown>;
  receiptContext?: Record<string, unknown> | null;
}): Promise<boolean> {
  if (
    !input.clientRequestId ||
    !Number.isSafeInteger(input.capturedByUserId) ||
    input.capturedByUserId <= 0 ||
    !Number.isSafeInteger(input.branchId) ||
    input.branchId <= 0 ||
    !globalThis.crypto?.subtle
  ) {
    return false;
  }
  try {
    return await withCrossTabPreflightLock(input.clientRequestId, async () => {
      const existing = await readMergedSinglePreflightIntent(input.clientRequestId);
      const { sanitizedSaleInput, hadManagerApprovalAtSubmit, semanticPayloadSha256 } =
        await sanitizeSaleInputForPreflightPersistence(input.saleInput);
      const nowMs = Date.now();
      const record: PreflightSaleIntentV4 = {
        clientRequestId: input.clientRequestId,
        tabId: input.tabId,
        branchId: Number(input.branchId),
        shiftId: Number(input.shiftId),
        capturedByUserId: Number(input.capturedByUserId),
        total: input.total,
        hadManagerApprovalAtSubmit,
        semanticPayloadSha256,
        saleInput: sanitizedSaleInput,
        receiptContext: input.receiptContext ?? existing?.receiptContext ?? null,
        ownerTabInstanceId: currentTabInstanceId,
        liveLeaseUntilMs: nowMs + PREFLIGHT_LIVE_LEASE_TTL_MS,
        commercialPayloadUnavailable: false,
        createdAtIso: existing?.createdAtIso ?? new Date(nowMs).toISOString(),
        updatedAtMs: nowMs,
        revision: (existing?.revision ?? 0) + 1,
        status: "IN_FLIGHT",
        clearedAtMs: null,
        failureReason: null,
      };
      return persistSinglePreflightRecord(record);
    });
  } catch {
    return false;
  }
}

export async function markPreflightSaleIntentUnconfirmed(
  clientRequestId: string,
  failureReason: string,
): Promise<PreflightSaleIntentV4 | null> {
  if (!clientRequestId) return null;
  unmarkPreflightIntentLiveInMemory(clientRequestId);
  try {
    return await withCrossTabPreflightLock(clientRequestId, async () => {
      const cur = await readMergedSinglePreflightIntent(clientRequestId);
      if (!cur || cur.status === "CLEARED") return null;
      const nowMs = Date.now();
      const updated: PreflightSaleIntentV4 = {
        ...cur,
        ownerTabInstanceId: currentTabInstanceId,
        liveLeaseUntilMs: 0,
        updatedAtMs: nowMs,
        revision: cur.revision + 1,
        status: "UNCONFIRMED_SERVER_OUTCOME",
        failureReason,
      };
      const ok = await persistSinglePreflightRecord(updated);
      return ok ? updated : null;
    });
  } catch {
    return null;
  }
}

/**
 * Durable CLEARED tombstone across both stores: even if clearing succeeds in one store and fails
 * in the other, the higher-revision `CLEARED` tombstone prevents stale resurrection on merge!
 */
export async function clearPreflightSaleIntent(clientRequestId: string): Promise<boolean> {
  if (!clientRequestId) return false;
  unmarkPreflightIntentLiveInMemory(clientRequestId);
  try {
    return await withCrossTabPreflightLock(clientRequestId, async () => {
      const cur = await readMergedSinglePreflightIntent(clientRequestId);
      if (!cur) return true;
      const nowMs = Date.now();
      const tombstone: PreflightSaleIntentV4 = {
        clientRequestId,
        tabId: cur.tabId,
        branchId: cur.branchId,
        shiftId: cur.shiftId,
        capturedByUserId: cur.capturedByUserId,
        total: "0",
        hadManagerApprovalAtSubmit: false,
        semanticPayloadSha256: "",
        saleInput: {},
        ownerTabInstanceId: currentTabInstanceId,
        liveLeaseUntilMs: 0,
        createdAtIso: cur.createdAtIso,
        updatedAtMs: nowMs,
        revision: cur.revision + 1,
        status: "CLEARED",
        clearedAtMs: nowMs,
        failureReason: null,
      };
      return persistSinglePreflightRecord(tombstone);
    });
  } catch {
    return false;
  }
}

async function discoverAllPreflightClientRequestIds(): Promise<string[]> {
  const ids = new Set<string>();
  try {
    if (typeof localStorage !== "undefined") {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFLIGHT_INTENT_LS_KEY_PREFIX)) {
          ids.add(k.slice(PREFLIGHT_INTENT_LS_KEY_PREFIX.length));
        }
      }
    }
  } catch {
    /* ignore localStorage enumeration errors */
  }
  try {
    if (offlineDb.meta && typeof offlineDb.meta.toArray === "function") {
      const rows = await offlineDb.meta.toArray();
      for (const row of rows) {
        if (row?.key && row.key.startsWith(PREFLIGHT_INTENT_IDB_KEY_PREFIX)) {
          ids.add(row.key.slice(PREFLIGHT_INTENT_IDB_KEY_PREFIX.length));
        }
      }
    }
  } catch {
    /* ignore IndexedDB enumeration errors */
  }
  return Array.from(ids);
}

export async function isPreflightIntentCleared(clientRequestId: string): Promise<boolean> {
  if (!clientRequestId) return false;
  try {
    const rec = await readMergedSinglePreflightIntent(clientRequestId);
    return rec?.status === "CLEARED";
  } catch {
    return false;
  }
}

async function purgeExpiredPreflightTombstoneFromStores(clientRequestId: string): Promise<void> {
  if (!clientRequestId) return;
  try {
    await withCrossTabPreflightLock(clientRequestId, async () => {
      const [lsRec, idbRec] = await Promise.all([
        readSinglePreflightFromLocalStorage(clientRequestId),
        readSinglePreflightFromIdb(clientRequestId),
      ]);
      const merged = mergePreflightRecords(idbRec, lsRec);
      if (!merged || merged.status !== "CLEARED") return;

      const lsKey = `${PREFLIGHT_INTENT_LS_KEY_PREFIX}${clientRequestId}`;
      const idbKey = `${PREFLIGHT_INTENT_IDB_KEY_PREFIX}${clientRequestId}`;

      const removeLs = (): boolean => {
        if (typeof localStorage === "undefined") return true;
        try {
          localStorage.removeItem(lsKey);
          return localStorage.getItem(lsKey) === null;
        } catch {
          return false;
        }
      };

      const removeIdb = async (): Promise<boolean> => {
        if (!offlineDb.meta || typeof offlineDb.meta.delete !== "function") return false;
        try {
          await offlineDb.meta.delete(idbKey);
          if (typeof offlineDb.meta.get === "function") {
            const check = await offlineDb.meta.get(idbKey);
            return check === undefined;
          }
          return true;
        } catch {
          return false;
        }
      };

      // Always purge any stale non-CLEARED replica first and retain the surviving CLEARED
      // tombstone whenever cleanup of the counterpart store fails (prevents stale resurrection).
      if (lsRec && lsRec.status !== "CLEARED" && idbRec?.status === "CLEARED") {
        if (!removeLs()) return;
        await removeIdb();
      } else {
        if (!(await removeIdb())) return;
        removeLs();
      }
    });
  } catch {
    /* retain surviving tombstone if cross-tab lock or store check fails */
  }
}

export async function listRecoverablePreflightSaleIntents(opts?: {
  branchId?: number | null;
  viewerUserId?: number | null;
  viewerCanAdminReconcile?: boolean;
}): Promise<RecoverablePreflightIntentsResult> {
  const ids = await discoverAllPreflightClientRequestIds();
  const intents: PreflightSaleIntentV4[] = [];
  let foreignOwnerPendingCount = 0;
  let activeInOtherTabCount = 0;
  let earliestOtherTabLeaseExpiryMs: number | null = null;
  const nowMs = Date.now();

  for (const id of ids) {
    const rec = await readMergedSinglePreflightIntent(id);
    if (!rec || rec.status === "CLEARED") {
      if (rec?.status === "CLEARED") {
        const clearedTs = Number(rec.clearedAtMs ?? rec.updatedAtMs ?? 0);
        if (clearedTs > 0 && nowMs - clearedTs > PREFLIGHT_TOMBSTONE_RETENTION_MS) {
          await purgeExpiredPreflightTombstoneFromStores(id);
        }
      }
      continue;
    }
    try {
      const existingOutbox = await offlineDb.outbox?.get?.(id);
      if (existingOutbox) {
        // Offline outbox owns this clientRequestId now — never expose preflight fencing for it.
        continue;
      }
    } catch {
      /* ignore outbox read failures during preflight listing */
    }
    if (opts?.branchId != null && Number(rec.branchId) !== Number(opts.branchId)) {
      continue;
    }
    if (rec.status === "IN_FLIGHT") {
      if (activeInMemoryPreflightIds.has(rec.clientRequestId)) {
        // Actively sending in THIS tab right now -> not orphaned
        continue;
      }
      const ownerId = String(rec.ownerTabInstanceId ?? "");
      const leaseUntilMs = Number(rec.liveLeaseUntilMs ?? 0);
      const leaseValid =
        leaseUntilMs > nowMs && !crashedSimulatedTabIds.has(ownerId);
      if (leaseValid && ownerId && ownerId !== currentTabInstanceId) {
        // Actively sending in ANOTHER live tab -> NEVER hijack or replay from Tab 2!
        activeInOtherTabCount++;
        if (earliestOtherTabLeaseExpiryMs == null || leaseUntilMs < earliestOtherTabLeaseExpiryMs) {
          earliestOtherTabLeaseExpiryMs = leaseUntilMs;
        }
        continue;
      }
    } else if (rec.status !== "UNCONFIRMED_SERVER_OUTCOME") {
      continue;
    }
    if (opts?.viewerUserId != null) {
      const isOwner = Number(rec.capturedByUserId) === Number(opts.viewerUserId);
      if (!isOwner && !opts.viewerCanAdminReconcile) {
        foreignOwnerPendingCount++;
        continue;
      }
    }
    intents.push(rec);
  }
  intents.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
  return {
    intents,
    foreignOwnerPendingCount,
    activeInOtherTabCount,
    earliestOtherTabLeaseExpiryMs,
  };
}

export async function listUnconfirmedPreflightSaleIntents(
  branchId?: number | null,
  viewerUserId?: number | null,
  viewerCanAdminReconcile = false,
): Promise<PreflightSaleIntentV4[]> {
  const res = await listRecoverablePreflightSaleIntents({
    branchId,
    viewerUserId,
    viewerCanAdminReconcile,
  });
  return res.intents;
}

export async function auditPreUpgradeOfflineOutbox(): Promise<PreUpgradeOutboxAuditReport> {
  const all = await offlineDb.outbox.toArray();
  const unsentLegacyIds: string[] = [];
  let unsentVerifiedV4Count = 0;
  let parkedCount = 0;
  let sentCount = 0;
  for (const row of all) {
    if (row.status === "SENT") {
      sentCount++;
      continue;
    }
    if (row.status === "PARKED") {
      parkedCount++;
      continue;
    }
    const kind = row.kind ?? "SALE";
    if (
      kind === "SALE" &&
      (!row.captureProof || !row.grantToken || !row.keyId || !row.grantId)
    ) {
      unsentLegacyIds.push(row.clientRequestId);
    } else {
      unsentVerifiedV4Count++;
    }
  }
  return {
    totalRows: all.length,
    unsentLegacyWithoutProofCount: unsentLegacyIds.length,
    unsentLegacyClientRequestIds: unsentLegacyIds,
    unsentVerifiedV4Count,
    parkedCount,
    sentCount,
    safeForCleanUpgradeWithoutQuarantine: unsentLegacyIds.length === 0,
  };
}
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const SERVER_ERROR_MAX_ATTEMPTS = 5;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SENDING_LEASE_MS = 5 * 60 * 1000;

export interface OfflineSaleLine {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride: string;
  discountPercent?: string;
  discountAmount?: string;
  promotionId?: number;
  promotionDiscount?: string;
  cashierDiscountAmount?: string;
  recipeSelections?: RecipeLineSelection[];
}

export interface OfflineSalePayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  lines: OfflineSaleLine[];
  /** خصم على رأس الفاتورة (مبلغ، عملة الفرع). الخادم يُطبّقه بعد مجموع الأسطر وقبل الضريبة. */
  invoiceDiscount?: string;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  cashRoundIQD?: boolean;
  notes?: string;
  salesRepId?: number;
  attribution?: { repId?: number | null; mode?: "DIRECT" | "SPLIT" | "POOL" };
}

/** خدمات الطباعة: سعرٌ يدويّ لكل سطر (طبيعة الشاشة)، بلا خصم سطر. */
export interface OfflinePrintSalePayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  contactName?: string;
  contactPhone?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  lines: Array<{ variantId: number; productUnitId: number; quantity: string; unitPriceOverride: string; recipeSelections?: RecipeLineSelection[] }>;
  invoiceDiscount?: string;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  cashRoundIQD?: boolean;
  notes?: string;
}

/** سلّة الاستقبال: بضاعةٌ جاهزة و/أو خدمات طباعة في معاملةٍ واحدة. **بلا أوامر شغل** —
 *  ترقيمها وإسنادها وصورها خادميّة، فلا تُلتقَط أصلاً (الشاشة ترفض قبل الوصول إلى هنا). */
export interface OfflineReceptionPayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  contactName?: string;
  contactPhone?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  paymentMethod: "CASH";
  paidAmount: string;
  regularSale?: { lines: OfflineSaleLine[]; amount: string; invoiceDiscount?: string } | null;
  printSale?: { lines: Array<{ variantId: number; productUnitId: number; quantity: string; unitPriceOverride: string; recipeSelections?: RecipeLineSelection[] }>; amount: string; invoiceDiscount?: string } | null;
  clientRequestId: string;
}

/**
 * مرتجعُ بيعٍ نقديّ التُقط دون اتصال (١/٩/٢٦). **الحمولةُ الوحيدة التي تُخرج نقداً** من
 * الطابور، ولذلك تحمل سبباً إلزامياً ومصيرَ البضاعة صريحاً — لا يقع ديناران بلا مستند.
 * ⚠️ سقفُ الاسترداد لا يُقيَّم على الجهاز (يحتاج تاريخ قبضِ الفاتورة كاملاً)؛ يُقيَّمه الخادم
 * عند الترحيل، والرفضُ يُعلَّق في طابور الاسترداد بقناة RETURN لمراجعة المدير.
 */
export interface OfflineReturnPayload {
  branchId: number;
  shiftId: number | null;
  invoiceId: number;
  lines: Array<{ invoiceItemId: number; baseQuantity: number }>;
  refund: { amount: string; method: "CASH"; shiftId?: number | null };
  restock: boolean;
  reason: string;
  clientRequestId: string;
}

export type OfflinePayload =
  | OfflineSalePayload
  | OfflinePrintSalePayload
  | OfflineReceptionPayload
  | OfflineReturnPayload;

// ── البيع الأوفلايني: **مفعَّل تلقائياً** على كل جهاز (قرار مالك ١٦/٨/٢٦) ──
//
// كان افتراضه معطَّلاً ويلزمه تفعيلٌ يدويّ لكل جهاز (بوّابة تجربة ش٥). النتيجة العملية:
// كاشيرٌ ينقطع عنه الإنترنت فلا يستطيع البيع أصلاً — لأنّ أحداً لم يفتح إعدادات جهازه سلفاً.
// وهذا يناقض غرض المنظومة: الالتقاط يجب أن يشتغل **لحظة الانقطاع بلا تدخّل بشريّ**.
//
// الآن: مفعَّلٌ ما لم يُعطَّل صراحةً ("0") — أي المفتاح صار **استثناءً** لا شرطاً، ويبقى
// متاحاً لاستبعاد جهازٍ بعينه (حاسوب إداريّ مثلاً).
//
// ⚠️ ما لم يتغيّر — وهي حرّاس السلامة الحقيقية، تبقى نافذةً كلّها:
//   • الأسعار المحلية أحدث من ٤٨ ساعة (assertCanCapture) وإلّا لا التقاط.
//   • سقف قيمة الطابور.
//   • نقديّ كامل فقط: لا آجل ولا بطاقة ولا بيع رقميّ.
//   • الالتقاط لا يحدث إلّا عند فشل النقل فعلياً — لا «وضع أوفلاين» اختياريّ.
// ويبوّب هذا العَلَم **الكتابة** وحدها؛ القراءة (تصفّح/مسح/سعر) كانت وتبقى دائمة.

const OFFLINE_SALE_FLAG_KEY = "offlineSaleEnabled";

export async function isOfflineSaleEnabled(): Promise<boolean> {
  // الغياب = مفعَّل. لا يُعطَّل إلّا بقيمة "0" صريحة كتبها مديرٌ من إعدادات الجهاز.
  return (await getMeta(OFFLINE_SALE_FLAG_KEY)) !== "0";
}

export async function setOfflineSaleEnabled(enabled: boolean): Promise<void> {
  await setMeta(OFFLINE_SALE_FLAG_KEY, enabled ? "1" : "0");
  notifyOutboxChanged();
}

// ── معرّف الجهاز + الترقيم المؤقّت ──────────────────────────────────────────

const DEVICE_CODE_KEY = "deviceCode";
const RECEIPT_SEQ_KEY = "offlineReceiptSeq";
const DEVICE_CODE_BYTES = 8;
const LEGACY_SHORT_HEX_DEVICE_RE = /^[0-9a-f]{4,8}$/i;
const UPGRADED_DEVICE_CODE_RE =
  /^(?:[0-9a-f]{16}|[0-9a-f]{4,8}-[0-9a-f]{12}|[A-Za-z0-9_-]{9,24})$/i;
const VALID_STORED_SEQ_RE = /^[1-9]\d*$/;

function generateRandomHexBytes(byteCount: number): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new OfflineCounterCorruptError(
      "OFFLINE_CSPRNG_UNAVAILABLE: WebCrypto getRandomValues is required to generate deviceCode",
    );
  }
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateHighEntropyDeviceCode(): string {
  return generateRandomHexBytes(DEVICE_CODE_BYTES);
}

let inProcessReceiptSeqChain: Promise<unknown> = Promise.resolve();

async function withReceiptSequenceLock<T>(task: () => Promise<T>): Promise<T> {
  const runSerialized = () => {
    const next = inProcessReceiptSeqChain.then(task, task);
    inProcessReceiptSeqChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const locks = (
    globalThis as unknown as {
      navigator?: {
        locks?: {
          request?: <R>(
            name: string,
            cb: () => Promise<R>,
          ) => Promise<R>;
        };
      };
    }
  ).navigator?.locks;
  if (locks && typeof locks.request === "function") {
    return locks.request("alroya-offline-receipt-seq", runSerialized);
  }
  return runSerialized();
}

async function resolveOrMigrateDeviceCodeInMetaStore(): Promise<string> {
  if (offlineDb.meta && typeof offlineDb.meta.get === "function") {
    const existingRow = await offlineDb.meta.get(DEVICE_CODE_KEY);
    if (existingRow === undefined) {
      const fresh = generateHighEntropyDeviceCode();
      await offlineDb.meta.put({ key: DEVICE_CODE_KEY, value: fresh });
      return fresh;
    }
    const raw = existingRow.value;
    if (typeof raw !== "string") {
      throw new OfflineCounterCorruptError(
        "OFFLINE_DEVICE_CODE_CORRUPTED: stored meta.deviceCode is not a string",
      );
    }
    if (LEGACY_SHORT_HEX_DEVICE_RE.test(raw)) {
      const upgraded = `${raw.toLowerCase()}-${generateRandomHexBytes(6)}`;
      await offlineDb.meta.put({ key: LEGACY_DEVICE_CODE_META_KEY, value: raw });
      await offlineDb.meta.put({ key: DEVICE_CODE_KEY, value: upgraded });
      return upgraded;
    }
    if (!UPGRADED_DEVICE_CODE_RE.test(raw)) {
      throw new OfflineCounterCorruptError(
        "OFFLINE_DEVICE_CODE_CORRUPTED: stored meta.deviceCode is malformed",
      );
    }
    return raw;
  }

  const existing = await getMeta(DEVICE_CODE_KEY);
  if (existing !== null) {
    if (LEGACY_SHORT_HEX_DEVICE_RE.test(existing)) {
      const upgraded = `${existing.toLowerCase()}-${generateRandomHexBytes(6)}`;
      await setMeta(LEGACY_DEVICE_CODE_META_KEY, existing);
      await setMeta(DEVICE_CODE_KEY, upgraded);
      return upgraded;
    }
    if (!UPGRADED_DEVICE_CODE_RE.test(existing)) {
      throw new OfflineCounterCorruptError(
        "OFFLINE_DEVICE_CODE_CORRUPTED: invalid stored deviceCode",
      );
    }
    return existing;
  }
  const code = generateHighEntropyDeviceCode();
  await setMeta(DEVICE_CODE_KEY, code);
  return code;
}

export async function getDeviceCode(): Promise<string> {
  return withReceiptSequenceLock(async () => {
    if (offlineDb.meta && typeof offlineDb.transaction === "function") {
      return offlineDb.transaction("rw", offlineDb.meta, async () =>
        resolveOrMigrateDeviceCodeInMetaStore(),
      );
    }
    return resolveOrMigrateDeviceCodeInMetaStore();
  });
}

export async function allocateOfflineReceiptNumber(branchId: number): Promise<string> {
  if (!Number.isSafeInteger(branchId) || branchId <= 0) {
    throw new OfflineCounterCorruptError(`OFFLINE_BRANCH_ID_INVALID: ${String(branchId)}`);
  }
  return withReceiptSequenceLock(async () => {
    return offlineDb.transaction("rw", offlineDb.meta, async () => {
      const device = await resolveOrMigrateDeviceCodeInMetaStore();

      const existingSeqRow = await offlineDb.meta.get(RECEIPT_SEQ_KEY);
      let prevSeq = 0;
      if (existingSeqRow !== undefined) {
        const raw = existingSeqRow.value;
        if (typeof raw !== "string" || !VALID_STORED_SEQ_RE.test(raw)) {
          throw new OfflineCounterCorruptError(
            `OFFLINE_RECEIPT_SEQ_CORRUPTED: refusing to reset corrupt counter (${String(raw)})`,
          );
        }
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed >= Number.MAX_SAFE_INTEGER) {
          throw new OfflineCounterCorruptError(
            `OFFLINE_RECEIPT_SEQ_CORRUPTED: unsafe sequence integer (${raw})`,
          );
        }
        prevSeq = parsed;
      }
      const seq = prevSeq + 1;
      const formatted = `OFF-${branchId}-${device}-${seq}`;
      if (formatted.length > 40) {
        throw new OfflineCounterCorruptError(
          `OFFLINE_RECEIPT_NUMBER_OVERFLOW: length ${formatted.length} exceeds varchar(40)`,
        );
      }
      await offlineDb.meta.put({ key: RECEIPT_SEQ_KEY, value: String(seq) });
      return formatted;
    });
  });
}

// ── إشعارات تغيّر الطابور (لواجهة الشارة/الدرج) ─────────────────────────────

type OutboxListener = () => void;
const listeners = new Set<OutboxListener>();
export function subscribeOutbox(cb: OutboxListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function notifyOutboxChanged() {
  listeners.forEach((cb) => cb());
}

// ── صمّاما الأمان ────────────────────────────────────────────────────────────

function validatedTotal(value: string | number, allowZero = false) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Invalid offline total");
  }
  const format = allowZero ? /^\d+(?:\.\d+)?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (typeof value === "string" && !format.test(value)) {
    throw new Error("Invalid offline total");
  }
  const total = D(value);
  if (!total.isFinite() || total.lt(0) || (!allowZero && total.isZero())) {
    throw new Error("Invalid offline total");
  }
  if (!allowZero && total.decimalPlaces() > 2) throw new Error("Invalid offline total precision");
  return total;
}

async function unresolvedIncomingTotal() {
  const items = await offlineDb.outbox
    .where("status")
    .anyOf("QUEUED", "SENDING", "PARKED")
    .toArray();
  // RETURN never releases sale capacity; a missing legacy kind means SALE.
  return items.reduce(
    (sum, item) => item.kind === "RETURN"
      ? sum
      // Older capture allowed zero (discounts/cash rounding). Preserve it without blocking sales.
      : sum.plus(validatedTotal(item.total, true)),
    D(0),
  );
}

export async function queuedTotalIQD(): Promise<number> {
  // Preserve the display API; admission keeps Decimal throughout. Corrupt exposure fails closed.
  try {
    return (await unresolvedIncomingTotal()).toNumber();
  } catch {
    return Infinity;
  }
}

function isCatalogFresh(lastSync: string | null): boolean {
  if (!lastSync) return false;
  const age = Date.now() - new Date(lastSync).getTime();
  return Number.isFinite(age) && age >= 0 && age <= OFFLINE_CACHE_MAX_AGE_MS;
}

/** بوّابة قبول بيع أوفلايني جديد (v4 fail-closed) — تفحص الأسعار وسقف الطابور ولقطة الصلاحيات المشفّرة ومنحة الوردية قبل حجز أي إيصال. */
export async function assertCanCapture(
  saleTotalIQD: number,
  kind: OfflineOutboxKind = "SALE",
  captureContext?: CaptureGrantCheckContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const total = validatedTotal(saleTotalIQD);
    const lastSync = await getLastSyncAt();
    if (!isCatalogFresh(lastSync)) {
      return {
        ok: false,
        reason: "الأسعار المحلية أقدم من ٤٨ ساعة — البيع الأوفلايني متوقف حتى مزامنةٍ ناجحة (القراءة والاستعلام متاحان)",
      };
    }
    const queued = kind === "RETURN" ? D(0) : await unresolvedIncomingTotal();
    if (kind !== "RETURN" && queued.plus(total).gt(OFFLINE_QUEUE_CAP_IQD)) {
      return {
        ok: false,
        reason: `بلغ طابور المزامنة سقفه (${OFFLINE_QUEUE_CAP_IQD.toLocaleString("en")} د.ع) — أعد الاتصال لتفريغه قبل قبول مبيعات جديدة`,
      };
    }
    if (kind === "SALE" && captureContext !== undefined) {
      const profile = captureContext.capturedByUserId
        ? null
        : await getOfflineProfile();
      const effectiveUserId = Number(
        captureContext.capturedByUserId ?? profile?.userId ?? 0,
      );
      const rawBranchId = captureContext.branchId;
      if (
        rawBranchId == null ||
        !Number.isInteger(Number(rawBranchId)) ||
        Number(rawBranchId) <= 0
      ) {
        return {
          ok: false,
          reason:
            "معرّف الفرع مفقود في سياق البيع الأوفلايني — اختر فرعاً صالحاً قبل حفظ العملية",
        };
      }
      const effectiveBranchId = Number(rawBranchId);
      const effectiveShiftId = Number(captureContext.shiftId ?? 0);
      if (captureContext.enforceOfflinePermPolicy) {
        const permSnap = await resolveOfflinePermSnapshot(
          effectiveUserId,
          effectiveBranchId,
        );
        if (!permSnap || !permSnap.canCreateRetailSale) {
          return { ok: false, reason: PERM_DENIED_OFFLINE_MESSAGE };
        }
      }
      const grantCheck = await resolveShiftCaptureGrantForCapture({
        userId: effectiveUserId,
        branchId: effectiveBranchId,
        shiftId: effectiveShiftId,
      });
      if (!grantCheck.ok) {
        return { ok: false, reason: grantCheck.reason };
      }
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: "تعذّر التحقق من قيمة طابور المزامنة — تحقق من المبلغ والتخزين المحلي قبل قبول مبيعات جديدة",
    };
  }
}

// ── الالتقاط ────────────────────────────────────────────────────────────────

export async function enqueueOfflineItem(args: {
  kind: OfflineOutboxKind;
  payload: OfflinePayload;
  offlineReceiptNumber: string;
  total: string;
  capturedByUserId?: number;
}): Promise<boolean> {
  try {
    const total = validatedTotal(args.total);
    const profile = args.capturedByUserId ? null : await getOfflineProfile();
    const capturedByUserId = Number(args.capturedByUserId ?? profile?.userId ?? 0);
    if (!Number.isInteger(capturedByUserId) || capturedByUserId <= 0) return false;
    const capturedAt = new Date().toISOString();
    const capturedShiftId =
      args.payload.shiftId != null ? Number(args.payload.shiftId) : null;
    let captureProof: string | null = null;
    let keyId: string | null = null;
    let grantId: string | null = null;
    let grantIssuedAtMs: number | null = null;
    let grantExpiresAtMs: number | null = null;
    let grantToken: string | null = null;
    if (capturedShiftId != null && capturedShiftId > 0) {
      const grantRes = await resolveShiftCaptureGrantForCapture({
        userId: capturedByUserId,
        branchId: Number(args.payload.branchId),
        shiftId: capturedShiftId,
      });
      if (grantRes.ok) {
        keyId = grantRes.grant.keyId;
        grantId = grantRes.grant.grantId;
        grantIssuedAtMs = grantRes.grant.issuedAtServerMs;
        grantExpiresAtMs = grantRes.grant.expiresAtServerMs;
        grantToken = grantRes.grant.grantToken;
        captureProof = await computeOfflineCaptureProofHex(
          grantRes.grant.captureKeyHex,
          {
            kind: args.kind,
            keyId,
            grantId,
            grantIssuedAtMs,
            grantExpiresAtMs,
            grantToken,
            clientRequestId: args.payload.clientRequestId,
            offlineReceiptNumber: args.offlineReceiptNumber,
            capturedAt,
            branchId: Number(args.payload.branchId),
            capturedShiftId,
            capturedByUserId,
            payload: args.payload,
          },
        );
      }
    }
    if (
      args.kind === "SALE" &&
      (!captureProof || !/^[0-9a-f]{64}$/i.test(captureProof) || !grantToken || !keyId || !grantId)
    ) {
      return false;
    }
    const authenticatedEnvelopePlaintext = {
      __outboxBoundV4: 1 as const,
      payload: args.payload,
      binding: {
        clientRequestId: args.payload.clientRequestId,
        kind: args.kind,
        capturedByUserId,
        capturedShiftId,
        branchId: Number(args.payload.branchId),
        offlineReceiptNumber: args.offlineReceiptNumber,
        capturedAt,
        captureProof,
        keyId,
        grantId,
        grantIssuedAtMs,
        grantExpiresAtMs,
        grantToken,
      },
    };
    const itemAad = buildOutboxItemAad({
      clientRequestId: args.payload.clientRequestId,
      kind: args.kind,
      capturedByUserId,
      branchId: Number(args.payload.branchId),
      capturedShiftId,
    });
    const item: OfflineOutboxItem = {
      clientRequestId: args.payload.clientRequestId,
      kind: args.kind,
      payload: await encryptJson(authenticatedEnvelopePlaintext, itemAad),
      offlineReceiptNumber: args.offlineReceiptNumber,
      capturedAt,
      capturedByUserId,
      ...(capturedShiftId != null ? { capturedShiftId } : {}),
      ...(captureProof != null ? { captureProof } : {}),
      ...(keyId != null ? { keyId } : {}),
      ...(grantId != null ? { grantId } : {}),
      ...(grantIssuedAtMs != null ? { grantIssuedAtMs } : {}),
      ...(grantExpiresAtMs != null ? { grantExpiresAtMs } : {}),
      ...(grantToken != null ? { grantToken } : {}),
      shiftId: args.payload.shiftId,
      branchId: args.payload.branchId,
      status: "QUEUED",
      attempts: 0,
      lastError: null,
      total: args.total,
    };
    // WebCrypto must finish before opening IndexedDB's transaction (otherwise it auto-commits).
    const lastSync = args.kind === "RETURN" ? null : await getLastSyncAt();
    const saved = await offlineDb.transaction("rw", offlineDb.outbox, async () => {
      // An existing command owns its key forever, including SENT/PARKED and active leases.
      if (await offlineDb.outbox.get(item.clientRequestId)) return false;
      if (args.kind !== "RETURN") {
        if (!isCatalogFresh(lastSync)) return false;
        if ((await unresolvedIncomingTotal()).plus(total).gt(OFFLINE_QUEUE_CAP_IQD)) return false;
      }
      await offlineDb.outbox.add(item);
      return true;
    });
    if (!saved) return false;
    // Clear any matching preflight intent immediately once the outbox owns this clientRequestId
    // so slow receipt printing or another tab cannot accidentally fence it on the server.
    void clearPreflightSaleIntent(item.clientRequestId);
    notifyOutboxChanged();
    return true;
  } catch {
    // حصة ممتلئة/وضع خاص — الواجهة تمنع تسليم البضاعة بدل الانفجار.
    return false;
  }
}

/** التقاطُ مرتجعٍ نقديّ (kind = RETURN) — النقدُ خرج فعلاً، فالالتقاط أصدق من الرفض. */
export async function enqueueOfflineReturn(args: {
  payload: OfflineReturnPayload;
  offlineReceiptNumber: string;
  total: string;
  capturedByUserId?: number;
}): Promise<boolean> {
  return enqueueOfflineItem({ kind: "RETURN", ...args });
}

/** غلاف توافقٍ رجعيّ لكاشير التجزئة (kind = SALE) — المستدعي الأقدم يبقى بلا تعديل. */
export async function enqueueOfflineSale(args: {
  payload: OfflineSalePayload;
  offlineReceiptNumber: string;
  total: string;
  capturedByUserId?: number;
}): Promise<boolean> {
  return enqueueOfflineItem({ kind: "SALE", ...args });
}

interface BoundOutboxPlaintextV4 {
  __outboxBoundV4: 1;
  payload: OfflinePayload;
  binding: {
    clientRequestId: string;
    kind: OfflineOutboxKind;
    capturedByUserId: number;
    capturedShiftId: number | null;
    branchId: number;
    offlineReceiptNumber: string;
    capturedAt: string;
    captureProof: string | null;
    keyId: string | null;
    grantId: string | null;
    grantIssuedAtMs: number | null;
    grantExpiresAtMs: number | null;
    grantToken: string | null;
  };
}

function isBoundOutboxPlaintextV4(v: unknown): v is BoundOutboxPlaintextV4 {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __outboxBoundV4?: unknown }).__outboxBoundV4 === 1 &&
    typeof (v as { binding?: unknown }).binding === "object" &&
    (v as { binding?: unknown }).binding !== null
  );
}

export async function readItemPayload(item: OfflineOutboxItem): Promise<OfflinePayload> {
  if (isEncryptedEnvelope(item.payload)) {
    const wasLegacyZeroIv = isLegacyZeroIvEnvelope(item.payload);
    let decoded: OfflinePayload | BoundOutboxPlaintextV4;
    if (wasLegacyZeroIv) {
      decoded = await decryptJson<OfflinePayload>(item.payload);
      try {
        const migrated = await encryptJson(decoded);
        if (!isLegacyZeroIvEnvelope(migrated)) {
          await offlineDb.outbox.update(item.clientRequestId, { payload: migrated });
          item.payload = migrated;
        }
      } catch {
        /* keep decoded legacy payload */
      }
      return decoded as OfflinePayload;
    }

    const itemShift = item.shiftId != null ? Number(item.shiftId) : null;
    const itemCapturedShift =
      item.capturedShiftId !== undefined
        ? (item.capturedShiftId != null ? Number(item.capturedShiftId) : null)
        : itemShift;
    const candidateAad = Number.isInteger(item.capturedByUserId)
      ? buildOutboxItemAad({
          clientRequestId: item.clientRequestId,
          kind: item.kind ?? "SALE",
          capturedByUserId: Number(item.capturedByUserId),
          branchId: Number(item.branchId),
          capturedShiftId: itemCapturedShift,
        })
      : undefined;

    try {
      decoded = candidateAad
        ? await decryptJson<OfflinePayload | BoundOutboxPlaintextV4>(item.payload, candidateAad)
        : await decryptJson<OfflinePayload | BoundOutboxPlaintextV4>(item.payload);
    } catch (aadErr) {
      // Backward compatibility for pre-v4 encrypted envelopes encrypted without AAD
      // (which carry NO v4 `grantToken` / `keyId`). Any row claiming v4 fields MUST pass AAD!
      if (item.grantToken != null || item.keyId != null || item.captureProof != null) {
        throw new OfflineIdentityTamperError(
          "تعذّر التحقق التشفيري (AES-GCM AAD) من هوية الملتقط أو الوردية على العنصر المحلي — رُصد تلاعب بالحقول الخارجية",
        );
      }
      decoded = await decryptJson<OfflinePayload | BoundOutboxPlaintextV4>(item.payload);
      void aadErr;
    }

    if (isBoundOutboxPlaintextV4(decoded)) {
      const b = decoded.binding;
      if (
        item.clientRequestId !== b.clientRequestId ||
        (item.kind ?? "SALE") !== b.kind ||
        !Number.isInteger(item.capturedByUserId) ||
        Number(item.capturedByUserId) !== Number(b.capturedByUserId) ||
        Number(item.branchId) !== Number(b.branchId) ||
        itemShift !== b.capturedShiftId ||
        itemCapturedShift !== b.capturedShiftId ||
        item.offlineReceiptNumber !== b.offlineReceiptNumber ||
        item.capturedAt !== b.capturedAt ||
        (item.captureProof ?? null) !== (b.captureProof ?? null) ||
        (item.keyId ?? null) !== (b.keyId ?? null) ||
        (item.grantId ?? null) !== (b.grantId ?? null) ||
        (item.grantIssuedAtMs ?? null) !== (b.grantIssuedAtMs ?? null) ||
        (item.grantExpiresAtMs ?? null) !== (b.grantExpiresAtMs ?? null) ||
        (item.grantToken ?? null) !== (b.grantToken ?? null)
      ) {
        throw new OfflineIdentityTamperError(
          "تعذّر التحقق من هوية الملتقط الأصلية على العنصر المحلي — رُصد تلاعب بحقول الهوية أو المنحة أو الوردية",
        );
      }
      return decoded.payload;
    }
    return decoded;
  }
  return item.payload as OfflinePayload;
}

// ── محرك التفريغ ────────────────────────────────────────────────────────────

export interface ReplayResult {
  invoiceId: number;
  invoiceNumber: string;
  idempotentReplay?: boolean;
}
export interface ReplayArgs {
  payload: OfflinePayload;
  capturedAt: string;
  offlineReceiptNumber: string;
  deviceId: string;
  capturedByUserId?: number | null;
  capturedShiftId?: number | null;
  captureProof?: string | null;
  keyId?: string | null;
  grantId?: string | null;
  grantIssuedAtMs?: number | null;
  grantExpiresAtMs?: number | null;
  grantToken?: string | null;
}
export type ReplaySaleApi = (args: ReplayArgs) => Promise<ReplayResult>;

/**
 * خريطة الترحيل بحسب نوع الكاشير. المحرّك لا يعرف شيئاً عن العقود الخادمية — يختار المسار
 * من `item.kind` فقط. غياب مسارٍ لنوعٍ ما ⇒ العنصر يُعلَّق برسالةٍ صريحة بدل محاولةٍ خاطئة
 * (مثلاً: شاشةٌ لم تُمرِّر إلا مسارها فتلقّى الطابور عنصراً من نوعٍ آخر).
 */
export type ReplayApiMap = Partial<Record<OfflineOutboxKind, ReplaySaleApi>>;

/** يقبل المحرّك دالةً واحدة (توافق رجعيّ = كلّها SALE) أو خريطةً كاملة. */
function toApiMap(api: ReplaySaleApi | ReplayApiMap): ReplayApiMap {
  return typeof api === "function" ? { SALE: api } : api;
}

interface FlushState {
  flushing: boolean;
  backoffUntil: number;
  backoffMs: number;
  needsLogin: boolean;
}
const flushState: FlushState = { flushing: false, backoffUntil: 0, backoffMs: BACKOFF_MIN_MS, needsLogin: false };

export function outboxNeedsLogin(): boolean {
  return flushState.needsLogin;
}

function classifyTrpcError(err: unknown): { kind: "transport" | "unauthorized" | "server" | "business"; message: string } {
  const anyErr = err as { data?: { code?: string }; message?: string };
  const code = anyErr?.data?.code;
  const message = anyErr?.message || "خطأ غير معروف";
  if (!code) return { kind: "transport", message };
  if (code === "UNAUTHORIZED") return { kind: "unauthorized", message };
  if (code === "INTERNAL_SERVER_ERROR" || code === "TIMEOUT") return { kind: "server", message };
  return { kind: "business", message };
}

async function cleanupSent(): Promise<void> {
  try {
    const cutoff = Date.now() - SENT_RETENTION_MS;
    const sent = await offlineDb.outbox.where("status").equals("SENT").toArray();
    const stale = sent
      .filter((i: OfflineOutboxItem) => new Date(i.capturedAt).getTime() < cutoff)
      .map((i: OfflineOutboxItem) => i.clientRequestId);
    if (stale.length) await offlineDb.outbox.bulkDelete(stale);
  } catch {
    // تنظيف تجميلي — فشله لا يهم.
  }
}

function leaseExpired(item: OfflineOutboxItem): boolean {
  return (
    item.status === "QUEUED" ||
    !Number.isFinite(item.sendingLeaseUntil) ||
    !item.sendingLeaseUntil ||
    item.sendingLeaseUntil <= Date.now()
  );
}

async function claimReplay(
  item: OfflineOutboxItem,
  parked = false,
): Promise<OfflineOutboxItem | null> {
  return offlineDb.transaction("rw", offlineDb.outbox, async () => {
    const current = await offlineDb.outbox.get(item.clientRequestId);
    if (!current || current.capturedByUserId !== item.capturedByUserId)
      return null;
    if (
      parked
        ? current.status !== "PARKED"
        : !["QUEUED", "SENDING"].includes(current.status) ||
          !leaseExpired(current)
    )
      return null;
    const claimed = {
      ...current,
      status: "SENDING" as const,
      sendingToken: crypto.randomUUID(),
      sendingLeaseUntil: Date.now() + SENDING_LEASE_MS,
    };
    await offlineDb.outbox.update(current.clientRequestId, claimed);
    return claimed;
  });
}

/** A late response from an expired tab cannot overwrite a newer attempt. */
async function updateClaimed(
  item: OfflineOutboxItem,
  patch: Partial<OfflineOutboxItem>,
): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.outbox, async () => {
    const current = await offlineDb.outbox.get(item.clientRequestId);
    if (
      current?.status !== "SENDING" ||
      current.sendingToken !== item.sendingToken
    )
      return;
    await offlineDb.outbox.update(item.clientRequestId, {
      ...patch,
      ...(patch.status && patch.status !== "SENDING"
        ? { sendingToken: null, sendingLeaseUntil: null }
        : {}),
    });
  });
}

/** تفريغ الطابور: FIFO، طلب واحد بالطيران. يُستدعى من محفّزات useOutbox أو زرّ «مزامنة الآن». */
export async function flushOutbox(
  api: ReplaySaleApi | ReplayApiMap,
  opts: { currentUserId: number; force?: boolean },
): Promise<void> {
  const apis = toApiMap(api);
  if (!Number.isInteger(opts.currentUserId) || opts.currentUserId <= 0) return;
  if (flushState.flushing) return;
  if (!opts?.force && Date.now() < flushState.backoffUntil) return;
  flushState.flushing = true;
  notifyOutboxChanged();
  try {
    await cleanupSent();
    const deviceId = await getDeviceCode();
    // عناصرٌ تخطّيناها لغياب مسار نوعها — تُستثنى من الاختيار كي لا تدور الحلقة عليها أبداً.
    let skippedKinds = 0;
    for (;;) {
      const queued = (
        await offlineDb.outbox
          .where("status")
          .anyOf("QUEUED", "SENDING")
          .sortBy("capturedAt")
      ).filter(leaseExpired);
      const { replayable, legacy } = partitionOutboxByIdentity(
        queued,
        opts.currentUserId,
      );
      if (legacy.length > 0) {
        await Promise.all(
          legacy.map((item) =>
            offlineDb.outbox.update(item.clientRequestId, {
              status: "PARKED",
              capturedByUserId: null,
              lastError: LEGACY_OUTBOX_REVIEW_MESSAGE,
            }),
          ),
        );
        notifyOutboxChanged();
      }
      const candidate = replayable[skippedKinds];
      if (!candidate) break;
      const next = await claimReplay(candidate);
      if (!next) continue;
      notifyOutboxChanged();
      // فشل فكّ التشفير (مفتاح جهاز مُتلَف/مُبدَّل) ليس خطأ شبكة — تعليق فوري لا backoff أبدي.
      // اختيار المسار قبل فكّ التشفير: عنصرٌ من نوعٍ لا تملك هذه الشاشة مسارَه لا يُستهلك
      // ولا يُعلَّق — يُترَك في الطابور لتفريغه شاشتُه (أو الشارة العامّة) بلا فقدٍ للنقد.
      const kindApi = apis[next.kind ?? "SALE"];
      if (!kindApi) {
        await updateClaimed(next, { status: "QUEUED" });
        skippedKinds += 1;
        continue;
      }
      let payload: OfflinePayload;
      try {
        payload = await readItemPayload(next);
      } catch (decodeErr) {
        const tamperMsg =
          decodeErr instanceof OfflineIdentityTamperError
            ? decodeErr.message
            : "تعذّر فكّ تشفير العنصر محلياً — راجع المدير (مفتاح الجهاز تغيّر؟)";
        await updateClaimed(next, {
          status: "PARKED",
          lastError: tamperMsg,
        });
        notifyOutboxChanged();
        continue;
      }
      const heartbeat = setInterval(() => {
        void updateClaimed(next, {
          sendingLeaseUntil: Date.now() + SENDING_LEASE_MS,
        }).catch(() => {});
      }, SENDING_LEASE_MS / 3);
      try {
        const res = await kindApi({
          payload,
          capturedAt: next.capturedAt,
          offlineReceiptNumber: next.offlineReceiptNumber,
          deviceId,
          ...(next.capturedByUserId != null ? { capturedByUserId: next.capturedByUserId } : {}),
          ...(next.capturedShiftId != null ? { capturedShiftId: next.capturedShiftId } : {}),
          ...(next.captureProof != null ? { captureProof: next.captureProof } : {}),
          ...(next.keyId != null ? { keyId: next.keyId } : {}),
          ...(next.grantId != null ? { grantId: next.grantId } : {}),
          ...(next.grantIssuedAtMs != null ? { grantIssuedAtMs: next.grantIssuedAtMs } : {}),
          ...(next.grantExpiresAtMs != null ? { grantExpiresAtMs: next.grantExpiresAtMs } : {}),
          ...(next.grantToken != null ? { grantToken: next.grantToken } : {}),
        });
        await updateClaimed(next, {
          status: "SENT",
          lastError: null,
          // نخزّن الرقم الرسمي على العنصر — درج المزامنة يعرض ربط OFF ↔ INV.
          ...(res.invoiceNumber
            ? ({
                resultInvoiceNumber: res.invoiceNumber,
              } as Partial<OfflineOutboxItem>)
            : {}),
        });
        flushState.backoffMs = BACKOFF_MIN_MS;
        flushState.needsLogin = false;
        notifyOutboxChanged();
      } catch (err) {
        const cls = classifyTrpcError(err);
        if (cls.kind === "transport") {
          await updateClaimed(next, { status: "QUEUED", lastError: null });
          flushState.backoffUntil = Date.now() + flushState.backoffMs;
          flushState.backoffMs = Math.min(
            flushState.backoffMs * 2,
            BACKOFF_MAX_MS,
          );
          break;
        }
        if (cls.kind === "unauthorized") {
          await updateClaimed(next, { status: "QUEUED", lastError: null });
          flushState.needsLogin = true;
          break;
        }
        if (cls.kind === "server") {
          const attempts = next.attempts + 1;
          if (attempts >= SERVER_ERROR_MAX_ATTEMPTS) {
            await updateClaimed(next, {
              status: "PARKED",
              attempts,
              lastError: cls.message,
            });
          } else {
            await updateClaimed(next, {
              status: "QUEUED",
              attempts,
              lastError: cls.message,
            });
            flushState.backoffUntil = Date.now() + flushState.backoffMs;
            flushState.backoffMs = Math.min(
              flushState.backoffMs * 2,
              BACKOFF_MAX_MS,
            );
            notifyOutboxChanged();
            break;
          }
        } else {
          // رفض أعمال: يُعلَّق هذا العنصر ويُكمل التفريغ — النقود التالية لا تنتظر قرار مدير.
          await updateClaimed(next, {
            status: "PARKED",
            attempts: next.attempts + 1,
            lastError: cls.message,
          });
        }
        notifyOutboxChanged();
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    flushState.flushing = false;
    notifyOutboxChanged();
  }
}

// ── قراءة ملخّص/عناصر للواجهة ───────────────────────────────────────────────

export interface OutboxSummary {
  queued: number;
  parked: number;
  sentRecent: number;
  queuedTotal: number;
  flushing: boolean;
  needsLogin: boolean;
}

export async function readOutboxSummary(): Promise<OutboxSummary> {
  try {
    const [queued, sending, parked, sent] = await Promise.all([
      offlineDb.outbox.where("status").equals("QUEUED").count(),
      offlineDb.outbox.where("status").equals("SENDING").count(),
      offlineDb.outbox.where("status").equals("PARKED").count(),
      offlineDb.outbox.where("status").equals("SENT").count(),
    ]);
    return {
      queued: queued + sending,
      parked,
      sentRecent: sent,
      queuedTotal: await queuedTotalIQD(),
      flushing: flushState.flushing,
      needsLogin: flushState.needsLogin,
    };
  } catch {
    return { queued: 0, parked: 0, sentRecent: 0, queuedTotal: 0, flushing: false, needsLogin: false };
  }
}

export async function readShiftOutboxSummary(shiftId?: number | null): Promise<{ queued: number; queuedTotal: number }> {
  try {
    const items = await offlineDb.outbox.where("status").anyOf("QUEUED", "SENDING").toArray();
    const shiftItems =
      shiftId != null
        ? items.filter((i) => {
            const payloadShiftId =
              (i.payload as { shiftId?: number | null; refund?: { shiftId?: number | null } } | null)?.shiftId ??
              (i.payload as { refund?: { shiftId?: number | null } } | null)?.refund?.shiftId;
            const resolvedShiftId = i.shiftId ?? payloadShiftId;
            return resolvedShiftId != null && Number(resolvedShiftId) === Number(shiftId);
          })
        : items;
    return {
      queued: shiftItems.length,
      queuedTotal: shiftItems.reduce(
        (sum, i) => sum + (i.kind === "RETURN" ? -Number(i.total || 0) : Number(i.total || 0)),
        0,
      ),
    };
  } catch {
    return { queued: 0, queuedTotal: 0 };
  }
}

export async function listOutboxItems(): Promise<OfflineOutboxItem[]> {
  try {
    const items = await offlineDb.outbox.toArray();
    return items.sort((a: OfflineOutboxItem, b: OfflineOutboxItem) => b.capturedAt.localeCompare(a.capturedAt));
  } catch {
    return [];
  }
}

/** إعادة محاولة عنصر معلَّق يدوياً (زر في درج المزامنة) — يعيده للطابور ويفرّغ فوراً. */
export async function requeueParkedItem(
  clientRequestId: string,
): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.outbox, async () => {
    const current = await offlineDb.outbox.get(clientRequestId);
    if (current?.status !== "PARKED") return;
    await offlineDb.outbox.update(clientRequestId, {
      status: "QUEUED",
      lastError: null,
      sendingToken: null,
      sendingLeaseUntil: null,
    });
  });
  notifyOutboxChanged();
}

/**
 * ش٤ — ترحيل عنصرٍ معلَّق واحد بسلطة مدير (تحت التكلفة FORBIDDEN): الشارة تبني نداءً
 * يحمل managerApproval ويُتحقَّق خادمياً (rate-limit + توقيت ثابت + SOD + تدقيق).
 * لا يمرّ بمحرّك FIFO — عنصر واحد بقرار بشري صريح.
 */
export async function replayParkedWithApproval(
  clientRequestId: string,
  api: ReplaySaleApi | ReplayApiMap,
): Promise<{ ok: boolean; error?: string }> {
  const parked = await offlineDb.outbox.get(clientRequestId);
  if (!parked || parked.status !== "PARKED")
    return { ok: false, error: "العنصر لم يعد معلَّقاً" };
  // نفس اختيار المسار بحسب النوع كما في محرّك التفريغ — لا يُرحَّل عنصرُ استقبالٍ عبر مسار
  // التجزئة لأن الشاشة مرّرت دالةً واحدة.
  const kindApi = toApiMap(api)[parked.kind ?? "SALE"];
  if (!kindApi) return { ok: false, error: "هذا النوع لا يُرحَّل من هذه الشاشة — افتح شاشته أو شارة المزامنة العامّة" };
  const item = await claimReplay(parked, true);
  if (!item) return { ok: false, error: "العنصر قيد المعالجة في نافذة أخرى" };
  notifyOutboxChanged();
  const heartbeat = setInterval(() => {
    void updateClaimed(item, {
      sendingLeaseUntil: Date.now() + SENDING_LEASE_MS,
    }).catch(() => {});
  }, SENDING_LEASE_MS / 3);
  try {
    const deviceId = await getDeviceCode();
    const res = await kindApi({
      payload: await readItemPayload(item),
      capturedAt: item.capturedAt,
      offlineReceiptNumber: item.offlineReceiptNumber,
      deviceId,
      ...(item.capturedByUserId != null ? { capturedByUserId: item.capturedByUserId } : {}),
      ...(item.capturedShiftId != null ? { capturedShiftId: item.capturedShiftId } : {}),
      ...(item.captureProof != null ? { captureProof: item.captureProof } : {}),
      ...(item.keyId != null ? { keyId: item.keyId } : {}),
      ...(item.grantId != null ? { grantId: item.grantId } : {}),
      ...(item.grantIssuedAtMs != null ? { grantIssuedAtMs: item.grantIssuedAtMs } : {}),
      ...(item.grantExpiresAtMs != null ? { grantExpiresAtMs: item.grantExpiresAtMs } : {}),
      ...(item.grantToken != null ? { grantToken: item.grantToken } : {}),
    });
    await updateClaimed(item, {
      status: "SENT",
      lastError: null,
      ...(res.invoiceNumber
        ? ({
            resultInvoiceNumber: res.invoiceNumber,
          } as Partial<OfflineOutboxItem>)
        : {}),
    });
    notifyOutboxChanged();
    return { ok: true };
  } catch (err) {
    const cls = classifyTrpcError(err);
    await updateClaimed(item, {
      status: "PARKED",
      attempts: item.attempts + 1,
      lastError: cls.message,
    });
    notifyOutboxChanged();
    return { ok: false, error: cls.message };
  } finally {
    clearInterval(heartbeat);
  }
}

export function isFencedParkedError(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return (
    errorText.includes("إلغاء وتسييح") ||
    errorText.includes("إلغاء وتسييج") ||
    errorText.includes("إبطال صريح") ||
    errorText.includes("FENCED_NOT_COMMITTED")
  );
}

export async function markOutboxItemSent(
  clientRequestId: string,
  invoiceNumber?: string | null,
): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.outbox, async () => {
    const current = await offlineDb.outbox.get(clientRequestId);
    if (!current) return;
    await offlineDb.outbox.update(clientRequestId, {
      status: "SENT",
      lastError: null,
      sendingToken: null,
      sendingLeaseUntil: null,
      ...(invoiceNumber ? { resultInvoiceNumber: invoiceNumber } : {}),
    });
  });
  notifyOutboxChanged();
}

export async function removeResolvedOutboxItem(clientRequestId: string): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.outbox, async () => {
    if (typeof offlineDb.outbox.delete === "function") {
      await offlineDb.outbox.delete(clientRequestId);
    } else if (typeof offlineDb.outbox.bulkDelete === "function") {
      await offlineDb.outbox.bulkDelete([clientRequestId]);
    }
  });
  notifyOutboxChanged();
}

export type ReissueFencedSaleResult =
  | { status: "POSTED" | "ALREADY_COMMITTED"; invoiceId: number; invoiceNumber: string; message?: string }
  | { status: "CAPTURED_IN_RECOVERY"; message: string };

export async function reissueParkedSaleItem(
  clientRequestId: string,
  reissueApi: (args: ReplayArgs) => Promise<ReissueFencedSaleResult>,
): Promise<{
  ok: boolean;
  outcome?: "POSTED" | "ALREADY_COMMITTED" | "CAPTURED_IN_RECOVERY";
  invoiceNumber?: string;
  message?: string;
  error?: string;
}> {
  const parked = await offlineDb.outbox.get(clientRequestId);
  if (!parked || parked.status !== "PARKED") {
    return { ok: false, error: "العنصر لم يعد معلَّقاً" };
  }
  if ((parked.kind ?? "SALE") !== "SALE") {
    return { ok: false, error: "إعادة الترحيل بمعرّف بديل متاحة لمبيعات التجزئة فقط" };
  }
  const item = await claimReplay(parked, true);
  if (!item) {
    return { ok: false, error: "العنصر قيد المعالجة في نافذة أخرى" };
  }
  notifyOutboxChanged();
  const heartbeat = setInterval(() => {
    void updateClaimed(item, {
      sendingLeaseUntil: Date.now() + SENDING_LEASE_MS,
    }).catch(() => {});
  }, SENDING_LEASE_MS / 3);
  try {
    const deviceId = await getDeviceCode();
    const res = await reissueApi({
      payload: await readItemPayload(item),
      capturedAt: item.capturedAt,
      offlineReceiptNumber: item.offlineReceiptNumber,
      deviceId,
      ...(item.capturedByUserId != null ? { capturedByUserId: item.capturedByUserId } : {}),
      ...(item.capturedShiftId != null ? { capturedShiftId: item.capturedShiftId } : {}),
      ...(item.captureProof != null ? { captureProof: item.captureProof } : {}),
      ...(item.keyId != null ? { keyId: item.keyId } : {}),
      ...(item.grantId != null ? { grantId: item.grantId } : {}),
      ...(item.grantIssuedAtMs != null ? { grantIssuedAtMs: item.grantIssuedAtMs } : {}),
      ...(item.grantExpiresAtMs != null ? { grantExpiresAtMs: item.grantExpiresAtMs } : {}),
      ...(item.grantToken != null ? { grantToken: item.grantToken } : {}),
    });
    if (res.status === "CAPTURED_IN_RECOVERY") {
      await updateClaimed(item, { status: "SENT", lastError: null });
      await removeResolvedOutboxItem(item.clientRequestId);
      return {
        ok: true,
        outcome: "CAPTURED_IN_RECOVERY",
        message: res.message,
      };
    }
    await updateClaimed(item, {
      status: "SENT",
      lastError: null,
      ...(res.invoiceNumber ? { resultInvoiceNumber: res.invoiceNumber } : {}),
    });
    notifyOutboxChanged();
    return {
      ok: true,
      outcome: res.status,
      invoiceNumber: res.invoiceNumber,
      message: res.message,
    };
  } catch (err) {
    const cls = classifyTrpcError(err);
    await updateClaimed(item, {
      status: "PARKED",
      attempts: item.attempts + 1,
      lastError: item.lastError ?? cls.message,
    });
    notifyOutboxChanged();
    return { ok: false, error: cls.message };
  } finally {
    clearInterval(heartbeat);
  }
}

export type DismissParkedResult =
  | { status: "ALREADY_COMMITTED"; invoiceId: number; invoiceNumber: string; message?: string }
  | { status: "SERVER_DISCARDED" | "DISMISSED"; message?: string };

export async function dismissParkedOutboxItemClient(
  clientRequestId: string,
  dismissApi: (args: {
    branchId: number;
    clientRequestId: string;
    kind: OfflineOutboxKind;
    offlineReceiptNumber: string;
    total: string;
    lastError?: string;
  }) => Promise<DismissParkedResult>,
): Promise<{
  ok: boolean;
  outcome?: "ALREADY_COMMITTED" | "SERVER_DISCARDED" | "DISMISSED";
  invoiceNumber?: string;
  message?: string;
  error?: string;
}> {
  const parked = await offlineDb.outbox.get(clientRequestId);
  if (!parked || parked.status !== "PARKED") {
    return { ok: false, error: "العنصر لم يعد معلَّقاً" };
  }
  const item = await claimReplay(parked, true);
  if (!item) {
    return { ok: false, error: "العنصر قيد المعالجة في نافذة أخرى" };
  }
  notifyOutboxChanged();
  try {
    const res = await dismissApi({
      branchId: item.branchId,
      clientRequestId: item.clientRequestId,
      kind: item.kind ?? "SALE",
      offlineReceiptNumber: item.offlineReceiptNumber,
      total: item.total,
      ...(item.lastError ? { lastError: item.lastError } : {}),
    });
    if (res.status === "ALREADY_COMMITTED") {
      await updateClaimed(item, {
        status: "SENT",
        lastError: null,
        ...(res.invoiceNumber ? { resultInvoiceNumber: res.invoiceNumber } : {}),
      });
      notifyOutboxChanged();
      return {
        ok: true,
        outcome: "ALREADY_COMMITTED",
        invoiceNumber: res.invoiceNumber,
        message: res.message,
      };
    }
    await updateClaimed(item, { status: "SENT", lastError: null });
    await removeResolvedOutboxItem(item.clientRequestId);
    return {
      ok: true,
      outcome: res.status,
      message: res.message,
    };
  } catch (err) {
    const cls = classifyTrpcError(err);
    await updateClaimed(item, {
      status: "PARKED",
      lastError: item.lastError,
    });
    notifyOutboxChanged();
    return { ok: false, error: cls.message };
  }
}
