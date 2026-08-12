import { PASSWORD_POLICY_MSG, isStrongPassword } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  passwordResetTokens,
  userRecoveryCodes,
  userSessions,
  users,
} from "../../drizzle/schema";
import { hashPassword } from "../auth/password";
import { logAuditTx } from "./auditService";
import { withTx, type Actor } from "./tx";
import { assertCanAdministerUser } from "./userAdminPolicy";

export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;
export const PASSWORD_RESET_GENERIC_ERROR =
  "تعذّرت إعادة تعيين كلمة المرور. تحقّق من الرمز أو اطلب رمزاً جديداً من المدير.";

const TOKEN_PREFIX = "PR1";
const LOOKUP_BYTES = 12; // 96 bits; base64url => 16 chars.
const SECRET_BYTES = 32; // 256-bit secret; base64url => 43 chars.
const TOKEN_RE = /^PR1-([A-Za-z0-9_-]{16})-([A-Za-z0-9_-]{43})$/;

function tokenFailure(): TRPCError {
  return new TRPCError({
    code: "UNAUTHORIZED",
    message: PASSWORD_RESET_GENERIC_ERROR,
  });
}

/** SHA-256 فقط؛ الرمز الخام لا يغادر ذاكرة الطلب ولا يُسجَّل. */
export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createPasswordResetToken(): {
  token: string;
  lookupId: string;
  tokenHash: string;
} {
  const lookupId = randomBytes(LOOKUP_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}-${lookupId}-${secret}`;
  return { token, lookupId, tokenHash: hashPasswordResetToken(token) };
}

export function parsePasswordResetToken(
  raw: string,
): { token: string; lookupId: string } | null {
  const token = raw.trim();
  const match = TOKEN_RE.exec(token);
  return match ? { token, lookupId: match[1] } : null;
}

function hashesEqual(actualHex: string, expectedHex: string): boolean {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * يصدر الأدمن رمزاً جديداً ويُلغي كل الرموز السابقة للمستخدم في المعاملة نفسها. القيمة
 * الخام موجودة فقط في ناتج هذا الاستدعاء كي تعرضها الواجهة مرّة واحدة.
 */
export async function issuePasswordResetToken(userId: number, actor: Actor) {
  return withTx(async (tx) => {
    const target = (
      await tx
        .select({ id: users.id, isActive: users.isActive, role: users.role, isOwner: users.isOwner })
        .from(users)
        .where(eq(users.id, userId))
        .for("update")
        .limit(1)
    )[0];
    if (!target)
      throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    assertCanAdministerUser(actor, target);
    if (!target.isActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "فعّل حساب المستخدم قبل إصدار رمز استعادة.",
      });
    }

    const now = new Date();
    await tx
      .update(passwordResetTokens)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          isNull(passwordResetTokens.consumedAt),
          isNull(passwordResetTokens.invalidatedAt),
        ),
      );

    const generated = createPasswordResetToken();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
    await tx.insert(passwordResetTokens).values({
      userId,
      lookupId: generated.lookupId,
      tokenHash: generated.tokenHash,
      expiresAt,
      createdByUserId: actor.userId,
    });
    return { token: generated.token, expiresAt };
  });
}

/**
 * يستهلك الرمز مرة واحدة تحت SELECT … FOR UPDATE. قفل الصف يجعل طلبين متزامنين لا
 * يستطيعان النجاح معاً؛ النجاح يغيّر الكلمة ويُلغي الرموز الأخرى وكل الجلسات ذرياً.
 */
export async function consumePasswordResetToken(
  rawToken: string,
  newPassword: string,
  auditCtx?: Parameters<typeof logAuditTx>[1],
) {
  if (!isStrongPassword(newPassword)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: PASSWORD_POLICY_MSG });
  }

  const parsed = parsePasswordResetToken(rawToken);
  if (!parsed) {
    // عمل ثابت صغير للمُدخل المشوّه، بلا بحث بمُعرّف مستخدم وبلا تسريب سبب الفشل.
    hashPasswordResetToken(rawToken.trim());
    throw tokenFailure();
  }

  const result = await withTx(async (tx) => {
    // Establish the user id without a lock, then use the same user -> token lock order
    // as issuance. Token-first here deadlocks against issuePasswordResetToken.
    const candidate = (
      await tx
        .select({ userId: passwordResetTokens.userId })
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.lookupId, parsed.lookupId))
        .limit(1)
    )[0];
    if (!candidate) return { ok: false as const };

    const target = (
      await tx
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, candidate.userId))
        .for("update")
        .limit(1)
    )[0];
    if (!target?.isActive) return { ok: false as const };

    const row = (
      await tx
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.lookupId, parsed.lookupId))
        .for("update")
        .limit(1)
    )[0];
    if (!row || row.userId !== target.id) return { ok: false as const };

    const suppliedHash = hashPasswordResetToken(parsed.token);
    if (!hashesEqual(suppliedHash, row.tokenHash)) {
      const failedAttempts = row.failedAttempts + 1;
      await tx
        .update(passwordResetTokens)
        .set({
          failedAttempts,
          ...(failedAttempts >= PASSWORD_RESET_MAX_ATTEMPTS
            ? { invalidatedAt: new Date() }
            : {}),
        })
        .where(eq(passwordResetTokens.id, row.id));
      return { ok: false as const };
    }

    const now = new Date();
    if (
      row.consumedAt ||
      row.invalidatedAt ||
      row.failedAttempts >= PASSWORD_RESET_MAX_ATTEMPTS ||
      new Date(row.expiresAt).getTime() <= now.getTime()
    ) {
      if (!row.consumedAt && !row.invalidatedAt) {
        await tx
          .update(passwordResetTokens)
          .set({ invalidatedAt: now })
          .where(eq(passwordResetTokens.id, row.id));
      }
      return { ok: false as const };
    }

    // لا نحسب scrypt قبل إثبات أن الرمز صحيح وحيّ كي لا يصبح المسار أداة استنزاف CPU عامة.
    const passwordHash = await hashPassword(newPassword);
    await tx
      .update(users)
      .set({
        passwordHash,
        sessionsValidFrom: now,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
      })
      .where(eq(users.id, target.id));

    await tx
      .update(userSessions)
      .set({ revokedAt: now })
      .where(
        and(eq(userSessions.userId, target.id), isNull(userSessions.revokedAt)),
      );
    await tx
      .update(passwordResetTokens)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, target.id),
          ne(passwordResetTokens.id, row.id),
          isNull(passwordResetTokens.consumedAt),
          isNull(passwordResetTokens.invalidatedAt),
        ),
      );
    await tx
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(eq(passwordResetTokens.id, row.id));

    if (auditCtx) {
      await logAuditTx(tx, auditCtx, {
        action: "auth.passwordReset.completed",
        entityType: "user",
        entityId: target.id,
        newValue: { sessionsRevoked: true },
      });
    }

    return { ok: true as const, userId: target.id, resetAt: now };
  });
  if (!result.ok) throw tokenFailure();
  return { userId: result.userId, resetAt: result.resetAt };
}

/**
 * مسار break-glass للـCLI فقط. يرفض العمل ما دام هناك أدمن/مالك فعّال آخر، فلا يتحول
 * إلى طريق مختصر يتجاوز واجهة الإدارة الطبيعية. لا يُطبع أو يُسجَّل السر.
 */
export async function recoverLastAdminAccess(
  identifier: string,
  newPassword: string,
  options?: { resetTwoFactor?: boolean },
) {
  if (!isStrongPassword(newPassword)) {
    throw new Error(PASSWORD_POLICY_MSG);
  }
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) throw new Error("معرّف المدير مطلوب.");

  return withTx(async (tx) => {
    const privileged = await tx
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        role: users.role,
        isOwner: users.isOwner,
        isActive: users.isActive,
      })
      .from(users)
      .where(or(eq(users.role, "admin"), eq(users.isOwner, true)))
      .for("update");
    const target = privileged.find(
      (u) =>
        u.email?.trim().toLowerCase() === normalized ||
        u.username?.trim().toLowerCase() === normalized,
    );
    if (!target)
      throw new Error("المعرّف لا يخص حساب أدمن أو مالك في الشركة المحددة.");
    if (privileged.some((u) => u.id !== target.id && u.isActive)) {
      throw new Error(
        "يوجد أدمن/مالك فعّال آخر؛ استخدم واجهة الإدارة ولا تستعمل مسار الطوارئ.",
      );
    }

    const now = new Date();
    const passwordHash = await hashPassword(newPassword);
    const resetTwoFactor = options?.resetTwoFactor === true;
    await tx
      .update(users)
      .set({
        passwordHash,
        isActive: true,
        sessionsValidFrom: now,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        ...(resetTwoFactor
          ? {
              totpSecretEncrypted: null,
              totpEnabledAt: null,
              totpLastUsedStep: null,
            }
          : {}),
      })
      .where(eq(users.id, target.id));
    if (resetTwoFactor) {
      await tx
        .delete(userRecoveryCodes)
        .where(eq(userRecoveryCodes.userId, target.id));
    }
    await tx
      .update(userSessions)
      .set({ revokedAt: now })
      .where(
        and(eq(userSessions.userId, target.id), isNull(userSessions.revokedAt)),
      );
    await tx
      .update(passwordResetTokens)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, target.id),
          isNull(passwordResetTokens.consumedAt),
          isNull(passwordResetTokens.invalidatedAt),
        ),
      );
    await logAuditTx(
      tx,
      { user: null, req: {} as never },
      {
        action: "auth.breakGlassAdminRecovery",
        entityType: "user",
        entityId: target.id,
        newValue: {
          channel: "local_cli",
          sessionsRevoked: true,
          twoFactorReset: resetTwoFactor,
        },
      },
    );
    return { userId: target.id, twoFactorReset: resetTwoFactor };
  });
}
