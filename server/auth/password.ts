import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing using Node's built-in scrypt (no external dependency).
 * Stored format: "<saltHex>:<hashHex>".
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = scryptSync(plain, salt, 64);
  // كل تجزّئات الإنتاج 64 بايت ثابتة؛ فحص الطول حارس ضدّ رمي timingSafeEqual فقط.
  return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf);
}

/**
 * تجزّئة وهمية صالحة تُحسب مرّة عند تحميل الوحدة. يستعملها مسار تسجيل الدخول
 * عند غياب المستخدم كي يمرّ بكامل تكلفة scrypt — فيتساوى زمن الردّ بين «بريد
 * موجود بكلمة خاطئة» و«بريد غير موجود»، ويُغلق قناة تعداد المستخدمين الزمنية.
 */
export const DUMMY_STORED = hashPassword("__alroya_timing_dummy__");
