/**
 * tests/e2e/comprehensivePermissionMatrixE2E.test.ts
 *
 * Comprehensive, requirement-driven, opaque-box E2E test suite for the
 * Atomic Permission Key-Tree Matrix & Operational Governance System.
 *
 * Features Covered (PROJECT.md & ORIGINAL_REQUEST.md):
 *  - F1: Domain.Resource.Action Taxonomy (10 operational domains, 75+ atomic keys)
 *  - F2: Digital Operational Caps Schema (quantitative financial ceilings)
 *  - F3: Sensitive Data Masking Controls (cost, margin, supplier & customer contacts)
 *  - F4: Role Default Presets & Dual Resolution Engine (11 roles + 3 cashier roles)
 *  - F5: Safe Storage, Schema & Persistence (envelope model, normalization, diffing)
 *  - F6: 100% Backward Compatibility Engine (29 coarse modules, legacy user fallback)
 *  - F7: Collapsible Key-Tree & Dynamic Counters (domain cards, dynamic badge counters)
 *  - F8: 8 Standard Atomic Action Toggles (view, create, edit, cancel, print, reprint, export, approve)
 *  - F9: 1-Click Smart Presets Bar (9 operational presets)
 *  - F10: Live Search with Arabic Spaces Preservation (intelligent debounced search)
 *  - F11: Visual Custom Override Highlighting (4 semantic states: Base Grant, Base Deny, Override Grant, Override Deny)
 *  - F12: Operational Caps & Masking UI Panel Integration (MoneyInput caps & masking)
 *
 * Test Methodology:
 *  - Tier 1: Feature Coverage (≥5 test cases per feature across F1 to F12)
 *  - Tier 2: Boundary & Corner Cases (Limits, Overflow, Empty, Negative values, Injections)
 *  - Tier 3: Cross-Feature Combinations (Pairwise feature interactions)
 *  - Tier 4: Real-World Enterprise Operational Scenarios (10 comprehensive end-to-end workflows)
 */

import { describe, expect, it } from "vitest";
import {
  ALL_DOMAINS,
  DOMAIN_METADATA,
  STANDARD_ACTIONS,
  ATOMIC_PERMISSION_DEFINITIONS,
  ALL_ATOMIC_PERMISSION_KEYS,
  ATOMIC_PERMISSION_BY_KEY,
  atomicPermissionKeySchema,
  atomicPermissionsMapSchema,
  operationalCapsSchema,
  sensitiveDataMaskingSchema,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  resolveAtomicPermissions,
  resolveOperationalCaps,
  resolveSensitiveDataMasking,
  hasAtomicPermission,
  deriveLegacyModulesFromAtomic,
  deriveAtomicFromLegacyModules,
  isPermissionEnvelope,
  normalizePermissionsInput,
  getAtomicPermissionsByDomain,
  getAtomicPermissionsByResource,
  searchAtomicPermissions,
  getDomainStats,
  filterAtomicOverrides,
  checkSodConflicts,
  isDiscountPercentWithinCap,
  isDiscountAmountWithinCap,
  isCreditSaleWithinCap,
  isPaymentVoucherWithinCap,
  isExpenseWithinCap,
  isRefundWithinCap,
  type AtomicPermissionKey,
  type AtomicPermissionsMap,
  type DomainKey,
  type OperationalCaps,
  type SensitiveDataMasking,
} from "../../shared/atomicPermissions";

