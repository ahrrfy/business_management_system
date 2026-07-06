/**
 * TOTP (RFC 6238) فوق HOTP (RFC 4226) بـ`node:crypto` خالصاً — بلا اعتمادية خارجية.
 * متوافق مع Google Authenticator وأشباهه: HMAC-SHA1، خطوة ٣٠ ثانية، ٦ أرقام.
 * وحدة خالصة (بلا DB/شبكة) — التخزين والتشفير مسؤولية twoFactorService.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** أبجدية base32 (RFC 4648) — تطبيقات Authenticator تتوقّع السرّ بها. */
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  // حلقة فهرسية (لا for..of) — هدف tsc في المشروع أدنى من es2015 iteration للـBuffer.
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // بلا حشو "=" — otpauth لا يستعمله وGoogle Authenticator يقبله هكذا.
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("base32: محرف غير صالح");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** سرّ جديد: ٢٠ بايت عشوائية (توصية RFC 4226 §4 لسرّ SHA1) ⇒ ٣٢ محرف base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;

/** HOTP (RFC 4226): HMAC-SHA1(secret, counter BE64) → dynamic truncation → mod 10^digits. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin =
    ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * يتحقّق من رمز TOTP بنافذة ±window خطوة (الافتراضي ±1 = ±٣٠ث انحراف ساعة مقبول).
 * يعيد **رقم الخطوة المطابقة** (لتخزينها في users.totpLastUsedStep ومنع replay) أو null.
 * نفحص كل خطوات النافذة دائماً (لا خروج مبكّر) + timingSafeEqual ⇒ توقيت ثابت.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { window?: number; stepSec?: number; nowMs?: number } = {}
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const window = opts.window ?? 1;
  const step = opts.stepSec ?? TOTP_STEP_SEC;
  let secret: Buffer;
  try {
    secret = base32Decode(secretB32);
  } catch {
    return null;
  }
  if (secret.length === 0) return null;
  const t = Math.floor((opts.nowMs ?? Date.now()) / 1000 / step);
  let matched: number | null = null;
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(secret, t + w));
    const given = Buffer.from(code);
    if (expected.length === given.length && timingSafeEqual(expected, given) && matched === null) {
      matched = t + w;
    }
  }
  return matched;
}

/**
 * رابط otpauth:// الذي يرسمه QR ويستورده تطبيق الهاتف.
 * issuer لاتيني عمداً — أوسع توافقاً مع تطبيقات Authenticator من نصّ عربي في الـURI.
 */
export function buildOtpauthUri(account: string, secretB32: string, issuer = "Alroya ERP"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SEC}`;
}

/** أبجدية رموز الاسترداد — بلا محارف ملتبسة (0/O، 1/I/L). */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** رمز استرداد بصيغة XXXXX-XXXXX (~٤٩ بت عشوائية) — يُعرَض مرّة واحدة ثم يُخزَّن مُجزّأً. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) {
    // rejection-free: 31 قيمة أبجدية من بايت 256 ⇒ انحياز modulo ضئيل (~0.4%) ومقبول
    // لرمز استرداد ٤٩+ بت؛ التبسيط أولى من قارئ crypto.randomInt في حلقة hot-path نادرة.
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    if (i === 4) out += "-";
  }
  return out;
}

/** تطبيع رمز الاسترداد قبل التجزئة/المقارنة: uppercase + إسقاط الشرطات والمسافات. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}
