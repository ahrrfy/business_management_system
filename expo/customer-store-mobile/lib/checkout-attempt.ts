import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const ATTEMPT_KEY = "alarabiya-checkout-attempt-v1";

export type PendingCheckoutAttempt = {
  clientRequestId: string;
  fingerprint: string;
  createdAt: number;
};

function createClientRequestId() {
  return `ma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function readRaw() {
  if (Platform.OS === "web") return globalThis.sessionStorage?.getItem(ATTEMPT_KEY) ?? null;
  return SecureStore.getItemAsync(ATTEMPT_KEY);
}

async function writeRaw(value: string | null) {
  if (Platform.OS === "web") {
    if (value) globalThis.sessionStorage?.setItem(ATTEMPT_KEY, value);
    else globalThis.sessionStorage?.removeItem(ATTEMPT_KEY);
    return;
  }
  if (value) await SecureStore.setItemAsync(ATTEMPT_KEY, value);
  else await SecureStore.deleteItemAsync(ATTEMPT_KEY);
}

export async function requestIdForFingerprint(fingerprint: string) {
  try {
    const raw = await readRaw();
    const existing = raw ? JSON.parse(raw) as PendingCheckoutAttempt : null;
    if (existing?.fingerprint === fingerprint && typeof existing.clientRequestId === "string" && existing.clientRequestId.length >= 8) return existing.clientRequestId;
  } catch {
    // التخزين مشغول أو تالف: نولد محاولة جديدة ولا نمنع العميل من الشراء.
  }
  const attempt: PendingCheckoutAttempt = { clientRequestId: createClientRequestId(), fingerprint, createdAt: Date.now() };
  try { await writeRaw(JSON.stringify(attempt)); } catch { /* يبقى الإدخال قابلاً للإرسال دون استعادة بعد إغلاق التطبيق. */ }
  return attempt.clientRequestId;
}

export async function clearPendingCheckoutAttempt() {
  try { await writeRaw(null); } catch { /* لا يؤثر فشل التنظيف في نتيجة الطلب الخادمية. */ }
}
