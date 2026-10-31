import { offlineDb } from "./offline/db";
import { decryptJsonWithKey, encryptJsonWithKey } from "./offline/crypto";

export interface FinancialIntentScope {
  companyId: number | null;
  userId: number;
  branchId: number;
  operation: "SALES_PAYMENT" | "SUPPLIER_SETTLEMENT";
  target: string;
}

export interface FinancialIntent<T> {
  id: string;
  createdAt: string;
  payload: T;
}

const KEY_NAME = "financial-intents-aes-v1";

export function financialIntentScopeKey(scope: FinancialIntentScope): string {
  if (
    !Number.isSafeInteger(scope.userId) ||
    scope.userId <= 0 ||
    !Number.isSafeInteger(scope.branchId) ||
    scope.branchId <= 0 ||
    (scope.companyId !== null &&
      (!Number.isSafeInteger(scope.companyId) || scope.companyId <= 0)) ||
    !["SALES_PAYMENT", "SUPPLIER_SETTLEMENT"].includes(scope.operation) ||
    !/^(?:invoice:[1-9]\d*|workspace)$/.test(scope.target)
  ) {
    throw new Error("تعذّر تحديد هوية محاولة الدفع؛ أعد تسجيل الدخول.");
  }
  return `financial-intent:v1:${scope.companyId === null ? "single" : `company-${scope.companyId}`}:user-${scope.userId}:branch-${scope.branchId}:${scope.operation}:${scope.target}`;
}

async function encryptionKey(create: boolean): Promise<CryptoKey> {
  const existing = await offlineDb.keys.get(KEY_NAME);
  if (existing?.key) return existing.key;
  if (!create)
    throw new Error(
      "مفتاح محاولة الدفع المحفوظة غير متاح؛ لا تمسح التخزين المحلي.",
    );
  const candidate = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  // Crypto finishes first; a transaction selects one durable key across tabs.
  return offlineDb.transaction("rw", offlineDb.keys, async () => {
    const winner = await offlineDb.keys.get(KEY_NAME);
    if (winner?.key) return winner.key;
    await offlineDb.keys.add({ name: KEY_NAME, key: candidate });
    return candidate;
  });
}

async function decode<T>(
  key: string,
  raw: string,
): Promise<FinancialIntent<T>> {
  const stored: unknown = JSON.parse(raw);
  if (!stored || typeof stored !== "object")
    throw new Error("محاولة الدفع المحفوظة غير قابلة للقراءة.");
  const value = stored as { v?: unknown; iv?: unknown; data?: unknown };
  const bytes = (v: unknown): v is number[] =>
    Array.isArray(v) &&
    v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (
    value.v !== 1 ||
    !bytes(value.iv) ||
    value.iv.length !== 12 ||
    !bytes(value.data)
  )
    throw new Error("محاولة الدفع المحفوظة غير قابلة للقراءة.");
  const decoded = await decryptJsonWithKey<{
    storageKey: string;
    intent: FinancialIntent<T>;
  }>(
    {
      enc: true,
      v: 1,
      iv: new Uint8Array(value.iv),
      data: new Uint8Array(value.data),
    },
    await encryptionKey(false),
  );
  if (
    decoded.storageKey !== key ||
    !decoded.intent ||
    typeof decoded.intent.id !== "string" ||
    !decoded.intent.id ||
    !decoded.intent.payload ||
    !Number.isFinite(Date.parse(decoded.intent.createdAt))
  ) {
    throw new Error(
      "هوية محاولة الدفع المحفوظة غير مطابقة؛ راجع الإدارة دون مسحها.",
    );
  }
  return decoded.intent;
}

export async function loadFinancialIntent<T>(
  scope: FinancialIntentScope,
): Promise<FinancialIntent<T> | null> {
  const key = financialIntentScopeKey(scope);
  const row = await offlineDb.meta.get(key);
  return row ? decode<T>(key, row.value) : null;
}

/** Returns a prior unresolved command unchanged, including one saved by another tab. */
export async function reserveFinancialIntent<T>(
  scope: FinancialIntentScope,
  intent: FinancialIntent<T>,
): Promise<FinancialIntent<T>> {
  const key = financialIntentScopeKey(scope);
  if (
    !intent.id ||
    intent.id.length > 160 ||
    !intent.payload ||
    !Number.isFinite(Date.parse(intent.createdAt))
  )
    throw new Error("محاولة الدفع غير صالحة للحفظ.");
  const encrypted = await encryptJsonWithKey(
    { storageKey: key, intent },
    await encryptionKey(true),
  );
  const value = JSON.stringify({
    v: 1,
    iv: Array.from(encrypted.iv),
    data: Array.from(encrypted.data),
  });
  const saved = await offlineDb.transaction("rw", offlineDb.meta, async () => {
    const prior = await offlineDb.meta.get(key);
    if (prior) return prior.value;
    await offlineDb.meta.add({ key, value });
    return value;
  });
  return decode<T>(key, saved);
}

/** Removes only this completed recovery envelope; never clears an outbox or another command. */
export async function resolveFinancialIntent(
  scope: FinancialIntentScope,
  id: string,
): Promise<boolean> {
  const key = financialIntentScopeKey(scope);
  const row = await offlineDb.meta.get(key);
  if (!row) return true;
  const intent = await decode<unknown>(key, row.value);
  if (intent.id !== id) return false;
  return offlineDb.transaction("rw", offlineDb.meta, async () => {
    const current = await offlineDb.meta.get(key);
    if (!current) return true;
    if (current.value !== row.value) return false;
    await offlineDb.meta.delete(key);
    return true;
  });
}

/** A response rejecting a fresh command differs from a lost response or a recovery rejection. */
export function isDefinitiveIntentRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { data?: { code?: unknown } }).data?.code;
  return (
    typeof code === "string" &&
    [
      "BAD_REQUEST",
      "FORBIDDEN",
      "UNAUTHORIZED",
      "NOT_FOUND",
      "CONFLICT",
      "PRECONDITION_FAILED",
      "TOO_MANY_REQUESTS",
    ].includes(code)
  );
}
