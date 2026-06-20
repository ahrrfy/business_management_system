import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import {
  checkUsernameAvailable,
  createUser,
  suggestUsername,
  updateUser,
} from "../userService";

const actor = { userId: 1, branchId: 1 };
const TABLES = ["auditLogs", "users", "branches"];
const PW = "Pass1234!Aaa";

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
    username: "admin",
    passwordHash: hashPassword("Admin@12345"),
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
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
  await seedAdmin();
});

describe("auth.login — بمعرّف بريد أو اسم مستخدم", () => {
  it("يدخل باسم المستخدم (identifier)", async () => {
    const { ctx, cookies } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    const r = await caller.auth.login({ identifier: "admin", password: "Admin@12345" });
    expect(r.id).toBe(1);
    expect(r.username).toBe("admin");
    expect(cookies["app_session_id"]).toBeTruthy();
  });

  it("يدخل بالبريد عبر identifier", async () => {
    const caller = appRouter.createCaller(makeCtx().ctx);
    const r = await caller.auth.login({ identifier: "admin@test.local", password: "Admin@12345" });
    expect(r.id).toBe(1);
  });

  it("يقبل الحقل القديم email (توافق خلفي)", async () => {
    const caller = appRouter.createCaller(makeCtx().ctx);
    const r = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    expect(r.id).toBe(1);
  });

  it("اسم المستخدم غير حسّاس لحالة الأحرف", async () => {
    const caller = appRouter.createCaller(makeCtx().ctx);
    const r = await caller.auth.login({ identifier: "ADMIN", password: "Admin@12345" });
    expect(r.id).toBe(1);
  });

  it("اسم مستخدم غير موجود يفشل بنفس رسالة الاعتماد الموحّدة", async () => {
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(caller.auth.login({ identifier: "ghost", password: "whatever1" })).rejects.toThrow(
      /البريد أو كلمة المرور/,
    );
  });

  it("يرفض الدخول بلا أي معرّف", async () => {
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(caller.auth.login({ password: "Admin@12345" } as any)).rejects.toThrow();
  });
});

describe("createUser — اسم المستخدم كمعرّف", () => {
  it("ينشئ مستخدماً باسم مستخدم فقط (بلا بريد) ويدخل به", async () => {
    const r = await createUser({ name: "مروة", username: "Marwa.Ibrahim", password: PW }, actor);
    const row = (await db().select().from(s.users).where(eq(s.users.id, r.userId)).limit(1))[0];
    expect(row.email).toBeNull();
    expect(row.username).toBe("marwa.ibrahim"); // تطبيع لحالة صغيرة
    const caller = appRouter.createCaller(makeCtx().ctx);
    const login = await caller.auth.login({ identifier: "marwa.ibrahim", password: PW });
    expect(login.id).toBe(r.userId);
  });

  it("ينشئ مستخدماً ببريد فقط (بلا اسم مستخدم)", async () => {
    const r = await createUser({ name: "سالم", email: "salem@a.local", password: PW }, actor);
    const row = (await db().select().from(s.users).where(eq(s.users.id, r.userId)).limit(1))[0];
    expect(row.username).toBeNull();
    expect(row.email).toBe("salem@a.local");
  });

  it("يرفض الإنشاء بلا بريد ولا اسم مستخدم", async () => {
    await expect(createUser({ name: "بلا", password: PW }, actor)).rejects.toThrow(/بريد|اسم مستخدم/);
  });

  it("يرفض اسم مستخدم بصيغة غير صالحة (مسافة/@/يبدأ برقم)", async () => {
    await expect(createUser({ name: "x", username: "has space", password: PW }, actor)).rejects.toThrow();
    await expect(createUser({ name: "x", username: "a@b", password: PW }, actor)).rejects.toThrow();
    await expect(createUser({ name: "x", username: "1abc", password: PW }, actor)).rejects.toThrow();
    await expect(createUser({ name: "x", username: "ab", password: PW }, actor)).rejects.toThrow(); // قصير
  });

  it("يرفض اسم مستخدم مكرّراً (UNIQUE ⇒ CONFLICT برسالة اسم المستخدم)", async () => {
    await createUser({ name: "أ", username: "dup.user", password: PW }, actor);
    await expect(createUser({ name: "ب", username: "dup.user", password: PW }, actor)).rejects.toThrow(/اسم المستخدم/);
    // التكرار حسّاس بعد التطبيع لحالة الأحرف.
    await expect(createUser({ name: "ج", username: "DUP.USER", password: PW }, actor)).rejects.toThrow(/اسم المستخدم/);
  });
});

describe("updateUser — تعديل معرّفات الدخول", () => {
  it("يضيف/يغيّر اسم المستخدم", async () => {
    const { userId } = await createUser({ name: "ت", email: "t@a.local", password: PW }, actor);
    await updateUser({ userId, username: "tarek" }, actor);
    const row = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    expect(row.username).toBe("tarek");
  });

  it("يسمح بمسح البريد ما دام اسم المستخدم باقياً", async () => {
    const { userId } = await createUser({ name: "ح", email: "h@a.local", username: "hamid", password: PW }, actor);
    const r = await updateUser({ userId, email: "" }, actor);
    expect(r.changed).toBe(true);
    const row = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    expect(row.email).toBeNull();
    expect(row.username).toBe("hamid");
  });

  it("يرفض مسح آخر معرّف دخول (مسح البريد بلا اسم مستخدم)", async () => {
    const { userId } = await createUser({ name: "خ", email: "kh@a.local", password: PW }, actor);
    await expect(updateUser({ userId, email: "" }, actor)).rejects.toThrow(/معرّف|على الأقل/);
  });

  it("يرفض اسم مستخدم متعارضاً مع مستخدم آخر", async () => {
    await createUser({ name: "ج", username: "taken", password: PW }, actor);
    const { userId } = await createUser({ name: "د", email: "d@a.local", password: PW }, actor);
    await expect(updateUser({ userId, username: "taken" }, actor)).rejects.toThrow(/اسم المستخدم/);
  });
});

describe("checkUsernameAvailable / suggestUsername", () => {
  it("checkUsernameAvailable يكشف المأخوذ والمتاح والصيغة غير الصالحة", async () => {
    expect(await checkUsernameAvailable("admin")).toBe(false); // مأخوذ (المدير)
    expect(await checkUsernameAvailable("brand.new")).toBe(true);
    expect(await checkUsernameAvailable("x y")).toBe(false); // صيغة غير صالحة
  });

  it("suggestUsername يشتقّ من الاسم العربي ويضمن التفرّد", async () => {
    const u1 = await suggestUsername("علي محمد");
    expect(u1).toMatch(/^[a-z][a-z0-9._-]{2,31}$/);
    // إنشاء بهذا الاسم ثم إعادة الاقتراح ⇒ اقتراح مختلف (متاح).
    await createUser({ name: "علي محمد", username: u1, password: PW }, actor);
    const u2 = await suggestUsername("علي محمد");
    expect(u2).not.toBe(u1);
    expect(await checkUsernameAvailable(u2)).toBe(true);
  });
});
