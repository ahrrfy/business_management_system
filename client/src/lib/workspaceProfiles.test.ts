import { describe, expect, it } from "vitest";
import {
  SECTION_CASHIER_ROLES,
  diffFromTemplate,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { canSeeGate } from "./navVisibility";
import { resolveWorkspaceProfile } from "./workspaceProfiles";

function sectionRole(key: string): { role: RoleKey; permissionsOverride: PermissionMap | null } {
  const spec = SECTION_CASHIER_ROLES.find((candidate) => candidate.key === key);
  if (!spec) throw new Error(`missing section role ${key}`);
  return {
    role: spec.baseRole,
    permissionsOverride: diffFromTemplate(spec.baseRole, spec.permissions),
  };
}

describe("resolveWorkspaceProfile", () => {
  it("يبقى فارغاً حتى تُحلّ هوية الجلسة", () => {
    const profile = resolveWorkspaceProfile({ role: undefined });
    expect(profile.id).toBe("unresolved");
    expect(profile.stations).toEqual([]);
    expect(profile.primaryNav).toEqual([]);
    expect(profile.defaultAction).toBeNull();
  });

  it("لا يصنّف المدير ككاشير متعدد المحطات", () => {
    const owner = resolveWorkspaceProfile({ role: "admin" });
    const manager = resolveWorkspaceProfile({ role: "manager" });
    expect(owner.id).toBe("management");
    expect(manager.id).toBe("management");
    expect(manager.stations).toEqual(["RETAIL", "PRINT_SERVICES", "RECEPTION"]);
    expect(manager.primaryNav.map((item) => item.id)).not.toContain("retail_pos");
  });

  it("يحترم المنع الصريح داخل ملف الإدارة من دون تغيير هويته", () => {
    const profile = resolveWorkspaceProfile({
      role: "manager",
      permissionsOverride: {
        sales: "NONE",
        pos: "NONE",
        workorders: "NONE",
        inventory: "NONE",
        treasury: "NONE",
      },
    });
    expect(profile.id).toBe("management");
    expect(profile.primaryNav.map((item) => item.id)).not.toContain("treasury");
    expect(profile.primaryNav.map((item) => item.id)).not.toContain("work_orders");
  });

  it("يعرض للكاشير القالبي محطاته الثلاث بالترتيب التشغيلي", () => {
    const profile = resolveWorkspaceProfile({ role: "cashier" });
    expect(profile.id).toBe("cashier_multi");
    expect(profile.stations).toEqual(["RETAIL", "PRINT_SERVICES", "RECEPTION"]);
    expect(profile.primaryNav.slice(0, 3).map((item) => item.id)).toEqual([
      "retail_pos",
      "print_pos",
      "reception_pos",
    ]);
  });

  it.each([
    ["retail_cashier", "cashier_retail", "RETAIL", "retail_pos"],
    ["print_cashier", "cashier_print", "PRINT_SERVICES", "print_pos"],
    ["reception_clerk", "reception", "RECEPTION", "reception_pos"],
  ] as const)("يحل دور القسم %s إلى مساحة واحدة", (key, id, station, action) => {
    const profile = resolveWorkspaceProfile(sectionRole(key));
    expect(profile.id).toBe(id);
    expect(profile.stations).toEqual([station]);
    expect(profile.defaultAction?.id).toBe(action);
  });

  it("يهوي الكاشير المحجوبة محطاته إلى مساحة عامة بلا رابط POS", () => {
    const profile = resolveWorkspaceProfile({
      role: "cashier",
      permissionsOverride: { sales: "NONE", pos: "NONE", workorders: "NONE" },
    });
    expect(profile.id).toBe("general");
    expect(profile.stations).toEqual([]);
    expect(profile.primaryNav.some((item) => item.activePath === "/pos")).toBe(false);
  });

  it("يبقي فني المطبعة تقنياً رغم امتلاكه محطة الاستقبال", () => {
    const profile = resolveWorkspaceProfile({ role: "print_operator" });
    expect(profile.id).toBe("technician");
    expect(profile.stations).toEqual(["RECEPTION"]);
    expect(profile.defaultAction?.id).toBe("work_orders");
  });

  it.each([
    ["accountant", "accounting"],
    ["warehouse", "warehouse"],
    ["purchasing", "purchasing"],
    ["sales_rep", "sales"],
    ["auditor", "audit"],
    ["courier", "courier"],
  ] as const)("يختار ملف %s المتوقع", (role, id) => {
    expect(resolveWorkspaceProfile({ role }).id).toBe(id);
  });

  it("يحترم منع المخزون والمهام لأمين المخزن", () => {
    const profile = resolveWorkspaceProfile({
      role: "warehouse",
      permissionsOverride: { inventory: "NONE", tasks: "NONE" },
    });
    expect(profile.id).toBe("warehouse");
    expect(profile.primaryNav.map((item) => item.id)).not.toContain("inventory");
    expect(profile.primaryNav.map((item) => item.id)).not.toContain("my_tasks");
    expect(profile.queues).not.toContain("my_stocktakes");
  });

  it("يبقي المندوب في مساحته ويضيف المهام فقط عند منحها صراحة", () => {
    expect(resolveWorkspaceProfile({ role: "courier" }).primaryNav.map((item) => item.id)).toEqual([
      "my_deliveries",
    ]);
    expect(resolveWorkspaceProfile({ role: "courier", permissionsOverride: { tasks: "READ" } }).primaryNav.map((item) => item.id)).toEqual([
      "my_deliveries",
      "my_tasks",
    ]);
  });

  it("لا يعيد تصنيف المستخدم العام عند منحه محطة طباعة صراحة", () => {
    const profile = resolveWorkspaceProfile({ role: "user", permissionsOverride: { pos: "FULL" } });
    expect(profile.id).toBe("general");
    expect(profile.stations).toEqual(["PRINT_SERVICES"]);
    expect(profile.primaryNav.map((item) => item.id)).toContain("print_pos");
  });

  it("لا يعيد تصنيف مندوب المبيعات عند منحه استقبالاً صراحة", () => {
    const profile = resolveWorkspaceProfile({ role: "sales_rep", permissionsOverride: { workorders: "FULL" } });
    expect(profile.id).toBe("sales");
  });

  it("يعامل null والخريطة الفارغة بالطريقة نفسها", () => {
    expect(resolveWorkspaceProfile({ role: "user", permissionsOverride: null }))
      .toEqual(resolveWorkspaceProfile({ role: "user", permissionsOverride: {} }));
  });

  it("يحافظ على ثوابت القائمة والبوابات من الـoverride الخام", () => {
    const cases = [
      { role: "manager" as const, permissionsOverride: { treasury: "NONE" as const } },
      { role: "cashier" as const, permissionsOverride: null },
      { role: "auditor" as const, permissionsOverride: { reports: "READ" as const } },
      sectionRole("reception_clerk"),
    ];
    for (const input of cases) {
      const profile = resolveWorkspaceProfile(input);
      expect(profile.primaryNav.length).toBeLessThanOrEqual(6);
      expect(new Set(profile.primaryNav.map((item) => item.id)).size).toBe(profile.primaryNav.length);
      if (profile.defaultAction) expect(profile.primaryNav).toContain(profile.defaultAction);
      for (const item of profile.primaryNav) {
        expect(canSeeGate(item.gate, input.role, input.permissionsOverride)).toBe(true);
      }
      expect(resolveWorkspaceProfile(input)).toEqual(profile);
    }
  });
});
