import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getUserFromRequest, signSession, verifySession } from "../../auth/session";
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
    // AUTH-02: حدّ الإبطال أقدم بثانيتين من الإنشاء (كما في seed/createUser) كي لا يُرفَض توكنٌ
    // يُصدَر في نفس ثانية البذر تحت مقارنة `iat <= validFromSec` (٢٠٠٠ms لتجاوز تقريب TIMESTAMP).
    sessionsValidFrom: new Date(Date.now() - 2000),
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
    // AUTH-01: القفل لا يُكشَف للعميل (لا oracle وجود/قفل) — يُرفَض الدخول حتى بالكلمة الصحيحة،
    // لكن بالرسالة الموحّدة لا برسالة «مقفل» المميِّزة.
    await expect(caller.auth.login({ email: "admin@test.local", password: "Admin@12345" })).rejects.toThrow(
      /البريد أو كلمة المرور/,
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

describe("AUTH-02 — نافذة الإبطال العمياء بدقّة الثانية", () => {
  it("(١) توكن صُكّ قبل sessionsValidFrom يُرفض (السلوك القائم)", async () => {
    await seedAdmin();
    // validFrom في المستقبل بثانيتين، والتوكن iat الآن ⇒ iat < validFromSec ⇒ يُرفض.
    const nowSec = Math.floor(Date.now() / 1000);
    await db()
      .update(s.users)
      .set({ sessionsValidFrom: new Date((nowSec + 2) * 1000) })
      .where(eq(s.users.id, 1));
    const token = await signSession(1, undefined, null, nowSec);
    const req = { headers: { cookie: `app_session_id=${token}` } } as any;
    expect(await getUserFromRequest(req)).toBeNull();
  });

  it("(٢) توكن صُكّ في نفس ثانية sessionsValidFrom يُرفض الآن (إصلاح AUTH-02)", async () => {
    await seedAdmin();
    // اضبط validFromSec ثمّ صُكّ توكناً بنفس iat بالضبط (iat == validFromSec).
    const validFromSec = Math.floor(Date.now() / 1000);
    await db()
      .update(s.users)
      .set({ sessionsValidFrom: new Date(validFromSec * 1000) })
      .where(eq(s.users.id, 1));
    const sameSecondToken = await signSession(1, undefined, null, validFromSec);
    const req = { headers: { cookie: `app_session_id=${sameSecondToken}` } } as any;
    // قبل الإصلاح: كانت المقارنة `<` تقبله (نافذة عمياء). الآن `<=` ⇒ يُرفض.
    expect(await getUserFromRequest(req)).toBeNull();
  });

  it("(٣) تغيير كلمة المرور بنفسه: جلسة صاحبها المُعاد إصدارها تبقى صالحة (لا طرد)", async () => {
    const admin = await seedAdmin();
    // سياق يلتقط الكوكي المُعاد إصداره؛ req يحمل user-agent ثابتاً ليطابق البصمة.
    const cookies: Record<string, string> = {};
    const req = { headers: { "user-agent": "vitest-UA" } as Record<string, string>, protocol: "http" };
    const res = {
      cookie(name: string, val: string) {
        cookies[name] = val;
      },
      clearCookie(name: string) {
        delete cookies[name];
      },
    };
    const caller = appRouter.createCaller({ req, res, user: admin } as any);

    const r = await caller.auth.changePassword({
      oldPassword: "Admin@12345",
      newPassword: "NewPass1!Aaa",
    });
    expect(r.success).toBe(true);

    // الكوكي المُعاد إصداره يجب أن يجتاز getUserFromRequest رغم تقدّم sessionsValidFrom.
    const reissued = cookies["app_session_id"];
    expect(reissued).toBeTruthy();
    const verifyReq = {
      headers: { cookie: `app_session_id=${reissued}`, "user-agent": "vitest-UA" },
    } as any;
    const stillValid = await getUserFromRequest(verifyReq);
    expect(stillValid?.id).toBe(1);

    // وفي الوقت نفسه، أيّ توكنٍ أجنبيٍّ صُكّ في نفس ثانية الإبطال (أو قبلها) يُرفض.
    const after = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const validFromSec = Math.floor(new Date(after.sessionsValidFrom).getTime() / 1000);
    const foreignToken = await signSession(1, undefined, null, validFromSec);
    const foreignReq = { headers: { cookie: `app_session_id=${foreignToken}` } } as any;
    expect(await getUserFromRequest(foreignReq)).toBeNull();
  });

  it("(٤) دخولٌ طبيعي ⇒ جلسة صالحة (لا انحدار)", async () => {
    await seedAdmin();
    const cookies: Record<string, string> = {};
    const req = { headers: { "user-agent": "vitest-UA" } as Record<string, string>, protocol: "http" };
    const res = {
      cookie(name: string, val: string) {
        cookies[name] = val;
      },
      clearCookie(name: string) {
        delete cookies[name];
      },
    };
    const caller = appRouter.createCaller({ req, res, user: null } as any);
    const r = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    expect(r.id).toBe(1);
    const token = cookies["app_session_id"];
    expect(token).toBeTruthy();
    const verifyReq = {
      headers: { cookie: `app_session_id=${token}`, "user-agent": "vitest-UA" },
    } as any;
    const u = await getUserFromRequest(verifyReq);
    expect(u?.id).toBe(1);
  });
});
