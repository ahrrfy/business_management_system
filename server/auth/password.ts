import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Password hashing using Node's built-in scrypt (no external dependency).
 * Stored format: "<saltHex>:<hashHex>".
 * TODO: الـformat الحالي لا يخزّن N/r/p؛ التجزّئات القديمة تُجدَّد طبيعياً عند تغيير
 * كلمة المرور التالي (changePassword) لأنّ hashPassword يكتب بالإعدادات الجديدة.
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  // كل تجزّئات الإنتاج 64 بايت ثابتة؛ فحص الطول حارس ضدّ رمي timingSafeEqual فقط.
  return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf);
}

/**
 * تجزّئة وهمية صالحة تُحسب مرّة عند تحميل الوحدة. يستعملها مسار تسجيل الدخول
 * عند غياب المستخدم كي يمرّ بكامل تكلفة scrypt — فيتساوى زمن الردّ بين «بريد
 * موجود بكلمة خاطئة» و«بريد غير موجود»، ويُغلق قناة تعداد المستخدمين الزمنية.
 */
export const DUMMY_STORED = hashPassword("__alroya_timing_dummy__");
