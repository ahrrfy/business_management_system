import { describe, expect, it, vi } from "vitest";
import { deriveEffectiveAccess, resolvePermissions } from "./permissions";

vi.mock("./operationPermissionCatalog.generated", () => {
  const metadata = {
    kind: "mutation",
    module: "sales",
    roles: ["cashier", "manager"],
    authority: "module-gate",
    branch: "required",
    label: "عملية",
    domain: "sales",
    resource: "invoice",
    lifecycleStage: "execute",
    legacyAliases: [],
    delegable: true,
    level: "FULL",
    supportsRecordScope: true,
  };
  return {
    GENERATED_OPERATION_PERMISSIONS: [
      { ...metadata, key: "operation.sales.create", path: "sales.create" },
      { ...metadata, key: "operation.printPos.createSale", path: "printPos.createSale", module: "pos" },
      { ...metadata, key: "operation.workOrders.receptionCheckout", path: "workOrders.receptionCheckout", module: "workorders" },
      { ...metadata, key: "operation.purchases.pay", path: "purchases.pay", delegable: false, reservedKind: "RETIRED" },
      { ...metadata, key: "operation.purchaseReturns.create", path: "purchaseReturns.create", delegable: false, reservedKind: "RETIRED" },
      { ...metadata, key: "operation.reports.costRead", path: "reports.costRead", kind: "query", module: "reports", level: "READ", requiresCostVisibility: true },
      {
        ...metadata,
        key: "operation.returns.create",
        path: "returns.create",
        legacyAliases: ["pos.return.create", "pos.refund.create"],
      },
      {
        ...metadata,
        key: "operation.delivery.dispatch",
        path: "delivery.dispatch",
        module: "store",
        roles: ["manager"],
        domain: "delivery",
        resource: "parcel",
      },
      {
        ...metadata,
        key: "operation.sales.list",
        path: "sales.list",
        kind: "query",
        authority: "module-map",
        roles: [],
        level: "READ",
        branch: "scoped",
      },
      {
        ...metadata,
        key: "operation.purchases.fullLookup",
        path: "purchases.fullLookup",
        kind: "query",
        module: "purchases",
        roles: ["purchasing"],
        level: "FULL",
        supportsRecordScope: false,
      },
      {
        ...metadata,
        key: "operation.catalog.lookup",
        path: "catalog.lookup",
        kind: "query",
        module: "sales|workorders|products",
        authority: "module-map",
        roles: [],
        level: "READ",
      },
      {
        ...metadata,
        key: "operation.users.create",
        path: "users.create",
        module: "users",
        roles: ["admin"],
        authority: "admin",
        delegable: false,
        branch: false,
      },
      {
        ...metadata,
        key: "operation.ownership.approve",
        path: "ownership.approve",
        module: "ownership",
        roles: [],
        authority: "owner",
        delegable: false,
        branch: false,
      },
      {
        ...metadata,
        key: "operation.self.current",
        path: "self.current",
        module: null,
        roles: ["authenticated-user"],
        authority: "self-assignment",
        delegable: false,
        branch: "self",
      },
    ],
  };
});

import {
  applyLegacyOperationDenials,
  buildOperationPolicyFromLegacy,
  canViewOperationData,
  deriveOperationAccess,
  getOperationPermission,
  hasOperationPolicy,
  legacyOperationPolicy,
  operationDecision,
  operationPolicySchema,
  operationRecordScope,
  resolveOperationPolicy,
  summarizeOperationModules,
  type OperationPolicy,
} from "./operationPermissions";

const policy = (grants: Record<string, boolean>): OperationPolicy => ({
  version: 1,
  grants,
});
const cashierModules = resolvePermissions("cashier", null);
const managerModules = resolvePermissions("manager", null);

