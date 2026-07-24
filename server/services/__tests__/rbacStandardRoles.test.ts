/**
 * ش٣ — الأدوار القياسية من الدرجة الأولى: دور «موظف استقبال» الجديد + فني المطبعة لمحطة الاستقبال +
 * حماية الأدوار القياسية (isSystem) من الحذف/تغيير الفئة + قلب الافتراضي الآمن.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  ROLE_TEMPLATES,
  SECTION_CASHIER_ROLES,
  canUseStation,
  deriveEffectiveAccess,
  diffFromTemplate,
  visibleStations,
} from "@shared/permissions";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { deleteRole, updateRole } from "../roleService";

const actor = { userId: 1, branchId: 1 };
const TABLES = ["auditLogs", "users", "roles", "branches"];
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

describe("ش٣ — مواصفة الأدوار القياسية", () => {
  it("«موظف استقبال» موجود بفئة cashier ومحطة RECEPTION، وثلاثة أدوار قسم مميّزة", () => {
    const recep = SECTION_CASHIER_ROLES.find((r) => r.key === "reception_clerk");
    expect(recep).toBeDefined();
    expect(recep!.baseRole).toBe("cashier");
    expect(recep!.station).toBe("RECEPTION");
    expect(SECTION_CASHIER_ROLES.map((r) => r.station).sort()).toEqual(["PRINT_SERVICES", "RECEPTION", "RETAIL"]);
  });

  it("«موظف استقبال» يفتح الاستقبال فقط (لا التجزئة ولا الطباعة)", () => {
    const spec = SECTION_CASHIER_ROLES.find((r) => r.key === "reception_clerk")!;
    // كما يُحَلّ في السياق: baseRole=cashier + override مشتقّ من خريطته.
    const override = diffFromTemplate("cashier", spec.permissions);
    expect(canUseStation("RECEPTION", "cashier", override)).toBe(true);
    expect(canUseStation("RETAIL", "cashier", override)).toBe(false);
    expect(canUseStation("PRINT_SERVICES", "cashier", override)).toBe(false);
    expect(deriveEffectiveAccess("cashier", override).station).toBe("RECEPTION");
  });

  it("فنّي المطبعة (قرار المالك ش٣) يفتح الآن محطة الاستقبال، لا قسمَي البيع النقديّ", () => {
    expect(visibleStations("print_operator", null)).toEqual(["RECEPTION"]);
    expect(canUseStation("RECEPTION", "print_operator", null)).toBe(true);
    expect(canUseStation("RETAIL", "print_operator", null)).toBe(false);
    expect(canUseStation("PRINT_SERVICES", "print_operator", null)).toBe(false);
  });
});

describe("ش٣ — حماية الأدوار القياسية (isSystem)", () => {
  async function insertSystemRole() {
    const res = await db().insert(s.roles).values({
      key: "reception_clerk", label: "موظف استقبال", baseRole: "cashier",
      permissions: { ...ROLE_TEMPLATES.cashier, sales: "NONE", pos: "NONE" },
      canSeeCost: false, isActive: true, isSystem: true, station: "RECEPTION",
    });
    const id = Number((res as unknown as { insertId: number }).insertId ?? (res as any)[0]?.insertId);
    return id;
  }

  it("يمنع حذف دور قياسيّ محميّ", async () => {
    const id = await insertSystemRole();
    await expect(deleteRole(id, actor)).rejects.toThrow(/قياسيّ محميّ|عطّله/);
  });

  it("يمنع تغيير الفئة الأساسية لدور قياسيّ، ويسمح بتحرير التسمية", async () => {
    const id = await insertSystemRole();
    await expect(updateRole({ id, baseRole: "manager" }, actor)).rejects.toThrow(/الفئة الأساسية|قياسيّ/);
    const ok = await updateRole({ id, label: "موظف استقبال ٢" }, actor);
    expect(ok.changed).toBe(true);
  });
});

describe("ش٣ — قلب الافتراضي الآمن (خاصية الأمان)", () => {
  it("«user» (افتراضي الحساب الجديد) لا يفتح أي قسم بيع؛ بينما «cashier» العام يفتح الثلاثة", () => {
    // قلب الافتراضي من cashier إلى user يضمن: يستحيل أن يرى حسابٌ الأقسام بلا إسنادٍ صريح لدورٍ قياسيّ.
    expect(deriveEffectiveAccess("user", null).station).toBe("NONE");
    expect(deriveEffectiveAccess("cashier", null).stations).toEqual(["RETAIL", "PRINT_SERVICES", "RECEPTION"]);
  });
});
