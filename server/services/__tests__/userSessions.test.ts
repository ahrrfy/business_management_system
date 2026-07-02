/**
 * شاشة «عرض/إلغاء الجلسات النشطة» (§٦ الخطوة التالية المقترحة، ٣/٧/٢٦) — تتبّع جلسة فردية
 * لكل تسجيل دخول (userSessions) مكمِّل لـ`users.sessionsValidFrom` (الإبطال الجماعي القائم).
 * يغطّي: إنشاء سطر عند الدخول + sid في الـJWT، إبطال جهازٍ واحدٍ بلا مسّ البقية، IDOR
 * (مستخدم لا يُبطل جلسة غيره / مدير لا يُبطل بزوج userId/sessionId غير متطابق)، وأنّ شاشة
 * العرض تُخفي جلسات ما قبل آخر إبطالٍ جماعي بلا حاجة لكتابة إضافية على logout/changePassword.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getUserFromRequest, verifySession } from "../../auth/session";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = ["userSessions", "auditLogs", "users", "branches"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedUsers() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "u1",
      name: "مستخدم ١",
      email: "u1@test.local",
      passwordHash: hashPassword("Pass1234!Aaa"),
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      sessionsValidFrom: new Date(Date.now() - 2000),
    },
    {
      id: 2,
      openId: "u2",
      name: "مستخدم ٢",
      email: "u2@test.local",
      passwordHash: hashPassword("Pass1234!Aaa"),
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
      sessionsValidFrom: new Date(Date.now() - 2000),
    },
    // ممثّل "مدير" مستقلّ عن ذاتَي الاختبار (١ و٢) — كي لا يسقط logAudit بخطأ FK صامت
    // (يبتلعه try/catch لكنه يُلوّث المخرجات) عند استعمال userId فعليّ غير موجود.
    {
      id: 3,
      openId: "u3",
      name: "المدير",
      email: "admin@test.local",
      passwordHash: hashPassword("Pass1234!Aaa"),
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      sessionsValidFrom: new Date(Date.now() - 2000),
    },
  ]);
}

/** يسجّل دخولاً حقيقياً عبر الراوتر (لا signSession مباشرةً) كي يُنشأ سطر userSessions
 *  فعلياً ويُضمَّن sid في الكوكي — يُعيد التوكن + sid المُستخرَج منه لبناء ctx تحقّق لاحقاً. */
async function loginAs(email: string, userAgent = "vitest-UA") {
  const cookies: Record<string, string> = {};
  const req = { headers: { "user-agent": userAgent } as Record<string, string>, protocol: "http" };
  const res = {
    cookie(name: string, val: string) { cookies[name] = val; },
    clearCookie(name: string) { delete cookies[name]; },
  };
  const caller = appRouter.createCaller({ req, res, user: null, sessionId: null } as any);
  const r = await caller.auth.login({ email, password: "Pass1234!Aaa" });
  const token = cookies["app_session_id"];
  const payload = await verifySession(token);
  return { userId: r.id, token, sid: payload?.sid ?? null };
}

/** ctx كأنّه صادر من createContext حقيقي (user + sessionId) — لاستدعاء إجراءات protected/admin. */
function ctxFor(user: any, sessionId: number | null) {
  const cookies: Record<string, string> = {};
  const req = { headers: {} as Record<string, string>, protocol: "http" };
  const res = {
    cookie(name: string, val: string) { cookies[name] = val; },
    clearCookie(name: string) { delete cookies[name]; },
  };
  return { ctx: { req, res, user, sessionId } as any, cookies };
}

beforeEach(async () => {
  await reset();
  await seedUsers();
});

describe("userSessions — إنشاء عند الدخول", () => {
  it("الدخول يُنشئ سطر جلسة يحمل userAgent/ipAddress + sid مضمَّن في الكوكي", async () => {
    const { sid } = await loginAs("u1@test.local", "Mozilla/5.0 Chrome vitest");
    expect(sid).toBeTypeOf("number");
    const rows = await db().select().from(s.userSessions).where(eq(s.userSessions.userId, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].userAgent).toMatch(/Chrome/);
    expect(rows[0].revokedAt).toBeNull();
  });

  it("توكن يحمل sid يمرّ getUserFromRequest كتوكن عادي", async () => {
    const { token } = await loginAs("u1@test.local");
    const req = { headers: { cookie: `app_session_id=${token}`, "user-agent": "vitest-UA" } } as any;
    const u = await getUserFromRequest(req);
    expect(u?.id).toBe(1);
  });
});

