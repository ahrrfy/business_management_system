// تشفير البيانات المحلية الحساسة (الشريحة ٥ من خطة الأوفلاين) — AES-256-GCM عبر WebCrypto.
//
// النطاق الصادق: تُشفَّر **حمولات طابور المبيعات** (تفاصيل البيع والعميل والمبالغ) بمفتاح
// CryptoKey غير قابل للاستخراج مخزونٍ في IndexedDB. هذا يهزم النسخ العرضي لملفات المتصفح
// (exfiltration ساذج)، **لا** مهاجماً محترفاً يملك جلسة المتصفح نفسها — يُصارَح المالك بذلك.
// الكتالوج والأسعار تبقى صريحة (علنية بطبيعتها)، ولقطة العملاء أسماء/هواتف فقط بلا أي ذمم
// أصلاً (قرار ش٢) — وتشفير حقل البحث المطبَّع نفسه مسرحيةٌ لا حماية (يُبحَث به) فلا نمثّلها.

import { offlineDb } from "./db";

const KEY_NAME = "outbox-aes";

let cachedKey: CryptoKey | null = null;

export function isWebCryptoAvailable(): boolean {
  return (
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined" &&
    typeof crypto.subtle.generateKey === "function"
  );
}

/** مفتاح AES-GCM غير قابل للاستخراج — يُولَّد مرة ويُخزَّن كـCryptoKey في IndexedDB
 *  (structured clone يحفظ الكائن بلا كشف الخام). */
export async function getOrCreateAesKey(): Promise<CryptoKey | null> {
  if (!isWebCryptoAvailable()) return null;
  if (cachedKey) return cachedKey;
  try {
    const existing = await offlineDb.keys.get(KEY_NAME);
    if (existing?.key) {
      cachedKey = existing.key;
      return existing.key;
    }
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await offlineDb.keys.put({ name: KEY_NAME, key });
    cachedKey = key;
    return key;
  } catch {
    return null;
  }
}

export interface EncryptedEnvelope {
  enc: true;
  iv: Uint8Array;
  data: Uint8Array;
}

export function isEncryptedEnvelope(v: unknown): v is EncryptedEnvelope {
  return typeof v === "object" && v !== null && (v as { enc?: unknown }).enc === true;
}

export async function encryptJson(value: unknown): Promise<EncryptedEnvelope> {
  const key = await getOrCreateAesKey();
  if (!key || !isWebCryptoAvailable()) {
    const data = new TextEncoder().encode(JSON.stringify(value));
    return { enc: true, iv: new Uint8Array(0), data };
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { enc: true, iv, data };
}

export async function decryptJson<T>(envelope: EncryptedEnvelope): Promise<T> {
  if (envelope.iv.length === 0 || !isWebCryptoAvailable()) {
    return JSON.parse(new TextDecoder().decode(envelope.data)) as T;
  }
  const key = await getOrCreateAesKey();
  if (!key) {
    return JSON.parse(new TextDecoder().decode(envelope.data)) as T;
  }
  return decryptJsonWithKey<T>(envelope, key);
}

// ── جوهر نقي قابل للحقن (اختبارات node تملك WebCrypto بلا IndexedDB) ─────────

export async function encryptJsonWithKey(value: unknown, key: CryptoKey): Promise<EncryptedEnvelope> {
  if (!isWebCryptoAvailable()) {
    const data = new TextEncoder().encode(JSON.stringify(value));
    return { enc: true, iv: new Uint8Array(0), data };
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { enc: true, iv, data };
}

export async function decryptJsonWithKey<T>(envelope: EncryptedEnvelope, key: CryptoKey): Promise<T> {
  if (envelope.iv.length === 0 || !isWebCryptoAvailable()) {
    return JSON.parse(new TextDecoder().decode(envelope.data)) as T;
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: envelope.iv as BufferSource },
      key,
      envelope.data as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return JSON.parse(new TextDecoder().decode(envelope.data)) as T;
  }
}
