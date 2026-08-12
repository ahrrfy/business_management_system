import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { hashPassword, verifyPassword } from "../../auth/password";
import { getDb } from "../../db";
import {
  changePassword,
  resetUserPassword,
  resetUserTwoFactor,
  setUserActive,
} from "../userService";
import {
  PASSWORD_RESET_GENERIC_ERROR,
  PASSWORD_RESET_MAX_ATTEMPTS,
  consumePasswordResetToken,
  hashPasswordResetToken,
  issuePasswordResetToken,
  parsePasswordResetToken,
  recoverLastAdminAccess,
} from "../passwordResetService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function resetAndSeed() {
  const d = db();
  // SET FOREIGN_KEY_CHECKS is connection-local; keep cleanup on one transaction connection.
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const table of [
      "auditLogs",
      "passwordResetTokens",
      "userSessions",
      "users",
      "branches",
    ]) {
      await tx.execute(sql.raw(`DELETE FROM \`${table}\``));
    }
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await d
    .insert(schema.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(schema.users).values([
    {
      id: 1,
      openId: "local_admin",
      name: "المدير",
      email: "admin@test.local",
      username: "admin",
      passwordHash: await hashPassword("OldAdmin!123"),
      role: "admin",
      isOwner: true,
      isActive: true,
      branchId: 1,
    },
    {
      id: 2,
      openId: "local_user",
      name: "المستخدم",
      email: "user@test.local",
      username: "employee",
      passwordHash: await hashPassword("OldUser!123"),
      role: "cashier",
      isActive: true,
      branchId: 1,
    },
  ]);
}

const actor = { userId: 1, branchId: 1, role: "admin" };

function wrongTokenWithSameLookup(token: string): string {
  const parsed = parsePasswordResetToken(token);
  if (!parsed) throw new Error("generated token was malformed");
  return `PR1-${parsed.lookupId}-${"A".repeat(43)}`;
}

beforeEach(resetAndSeed);

describe("password reset tokens — hostile lifecycle", () => {
  it("prevents a non-owner admin from taking over the owner account", async () => {
    await db().update(schema.users).set({ role: "admin", isOwner: false }).where(eq(schema.users.id, 2));
    const nonOwnerAdmin = { userId: 2, branchId: 1, role: "admin", isOwner: false };
    await expect(issuePasswordResetToken(1, nonOwnerAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resetUserPassword(1, "Takeover!123", nonOwnerAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      resetUserTwoFactor(1, nonOwnerAdmin, { user: null, req: {} as never }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stores SHA-256 only and invalidates an older token on issuance", async () => {
    const first = await issuePasswordResetToken(2, actor);
    const second = await issuePasswordResetToken(2, actor);
    expect(first.token).not.toBe(second.token);

    const rows = await db()
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, 2));
    expect(rows).toHaveLength(2);
    const oldRow = rows.find(
      (row) => row.tokenHash === hashPasswordResetToken(first.token),
    );
    const newRow = rows.find(
      (row) => row.tokenHash === hashPasswordResetToken(second.token),
    );
    expect(oldRow?.invalidatedAt).not.toBeNull();
    expect(newRow?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(newRow?.tokenHash).not.toContain(second.token);
    expect(newRow?.lookupId).toHaveLength(16);
    await expect(
      consumePasswordResetToken(first.token, "NewUser!123"),
    ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);
  });

  it("expires after TTL and returns the same generic error", async () => {
    const issued = await issuePasswordResetToken(2, actor);
    await db()
      .update(schema.passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.passwordResetTokens.userId, 2));
    await expect(
      consumePasswordResetToken(issued.token, "NewUser!123"),
    ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);
    const row = (
      await db()
        .select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.userId, 2))
    )[0];
    expect(row.invalidatedAt).not.toBeNull();
  });

  it("counts a wrong secret against its random lookup and locks it after the limit", async () => {
    const issued = await issuePasswordResetToken(2, actor);
    const wrong = wrongTokenWithSameLookup(issued.token);
    for (let attempt = 0; attempt < PASSWORD_RESET_MAX_ATTEMPTS; attempt += 1) {
      await expect(
        consumePasswordResetToken(wrong, "NewUser!123"),
      ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);
    }
    const row = (
      await db()
        .select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.userId, 2))
    )[0];
    expect(row.failedAttempts).toBe(PASSWORD_RESET_MAX_ATTEMPTS);
    expect(row.invalidatedAt).not.toBeNull();
    await expect(
      consumePasswordResetToken(issued.token, "NewUser!123"),
    ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);
  });

  it("consumes once, changes the password, and explicitly revokes every session", async () => {
    const issued = await issuePasswordResetToken(2, actor);
    await db()
      .insert(schema.userSessions)
      .values({
        userId: 2,
        userAgent: "hostile-test",
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 60_000),
      });
    await consumePasswordResetToken(issued.token, "NewUser!123");

    const user = (
      await db().select().from(schema.users).where(eq(schema.users.id, 2))
    )[0];
    const session = (
      await db()
        .select()
        .from(schema.userSessions)
        .where(eq(schema.userSessions.userId, 2))
    )[0];
    expect(await verifyPassword("NewUser!123", user.passwordHash)).toBe(true);
    expect(user.sessionsValidFrom).toBeTruthy();
    expect(session.revokedAt).not.toBeNull();
    await expect(
      consumePasswordResetToken(issued.token, "Another!123"),
    ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);
  });

  it("allows exactly one of two concurrent consumers to win", async () => {
    const issued = await issuePasswordResetToken(2, actor);
    const results = await Promise.allSettled([
      consumePasswordResetToken(issued.token, "ConcurrentA!123"),
      consumePasswordResetToken(issued.token, "ConcurrentB!123"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const row = (
      await db()
        .select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.userId, 2))
    )[0];
    expect(row.consumedAt).not.toBeNull();
  });

  it("keeps issuance and consumption on one lock order without surfacing a DB deadlock", async () => {
    const issued = await issuePasswordResetToken(2, actor);
    const results = await Promise.allSettled([
      issuePasswordResetToken(2, actor),
      consumePasswordResetToken(issued.token, "NoDeadlock!123"),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(String(result.reason)).not.toMatch(/ER_LOCK_DEADLOCK|deadlock/i);
      }
    }
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });

  it("invalidates issued tokens when an admin resets, the user changes, or the account is disabled", async () => {
    const adminReset = await issuePasswordResetToken(2, actor);
    await resetUserPassword(2, "AdminChanged!123", actor);
    await expect(
      consumePasswordResetToken(adminReset.token, "ShouldFail!123"),
    ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);

    const selfChange = await issuePasswordResetToken(2, actor);
    await changePassword(2, "AdminChanged!123", "SelfChanged!123");
    await expect(
      consumePasswordResetToken(selfChange.token, "ShouldFail!123"),
    ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);

    const disabled = await issuePasswordResetToken(2, actor);
    await setUserActive(2, false, actor);
    await expect(
      consumePasswordResetToken(disabled.token, "ShouldFail!123"),
    ).rejects.toThrow(PASSWORD_RESET_GENERIC_ERROR);
  });
});

