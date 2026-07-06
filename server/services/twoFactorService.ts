/**
 * خدمة المصادقة الثنائية (TOTP + رموز استرداد) — منطق التخزين والتحقّق الذرّي.
 *
 * المبادئ:
 *  - سرّ TOTP يُخزَّن مشفَّراً AES-256-GCM (cryptoService، مفتاح INTEGRATIONS_ENCRYPTION_KEY)
 *    — لا يُعاد للعميل أبداً بعد التفعيل، ويُحجب من auth.me في الراوتر.
 *  - منع replay: totpLastUsedStep يتقدّم ذرّياً داخل معاملة بقفل صفّ المستخدم —
 *    طلبان متسابقان بنفس الرمز لا يمرّان معاً.
 *  - رموز الاسترداد: ١٠ أحادية الاستخدام، تُعرَض مرّة واحدة، تُخزَّن scrypt
 *    (نفس صيغة كلمات المرور). التحقّق ≤ ١٠ × scrypt (~أقل من ثانية) — مسار نادر.
 *  - عدّ المحاولات الخاطئة على قفل الحساب نفسه مسؤولية الراوتر (registerFailedLogin).
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { userRecoveryCodes, users, type User } from "../../drizzle/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  buildOtpauthUri,
  generateRecoveryCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotp,
} from "../auth/totp";
import type { Tx } from "../db";
import { decryptSecret, encryptSecret, isCryptoReady } from "./cryptoService";
import { requireDb, withTx } from "./tx";

const RECOVERY_CODES_COUNT = 10;

const CRYPTO_NOT_READY_MSG =
  "المصادقة الثنائية تتطلّب ضبط مفتاح التشفير (INTEGRATIONS_ENCRYPTION_KEY) على الخادم — راجع مدير النظام.";

export type TwoFactorStatus = {
  enabled: boolean;
  enabledAt: Date | null;
  pending: boolean;
  recoveryCodesRemaining: number;
  cryptoReady: boolean;
};

export async function getTwoFactorStatus(userId: number): Promise<TwoFactorStatus> {
  const db = requireDb();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const u = rows[0];
  const enabled = !!u?.totpEnabledAt;
  let recoveryCodesRemaining = 0;
  if (enabled) {
    const codes = await db
      .select({ id: userRecoveryCodes.id })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    recoveryCodesRemaining = codes.length;
  }
  return {
    enabled,
    enabledAt: u?.totpEnabledAt ?? null,
    pending: !!u?.totpSecretEncrypted && !u?.totpEnabledAt,
    recoveryCodesRemaining,
    cryptoReady: isCryptoReady(),
  };
}

/**
 * بدء التسجيل: سرّ جديد يُخزَّن مشفَّراً بحالة «معلّق» (totpEnabledAt=null — لا يُفرض عند
 * الدخول حتى يُؤكَّد برمز صحيح). يستبدل أي سرّ معلّق سابق. كلمة المرور تُتحقَّق في الراوتر.
 */
export async function startTwoFactorSetup(user: User): Promise<{ secretB32: string; otpauthUri: string }> {
  if (!isCryptoReady()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: CRYPTO_NOT_READY_MSG });
  if (user.totpEnabledAt) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المصادقة الثنائية مفعّلة أصلاً — عطّلها أولاً لإعادة الربط." });
  }
  const secret = generateTotpSecret();
  const db = requireDb();
  await db
    .update(users)
    .set({ totpSecretEncrypted: encryptSecret(secret), totpEnabledAt: null, totpLastUsedStep: null })
    .where(eq(users.id, user.id));
  const account = user.email ?? user.username ?? `user-${user.id}`;
  return { secretB32: secret, otpauthUri: buildOtpauthUri(account, secret) };
}

/** توليد دفعة رموز استرداد وإدراج تجزئاتها (يفترض معاملة جارية tx). */
async function issueRecoveryCodes(tx: Tx, userId: number): Promise<string[]> {
  await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  const codes = Array.from({ length: RECOVERY_CODES_COUNT }, () => generateRecoveryCode());
  await tx
    .insert(userRecoveryCodes)
    .values(codes.map((c) => ({ userId, codeHash: hashPassword(normalizeRecoveryCode(c)) })));
  return codes;
}

