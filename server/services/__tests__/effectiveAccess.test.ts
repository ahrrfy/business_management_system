/**
 * طبقة الشفافية (ش١ RBAC): الأثر الفعليّ محسوبٌ من الخريطة المحلولة لا من الـdiff الخام.
 * يحرس المبدأ الحاكم «العرض يقول الحقيقة عن السلوك» عبر مستويين: الدالة النقيّة (deriveEffectiveAccess)
 * والمسار الخادميّ الكامل (getEffectivePermissions + عمود listUsers.effectiveStation).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  ROLE_TEMPLATES,
  deriveEffectiveAccess,
  diffFromTemplate,
  visibleStations,
} from "@shared/permissions";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { createRole, setRoleActive } from "../roleService";
import { createUser, getEffectivePermissions, listUsers, setUserActive } from "../userService";

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

describe("deriveEffectiveAccess — دالة نقيّة (مصدر حقيقة العرض)", () => {
  it("الكاشير القالبيّ يفتح الأقسام الثلاثة (تجزئة+طباعة+استقبال — القالب واسع جداً، حجّة قلب الافتراضي)", () => {
    // قالب cashier يمنح sales+pos+workorders=FULL ⇒ يرى الأقسام الثلاثة. هذا بالضبط السبب البنيويّ
    // الذي يجعل النظام «بدائياً»: أوسع دور = افتراضيّ، فيسهل أن يرى حسابٌ كلَّ شيء بلا قصد (يُعالَج في ش٣).
    const eff = deriveEffectiveAccess("cashier", null);
    expect(eff.stations).toEqual(["RETAIL", "PRINT_SERVICES", "RECEPTION"]);
    expect(eff.station).toBe("MULTI");
    expect(eff.canSeeCost).toBe(false);
  });

  it("كاشير تجزئة (pos=NONE) ⇒ RETAIL فقط", () => {
    const override = { pos: "NONE" as const, workorders: "NONE" as const };
    const eff = deriveEffectiveAccess("cashier", override);
    expect(eff.stations).toEqual(["RETAIL"]);
    expect(eff.station).toBe("RETAIL");
  });

  it("كاشير طباعة (sales=NONE) ⇒ PRINT_SERVICES فقط", () => {
    const override = { sales: "NONE" as const, workorders: "NONE" as const };
    const eff = deriveEffectiveAccess("cashier", override);
    expect(eff.stations).toEqual(["PRINT_SERVICES"]);
    expect(eff.station).toBe("PRINT_SERVICES");
  });

  it("المحاسب لا يفتح أي قسم بيع نقديّ (sales=READ/pos=NONE)", () => {
    const eff = deriveEffectiveAccess("accountant", null);
    expect(eff.stations).toEqual([]);
    expect(eff.station).toBe("NONE");
    expect(eff.canSeeCost).toBe(true);
  });

  it("منحٌ صريح للوحدة يفتح قسمها لدور خارج القائمة (مرآة moduleAccessAllowed)", () => {
    expect(visibleStations("user", { pos: "FULL" as const })).toEqual(["PRINT_SERVICES"]);
    expect(visibleStations("user", null)).toEqual([]);
  });
});

describe("getEffectivePermissions — المسار الخادميّ الكامل", () => {
  it("دور مخصّص «كاشير طباعة» ⇒ station=PRINT_SERVICES + مصدر القيمة customRole", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } },
      actor,
    );
    const { userId } = await createUser({ name: "ط", username: "print1", password: PW, customRoleId: role.id }, actor);
    const eff = await getEffectivePermissions(userId);
    expect(eff?.effectiveRole).toBe("cashier");
    expect(eff?.customRoleLabel).toBe("كاشير طباعة");
    expect(eff?.access.station).toBe("PRINT_SERVICES");
    // sales هبطت من FULL (قالب الكاشير) إلى NONE عبر الدور المخصّص ⇒ مصدرها customRole.
    const salesRow = eff?.modules.find((m) => m.key === "sales");
    expect(salesRow?.level).toBe("NONE");
    expect(salesRow?.source).toBe("customRole");
    // pos = FULL يطابق قالب الكاشير ⇒ مصدرها template.
    expect(eff?.modules.find((m) => m.key === "pos")?.source).toBe("template");
  });

  it("دور مخصّص معطَّل ⇒ فشلٌ مغلق إلى user (ش٢) + customRoleInactive=true + لا قسم بيع", async () => {
    const role = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { pos: "FULL", sales: "NONE", workorders: "NONE" } },
      actor,
    );
    const { userId } = await createUser({ name: "ط", username: "print2", password: PW, customRoleId: role.id }, actor);
    await setUserActive(userId, false, actor);
    await setRoleActive(role.id, false, actor);
    const eff = await getEffectivePermissions(userId);
    expect(eff?.customRoleInactive).toBe(true);
    // ش٢ إغلاق الفشل المفتوح: الهبوط لأضيق دور «user» (لا cashier الكامل) ⇒ لا قسم بيع (كان يسرّب الثلاثة).
    expect(eff?.effectiveRole).toBe("user");
    expect(eff?.access.station).toBe("NONE");
  });

  it("admin ⇒ كل الوحدات مصدرها admin + station=MULTI", async () => {
    const eff = await getEffectivePermissions(1);
    expect(eff?.access.station).toBe("MULTI");
    expect(eff?.modules.every((m) => m.source === "admin")).toBe(true);
  });
});

describe("listUsers.effectiveStation — القسم الفعليّ في القائمة", () => {
  it("يعيد القسم الصحيح لكل صفّ (مخصّص محسوب من خريطة الدور، مبنيّ من العمود)", async () => {
    const retail = await createRole(
      { label: "كاشير تجزئة", baseRole: "cashier", permissions: { ...ROLE_TEMPLATES.cashier, pos: "NONE", workorders: "NONE" } },
      actor,
    );
    const print = await createRole(
      { label: "كاشير طباعة", baseRole: "cashier", permissions: { ...ROLE_TEMPLATES.cashier, sales: "NONE", workorders: "NONE" } },
      actor,
    );
    await createUser({ name: "تجزئة", username: "retail1", password: PW, customRoleId: retail.id }, actor);
    await createUser({ name: "طباعة", username: "print3", password: PW, customRoleId: print.id }, actor);
    // مبنيّ بأوفررايد فرديّ يحصره في الطباعة (بلا دور مخصّص).
    await createUser({
      name: "يدوي", username: "manual1", password: PW, role: "cashier",
      permissionsOverride: diffFromTemplate("cashier", { ...ROLE_TEMPLATES.cashier, sales: "NONE", workorders: "NONE" }),
    }, actor);

    const { rows } = await listUsers({});
    const byName = (n: string) => rows.find((r) => r.username === n) as { effectiveStation?: string } | undefined;
    expect(byName("retail1")?.effectiveStation).toBe("RETAIL");
    expect(byName("print3")?.effectiveStation).toBe("PRINT_SERVICES");
    expect(byName("manual1")?.effectiveStation).toBe("PRINT_SERVICES");
    // لا تُسرَّب خريطة الدور الكاملة في صفوف القائمة (القسم فقط).
    expect((byName("retail1") as Record<string, unknown>)?._rolePermissions).toBeUndefined();
  });
});
