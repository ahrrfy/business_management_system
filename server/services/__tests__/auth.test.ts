import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getUserFromRequest, signSession, verifySession } from "../../auth/session";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createUser } from "../userService";
import { truncateTables } from "./__testUtils__";

const TABLES = ["auditLogs", "users", "branches"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await truncateTables(TABLES);
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

/** سياق tRPC وهمي مع res يلتقط الكوكي. */
function makeCtx(user: any = null) {
  const cookies: Record<string, string> = {};
  const res = {
    cookie(name: string, val: string) { cookies[name] = val; },
    clearCookie(name: string) { delete cookies[name]; },
  };
  const req = { headers: {} as Record<string, string>, protocol: "http" };
  return { ctx: { req, res, user } as any, cookies };
}

beforeEach(async () => {
  await reset();
});

describe("auth.login — قفل الحساب وتوحيد الخطأ", () => {
  it("ينجح بالبيانات الصحيحة ويصفّر العدّاد", async () => {
    await seedAdmin();
    const { ctx, cookies } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    const r = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    expect(r.id).toBe(1);
    expect(cookies["app_session_id"]).toBeTruthy();
    const u = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    expect(u.failedLoginAttempts).toBe(0);
  });

  it("بريد غير موجود يفشل بنفس رسالة كلمة المرور الخاطئة (UNAUTHORIZED)", async () => {
    await seedAdmin();
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(caller.auth.login({ email: "ghost@test.local", password: "whatever1" })).rejects.toThrow(
      /البريد أو كلمة المرور/,
    );
  });

  it("كلمة مرور خاطئة تزيد عدّاد الإخفاق", async () => {
    await seedAdmin();
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(caller.auth.login({ email: "admin@test.local", password: "wrongpass1" })).rejects.toThrow();
    const u = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    expect(u.failedLoginAttempts).toBe(1);
  });

  it("يقفل الحساب بعد ٥ محاولات فاشلة — حتى الكلمة الصحيحة تُرفض بعدها", async () => {
    await seedAdmin();
    const caller = appRouter.createCaller(makeCtx().ctx);
    for (let i = 0; i < 5; i++) {
      await expect(caller.auth.login({ email: "admin@test.local", password: `bad${i}xyz1` })).rejects.toThrow();
    }
    const u = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    expect(u.lockedUntil).toBeTruthy();
    await expect(caller.auth.login({ email: "admin@test.local", password: "Admin@12345" })).rejects.toThrow(
      /مقفل/,
    );
  });

  it("الحساب المعطّل يُرفض بنفس الرسالة الموحّدة", async () => {
    await seedAdmin();
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 1));
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(caller.auth.login({ email: "admin@test.local", password: "Admin@12345" })).rejects.toThrow(
      /البريد أو كلمة المرور/,
    );
  });
});

describe("auth.register — ذرّي وفريد", () => {
  it("ينشئ مستخدماً ثم يرفض تكرار البريد", async () => {
    const admin = await seedAdmin();
    const caller = appRouter.createCaller(makeCtx(admin).ctx);
    const r = await caller.auth.register({ email: "new@test.local", password: "Pass1234!Aaa", name: "جديد" });
    expect(r.success).toBe(true);
    await expect(
      caller.auth.register({ email: "new@test.local", password: "Pass1234!Aaa", name: "مكرّر" }),
    ).rejects.toThrow(/مستخدم مسبقاً/);
  });
});

describe("session — إبطال وإزالة الدور", () => {
  it("التوكن لا يحمل الدور (يُقرأ من القاعدة فقط)", async () => {
    await seedAdmin();
    const token = await signSession(1);
    const payload = await verifySession(token);
    expect(payload?.uid).toBe(1);
    expect((payload as any)?.role).toBeUndefined();
  });

  it("getUserFromRequest يقبل التوكن الصالح ويرفضه بعد إبطال الجلسات", async () => {
    await seedAdmin();
    const token = await signSession(1);
    const req = { headers: { cookie: `app_session_id=${token}` } } as any;

    const u1 = await getUserFromRequest(req);
    expect(u1?.id).toBe(1);

    // إبطال: sessionsValidFrom في المستقبل ⇒ التوكن القديم (iat أقدم) يُرفض.
    await db().update(s.users).set({ sessionsValidFrom: new Date(Date.now() + 60_000) }).where(eq(s.users.id, 1));
    expect(await getUserFromRequest(req)).toBeNull();
  });

  it("getUserFromRequest يرفض مستخدماً معطّلاً", async () => {
    await seedAdmin();
    const token = await signSession(1);
    const req = { headers: { cookie: `app_session_id=${token}` } } as any;
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 1));
    expect(await getUserFromRequest(req)).toBeNull();
  });

  it("createUser يُنشئ مستخدماً يمكنه الدخول فوراً (تكامل verifyPassword)", async () => {
    await seedAdmin();
    await createUser({ name: "ك", email: "k@test.local", password: "Pass1234!Aaa" }, { userId: 1, branchId: 1 });
    const caller = appRouter.createCaller(makeCtx().ctx);
    const r = await caller.auth.login({ email: "k@test.local", password: "Pass1234!Aaa" });
    expect(r.email).toBe("k@test.local");
  });
});
