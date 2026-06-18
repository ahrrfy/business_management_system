import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword, verifyPassword } from "../../auth/password";
import { getDb } from "../../db";
import {
  changePassword,
  createUser,
  getUser,
  listUsers,
  resetUserPassword,
  setUserActive,
  updateUser,
} from "../userService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1 };
/** فاعل بديل (مدير آخر) لاختبار حارس آخر مدير دون أن يصطدم بحارس «الذات». */
const otherActor = { userId: 999, branchId: 1 };

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

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  // المدير المؤسِّس (الفاعل في معظم الاختبارات).
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
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("userService.createUser", () => {
  it("ينشئ مستخدماً بالحقول الكاملة (بلا تسريب passwordHash في القراءة)", async () => {
    const r = await createUser(
      { name: "كاشير ١", email: "Cashier1@Alroya.Local", password: "Pass1234!Aaa", role: "cashier", branchId: 2 },
      actor,
    );
    expect(r.userId).toBeGreaterThan(0);
    const row = (await db().select().from(s.users).where(eq(s.users.id, r.userId)).limit(1))[0];
    expect(row.name).toBe("كاشير ١");
    expect(row.email).toBe("cashier1@alroya.local"); // تطبيع لحالة صغيرة
    expect(row.role).toBe("cashier");
    expect(row.branchId).toBe(2);
    expect(row.isActive).toBe(true);
    expect(verifyPassword("Pass1234!Aaa", row.passwordHash)).toBe(true);
  });

  it("يجعل الدور الافتراضي cashier", async () => {
    const r = await createUser({ name: "م", email: "x@a.local", password: "Pass1234!Aaa" }, actor);
    const row = await getUser(r.userId);
    expect(row?.role).toBe("cashier");
  });

  it("يرفض اسماً فارغاً", async () => {
    await expect(createUser({ name: "  ", email: "y@a.local", password: "Pass1234!Aaa" }, actor)).rejects.toThrow();
  });

  it("يرفض كلمة مرور ضعيفة (قصيرة / بلا رقم / بلا حرف)", async () => {
    await expect(createUser({ name: "ا", email: "p1@a.local", password: "short1" }, actor)).rejects.toThrow();
    await expect(createUser({ name: "ا", email: "p2@a.local", password: "onlyletters" }, actor)).rejects.toThrow();
    await expect(createUser({ name: "ا", email: "p3@a.local", password: "12345678" }, actor)).rejects.toThrow();
  });

  it("يرفض بريداً مكرّراً (UNIQUE ⇒ CONFLICT)", async () => {
    await createUser({ name: "أ", email: "dup@a.local", password: "Pass1234!Aaa" }, actor);
    await expect(createUser({ name: "ب", email: "dup@a.local", password: "Pass1234!Aaa" }, actor)).rejects.toThrow();
    // التكرار حسّاس للحالة بعد التطبيع.
    await expect(createUser({ name: "ج", email: "DUP@A.LOCAL", password: "Pass1234!Aaa" }, actor)).rejects.toThrow();
  });
});

describe("userService.updateUser", () => {
  it("يعدّل الاسم والفرع", async () => {
    const { userId } = await createUser({ name: "ت", email: "t@a.local", password: "Pass1234!Aaa", branchId: 1 }, actor);
    const r = await updateUser({ userId, name: "تعديل", branchId: 2 }, actor);
    expect(r.changed).toBe(true);
    const row = await getUser(userId);
    expect(row?.name).toBe("تعديل");
    expect(row?.branchId).toBe(2);
  });

  it("يغيّر دور مستخدم عادي", async () => {
    const { userId } = await createUser({ name: "ث", email: "th@a.local", password: "Pass1234!Aaa", role: "cashier" }, actor);
    await updateUser({ userId, role: "manager" }, actor);
    const row = await getUser(userId);
    expect(row?.role).toBe("manager");
  });

  it("يمنع المدير من تخفيض دور نفسه (حارس الذات)", async () => {
    await expect(updateUser({ userId: 1, role: "cashier" }, actor)).rejects.toThrow(/بنفسك/);
  });

  it("يمنع تخفيض آخر مدير نشط", async () => {
    // فاعل مختلف يخفّض المدير الوحيد ⇒ يصطدم بحارس آخر مدير.
    await expect(updateUser({ userId: 1, role: "cashier" }, otherActor)).rejects.toThrow(/آخر مدير/);
  });

  it("يسمح بتخفيض مدير عند وجود مدير آخر نشط", async () => {
    const { userId } = await createUser({ name: "مدير٢", email: "a2@a.local", password: "Pass1234!Aaa", role: "admin" }, actor);
    const r = await updateUser({ userId, role: "manager" }, actor);
    expect(r.changed).toBe(true);
  });

  it("يرفض بريداً متعارضاً مع مستخدم آخر", async () => {
    await createUser({ name: "ج", email: "j1@a.local", password: "Pass1234!Aaa" }, actor);
    const { userId } = await createUser({ name: "ح", email: "j2@a.local", password: "Pass1234!Aaa" }, actor);
    await expect(updateUser({ userId, email: "j1@a.local" }, actor)).rejects.toThrow();
  });
});