describe("actual access preview", () => {
  const canonical = (role: string, grants: Record<string, boolean>, cost = false) => ({
    role,
    operationPolicyEnabled: true,
    resolvedOperationPolicy: {
      ...policy(grants),
      dataVisibility: { purchaseCost: cost, profitMargin: cost },
    },
  });

  it("shows delegated cost visibility independently of the base category", () => {
    for (const [role, visible] of [["courier", true], ["manager", false]] as const) {
      const user = canonical(role, {}, visible);
      expect(deriveOperationAccess(user).canSeeCost).toBe(canViewOperationData(user, "purchaseCost"));
      expect(deriveOperationAccess(user).canSeeCost).toBe(visible);
    }
  });

  it("requires the exact station operation, not another write in the same module", () => {
    expect(deriveOperationAccess(canonical("manager", { "operation.returns.create": true })).stations).toEqual([]);
    for (const [path, station] of [["sales.create", "RETAIL"], ["printPos.createSale", "PRINT_SERVICES"], ["workOrders.receptionCheckout", "RECEPTION"]] as const) {
      const user = canonical("courier", { [`operation.${path}`]: true });
      expect(deriveOperationAccess(user).stations).toEqual([station]);
      expect(deriveOperationAccess(user).station).toBe(station);
    }
  });

  it("does not restore admin or disabled-role authority over a saved deny policy", () => {
    for (const role of ["admin", "user"])
      expect(deriveOperationAccess(canonical(role, {}))).toMatchObject({ station: "NONE", stations: [], canSeeCost: false });
  });

  it("shows multiple explicitly delegated stations without granting the third", () => {
    expect(deriveOperationAccess(canonical("courier", {
      "operation.sales.create": true,
      "operation.printPos.createSale": true,
    }))).toMatchObject({ station: "MULTI", stations: ["RETAIL", "PRINT_SERVICES"] });
  });

  it("applies individual denials over an inherited role without changing that role", () => {
    const rolePolicy = {
      ...policy({ "operation.sales.create": true, "operation.printPos.createSale": true }),
      dataVisibility: { purchaseCost: true, profitMargin: true },
    };
    const userPolicy = {
      ...policy({ "operation.sales.create": false }),
      dataVisibility: { purchaseCost: false, profitMargin: false },
    };
    expect(deriveOperationAccess({ role: "manager", roleOperationPolicy: rolePolicy, operationPolicy: userPolicy }))
      .toMatchObject({ stations: ["PRINT_SERVICES"], canSeeCost: false });
    expect(deriveOperationAccess({ role: "manager", roleOperationPolicy: rolePolicy }))
      .toMatchObject({ stations: ["RETAIL", "PRINT_SERVICES"], canSeeCost: true });
    expect(rolePolicy.grants["operation.sales.create"]).toBe(true);
  });

  it("keeps a selected cost read out of the effective module summary until visibility is allowed", () => {
    const user = canonical("manager", { "operation.reports.costRead": true });
    expect(deriveOperationAccess(user).resolved.reports).toBe("NONE");
    expect(user.resolvedOperationPolicy.grants["operation.reports.costRead"]).toBe(true);
    expect(deriveOperationAccess(canonical("courier", { "operation.reports.costRead": true }, true)).resolved.reports).toBe("READ");
  });

  it("preserves legacy previews and the protected owner authority", () => {
    const override = { sales: "NONE" as const };
    expect(deriveOperationAccess({ role: "cashier", permissionsOverride: override })).toEqual(deriveEffectiveAccess("cashier", override));
    expect(deriveOperationAccess({ ...canonical("courier", {}), isOwner: true })).toEqual(deriveEffectiveAccess("admin", null));
  });
});