describe("last-admin break-glass validation", () => {
  it("recovers the only active privileged target and revokes its sessions", async () => {
    await db()
      .insert(schema.userSessions)
      .values({
        userId: 1,
        userAgent: "old-admin-session",
        expiresAt: new Date(Date.now() + 60_000),
      });
    await recoverLastAdminAccess("ADMIN", "Recovered!123");
    const user = (
      await db().select().from(schema.users).where(eq(schema.users.id, 1))
    )[0];
    const session = (
      await db()
        .select()
        .from(schema.userSessions)
        .where(eq(schema.userSessions.userId, 1))
    )[0];
    expect(user.isActive).toBe(true);
    expect(await verifyPassword("Recovered!123", user.passwordHash)).toBe(true);
    expect(session.revokedAt).not.toBeNull();
  });

  it("resets 2FA only when the explicit break-glass option is supplied", async () => {
    await db()
      .update(schema.users)
      .set({
        totpSecretEncrypted: "fixture-encrypted-secret",
        totpEnabledAt: new Date(),
        totpLastUsedStep: 123,
      })
      .where(eq(schema.users.id, 1));
    await db()
      .insert(schema.userRecoveryCodes)
      .values({
        userId: 1,
        codeHash: await hashPassword("RECOVERY-CODE"),
      });

    const result = await recoverLastAdminAccess("admin", "Recovered!123", {
      resetTwoFactor: true,
    });
    const user = (
      await db().select().from(schema.users).where(eq(schema.users.id, 1))
    )[0];
    const codes = await db()
      .select()
      .from(schema.userRecoveryCodes)
      .where(eq(schema.userRecoveryCodes.userId, 1));
    expect(result.twoFactorReset).toBe(true);
    expect(user.totpSecretEncrypted).toBeNull();
    expect(user.totpEnabledAt).toBeNull();
    expect(user.totpLastUsedStep).toBeNull();
    expect(codes).toHaveLength(0);
  });

  it("refuses a non-privileged identifier and refuses while another admin is active", async () => {
    await expect(
      recoverLastAdminAccess("employee", "Recovered!123"),
    ).rejects.toThrow(/لا يخص حساب أدمن/);
    await db()
      .insert(schema.users)
      .values({
        id: 3,
        openId: "local_admin_2",
        email: "admin2@test.local",
        username: "admin2",
        passwordHash: await hashPassword("OtherAdmin!123"),
        role: "admin",
        isActive: true,
        branchId: 1,
      });
    await expect(
      recoverLastAdminAccess("admin", "Recovered!123"),
    ).rejects.toThrow(/أدمن\/مالك فعّال آخر/);
    const user = (
      await db().select().from(schema.users).where(eq(schema.users.id, 1))
    )[0];
    expect(await verifyPassword("OldAdmin!123", user.passwordHash)).toBe(true);
  });
});