describe("userSessions — إبطال جهازٍ واحدٍ بلا مسّ البقية (القيمة الجوهرية للميزة)", () => {
  it("جهازان لنفس المستخدم؛ إبطال أحدهما لا يُسقط الآخر", async () => {
    const deviceA = await loginAs("u1@test.local", "device-A");
    const deviceB = await loginAs("u1@test.local", "device-B");
    expect(deviceA.sid).not.toBe(deviceB.sid);

    // ب لا A: أبطل جلسة A من خلال ctx يحمل sessionId=deviceA.sid (كأنّه مسجَّل من جهاز A).
    const admin = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const { ctx } = ctxFor(admin, deviceA.sid);
    const caller = appRouter.createCaller(ctx);
    await caller.auth.revokeSession({ sessionId: deviceA.sid! });

    const reqA = { headers: { cookie: `app_session_id=${deviceA.token}`, "user-agent": "device-A" } } as any;
    const reqB = { headers: { cookie: `app_session_id=${deviceB.token}`, "user-agent": "device-B" } } as any;
    expect(await getUserFromRequest(reqA)).toBeNull(); // A طُرِد
    expect((await getUserFromRequest(reqB))?.id).toBe(1); // B بقي سليماً
  });

  it("revokeSession على الجلسة الحالية يمسح الكوكي أيضاً", async () => {
    const device = await loginAs("u1@test.local");
    const admin = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const { ctx, cookies } = ctxFor(admin, device.sid);
    cookies["app_session_id"] = device.token!; // محاكاة الكوكي الحالي في الطلب
    const caller = appRouter.createCaller(ctx);
    await caller.auth.revokeSession({ sessionId: device.sid! });
    expect(cookies["app_session_id"]).toBeUndefined();
  });
});

describe("userSessions — IDOR: لا إبطال لجلسة مستخدمٍ آخر", () => {
  it("مستخدم عادي لا يستطيع إبطال جلسة مستخدمٍ آخر عبر تخمين sessionId (auth.revokeSession)", async () => {
    const victim = await loginAs("u1@test.local");
    const attacker = (await db().select().from(s.users).where(eq(s.users.id, 2)).limit(1))[0];
    const { ctx } = ctxFor(attacker, null);
    const caller = appRouter.createCaller(ctx);
    await expect(caller.auth.revokeSession({ sessionId: victim.sid! })).rejects.toThrow(/غير موجودة/);
    // الضحية بقيت سليمة (لم تُبطَل).
    const reqVictim = { headers: { cookie: `app_session_id=${victim.token}`, "user-agent": "vitest-UA" } } as any;
    expect((await getUserFromRequest(reqVictim))?.id).toBe(1);
  });

  it("المدير: زوج (userId, sessionId) غير متطابق يُرفَض (users.revokeSession)", async () => {
    const u1Session = await loginAs("u1@test.local");
    const admin = (await db().select().from(s.users).where(eq(s.users.id, 3)).limit(1))[0];
    const caller = appRouter.createCaller({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: admin, sessionId: null } as any);
    // يطلب إبطال جلسة تخصّ u1 لكن يمرّر userId=2 (مستخدم آخر) ⇒ يجب الرفض.
    await expect(
      caller.users.revokeSession({ userId: 2, sessionId: u1Session.sid! }),
    ).rejects.toThrow(/غير موجودة/);
  });

  it("المدير: زوج متطابق يُبطل الجلسة فعلياً", async () => {
    const u1Session = await loginAs("u1@test.local");
    const admin = (await db().select().from(s.users).where(eq(s.users.id, 3)).limit(1))[0];
    const caller = appRouter.createCaller({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: admin, sessionId: null } as any);
    await caller.users.revokeSession({ userId: 1, sessionId: u1Session.sid! });
    const reqVictim = { headers: { cookie: `app_session_id=${u1Session.token}`, "user-agent": "vitest-UA" } } as any;
    expect(await getUserFromRequest(reqVictim)).toBeNull();
  });
});

