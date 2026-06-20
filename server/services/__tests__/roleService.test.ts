import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { resolvePermissions } from "@shared/permissions";
import { hashPassword } from "../../auth/password";
import { resolveCustomRole } from "../../context";
import { getDb } from "../../db";
import {
  createRole,
  deleteRole,
  getRole,
  listCustomRoles,
  setRoleActive,
  updateRole,
} from "../roleService";
import { createUser, getUser, updateUser } from "../userService";

const actor = { userId: 1, branchId: 1 };
const otherActor = { userId: 999, branchId: 1 };
const TABLES = ["auditLogs", "users", "roles", "branches"];
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
    id: 1, openId: "local_admin", name: "المدير", email: "admin@test.local", username: "admin",
    passwordHash: hashPassword("Admin@12345"), role: "admin", loginMethod: "local", branchId: 1,
  });
}

/** خريطة صلاحيات كاملة بقيمة موحّدة ثم تخصيصات. */
function perms(over: Record<string, "FULL" | "READ" | "NONE"> = {}) {
  return { pos: "NONE", sales: "NONE", purchases: "NONE", inventory: "NONE", workorders: "NONE", customers: "NONE", suppliers: "NONE", products: "NONE", expenses: "NONE", reports: "NONE", assets: "NONE", hr: "NONE", users: "NONE", settings: "NONE", ...over } as Record<string, "FULL" | "READ" | "NONE">;
}

beforeEach(async () => { await reset(); await seedAdmin(); });

