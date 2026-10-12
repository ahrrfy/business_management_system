import { describe, expect, it, vi } from "vitest";
import { catalogPeopleOperationAllowed } from "./catalogPeopleOperationAccess";
import { resolveOperationPolicy, type OperationPolicy, type OperationUser } from "@shared/operationPermissions";

vi.mock("@/lib/trpc", () => ({ trpc: {} }));

function account(grants: Record<string, boolean>, role = "cashier"): OperationUser {
  const policy: OperationPolicy = { version: 1, grants };
  return { role, operationPolicyEnabled: true, roleOperationPolicy: policy };
}

describe("catalog, people and asset operation access", () => {
  it("allows an independently delegated customer update without activation or import", () => {
    const user = account({ "operation.customers.update": true });
    expect(catalogPeopleOperationAllowed(user, "customers.update", false)).toBe(true);
    expect(catalogPeopleOperationAllowed(user, "customers.activate", true)).toBe(false);
    expect(catalogPeopleOperationAllowed(user, "imports.customers", true)).toBe(false);
  });

  it("separates asset acquisition, maintenance, custody and depreciation", () => {
    const user = account({ "operation.assets.handover": true });
    expect(catalogPeopleOperationAllowed(user, "assets.handover", false)).toBe(true);
    for (const path of ["assets.create", "assets.addMaintenance", "assets.postDepreciation", "assets.import"])
      expect(catalogPeopleOperationAllowed(user, path, true)).toBe(false);
  });

  it("lets a user override grant cancellation while revoking the inherited advance grant", () => {
    const user = account({ "operation.payroll.advanceGrant": true });
    user.operationPolicy = { version: 1, grants: { "operation.payroll.advanceGrant": false, "operation.payroll.advanceCancel": true } };
    user.resolvedOperationPolicy = resolveOperationPolicy(user.role, {}, user.roleOperationPolicy, user.operationPolicy);
    expect(catalogPeopleOperationAllowed(user, "payroll.advanceCancel", false)).toBe(true);
    expect(catalogPeopleOperationAllowed(user, "payroll.advanceGrant", true)).toBe(false);
  });

  it("denies an admin's omitted canonical operations", () => {
    const user = account({}, "admin");
    expect(catalogPeopleOperationAllowed(user, "catalog.delete", true)).toBe(false);
  });

  it("requires the cost visibility flags for last purchase cost", () => {
    const user = account({ "operation.catalog.lastPurchaseCost": true });
    expect(catalogPeopleOperationAllowed(user, "catalog.lastPurchaseCost", true)).toBe(false);
    user.roleOperationPolicy!.dataVisibility = { purchaseCost: true, profitMargin: true };
    expect(catalogPeopleOperationAllowed(user, "catalog.lastPurchaseCost", false)).toBe(true);
  });

  it("preserves the original authority of protected account management", () => {
    const user = account({ "operation.users.create": true });
    expect(catalogPeopleOperationAllowed(user, "users.create", false)).toBe(false);
    expect(catalogPeopleOperationAllowed(user, "users.create", true)).toBe(false);
    const admin = account({}, "admin");
    expect(catalogPeopleOperationAllowed(admin, "users.create", true)).toBe(true);
    expect(catalogPeopleOperationAllowed(admin, "users.create", false)).toBe(false);
  });

  it("retains untouched legacy behavior and waits for the account to load", () => {
    expect(catalogPeopleOperationAllowed({ role: "manager" }, "catalog.createProduct", true)).toBe(true);
    expect(catalogPeopleOperationAllowed({ role: "cashier" }, "catalog.createProduct", false)).toBe(false);
    expect(catalogPeopleOperationAllowed(undefined, "catalog.createProduct", true)).toBe(false);
  });
});
