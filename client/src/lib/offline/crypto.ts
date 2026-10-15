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
  v?: 1;
  iv: Uint8Array;
  data: Uint8Array;
}

export function isEncryptedEnvelope(v: unknown): v is EncryptedEnvelope {
  return typeof v === "object" && v !== null && (v as { enc?: unknown }).enc === true;
}

/**
 * تحقّق من مغلّف التوافق الرجعي السابق للترقية (كتبَته النُسخ الأقدم عند غياب مفتاح الجهاز بـ`iv` بطول صفر ودون `v: 1`).
 * أيّ مغلّف حديث (`v === 1` أو `iv.byteLength > 0`) يخضع لإلزام `iv` ذي ١٢ بايت ومصادقة AES-GCM الكاملة بلا أي سقوط لنصّ صريح.
 */
export function isLegacyZeroIvEnvelope(envelope: EncryptedEnvelope): boolean {
  return (
    envelope.enc === true &&
    envelope.v === undefined &&
    envelope.iv instanceof Uint8Array &&
    envelope.iv.byteLength === 0 &&
    envelope.data instanceof Uint8Array
  );
}

export function decodeLegacyZeroIvEnvelope<T>(envelope: EncryptedEnvelope): T {
  if (!isLegacyZeroIvEnvelope(envelope)) {
    throw new Error("ليس مغلّف توافقٍ رجعيّ صالحاً");
  }
  return JSON.parse(new TextDecoder().decode(envelope.data)) as T;
}

export async function encryptJson(value: unknown): Promise<EncryptedEnvelope> {
  if (!isWebCryptoAvailable()) {
    throw new Error("WebCrypto غير متاح لتشفير البيانات المحلية");
  }
  const key = await getOrCreateAesKey();
  if (!key) {
    throw new Error("تعذّر الوصول إلى مفتاح التشفير المحلي");
  }
  return encryptJsonWithKey(value, key);
}

export async function decryptJson<T>(envelope: EncryptedEnvelope): Promise<T> {
  if (isLegacyZeroIvEnvelope(envelope)) {
    return decodeLegacyZeroIvEnvelope<T>(envelope);
  }
  if (!isWebCryptoAvailable()) {
    throw new Error("WebCrypto غير متاح لفك تشفير البيانات المحلية");
  }
  if (!(envelope.iv instanceof Uint8Array) || envelope.iv.byteLength !== 12) {
    throw new Error("مغلّف التشفير المحلي غير صالح (IV)");
  }
  const key = await getOrCreateAesKey();
  if (!key) {
    throw new Error("تعذّر الوصول إلى مفتاح فك التشفير المحلي");
  }
  return decryptJsonWithKey<T>(envelope, key);
}

// ── جوهر نقي قابل للحقن (اختبارات node تملك WebCrypto بلا IndexedDB) ─────────

export async function encryptJsonWithKey(value: unknown, key: CryptoKey): Promise<EncryptedEnvelope> {
  if (!isWebCryptoAvailable() || !key) {
    throw new Error("مفتاح التشفير أو WebCrypto غير متاح");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { enc: true, v: 1, iv, data };
}

export async function decryptJsonWithKey<T>(envelope: EncryptedEnvelope, key: CryptoKey): Promise<T> {
  if (!isWebCryptoAvailable() || !key) {
    throw new Error("مفتاح فك التشفير أو WebCrypto غير متاح");
  }
  if (!(envelope.iv instanceof Uint8Array) || envelope.iv.byteLength !== 12) {
    throw new Error("مغلّف التشفير المحلي غير صالح (IV)");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: envelope.iv as BufferSource },
    key,
    envelope.data as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
