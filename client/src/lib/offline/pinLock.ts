// قفل PIN المحلي + ملف تعريف الجهاز — الشريحة ٥ من خطة الأوفلاين.
//
// الغرض الصادق: عند إقلاع الجهاز والاتصال مقطوع لا يمكن التحقق من الجلسة خادمياً — بدل
// شاشة «تعذّر الاتصال» العمياء، مَن سبق له الدخول أونلاين على هذا الجهاز وضبط رمز PIN
// يفتح **واجهة الكاشير فقط** برمزه. هذه **حراسة واجهة** (till discipline) لا مصادقة
// تشفيرية — الترحيل الفعلي للمبيعات يستوثق بجلسة الخادم عند عودة الاتصال، وأي إبطال
// خادمي (sessionsValidFrom/sid) يسري عندها. يُصارَح المالك بهذا الحدّ بوضوح.
//
// PIN: PBKDF2-SHA-256 بـ٣١٠ ألف تكرار وملح لكل جهاز (توصية OWASP) — يهزم قراءة القرص
// العرضية، ومقارنة الهاش ثابتة الزمن.

import { getMeta, offlineDb, setMeta, type OfflineProfileRow } from "./db";
import { decryptJson, encryptJson } from "./crypto";
import type { PermissionMap, RoleKey } from "@shared/permissions";
import type { OperationPolicy } from "@shared/operationPermissions";
import {
  isValidStudioTenantScope,
  sameStudioTenantScope,
  type StudioTenantScope,
} from "@/lib/productStudio/studioTenantScope";

const PBKDF2_ITERATIONS = 310_000;

export interface OfflineProfile {
  /** `undefined` يعني ملفاً قديماً؛ يصلح لـPOS القديم ولا يفتح Studio البارد. */
  companyId: number | null | undefined;
  userId: number;
  name: string;
  role: string;
  branchId: number | null;
  hasPin: boolean;
}

function shouldPreserveOfflinePin(
  existing: OfflineProfileRow | undefined,
  nextScope: StudioTenantScope,
): boolean {
  return (
    isValidStudioTenantScope(existing) &&
    sameStudioTenantScope(existing, nextScope)
  );
}

