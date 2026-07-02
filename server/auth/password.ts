import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Password hashing using Node's built-in scrypt (no external dependency).
 * Stored format: "<N>:<r>:<p>:<keylen>:<saltHex>:<hashHex>" (يحمل إعدادات scrypt
 * نفسها) — يسمح بتغيير SCRYPT_OPTIONS مستقبلاً دون كسر التحقّق من التجزّئات القديمة.
 * التنسيق القديم "<saltHex>:<hashHex>" (بلا إعدادات) لا يزال يُتحقَّق منه بإعدادات
 * SCRYPT_OPTIONS الحالية للتوافق الرجعي.
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString("hex");
  const { N, r, p } = SCRYPT_OPTIONS;
  return `${N}:${r}:${p}:${SCRYPT_KEYLEN}:${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(":");

  let salt: string, hash: string, N: number, r: number, p: number, keylen: number;
  if (parts.length === 6) {
    [N, r, p, keylen, salt, hash] = [
      Number(parts[0]),
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
      parts[4],
      parts[5],
    ];
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !Number.isFinite(keylen)) {
      return false;
    }
  } else if (parts.length === 2) {
    // تنسيق قديم بلا إعدادات مخزَّنة — رجوعاً للإعدادات الحالية.
    [salt, hash] = parts;
    ({ N, r, p } = SCRYPT_OPTIONS);
    keylen = SCRYPT_KEYLEN;
  } else {
    return false;
  }
  if (!salt || !hash) return false;

  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = scryptSync(plain, salt, keylen, { N, r, p, maxmem: SCRYPT_OPTIONS.maxmem });
  // كل تجزّئات الإنتاج 64 بايت ثابتة؛ فحص الطول حارس ضدّ رمي timingSafeEqual فقط.
  return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf);
}

/**
 * تجزّئة وهمية صالحة تُحسب مرّة عند تحميل الوحدة. يستعملها مسار تسجيل الدخول
 * عند غياب المستخدم كي يمرّ بكامل تكلفة scrypt — فيتساوى زمن الردّ بين «بريد
 * موجود بكلمة خاطئة» و«بريد غير موجود»، ويُغلق قناة تعداد المستخدمين الزمنية.
 */
export const DUMMY_STORED = hashPassword("__alroya_timing_dummy__");
