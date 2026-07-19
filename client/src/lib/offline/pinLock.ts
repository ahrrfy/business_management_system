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

import { offlineDb, type OfflineProfileRow } from "./db";

const PBKDF2_ITERATIONS = 310_000;

export interface OfflineProfile {
  userId: number;
  name: string;
  role: string;
  branchId: number | null;
  hasPin: boolean;
}

async function derivePinHash(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
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

/** يُحدَّث عند كل دخول/جلسة أونلاين ناجحة (من POS) — هوية «آخر مستخدم معروف» للجهاز. */
export async function saveOfflineProfile(user: {
  id: number;
  name: string;
  role: string;
  branchId: number | null;
}): Promise<void> {
  try {
    const existing = await offlineDb.profile.get("profile");
    await offlineDb.profile.put({
      key: "profile",
      userId: user.id,
      name: user.name,
      role: user.role,
      branchId: user.branchId,
      // تغيّر المستخدم على الجهاز ⇒ PIN القديم يخص غيره فيُمسح (يُعاد ضبطه للمستخدم الجديد).
      pinSalt: existing && existing.userId === user.id ? existing.pinSalt : null,
      pinHash: existing && existing.userId === user.id ? existing.pinHash : null,
      savedAt: new Date().toISOString(),
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

export async function setOfflinePin(pin: string): Promise<{ ok: boolean; error?: string }> {
  const trimmed = pin.trim();
  if (!/^\d{4,8}$/.test(trimmed)) {
    return { ok: false, error: "رمز PIN من ٤ إلى ٨ أرقام" };
  }
  const row = await offlineDb.profile.get("profile");
  if (!row) return { ok: false, error: "لا ملف جهاز — سجّل الدخول أونلاين أولاً" };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(trimmed, salt);
  await offlineDb.profile.put({ ...row, pinSalt: salt, pinHash: hash });
  return { ok: true };
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
const listeners = new Set<UnlockListener>();

export function isOfflineUnlocked(): boolean {
  return unlocked;
}

export function markOfflineUnlocked(): void {
  unlocked = true;
  listeners.forEach((cb) => cb());
}

export function subscribeOfflineUnlock(cb: UnlockListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ── الدوال النقية للاختبار (بيئة node تملك WebCrypto) ────────────────────────
export const __testables = { derivePinHash, constantTimeEqual };
