// عميل جسر الطباعة على الخادم. يكتشف إن كان الجسر مفعّلاً، ويرسل بايتات ESC/POS للخادم ليطبعها صامتاً.
// العربية تُرسَّم نقطياً (raster) على Canvas في المتصفّح ثم تُرسَل بايتاتها كما هي ⇒ الخادم مجرّد ناقل.

let cachedEnabled: boolean | null = null;

/** ترميز Uint8Array إلى base64 (حلقة بايت-بايت ⇒ بلا نشر typed array، متوافق مع كل أهداف TS). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** هل جسر الخادم مفعّل؟ (مخزّن مؤقّتاً؛ مرّر force=true لإعادة الفحص). */
export async function isServerBridgeEnabled(force = false): Promise<boolean> {
  if (cachedEnabled !== null && !force) return cachedEnabled;
  try {
    const res = await fetch("/api/print/status", { credentials: "include" });
    if (!res.ok) { cachedEnabled = false; return false; }
    const data = await res.json();
    cachedEnabled = !!data?.enabled;
    return cachedEnabled;
  } catch {
    cachedEnabled = false;
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
    headers: { "Content-Type": "application/json" },
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
    const res = await fetch("/api/print/test", { method: "POST", credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error ?? `خطأ ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر الاتصال بالخادم" };
  }
}