describe("operation policies", () => {
  it("removes only retired keys from old full policies without changing grants or visibility", () => {
    for (const retiredGrant of [true, false]) {
      const visibility = { purchaseCost: true, profitMargin: true };
      const old = {
        version: 1 as const,
        grants: {
          "operation.sales.create": true,
          "operation.returns.create": false,
          "operation.purchases.pay": retiredGrant,
          "operation.purchaseReturns.create": !retiredGrant,
        },
        recordScopes: { "operation.sales.create": "OWN" as const, "operation.purchases.pay": "BRANCH" as const },
        dataVisibility: visibility,
      };
      expect(operationPolicySchema.parse(old)).toEqual({
        version: 1,
        grants: { "operation.sales.create": true, "operation.returns.create": false },
        recordScopes: { "operation.sales.create": "OWN" },
        dataVisibility: visibility,
      });
      expect(old.grants["operation.purchases.pay"]).toBe(retiredGrant);
      expect(old.recordScopes).toHaveProperty("operation.purchases.pay", "BRANCH");
    }
    for (const key of ["operation.unknown.path", "operation.users.create"])
      expect(operationPolicySchema.safeParse(policy({ "operation.purchases.pay": true, [key]: true })).success).toBe(false);
    expect(operationPolicySchema.safeParse({ ...policy({}), recordScopes: { "operation.unknown.path": "BRANCH" } }).success).toBe(false);
  });
  it("maps only the canonical tRPC path and operation key", () => {
    expect(getOperationPermission("returns.create")?.key).toBe(
      "operation.returns.create",
    );
    expect(getOperationPermission("operation.returns.create")?.path).toBe(
      "returns.create",
    );
    expect(getOperationPermission("pos.refund.create")).toBeUndefined();
  });

  it("denies all omitted permissions in a saved role", () => {
    const resolved = resolveOperationPolicy(
      "manager",
      managerModules,
      policy({ "operation.sales.create": true }),
    );
    expect(resolved.grants["operation.sales.create"]).toBe(true);
    expect(resolved.grants["operation.returns.create"]).toBe(false);
    expect(resolved.grants["operation.sales.list"]).toBe(false);
  });

  it("uses exact operation grants independently of the base role", () => {
    const rolePolicy = policy({ "operation.delivery.dispatch": true });
    const cashier = resolveOperationPolicy(
      "cashier",
      cashierModules,
      rolePolicy,
    );
    const manager = resolveOperationPolicy(
      "manager",
      managerModules,
      rolePolicy,
    );
    expect(cashier).toEqual(manager);
    expect(cashier.grants["operation.delivery.dispatch"]).toBe(true);
    expect(cashier.grants["operation.sales.create"]).toBe(false);
  });

  it("inherits sparse user choices and applies explicit user denial", () => {
    const rolePolicy = policy({
      "operation.sales.create": true,
      "operation.returns.create": true,
    });
    const userPolicy = policy({
      "operation.returns.create": false,
      "operation.delivery.dispatch": true,
    });
    const resolved = resolveOperationPolicy(
      "cashier",
      cashierModules,
      rolePolicy,
      userPolicy,
    );
    expect(resolved.grants["operation.sales.create"]).toBe(true);
    expect(resolved.grants["operation.returns.create"]).toBe(false);
    expect(resolved.grants["operation.delivery.dispatch"]).toBe(true);
    expect(rolePolicy.grants["operation.returns.create"]).toBe(true);
    expect(rolePolicy.grants["operation.delivery.dispatch"]).toBeUndefined();
  });

  it("does not change another user's inherited role", () => {
    const rolePolicy = policy({ "operation.sales.create": true });
    const first = resolveOperationPolicy(
      "cashier",
      cashierModules,
      rolePolicy,
      policy({ "operation.sales.create": false }),
    );
    const second = resolveOperationPolicy(
      "cashier",
      cashierModules,
      rolePolicy,
    );
    expect(first.grants["operation.sales.create"]).toBe(false);
    expect(second.grants["operation.sales.create"]).toBe(true);
  });

  it("uses legacy inheritance when only individual overrides exist", () => {
    const resolved = resolveOperationPolicy(
      "cashier",
      cashierModules,
      null,
      policy({ "operation.delivery.dispatch": true }),
    );
    expect(resolved.grants["operation.sales.create"]).toBe(true);
    expect(resolved.grants["operation.delivery.dispatch"]).toBe(true);
  });

  it("preserves an explicit old module grant over a restrictive preset", () => {
    const permissionsOverride = { purchases: "FULL" as const };
    const resolved = resolveOperationPolicy(
      "cashier",
      resolvePermissions("cashier", permissionsOverride),
      policy({
        "operation.sales.create": true,
        "operation.purchases.fullLookup": false,
        "operation.delivery.dispatch": false,
      }),
      null,
      permissionsOverride,
      { permissionsOverride, inheritedModules: cashierModules },
    );
    expect(resolved.grants["operation.purchases.fullLookup"]).toBe(true);
    expect(resolved.grants["operation.sales.create"]).toBe(true);
    expect(resolved.grants["operation.delivery.dispatch"]).toBe(false);
  });

  it("inherits and overrides record scopes without allowing cross-branch scope", () => {
    const rolePolicy: OperationPolicy = {
      ...policy({ "operation.sales.list": true }),
      recordScopes: { "operation.sales.list": "BRANCH" },
    };
    const userPolicy: OperationPolicy = {
      ...policy({}),
      recordScopes: { "operation.sales.list": "OWN" },
    };
    expect(
      resolveOperationPolicy("cashier", cashierModules, rolePolicy)
        .recordScopes?.["operation.sales.list"],
    ).toBe("BRANCH");
    const resolved = resolveOperationPolicy(
      "cashier",
      cashierModules,
      rolePolicy,
      userPolicy,
    );
    expect(
      operationRecordScope(
        { role: "cashier", resolvedOperationPolicy: resolved },
        "sales.list",
      ),
    ).toBe("OWN");
    expect(
      operationPolicySchema.safeParse({
        ...rolePolicy,
        recordScopes: { "operation.sales.list": "ALL" },
      }).success,
    ).toBe(false);
  });

  it("defaults a saved role to own records and hidden sensitive fields", () => {
    const resolved = resolveOperationPolicy(
      "manager",
      managerModules,
      policy({ "operation.sales.list": true }),
    );
    expect(resolved.recordScopes?.["operation.sales.list"]).toBe("OWN");
    expect(resolved.dataVisibility?.purchaseCost).toBe(false);
    expect(resolved.dataVisibility?.profitMargin).toBe(false);
  });

  it("delegates the combined cost and profit capability with sparse user revocation", () => {
    const rolePolicy: OperationPolicy = {
      ...policy({}),
      dataVisibility: {
        purchaseCost: true,
        profitMargin: true,
      },
    };
    const userPolicy: OperationPolicy = {
      ...policy({}),
      dataVisibility: { purchaseCost: false, profitMargin: false },
    };
    const resolved = resolveOperationPolicy(
      "cashier",
      cashierModules,
      rolePolicy,
      userPolicy,
    );
    const user = { role: "cashier", resolvedOperationPolicy: resolved };
    expect(
      canViewOperationData(
        { role: "cashier", roleOperationPolicy: rolePolicy },
        "purchaseCost",
      ),
    ).toBe(true);
    expect(canViewOperationData(user, "purchaseCost")).toBe(false);
    expect(canViewOperationData(user, "profitMargin")).toBe(false);
  });
});

