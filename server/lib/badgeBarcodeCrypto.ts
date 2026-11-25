import { createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";

const BADGE_HKDF_INFO = "alroya:badge-barcode:v1";
const DEV_FALLBACK_SECRET = "alroya-dev-local-badge-secret-v1";

function resolveBadgeKey(): Buffer {
  const secret = process.env.JWT_SECRET?.trim() || DEV_FALLBACK_SECRET;
  return Buffer.from(hkdfSync("sha256", secret, "", BADGE_HKDF_INFO, 32));
}

/** يطبّع رمز شارة المدير الممسوح قبل حساب البصمة أو المقارنة. */
export function normalizeBadgeBarcode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * يحسب بصمة HMAC-SHA256 أحادية الاتجاه بطول 64 محرفاً سداسياً عشرياً (تلائم `varchar(64) UNIQUE`
 * دون هجرة مخطط، ومنفصلة تماماً عن بادئة `MGR-` النصية).
 */
export function hashBadgeBarcode(rawBarcode: string): string {
  const normalized = normalizeBadgeBarcode(rawBarcode);
  return createHmac("sha256", resolveBadgeKey()).update(normalized).digest("hex");
}

/** يولّد شارة مدير عالية العشوائية (16 رقماً عشوائياً مشفراً ≈ 53 بت) متوافقة مع ماسحات Code128. */
export function generateHighEntropyBadgeCode(userId: number): string {
  let digits = "";
  for (let i = 0; i < 16; i += 1) {
    digits += String(randomInt(0, 10));
  }
  return `MGR-${userId}-${digits}`;
}

/** مقارنة زمن-ثابت تدعم البصمات المشفّرة (`64 hex`) والشارات المطبوعة سابقاً (`MGR-...`) بلا انقطاع. */
export function matchesStoredBadgeBarcode(
  storedValue: string | null | undefined,
  presentedRawBarcode: string,
): boolean {
  if (!storedValue) return false;
  const normalized = normalizeBadgeBarcode(presentedRawBarcode);
  if (!normalized) return false;
  const expectedHash = hashBadgeBarcode(normalized);
  const storedBuf = Buffer.from(storedValue, "utf8");
  const hashBuf = Buffer.from(expectedHash, "utf8");
  if (storedBuf.length === hashBuf.length && timingSafeEqual(storedBuf, hashBuf)) {
    return true;
  }
  const legacyBuf = Buffer.from(storedValue.trim().toUpperCase(), "utf8");
  const normBuf = Buffer.from(normalized, "utf8");
  return legacyBuf.length === normBuf.length && timingSafeEqual(legacyBuf, normBuf);
}
