/**
 * صدق تسمية الدور المخصّص في قوائم/تفاصيل المستخدمين (٢٤/٧/٢٦).
 *
 * جذر الشكوى: حساب «كاشير تدريبي» على دورٍ مخصّص «كاشير طباعة» كان يظهر في قائمة المستخدمين
 * وشاشة «حسابي» بتسمية فئته الأساس («كاشير») فقط — فيفتح كاشير الطباعة ويبدو النظام «غير
 * منطقي» للمالك. الإصلاح: getUser/listUsers يعيدان `customRoleLabel` (LEFT JOIN roles) دائماً.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { ROLE_TEMPLATES, SECTION_CASHIER_ROLES, diffFromTemplate, resolvePermissions } from "@shared/permissions";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { createRole, setRoleActive } from "../roleService";
import { createUser, getUser, listUsers, setUserActive, updateUser } from "../userService";

const actor = { userId: 1, branchId: 1 };
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

beforeEach(async () => { await reset(); await seedAdmin(); });

describe("userService — تسمية الدور المخصّص (customRoleLabel)", () => {
  it("getUser يعيد تسمية الدور المخصّص، وnull لصاحب الدور المبني", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } },
      actor,
    );
    const { userId: customUserId } = await createUser(
      { name: "كاشير تدريبي", username: "tray", password: PW, customRoleId: role.id },
      actor,
    );
    const { userId: plainUserId } = await createUser(
      { name: "كاشير عادي", username: "plain", password: PW, role: "cashier" },
      actor,
    );

    const customUser = await getUser(customUserId);
    expect(customUser?.role).toBe("cashier"); // baseRole للبوّابات
    expect(customUser?.customRoleLabel).toBe("كاشير طباعة"); // التسمية الحقيقية للعرض

    const plainUser = await getUser(plainUserId);
    expect(plainUser?.customRoleLabel ?? null).toBeNull();
  });

  it("listUsers يعيد customRoleLabel لكل صفّ (المخصّص بتسميته، المبني بلا تسمية)", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } },
      actor,
    );
    await createUser({ name: "كاشير تدريبي", username: "tray", password: PW, customRoleId: role.id }, actor);
    await createUser({ name: "كاشير عادي", username: "plain", password: PW, role: "cashier" }, actor);

    const { rows } = await listUsers({});
    const custom = rows.find((r) => r.username === "tray");
    const plain = rows.find((r) => r.username === "plain");
    expect(custom?.customRoleLabel).toBe("كاشير طباعة");
    expect(plain?.customRoleLabel ?? null).toBeNull();

    // فلتر الدور يفلتر بالفئة الأساس ويُبقي التسمية الحقيقية ظاهرة (لا يعود «كاشير» مجرّدة).
    const { rows: cashiers } = await listUsers({ role: "cashier" });
    expect(cashiers.some((r) => r.username === "tray" && r.customRoleLabel === "كاشير طباعة")).toBe(true);
  });

  it("أدوار الأقسام المبذورة تحمل تسميتين مميّزتين (كاشير تجزئة/كاشير طباعة) بفئة cashier", () => {
    // حارس مواصفة: لو تغيّرت التسميات/الفئة تنكسر تجربة التمييز التي بُني عليها العرض.
    const labels = SECTION_CASHIER_ROLES.map((r) => r.label);
    expect(labels).toContain("كاشير تجزئة");
    expect(labels).toContain("كاشير طباعة");
    for (const spec of SECTION_CASHIER_ROLES) expect(spec.baseRole).toBe("cashier");
  });

  it("دور مخصّص مُعطَّل ⇒ لا تسمية في القائمة/التفاصيل (العرض يطابق الإنفاذ الساقط للفئة الأساس)", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } },
      actor,
    );
    const { userId } = await createUser(
      { name: "كاشير تدريبي", username: "tray", password: PW, customRoleId: role.id },
      actor,
    );
    // تعطيل الدور يتطلب ألّا يكون عليه مستخدم نشط ⇒ عطّل المستخدم أولاً (نفس تسلسل الواقع).
    await setUserActive(userId, false, actor);
    await setRoleActive(role.id, false, actor);

    const u = await getUser(userId);
    expect(u?.customRoleId).toBe(role.id); // الإسناد باقٍ في الصف
    expect(u?.customRoleLabel ?? null).toBeNull(); // لكن التسمية تسقط مع سقوط الإنفاذ

    const { rows } = await listUsers({ includeInactive: true });
    expect(rows.find((r) => r.username === "tray")?.customRoleLabel ?? null).toBeNull();
  });

  it("حارس إعادة التفعيل: مستخدم دوره المخصّص مُعطَّل لا يُفعَّل (وإلا استيقظ بقالب الفئة كاملاً)", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } },
      actor,
    );
    const { userId } = await createUser(
      { name: "كاشير تدريبي", username: "tray", password: PW, customRoleId: role.id },
      actor,
    );
    await setUserActive(userId, false, actor);
    await setRoleActive(role.id, false, actor);
    await expect(setUserActive(userId, true, actor)).rejects.toThrow(/مُعطَّل|أسنِد/);
    // تفعيل الدور يفتح الطريق من جديد.
    await setRoleActive(role.id, true, actor);
    const r = await setUserActive(userId, true, actor);
    expect(r.isActive).toBe(true);
  });

  it("updateUser يكنس override ميتاً لمستخدم على دور مخصّص (لا يستيقظ عند مسح الدور لاحقاً)", async () => {
    const role = await createRole(
      { label: "مقيّد", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } },
      actor,
    );
    const { userId } = await createUser({ name: "س", username: "sara", password: PW, customRoleId: role.id }, actor);
    // زرع override ميت مباشرة (يحاكي بيانات قديمة سبقت الحارس).
    await db().update(s.users).set({ permissionsOverride: { sales: "FULL" } }).where(sql`id = ${userId}`);
    // أي تعديل عابر (اسم فقط) يكنس البقايا.
    await updateUser({ userId, name: "سارة" }, { userId: 999, branchId: 1 });
    const afterEdit = (await db().select().from(s.users).where(sql`id = ${userId}`).limit(1))[0];
    expect(afterEdit.permissionsOverride ?? null).toBeNull();
    // مسح الدور المخصّص يهبط على قالب نظيف (لا override قديم يستيقظ).
    await updateUser({ userId, customRoleId: null }, { userId: 999, branchId: 1 });
    const cleared = (await db().select().from(s.users).where(sql`id = ${userId}`).limit(1))[0];
    expect(cleared.customRoleId ?? null).toBeNull();
    expect(cleared.permissionsOverride ?? null).toBeNull();
  });
});

describe("diffFromTemplate — دلالة المفتاح الغائب الموحَّدة (منع افتراضي)", () => {
  it("خريطة مخزَّنة تسبق إضافة وحدة جديدة ⇒ الوحدة الغائبة NONE لا قيمة القالب الحالي", () => {
    // خريطة «كاشير طباعة» كما خُزّنت قبل دخول وحدة tasks (بلا مفتاح tasks إطلاقاً).
    const stored = { ...ROLE_TEMPLATES.cashier, sales: "NONE" as const, workorders: "NONE" as const };
    delete (stored as Record<string, unknown>).tasks;
    const diff = diffFromTemplate("cashier", stored);
    // قالب cashier الحالي يمنح tasks=FULL ⇒ الغياب يجب أن يُحَلّ فرقاً صريحاً إلى NONE.
    expect(diff?.tasks).toBe("NONE");
    // والخريطة الفعّالة المحلولة تعكس المنع — مطابقةً لما يعرضه محرّر الأدوار (الغائب = «لا وصول»).
    const eff = resolvePermissions("cashier", diff);
    expect(eff.tasks).toBe("NONE");
    // القيم المخزَّنة صراحةً لا تتأثر.
    expect(diff?.sales).toBe("NONE");
    expect(eff.pos).toBe("FULL");
  });
});
