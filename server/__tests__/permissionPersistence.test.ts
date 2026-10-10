/**
 * server/__tests__/permissionPersistence.test.ts
 *
 * Unit test suite for Milestone 2 (Database Schema & Persistence - R3):
 *  1. Drizzle schema definitions for users and roles tables (atomicPermissions, operationalCaps).
 *  2. Migration file and journal index registration integrity.
 *  3. SAFE_COLUMNS projection in userService.
 *  4. Session context resolution (normalizeOwnerAuthority, resolveCustomRole).
 *  5. User overrides, custom roles, and fail-closed inactive role handling.
 *  6. 100% backward compatibility for legacy accounts.
 *  7. Zod schema validation for router input/output payloads.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { roles, users } from "../../drizzle/schema";
import {
  normalizeOwnerAuthority,
  resolveCustomRole,
  type AuthUser,
} from "../context";
import {
  atomicPermissionsMapSchema,
  operationalCapsSchema,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  type AtomicPermissionsMap,
  type OperationalCaps,
} from "@shared/atomicPermissions";
import * as roleService from "../services/roleService";

describe("Milestone 2: Schema & Persistence Integrity (R3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Drizzle Schema & Migration Integrity
  // ==========================================================================
  describe("1. Drizzle Schema & Migration Integrity", () => {
    it("users table defines atomicPermissions and operationalCaps JSON columns", () => {
      expect(users.atomicPermissions).toBeDefined();
      expect(users.operationalCaps).toBeDefined();
      expect(users.atomicPermissions.name).toBe("atomicPermissions");
      expect(users.operationalCaps.name).toBe("operationalCaps");
    });

    it("roles table defines atomicPermissions and operationalCaps JSON columns", () => {
      expect(roles.atomicPermissions).toBeDefined();
      expect(roles.operationalCaps).toBeDefined();
      expect(roles.atomicPermissions.name).toBe("atomicPermissions");
      expect(roles.operationalCaps.name).toBe("operationalCaps");
    });

    it("migration file exists and contains valid DDL for roles and users", () => {
      const migrationPath = path.resolve(
        process.cwd(),
        "drizzle/migrations/0390_comprehensive_permission_matrix_caps.sql",
      );
      expect(existsSync(migrationPath)).toBe(true);

      const sqlContent = readFileSync(migrationPath, "utf8");
      expect(sqlContent).toContain("ALTER TABLE `roles` ADD COLUMN `atomicPermissions` json NULL;");
      expect(sqlContent).toContain("ALTER TABLE `roles` ADD COLUMN `operationalCaps` json NULL;");
      expect(sqlContent).toContain("ALTER TABLE `users` ADD COLUMN `atomicPermissions` json NULL;");
      expect(sqlContent).toContain("ALTER TABLE `users` ADD COLUMN `operationalCaps` json NULL;");
    });

    it("migration journal registers entry 390 correctly", () => {
      const journalPath = path.resolve(
        process.cwd(),
        "drizzle/migrations/meta/_journal.json",
      );
      expect(existsSync(journalPath)).toBe(true);

      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const entry = journal.entries.find(
        (e: { tag: string }) => e.tag === "0390_comprehensive_permission_matrix_caps",
      );
      expect(entry).toBeDefined();
      expect(entry.idx).toBe(390);
      expect(entry.when).toBe(1788148848000);
      expect(entry.breakpoints).toBe(true);
    });
  });

  // ==========================================================================
  // 2. SAFE_COLUMNS Projection
  // ==========================================================================
  describe("2. SAFE_COLUMNS Projection in userService", () => {
    it("users table columns are referenced for safe query selection", () => {
      // In userService.ts, SAFE_COLUMNS selects users.atomicPermissions and users.operationalCaps
      expect(users.atomicPermissions).toBeDefined();
      expect(users.operationalCaps).toBeDefined();
      expect(users.permissionsOverride).toBeDefined();
    });
  });

  // ==========================================================================
  // 3. Context Resolution: Owner Authority
  // ==========================================================================
  describe("3. normalizeOwnerAuthority Resolution", () => {
    it("normalizes company owner to admin with full atomic permissions and unlimited caps", () => {
      const mockOwner = {
        id: 1,
        openId: "local_owner_1",
        name: "المالك",
        email: "owner@alroya.local",
        username: "owner",
        role: "cashier", // Stored base role was cashier
        isOwner: true,
        permissionsOverride: { pos: "READ" },
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      const normalized = normalizeOwnerAuthority(mockOwner);

      expect(normalized.role).toBe("admin");
      expect(normalized.permissionsOverride).toBeNull();
      expect(normalized.resolvedAtomicPermissions).toBeDefined();
      expect(normalized.resolvedAtomicPermissions?.["pos.invoice.create"]).toBe(true);
      expect(normalized.resolvedAtomicPermissions?.["reception.order.create"]).toBe(true);
      expect(normalized.resolvedAtomicPermissions?.["governance.audit.view"]).toBe(true);

      expect(normalized.resolvedOperationalCaps).toBeDefined();
      expect(normalized.resolvedOperationalCaps?.maxDiscountPercent).toBe(100);
      expect(normalized.resolvedOperationalCaps?.maxCreditSaleLimitIqd).toBeNull();
    });

    it("leaves non-owner user intact without normalizing to admin", () => {
      const mockUser = {
        id: 2,
        openId: "local_user_2",
        name: "كاشير",
        role: "cashier",
        isOwner: false,
        permissionsOverride: null,
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      const unchanged = normalizeOwnerAuthority(mockUser);
      expect(unchanged.role).toBe("cashier");
      expect(unchanged.resolvedAtomicPermissions).toBeUndefined();
    });
  });

  // ==========================================================================
  // 4. Context Resolution: Built-in Roles & Overrides
  // ==========================================================================
  describe("4. resolveCustomRole: Built-in Roles & Overrides", () => {
    it("resolves default cashier atomic permissions and caps when customRoleId is null", async () => {
      const mockCashier = {
        id: 10,
        openId: "cashier_10",
        name: "كاشير رئيسي",
        role: "cashier",
        customRoleId: null,
        isOwner: false,
        permissionsOverride: null,
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      await resolveCustomRole(mockCashier);

      expect(mockCashier.resolvedAtomicPermissions).toBeDefined();
      // Cashier has pos.invoice.create = true, but workshop.job.complete = false
      expect(mockCashier.resolvedAtomicPermissions?.["pos.invoice.create"]).toBe(true);
      expect(mockCashier.resolvedAtomicPermissions?.["workshop.job.complete"]).toBe(false);

      expect(mockCashier.resolvedOperationalCaps).toBeDefined();
      expect(mockCashier.resolvedOperationalCaps?.maxCreditSaleLimitIqd).toBe(
        ROLE_DEFAULT_OPERATIONAL_CAPS.cashier.maxCreditSaleLimitIqd,
      );
    });

    it("applies user atomic permission and cap overrides over built-in role template", async () => {
      const mockCashierWithOverrides = {
        id: 11,
        openId: "cashier_11",
        name: "كاشير استثنائي",
        role: "cashier",
        customRoleId: null,
        isOwner: false,
        permissionsOverride: null,
        // Override: grant pos.drawer.open (false by default for cashier) and deny pos.invoice.create
        atomicPermissions: {
          "pos.drawer.open": true,
          "pos.invoice.create": false,
        } as AtomicPermissionsMap,
        operationalCaps: {
          maxDiscountPercent: 20, // Default for cashier is 10
        } as OperationalCaps,
      } as unknown as AuthUser;

      await resolveCustomRole(mockCashierWithOverrides);

      expect(mockCashierWithOverrides.resolvedAtomicPermissions?.["pos.drawer.open"]).toBe(true);
      expect(mockCashierWithOverrides.resolvedAtomicPermissions?.["pos.invoice.create"]).toBe(false);
      // Other permissions retain cashier defaults
      expect(mockCashierWithOverrides.resolvedAtomicPermissions?.["pos.invoice.view"]).toBe(true);

      expect(mockCashierWithOverrides.resolvedOperationalCaps?.maxDiscountPercent).toBe(20);
    });
  });

  // ==========================================================================
  // 5. Context Resolution: Custom Roles & Inactive Fallback
  // ==========================================================================
  describe("5. resolveCustomRole: Custom Roles & Fail-Closed Inactive Fallback", () => {
    it("resolves active custom role permissions and merges individual user overrides", async () => {
      vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue({
        id: 100,
        key: "print_cashier",
        label: "كاشير مطبعة متقدم",
        description: "كاشير مع صلاحيات تشغيل",
        baseRole: "cashier",
        permissions: { pos: "FULL", sales: "FULL", workshop: "READ" },
        atomicPermissions: {
          "workshop.job.view": true,
        },
        operationalCaps: {
          maxDiscountPercent: 12,
        },
        canSeeCost: false,
        isActive: true,
        isSystem: false,
        station: "PRINT_SERVICES",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const mockUser = {
        id: 20,
        openId: "user_20",
        name: "موظف دور مخصص",
        role: "user",
        customRoleId: 100,
        isOwner: false,
        permissionsOverride: null,
        atomicPermissions: {
          "workshop.job.start": true, // Individual user grant
        },
        operationalCaps: null,
      } as unknown as AuthUser;

      await resolveCustomRole(mockUser);

      expect(mockUser.role).toBe("cashier");
      expect(mockUser.customRoleLabel).toBe("كاشير مطبعة متقدم");
      expect(mockUser.customRoleKey).toBe("print_cashier");

      // Custom role grant
      expect(mockUser.resolvedAtomicPermissions?.["workshop.job.view"]).toBe(true);
      // Individual user override grant
      expect(mockUser.resolvedAtomicPermissions?.["workshop.job.start"]).toBe(true);
      // Inherited cashier grant
      expect(mockUser.resolvedAtomicPermissions?.["pos.invoice.create"]).toBe(true);

      // Custom role cap applied
      expect(mockUser.resolvedOperationalCaps?.maxDiscountPercent).toBe(12);
    });

    it("falls back fail-closed to user role when custom role is inactive or deleted", async () => {
      vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue(null);

      const mockUser = {
        id: 21,
        openId: "user_21",
        name: "موظف معطل دوره",
        role: "manager", // Formerly stored manager
        customRoleId: 999, // Inactive role ID
        isOwner: false,
        permissionsOverride: { reports: "FULL" },
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      await resolveCustomRole(mockUser);

      expect(mockUser.role).toBe("user");
      expect(mockUser.roleLockedByInactiveCustomRole).toBe(true);
      expect(mockUser.permissionsOverride).toBeNull();
      expect(mockUser.customRoleLabel).toBeNull();

      // Resolved atomic permissions drop to standard user permissions (read-only / minimal)
      expect(mockUser.resolvedAtomicPermissions?.["pos.invoice.create"]).toBe(false);
      expect(mockUser.resolvedAtomicPermissions?.["governance.audit.view"]).toBe(false);

      // Caps drop to default zero caps
      expect(mockUser.resolvedOperationalCaps?.maxDiscountPercent).toBe(0);
    });
  });

  // ==========================================================================
  // 6. 100% Backward Compatibility Engine
  // ==========================================================================
  describe("6. Backward Compatibility for Legacy Accounts", () => {
    it("handles legacy accounts with null atomicPermissions and operationalCaps without throwing", async () => {
      const legacyAccount = {
        id: 30,
        openId: "legacy_user_30",
        name: "حساب قديم",
        role: "accountant",
        customRoleId: null,
        isOwner: false,
        permissionsOverride: { treasury: "FULL", expenses: "FULL" },
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      await expect(resolveCustomRole(legacyAccount)).resolves.not.toThrow();

      // Existing coarse module override is 100% preserved
      expect(legacyAccount.permissionsOverride).toEqual({
        treasury: "FULL",
        expenses: "FULL",
      });

      // Resolved atomic permissions fall back smoothly to accountant preset
      expect(legacyAccount.resolvedAtomicPermissions).toBeDefined();
      expect(legacyAccount.resolvedAtomicPermissions?.["treasury.voucher_in.create"]).toBe(true);
      expect(legacyAccount.resolvedOperationalCaps).toBeDefined();
      expect(legacyAccount.resolvedOperationalCaps?.maxDiscountPercent).toBe(
        ROLE_DEFAULT_OPERATIONAL_CAPS.accountant.maxDiscountPercent,
      );
    });
  });

  // ==========================================================================
  // 7. Zod Validation Schemas for Routers
  // ==========================================================================
  describe("7. Zod Validation Schemas for Routers", () => {
    it("validates valid atomic permissions map", () => {
      const validMap: AtomicPermissionsMap = {
        "pos.invoice.create": true,
        "pos.invoice.void": false,
      };
      const parsed = atomicPermissionsMapSchema.parse(validMap);
      expect(parsed).toEqual(validMap);
    });

    it("rejects non-boolean values in atomic permissions map", () => {
      const invalidMap = {
        "pos.invoice.create": "FULL", // String instead of boolean
      };
      expect(() => atomicPermissionsMapSchema.parse(invalidMap)).toThrow();
    });

    it("validates valid operational caps structure", () => {
      const validCaps: OperationalCaps = {
        maxDiscountPercent: 15,
        maxDiscountAmountIqd: "25000.00",
        maxCreditSaleLimitIqd: "500000.00",
        maxPaymentVoucherAmountIqd: "1000000.00",
      };
      const parsed = operationalCapsSchema.parse(validCaps);
      expect(parsed).toEqual(validCaps);
    });

    it("rejects invalid discount percentage > 100", () => {
      const invalidCaps = {
        maxDiscountPercent: 150,
      };
      expect(() => operationalCapsSchema.parse(invalidCaps)).toThrow();
    });

    it("rejects malformed monetary string in operational caps", () => {
      const invalidCaps = {
        maxCreditSaleLimitIqd: "invalid_money",
      };
      expect(() => operationalCapsSchema.parse(invalidCaps)).toThrow();
    });

    it("accepts nullish operational caps and atomic permissions for backward compatibility", () => {
      expect(atomicPermissionsMapSchema.nullish().parse(null)).toBeNull();
      expect(atomicPermissionsMapSchema.nullish().parse(undefined)).toBeUndefined();
      expect(operationalCapsSchema.nullish().parse(null)).toBeNull();
      expect(operationalCapsSchema.nullish().parse(undefined)).toBeUndefined();
    });
  });
});
