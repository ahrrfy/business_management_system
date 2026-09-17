import { describe, expect, it } from "vitest";
import {
  SECTION_CASHIER_ROLES,
  diffFromTemplate,
  type PermissionMap,
} from "@shared/permissions";
import {
  cashierProfileActions,
  receptionOperationAvailability,
} from "./cashierWorkspace";
import { resolveWorkspaceProfile } from "./workspaceProfiles";

function sectionProfile(key: string) {
  const section = SECTION_CASHIER_ROLES.find((candidate) => candidate.key === key);
  if (!section) throw new Error(`missing section role ${key}`);
  return resolveWorkspaceProfile({
    role: section.baseRole,
    permissionsOverride: diffFromTemplate(
      section.baseRole,
      section.permissions,
    ) as PermissionMap,
  });
}

function remainingIds(profile: ReturnType<typeof resolveWorkspaceProfile>) {
  if (!profile.defaultAction) return [];
  return cashierProfileActions(profile.primaryNav, profile.defaultAction.id).map(
    (item) => item.id,
  );
}

describe("cashierProfileActions", () => {
  it("يعرض للكاشير متعدد المحطات المحطتين الأخريين والفواتير بلا تكرار الافتراضي", () => {
    const profile = resolveWorkspaceProfile({ role: "cashier" });
    expect(profile.defaultAction?.id).toBe("retail_pos");
    expect(remainingIds(profile)).toEqual([
      "print_pos",
      "reception_pos",
      "invoices",
    ]);
  });

  it.each([
    ["retail_cashier", ["invoices", "sales_returns", "my_tasks"]],
    ["print_cashier", ["invoices", "price_checker", "my_tasks"]],
    ["reception_clerk", ["work_orders", "invoices", "my_tasks"]],
  ] as const)("يحترم إجراءات profile للقسم %s", (key, expected) => {
    expect(remainingIds(sectionProfile(key))).toEqual(expected);
  });

  it("لا يعيد إدخالاً أسقطه حل الصلاحيات", () => {
    const profile = resolveWorkspaceProfile({
      role: "cashier",
      permissionsOverride: {
        sales: "NONE",
        pos: "FULL",
        workorders: "NONE",
        tasks: "NONE",
      },
    });
    expect(remainingIds(profile)).toEqual(["invoices", "price_checker"]);
  });

  it("يبقي قارئ الأسعار وحده عند غياب الفرع ويغلق كل مسار تشغيلي مقصور", () => {
    const profile = sectionProfile("print_cashier");
    expect(profile.defaultAction?.id).toBe("print_pos");
    expect(
      cashierProfileActions(profile.primaryNav, profile.defaultAction.id, {
        hasBranch: false,
      }).map((item) => item.id),
    ).toEqual(["price_checker"]);
  });

  it("يغلق روابط الاستقبال التي تركب استعلامات الخزينة والمتجر عند سحبها", () => {
    expect(
      receptionOperationAvailability({
        hasBranch: true,
        canReadTreasury: false,
        canReadStore: false,
      }),
    ).toEqual({
      orders: true,
      handover: false,
      workflow: false,
      invoices: false,
    });
    expect(
      receptionOperationAvailability({
        hasBranch: true,
        canReadTreasury: true,
        canReadStore: true,
      }),
    ).toEqual({
      orders: true,
      handover: true,
      workflow: true,
      invoices: true,
    });
    expect(
      receptionOperationAvailability({
        hasBranch: false,
        canReadTreasury: true,
        canReadStore: true,
      }),
    ).toEqual({
      orders: true,
      handover: false,
      workflow: false,
      invoices: false,
    });
  });
});
