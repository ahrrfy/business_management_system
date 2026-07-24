/**
 * حارس تكافؤ قرارات RBAC (ش٢) — يشفّر **القرار المقصود** لكل بوّابة حسّاسة صراحةً (لا لقطة عمياء).
 * أي انحدار في منطق الإنفاذ (resolvePermissions/moduleAccessAllowed/resolveCustomRole) يُحمِّره فوراً.
 * يغطّي: عزل أقسام POS للأدوار المبذورة (عبر resolveCustomRole الحقيقيّ)، رفض كل أدوار الكاشير على
 * البوّابات المديرية، المسار «خارج القائمة» (المنح الصريح)، حجب بوّابة التقارير الحمراء، والفشل المغلق (ش٢).
 *
 * نموذج القرار مطابقٌ للإنفاذ: moduleProcedure = requireModuleGate = moduleAccessAllowed(role, override,
 * module, level, allowedRoles). فحص الفرع (requireOwnBranch) متعامدٌ ولا تمسّه ش٢، فلا يدخل هنا.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  ALL_ROLES,
  ROLE_TEMPLATES,
  moduleAccessAllowed,
  type PermissionMap,
} from "@shared/permissions";
import { hashPassword } from "../../auth/password";
import { resolveCustomRole } from "../../context";
import { canSeeCostForUser } from "../../trpc";
import { getDb } from "../../db";
import { createRole, setRoleActive } from "../roleService";
import { createUser, setUserActive } from "../userService";

/** مواصفة بوّابة حقيقية (مرآة تعريفها في trpc.ts) — module + minLevel + الأدوار المسموحة. */
type Gate = { name: string; module: string; level: "FULL" | "READ"; allowed: readonly string[] };

/** البوّابات المديرية الحصرية (allowedRoles=[manager] فقط) — يجب أن يُرفَض عليها كل دور أساسه cashier. */
const MANAGER_ONLY: Gate[] = [
  { name: "storeManager", module: "store", level: "FULL", allowed: ["manager"] },
  { name: "customersManager", module: "crm", level: "FULL", allowed: ["manager"] },
  { name: "expensesManager", module: "expenses", level: "FULL", allowed: ["manager"] },
  { name: "tasksManager", module: "tasks", level: "FULL", allowed: ["manager"] },
  { name: "salesManager", module: "sales", level: "FULL", allowed: ["manager"] },
  { name: "inventoryManager", module: "inventory", level: "FULL", allowed: ["manager"] },
  { name: "productsManager", module: "products", level: "FULL", allowed: ["manager"] },
  { name: "commissionsManager", module: "commissions", level: "FULL", allowed: ["manager"] },
  { name: "workordersManager", module: "workorders", level: "FULL", allowed: ["manager"] },
];

/** بوّابات أقسام POS — الأساس الذي يقوم عليه الفصل بين كاشير التجزئة والطباعة. */
const SECTION_GATES = {
  salesCashier: { module: "sales", level: "FULL", allowed: ["cashier", "manager"] } as Gate,
  posCashier: { module: "pos", level: "FULL", allowed: ["cashier", "manager"] } as Gate,
  workordersCashier: { module: "workorders", level: "FULL", allowed: ["cashier", "manager"] } as Gate,
};

/** يحاكي قرار البوّابة الحقيقيّ (requireModuleGate). */
function decide(gate: Gate, role: string, override: PermissionMap | null): boolean {
  return moduleAccessAllowed(role, override, gate.module, gate.level, gate.allowed);
}

const actor = { userId: 1, branchId: 1 };
const TABLES = ["auditLogs", "users", "roles", "branches"];
const PW = "Pass1234!Aaa";
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
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

describe("تكافؤ RBAC — البوّابات المديرية (منع تصعيد أدوار الكاشير)", () => {
  it("كل دور مبنيّ غير (admin/manager) يُرفَض على كل بوّابة مديرية حصرية بأوفررايد فارغ", () => {
    for (const gate of MANAGER_ONLY) {
      for (const role of ALL_ROLES) {
        const expected = role === "admin" || role === "manager";
        expect(decide(gate, role, null), `${gate.name} × ${role}`).toBe(expected);
      }
    }
  });

  it("admin يمرّ كل بوّابة (تجاوز فوقيّ ثابت)", () => {
    for (const gate of [...MANAGER_ONLY, SECTION_GATES.salesCashier, SECTION_GATES.posCashier]) {
      expect(decide(gate, "admin", null)).toBe(true);
    }
  });
});

