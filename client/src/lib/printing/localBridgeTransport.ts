// عميل الجسر المحلي — يكلّم alroya-bridge.exe الذي يعمل على نفس جهاز المستخدم
// (127.0.0.1:9101) ويوقّع كل طلب بـHMAC-SHA256 بالسرّ المخزّن في localStorage.
//
// لماذا هذا الجسر بدل /api/print الخادمي:
// بعد النشر السحابي، خادم الـPWA لا يصل لطابعة المتجر. الحلّ الإنتاجي: عملية محلية
// على جهاز الكاشير تستقبل البايتات من الـPWA السحابي وتطبعها على الطابعة المحلّية.
//
// مسار التزويد بالسرّ: المُثبِّت (install.ps1) يولّد السرّ، يحفظه في config.json
// للجسر، ويفتح المتصفح على `<cloudUrl>/?bridge=<secret>`. main.tsx يلتقطه ويحفظه هنا.

const STORAGE_KEY = "alroya:bridge-secret";
const DEFAULT_PORT = 9101;
const ENDPOINT_BASE = `http://127.0.0.1:${DEFAULT_PORT}`;
const CACHE_TTL_MS = 30_000;

export interface BridgeStatus {
  available: boolean;
  checkedAt: number;
  version?: string;
  receiptConfigured?: boolean;
  labelConfigured?: boolean;
  receiptOnline?: boolean;
  labelOnline?: boolean;
}

let statusCache: BridgeStatus | null = null;

// ─── secret storage ──────────────────────────────────────────────────────

export function getBridgeSecret(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setBridgeSecret(secret: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, secret);
  } catch {
    /* private mode or full storage — fail silent, prints will fall back */
  }
  statusCache = null;
}

export function clearBridgeSecret(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  statusCache = null;
}

/**
 * Look for `?bridge=<secret>` on the current URL (set by install.ps1's final step)
 * and persist it to localStorage. Then clean the URL so the secret never appears
 * in browser history or share links. Returns true if a secret was ingested.
 */
export function ingestBridgeSecretFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(window.location.href);
    const secret = url.searchParams.get("bridge");
    if (!secret) return false;
    setBridgeSecret(secret);
    url.searchParams.delete("bridge");
    window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
    return true;
  } catch {
    return false;
  }
}

// ─── HMAC + base64 ───────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function hmacHex(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const arr = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

// ─── health / availability ──────────────────────────────────────────────

export async function fetchBridgeStatus(force = false): Promise<BridgeStatus> {
  if (statusCache && !force && Date.now() - statusCache.checkedAt < CACHE_TTL_MS) {
    return statusCache;
  }
  try {
    const r = await fetch(`${ENDPOINT_BASE}/health`, {
      method: "GET",
      mode: "cors",
      // health endpoint doesn't require HMAC — used by the UI to show online indicator
      credentials: "omit",
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const data = (await r.json()) as {
      version?: string;
      receiptConfigured?: boolean;
      labelConfigured?: boolean;
      receiptOnline?: boolean;
      labelOnline?: boolean;
    };
    statusCache = {
      available: true,
      checkedAt: Date.now(),
      version: data.version,
      receiptConfigured: data.receiptConfigured,
      labelConfigured: data.labelConfigured,
      receiptOnline: data.receiptOnline,
      labelOnline: data.labelOnline,
    };
    return statusCache;
  } catch {
    statusCache = { available: false, checkedAt: Date.now() };
    return statusCache;
  }
}

/** Quick check used by print.ts to decide whether to route via the local bridge. */
export async function isLocalBridgeEnabled(force = false): Promise<boolean> {
  if (!getBridgeSecret()) return false;
  const s = await fetchBridgeStatus(force);
  return s.available;
}

// ─── print ───────────────────────────────────────────────────────────────

type PrintKind = "receipt" | "label" | "raw";

export interface SendResult {
  ok: boolean;
  jobId?: string;
  mode?: string;
  error?: string;
}

export async function sendToLocalBridge(
  bytes: Uint8Array,
  kind: PrintKind = "receipt",
  jobName?: string,
): Promise<SendResult> {
  const secret = getBridgeSecret();
  if (!secret) return { ok: false, error: "الجسر غير مُكوَّن (لا سرّ)" };
  const body = JSON.stringify({ kind, bytesB64: bytesToBase64(bytes), jobName });
  let sig: string;
  try {
    sig = await hmacHex(body, secret);
  } catch (e) {
    return { ok: false, error: `HMAC error: ${(e as Error).message}` };
  }
  try {
    const r = await fetch(`${ENDPOINT_BASE}/print`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json", "X-Alroya-Sig": sig },
      body,
    });
    const data = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      jobId?: string;
      mode?: string;
      error?: string;
    };
    if (!r.ok || !data.ok) {
      return { ok: false, error: data.error ?? `bridge HTTP ${r.status}` };
    }
    return { ok: true, jobId: data.jobId, mode: data.mode };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

export async function localBridgeTestPrint(kind: "receipt" | "label" = "receipt"): Promise<SendResult> {
  const secret = getBridgeSecret();
  if (!secret) return { ok: false, error: "الجسر غير مُكوَّن" };
  const body = JSON.stringify({ kind });
  const sig = await hmacHex(body, secret);
  try {
    const r = await fetch(`${ENDPOINT_BASE}/test-print`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json", "X-Alroya-Sig": sig },
      body,
    });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !data.ok) return { ok: false, error: data.error ?? `${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

export async function localBridgeOpenDrawer(): Promise<SendResult> {
  const secret = getBridgeSecret();
  if (!secret) return { ok: false, error: "الجسر غير مُكوَّن" };
  const body = "{}";
  const sig = await hmacHex(body, secret);
  try {
    const r = await fetch(`${ENDPOINT_BASE}/open-drawer`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json", "X-Alroya-Sig": sig },
      body,
    });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !data.ok) return { ok: false, error: data.error ?? `${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}