describe("catalog validation", () => {
  it("accepts canonical boolean grants", () => {
    expect(
      operationPolicySchema.parse(
        policy({
          "operation.sales.create": true,
          "operation.returns.create": false,
        }),
      ),
    ).toEqual(
      policy({
        "operation.sales.create": true,
        "operation.returns.create": false,
      }),
    );
  });

  it.each([
    "operation.missing.path",
    "pos.return.create",
    "operation.users.create",
    "operation.self.current",
  ])("rejects unknown, alias or reserved grant %s", (key) => {
    expect(
      operationPolicySchema.safeParse(policy({ [key]: true })).success,
    ).toBe(false);
  });

  it("rejects nonboolean grant, unknown data fields and unsupported scopes", () => {
    expect(
      operationPolicySchema.safeParse({
        version: 1,
        grants: { "operation.sales.create": "true" },
      }).success,
    ).toBe(false);
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        dataVisibility: { salaries: true },
      }).success,
    ).toBe(false);
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        dataVisibility: { customerContact: true },
      }).success,
    ).toBe(false);
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        recordScopes: { "operation.purchases.fullLookup": "OWN" },
      }).success,
    ).toBe(false);
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        recordScopes: { "operation.users.create": "BRANCH" },
      }).success,
    ).toBe(false);
  });

  it("requires both cost and profit flags to be supplied together and equal", () => {
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        dataVisibility: { purchaseCost: true },
      }).success,
    ).toBe(false);
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        dataVisibility: { profitMargin: false },
      }).success,
    ).toBe(false);
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        dataVisibility: { purchaseCost: true, profitMargin: false },
      }).success,
    ).toBe(false);
    expect(
      operationPolicySchema.safeParse({
        ...policy({}),
        dataVisibility: { purchaseCost: true, profitMargin: true },
      }).success,
    ).toBe(true);
    expect(
      operationPolicySchema.safeParse({ ...policy({}), dataVisibility: {} })
        .success,
    ).toBe(true);
  });
});