describe("تكافؤ RBAC — المسار «خارج القائمة» (المنح الصريح) + حجب التقارير", () => {
  it("دور «user» يُمنح pos=FULL صراحةً ⇒ يمرّ بوّابة POS الطباعة؛ وبلا منح يُرفَض", () => {
    expect(decide(SECTION_GATES.posCashier, "user", { pos: "FULL" })).toBe(true);
    expect(decide(SECTION_GATES.posCashier, "user", null)).toBe(false);
  });

  it("بوّابة التقارير الحمراء: warehouse/purchasing/user يُرفَضون بالقالب، ويمرّون بمنح reports صريح فقط", () => {
    const reportGate: Gate = { name: "reportViewer", module: "reports", level: "READ", allowed: ["manager", "accountant", "auditor"] };
    for (const role of ["warehouse", "purchasing", "user"]) {
      expect(decide(reportGate, role, null), `${role} بالقالب`).toBe(false);
      expect(decide(reportGate, role, { reports: "READ" }), `${role} بمنح صريح`).toBe(true);
    }
    // القالبيّون الماليّون يمرّون بلا منح.
    for (const role of ["manager", "accountant", "auditor"]) {
      expect(decide(reportGate, role, null), `${role} قالبيّ`).toBe(true);
    }
  });
});

describe("تكافؤ RBAC — عزل الأقسام للأدوار المبذورة (عبر resolveCustomRole الحقيقيّ)", () => {
  async function resolvedUserOf(customRoleId: number) {
    const { userId } = await createUser(
      { name: "u", username: `usr${customRoleId}`, password: PW, customRoleId }, actor,
    );
    const u = (await db().select().from(s.users).where(sql`id = ${userId}`).limit(1))[0] as any;
    await resolveCustomRole(u);
    return u as { role: string; permissionsOverride: PermissionMap | null };
  }

  it("«كاشير تجزئة» ⇒ يمرّ التجزئة فقط (لا الطباعة ولا الاستقبال)", async () => {
    const role = await createRole(
      { label: "كاشير تجزئة", baseRole: "cashier", permissions: { ...ROLE_TEMPLATES.cashier, pos: "NONE", workorders: "NONE" } }, actor,
    );
    const u = await resolvedUserOf(role.id);
    expect(decide(SECTION_GATES.salesCashier, u.role, u.permissionsOverride)).toBe(true);
    expect(decide(SECTION_GATES.posCashier, u.role, u.permissionsOverride)).toBe(false);
    expect(decide(SECTION_GATES.workordersCashier, u.role, u.permissionsOverride)).toBe(false);
  });

  it("«كاشير طباعة» ⇒ يمرّ الطباعة فقط (لا التجزئة ولا الاستقبال)", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { ...ROLE_TEMPLATES.cashier, sales: "NONE", workorders: "NONE" } }, actor,
    );
    const u = await resolvedUserOf(role.id);
    expect(decide(SECTION_GATES.posCashier, u.role, u.permissionsOverride)).toBe(true);
    expect(decide(SECTION_GATES.salesCashier, u.role, u.permissionsOverride)).toBe(false);
    expect(decide(SECTION_GATES.workordersCashier, u.role, u.permissionsOverride)).toBe(false);
  });
});

describe("تكافؤ RBAC — الفشل المغلق (ش٢) + canSeeCost", () => {
  it("مستخدم دوره المخصّص عُطِّل ⇒ resolveCustomRole يهبط إلى user (لا الفئة الكاملة) + وسم + رفض بوّابة البيع", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } }, actor,
    );
    const { userId } = await createUser({ name: "ط", username: "print", password: PW, customRoleId: role.id }, actor);
    // نعطّل المستخدم أولاً (الحارس يمنع تعطيل دورٍ عليه نشطون)، ثم نعطّل الدور — لبلوغ مسار الفشل المغلق.
    await setUserActive(userId, false, actor);
    await setRoleActive(role.id, false, actor);
    const u = (await db().select().from(s.users).where(sql`id = ${userId}`).limit(1))[0] as any;
    await resolveCustomRole(u);
    expect(u.role).toBe("user");
    expect(u.roleLockedByInactiveCustomRole).toBe(true);
    expect(u.permissionsOverride ?? null).toBeNull();
    // لا يمرّ أي بوّابة بيع (فشلٌ مغلق لا اتّساع).
    expect(decide(SECTION_GATES.salesCashier, u.role, u.permissionsOverride)).toBe(false);
    expect(decide(SECTION_GATES.posCashier, u.role, u.permissionsOverride)).toBe(false);
  });

  it("canSeeCostForUser: القالبيّون الماليّون فقط يرون التكلفة؛ ودورٌ أساسه manager بـreports=NONE لا يراها", () => {
    expect(canSeeCostForUser({ role: "manager" })).toBe(true);
    expect(canSeeCostForUser({ role: "accountant" })).toBe(true);
    for (const role of ["cashier", "warehouse", "user", "sales_rep", "print_operator", "courier"]) {
      expect(canSeeCostForUser({ role }), role).toBe(false);
    }
    // RBAC-COST: دور مخصّص أساسه manager لكن reports محجوبة ⇒ لا يرى التكلفة.
    expect(canSeeCostForUser({ role: "manager", permissionsOverride: { reports: "NONE" } })).toBe(false);
  });
});