describe("roleService — إنشاء/تحقّق", () => {
  it("ينشئ دوراً مخصّصاً بمفتاح مشتقّ وخريطة مطبّعة", async () => {
    const r = await createRole({ label: "مشرف فرع", baseRole: "cashier", permissions: perms({ pos: "FULL", sales: "FULL", reports: "READ" }) }, actor);
    expect(r.id).toBeGreaterThan(0);
    const row = await getRole(r.id);
    expect(row?.baseRole).toBe("cashier");
    expect((row?.permissions as any).pos).toBe("FULL");
    expect((row?.permissions as any).inventory).toBe("NONE"); // المفقود = NONE
    expect(row?.canSeeCost).toBe(false); // cashier لا يرى التكلفة
  });

  it("يرفض الفئة الأساسية admin (تتجاوز التخصيص)", async () => {
    await expect(createRole({ label: "x", baseRole: "admin", permissions: perms() }, actor)).rejects.toThrow(/مدير النظام|أدنى/);
  });

  it("يرفض مفتاحاً محجوزاً لدور مبني", async () => {
    await expect(createRole({ label: "كاشير", key: "cashier", baseRole: "cashier", permissions: perms() }, actor)).rejects.toThrow(/محجوز/);
  });

  it("يرفض وحدة صلاحيات غير معروفة", async () => {
    await expect(createRole({ label: "y", baseRole: "user", permissions: { bogus: "FULL" } as any }, actor)).rejects.toThrow(/غير معروفة/);
  });

  it("يرفض مفتاحاً مكرّراً (CONFLICT)", async () => {
    await createRole({ label: "دور أ", key: "role_a", baseRole: "user", permissions: perms() }, actor);
    await expect(createRole({ label: "دور أ٢", key: "role_a", baseRole: "user", permissions: perms() }, actor)).rejects.toThrow(/مستخدم مسبقاً/);
  });

  it("اسمان عربيّان (بلا أحرف لاتينية) ⇒ مفتاحان فريدان بلا تصادم", async () => {
    const a = await createRole({ label: "مشرف فرع", baseRole: "cashier", permissions: perms({ pos: "FULL" }) }, actor);
    const b = await createRole({ label: "مشرف مخزن", baseRole: "warehouse", permissions: perms({ inventory: "FULL" }) }, actor);
    const ra = await getRole(a.id); const rb = await getRole(b.id);
    expect(ra?.key).not.toBe(rb?.key);
    expect(ra?.key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("baseRole محاسب ⇒ canSeeCost=true (يتبع الفئة)", async () => {
    const r = await createRole({ label: "محاسب مخصّص", baseRole: "accountant", permissions: perms({ reports: "FULL" }) }, actor);
    expect((await getRole(r.id))?.canSeeCost).toBe(true);
  });
});

describe("roleService — إسناد لمستخدم + حلّ السياق", () => {
  it("إسناد دور مخصّص يضبط role=baseRole + customRoleId، والسياق يحلّ الصلاحيات", async () => {
    const role = await createRole({ label: "مشرف", baseRole: "cashier", permissions: perms({ pos: "FULL", sales: "FULL", reports: "FULL" }) }, actor);
    const { userId } = await createUser({ name: "مروة", username: "marwa", password: PW, customRoleId: role.id }, actor);
    const row = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    expect(row.role).toBe("cashier"); // baseRole
    expect(Number(row.customRoleId)).toBe(role.id);

    // حلّ السياق (resolveCustomRole): role=baseRole، والصلاحيات الفعّالة = خريطة الدور المخصّص.
    const u = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0] as any;
    await resolveCustomRole(u);
    expect(u.role).toBe("cashier");
    expect(u.customRoleLabel).toBe("مشرف");
    const eff = resolvePermissions(u.role, u.permissionsOverride);
    expect(eff.reports).toBe("FULL"); // الكاشير المبني reports=NONE ⇒ التخصيص فعّال
    expect(eff.pos).toBe("FULL");
  });

  it("تعديل خريطة الدور ينتشر للمستخدم المُسنَد (حلّ لحظي) + يُبطل جلسته", async () => {
    const role = await createRole({ label: "د", baseRole: "user", permissions: perms({ reports: "READ" }) }, actor);
    const { userId } = await createUser({ name: "ع", username: "omar", password: PW, customRoleId: role.id }, actor);
    const before = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    await new Promise((r) => setTimeout(r, 1100));
    await updateRole({ id: role.id, permissions: perms({ reports: "FULL", customers: "FULL" }) }, actor);
    const after = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    expect(new Date(after.sessionsValidFrom).getTime()).toBeGreaterThan(new Date(before.sessionsValidFrom).getTime());
    const u = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0] as any;
    await resolveCustomRole(u);
    const eff = resolvePermissions(u.role, u.permissionsOverride);
    expect(eff.customers).toBe("FULL"); // التعديل انتشر لحظياً عبر حلّ السياق
  });

  it("تبديل المستخدم لدور مبني يمسح الدور المخصّص", async () => {
    const role = await createRole({ label: "د", baseRole: "cashier", permissions: perms({ pos: "FULL" }) }, actor);
    const { userId } = await createUser({ name: "س", username: "salem", password: PW, customRoleId: role.id }, actor);
    await updateUser({ userId, role: "warehouse" }, otherActor);
    const row = await getUser(userId);
    expect(row?.role).toBe("warehouse");
    expect(row?.customRoleId == null).toBe(true);
  });
});

describe("roleService — تعطيل/حذف بحُرّاس المراجع", () => {
  it("يمنع تعطيل/حذف دور مُسنَد لمستخدم نشط", async () => {
    const role = await createRole({ label: "د", baseRole: "user", permissions: perms() }, actor);
    await createUser({ name: "ن", username: "noor", password: PW, customRoleId: role.id }, actor);
    await expect(setRoleActive(role.id, false, actor)).rejects.toThrow(/مُسنَد|نشطين/);
    await expect(deleteRole(role.id, actor)).rejects.toThrow(/مُسنَد|غيّر/);
  });

  it("يحذف دوراً غير مُسنَد", async () => {
    const role = await createRole({ label: "يتيم", baseRole: "user", permissions: perms() }, actor);
    const r = await deleteRole(role.id, actor);
    expect(r.deleted).toBe(true);
    expect(await getRole(role.id)).toBeNull();
  });

  it("listCustomRoles يعرض النشطة افتراضياً", async () => {
    await createRole({ label: "نشط", baseRole: "user", permissions: perms() }, actor);
    const list = await listCustomRoles();
    expect(list.length).toBe(1);
  });
});
