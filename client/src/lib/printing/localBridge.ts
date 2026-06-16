// عميل **الجسر المحلي** (يعمل على جهاز الكاشير نفسه على 127.0.0.1) — مستقلّ عن جسر الخادم السحابي
// (serverBridge.ts). يكتشف الجسر، يسرد طابعات Windows بأسمائها، ويرسل بايتات ESC/POS حرفياً ليطبعها
// الجسر RAW عبر تعريف الطابعة ⇒ **جودة بايت-مطابقة، أي ماركة/موديل**.
//
// أمان المتصفّح (Chrome 142+/Edge 143): الطلب من صفحة HTTPS إلى http://127.0.0.1 مسموح (loopback سياق
// آمن)، ويُمرَّر `targetAddressSpace:"local"` للتلميح بالوجهة المحلية. الجسر يردّ رؤوس CORS/PNA المناسبة.

const PORTS = [17777, 17778, 17779] as const;
const PROBE_TIMEOUT_MS = 900;
const TOKEN_KEY = "printer.bridge.token";

let cachedBase: string | null = null;
let probed = false;

export interface BridgePrinter {
  name: string;
  driver?: string;
  port?: string;
  shared?: boolean;
  share?: string;
  default?: boolean;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bridgeToken(): string {
  try {
    return (typeof localStorage !== "undefined" && localStorage.getItem(TOKEN_KEY)) || "";
  } catch {
    return "";
  }
}

/** يضبط رمز الجسر (token) محلياً — يُدخله المستخدم مرّة في شاشة إدارة الطابعات. */
export function setBridgeToken(token: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    /* تجاهل */
  }
}

export function getBridgeToken(): string {
  return bridgeToken();
}

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  const t = bridgeToken();
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

/** fetch بمهلة + تلميح الوجهة المحلية (يُتجاهَل الخيار في المحرّكات التي لا تدعمه). */
async function bridgeFetch(url: string, init: RequestInit = {}, timeoutMs = PROBE_TIMEOUT_MS): Promise<Response> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl?.signal,
      // @ts-expect-error: خيار Chrome للوصول للشبكة المحلية (Local Network Access)
      targetAddressSpace: "local",
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probePort(port: number): Promise<boolean> {
  try {
    const res = await bridgeFetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return !!data?.ok;
  } catch {
    return false;
  }
}

/** هل الجسر المحلي متاح؟ (يفحص المنافذ مرّة ويُخزّن النتيجة؛ force لإعادة الفحص). */
export async function isLocalBridgeAvailable(force = false): Promise<boolean> {
  if (probed && !force) return cachedBase != null;
  cachedBase = null;
  for (const p of PORTS) {
    // eslint-disable-next-line no-await-in-loop
    if (await probePort(p)) {
      cachedBase = `http://127.0.0.1:${p}`;
      break;
    }
  }
  probed = true;
  return cachedBase != null;
}

export function getBridgeBase(): string | null {
  return cachedBase;
}

/** قائمة طابعات Windows من الجسر (بالاسم/التعريف/المنفذ/الافتراضي). يرمي عند تعذّر الاتصال. */
export async function listBridgePrinters(): Promise<BridgePrinter[]> {
  if (!(await isLocalBridgeAvailable())) throw new Error("الجسر المحلي غير متصل");
  const res = await bridgeFetch(`${cachedBase}/printers`, { headers: authHeaders() }, 4000);
  if (!res.ok) {
    let msg = `تعذّر سرد الطابعات (${res.status})`;
    try { const d = await res.json(); if (d?.error) msg = String(d.error); } catch { /* تجاهل */ }
    throw new Error(msg);
  }
  const data = await res.json();
  const arr = Array.isArray(data?.printers) ? data.printers : [];
  return arr
    .filter((p: any) => p && typeof p.name === "string")
    .map((p: any) => ({
      name: p.name,
      driver: p.driver,
      port: p.port,
      shared: !!p.shared,
      share: p.share,
      default: !!p.default,
    }));
}

/**
 * إرسال بايتات RAW (ESC/POS الآن؛ zpl/epl لاحقاً) للطباعة على طابعة بالاسم عبر الجسر.
 * يمرّر الجسر البايتات حرفياً ⇒ بلا أي مساس بالجودة. يرمي عند الفشل (ليتراجع المُرسِل للبديل).
 */
export async function sendRawToBridge(
  printerName: string,
  bytes: Uint8Array,
  format: "escpos" | "zpl" | "epl" = "escpos",
): Promise<void> {
  if (!(await isLocalBridgeAvailable())) throw new Error("الجسر المحلي غير متصل");
  const res = await bridgeFetch(
    `${cachedBase}/print/raw`,
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ printer: printerName, bytesB64: bytesToBase64(bytes), format }),
    },
    15000,
  );
  if (!res.ok) {
    let msg = `فشل الطباعة عبر الجسر المحلي (${res.status})`;
    try { const d = await res.json(); if (d?.error) msg = String(d.error); } catch { /* تجاهل */ }
    throw new Error(msg);
  }
}

/** تشغيل تذكرة اختبار عبر الجسر (للتشخيص في الواجهة). يعيد نتيجة بدل الرمي. */
export async function bridgePrintTest(printerName: string, bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
  try {
    await sendRawToBridge(printerName, bytes);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر الاتصال بالجسر" };
  }
}
