/**
 * قفل حسابٍ دائم مشترك بين مسارات كلمة المرور و2FA والتحقّق الإضافي.
 *
 * هذا القفل محفوظ في قاعدة البيانات، لا في ذاكرة العامل؛ لذلك لا يضيع عند
 * تعدد العمال أو إعادة التشغيل. نأخذ قفل الصف قبل حساب العداد حتى لا تجعل
 * محاولتان متوازيتان العداد يتراجع أو تتجاوزان حد القفل.
 */
import { eq } from "drizzle-orm";

import { users } from "../../drizzle/schema";
import { logger } from "../logger";
import { requireDb, withTx } from "./tx";

export const ACCOUNT_AUTH_FAILURE_THRESHOLD = 5;
export const ACCOUNT_AUTH_LOCK_MS = 15 * 60 * 1000;

export function isAccountAuthenticationLocked(user: {
  lockedUntil?: Date | null;
} | null | undefined): boolean {
  return Boolean(
    user?.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now(),
  );
}

/** يسجّل إخفاقاً واحداً بصورة ذرّية. عطل كتابة القفل لا يحجب رسالة التحقق الأصلية. */
export async function recordAccountAuthenticationFailure(userId: number): Promise<void> {
  try {
    await withTx(async (tx) => {
      const [user] = await tx
        .select({
          id: users.id,
          failedLoginAttempts: users.failedLoginAttempts,
          lastFailedLoginAt: users.lastFailedLoginAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for("update")
        .limit(1);
      if (!user) return;

      const now = Date.now();
      const last = user.lastFailedLoginAt
        ? new Date(user.lastFailedLoginAt).getTime()
        : 0;
      const stale = now - last > ACCOUNT_AUTH_LOCK_MS;
      const attempts = (stale ? 0 : (user.failedLoginAttempts ?? 0)) + 1;
      const patch = attempts >= ACCOUNT_AUTH_FAILURE_THRESHOLD
        ? {
            failedLoginAttempts: 0,
            lockedUntil: new Date(now + ACCOUNT_AUTH_LOCK_MS),
            lastFailedLoginAt: new Date(now),
          }
        : {
            failedLoginAttempts: attempts,
            lastFailedLoginAt: new Date(now),
          };
      await tx.update(users).set(patch).where(eq(users.id, userId));
    });
  } catch (error) {
    logger.warn({ err: error, userId }, "auth.lockout.update_failed");
  }
}

/** النجاح في عامل مصادقة حقيقي فقط هو ما يصفر العداد المشترك. */
export async function clearAccountAuthenticationFailures(userId: number): Promise<void> {
  try {
    const db = requireDb();
    await db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
      })
      .where(eq(users.id, userId));
  } catch (error) {
    logger.warn({ err: error, userId }, "auth.lockout.clear_failed");
  }
}
