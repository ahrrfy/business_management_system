import { createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";

const BADGE_HKDF_INFO = "alroya:badge-barcode:v1";
const DEV_FALLBACK_SECRET = "alroya-dev-local-badge-secret-v1";
const LEGACY_PLAINTEXT_BADGE_RE = /^MGR-\d+-\d+$/i;
const DIGEST_BADGE_RE = /^[0-9a-f]{64}$/;

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

/** هل يطابق النص صيغة رمز شارة مدير ممسوح (`MGR-<userId>-<digits>`)؟ */
export function isPlaintextManagerBadgeFormat(raw: string): boolean {
  return LEGACY_PLAINTEXT_BADGE_RE.test(raw.trim());
}

/** مقارنة زمن-ثابت تدعم البصمات المشفّرة (`64 hex`) والشارات المطبوعة سابقاً (`MGR-...`) دون قبول البصمة كرمز خام. */
export function matchesStoredBadgeBarcode(
  storedValue: string | null | undefined,
  presentedRawBarcode: string,
): boolean {
  if (!storedValue) return false;
  const normalized = normalizeBadgeBarcode(presentedRawBarcode);
  if (!LEGACY_PLAINTEXT_BADGE_RE.test(normalized)) {
    return false;
  }
  const trimmedStored = storedValue.trim();
  if (DIGEST_BADGE_RE.test(trimmedStored)) {
    const expectedHash = hashBadgeBarcode(normalized);
    const storedBuf = Buffer.from(trimmedStored, "utf8");
    const hashBuf = Buffer.from(expectedHash, "utf8");
    return storedBuf.length === hashBuf.length && timingSafeEqual(storedBuf, hashBuf);
  }
  if (LEGACY_PLAINTEXT_BADGE_RE.test(trimmedStored)) {
    const legacyBuf = Buffer.from(trimmedStored.toUpperCase(), "utf8");
    const normBuf = Buffer.from(normalized, "utf8");
    return legacyBuf.length === normBuf.length && timingSafeEqual(legacyBuf, normBuf);
  }
  return false;
}