/**
 * تأكيد التسجيل برمز من التطبيق ⇒ تفعيل فعلي + إصدار رموز الاسترداد (تُعرَض مرّة واحدة).
 * داخل معاملة بقفل صفّ المستخدم — تأكيدان متسابقان لا يفعّلان مرّتين.
 */
export async function confirmTwoFactorSetup(userId: number, code: string): Promise<{ recoveryCodes: string[] }> {
  return withTx(async (tx) => {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    const u = rows[0];
    if (!u?.totpSecretEncrypted || u.totpEnabledAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد تسجيل مصادقة ثنائية معلّق — ابدأ التفعيل من جديد." });
    }
    let secret: string | null = null;
    try {
      secret = decryptSecret(u.totpSecretEncrypted);
    } catch {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: CRYPTO_NOT_READY_MSG });
    }
    const matched = secret ? verifyTotp(secret, code) : null;
    if (matched == null) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "رمز التحقق غير صحيح — تأكّد من مزامنة وقت الهاتف وأعد المحاولة." });
    }
    await tx
      .update(users)
      .set({ totpEnabledAt: new Date(), totpLastUsedStep: matched })
      .where(eq(users.id, userId));
    const recoveryCodes = await issueRecoveryCodes(tx, userId);
    return { recoveryCodes };
  });
}

/**
 * استهلاك رمز TOTP عند الدخول/التعطيل: تحقّق + تقدّم totpLastUsedStep ذرّياً (منع replay
 * لنفس الرمز داخل نافذة ±1 وضدّ السباق). يعيد false بصمت — عدّ الفشل مسؤولية المستدعي.
 */
export async function consumeTotpCode(userId: number, code: string): Promise<boolean> {
  return withTx(async (tx) => {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    const u = rows[0];
    if (!u?.totpEnabledAt || !u.totpSecretEncrypted) return false;
    let secret: string | null = null;
    try {
      secret = decryptSecret(u.totpSecretEncrypted);
    } catch {
      return false;
    }
    const matched = secret ? verifyTotp(secret, code) : null;
    if (matched == null) return false;
    if (u.totpLastUsedStep != null && matched <= u.totpLastUsedStep) return false;
    await tx.update(users).set({ totpLastUsedStep: matched }).where(eq(users.id, userId));
    return true;
  });
}

/** استهلاك رمز استرداد (أحادي الاستخدام حتى تحت السباق — قفل صفوف + usedAt). */
export async function consumeRecoveryCode(
  userId: number,
  rawCode: string
): Promise<{ ok: boolean; remaining: number }> {
  const normalized = normalizeRecoveryCode(rawCode);
  if (!normalized) return { ok: false, remaining: 0 };
  return withTx(async (tx) => {
    const rows = await tx
      .select()
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)))
      .for("update");
    const hit = rows.find((r) => verifyPassword(normalized, r.codeHash));
    if (!hit) return { ok: false, remaining: rows.length };
    await tx.update(userRecoveryCodes).set({ usedAt: new Date() }).where(eq(userRecoveryCodes.id, hit.id));
    return { ok: true, remaining: rows.length - 1 };
  });
}

/** تعطيل 2FA بالكامل + حذف رموز الاسترداد (يستعمله المستخدم بعد تحقّق الراوتر، والأدمن للإنقاذ). */
export async function disableTwoFactor(userId: number): Promise<void> {
  await withTx(async (tx) => {
    await tx
      .update(users)
      .set({ totpSecretEncrypted: null, totpEnabledAt: null, totpLastUsedStep: null })
      .where(eq(users.id, userId));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  });
}

/** إعادة توليد رموز الاسترداد (تُبطل القديمة كلها) — تتطلّب 2FA مفعّلة. */
export async function regenerateRecoveryCodes(userId: number): Promise<{ recoveryCodes: string[] }> {
  return withTx(async (tx) => {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!rows[0]?.totpEnabledAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المصادقة الثنائية غير مفعّلة." });
    }
    const recoveryCodes = await issueRecoveryCodes(tx, userId);
    return { recoveryCodes };
  });
}