describe("legacy compatibility and migration", () => {
  it("preserves legacy role/module gates without expanding unrelated modules", () => {
    const legacy = legacyOperationPolicy("cashier", cashierModules);
    expect(legacy.grants["operation.sales.create"]).toBe(true);
    expect(legacy.grants["operation.delivery.dispatch"]).toBe(false);
    expect(legacy.grants["operation.users.create"]).toBeUndefined();
    const restricted = legacyOperationPolicy(
      "cashier",
      { ...cashierModules, sales: "NONE" },
      { sales: "NONE" },
    );
    expect(restricted.grants["operation.sales.create"]).toBe(false);
  });

  it("requires explicit module grants for a role outside a legacy gate", () => {
    const modules = { ...cashierModules, store: "FULL" as const };
    expect(
      legacyOperationPolicy("warehouse", modules, null).grants[
        "operation.delivery.dispatch"
      ],
    ).toBe(false);
    expect(
      legacyOperationPolicy("warehouse", modules, { store: "FULL" }).grants[
        "operation.delivery.dispatch"
      ],
    ).toBe(true);
  });

  it("respects inherited FULL requirement even for a query", () => {
    const modules = { purchases: "READ" as const };
    expect(
      legacyOperationPolicy("purchasing", modules, { purchases: "READ" })
        .grants["operation.purchases.fullLookup"],
    ).toBe(false);
    expect(
      legacyOperationPolicy(
        "purchasing",
        { purchases: "FULL" },
        { purchases: "FULL" },
      ).grants["operation.purchases.fullLookup"],
    ).toBe(true);
  });

  it.each(["pos.return.create", "pos.refund.create"])(
    "carries explicit alias revocation %s to its real path",
    (alias) => {
      const converted = buildOperationPolicyFromLegacy(
        "cashier",
        cashierModules,
        { [alias]: false },
      );
      expect(converted.grants["operation.returns.create"]).toBe(false);
      expect(converted.grants["operation.sales.create"]).toBe(true);
    },
  );

  it("does not transform a legacy alias ALLOW into new grants", () => {
    const base = policy({ "operation.returns.create": false });
    expect(
      applyLegacyOperationDenials(base, { "pos.refund.create": true }).grants[
        "operation.returns.create"
      ],
    ).toBe(false);
    expect(base.grants).toEqual({ "operation.returns.create": false });
  });

  it("summarizes only the directly owned module, never alternative lookup modules", () => {
    const summary = summarizeOperationModules(
      policy({
        "operation.sales.create": true,
        "operation.catalog.lookup": true,
      }),
    );
    expect(summary.sales).toBe("FULL");
    expect(summary.store).toBe("NONE");
    expect(summary.workorders).toBe("NONE");
    expect(summary.products).toBe("NONE");
  });
});

describe("operation decision", () => {
  it("uses the same exact grant for visible choice and CASL evaluation", () => {
    const rolePolicy = policy({ "operation.delivery.dispatch": true });
    const user = { role: "cashier", roleOperationPolicy: rolePolicy };
    expect(operationDecision(user, "delivery.dispatch")).toMatchObject({
      allowed: true,
      source: "role",
      key: "operation.delivery.dispatch",
    });
    expect(operationDecision(user, "returns.create").allowed).toBe(false);
    expect(
      operationDecision(
        {
          ...user,
          operationPolicy: policy({ "operation.delivery.dispatch": false }),
        },
        "delivery.dispatch",
      ),
    ).toMatchObject({ allowed: false, source: "user" });
  });

  it("denies unregistered paths and keeps protected authority external", () => {
    const user = {
      role: "cashier",
      resolvedOperationPolicy: policy({ "operation.users.create": true }),
    };
    expect(operationDecision(user, "missing.path")).toMatchObject({
      allowed: false,
      source: "unknown",
    });
    expect(operationDecision(user, "users.create")).toMatchObject({
      allowed: false,
      source: "protected",
    });
    expect(operationDecision({ role: "admin" }, "users.create")).toMatchObject({
      allowed: true,
      source: "admin",
    });
    expect(
      operationDecision(
        { role: "cashier", isOwner: true },
        "ownership.approve",
      ),
    ).toMatchObject({ allowed: true, source: "owner" });
  });

  it("legacy access previews respect an explicit cost visibility revocation", () => {
    expect(deriveOperationAccess({ role: "manager", permissionsOverride: { reports: "NONE" } }).canSeeCost).toBe(false);
  });

  it("distinguishes saved policies from the compatibility fallback", () => {
    expect(hasOperationPolicy({ role: "cashier" })).toBe(false);
    expect(
      hasOperationPolicy({
        role: "cashier",
        resolvedOperationPolicy: policy({}),
      }),
    ).toBe(false);
    expect(
      hasOperationPolicy({
        role: "cashier",
        resolvedOperationPolicy: policy({}),
        operationPolicyEnabled: true,
      }),
    ).toBe(true);
    expect(
      hasOperationPolicy({ role: "cashier", operationPolicy: policy({}) }),
    ).toBe(true);
    expect(
      operationDecision({ role: "cashier" }, "sales.create"),
    ).toMatchObject({ allowed: true, source: "legacy" });
  });
});
