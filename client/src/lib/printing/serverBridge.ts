// عميل جسر الطباعة على الخادم. يكتشف إن كان الجسر مفعّلاً، ويرسل بايتات ESC/POS للخادم ليطبعها صامتاً.
// العربية تُرسَّم نقطياً (raster) على Canvas في المتصفّح ثم تُرسَل بايتاتها كما هي ⇒ الخادم مجرّد ناقل.
import { screenAttributionHeaders } from "@/lib/screenAttribution";

let cachedEnabled: boolean | null = null;
let lastStatusCheck = 0;
const STATUS_CACHE_TTL = 15_000; // 15 ثانية — تجديد دوري تلقائي

/** ترميز Uint8Array إلى base64 (حلقة بايت-بايت ⇒ بلا نشر typed array، متوافق مع كل أهداف TS). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** هل جسر الخادم مفعّل؟ (مخزّن مؤقّتاً لمدة 15 ثانية؛ مرّر force=true لإعادة الفحص الفوري). */
export async function isServerBridgeEnabled(force = false): Promise<boolean> {
  const now = Date.now();
  if (cachedEnabled !== null && !force && (now - lastStatusCheck) < STATUS_CACHE_TTL) {
    return cachedEnabled;
  }
  try {
    const res = await fetch("/api/print/status", { credentials: "include" });
    if (!res.ok) {
      cachedEnabled = false;
      lastStatusCheck = now;
      return false;
    }
    const data = await res.json();
    cachedEnabled = !!data?.enabled;
    lastStatusCheck = now;
    return cachedEnabled;
  } catch {
    cachedEnabled = false;
    lastStatusCheck = now;
    return false;
  }
}

/** حالة الجسر للعرض في الواجهة (مفعّل + وصف الوجهة). */
export async function getServerBridgeStatus(): Promise<{ enabled: boolean; description: string }> {
  try {
    const res = await fetch("/api/print/status", { credentials: "include" });
    if (!res.ok) return { enabled: false, description: "غير متاح" };
    const data = await res.json();
    cachedEnabled = !!data?.enabled;
    lastStatusCheck = Date.now();
    return { enabled: !!data?.enabled, description: String(data?.description ?? "") };
  } catch {
    return { enabled: false, description: "غير متاح" };
  }
}

/** إرسال بايتات ESC/POS للخادم ليطبعها. يرمي عند الفشل (ليتراجع المتّصِل للبديل). */
export async function sendRawToServer(bytes: Uint8Array): Promise<void> {
  const res = await fetch("/api/print/raw", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-ERP-CSRF": "1", ...screenAttributionHeaders() },
    body: JSON.stringify({ bytesB64: bytesToBase64(bytes) }),
  });
  if (!res.ok) {
    let msg = `فشل الطباعة عبر الخادم (${res.status})`;
    try { const d = await res.json(); if (d?.error) msg = String(d.error); } catch { /* تجاهل */ }
    throw new Error(msg);
  }
}

/** تشغيل تذكرة اختبار من الخادم (ASCII). يعيد نتيجة بدل الرمي ليسهل عرضها في الواجهة. */
export async function serverPrintTest(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/print/test", {
      method: "POST",
      credentials: "include",
      headers: { "X-ERP-CSRF": "1", ...screenAttributionHeaders() },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error ?? `خطأ ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر الاتصال بالخادم" };
  }
}
