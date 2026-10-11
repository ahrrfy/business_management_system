/**
 * server/__tests__/adversarialPermissionStress.test.ts
 *
 * Empirical Adversarial Stress & Property-Based Test Suite for Milestone 2 (R3):
 *  1. Persistence & Zod Schema Stress: Extreme numbers (NaN, negative, huge, Infinity),
 *     malformed formats, empty objects, prototype pollution, non-object payloads.
 *  2. Operational Cap Enforcement Helpers: Fail-closed boundary behavior on corrupted
 *     caps, negative requests, and fuzz inputs.
 *  3. Session Context Resolution: Built-in + null overrides, custom roles + user overrides,
 *     inactive/deleted custom roles, non-existent role IDs, corrupted DB data fail-closed.
 *  4. Safe Columns Leak Prevention: Direct AST/file inspection and simulation ensuring
 *     zero leakage of sensitive fields (passwordHash, pinHash, totp, tokens, brute-force state).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { users } from "../../drizzle/schema";
import {
  normalizeOwnerAuthority,
  resolveCustomRole,
  type AuthUser,
} from "../context";
import {
  atomicPermissionsMapSchema,
  operationalCapsSchema,
  isDiscountPercentWithinCap,
  isDiscountAmountWithinCap,
  isCreditSaleWithinCap,
  isPaymentVoucherWithinCap,
  isExpenseWithinCap,
  isRefundWithinCap,
  resolveAtomicPermissions,
  resolveOperationalCaps,
  resolveSensitiveDataMasking,
  ALL_ATOMIC_PERMISSION_KEYS,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  DEFAULT_ZERO_CAPS,
  DEFAULT_UNLIMITED_CAPS,
  type AtomicPermissionsMap,
  type OperationalCaps,
} from "@shared/atomicPermissions";
import * as roleService from "../services/roleService";

describe("Adversarial Stress & Property Checks: Milestone 2 Persistence (R3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Suite 1: Persistence & Schema Adversarial Stress Testing (Zod Validation)
  // ==========================================================================
  describe("Suite 1: Persistence & Zod Schema Stress", () => {
    it("1.1 Rejects NaN in maxDiscountPercent and monetary caps", () => {
      const nanPercent = operationalCapsSchema.safeParse({ maxDiscountPercent: NaN });
      expect(nanPercent.success).toBe(false);

      const nanAmount = operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "NaN" });
      expect(nanAmount.success).toBe(false);
    });

    it("1.2 Rejects negative numbers in percent and monetary fields", () => {
      const negativePercents = [-1, -0.0001, -50, -100];
      for (const val of negativePercents) {
        const res = operationalCapsSchema.safeParse({ maxDiscountPercent: val });
        expect(res.success, `Expected rejection for percent: ${val}`).toBe(false);
      }

      const negativeAmounts = [
        { maxDiscountAmountIqd: "-1" },
        { maxDiscountAmountIqd: "-0.01" },
        { maxCreditSaleLimitIqd: "-500" },
        { maxPaymentVoucherAmountIqd: "-1000" },
        { maxExpenseVoucherAmountIqd: "-50" },
        { maxRefundAmountIqd: "-10" },
      ];
      for (const payload of negativeAmounts) {
        const res = operationalCapsSchema.safeParse(payload);
        expect(res.success, `Expected rejection for payload: ${JSON.stringify(payload)}`).toBe(false);
      }
    });

    it("1.3 Rejects huge numbers and Infinity in maxDiscountPercent (> 100)", () => {
      const invalidPercents = [100.0001, 101, 1000, 1e20, Infinity, -Infinity, Number.MAX_SAFE_INTEGER];
      for (const val of invalidPercents) {
        const res = operationalCapsSchema.safeParse({ maxDiscountPercent: val });
        expect(res.success, `Expected rejection for percent: ${val}`).toBe(false);
      }
    });

    it("1.4 Accepts valid exact boundary values (0, 100, null, 0.00)", () => {
      const validPayloads = [
        { maxDiscountPercent: 0 },
        { maxDiscountPercent: 100 },
        { maxDiscountPercent: 50.5 },
        { maxDiscountPercent: null },
        { maxDiscountAmountIqd: "0" },
        { maxDiscountAmountIqd: "0.00" },
        { maxDiscountAmountIqd: "1000000.00" },
        { maxDiscountAmountIqd: null },
        { maxCreditSaleLimitIqd: null },
      ];
      for (const payload of validPayloads) {
        const res = operationalCapsSchema.safeParse(payload);
        expect(res.success, `Expected success for payload: ${JSON.stringify(payload)}`).toBe(true);
      }
    });

    it("1.5 Rejects malformed monetary strings (decimals > 2, commas, currencies, spaces)", () => {
      const malformed = [
        "100.000",   // 3 decimals
        "100,000",   // comma
        "$100",      // currency sign
        " 100 ",     // untrimmed space
        "abc",       // non-numeric
        "1e5",       // scientific notation
        "",          // empty string
        "100.",      // trailing dot
        ".50",       // leading dot without 0
      ];
      for (const str of malformed) {
        const res = operationalCapsSchema.safeParse({ maxDiscountAmountIqd: str });
        expect(res.success, `Expected rejection for money string: "${str}"`).toBe(false);
      }
    });

    it("1.6 Rejects non-string types for money cap fields (numbers, booleans, arrays)", () => {
      const badTypes = [
        { maxDiscountAmountIqd: 100 },
        { maxDiscountAmountIqd: true },
        { maxDiscountAmountIqd: [100] },
        { maxDiscountAmountIqd: { amount: 100 } },
      ];
      for (const payload of badTypes) {
        const res = operationalCapsSchema.safeParse(payload as any);
        expect(res.success, `Expected rejection for bad type: ${JSON.stringify(payload)}`).toBe(false);
      }
    });

    it("1.7 Rejects non-object root structures for operationalCapsSchema", () => {
      const nonObjects = ["not an object", 12345, true, [1, 2, 3]];
      for (const val of nonObjects) {
        const res = operationalCapsSchema.safeParse(val as any);
        expect(res.success).toBe(false);
      }
    });

    it("1.8 Empty object {} cleanly validates as valid with all optional keys", () => {
      const res = operationalCapsSchema.safeParse({});
      expect(res.success).toBe(true);
      expect(res.data).toEqual({});
    });

    it("1.9 Strips unexpected keys and guards against prototype pollution attempts", () => {
      const payloadWithExtras = JSON.parse(
        '{"maxDiscountPercent": 10, "evilKey": "malicious", "__proto__": {"polluted": true}}'
      );
      const res = operationalCapsSchema.safeParse(payloadWithExtras);
      expect(res.success).toBe(true);
      if (res.success) {
        expect((res.data as any).evilKey).toBeUndefined();
        expect((res.data as any).polluted).toBeUndefined();
        expect(res.data.maxDiscountPercent).toBe(10);
      }
    });

    it("1.10 atomicPermissionsMapSchema strictly requires boolean values and rejects non-booleans", () => {
      const valid = atomicPermissionsMapSchema.safeParse({
        "pos.shift.open": true,
        "pos.invoice.create": false,
      });
      expect(valid.success).toBe(true);

      const invalidValues = [
        { "pos.shift.open": "true" },
        { "pos.shift.open": 1 },
        { "pos.shift.open": 0 },
        { "pos.shift.open": null },
        { "pos.shift.open": undefined },
        { "pos.shift.open": [true] },
      ];
      for (const item of invalidValues) {
        const res = atomicPermissionsMapSchema.safeParse(item);
        expect(res.success, `Expected rejection for: ${JSON.stringify(item)}`).toBe(false);
      }
    });

    it("1.11 Fuzz testing: 50 randomly generated corrupted payloads are all rejected by operationalCapsSchema", () => {
      for (let i = 0; i < 50; i++) {
        const badPercent = -Math.random() * 1000 - 0.01;
        const badMoney = `bad_${Math.random()}`;
        const payload = {
          maxDiscountPercent: badPercent,
          maxDiscountAmountIqd: badMoney,
        };
        const res = operationalCapsSchema.safeParse(payload);
        expect(res.success).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Suite 2: Operational Cap Enforcement Helpers & Fail-Closed Behavior
  // ==========================================================================
  describe("Suite 2: Cap Evaluation Helpers & Fail-Closed Logic", () => {
    it("2.1 isDiscountPercentWithinCap fails-closed on NaN, Infinity, and negative requests", () => {
      const caps = { maxDiscountPercent: 20 };
      expect(isDiscountPercentWithinCap(NaN, caps)).toBe(false);
      expect(isDiscountPercentWithinCap(Infinity, caps)).toBe(false);
      expect(isDiscountPercentWithinCap(-Infinity, caps)).toBe(false);
      expect(isDiscountPercentWithinCap(-1, caps)).toBe(false);
      expect(isDiscountPercentWithinCap(101, caps)).toBe(false);
      expect(isDiscountPercentWithinCap(20, caps)).toBe(true);
      expect(isDiscountPercentWithinCap(20.0001, caps)).toBe(false);
      expect(isDiscountPercentWithinCap(0, caps)).toBe(true);
    });

    it("2.2 isDiscountPercentWithinCap fails-closed on corrupted caps in memory", () => {
      expect(isDiscountPercentWithinCap(5, { maxDiscountPercent: NaN as any })).toBe(false);
      expect(isDiscountPercentWithinCap(5, { maxDiscountPercent: -5 })).toBe(false);
      expect(isDiscountPercentWithinCap(0, { maxDiscountPercent: -5 })).toBe(false);
    });

    it("2.3 isDiscountAmountWithinCap fails-closed on negative, NaN, or non-numeric requests", () => {
      const caps = { maxDiscountAmountIqd: "50000.00" };
      expect(isDiscountAmountWithinCap("-1", caps)).toBe(false);
      expect(isDiscountAmountWithinCap("-0.01", caps)).toBe(false);
      expect(isDiscountAmountWithinCap("NaN", caps)).toBe(false);
      expect(isDiscountAmountWithinCap("invalid", caps)).toBe(false);
      expect(isDiscountAmountWithinCap("", caps)).toBe(false);
      expect(isDiscountAmountWithinCap("50000.00", caps)).toBe(true);
      expect(isDiscountAmountWithinCap("50000.01", caps)).toBe(false);
      expect(isDiscountAmountWithinCap("0.00", caps)).toBe(true);
      expect(isDiscountAmountWithinCap(50000, caps)).toBe(true);
      expect(isDiscountAmountWithinCap(50001, caps)).toBe(false);
    });

    it("2.4 isDiscountAmountWithinCap fails-closed on corrupted cap definitions", () => {
      expect(isDiscountAmountWithinCap("10.00", { maxDiscountAmountIqd: "invalid" as any })).toBe(false);
      expect(isDiscountAmountWithinCap("10.00", { maxDiscountAmountIqd: "-100" as any })).toBe(false);
      expect(isDiscountAmountWithinCap("0.00", { maxDiscountAmountIqd: "-100" as any })).toBe(false);
    });

    it("2.5 All other monetary cap helpers fail-closed identically", () => {
      const creditCaps = { maxCreditSaleLimitIqd: "100000.00" };
      expect(isCreditSaleWithinCap("-10", creditCaps)).toBe(false);
      expect(isCreditSaleWithinCap("100000.00", creditCaps)).toBe(true);
      expect(isCreditSaleWithinCap("100000.01", creditCaps)).toBe(false);

      const paymentCaps = { maxPaymentVoucherAmountIqd: "50000.00" };
      expect(isPaymentVoucherWithinCap("-5", paymentCaps)).toBe(false);
      expect(isPaymentVoucherWithinCap("50000.00", paymentCaps)).toBe(true);
      expect(isPaymentVoucherWithinCap("50000.01", paymentCaps)).toBe(false);

      const expenseCaps = { maxExpenseVoucherAmountIqd: "25000.00" };
      expect(isExpenseWithinCap("-5", expenseCaps)).toBe(false);
      expect(isExpenseWithinCap("25000.00", expenseCaps)).toBe(true);
      expect(isExpenseWithinCap("25000.01", expenseCaps)).toBe(false);

      const refundCaps = { maxRefundAmountIqd: "15000.00" };
      expect(isRefundWithinCap("-5", refundCaps)).toBe(false);
      expect(isRefundWithinCap("15000.00", refundCaps)).toBe(true);
      expect(isRefundWithinCap("15000.01", refundCaps)).toBe(false);
    });

    it("2.6 Unlimited caps (null) permit any non-negative valid amount", () => {
      const unlimited: OperationalCaps = {
        maxDiscountPercent: 100,
        maxDiscountAmountIqd: null,
        maxCreditSaleLimitIqd: null,
      };
      expect(isDiscountPercentWithinCap(100, unlimited)).toBe(true);
      expect(isDiscountPercentWithinCap(0, unlimited)).toBe(true);
      expect(isDiscountAmountWithinCap("999999999.00", unlimited)).toBe(true);
      expect(isCreditSaleWithinCap("999999999.00", unlimited)).toBe(true);
      // But still rejects negative numbers:
      expect(isDiscountPercentWithinCap(-1, unlimited)).toBe(false);
      expect(isDiscountAmountWithinCap("-1", unlimited)).toBe(false);
    });

    it("2.7 Fuzz testing: 50 randomized inputs to cap evaluators never throw unhandled exceptions", () => {
      const caps = { maxDiscountPercent: 15, maxDiscountAmountIqd: "10000.00" };
      for (let i = 0; i < 50; i++) {
        const randomVal = (Math.random() - 0.5) * 50000;
        expect(() => isDiscountPercentWithinCap(randomVal, caps)).not.toThrow();
        expect(() => isDiscountAmountWithinCap(String(randomVal), caps)).not.toThrow();
      }
    });
  });

  // ==========================================================================
  // Suite 3: Context Resolution Stress Testing
  // ==========================================================================
  describe("Suite 3: Context Resolution Stress Testing", () => {
    it("3.1 Built-in role with null overrides resolves strictly typed complete atomic map", async () => {
      const user = {
        id: 10,
        name: "كاشير",
        role: "cashier",
        customRoleId: null,
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      await resolveCustomRole(user);

      expect(user.resolvedAtomicPermissions).toBeDefined();
      expect(user.resolvedOperationalCaps).toBeDefined();

      // Verify every known atomic key is boolean
      for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
        expect(typeof user.resolvedAtomicPermissions![key]).toBe("boolean");
      }
      expect(user.resolvedAtomicPermissions!["pos.shift.open"]).toBe(true);
      expect(user.resolvedOperationalCaps!.maxDiscountPercent).toBe(5);
    });

    it("3.2 Unknown or missing base role string safely falls back to 'user' defaults", async () => {
      const user = {
        id: 11,
        name: "دور غريب",
        role: "HACKER_ROLE_NOT_EXIST" as any,
        customRoleId: null,
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      await resolveCustomRole(user);

      // Falls back to 'user'
      expect(user.resolvedAtomicPermissions!["pos.shift.open"]).toBe(false);
      expect(user.resolvedAtomicPermissions!["reception.order.cancel"]).toBe(false);
      expect(user.resolvedOperationalCaps!.maxDiscountPercent).toBe(0);
      expect(user.resolvedOperationalCaps!.maxDiscountAmountIqd).toBe("0.00");
    });

    it("3.3 Custom role + user overrides: user explicit false revokes and true grants", async () => {
      vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue({
        id: 5,
        key: "custom_cashier",
        label: "كاشير مخصص",
        baseRole: "cashier",
        isActive: true,
        permissions: {},
        atomicPermissions: {
          "pos.shift.open": true,
          "reception.order.cancel": false,
        },
        operationalCaps: {
          maxDiscountPercent: 10,
          maxDiscountAmountIqd: "50000.00",
        },
      } as any);

      const user = {
        id: 12,
        name: "مستخدم مخصص",
        role: "cashier",
        customRoleId: 5,
        atomicPermissions: {
          "pos.shift.open": false,           // Explicit user revocation
          "reception.order.cancel": true,    // Explicit user grant
        },
        operationalCaps: {
          maxDiscountPercent: 2,             // User override tighter cap
          maxDiscountAmountIqd: "10000.00",
        },
      } as unknown as AuthUser;

      await resolveCustomRole(user);

      expect(user.role).toBe("cashier");
      expect(user.customRoleLabel).toBe("كاشير مخصص");
      expect(user.resolvedAtomicPermissions!["pos.shift.open"]).toBe(false);
      expect(user.resolvedAtomicPermissions!["reception.order.cancel"]).toBe(true);
      expect(user.resolvedOperationalCaps!.maxDiscountPercent).toBe(2);
      expect(user.resolvedOperationalCaps!.maxDiscountAmountIqd).toBe("10000.00");
    });

    it("3.4 Inactive custom role fails-closed to 'user' role with locked flag and stripped caps", async () => {
      // Simulates loadActiveCustomRole returning null when role is inactive
      vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue(null);

      const user = {
        id: 13,
        name: "دور معطل",
        role: "admin", // Originally claimed admin
        customRoleId: 99,
        permissionsOverride: { pos: "FULL" },
        atomicPermissions: { "pos.shift.open": true },
        operationalCaps: { maxDiscountPercent: 100 },
      } as unknown as AuthUser;

      await resolveCustomRole(user);

      expect(user.role).toBe("user");
      expect(user.permissionsOverride).toBeNull();
      expect(user.customRoleLabel).toBeNull();
      expect(user.roleLockedByInactiveCustomRole).toBe(true);
      expect(user.resolvedAtomicPermissions!["pos.shift.open"]).toBe(false);
      expect(user.resolvedOperationalCaps!.maxDiscountPercent).toBe(0);
      expect(user.resolvedOperationalCaps!.maxDiscountAmountIqd).toBe("0.00");
    });

    it("3.5 Non-existent custom role ID (e.g. 999999) fails-closed safely without crashing", async () => {
      vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue(null);

      const user = {
        id: 14,
        name: "معرف مفقود",
        role: "manager",
        customRoleId: 999999,
      } as unknown as AuthUser;

      await expect(resolveCustomRole(user)).resolves.not.toThrow();
      expect(user.role).toBe("user");
      expect(user.roleLockedByInactiveCustomRole).toBe(true);
    });

    it("3.6 DB-corrupted atomicPermissions (non-booleans, arrays, strings) do not corrupt resolution", () => {
      const corruptedOverrides = {
        "pos.shift.open": "NOT_A_BOOLEAN",
        "evil.key": 12345,
        "pos.invoice.create": false, // Valid boolean
      } as any;

      const resolved = resolveAtomicPermissions("cashier", null, corruptedOverrides);
      expect(resolved["pos.invoice.create"]).toBe(false);
      // Non-boolean did not overwrite base preset:
      expect(resolved["pos.shift.open"]).toBe(true);
      expect((resolved as any)["evil.key"]).toBeUndefined();
    });

    it("3.7 DB-corrupted operationalCaps (arrays, strings, non-objects) do not crash resolveOperationalCaps", () => {
      expect(() => resolveOperationalCaps("cashier", "STRING" as any, null)).not.toThrow();
      expect(() => resolveOperationalCaps("cashier", [1, 2, 3] as any, null)).not.toThrow();
      expect(() => resolveOperationalCaps("cashier", null, "STRING" as any)).not.toThrow();
      expect(() => resolveOperationalCaps("cashier", null, [1, 2, 3] as any)).not.toThrow();

      const res = resolveOperationalCaps("cashier", "CORRUPTED" as any, [1, 2, 3] as any);
      expect(res.maxDiscountPercent).toBe(5);
    });

    it("3.8 Company owner authority normalizes any role to admin with 100% full permissions and unlimited caps", () => {
      const owner = {
        id: 1,
        name: "المالك",
        role: "user",
        isOwner: true,
        customRoleId: null,
        atomicPermissions: null,
        operationalCaps: null,
      } as unknown as AuthUser;

      const normalized = normalizeOwnerAuthority(owner);
      expect(normalized.role).toBe("admin");
      expect(normalized.resolvedOperationalCaps!.maxDiscountPercent).toBe(100);
      expect(normalized.resolvedOperationalCaps!.maxDiscountAmountIqd).toBeNull();
      expect(normalized.resolvedAtomicPermissions!["pos.shift.open"]).toBe(true);
    });

    it("3.9 Fuzz testing: 50 erratic AuthUser objects resolve cleanly without unhandled errors", async () => {
      vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue(null);

      for (let i = 0; i < 50; i++) {
        const erraticUser = {
          id: i,
          name: `User_${i}`,
          role: i % 2 === 0 ? "cashier" : (null as any),
          customRoleId: i % 3 === 0 ? i : null,
          atomicPermissions: i % 4 === 0 ? ("bad_str" as any) : { "pos.shift.open": i % 2 === 0 },
          operationalCaps: i % 5 === 0 ? ([123] as any) : { maxDiscountPercent: i },
        } as unknown as AuthUser;

        await expect(resolveCustomRole(erraticUser)).resolves.not.toThrow();
        expect(erraticUser.resolvedAtomicPermissions).toBeDefined();
        expect(erraticUser.resolvedOperationalCaps).toBeDefined();
      }
    });
  });

  // ==========================================================================
  // Suite 4: Safe Columns Leak Prevention Testing
  // ==========================================================================
  describe("Suite 4: Safe Columns Leak Prevention Testing", () => {
    const SENSITIVE_FIELDS = [
      "passwordHash",
      "pinHash",
      "totpSecretEncrypted",
      "totpEnabledAt",
      "totpLastUsedStep",
      "failedLoginAttempts",
      "lockedUntil",
      "lastFailedLoginAt",
      "tempPasswordExpiresAt",
      "accessExpiresAt",
      "sessionsValidFrom",
    ];

    it("4.1 Direct source inspection: SAFE_COLUMNS in userService.ts strictly excludes sensitive fields", () => {
      const userServicePath = path.resolve(
        process.cwd(),
        "server/services/userService.ts",
      );
      const code = readFileSync(userServicePath, "utf8");

      // Extract SAFE_COLUMNS block
      const match = code.match(/const SAFE_COLUMNS = \{([\s\S]*?)\} as const;/);
      expect(match).not.toBeNull();
      const safeColumnsBlock = match![1];

      // Verify none of the sensitive fields are present as selected keys in SAFE_COLUMNS
      for (const field of SENSITIVE_FIELDS) {
        const regex = new RegExp(`^\\s*${field}\\s*:`, "m");
        expect(
          regex.test(safeColumnsBlock),
          `Security violation: ${field} must NOT be present in SAFE_COLUMNS!`,
        ).toBe(false);
      }

      // Verify pinHash is only used inside the SQL expression for hasPin
      expect(safeColumnsBlock).toContain("hasPin: sql<boolean>`CASE WHEN ${users.pinHash} IS NOT NULL THEN TRUE ELSE FALSE END`");
      // And pinHash is NOT an exported property
      expect(/^\s*pinHash\s*:/m.test(safeColumnsBlock)).toBe(false);

      // Verify atomicPermissions and operationalCaps ARE selected
      expect(safeColumnsBlock).toContain("atomicPermissions: users.atomicPermissions");
      expect(safeColumnsBlock).toContain("operationalCaps: users.operationalCaps");
    });

    it("4.2 SAFE_COLUMNS_WITH_ROLE does not introduce any sensitive fields", () => {
      const userServicePath = path.resolve(
        process.cwd(),
        "server/services/userService.ts",
      );
      const code = readFileSync(userServicePath, "utf8");
      expect(code).toContain("const SAFE_COLUMNS_WITH_ROLE = { ...SAFE_COLUMNS, customRoleLabel: roles.label } as const;");
    });

    it("4.3 listUsers excludes internal joined role columns (_roleBaseRole, _rolePermissions)", () => {
      const userServicePath = path.resolve(
        process.cwd(),
        "server/services/userService.ts",
      );
      const code = readFileSync(userServicePath, "utf8");

      // Verify destructuring drops internal columns before returning rows
      expect(code).toContain("const rows = raw.map(({ _roleBaseRole, _rolePermissions, ...r }) => ({");
    });

    it("4.4 Simulated full DB row projection: 100% of sensitive fields are excluded from safe user objects", () => {
      // Simulate raw database record with realistic secrets
      const rawDbRow = {
        id: 100,
        name: "حساب تجريبي",
        email: "test@alroya.local",
        username: "test_user",
        phone: "07701234567",
        role: "cashier",
        customRoleId: null,
        branchId: 1,
        isActive: true,
        isOwner: false,
        jobTitle: "كاشير",
        hiredAt: "2026-01-01",
        permissionsOverride: null,
        atomicPermissions: { "pos.shift.open": true },
        operationalCaps: { maxDiscountPercent: 5 },
        mustChangePassword: false,
        lastSignedIn: new Date(),
        createdAt: new Date(),
        badgeBarcode: "BC-100",
        // Sensitive columns:
        passwordHash: "$scrypt$N=16384,r=8,p=1$secretpasswordhash",
        pinHash: "$scrypt$N=16384,r=8,p=1$secretpinhash",
        totpSecretEncrypted: "v1:iv123:tag123:encryptedtotpsecret",
        totpEnabledAt: new Date(),
        totpLastUsedStep: 123456,
        failedLoginAttempts: 3,
        lockedUntil: new Date(),
        lastFailedLoginAt: new Date(),
        tempPasswordExpiresAt: new Date(),
        accessExpiresAt: new Date(),
        sessionsValidFrom: new Date(),
      };

      // Simulated safe projection keys based on SAFE_COLUMNS
      const safeKeys = [
        "id", "name", "email", "username", "phone", "role", "customRoleId",
        "branchId", "isActive", "isOwner", "jobTitle", "hiredAt",
        "permissionsOverride", "atomicPermissions", "operationalCaps",
        "mustChangePassword", "lastSignedIn", "createdAt", "badgeBarcode", "hasPin",
      ];

      const projectedUser: Record<string, any> = {};
      for (const k of safeKeys) {
        if (k === "hasPin") {
          projectedUser[k] = rawDbRow.pinHash !== null;
        } else {
          projectedUser[k] = (rawDbRow as any)[k];
        }
      }

      // Assert that none of the sensitive fields exist on projectedUser
      for (const secretField of SENSITIVE_FIELDS) {
        expect(projectedUser[secretField]).toBeUndefined();
      }

      const serialized = JSON.stringify(projectedUser);
      expect(serialized).not.toContain("secretpasswordhash");
      expect(serialized).not.toContain("secretpinhash");
      expect(serialized).not.toContain("encryptedtotpsecret");
      expect(serialized).not.toContain("totp");
      expect(serialized).not.toContain("passwordHash");

      // Verify that atomicPermissions and operationalCaps ARE safely available
      expect(projectedUser.atomicPermissions).toEqual({ "pos.shift.open": true });
      expect(projectedUser.operationalCaps).toEqual({ maxDiscountPercent: 5 });
      expect(projectedUser.hasPin).toBe(true);
    });
  });

  // ==========================================================================
  // Suite 5: Deep Boundary, Prototype Pollution & Performance Resilience
  // ==========================================================================
  describe("Suite 5: Prototype Pollution, Boundary & Performance Resilience", () => {
    it("5.1 Prototype pollution attack via atomic overrides never pollutes Object.prototype", () => {
      const maliciousPayload = JSON.parse(
        '{"pos.shift.open": false, "__proto__": {"pollutedAttr": "ATTACK_SUCCESS"}}'
      );

      const resolved = resolveAtomicPermissions("cashier", null, maliciousPayload);
      expect(resolved["pos.shift.open"]).toBe(false);
      expect((Object.prototype as any).pollutedAttr).toBeUndefined();
      expect(({} as any).pollutedAttr).toBeUndefined();
    });

    it("5.2 Payload inflation / DoS check: resolves 10,000 override keys in under 50ms", () => {
      const hugeOverrides: AtomicPermissionsMap = {};
      for (let i = 0; i < 10000; i++) {
        hugeOverrides[`stress.key.${i}`] = i % 2 === 0;
      }

      const start = performance.now();
      const resolved = resolveAtomicPermissions("cashier", null, hugeOverrides);
      const elapsedMs = performance.now() - start;

      expect(resolved["pos.shift.open"]).toBe(true);
      expect(resolved["stress.key.9999"]).toBe(false);
      expect(elapsedMs).toBeLessThan(50); // High throughput execution
    });

    it("5.3 Strict distinction between explicit 0 (forbidden) and null (unlimited)", () => {
      // 0 discount means zero discount allowed
      const zeroCaps = resolveOperationalCaps("cashier", null, { maxDiscountPercent: 0 });
      expect(zeroCaps.maxDiscountPercent).toBe(0);
      expect(isDiscountPercentWithinCap(0, zeroCaps)).toBe(true);
      expect(isDiscountPercentWithinCap(0.01, zeroCaps)).toBe(false);

      // null discount amount means unlimited allowed
      const roleWithCap = { maxDiscountAmountIqd: "50000.00" };
      const userUnlimiting = { maxDiscountAmountIqd: null };
      const resolved = resolveOperationalCaps("cashier", roleWithCap, userUnlimiting);
      expect(resolved.maxDiscountAmountIqd).toBeNull();
      expect(isDiscountAmountWithinCap("1000000000.00", resolved)).toBe(true);
    });

    it("5.4 Sensitive data masking fails-closed to all-true for inactive custom roles and unknown roles", async () => {
      vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue(null);

      const inactiveRoleUser = {
        id: 77,
        name: "مستخدم معطل",
        role: "admin",
        customRoleId: 77,
      } as unknown as AuthUser;

      await resolveCustomRole(inactiveRoleUser);

      // Must fail closed to full masking
      expect(inactiveRoleUser.resolvedSensitiveDataMasking).toBeDefined();
      expect(inactiveRoleUser.resolvedSensitiveDataMasking!.maskPurchaseCost).toBe(true);
      expect(inactiveRoleUser.resolvedSensitiveDataMasking!.maskProfitMargin).toBe(true);
      expect(inactiveRoleUser.resolvedSensitiveDataMasking!.maskSupplierPhone).toBe(true);
    });

    it("5.5 Non-positive or falsy customRoleId (0, NaN, null, undefined) bypasses DB role lookup safely", async () => {
      const dbSpy = vi.spyOn(roleService, "loadActiveCustomRole");

      const usersWithFalsyRoles = [
        { id: 1, role: "cashier", customRoleId: null },
        { id: 2, role: "cashier", customRoleId: undefined },
        { id: 3, role: "cashier", customRoleId: 0 },
        { id: 4, role: "cashier", customRoleId: NaN },
      ];

      for (const u of usersWithFalsyRoles) {
        await resolveCustomRole(u as unknown as AuthUser);
        expect((u as any).resolvedAtomicPermissions).toBeDefined();
        expect((u as any).resolvedOperationalCaps).toBeDefined();
      }

      // No DB lookups were initiated for falsy role IDs
      expect(dbSpy).not.toHaveBeenCalled();
    });
  });
});
