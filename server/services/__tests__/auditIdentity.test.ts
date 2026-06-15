import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createUser } from "../userService";

const TABLES = ["auditLogs", "users", "branches"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedAdmin() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({
    id: 1,
    openId: "local_admin",
    name: "المدير",
    email: "admin@test.local",
    passwordHash: hashPassword("Admin@12345"),
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  return (await d.select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
}

function makeCtx(user: any = null) {
  const res = { cookie() {}, clearCookie() {} };
  const req = { headers: {} as Record<string, string> };
  return { req, res, user } as any;
}

/** يجلب أحدث صفّ تدقيق بفعل معيّن. */
async function lastAudit(action: string) {
  const rows = await db()
    .select()
    .from(s.auditLogs)
    .where(eq(s.auditLogs.action, action))
    .orderBy(sql`${s.auditLogs.id} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

beforeEach(async () => {
  await reset();
});

describe("تدقيق أحداث الهوية/المصادقة", () => {
  it("auth.login الناجح يكتب سطر تدقيق بالمستخدم", async () => {
    await seedAdmin();
    const caller = appRouter.createCaller(makeCtx());
    await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    const row = await lastAudit("auth.login");
    expect(row).toBeTruthy();
    expect(Number(row.entityId)).toBe(1);
    expect(Number(row.userId)).toBe(1);
  });

  it("auth.login.failed يُسجَّل عند كلمة مرور خاطئة (مع السبب بلا كلمة المرور)", async () => {
    await seedAdmin();
    const caller = appRouter.createCaller(makeCtx());
    await expect(caller.auth.login({ email: "admin@test.local", password: "wrongpass1" })).rejects.toThrow();
    const row = await lastAudit("auth.login.failed");
    expect(row).toBeTruthy();
    expect((row.newValue as any)?.reason).toBe("invalid_credentials");
    expect(JSON.stringify(row.newValue ?? {})).not.toContain("wrongpass1");
  });

  it("auth.login.failed يُسجَّل لبريد غير موجود (entityId=null)", async () => {
    await seedAdmin();
    const caller = appRouter.createCaller(makeCtx());
    await expect(caller.auth.login({ email: "ghost@test.local", password: "whatever1" })).rejects.toThrow();
    const row = await lastAudit("auth.login.failed");
    expect(row).toBeTruthy();
    expect(row.entityId).toBeNull();
    expect((row.newValue as any)?.reason).toBe("invalid_credentials");
  });

  it("user.create يُسجَّل عند إنشاء مستخدم من المدير", async () => {
    const admin = await seedAdmin();
    const caller = appRouter.createCaller(makeCtx(admin));
    const r = await caller.auth.register({ email: "new@test.local", password: "Pass1234!Aaa", name: "جديد", role: "cashier" });
    const row = await lastAudit("user.create");
    expect(row).toBeTruthy();
    expect(Number(row.entityId)).toBe(r.userId);
    expect(Number(row.userId)).toBe(1); // الفاعل = المدير
    expect(JSON.stringify(row.newValue ?? {})).not.toContain("Pass1234!Aaa"); // لا كلمة مرور
  });

  it("user.deactivate و user.resetPassword يُسجَّلان", async () => {
    const admin = await seedAdmin();
    const { userId } = await createUser({ name: "ك", email: "k@test.local", password: "Pass1234!Aaa" }, { userId: 1, branchId: 1 });
    const caller = appRouter.createCaller(makeCtx(admin));
    await caller.users.setActive({ userId, isActive: false });
    expect(await lastAudit("user.deactivate")).toBeTruthy();
    await caller.users.resetPassword({ userId, newPassword: "Reset123!Bbb" });
    const reset = await lastAudit("user.resetPassword");
    expect(reset).toBeTruthy();
    expect(JSON.stringify(reset)).not.toContain("Reset123!Bbb");
  });

  it("auth.changePassword يُسجَّل", async () => {
    await seedAdmin();
    const { userId } = await createUser({ name: "س", email: "s@test.local", password: "OldPass1!Aaa" }, { userId: 1, branchId: 1 });
    const u = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    const caller = appRouter.createCaller(makeCtx(u));
    await caller.auth.changePassword({ oldPassword: "OldPass1!Aaa", newPassword: "NewPass2!Bbb" });
    const row = await lastAudit("auth.changePassword");
    expect(row).toBeTruthy();
    expect(Number(row.entityId)).toBe(userId);
  });
});