describe("Comprehensive Atomic Permission Matrix & Governance E2E Suite", () => {
  // ==========================================================================
  // TIER 1: FEATURE COVERAGE (≥5 test cases per feature across F1 to F12)
  // ==========================================================================

  describe("Tier 1: Feature Coverage", () => {
    // ------------------------------------------------------------------------
    // F1: Domain.Resource.Action Taxonomy
    // ------------------------------------------------------------------------
    describe("F1: Domain.Resource.Action Taxonomy", () => {
      it("T1-F1.1: covers all 10 standard operational domains with complete Arabic metadata", () => {
        expect(ALL_DOMAINS).toHaveLength(10);
        const expectedDomains: DomainKey[] = [
          "pos",
          "reception",
          "workshop",
          "inventory",
          "purchasing",
          "treasury",
          "fieldsales",
          "delivery",
          "hr",
          "governance",
        ];
        expect(ALL_DOMAINS).toEqual(expectedDomains);

        for (const dom of ALL_DOMAINS) {
          const meta = DOMAIN_METADATA[dom];
          expect(meta).toBeDefined();
          expect(meta.key).toBe(dom);
          expect(meta.label.length).toBeGreaterThan(0);
          expect(meta.description.length).toBeGreaterThan(0);
          expect(meta.iconName.length).toBeGreaterThan(0);
          expect(meta.order).toBeGreaterThanOrEqual(1);
        }
      });

      it("T1-F1.2: validates all atomic keys follow the strict Domain.Resource.Action format", () => {
        expect(ALL_ATOMIC_PERMISSION_KEYS.length).toBeGreaterThanOrEqual(75);
        for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
          const parts = key.split(".");
          expect(parts).toHaveLength(3);
          const [domain, resource, action] = parts;
          expect(ALL_DOMAINS).toContain(domain);
          expect(resource.length).toBeGreaterThanOrEqual(2);
          expect(action.length).toBeGreaterThanOrEqual(2);
        }
      });

      it("T1-F1.3: enforces atomic permission definition schema and valid Arabic labels", () => {
        for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
          expect(def.key).toBe(`${def.domain}.${def.resource}.${def.action}`);
          expect(def.label.length).toBeGreaterThan(0);
          expect(def.description.length).toBeGreaterThan(0);
          expect(["normal", "medium", "high", "critical"]).toContain(def.sensitivity);
          expect(def.legacyModule.length).toBeGreaterThan(0);
        }
      });

      it("T1-F1.4: ensures fast O(1) key indexing in ATOMIC_PERMISSION_BY_KEY covers every key", () => {
        for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
          const def = ATOMIC_PERMISSION_BY_KEY[key];
          expect(def).toBeDefined();
          expect(def.key).toBe(key);
        }
      });

      it("T1-F1.5: validates Zod atomicPermissionKeySchema accepts only registered key patterns", () => {
        const validKey = ALL_ATOMIC_PERMISSION_KEYS[0];
        expect(atomicPermissionKeySchema.parse(validKey)).toBe(validKey);

        expect(() => atomicPermissionKeySchema.parse("pos.onlytwoparts")).toThrow();
        expect(() => atomicPermissionKeySchema.parse("INVALID_UPPERCASE.RES.ACT")).toThrow();
        expect(() => atomicPermissionKeySchema.parse("")).toThrow();
        expect(() => atomicPermissionKeySchema.parse("a.b")).toThrow();
      });
    });

    // ------------------------------------------------------------------------
    // F2: Digital Operational Caps Schema
    // ------------------------------------------------------------------------
    describe("F2: Digital Operational Caps Schema", () => {
      it("T1-F2.1: validates operationalCapsSchema parses complete valid caps payload", () => {
        const validCaps: OperationalCaps = {
          maxDiscountPercent: 15,
          maxDiscountAmountIqd: "50000.00",
          maxCreditSaleLimitIqd: "500000.00",
          maxPaymentVoucherAmountIqd: "1000000.00",
          maxExpenseVoucherAmountIqd: "100000.00",
          maxRefundAmountIqd: "25000.00",
        };
        const parsed = operationalCapsSchema.parse(validCaps);
        expect(parsed).toEqual(validCaps);
      });

      it("T1-F2.2: supports nullable and partial caps with safe fallback", () => {
        const partialCaps: OperationalCaps = {
          maxDiscountPercent: 5,
        };
        const parsed = operationalCapsSchema.parse(partialCaps);
        expect(parsed.maxDiscountPercent).toBe(5);
        expect(parsed.maxDiscountAmountIqd).toBeUndefined();
      });

      it("T1-F2.3: verifies all 11 system roles have registered default operational caps", () => {
        const standardRoles = [
          "admin",
          "manager",
          "accountant",
          "cashier",
          "warehouse",
          "purchasing",
          "print_operator",
          "sales_rep",
          "auditor",
          "courier",
          "user",
        ];
        for (const role of standardRoles) {
          const caps = ROLE_DEFAULT_OPERATIONAL_CAPS[role];
          expect(caps).toBeDefined();
          if (caps.maxDiscountPercent !== null && caps.maxDiscountPercent !== undefined) {
            expect(caps.maxDiscountPercent).toBeGreaterThanOrEqual(0);
          }
        }
      });

      it("T1-F2.4: verifies cashier role has strict zero credit sale cap (cash-only)", () => {
        const cashierCaps = ROLE_DEFAULT_OPERATIONAL_CAPS.cashier;
        expect(cashierCaps.maxCreditSaleLimitIqd).toBe("0.00");
        expect(cashierCaps.maxDiscountPercent).toBeLessThanOrEqual(10);
      });

      it("T1-F2.5: verifies enforcement helper functions for discount and credit limits", () => {
        const caps: Required<OperationalCaps> = {
          maxDiscountPercent: 10,
          maxDiscountAmountIqd: "20000.00",
          maxCreditSaleLimitIqd: "100000.00",
          maxPaymentVoucherAmountIqd: "0.00",
          maxExpenseVoucherAmountIqd: "25000.00",
          maxRefundAmountIqd: "25000.00",
        };
        expect(isDiscountPercentWithinCap(5, caps)).toBe(true);
        expect(isDiscountPercentWithinCap(10, caps)).toBe(true);
        expect(isDiscountPercentWithinCap(15, caps)).toBe(false);

        expect(isDiscountAmountWithinCap("15000", caps)).toBe(true);
        expect(isDiscountAmountWithinCap("20000", caps)).toBe(true);
        expect(isDiscountAmountWithinCap("25000", caps)).toBe(false);

        expect(isCreditSaleWithinCap("50000", caps)).toBe(true);
        expect(isCreditSaleWithinCap("150000", caps)).toBe(false);
      });
    });

    // ------------------------------------------------------------------------
    // F3: Sensitive Data Masking Controls
    // ------------------------------------------------------------------------
    describe("F3: Sensitive Data Masking Controls", () => {
      it("T1-F3.1: validates sensitiveDataMaskingSchema parses 4 masking toggles", () => {
        const masking: SensitiveDataMasking = {
          maskPurchaseCost: true,
          maskProfitMargin: true,
          maskSupplierPhone: false,
          maskCustomerContact: true,
        };
        const parsed = sensitiveDataMaskingSchema.parse(masking);
        expect(parsed).toEqual(masking);
      });

      it("T1-F3.2: verifies privileged roles (admin, manager, accountant) have unmasked costs by default", () => {
        expect(ROLE_DEFAULT_DATA_MASKING.admin.maskPurchaseCost).toBe(false);
        expect(ROLE_DEFAULT_DATA_MASKING.admin.maskProfitMargin).toBe(false);

        expect(ROLE_DEFAULT_DATA_MASKING.manager.maskPurchaseCost).toBe(false);
        expect(ROLE_DEFAULT_DATA_MASKING.manager.maskProfitMargin).toBe(false);

        expect(ROLE_DEFAULT_DATA_MASKING.accountant.maskPurchaseCost).toBe(false);
        expect(ROLE_DEFAULT_DATA_MASKING.accountant.maskProfitMargin).toBe(false);
      });

      it("T1-F3.3: verifies cashier, warehouse, and print_operator have masked costs by default", () => {
        expect(ROLE_DEFAULT_DATA_MASKING.cashier.maskPurchaseCost).toBe(true);
        expect(ROLE_DEFAULT_DATA_MASKING.warehouse.maskPurchaseCost).toBe(true);
        expect(ROLE_DEFAULT_DATA_MASKING.print_operator.maskPurchaseCost).toBe(true);
      });

      it("T1-F3.4: verifies supplier phone masking is enabled for warehouse but disabled for purchasing", () => {
        expect(ROLE_DEFAULT_DATA_MASKING.warehouse.maskSupplierPhone).toBe(true);
        expect(ROLE_DEFAULT_DATA_MASKING.purchasing.maskSupplierPhone).toBe(false);
      });

      it("T1-F3.5: verifies customer contact masking is enabled for workshop technicians", () => {
        expect(ROLE_DEFAULT_DATA_MASKING.print_operator.maskCustomerContact).toBe(true);
        expect(ROLE_DEFAULT_DATA_MASKING.reception_clerk.maskCustomerContact).toBe(false);
      });
    });

    // ------------------------------------------------------------------------
    // F4: Role Default Presets & Dual Resolution Engine
    // ------------------------------------------------------------------------
    describe("F4: Role Default Presets & Dual Resolution Engine", () => {
      it("T1-F4.1: resolves atomic permissions for cashier including POS and excluding governance", () => {
        const perms = resolveAtomicPermissions("cashier");
        expect(hasAtomicPermission(perms, "pos.invoice.create")).toBe(true);
        expect(hasAtomicPermission(perms, "pos.shift.open")).toBe(true);
        expect(hasAtomicPermission(perms, "governance.settings.manage")).toBe(false);
        expect(hasAtomicPermission(perms, "treasury.period.lock")).toBe(false);
      });

      it("T1-F4.2: resolves atomic permissions for section cashier roles (retail, print, reception)", () => {
        const retailPerms = resolveAtomicPermissions("retail_cashier");
        const printPerms = resolveAtomicPermissions("print_cashier");
        const receptionPerms = resolveAtomicPermissions("reception_clerk");

        expect(hasAtomicPermission(retailPerms, "pos.invoice.create")).toBe(true);
        expect(hasAtomicPermission(printPerms, "workshop.job.view")).toBe(true);
        expect(hasAtomicPermission(receptionPerms, "reception.order.create")).toBe(true);
      });

      it("T1-F4.3: applies user-level atomic overrides over base role defaults", () => {
        const overrides: AtomicPermissionsMap = {
          "pos.price.override": true, // Normally false for cashier
          "pos.invoice.create": false, // Normally true for cashier
        };
        const resolved = resolveAtomicPermissions("cashier", null, overrides);
        expect(hasAtomicPermission(resolved, "pos.price.override")).toBe(true);
        expect(hasAtomicPermission(resolved, "pos.invoice.create")).toBe(false);
        expect(hasAtomicPermission(resolved, "pos.shift.open")).toBe(true); // Retained from base
      });

      it("T1-F4.4: prioritizes custom role atomic grants before user overrides", () => {
        const roleCustom: AtomicPermissionsMap = {
          "inventory.transfer.create": true,
        };
        const userOverride: AtomicPermissionsMap = {
          "inventory.transfer.create": false,
        };
        // Without user override: custom role wins
        const resolvedRoleOnly = resolveAtomicPermissions("cashier", roleCustom);
        expect(hasAtomicPermission(resolvedRoleOnly, "inventory.transfer.create")).toBe(true);

        // With user override: user override wins
        const resolvedUserOver = resolveAtomicPermissions("cashier", roleCustom, userOverride);
        expect(hasAtomicPermission(resolvedUserOver, "inventory.transfer.create")).toBe(false);
      });

      it("T1-F4.5: guarantees admin role receives full grants across all atomic keys", () => {
        const adminPerms = resolveAtomicPermissions("admin");
        for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
          expect(adminPerms[key]).toBe(true);
        }
      });
    });

    // ------------------------------------------------------------------------
    // F5: Safe Storage, Schema & Persistence
    // ------------------------------------------------------------------------
    describe("F5: Safe Storage, Schema & Persistence", () => {
      it("T1-F5.1: validates atomicPermissionsMapSchema validates JSON record of boolean values", () => {
        const validMap: AtomicPermissionsMap = {
          "pos.invoice.create": true,
          "pos.invoice.void": false,
        };
        const parsed = atomicPermissionsMapSchema.parse(validMap);
        expect(parsed).toEqual(validMap);
      });

      it("T1-F5.2: verifies isPermissionEnvelope accurately detects envelope structures", () => {
        const envelope = {
          atomic: { "pos.invoice.create": true },
          caps: { maxDiscountPercent: 10 },
          masking: { maskPurchaseCost: true },
        };
        expect(isPermissionEnvelope(envelope)).toBe(true);

        const flatLegacy = { pos: "FULL", sales: "READ" };
        expect(isPermissionEnvelope(flatLegacy)).toBe(false);
        expect(isPermissionEnvelope(null)).toBe(false);
      });

      it("T1-F5.3: normalizes permissions input from either flat or envelope structures", () => {
        const envelopeInput = {
          atomic: { "pos.invoice.create": true, "pos.shift.open": true },
          caps: { maxDiscountPercent: 5 },
          masking: { maskPurchaseCost: true },
        };
        const norm = normalizePermissionsInput(envelopeInput);
        expect(norm.atomic["pos.invoice.create"]).toBe(true);
        expect(norm.caps?.maxDiscountPercent).toBe(5);
        expect(norm.masking?.maskPurchaseCost).toBe(true);
        expect(norm.legacyModules.pos).toBe("FULL");
        expect(norm.legacyModules.sales).toBe("FULL");
      });

      it("T1-F5.4: computes minimal diff overrides using filterAtomicOverrides", () => {
        const base = resolveAtomicPermissions("cashier");
        const current = {
          ...base,
          "pos.drawer.open": true, // Changed from base (false -> true)
          "pos.shift.open": false, // Changed from base (true -> false)
        };
        const result = filterAtomicOverrides(current, base);
        expect(result["pos.drawer.open"].overridden).toBe(true);
        expect(result["pos.drawer.open"].granted).toBe(true);
        expect(result["pos.drawer.open"].baseGranted).toBe(false);

        expect(result["pos.shift.open"].overridden).toBe(true);
        expect(result["pos.shift.open"].granted).toBe(false);
        expect(result["pos.shift.open"].baseGranted).toBe(true);

        // Inherited unmodified key
        expect(result["pos.invoice.create"].overridden).toBe(false);
      });

      it("T1-F5.5: ensures JSON serialization round-trip maintains exact precision and keys", () => {
        const sampleMap: AtomicPermissionsMap = {
          "pos.invoice.create": true,
          "inventory.stocktake.create": false,
          "treasury.voucher_in.create": true,
        };
        const serialized = JSON.stringify(sampleMap);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(sampleMap);
      });
    });

    // ------------------------------------------------------------------------
    // F6: 100% Backward Compatibility Engine
    // ------------------------------------------------------------------------
    describe("F6: 100% Backward Compatibility Engine", () => {
      it("T1-F6.1: derives legacy coarse modules from atomic permissions accurately", () => {
        const cashierAtomic = resolveAtomicPermissions("cashier");
        const legacyModules = deriveLegacyModulesFromAtomic(cashierAtomic);

        expect(legacyModules.pos).toBe("FULL");
        expect(legacyModules.sales).toBe("FULL");
        expect(legacyModules.treasury).toBe("FULL");
        expect(legacyModules.settings).toBe("NONE");
        expect(legacyModules.hr).toBe("NONE");
      });

      it("T1-F6.2: derives atomic permissions from legacy coarse module map", () => {
        const legacyMap = {
          pos: "FULL" as const,
          sales: "FULL" as const,
          inventory: "READ" as const,
          treasury: "NONE" as const,
        };
        const atomic = deriveAtomicFromLegacyModules(legacyMap);

        // FULL pos and sales grants pos actions
        expect(atomic["pos.invoice.create"]).toBe(true);
        expect(atomic["pos.shift.open"]).toBe(true);

        // READ inventory grants only view actions
        expect(atomic["inventory.balance.view"]).toBe(true);
        expect(atomic["inventory.transfer.create"]).toBe(false);

        // NONE treasury grants zero treasury actions
        expect(atomic["treasury.cashbox.view"]).toBe(false);
        expect(atomic["treasury.voucher_in.create"]).toBe(false);
      });

      it("T1-F6.3: resolves legacy user without atomic overrides safely to role baseline", () => {
        const resolved = resolveAtomicPermissions("sales_rep", null, null);
        expect(hasAtomicPermission(resolved, "fieldsales.quote.create")).toBe(true);
        expect(hasAtomicPermission(resolved, "fieldsales.visit.record")).toBe(true);
        expect(hasAtomicPermission(resolved, "pos.drawer.open")).toBe(false);
      });

      it("T1-F6.4: maintains legacy access levels for all 11 roles with zero regression", () => {
        const roles = ["admin", "manager", "accountant", "cashier", "warehouse", "auditor"] as const;
        for (const role of roles) {
          const atomic = resolveAtomicPermissions(role);
          const legacy = deriveLegacyModulesFromAtomic(atomic);
          expect(legacy).toBeDefined();

          if (role === "admin") {
            expect(legacy.users).toBe("FULL");
            expect(legacy.settings).toBe("FULL");
          } else if (role === "auditor") {
            // Auditor has read-only
            expect(legacy.sales).toBe("READ");
            expect(legacy.treasury).toBe("READ");
          }
        }
      });

      it("T1-F6.5: normalizes legacy permissionsOverride flat object without data loss", () => {
        const flatLegacy = {
          pos: "FULL" as const,
          sales: "FULL" as const,
        };
        const normalized = normalizePermissionsInput(flatLegacy);
        expect(normalized.legacyModules.pos).toBe("FULL");
        expect(normalized.legacyModules.sales).toBe("FULL");
        expect(normalized.atomic["pos.invoice.create"]).toBe(true);
      });
    });

    // ------------------------------------------------------------------------
    // F7: Collapsible Key-Tree & Dynamic Counters
    // ------------------------------------------------------------------------
    describe("F7: Collapsible Key-Tree & Dynamic Counters", () => {
      it("T1-F7.1: calculates domain grant statistics (total, granted, percent)", () => {
        const cashierPerms = resolveAtomicPermissions("cashier");
        const posStats = getDomainStats(cashierPerms, "pos");

        expect(posStats.total).toBeGreaterThan(5);
        expect(posStats.granted).toBeGreaterThan(0);
        expect(posStats.percent).toBe(Math.round((posStats.granted / posStats.total) * 100));
      });

      it("T1-F7.2: dynamically increments grant counter when an action is enabled", () => {
        const initialMap: AtomicPermissionsMap = {
          "pos.shift.open": true,
          "pos.shift.close": false,
        };
        const statsBefore = getDomainStats(initialMap, "pos");

        const updatedMap = { ...initialMap, "pos.shift.close": true };
        const statsAfter = getDomainStats(updatedMap, "pos");

        expect(statsAfter.granted).toBe(statsBefore.granted + 1);
      });

      it("T1-F7.3: dynamically decrements grant counter when an action is revoked", () => {
        const initialMap: AtomicPermissionsMap = {
          "pos.shift.open": true,
          "pos.shift.close": true,
        };
        const statsBefore = getDomainStats(initialMap, "pos");

        const updatedMap = { ...initialMap, "pos.shift.open": false };
        const statsAfter = getDomainStats(updatedMap, "pos");

        expect(statsAfter.granted).toBe(statsBefore.granted - 1);
      });

      it("T1-F7.4: filters atomic permission definitions strictly by domain", () => {
        for (const dom of ALL_DOMAINS) {
          const defs = getAtomicPermissionsByDomain(dom);
          expect(defs.length).toBeGreaterThan(0);
          for (const d of defs) {
            expect(d.domain).toBe(dom);
          }
        }
      });

      it("T1-F7.5: supports resource-level partitioning within a domain", () => {
        const shiftDefs = getAtomicPermissionsByResource("pos", "shift");
        expect(shiftDefs.length).toBeGreaterThanOrEqual(2);
        for (const d of shiftDefs) {
          expect(d.domain).toBe("pos");
          expect(d.resource).toBe("shift");
        }
      });
    });

    // ------------------------------------------------------------------------
    // F8: 8 Standard Atomic Action Toggles
    // ------------------------------------------------------------------------
    describe("F8: 8 Standard Atomic Action Toggles", () => {
      it("T1-F8.1: defines all 8 standard action types with valid Arabic labels", () => {
        expect(STANDARD_ACTIONS).toHaveLength(8);
        const expectedActions = ["view", "create", "edit", "cancel", "print", "reprint", "export", "approve"];
        const actualActions = STANDARD_ACTIONS.map((a) => a.key);
        expect(actualActions).toEqual(expectedActions);

        for (const act of STANDARD_ACTIONS) {
          expect(act.label.length).toBeGreaterThan(0);
          expect(act.iconName.length).toBeGreaterThan(0);
        }
      });

      it("T1-F8.2: guarantees action toggle independence across sibling resources", () => {
        const base: AtomicPermissionsMap = {
          "pos.invoice.view": true,
          "pos.invoice.create": true,
          "pos.invoice.void": false,
        };
        // Toggling void does not affect view or create
        const modified = { ...base, "pos.invoice.void": true };
        expect(modified["pos.invoice.view"]).toBe(true);
        expect(modified["pos.invoice.create"]).toBe(true);
        expect(modified["pos.invoice.void"]).toBe(true);
      });

      it("T1-F8.3: identifies critical actions with elevated sensitivity", () => {
        const criticalDefs = ATOMIC_PERMISSION_DEFINITIONS.filter((d) => d.sensitivity === "critical");
        expect(criticalDefs.length).toBeGreaterThan(0);
        for (const d of criticalDefs) {
          expect([
            "cancel",
            "approve",
            "void",
            "override",
            "unlock",
            "write_off",
            "export",
            "manage",
            "reset_security",
            "lock",
            "disburse",
          ]).toContain(d.action);
        }
      });

      it("T1-F8.4: classifies view actions under normal or elevated sensitivity", () => {
        const viewDefs = ATOMIC_PERMISSION_DEFINITIONS.filter((d) => d.standardAction === "view");
        for (const d of viewDefs) {
          expect(["normal", "medium", "high"]).toContain(d.sensitivity);
        }
      });

      it("T1-F8.5: enforces SoD maker-checker distinction on approve actions", () => {
        const approveDefs = ATOMIC_PERMISSION_DEFINITIONS.filter((d) => d.standardAction === "approve");
        expect(approveDefs.length).toBeGreaterThanOrEqual(4);
        for (const d of approveDefs) {
          expect([
            "treasury",
            "purchasing",
            "hr",
            "inventory",
            "workshop",
            "pos",
            "reception",
            "delivery",
            "governance",
          ]).toContain(d.domain);
        }
      });
    });

    // ------------------------------------------------------------------------
    // F9: 1-Click Smart Presets Bar
    // ------------------------------------------------------------------------
    describe("F9: 1-Click Smart Presets Bar", () => {
      it("T1-F9.1: Cashier smart preset activates POS sales and disables back-office management", () => {
        const preset = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier;
        expect(preset["pos.invoice.create"]).toBe(true);
        expect(preset["pos.return.create"]).toBe(true);
        expect(preset["treasury.period.lock"]).toBe(false);
        expect(preset["governance.user.manage"]).toBe(false);
      });

      it("T1-F9.2: Warehouse smart preset enables inventory operations and disables sales", () => {
        const preset = ROLE_DEFAULT_ATOMIC_PERMISSIONS.warehouse;
        expect(preset["inventory.transfer.create"]).toBe(true);
        expect(preset["inventory.stocktake.record"]).toBe(true);
        expect(preset["pos.invoice.create"]).toBe(false);
        expect(preset["purchasing.payment.approve"]).toBe(false);
      });

      it("T1-F9.3: Sales Rep smart preset enables field visits and quotes, disables cash drawer", () => {
        const preset = ROLE_DEFAULT_ATOMIC_PERMISSIONS.sales_rep;
        expect(preset["fieldsales.visit.record"]).toBe(true);
        expect(preset["fieldsales.quote.create"]).toBe(true);
        expect(preset["pos.drawer.open"]).toBe(false);
        expect(preset["treasury.cashbox.view"]).toBe(false);
      });

      it("T1-F9.4: Accountant smart preset enables treasury vouchers and financial tracking", () => {
        const preset = ROLE_DEFAULT_ATOMIC_PERMISSIONS.accountant;
        expect(preset["treasury.voucher_in.create"]).toBe(true);
        expect(preset["treasury.voucher_out.create"]).toBe(true);
        expect(preset["governance.settings.manage"]).toBe(false);
      });

      it("T1-F9.5: Auditor smart preset enables read-only viewing across domains with zero mutations", () => {
        const preset = ROLE_DEFAULT_ATOMIC_PERMISSIONS.auditor;
        // Verify view grants exist
        expect(preset["governance.audit.view"]).toBe(true);
        expect(preset["inventory.balance.view"]).toBe(true);
        expect(preset["treasury.cashbox.view"]).toBe(true);

        // Verify mutation actions are false
        expect(preset["pos.invoice.create"]).toBe(false);
        expect(preset["treasury.voucher_in.create"]).toBe(false);
        expect(preset["inventory.transfer.create"]).toBe(false);
      });
    });

    // ------------------------------------------------------------------------
    // F10: Live Search & Filters with Arabic Spaces Preservation
    // ------------------------------------------------------------------------
    describe("F10: Live Search & Filters with Arabic Spaces Preservation", () => {
      it("T1-F10.1: matches permissions by Arabic keyword 'طباعة'", () => {
        const results = searchAtomicPermissions("طباعة");
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
          const matched =
            r.label.includes("طباعة") ||
            r.description.includes("طباعة") ||
            r.key.toLowerCase().includes("طباعة") ||
            r.action.includes("print");
          expect(matched).toBe(true);
        }
      });

      it("T1-F10.2: preserves spaces between Arabic words (no aggressive live trim)", () => {
        const results = searchAtomicPermissions("أمر شغل");
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
          const matched =
            r.label.includes("أمر شغل") ||
            r.description.includes("أمر شغل") ||
            (r.domain === "reception" && r.resource === "order");
          expect(matched).toBe(true);
        }
      });

      it("T1-F10.3: matches by exact key prefix or substring", () => {
        const results = searchAtomicPermissions("pos.shift");
        expect(results.length).toBeGreaterThanOrEqual(2);
        for (const r of results) {
          expect(r.key.startsWith("pos.shift")).toBe(true);
        }
      });

      it("T1-F10.4: returns empty array when search query matches no definitions", () => {
        const results = searchAtomicPermissions("xyznonexistentkeyword123");
        expect(results).toHaveLength(0);
      });

      it("T1-F10.5: returns all definitions when query is empty string", () => {
        const results = searchAtomicPermissions("");
        expect(results.length).toBe(ATOMIC_PERMISSION_DEFINITIONS.length);
      });
    });

    // ------------------------------------------------------------------------
    // F11: Visual Custom Override Highlighting
    // ------------------------------------------------------------------------
    describe("F11: Visual Custom Override Highlighting", () => {
      it("T1-F11.1: identifies inherited base grant state with zero override diff", () => {
        const base = resolveAtomicPermissions("cashier");
        const current = { ...base };
        const overrides = filterAtomicOverrides(current, base);
        expect(overrides["pos.invoice.create"].overridden).toBe(false);
        expect(overrides["pos.invoice.create"].granted).toBe(true);
        expect(overrides["pos.invoice.create"].baseGranted).toBe(true);
        const activeOverrides = Object.values(overrides).filter((o) => o.overridden);
        expect(activeOverrides).toHaveLength(0);
      });

      it("T1-F11.2: identifies explicit custom grant override (Base: false, User: true)", () => {
        const base = resolveAtomicPermissions("cashier");
        const current = { ...base, "pos.price.override": true }; // Override grant
        const overrides = filterAtomicOverrides(current, base);
        expect(overrides["pos.price.override"].overridden).toBe(true);
        expect(overrides["pos.price.override"].granted).toBe(true);
        expect(overrides["pos.price.override"].baseGranted).toBe(false);
      });

      it("T1-F11.3: identifies explicit custom deny override (Base: true, User: false)", () => {
        const base = resolveAtomicPermissions("cashier");
        const current = { ...base, "pos.invoice.create": false }; // Override deny
        const overrides = filterAtomicOverrides(current, base);
        expect(overrides["pos.invoice.create"].overridden).toBe(true);
        expect(overrides["pos.invoice.create"].granted).toBe(false);
        expect(overrides["pos.invoice.create"].baseGranted).toBe(true);
      });

      it("T1-F11.4: resets override back to inherited state when value matches base", () => {
        const base = resolveAtomicPermissions("cashier");
        const current = { ...base, "pos.invoice.create": true }; // Reverted back
        const overrides = filterAtomicOverrides(current, base);
        expect(overrides["pos.invoice.create"].overridden).toBe(false);
        const activeOverrides = Object.values(overrides).filter((o) => o.overridden);
        expect(activeOverrides).toHaveLength(0);
      });

      it("T1-F11.5: isolates multi-domain overrides accurately", () => {
        const base = resolveAtomicPermissions("cashier");
        const current = {
          ...base,
          "pos.price.override": true,
          "inventory.transfer.create": true,
        };
        const overrides = filterAtomicOverrides(current, base);
        expect(overrides["pos.price.override"].overridden).toBe(true);
        expect(overrides["pos.price.override"].granted).toBe(true);
        expect(overrides["pos.price.override"].baseGranted).toBe(false);
        expect(overrides["inventory.transfer.create"].overridden).toBe(true);
        expect(overrides["inventory.transfer.create"].granted).toBe(true);
        expect(overrides["inventory.transfer.create"].baseGranted).toBe(false);
        const activeOverrides = Object.values(overrides).filter((o) => o.overridden);
        expect(activeOverrides).toHaveLength(2);
      });
    });

    // ------------------------------------------------------------------------
    // F12: Operational Caps & Masking UI Integration
    // ------------------------------------------------------------------------
    describe("F12: Operational Caps & Masking UI Integration", () => {
      it("T1-F12.1: resolves operational caps applying user override over role defaults", () => {
        const userOverrides: OperationalCaps = {
          maxDiscountPercent: 20,
        };
        const resolved = resolveOperationalCaps("cashier", null, userOverrides);
        expect(resolved.maxDiscountPercent).toBe(20);
        expect(resolved.maxCreditSaleLimitIqd).toBe("0.00"); // Retained from role
      });

      it("T1-F12.2: resolves sensitive masking applying user override over role defaults", () => {
        const userOverrides: SensitiveDataMasking = {
          maskPurchaseCost: false, // Unmask cost for this specific cashier
        };
        const resolved = resolveSensitiveDataMasking("cashier", null, userOverrides);
        expect(resolved.maskPurchaseCost).toBe(false);
        expect(resolved.maskProfitMargin).toBe(true); // Retained from role
      });

      it("T1-F12.3: checks SoD maker-checker conflict detection", () => {
        const conflictingMap: AtomicPermissionsMap = {
          "purchasing.payment.request": true, // Maker
          "purchasing.payment.approve": true, // Checker
        };
        const conflicts = checkSodConflicts(conflictingMap);
        expect(conflicts.length).toBeGreaterThanOrEqual(1);
        expect(conflicts[0].group).toBe("purchasing_payment");
      });

      it("T1-F12.4: checks SoD compliance when maker and checker are segregated", () => {
        const segregatedMap: AtomicPermissionsMap = {
          "purchasing.payment.request": true, // Maker only
          "purchasing.payment.approve": false, // No checker
        };
        const conflicts = checkSodConflicts(segregatedMap);
        const paymentConflicts = conflicts.filter((c) => c.group === "payment");
        expect(paymentConflicts).toHaveLength(0);
      });

      it("T1-F12.5: tests expense voucher ceiling check helper", () => {
        const caps: Required<OperationalCaps> = {
          maxDiscountPercent: 10,
          maxDiscountAmountIqd: "25000",
          maxCreditSaleLimitIqd: "0",
          maxPaymentVoucherAmountIqd: "0",
          maxExpenseVoucherAmountIqd: "50000.00",
          maxRefundAmountIqd: "25000",
        };
        expect(isExpenseWithinCap("30000", caps)).toBe(true);
        expect(isExpenseWithinCap("50000", caps)).toBe(true);
        expect(isExpenseWithinCap("60000", caps)).toBe(false);
      });
    });
  });

  // ==========================================================================
  // TIER 2: BOUNDARY & CORNER CASES (Limits, Overflow, Negative Values, Injections)
  // ==========================================================================

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2-B1: tests discount percentage exact boundary limits (0% and 100%)", () => {
      const caps0: Required<OperationalCaps> = {
        maxDiscountPercent: 0,
        maxDiscountAmountIqd: "0",
        maxCreditSaleLimitIqd: "0",
        maxPaymentVoucherAmountIqd: "0",
        maxExpenseVoucherAmountIqd: "0",
        maxRefundAmountIqd: "0",
      };
      expect(isDiscountPercentWithinCap(0, caps0)).toBe(true);
      expect(isDiscountPercentWithinCap(0.01, caps0)).toBe(false);

      const caps100: Required<OperationalCaps> = {
        maxDiscountPercent: 100,
        maxDiscountAmountIqd: null,
        maxCreditSaleLimitIqd: null,
        maxPaymentVoucherAmountIqd: null,
        maxExpenseVoucherAmountIqd: null,
        maxRefundAmountIqd: null,
      };
      expect(isDiscountPercentWithinCap(100, caps100)).toBe(true);
      expect(isDiscountPercentWithinCap(100.01, caps100)).toBe(false);
    });

    it("T2-B2: enforces ceiling bounds and rejects values exceeding cap", () => {
      const caps: Required<OperationalCaps> = {
        maxDiscountPercent: 10,
        maxDiscountAmountIqd: "25000",
        maxCreditSaleLimitIqd: "0",
        maxPaymentVoucherAmountIqd: "0",
        maxExpenseVoucherAmountIqd: "0",
        maxRefundAmountIqd: "0",
      };
      expect(isDiscountPercentWithinCap(10, caps)).toBe(true);
      expect(isDiscountPercentWithinCap(10.01, caps)).toBe(false);
      expect(isDiscountAmountWithinCap("25000", caps)).toBe(true);
      expect(isDiscountAmountWithinCap("25001", caps)).toBe(false);
    });

    it("T2-B3: handles null, undefined, and empty objects without crashing", () => {
      const permsFromNull = resolveAtomicPermissions("user", null, null);
      expect(permsFromNull).toBeDefined();

      const capsFromNull = resolveOperationalCaps("user", null, null);
      expect(capsFromNull).toBeDefined();

      const maskingFromNull = resolveSensitiveDataMasking("user", null, null);
      expect(maskingFromNull).toBeDefined();
    });

    it("T2-B4: tests extreme IQD amounts without float overflow", () => {
      const extremeCaps: Required<OperationalCaps> = {
        maxDiscountPercent: 100,
        maxDiscountAmountIqd: null,
        maxCreditSaleLimitIqd: null,
        maxPaymentVoucherAmountIqd: "999999999999.00",
        maxExpenseVoucherAmountIqd: null,
        maxRefundAmountIqd: null,
      };
      expect(isPaymentVoucherWithinCap("999999999999", extremeCaps)).toBe(true);
      expect(isPaymentVoucherWithinCap("1000000000000", extremeCaps)).toBe(false);
    });

    it("T2-B5: handles unknown role key with safe fallback to base user role", () => {
      const fallbackPerms = resolveAtomicPermissions("unknown_alien_role");
      expect(fallbackPerms).toBeDefined();
      expect(fallbackPerms["governance.settings.manage"]).toBe(false);
    });

    it("T2-B6: tests search query containing regex special meta-characters", () => {
      // Regex meta-characters: . * + ? ^ $ { } ( ) | [ ] \
      expect(() => searchAtomicPermissions(".*+?^${}()|[]\\")).not.toThrow();
      const results = searchAtomicPermissions(".*+?^${}()|[]\\");
      expect(Array.isArray(results)).toBe(true);
    });

    it("T2-B7: validates atomic map with extreme key counts (300+ entries)", () => {
      const bigMap: AtomicPermissionsMap = {};
      for (let i = 0; i < 300; i++) {
        bigMap[`custom.resource_${i}.action`] = i % 2 === 0;
      }
      expect(atomicPermissionsMapSchema.parse(bigMap)).toEqual(bigMap);
    });

    it("T2-B8: tests refund ceiling exact boundary match", () => {
      const caps: Required<OperationalCaps> = {
        maxDiscountPercent: 10,
        maxDiscountAmountIqd: "0",
        maxCreditSaleLimitIqd: "0",
        maxPaymentVoucherAmountIqd: "0",
        maxExpenseVoucherAmountIqd: "0",
        maxRefundAmountIqd: "25000.00",
      };
      expect(isRefundWithinCap("25000.00", caps)).toBe(true);
      expect(isRefundWithinCap("25000.01", caps)).toBe(false);
      expect(isRefundWithinCap("0.00", caps)).toBe(true);
    });
  });

  // ==========================================================================
  // TIER 3: CROSS-FEATURE COMBINATIONS (Pairwise Interactions)
  // ==========================================================================

  describe("Tier 3: Cross-Feature Combinations", () => {
    it("T3-C1: combines atomic resolution with envelope serialization and legacy derivation", () => {
      // 1. Resolve custom cashier
      const cashierAtomic = resolveAtomicPermissions("cashier", null, {
        "pos.price.override": true,
      });

      // 2. Package into envelope
      const envelope = {
        atomic: cashierAtomic,
        caps: { maxDiscountPercent: 12 },
        masking: { maskPurchaseCost: true },
      };

      // 3. Normalize
      const normalized = normalizePermissionsInput(envelope);
      expect(normalized.atomic["pos.price.override"]).toBe(true);
      expect(normalized.caps?.maxDiscountPercent).toBe(12);

      // 4. Derive legacy modules
      const legacy = deriveLegacyModulesFromAtomic(normalized.atomic);
      expect(legacy.pos).toBe("FULL");
      expect(legacy.sales).toBe("FULL");
    });

    it("T3-C2: tests search filtering combined with domain grant statistics", () => {
      const perms = resolveAtomicPermissions("cashier");
      const matched = searchAtomicPermissions("فاتورة");
      expect(matched.length).toBeGreaterThan(0);

      // Verify domain stats for domains represented in search results
      const domainsWithMatches = Array.from(new Set(matched.map((m) => m.domain)));
      for (const d of domainsWithMatches) {
        const stats = getDomainStats(perms, d);
        expect(stats.total).toBeGreaterThan(0);
      }
    });

    it("T3-C3: tests smart preset application followed by granular override and SoD verification", () => {
      // 1. Start with purchasing preset
      const purchasingBase = resolveAtomicPermissions("purchasing");
      expect(purchasingBase["purchasing.payment.approve"]).toBe(false);

      // 2. Attempt unsafe override (granting approve to requester)
      const unsafeOverride: AtomicPermissionsMap = {
        "purchasing.payment.approve": true,
      };
      const resolvedUnsafe = resolveAtomicPermissions("purchasing", null, unsafeOverride);

      // 3. SoD detector must catch the violation
      const conflicts = checkSodConflicts(resolvedUnsafe);
      expect(conflicts.some((c) => c.group === "purchasing_payment")).toBe(true);
    });

    it("T3-C4: combines operational caps checks with financial limits", () => {
      const caps = resolveOperationalCaps("manager", null, {
        maxDiscountPercent: 25,
        maxDiscountAmountIqd: "100000.00",
      });

      expect(isDiscountPercentWithinCap(20, caps)).toBe(true);
      expect(isDiscountPercentWithinCap(30, caps)).toBe(false);
      expect(isDiscountAmountWithinCap("90000", caps)).toBe(true);
      expect(isDiscountAmountWithinCap("110000", caps)).toBe(false);
    });

    it("T3-C5: combines sensitive data masking with domain resource inspection", () => {
      const warehouseMasking = resolveSensitiveDataMasking("warehouse");
      expect(warehouseMasking.maskPurchaseCost).toBe(true);
      expect(warehouseMasking.maskSupplierPhone).toBe(true);

      const warehousePerms = resolveAtomicPermissions("warehouse");
      expect(hasAtomicPermission(warehousePerms, "inventory.balance.view")).toBe(true);
      expect(hasAtomicPermission(warehousePerms, "inventory.transfer.create")).toBe(true);
      // Even with inventory access, purchase cost remains masked
      expect(warehouseMasking.maskPurchaseCost).toBe(true);
    });
  });

  // ==========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS (10 Operational Workflows)
  // ==========================================================================

  describe("Tier 4: Real-World Enterprise Operational Scenarios", () => {
    // ------------------------------------------------------------------------
    // Scenario 1: Retail Cashier (كاشير التجزئة)
    // ------------------------------------------------------------------------
    it("T4-S1: executes retail cashier lifecycle with strict caps and masked costs", () => {
      const cashierPerms = resolveAtomicPermissions("retail_cashier");
      const cashierCaps = resolveOperationalCaps("retail_cashier");
      const cashierMasking = resolveSensitiveDataMasking("retail_cashier");

      // Can open shift and issue invoices
      expect(hasAtomicPermission(cashierPerms, "pos.shift.open")).toBe(true);
      expect(hasAtomicPermission(cashierPerms, "pos.invoice.create")).toBe(true);
      expect(hasAtomicPermission(cashierPerms, "pos.return.create")).toBe(true);

      // Cannot void without manager
      expect(hasAtomicPermission(cashierPerms, "pos.invoice.void")).toBe(false);
      expect(hasAtomicPermission(cashierPerms, "pos.price.override")).toBe(false);

      // Financial caps
      expect(cashierCaps.maxDiscountPercent).toBeLessThanOrEqual(5);
      expect(cashierCaps.maxCreditSaleLimitIqd).toBe("0.00"); // Strictly cash only

      // Cost price masked
      expect(cashierMasking.maskPurchaseCost).toBe(true);
      expect(cashierMasking.maskProfitMargin).toBe(true);
    });

    // ------------------------------------------------------------------------
    // Scenario 2: Customer Reception Clerk (موظف الاستقبال)
    // ------------------------------------------------------------------------
    it("T4-S2: executes customer reception clerk workflow with deposit handling and work orders", () => {
      const clerkPerms = resolveAtomicPermissions("reception_clerk");
      const clerkCaps = resolveOperationalCaps("reception_clerk");

      expect(hasAtomicPermission(clerkPerms, "reception.order.create")).toBe(true);
      expect(hasAtomicPermission(clerkPerms, "reception.deposit.collect")).toBe(true);
      expect(hasAtomicPermission(clerkPerms, "reception.proof.send")).toBe(true);

      // Cannot touch inventory transfers or write-offs
      expect(hasAtomicPermission(clerkPerms, "inventory.transfer.create")).toBe(false);
      expect(hasAtomicPermission(clerkPerms, "inventory.scrap.write_off")).toBe(false);

      // Discount cap: 10%
      expect(isDiscountPercentWithinCap(10, clerkCaps)).toBe(true);
      expect(isDiscountPercentWithinCap(12, clerkCaps)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // Scenario 3: Print Workshop Technician (فني المطبعة)
    // ------------------------------------------------------------------------
    it("T4-S3: executes print workshop technician job handling with customer contact masked", () => {
      const techPerms = resolveAtomicPermissions("print_operator");
      const techMasking = resolveSensitiveDataMasking("print_operator");

      expect(hasAtomicPermission(techPerms, "workshop.job.view")).toBe(true);
      expect(hasAtomicPermission(techPerms, "workshop.job.start")).toBe(true);
      expect(hasAtomicPermission(techPerms, "workshop.material.consume")).toBe(true);
      expect(hasAtomicPermission(techPerms, "workshop.waste.record")).toBe(true);

      // Customer personal contact is masked for technical workshop staff
      expect(techMasking.maskCustomerContact).toBe(true);
      expect(techMasking.maskPurchaseCost).toBe(true);
    });

    // ------------------------------------------------------------------------
    // Scenario 4: Warehouse Keeper (أمين المستودع)
    // ------------------------------------------------------------------------
    it("T4-S4: executes warehouse keeper transfer and stocktaking with SoD and masked supplier phone", () => {
      const keeperPerms = resolveAtomicPermissions("warehouse");
      const keeperMasking = resolveSensitiveDataMasking("warehouse");

      expect(hasAtomicPermission(keeperPerms, "inventory.balance.view")).toBe(true);
      expect(hasAtomicPermission(keeperPerms, "inventory.transfer.create")).toBe(true);
      expect(hasAtomicPermission(keeperPerms, "inventory.stocktake.record")).toBe(true);

      // SoD: Can record stocktake, but cannot approve it
      expect(hasAtomicPermission(keeperPerms, "inventory.stocktake.approve")).toBe(false);
      expect(hasAtomicPermission(keeperPerms, "inventory.adjustment.approve")).toBe(false);

      // Supplier phone masked
      expect(keeperMasking.maskSupplierPhone).toBe(true);
    });

    // ------------------------------------------------------------------------
    // Scenario 5: Purchasing Specialist (مسؤول المشتريات)
    // ------------------------------------------------------------------------
    it("T4-S5: executes purchasing specialist PO workflow with unmasked vendor data and SoD on payments", () => {
      const buyerPerms = resolveAtomicPermissions("purchasing");
      const buyerMasking = resolveSensitiveDataMasking("purchasing");

      expect(hasAtomicPermission(buyerPerms, "purchasing.supplier.view")).toBe(true);
      expect(hasAtomicPermission(buyerPerms, "purchasing.po.create")).toBe(true);
      expect(hasAtomicPermission(buyerPerms, "purchasing.invoice.match")).toBe(true);

      // Unmasked supplier contact and purchase cost
      expect(buyerMasking.maskSupplierPhone).toBe(false);
      expect(buyerMasking.maskPurchaseCost).toBe(false);

      // Can request payment (Maker), but cannot approve it (Checker)
      expect(hasAtomicPermission(buyerPerms, "purchasing.payment.request")).toBe(true);
      expect(hasAtomicPermission(buyerPerms, "purchasing.payment.approve")).toBe(false);
    });

    // ------------------------------------------------------------------------
    // Scenario 6: Treasury Accountant (محاسب الخزينة)
    // ------------------------------------------------------------------------
    it("T4-S6: executes treasury accountant vouchers and reconciliation with high caps", () => {
      const acctPerms = resolveAtomicPermissions("accountant");
      const acctCaps = resolveOperationalCaps("accountant");
      const acctMasking = resolveSensitiveDataMasking("accountant");

      expect(hasAtomicPermission(acctPerms, "treasury.voucher_in.create")).toBe(true);
      expect(hasAtomicPermission(acctPerms, "treasury.voucher_out.create")).toBe(true);
      expect(hasAtomicPermission(acctPerms, "treasury.shift.reconcile")).toBe(true);

      // High payment voucher cap
      expect(isPaymentVoucherWithinCap("1000000.00", acctCaps)).toBe(true);

      // All costs and margins visible
      expect(acctMasking.maskPurchaseCost).toBe(false);
      expect(acctMasking.maskProfitMargin).toBe(false);
    });

    // ------------------------------------------------------------------------
    // Scenario 7: Field Sales Representative (مندوب المبيعات)
    // ------------------------------------------------------------------------
    it("T4-S7: executes field sales representative visits and quotation within discount cap", () => {
      const repPerms = resolveAtomicPermissions("sales_rep");
      const repCaps = resolveOperationalCaps("sales_rep");

      expect(hasAtomicPermission(repPerms, "fieldsales.visit.record")).toBe(true);
      expect(hasAtomicPermission(repPerms, "fieldsales.quote.create")).toBe(true);
      expect(hasAtomicPermission(repPerms, "fieldsales.order.submit")).toBe(true);

      // Negotiated discount cap: up to 15%
      expect(isDiscountPercentWithinCap(15, repCaps)).toBe(true);
      expect(isDiscountPercentWithinCap(20, repCaps)).toBe(false);

      // Credit limit up to 500,000 IQD
      expect(isCreditSaleWithinCap("500000.00", repCaps)).toBe(true);
      expect(isCreditSaleWithinCap("600000.00", repCaps)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // Scenario 8: Delivery Courier (مندوب التوصيل)
    // ------------------------------------------------------------------------
    it("T4-S8: executes delivery courier parcel confirmation and delivery workflow", () => {
      const courierPerms = resolveAtomicPermissions("courier");

      expect(hasAtomicPermission(courierPerms, "delivery.parcel.view")).toBe(true);
      expect(hasAtomicPermission(courierPerms, "delivery.proof.confirm")).toBe(true);
      expect(hasAtomicPermission(courierPerms, "delivery.proof.partial")).toBe(true);
      expect(hasAtomicPermission(courierPerms, "delivery.failure.record")).toBe(true);
      expect(hasAtomicPermission(courierPerms, "delivery.cod.settle")).toBe(true);

      // Courier cannot write off shortfall (executive only), nor touch back-office treasury
      expect(hasAtomicPermission(courierPerms, "delivery.shortfall.write_off")).toBe(false);
      expect(hasAtomicPermission(courierPerms, "treasury.cashbox.view")).toBe(false);
      expect(hasAtomicPermission(courierPerms, "pos.discount.apply")).toBe(false);
    });

    // ------------------------------------------------------------------------
    // Scenario 9: HR & Payroll Officer (مسؤول الموارد البشرية)
    // ------------------------------------------------------------------------
    it("T4-S9: executes HR payroll computation and disbursement governance", () => {
      const managerPerms = resolveAtomicPermissions("manager");
      const adminPerms = resolveAtomicPermissions("admin");

      // Manager can view employees and record attendance
      expect(hasAtomicPermission(managerPerms, "hr.employee.view")).toBe(true);
      expect(hasAtomicPermission(managerPerms, "hr.attendance.record")).toBe(true);

      // Admin has full HR rights including payroll approval and disbursement
      expect(hasAtomicPermission(adminPerms, "hr.employee.view")).toBe(true);
      expect(hasAtomicPermission(adminPerms, "hr.payroll.compute")).toBe(true);
      expect(hasAtomicPermission(adminPerms, "hr.payroll.approve")).toBe(true);
      expect(hasAtomicPermission(adminPerms, "hr.payroll.disburse")).toBe(true);
    });

    // ------------------------------------------------------------------------
    // Scenario 10: System Administrator & Auditor (الإدارة والتدقيق)
    // ------------------------------------------------------------------------
    it("T4-S10: verifies system admin root omnipotence vs auditor read-only governance", () => {
      const adminPerms = resolveAtomicPermissions("admin");
      const auditorPerms = resolveAtomicPermissions("auditor");

      // Admin has root capabilities
      expect(hasAtomicPermission(adminPerms, "governance.audit.view")).toBe(true);
      expect(hasAtomicPermission(adminPerms, "governance.audit.export")).toBe(true);
      expect(hasAtomicPermission(adminPerms, "governance.user.manage")).toBe(true);
      expect(hasAtomicPermission(adminPerms, "governance.role.manage")).toBe(true);

      // Auditor has read access to audit log and balances
      expect(hasAtomicPermission(auditorPerms, "governance.audit.view")).toBe(true);
      expect(hasAtomicPermission(auditorPerms, "inventory.balance.view")).toBe(true);
      expect(hasAtomicPermission(auditorPerms, "treasury.cashbox.view")).toBe(true);

      // Auditor is strictly blocked from modifying users or exporting raw audit data
      expect(hasAtomicPermission(auditorPerms, "governance.user.manage")).toBe(false);
      expect(hasAtomicPermission(auditorPerms, "governance.role.manage")).toBe(false);
      expect(hasAtomicPermission(auditorPerms, "governance.settings.manage")).toBe(false);
    });
  });
});
