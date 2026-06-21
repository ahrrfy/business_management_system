/**
 * اختبارات تكامل (DB) لميزة «إضافة موظف + حساب نظام» — الأوضاع الثلاثة (none/new/link)،
 * الذرّية (تراجع كامل عند الفشل)، علاقة واحد-لواحد، ربط/فكّ ربط في التعديل، إنشاء حساب لموظف
 * قائم، قائمة الحسابات القابلة للربط، وبوّابة admin على الراوتر.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { verifyPassword } from "../../auth/password";
import {
  createAccountForEmployee,
  createEmployee,
  createEmployeeWithAccount,
  getEmployee,
  linkEmployeeAccount,
  listLinkableUsers,
  unlinkEmployeeAccount,
} from "../employeeService";
import { createUser } from "../userService";

const TABLES = ["assetMaintenance", "assetCustodyLog", "assetDocuments", "fixedAssets", "attendance", "employees", "auditLogs", "branches", "users"];
const STRONG = "Abcd@1234567"; // ١٢ حرفاً + صغير/كبير/رقم/رمز ⇒ يجتاز السياسة
const actor = { userId: 1, branchId: 1, role: "admin" };
const baseEmp = {
  firstName: "علي", lastName: "العبيدي", payType: "monthly" as const, salary: "1000000",
  phone: "07701234567", position: "محاسب", branchId: 1, hireDate: "2024-01-15",
};

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
async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
}
async function counts() {
  const [e] = await db().select({ n: sql<number>`count(*)` }).from(s.employees);
  const [u] = await db().select({ n: sql<number>`count(*)` }).from(s.users);
  return { employees: Number(e.n), users: Number(u.n) };
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("createEmployeeWithAccount — الأوضاع الثلاثة", () => {
  it("none: ينشئ موظفاً بلا حساب نظام", async () => {
    const { employeeId, userId } = await createEmployeeWithAccount(baseEmp, { mode: "none" }, actor);
    expect(userId).toBeNull();
    const e = await getEmployee(employeeId);
    expect(e!.userId).toBeNull();
    expect(e!.linkedUser).toBeNull();
    expect((await counts()).users).toBe(0);
  });

  it("new: ينشئ مستخدماً مرتبطاً ذرّياً مع تعبئة من بيانات الموظف", async () => {
    const { employeeId, userId } = await createEmployeeWithAccount(
      baseEmp,
      { mode: "new", user: { name: "علي العبيدي", username: "ali.acct", password: STRONG, role: "cashier", mustChangePassword: true } },
      actor,
    );
    expect(typeof userId).toBe("number");
    const e = await getEmployee(employeeId);
    expect(e!.userId).toBe(userId);
    expect(e!.linkedUser?.username).toBe("ali.acct");
    const [u] = await db().select().from(s.users).where(eq(s.users.id, userId!));
    expect(verifyPassword(STRONG, u.passwordHash)).toBe(true);
    expect(u.mustChangePassword).toBe(true);
    // تعبئة من الموظف (تجنّب الإدخال المزدوج)
    expect(u.phone).toBe("07701234567");
    expect(u.jobTitle).toBe("محاسب");
    expect(Number(u.branchId)).toBe(1);
    expect(u.role).toBe("cashier");
  });

  it("link: يربط حساباً قائماً غير مرتبط", async () => {
    const { userId } = await createUser({ name: "حساب", username: "link.me", password: STRONG }, actor);
    const { employeeId } = await createEmployeeWithAccount(baseEmp, { mode: "link", userId }, actor);
    const e = await getEmployee(employeeId);
    expect(e!.userId).toBe(userId);
    expect(e!.linkedUser?.id).toBe(userId);
  });
});

describe("createEmployeeWithAccount — الذرّية (تراجع كامل)", () => {
  it("new: تكرار البريد ⇒ CONFLICT ولا يبقى موظف ولا مستخدم", async () => {
    await createUser({ name: "موجود", email: "dup@test.local", password: STRONG }, actor);
    const before = await counts();
    await expect(
      createEmployeeWithAccount(baseEmp, { mode: "new", user: { name: "علي", email: "dup@test.local", password: STRONG } }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await counts();
    expect(after.employees).toBe(before.employees);
    expect(after.users).toBe(before.users);
  });

  it("new: كلمة مرور ضعيفة ⇒ خطأ ولا موظف يُنشأ", async () => {
    const before = await counts();
    await expect(
      createEmployeeWithAccount(baseEmp, { mode: "new", user: { name: "علي", username: "weakuser", password: "weak" } }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await counts()).employees).toBe(before.employees);
  });

  it("new: بلا بريد ولا اسم مستخدم ⇒ خطأ ولا موظف يُنشأ", async () => {
    const before = await counts();
    await expect(
      createEmployeeWithAccount(baseEmp, { mode: "new", user: { name: "علي", password: STRONG } }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await counts()).employees).toBe(before.employees);
  });
});

describe("علاقة واحد-لواحد + تحقّقات الربط", () => {
  it("لا يُربط الحساب نفسه بموظفين", async () => {
    const { userId } = await createUser({ name: "حساب", username: "once.only", password: STRONG }, actor);
    await createEmployeeWithAccount(baseEmp, { mode: "link", userId }, actor);
    await expect(
      createEmployeeWithAccount({ ...baseEmp, firstName: "ثانٍ" }, { mode: "link", userId }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("link: مستخدم غير موجود ⇒ NOT_FOUND (ولا موظف يُنشأ)", async () => {
    const before = await counts();
    await expect(
      createEmployeeWithAccount(baseEmp, { mode: "link", userId: 99999 }, actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await counts()).employees).toBe(before.employees);
  });
});

describe("التعديل — ربط/فكّ ربط/إنشاء لموظف قائم", () => {
  it("ربط ثم فكّ ربط: الحساب يبقى موجوداً وإعادة الربط تعمل", async () => {
    const { userId } = await createUser({ name: "حساب", username: "edit.link", password: STRONG }, actor);
    const e = await createEmployee(baseEmp);
    const linked = await linkEmployeeAccount(e!.id, userId);
    expect(linked!.userId).toBe(userId);
    const unlinked = await unlinkEmployeeAccount(e!.id);
    expect(unlinked!.userId).toBeNull();
    // فكّ الربط لا يحذف المستخدم
    const [u] = await db().select().from(s.users).where(eq(s.users.id, userId));
    expect(u).toBeTruthy();
    const relink = await linkEmployeeAccount(e!.id, userId);
    expect(relink!.userId).toBe(userId);
  });

  it("ربط موظف له حساب بالفعل ⇒ CONFLICT", async () => {
    const { userId: u1 } = await createUser({ name: "أول", username: "first.acc", password: STRONG }, actor);
    const { userId: u2 } = await createUser({ name: "ثانٍ", username: "second.acc", password: STRONG }, actor);
    const e = await createEmployee(baseEmp);
    await linkEmployeeAccount(e!.id, u1);
    await expect(linkEmployeeAccount(e!.id, u2)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("فكّ ربط موظف بلا حساب ⇒ BAD_REQUEST", async () => {
    const e = await createEmployee(baseEmp);
    await expect(unlinkEmployeeAccount(e!.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("إنشاء حساب لموظف قائم (تعبئة من الموظف) + تراجع عند تكرار البريد", async () => {
    const e = await createEmployee(baseEmp);
    const { userId } = await createAccountForEmployee(e!.id, { name: "علي", username: "for.emp", password: STRONG }, actor);
    const fresh = await getEmployee(e!.id);
    expect(fresh!.userId).toBe(userId);
    const [u] = await db().select().from(s.users).where(eq(s.users.id, userId));
    expect(u.phone).toBe("07701234567"); // من الموظف
    expect(u.jobTitle).toBe("محاسب");
    // تراجع: موظف آخر، بريد مكرّر ⇒ لا يتغيّر ربطه
    await createUser({ name: "x", email: "taken@test.local", password: STRONG }, actor);
    const e2 = await createEmployee({ ...baseEmp, firstName: "ثانٍ" });
    await expect(
      createAccountForEmployee(e2!.id, { name: "y", email: "taken@test.local", password: STRONG }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getEmployee(e2!.id))!.userId).toBeNull();
  });
});

describe("listLinkableUsers", () => {
  it("يُعيد النشطين غير المرتبطين فقط + يحترم البحث", async () => {
    const { userId: free } = await createUser({ name: "متاح زيد", username: "free.one", password: STRONG }, actor);
    const { userId: taken } = await createUser({ name: "مرتبط عمر", username: "taken.one", password: STRONG }, actor);
    const e = await createEmployee(baseEmp);
    await linkEmployeeAccount(e!.id, taken);
    const all = await listLinkableUsers({});
    const ids = all.map((u) => u.id);
    expect(ids).toContain(free);
    expect(ids).not.toContain(taken);
    const byQ = await listLinkableUsers({ q: "زيد" });
    expect(byQ.some((u) => u.id === free)).toBe(true);
    expect(byQ.some((u) => u.id === taken)).toBe(false);
  });
});

describe("بوّابة admin على employees.createWithAccount (الراوتر)", () => {
  const HR_FULL = { hr: "FULL" as const };
  function ctxWith(role: string, override: Record<string, string> | null): TrpcContext {
    return {
      req: { headers: {} } as unknown as TrpcContext["req"],
      res: {} as unknown as TrpcContext["res"],
      user: { id: 1, role, branchId: 1, name: "t", email: "t@t", isActive: true, permissionsOverride: override } as unknown as TrpcContext["user"],
    };
  }
  const caller = (role: string, override: Record<string, string> | null = null) => appRouter.createCaller(ctxWith(role, override));

  it("مدير (hr/FULL) + mode:new ⇒ FORBIDDEN (منع تصعيد الامتياز)", async () => {
    await expect(
      caller("manager", HR_FULL).employees.createWithAccount({ ...baseEmp, account: { mode: "new", name: "x", username: "mgr.try", password: STRONG } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await counts()).employees).toBe(0); // لم يُنشأ موظف
  });

  it("مدير (hr/FULL) + mode:none ⇒ ينجح بلا حساب", async () => {
    const res = await caller("manager", HR_FULL).employees.createWithAccount({ ...baseEmp, account: { mode: "none" } });
    expect(res.employee).toBeTruthy();
    expect(res.credentials).toBeNull();
    expect(res.employee?.userId).toBeNull();
  });

  it("admin + mode:new ⇒ ينشئ ويعيد بيانات الدخول", async () => {
    const res = await caller("admin").employees.createWithAccount({ ...baseEmp, account: { mode: "new", name: "x", username: "admin.made", password: STRONG } });
    expect(typeof res.employee?.userId).toBe("number");
    expect(res.credentials?.password).toBe(STRONG);
    expect(res.credentials?.username).toBe("admin.made");
  });
});
