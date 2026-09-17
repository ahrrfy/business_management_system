import { describe, expect, it } from "vitest";
import {
  SECTION_CASHIER_ROLES,
  diffFromTemplate,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import {
  TREASURY_READ_GATE,
  resolveWorkspaceProfile,
} from "./workspaceProfiles";

function sectionRole(key: string): {
  role: RoleKey;
  permissionsOverride: PermissionMap | null;
} {
  const spec = SECTION_CASHIER_ROLES.find((candidate) => candidate.key === key);
  if (!spec) throw new Error(`missing section role ${key}`);
  return {
    role: spec.baseRole,
    permissionsOverride: diffFromTemplate(spec.baseRole, spec.permissions),
  };
}

function ids(input: Parameters<typeof resolveWorkspaceProfile>[0]): string[] {
  return resolveWorkspaceProfile(input).primaryNav.map((item) => item.id);
}

describe("resolveWorkspaceProfile", () => {
  it("يبقى فارغاً حتى تُحلّ هوية الجلسة", () => {
    for (const role of [undefined, null] as const) {
      const profile = resolveWorkspaceProfile({ role });
      expect(profile.id).toBe("unresolved");
      expect(profile.stations).toEqual([]);
      expect(profile.primaryNav).toEqual([]);
      expect(profile.queues).toEqual([]);
      expect(profile.defaultAction).toBeNull();
    }
  });

  it("يثبت مصفوفة المساحات الأساسية بأربعة مداخل تشغيلية كحد أقصى", () => {
    const matrix = [
      ["manager", ["my_work", "reports", "treasury", "work_orders"]],
      ["accountant", ["treasury", "reports", "ar", "ap"]],
      ["cashier", ["retail_pos", "print_pos", "reception_pos", "invoices"]],
      [
        "print_operator",
        ["work_orders", "my_tasks", "product_studio", "inbox"],
      ],
      ["warehouse", ["inventory", "my_stocktakes", "transfers", "backorders"]],
      ["purchasing", ["purchases", "purchase_new", "suppliers", "reorder"]],
      [
        "sales_rep",
        ["sales_followups", "inbox", "sales_pipeline", "quotations"],
      ],
      ["auditor", ["reports", "closing", "invoices", "inventory"]],
      ["courier", ["my_deliveries"]],
    ] as const satisfies readonly (readonly [RoleKey, readonly string[]])[];

    for (const [role, expected] of matrix) {
      expect(ids({ role }), role).toEqual(expected);
    }
  });

  it.each([
    [
      "retail_cashier",
      "cashier_retail",
      "RETAIL",
      ["retail_pos", "invoices", "sales_returns", "my_tasks"],
    ],
    [
      "print_cashier",
      "cashier_print",
      "PRINT_SERVICES",
      ["print_pos", "invoices", "price_checker", "my_tasks"],
    ],
    [
      "reception_clerk",
      "reception",
      "RECEPTION",
      ["reception_pos", "work_orders", "invoices", "my_tasks"],
    ],
  ] as const)(
    "يفصل محطة %s ولا يسرّب إليها محطة أخرى",
    (key, profileId, station, expected) => {
      const profile = resolveWorkspaceProfile(sectionRole(key));
      expect(profile.id).toBe(profileId);
      expect(profile.stations).toEqual([station]);
      expect(profile.primaryNav.map((item) => item.id)).toEqual(expected);
      expect(
        profile.primaryNav.filter((item) => item.access.kind === "STATION"),
      ).toHaveLength(1);
      expect(profile.defaultAction?.id).toBe(expected[0]);
    },
  );

  it("لا يصنّف المدير ككاشير متعدد المحطات", () => {
    const owner = resolveWorkspaceProfile({ role: "admin" });
    const manager = resolveWorkspaceProfile({ role: "manager" });
    expect(owner.id).toBe("management");
    expect(manager.id).toBe("management");
    expect(manager.stations).toEqual(["RETAIL", "PRINT_SERVICES", "RECEPTION"]);
    expect(manager.primaryNav.map((item) => item.id)).not.toContain(
      "retail_pos",
    );
  });

  it("يسحب NONE مداخل الإدارة والمحاسبة المرتبطة بالبوابة نفسها", () => {
    expect(
      ids({
        role: "manager",
        permissionsOverride: {
          reports: "NONE",
          treasury: "NONE",
          workorders: "NONE",
          inventory: "NONE",
        },
      }),
    ).toEqual(["my_work"]);
    expect(
      ids({
        role: "accountant",
        permissionsOverride: { reports: "NONE", treasury: "NONE" },
      }),
    ).toEqual([]);
  });

  it("يطابق ثابت قراءة الخزينة أدوار الإجراء الخادمي", () => {
    expect(TREASURY_READ_GATE).toEqual({
      roles: ["manager", "accountant", "cashier", "auditor"],
      module: "treasury",
      level: "READ",
    });
  });

  it("يحرس الذمم المدينة والدائنة ببوابة قارئ التقارير", () => {
    const profile = resolveWorkspaceProfile({ role: "accountant" });
    for (const id of ["ar", "ap"] as const) {
      const item = profile.primaryNav.find((candidate) => candidate.id === id);
      expect(item?.access).toEqual({
        kind: "GATE",
        gate: {
          roles: ["manager", "accountant", "auditor"],
          module: "reports",
          level: "READ",
        },
      });
    }
  });

  it("يحرس إعادة الطلب بقراءة المخزون لا بكتابة المشتريات", () => {
    const profile = resolveWorkspaceProfile({ role: "purchasing" });
    expect(
      profile.primaryNav.find((item) => item.id === "reorder")?.access,
    ).toEqual({
      kind: "GATE",
      gate: { module: "inventory", level: "READ" },
    });
    expect(
      ids({ role: "purchasing", permissionsOverride: { inventory: "NONE" } }),
    ).toEqual(["purchases", "purchase_new", "suppliers"]);
  });

  it("يحرس عروض الأسعار بقراءة المبيعات ويسحب عناصر المبيعات حسب وحداتها", () => {
    const profile = resolveWorkspaceProfile({ role: "sales_rep" });
    expect(
      profile.primaryNav.find((item) => item.id === "quotations")?.access,
    ).toEqual({
      kind: "GATE",
      gate: { module: "sales", level: "READ" },
    });
    expect(
      ids({
        role: "sales_rep",
        permissionsOverride: { crm: "NONE", channels: "NONE", sales: "NONE" },
      }),
    ).toEqual([]);
  });

  it("يبقي جردي مساحةً مسندةً لمستخدم مصادق ويشدّد التحويلات إلى FULL", () => {
    const profile = resolveWorkspaceProfile({
      role: "warehouse",
      permissionsOverride: { inventory: "READ" },
    });
    expect(profile.primaryNav.map((item) => item.id)).toEqual([
      "inventory",
      "my_stocktakes",
      "backorders",
    ]);
    expect(
      profile.primaryNav.find((item) => item.id === "my_stocktakes")?.access,
    ).toEqual({ kind: "AUTHENTICATED" });

    const full = resolveWorkspaceProfile({ role: "warehouse" });
    expect(
      full.primaryNav.find((item) => item.id === "transfers")?.access,
    ).toEqual({
      kind: "GATE",
      gate: {
        roles: ["warehouse", "manager"],
        module: "inventory",
        level: "FULL",
      },
    });
    expect(full.primaryNav.find((item) => item.id === "backorders")?.href).toBe(
      "/inventory?tab=backorder",
    );
  });

  it("يسحب NONE مداخل المدقق ولا يترك بوابة تقارير أو مخزون مفتوحة", () => {
    expect(
      ids({
        role: "auditor",
        permissionsOverride: {
          reports: "NONE",
          sales: "NONE",
          inventory: "NONE",
        },
      }),
    ).toEqual([]);
  });

  it("يضيف مهام المندوب بمنحة صريحة فقط", () => {
    expect(ids({ role: "courier" })).toEqual(["my_deliveries"]);
    expect(
      ids({ role: "courier", permissionsOverride: { tasks: "READ" } }),
    ).toEqual(["my_deliveries", "my_tasks"]);
  });

  it("يبني المساحة العامة من أول أربعة مداخل ناجحة بالترتيب المتفق عليه", () => {
    const base = resolveWorkspaceProfile({ role: "user" });
    expect(base.id).toBe("general");
    expect(base.primaryNav.map((item) => item.id)).toEqual([
      "my_work",
      "my_tasks",
      "invoices",
      "inventory",
    ]);

    const printGranted = resolveWorkspaceProfile({
      role: "user",
      permissionsOverride: { pos: "FULL" },
    });
    expect(printGranted.id).toBe("general");
    expect(printGranted.stations).toEqual(["PRINT_SERVICES"]);
    expect(printGranted.primaryNav.map((item) => item.id)).toEqual([
      "print_pos",
      "my_work",
      "my_tasks",
      "invoices",
    ]);
  });

  it("يفرض ثوابت القائمة ولا يحمل أي عنصر وصولاً ضمنياً", () => {
    const cases = [
      { role: "admin" },
      { role: "accountant" },
      { role: "cashier" },
      sectionRole("retail_cashier"),
      sectionRole("print_cashier"),
      sectionRole("reception_clerk"),
      { role: "print_operator" },
      { role: "warehouse" },
      { role: "purchasing" },
      { role: "sales_rep" },
      { role: "auditor" },
      { role: "courier", permissionsOverride: { tasks: "READ" } },
      { role: "user" },
    ] satisfies Array<{
      role: RoleKey;
      permissionsOverride?: PermissionMap | null;
    }>;

    for (const input of cases) {
      const profile = resolveWorkspaceProfile(input);
      const itemIds = profile.primaryNav.map((item) => item.id);
      expect(profile.primaryNav.length, input.role).toBeLessThanOrEqual(4);
      expect(new Set(itemIds).size, input.role).toBe(itemIds.length);
      if (profile.defaultAction)
        expect(itemIds, input.role).toContain(profile.defaultAction.id);
      for (const item of profile.primaryNav) {
        expect(
          ["PUBLIC", "AUTHENTICATED", "GATE", "STATION"],
          item.id,
        ).toContain(item.access.kind);
        expect(Object.hasOwn(item, "gate"), item.id).toBe(false);
        expect(Object.hasOwn(item, "station"), item.id).toBe(false);
      }
      expect(resolveWorkspaceProfile(input)).toEqual(profile);
    }
  });
});