describe("userSessions — شاشة العرض (mySessions/users.sessions)", () => {
  it("mySessions يسرد الجلسات الفعّالة ويُصحّح isCurrent حسب ctx.sessionId", async () => {
    const deviceA = await loginAs("u1@test.local", "device-A");
    const deviceB = await loginAs("u1@test.local", "device-B");
    const admin = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const { ctx } = ctxFor(admin, deviceA.sid);
    const list = await appRouter.createCaller(ctx).auth.mySessions();
    expect(list).toHaveLength(2);
    const a = list.find((r) => r.id === deviceA.sid);
    const b = list.find((r) => r.id === deviceB.sid);
    expect(a?.isCurrent).toBe(true);
    expect(b?.isCurrent).toBe(false);
  });

  it("users.sessions (المدير) يسرد جلسات مستخدمٍ آخر", async () => {
    await loginAs("u2@test.local", "u2-device");
    const admin = (await db().select().from(s.users).where(eq(s.users.id, 3)).limit(1))[0];
    const caller = appRouter.createCaller({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: admin, sessionId: null } as any);
    const list = await caller.users.sessions({ userId: 2 });
    expect(list).toHaveLength(1);
    expect(list[0].userAgent).toMatch(/u2-device/);
  });

  it("جلسة سابقة لإبطالٍ جماعي (revokeMySessions) تختفي من القائمة تلقائياً", async () => {
    const oldDevice = await loginAs("u1@test.local", "old-device");
    // TIMESTAMP بلا كسور ثانية (مقصوصة لا مُقرَّبة — تحقّق تجريبي) ⇒ حدثان فعليّان قد
    // يقعان في **نفس الثانية** المعروضة فيبدو ترتيبهما متعادلاً؛ نُثبّت createdAt في الماضي
    // صراحةً هنا كي يختبر السيناريو الواقعي (جلسة قديمة فعلاً) بلا اعتماد على سرعة التنفيذ.
    await db().update(s.userSessions).set({ createdAt: new Date(Date.now() - 10_000) }).where(eq(s.userSessions.id, oldDevice.sid!));
    const admin1 = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    // إبطال جماعي حقيقي عبر الراوتر (بلا لمس صفّ userSessions مباشرةً) — يحاكي «تسجيل
    // الخروج من كل الأجهزة».
    await appRouter.createCaller(ctxFor(admin1, oldDevice.sid).ctx).auth.revokeMySessions();

    const admin1After = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const list = await appRouter.createCaller(ctxFor(admin1After, null).ctx).auth.mySessions();
    expect(list.map((r) => r.id)).not.toContain(oldDevice.sid);
  });

  it("إعادة إصدار تغيير كلمة المرور: الجلسة الجديدة تظهر فوراً، والقديمة تختفي", async () => {
    const oldDevice = await loginAs("u1@test.local", "old-device");
    await db().update(s.userSessions).set({ createdAt: new Date(Date.now() - 10_000) }).where(eq(s.userSessions.id, oldDevice.sid!));
    const admin1 = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];

    const cookies: Record<string, string> = {};
    const req = { headers: { "user-agent": "new-device" } as Record<string, string>, protocol: "http" };
    const res = {
      cookie(name: string, val: string) { cookies[name] = val; },
      clearCookie(name: string) { delete cookies[name]; },
    };
    const changeCaller = appRouter.createCaller({ req, res, user: admin1, sessionId: oldDevice.sid } as any);
    await changeCaller.auth.changePassword({ oldPassword: "Pass1234!Aaa", newPassword: "NewPass1!Aaa" });
    const reissuedToken = cookies["app_session_id"];
    const reissuedPayload = await verifySession(reissuedToken);
    expect(reissuedPayload?.sid).toBeTypeOf("number");

    const admin1After = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const list = await appRouter.createCaller(ctxFor(admin1After, reissuedPayload!.sid!).ctx).auth.mySessions();
    expect(list.map((r) => r.id)).toContain(reissuedPayload!.sid);
    expect(list.map((r) => r.id)).not.toContain(oldDevice.sid);
    expect(list.find((r) => r.id === reissuedPayload!.sid)?.isCurrent).toBe(true);
  });
});
