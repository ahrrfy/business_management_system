import { describe, it, expect } from "vitest";
import {
  ALL_PERMISSION_MODULE_KEYS,
  PERMISSION_MODULES,
  type AccessLevel,
} from "@shared/permissions";
import { deriveLegacyModulesFromAtomic } from "@shared/atomicPermissions";

describe("RBAC Permission Whitelist Forensic Contract", () => {
  it("ALL_PERMISSION_MODULE_KEYS includes all 28 PERMISSION_MODULES + legacy keys (customers, tasks)", () => {
    const activeKeys = PERMISSION_MODULES.map((m) => m.key);
    expect(activeKeys).toHaveLength(28);

    for (const key of activeKeys) {
      expect(ALL_PERMISSION_MODULE_KEYS).toContain(key);
    }

    expect(ALL_PERMISSION_MODULE_KEYS).toContain("customers");
    expect(ALL_PERMISSION_MODULE_KEYS).toContain("tasks");
    expect(ALL_PERMISSION_MODULE_KEYS).toHaveLength(30);
  });

  it("deriveLegacyModulesFromAtomic outputs valid levels for all 30 modules", () => {
    const derived = deriveLegacyModulesFromAtomic({ "pos.invoice.create": true });
    for (const key of ALL_PERMISSION_MODULE_KEYS) {
      expect(derived[key]).toBeDefined();
      expect(["FULL", "READ", "NONE"]).toContain(derived[key]);
    }
  });

  it("recognizes legacy tasks as an allowed backward-compatible module", () => {
    const allowed = new Set<string>(ALL_PERMISSION_MODULE_KEYS);
    expect(allowed.has("tasks")).toBe(true);
    expect(allowed.has("customers")).toBe(true);
    expect(allowed.has("crm")).toBe(true);
    expect(allowed.has("bogus_unknown_module")).toBe(false);
  });
});