describe("userService.setUserActive", () => {
  it("يعطّل مستخدماً عادياً ويُبطل جلساته (sessionsValidFrom يتقدّم)", async () => {
    const { userId } = await createUser({ name: "خ", email: "x2@a.local", password: "Pass1234!Aaa" }, actor);
    const before = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    await new Promise((r) => setTimeout(r, 1100)); // ثانية كاملة لضمان فرق محسوس
    const r = await setUserActive(userId, false, actor);
    expect(r.isActive).toBe(false);
    const after = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    expect(after.isActive).toBe(false);
    expect(new Date(after.sessionsValidFrom).getTime()).toBeGreaterThanOrEqual(
      new Date(before.sessionsValidFrom).getTime(),
    );
  });

  it("يعيد تفعيل مستخدم معطّل", async () => {
    const { userId } = await createUser({ name: "د", email: "d@a.local", password: "Pass1234!Aaa" }, actor);
    await setUserActive(userId, false, actor);
    const r = await setUserActive(userId, true, actor);
    expect(r.isActive).toBe(true);
  });

  it("يمنع المدير من تعطيل نفسه", async () => {
    await expect(setUserActive(1, false, actor)).rejects.toThrow(/بنفسك/);
  });

  it("يمنع تعطيل آخر مدير نشط", async () => {
    await expect(setUserActive(1, false, otherActor)).rejects.toThrow(/آخر مدير/);
  });

  it("يرفض تعطيل معطّل بالفعل / تفعيل مفعّل بالفعل", async () => {
    const { userId } = await createUser({ name: "ذ", email: "z@a.local", password: "Pass1234!Aaa" }, actor);
    await expect(setUserActive(userId, true, actor)).rejects.toThrow(/بالفعل/);
    await setUserActive(userId, false, actor);
    await expect(setUserActive(userId, false, actor)).rejects.toThrow(/بالفعل/);
  });
});

describe("userService.resetUserPassword", () => {
  it("يضع كلمة مرور جديدة ويُبطل الجلسات", async () => {
    const { userId } = await createUser({ name: "ر", email: "r@a.local", password: "Pass1234!Aaa" }, actor);
    await resetUserPassword(userId, "NewPass99!Aaa", actor);
    const row = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    expect(verifyPassword("NewPass99!Aaa", row.passwordHash)).toBe(true);
    expect(verifyPassword("Pass1234!Aaa", row.passwordHash)).toBe(false);
  });

  it("يرفض كلمة مرور ضعيفة", async () => {
    const { userId } = await createUser({ name: "ز", email: "z3@a.local", password: "Pass1234!Aaa" }, actor);
    await expect(resetUserPassword(userId, "weak", actor)).rejects.toThrow();
  });
});

describe("userService.changePassword", () => {
  it("يغيّر كلمة المرور عند صحّة الحالية", async () => {
    const { userId } = await createUser({ name: "س", email: "s@a.local", password: "OldPass11!Aaa" }, actor);
    await changePassword(userId, "OldPass11!Aaa", "NewPass22!Aaa");
    const row = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    expect(verifyPassword("NewPass22!Aaa", row.passwordHash)).toBe(true);
  });

  it("يرفض كلمة مرور حالية خاطئة", async () => {
    const { userId } = await createUser({ name: "ش", email: "sh@a.local", password: "OldPass11!Aaa" }, actor);
    await expect(changePassword(userId, "WrongOld1!Aaa", "NewPass22!Aaa")).rejects.toThrow(/الحالية/);
  });

  it("يرفض كلمة مرور جديدة ضعيفة", async () => {
    const { userId } = await createUser({ name: "ص", email: "sa@a.local", password: "OldPass11!Aaa" }, actor);
    await expect(changePassword(userId, "OldPass11!Aaa", "weak")).rejects.toThrow();
  });

  it("يرفض كلمة مرور جديدة مطابقة للحالية", async () => {
    const { userId } = await createUser({ name: "ض", email: "da@a.local", password: "OldPass11!Aaa" }, actor);
    await expect(changePassword(userId, "OldPass11!Aaa", "OldPass11!Aaa")).rejects.toThrow(/تختلف/);
  });
});

describe("userService.listUsers / getUser", () => {
  it("لا يُسرّب passwordHash في القائمة أو البطاقة", async () => {
    const { userId } = await createUser({ name: "ط", email: "ta@a.local", password: "Pass1234!Aaa" }, actor);
    const list = await listUsers({ includeInactive: true });
    for (const row of list.rows) expect("passwordHash" in row).toBe(false);
    const one = await getUser(userId);
    expect(one && "passwordHash" in one).toBe(false);
  });

  it("يعرض المفعّلين فقط افتراضياً", async () => {
    const a = await createUser({ name: "ع", email: "aa@a.local", password: "Pass1234!Aaa" }, actor);
    await createUser({ name: "غ", email: "gh@a.local", password: "Pass1234!Aaa" }, actor);
    await setUserActive(a.userId, false, actor);
    const r = await listUsers({}); // admin + غ = 2 مفعّلان
    const ids = r.rows.map((x) => Number(x.id));
    expect(ids).not.toContain(a.userId);
  });

  it("يبحث بالاسم والبريد ويفلتر بالدور", async () => {
    await createUser({ name: "أحمد كاشير", email: "ahmed@a.local", password: "Pass1234!Aaa", role: "cashier" }, actor);
    await createUser({ name: "علي مخزن", email: "ali@a.local", password: "Pass1234!Aaa", role: "warehouse" }, actor);
    expect((await listUsers({ q: "أحمد" })).rows).toHaveLength(1);
    expect((await listUsers({ q: "ali@" })).rows).toHaveLength(1);
    expect((await listUsers({ role: "warehouse" })).rows).toHaveLength(1);
  });

  it("getUser يُرجع null لمعرّف غير موجود", async () => {
    expect(await getUser(99999)).toBeNull();
  });
});