async function derivePinHash(
  pin: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** مقارنة ثابتة الزمن (لا early-exit يكشف طول التطابق). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function sameProfileVersion(
  current: OfflineProfileRow | undefined,
  expected: OfflineProfileRow,
): boolean {
  if (!current) return false;
  const fields = [
    "companyId",
    "userId",
    "branchId",
    "role",
    "name",
    "savedAt",
  ] as const;
  const sameBytes = (
    a: Uint8Array | null | undefined,
    b: Uint8Array | null | undefined,
  ) =>
    a == null || b == null
      ? a === b
      : constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
  return (
    fields.every((field) => current[field] === expected[field]) &&
    sameBytes(current.pinSalt, expected.pinSalt) &&
    sameBytes(current.pinHash, expected.pinHash)
  );
}

/** يُحدَّث عند كل دخول/جلسة أونلاين ناجحة (من POS) — هوية «آخر مستخدم معروف» للجهاز. */
export async function saveOfflineProfile(user: {
  id: number;
  companyId: number | null;
  name: string;
  role: string;
  branchId: number | null;
}): Promise<void> {
  try {
    await offlineDb.transaction("rw", offlineDb.profile, async () => {
      const existing = await offlineDb.profile.get("profile");
      const nextScope: StudioTenantScope = {
        companyId: user.companyId,
        userId: user.id,
      };
      const preservePin = shouldPreserveOfflinePin(existing, nextScope);
      await offlineDb.profile.put({
        key: "profile",
        companyId: user.companyId,
        userId: user.id,
        name: user.name,
        role: user.role,
        branchId: user.branchId,
        // تغيّر الشركة أو المستخدم على الجهاز ⇒ PIN القديم يخص نطاقاً آخر فيُمسح ويُعاد ضبطه.
        pinSalt: preservePin && existing ? existing.pinSalt : null,
        pinHash: preservePin && existing ? existing.pinHash : null,
        savedAt: new Date().toISOString(),
      });
    });
  } catch {
    // فشل التخزين المحلي لا يمسّ التشغيل الأونلايني.
  }
}

export async function getOfflineProfile(): Promise<OfflineProfile | null> {
  try {
    const row = await offlineDb.profile.get("profile");
    if (!row) return null;
    return {
      companyId:
        Object.prototype.hasOwnProperty.call(row, "companyId") &&
        (row.companyId === null ||
          (Number.isInteger(row.companyId) && Number(row.companyId) > 0))
          ? row.companyId
          : undefined,
      userId: row.userId,
      name: row.name,
      role: row.role,
      branchId: row.branchId,
      hasPin: !!(row.pinSalt && row.pinHash),
    };
  } catch {
    return null;
  }
}

export async function setOfflinePin(
  pin: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = pin.trim();
  if (!/^\d{4,8}$/.test(trimmed)) {
    return { ok: false, error: "رمز PIN من ٤ إلى ٨ أرقام" };
  }
  const row = await offlineDb.profile.get("profile");
  if (!row)
    return { ok: false, error: "لا ملف جهاز — سجّل الدخول أونلاين أولاً" };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(trimmed, salt);
  // Derive outside the IndexedDB transaction; compare and write atomically afterwards.
  return offlineDb.transaction("rw", offlineDb.profile, async () => {
    const current = await offlineDb.profile.get("profile");
    if (!sameProfileVersion(current, row)) {
      return {
        ok: false,
        error:
          "تغير ملف الجهاز أثناء ضبط الرمز. أعد فتح الإعدادات وحاول مجدداً.",
      };
    }
    await offlineDb.profile.put({ ...current!, pinSalt: salt, pinHash: hash });
    return { ok: true };
  });
}

export async function verifyOfflinePin(pin: string): Promise<boolean> {
  try {
    const row = await offlineDb.profile.get("profile");
    if (!row?.pinSalt || !row.pinHash) return false;
    const hash = await derivePinHash(pin.trim(), new Uint8Array(row.pinSalt));
    return constantTimeEqual(hash, new Uint8Array(row.pinHash));
  } catch {
    return false;
  }
}

// ── حالة الفتح (لكل إقلاع — لا تُخزَّن: إعادة التحميل تعيد القفل) ────────────

type UnlockListener = () => void;
let unlocked = false;
let unlockedProfile: Pick<
  OfflineProfile,
  "companyId" | "userId" | "role"
> | null = null;
const listeners = new Set<UnlockListener>();

export function isOfflineUnlocked(): boolean {
  return unlocked;
}

export function markOfflineUnlocked(
  profile?: Pick<OfflineProfile, "companyId" | "userId" | "role">,
): void {
  unlocked = true;
  unlockedProfile = profile ?? null;
  listeners.forEach((cb) => cb());
}

export function lockOfflineSession(): void {
  unlocked = false;
  unlockedProfile = null;
  listeners.forEach((cb) => cb());
}

/** ملف جلسة PIN عابر للذاكرة؛ لا يكفي وحده لفتح Studio بلا مطابقة هوية المسودة. */
export function getOfflineUnlockedProfile(): Pick<
  OfflineProfile,
  "companyId" | "userId" | "role"
> | null {
  return unlockedProfile;
}

export function subscribeOfflineUnlock(cb: UnlockListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ── v4: لقطة الصلاحيات الفعلية المشفّرة بـAAD والمقيدة بالهوية والمدة + إبطال عبر التبويبات ──

export const ENCRYPTED_PERM_POLICY_META_KEY = "encryptedOfflinePermSnapshot";
export const OFFLINE_PERM_POLICY_TTL_MS = 48 * 60 * 60 * 1000;
export const OFFLINE_AUTH_BROADCAST_CHANNEL = "alroya-offline-auth-v4";
export const OFFLINE_REVOKE_EPOCH_STORAGE_KEY = "alroya.offlineRevokedAtMs.v4";
export const OFFLINE_SESSION_EPOCH_STORAGE_KEY = "alroya.offlineSessionEpoch.v4";

export interface OfflineEffectivePermSnapshotV4 {
  __permPolicyV4: 1;
  userId: number;
  branchId: number | null;
  role: RoleKey;
  isOwner: boolean;
  permissionsOverride: PermissionMap | null;
  operationPolicyEnabled: boolean;
  resolvedOperationPolicy: OperationPolicy | null;
  canCreateRetailSale: boolean;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface SerializedPermCipherV4 {
  __permCipherV4: 1;
  userId: number;
  branchId: number | null;
  ivHex: string;
  dataHex: string;
}

function buildPermPolicyAad(userId: number, branchId: number | null): Uint8Array {
  return new TextEncoder().encode(
    `alroya.perm_policy.v4|${Number(userId)}|${branchId == null ? "null" : Number(branchId)}`,
  );
}

function bytesToHexPerm(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytesPerm(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

let cachedOfflinePermSnapshot: OfflineEffectivePermSnapshotV4 | null = null;
let inMemorySessionEpoch = 1;

export function readCrossTabRevokedAtMs(): number {
  try {
    if (typeof localStorage === "undefined") return 0;
    const raw = localStorage.getItem(OFFLINE_REVOKE_EPOCH_STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function readCrossTabSessionEpoch(): number {
  try {
    if (typeof localStorage === "undefined") return inMemorySessionEpoch;
    const raw = localStorage.getItem(OFFLINE_SESSION_EPOCH_STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    if (Number.isSafeInteger(n) && n > inMemorySessionEpoch) {
      inMemorySessionEpoch = n;
    }
  } catch {
    /* ignore private-mode storage read error */
  }
  return inMemorySessionEpoch;
}

export function broadcastCrossTabOfflineRevocation(reason = "session_boundary"): number {
  const revokedAtMs = Math.max(Date.now() + 1, readCrossTabRevokedAtMs() + 1);
  const nextSessionEpoch = readCrossTabSessionEpoch() + 1;
  inMemorySessionEpoch = nextSessionEpoch;
  cachedOfflinePermSnapshot = null;
  unlocked = false;
  unlockedProfile = null;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(OFFLINE_REVOKE_EPOCH_STORAGE_KEY, String(revokedAtMs));
      localStorage.setItem(OFFLINE_SESSION_EPOCH_STORAGE_KEY, String(nextSessionEpoch));
      const nonceBytes = new Uint8Array(8);
      if (typeof globalThis.crypto?.getRandomValues === "function") {
        globalThis.crypto.getRandomValues(nonceBytes);
      }
      const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(
        "alroya.offlineRevokeSignal.v4",
        JSON.stringify({ revokedAtMs, sessionEpoch: nextSessionEpoch, reason, nonce }),
      );
    }
  } catch {
    /* ignore private-mode storage error; RAM + BroadcastChannel still fire */
  }
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const bc = new BroadcastChannel(OFFLINE_AUTH_BROADCAST_CHANNEL);
      bc.postMessage({ type: "REVOKE_ALL", revokedAtMs, sessionEpoch: nextSessionEpoch, reason });
      bc.close();
    }
  } catch {
    /* ignore environments without BroadcastChannel */
  }
  listeners.forEach((cb) => cb());
  return revokedAtMs;
}

if (typeof window !== "undefined") {
  try {
    window.addEventListener("storage", (ev) => {
      if (
        ev.key === OFFLINE_REVOKE_EPOCH_STORAGE_KEY ||
        ev.key === OFFLINE_SESSION_EPOCH_STORAGE_KEY ||
        ev.key === "alroya.offlineRevokeSignal.v4"
      ) {
        inMemorySessionEpoch = Math.max(inMemorySessionEpoch + 1, readCrossTabSessionEpoch());
        cachedOfflinePermSnapshot = null;
        if (unlocked) {
          unlocked = false;
          unlockedProfile = null;
        }
        listeners.forEach((cb) => cb());
      }
    });
  } catch {
    /* noop */
  }
}

if (typeof BroadcastChannel !== "undefined") {
  try {
    const subBc = new BroadcastChannel(OFFLINE_AUTH_BROADCAST_CHANNEL);
    subBc.onmessage = (ev) => {
      if (ev?.data?.type === "REVOKE_ALL") {
        const incomingEpoch = Number(ev?.data?.sessionEpoch ?? 0);
        inMemorySessionEpoch = Math.max(
          inMemorySessionEpoch + 1,
          Number.isSafeInteger(incomingEpoch) ? incomingEpoch : 0,
        );
        cachedOfflinePermSnapshot = null;
        unlocked = false;
        unlockedProfile = null;
        listeners.forEach((cb) => cb());
      }
    };
  } catch {
    /* noop */
  }
}

export async function saveOfflinePermSnapshot(params: {
  userId: number;
  branchId: number | null;
  role: RoleKey;
  isOwner: boolean;
  permissionsOverride: PermissionMap | null;
  operationPolicyEnabled: boolean;
  resolvedOperationPolicy: OperationPolicy | null;
  canCreateRetailSale: boolean;
  ttlMs?: number;
}): Promise<void> {
  const now = Math.max(Date.now(), readCrossTabRevokedAtMs() + 1);
  const ttl = params.ttlMs != null && params.ttlMs > 0 ? params.ttlMs : OFFLINE_PERM_POLICY_TTL_MS;
  const snap: OfflineEffectivePermSnapshotV4 = {
    __permPolicyV4: 1,
    userId: Number(params.userId),
    branchId: params.branchId == null ? null : Number(params.branchId),
    role: params.role,
    isOwner: Boolean(params.isOwner),
    permissionsOverride: params.permissionsOverride ?? null,
    operationPolicyEnabled: Boolean(params.operationPolicyEnabled),
    resolvedOperationPolicy: params.resolvedOperationPolicy ?? null,
    canCreateRetailSale: Boolean(params.canCreateRetailSale),
    issuedAtMs: now,
    expiresAtMs: now + ttl,
  };
  cachedOfflinePermSnapshot = snap;
  try {
    const aad = buildPermPolicyAad(snap.userId, snap.branchId);
    const env = await encryptJson(snap, aad);
    const serialized: SerializedPermCipherV4 = {
      __permCipherV4: 1,
      userId: snap.userId,
      branchId: snap.branchId,
      ivHex: bytesToHexPerm(env.iv),
      dataHex: bytesToHexPerm(env.data),
    };
    await setMeta(ENCRYPTED_PERM_POLICY_META_KEY, JSON.stringify(serialized));
    listeners.forEach((cb) => cb());
  } catch {
    /* keep validated RAM snapshot if IndexedDB unavailable */
  }
}

export async function clearOfflinePermSnapshot(): Promise<void> {
  cachedOfflinePermSnapshot = null;
  await setMeta(ENCRYPTED_PERM_POLICY_META_KEY, "");
  listeners.forEach((cb) => cb());
}

export async function resolveOfflinePermSnapshot(
  expectedUserId: number,
  expectedBranchId?: number | null,
): Promise<OfflineEffectivePermSnapshotV4 | null> {
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) return null;
  const now = Date.now();
  const revokedAtMs = readCrossTabRevokedAtMs();

  const isSnapAcceptable = (s: OfflineEffectivePermSnapshotV4 | null): s is OfflineEffectivePermSnapshotV4 => {
    if (!s || s.__permPolicyV4 !== 1) return false;
    if (s.userId !== expectedUserId) return false;
    if (
      expectedBranchId != null &&
      s.branchId != null &&
      Number(s.branchId) !== Number(expectedBranchId)
    ) {
      return false;
    }
    if (revokedAtMs > 0 && s.issuedAtMs <= revokedAtMs) return false;
    if (now > s.expiresAtMs || now < s.issuedAtMs - 5 * 60_000) return false;
    return true;
  };

  if (isSnapAcceptable(cachedOfflinePermSnapshot)) {
    return cachedOfflinePermSnapshot;
  }
  cachedOfflinePermSnapshot = null;

  const raw = await getMeta(ENCRYPTED_PERM_POLICY_META_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SerializedPermCipherV4>;
    if (parsed?.__permCipherV4 !== 1 || Number(parsed.userId) !== expectedUserId) {
      return null;
    }
    const iv = hexToBytesPerm(parsed.ivHex ?? "");
    const data = hexToBytesPerm(parsed.dataHex ?? "");
    if (!iv || iv.byteLength !== 12 || !data || data.byteLength === 0) return null;
    const aad = buildPermPolicyAad(expectedUserId, parsed.branchId ?? null);
    const decoded = await decryptJson<OfflineEffectivePermSnapshotV4>(
      { enc: true, v: 1, iv, data },
      aad,
    );
    if (!isSnapAcceptable(decoded)) return null;
    cachedOfflinePermSnapshot = decoded;
    listeners.forEach((cb) => cb());
    return decoded;
  } catch {
    return null;
  }
}

export function getCachedOfflinePermSnapshotSync(
  expectedUserId?: number | null,
): OfflineEffectivePermSnapshotV4 | null {
  if (!cachedOfflinePermSnapshot) return null;
  if (expectedUserId != null && cachedOfflinePermSnapshot.userId !== Number(expectedUserId)) {
    return null;
  }
  const now = Date.now();
  const revokedAtMs = readCrossTabRevokedAtMs();
  if (
    (revokedAtMs > 0 && cachedOfflinePermSnapshot.issuedAtMs <= revokedAtMs) ||
    now > cachedOfflinePermSnapshot.expiresAtMs
  ) {
    cachedOfflinePermSnapshot = null;
    return null;
  }
  return cachedOfflinePermSnapshot;
}

// ── الدوال النقية للاختبار (بيئة node تملك WebCrypto) ────────────────────────
export const __testables = {
  derivePinHash,
  constantTimeEqual,
  shouldPreserveOfflinePin,
};
