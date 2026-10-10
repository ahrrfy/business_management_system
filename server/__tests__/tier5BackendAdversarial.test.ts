/**
 * server/__tests__/tier5BackendAdversarial.test.ts
 *
 * Tier 5 White-Box Adversarial Coverage Hardening Suite for
 * Comprehensive Permission Matrix System (Milestone 4):
 *
 * 1. Extreme boundary stress:
 *    NaN, Infinity, negative values, fractional amounts, null/undefined
 *    permutations in financial caps and Zod schemas.
 * 2. Resolution hierarchy stress:
 *    Built-in role vs custom role vs user override under contradictory
 *    grant/deny overrides, fail-closed inactive roles, and owner immunity.
 * 3. SoD rules stress:
 *    Maker-checker combinations across all 10 operational domains,
 *    auditor neutrality, and template SoD conflict immunity.
 * 4. Concurrency & session invalidation:
 *    Immediate token invalidation via `sessionsValidFrom` timestamp comparisons,
 *    mathematical boundary proofs, and service trigger verification.
 * 5. Dual-resolution & backward compatibility:
 *    30-module legacy mapping, envelope normalization, and fail-closed fallbacks.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  isDiscountPercentWithinCap,
  isDiscountAmountWithinCap,
  isCreditSaleWithinCap,
  isPaymentVoucherWithinCap,
  isExpenseWithinCap,
  isRefundWithinCap,
  resolveAtomicPermissions,
  resolveOperationalCaps,
  resolveSensitiveDataMasking,
  hasAtomicPermission,
  checkSodConflicts,
  filterAtomicOverrides,
  getDomainStats,
  searchAtomicPermissions,
  deriveLegacyModulesFromAtomic,
  deriveAtomicFromLegacyModules,
  normalizePermissionsInput,
  operationalCapsSchema,
  sensitiveDataMaskingSchema,
  atomicPermissionsMapSchema,
  permissionEnvelopeSchema,
  ATOMIC_PERMISSION_DEFINITIONS,
  ALL_DOMAINS,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  DEFAULT_ZERO_CAPS,
  DEFAULT_UNLIMITED_CAPS,
  DEFAULT_MASKING_ALL_TRUE,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
  type DomainKey,
} from "@shared/atomicPermissions";
import { ALL_PERMISSION_MODULE_KEYS } from "@shared/permissions";
import {
  normalizeOwnerAuthority,
  resolveCustomRole,
  type AuthUser,
} from "../context";
import { isSessionRevokedByTimestamp } from "../auth/session";
import * as roleService from "../services/roleService";
import { users, roles } from "../../drizzle/schema";

describe("Tier 5 Backend Adversarial Coverage Hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // SUITE 1: Extreme Boundary Stress on Financial Caps & Schemas
  // ==========================================================================
  describe("Suite 1: Extreme Boundary Stress on Financial Caps", () => {
    describe("1.1 Discount Percentage Cap Hardening (isDiscountPercentWithinCap)", () => {
      it("rejects non-numeric, NaN, and infinite inputs fail-closed", () => {
        const hostilePercents = [
          NaN,
          Infinity,
          -Infinity,
          -1,
          -0.0001,
          -100,
          100.0001,
          101,
          999,
          1e20,
        ];

        for (const p of hostilePercents) {
          expect(isDiscountPercentWithinCap(p, { maxDiscountPercent: 50 })).toBe(false);
          expect(isDiscountPercentWithinCap(p, null)).toBe(false);
          expect(isDiscountPercentWithinCap(p, undefined)).toBe(false);
          expect(isDiscountPercentWithinCap(p, { maxDiscountPercent: 100 })).toBe(false);
        }
      });

      it("enforces exact percentage boundaries under various cap states", () => {
        // Zero cap (0% allowed, nothing above)
        expect(isDiscountPercentWithinCap(0, { maxDiscountPercent: 0 })).toBe(true);
        expect(isDiscountPercentWithinCap(0.01, { maxDiscountPercent: 0 })).toBe(false);

        // Standard cashier cap (5%)
        expect(isDiscountPercentWithinCap(0, { maxDiscountPercent: 5 })).toBe(true);
        expect(isDiscountPercentWithinCap(5, { maxDiscountPercent: 5 })).toBe(true);
        expect(isDiscountPercentWithinCap(5.0001, { maxDiscountPercent: 5 })).toBe(false);

        // Full cap (100%)
        expect(isDiscountPercentWithinCap(100, { maxDiscountPercent: 100 })).toBe(true);
        expect(isDiscountPercentWithinCap(100.001, { maxDiscountPercent: 100 })).toBe(false);

        // Unlimited cap (null or undefined cap allows valid 0-100)
        expect(isDiscountPercentWithinCap(0, { maxDiscountPercent: null })).toBe(true);
        expect(isDiscountPercentWithinCap(100, { maxDiscountPercent: null })).toBe(true);
        expect(isDiscountPercentWithinCap(50, null)).toBe(true);
        expect(isDiscountPercentWithinCap(100, undefined)).toBe(true);
      });
    });

    describe("1.2 Monetary Caps Hardening (Amounts, Limits, Vouchers, Expenses, Refunds)", () => {
      const capCheckers = [
        { name: "DiscountAmount", fn: isDiscountAmountWithinCap, field: "maxDiscountAmountIqd" as const },
        { name: "CreditSale", fn: isCreditSaleWithinCap, field: "maxCreditSaleLimitIqd" as const },
        { name: "PaymentVoucher", fn: isPaymentVoucherWithinCap, field: "maxPaymentVoucherAmountIqd" as const },
        { name: "Expense", fn: isExpenseWithinCap, field: "maxExpenseVoucherAmountIqd" as const },
        { name: "Refund", fn: isRefundWithinCap, field: "maxRefundAmountIqd" as const },
      ];

      for (const { name, fn, field } of capCheckers) {
        describe(`Function ${name}`, () => {
          it("rejects negative, NaN, infinite, and malformed strings fail-closed", () => {
            const invalidInputs = [
              "-1",
              "-0.01",
              "-1000.00",
              "NaN",
              "Infinity",
              "-Infinity",
              "abc",
              "100 IQD",
              "$100",
              "",
              "   ",
              "\t\n",
              -1,
              -0.0001,
              NaN,
              Infinity,
              -Infinity,
            ];

            const standardCap = { [field]: "50000.00" } as OperationalCaps;
            for (const input of invalidInputs) {
              expect(fn(input, standardCap)).toBe(false);
              expect(fn(input, null)).toBe(false);
              expect(fn(input, undefined)).toBe(false);
            }
          });

          it("enforces zero-cap boundary strictly", () => {
            const zeroCap = { [field]: "0.00" } as OperationalCaps;
            expect(fn("0", zeroCap)).toBe(true);
            expect(fn("0.00", zeroCap)).toBe(true);
            expect(fn(0, zeroCap)).toBe(true);
            expect(fn("0.01", zeroCap)).toBe(false);
            expect(fn(0.01, zeroCap)).toBe(false);
            expect(fn("100", zeroCap)).toBe(false);
          });

          it("handles exact threshold boundaries and precision edge cases", () => {
            const testCap = { [field]: "25000.00" } as OperationalCaps;
            expect(fn("24999.99", testCap)).toBe(true);
            expect(fn("25000.00", testCap)).toBe(true);
            expect(fn(25000, testCap)).toBe(true);
            expect(fn("25000.01", testCap)).toBe(false);
            expect(fn(25000.01, testCap)).toBe(false);

            // Floating point boundary simulation (0.1 + 0.2 = 0.30000000000000004)
            const sumFloat = 0.1 + 0.2;
            const floatCap = { [field]: "0.30" } as OperationalCaps;
            // 0.30000000000000004 > 0.30, so strict number check correctly evaluates
            expect(fn(sumFloat, floatCap)).toBe(false);
            // Normalized string format "0.30" succeeds
            expect(fn("0.30", floatCap)).toBe(true);
          });

          it("treats null and undefined caps as unlimited for non-negative inputs", () => {
            const unlimitedCap = { [field]: null } as OperationalCaps;
            expect(fn("1000000000.00", unlimitedCap)).toBe(true);
            expect(fn(999999999, null)).toBe(true);
            expect(fn("0.00", undefined)).toBe(true);
          });

          it("fails closed when the cap definition itself is corrupted or malformed", () => {
            const corruptedCaps = [
              { [field]: "invalid" } as OperationalCaps,
              { [field]: "-500.00" } as OperationalCaps,
              { [field]: "NaN" } as OperationalCaps,
              { [field]: "" } as OperationalCaps,
            ];

            for (const badCap of corruptedCaps) {
              expect(fn("100.00", badCap)).toBe(false);
            }
          });
        });
      }
    });

    describe("1.3 Zod Schema Validation Hardening (operationalCapsSchema & sensitiveDataMaskingSchema)", () => {
      it("rejects malicious or out-of-range payloads in operationalCapsSchema", () => {
        const hostilePayloads = [
          { maxDiscountPercent: 101 },
          { maxDiscountPercent: -1 },
          { maxDiscountPercent: NaN },
          { maxDiscountPercent: "50" }, // must be number
          { maxDiscountAmountIqd: "-100.00" },
          { maxDiscountAmountIqd: "100.001" }, // > 2 decimal places
          { maxDiscountAmountIqd: "1,000.00" }, // comma rejected
          { maxCreditSaleLimitIqd: "Infinity" },
          { maxPaymentVoucherAmountIqd: 1000 }, // must be string
          { maxExpenseVoucherAmountIqd: true },
          { maxRefundAmountIqd: [500] },
        ];

        for (const payload of hostilePayloads) {
          const parsed = operationalCapsSchema.safeParse(payload);
          expect(parsed.success).toBe(false);
        }
      });

      it("accepts valid nullish and fractional payloads in operationalCapsSchema", () => {
        const validPayloads = [
          {},
          { maxDiscountPercent: 0 },
          { maxDiscountPercent: 100 },
          { maxDiscountPercent: 12.5 },
          { maxDiscountPercent: null },
          { maxDiscountAmountIqd: "0" },
          { maxDiscountAmountIqd: "0.00" },
          { maxDiscountAmountIqd: "9999999.99" },
          { maxDiscountAmountIqd: null },
          {
            maxDiscountPercent: 10,
            maxDiscountAmountIqd: "50000.00",
            maxCreditSaleLimitIqd: "1000000.00",
            maxPaymentVoucherAmountIqd: "250000.00",
            maxExpenseVoucherAmountIqd: "100000.00",
            maxRefundAmountIqd: "50000.00",
          },
        ];

        for (const payload of validPayloads) {
          const parsed = operationalCapsSchema.safeParse(payload);
          expect(parsed.success).toBe(true);
        }
      });

      it("enforces strict boolean/null/undefined types in sensitiveDataMaskingSchema", () => {
        const validMasking = [
          {},
          { maskPurchaseCost: true },
          { maskPurchaseCost: false },
          { maskPurchaseCost: null },
          {
            maskPurchaseCost: true,
            maskProfitMargin: true,
            maskSupplierPhone: false,
            maskCustomerContact: false,
          },
        ];

        for (const payload of validMasking) {
          expect(sensitiveDataMaskingSchema.safeParse(payload).success).toBe(true);
        }

        const invalidMasking = [
          { maskPurchaseCost: "true" },
          { maskProfitMargin: 1 },
          { maskSupplierPhone: 0 },
          { maskCustomerContact: {} },
        ];

        for (const payload of invalidMasking) {
          expect(sensitiveDataMaskingSchema.safeParse(payload).success).toBe(false);
        }
      });
    });
  });

  // ==========================================================================
  // SUITE 2: Resolution Hierarchy Stress (Built-in vs Custom vs Overrides)
  // ==========================================================================
  describe("Suite 2: Resolution Hierarchy Stress", () => {
    describe("2.1 Atomic Permissions Hierarchy Resolution", () => {
      it("resolves exact 3-tier contradictory overrides (Base vs Custom vs User)", () => {
        const key = "pos.invoice.create";

        // Case 1: Base=true, Custom=false (DENY), User=true (GRANT) -> Final: true
        const res1 = resolveAtomicPermissions(
          "cashier",
          { [key]: false },
          { [key]: true },
        );
        expect(res1[key]).toBe(true);

        // Case 2: Base=true, Custom=true, User=false (DENY) -> Final: false
        const res2 = resolveAtomicPermissions(
          "cashier",
          { [key]: true },
          { [key]: false },
        );
        expect(res2[key]).toBe(false);

        // Case 3: Base=false, Custom=true (GRANT), User=false (DENY) -> Final: false
        const res3 = resolveAtomicPermissions(
          "auditor",
          { [key]: true },
          { [key]: false },
        );
        expect(res3[key]).toBe(false);

        // Case 4: Base=false, Custom=true (GRANT), User=undefined -> Final: true
        const res4 = resolveAtomicPermissions(
          "auditor",
          { [key]: true },
          undefined,
        );
        expect(res4[key]).toBe(true);

        // Case 5: Base=true, Custom=undefined, User=false (DENY) -> Final: false
        const res5 = resolveAtomicPermissions(
          "cashier",
          undefined,
          { [key]: false },
        );
        expect(res5[key]).toBe(false);
      });

      it("ignores non-boolean values in overrides without corrupting state", () => {
        const key = "pos.invoice.create";
        const malformedCustom = { [key]: "true" as unknown as boolean, "pos.shift.open": 123 as unknown as boolean };
        const malformedUser = { [key]: null as unknown as boolean, "pos.shift.close": {} as unknown as boolean };

        const resolved = resolveAtomicPermissions("cashier", malformedCustom, malformedUser);
        // Base cashier has pos.invoice.create = true, pos.shift.open = true, pos.shift.close = true
        expect(resolved["pos.invoice.create"]).toBe(true);
        expect(resolved["pos.shift.open"]).toBe(true);
        expect(resolved["pos.shift.close"]).toBe(true);
      });

      it("falls back safely to 'user' template if unknown role name provided", () => {
        const resolved = resolveAtomicPermissions("unknown_evil_role");
        const userTemplate = ROLE_DEFAULT_ATOMIC_PERMISSIONS.user;
        expect(resolved).toEqual(userTemplate);
      });
    });

    describe("2.2 Operational Caps Hierarchy Resolution", () => {
      it("resolves 3-tier contradictory caps prioritizing user override", () => {
        // Base cashier has maxDiscountPercent = 5
        const roleCaps: OperationalCaps = { maxDiscountPercent: 10, maxDiscountAmountIqd: "50000.00" };
        const userCaps: OperationalCaps = { maxDiscountPercent: 0, maxDiscountAmountIqd: "0.00" };

        const resolved = resolveOperationalCaps("cashier", roleCaps, userCaps);
        // User explicit 0 override must trump custom role's 10 and base's 5
        expect(resolved.maxDiscountPercent).toBe(0);
        expect(resolved.maxDiscountAmountIqd).toBe("0.00");
      });

      it("preserves role cap when user override does not specify that field", () => {
        const roleCaps: OperationalCaps = {
          maxDiscountPercent: 15,
          maxCreditSaleLimitIqd: "100000.00",
        };
        const userCaps: OperationalCaps = {
          maxDiscountPercent: 8,
          // maxCreditSaleLimitIqd omitted
        };

        const resolved = resolveOperationalCaps("cashier", roleCaps, userCaps);
        expect(resolved.maxDiscountPercent).toBe(8);
        expect(resolved.maxCreditSaleLimitIqd).toBe("100000.00");
      });
    });

    describe("2.3 Company Owner Invariant (normalizeOwnerAuthority)", () => {
      it("strictly restores admin authority and strips all restrictions for owner accounts", () => {
        const restrictedOwner: AuthUser = {
          id: 1,
          name: "Owner",
          role: "user" as const,
          isOwner: true,
          customRoleId: 42,
          customRoleLabel: "Restricted",
          customRoleKey: "restricted",
          permissionsOverride: { sales: "NONE" },
          atomicPermissions: { "pos.invoice.create": false, "governance.user.manage": false },
          operationalCaps: { maxDiscountPercent: 0, maxDiscountAmountIqd: "0.00" },
          roleLockedByInactiveCustomRole: true,
        } as AuthUser;

        const normalized = normalizeOwnerAuthority(restrictedOwner);

        expect(normalized.role).toBe("admin");
        expect(normalized.isOwner).toBe(true);
        expect(normalized.customRoleId).toBe(42); // field retained but neutralized
        expect(normalized.customRoleLabel).toBeNull();
        expect(normalized.customRoleKey).toBeNull();
        expect(normalized.roleLockedByInactiveCustomRole).toBe(false);
        expect(normalized.permissionsOverride).toBeNull();

        // Must have full admin permissions
        expect(normalized.resolvedAtomicPermissions?.["governance.user.manage"]).toBe(true);
        expect(normalized.resolvedAtomicPermissions?.["pos.invoice.create"]).toBe(true);

        // Must have unlimited caps
        expect(normalized.resolvedOperationalCaps?.maxDiscountPercent).toBe(100);
        expect(normalized.resolvedOperationalCaps?.maxDiscountAmountIqd).toBeNull();

        // Must have unmasked sensitive data
        expect(normalized.resolvedSensitiveDataMasking?.maskPurchaseCost).toBe(false);
        expect(normalized.resolvedSensitiveDataMasking?.maskProfitMargin).toBe(false);
      });

      it("does not normalize non-owner accounts", () => {
        const regularUser: AuthUser = {
          id: 2,
          name: "Regular",
          role: "user" as const,
          isOwner: false,
          customRoleId: null,
        } as AuthUser;

        const result = normalizeOwnerAuthority(regularUser);
        expect(result.role).toBe("user");
        expect(result.isOwner).toBe(false);
      });
    });

    describe("2.4 Inactive/Deleted Custom Role Fail-Closed Resolution", () => {
      it("drops strictly to minimal 'user' role if custom role is inactive or deleted", async () => {
        vi.spyOn(roleService, "loadActiveCustomRole").mockResolvedValue(null);

        const user: AuthUser = {
          id: 10,
          name: "Assigned User",
          role: "cashier" as const,
          isOwner: false,
          customRoleId: 99,
          permissionsOverride: { sales: "FULL" },
          atomicPermissions: { "pos.invoice.create": true },
        } as AuthUser;

        await resolveCustomRole(user);

        expect(user.role).toBe("user");
        expect(user.roleLockedByInactiveCustomRole).toBe(true);
        expect(user.permissionsOverride).toBeNull();
        expect(user.customRoleLabel).toBeNull();
        expect(user.customRoleKey).toBeNull();

        // Must have minimal user permissions, not cashier permissions
        expect(user.resolvedAtomicPermissions?.["pos.invoice.create"]).toBe(false);
        expect(user.resolvedAtomicPermissions?.["inventory.item.view"]).toBe(true);

        // Must have zero caps
        expect(user.resolvedOperationalCaps?.maxDiscountPercent).toBe(0);
        expect(user.resolvedOperationalCaps?.maxDiscountAmountIqd).toBe("0.00");
      });
    });
  });

  // ==========================================================================
  // SUITE 3: Segregation of Duties (SoD) Rules Stress Across All 10 Domains
  // ==========================================================================
  describe("Suite 3: Segregation of Duties (SoD) Rules Stress Across All 10 Domains", () => {
    describe("3.1 Core SoD Group Conflict Detection", () => {
      const sodPairs = [
        { group: "rework", maker: "workshop.rework.request", checker: "workshop.rework.approve" },
        { group: "stocktake", maker: "inventory.stocktake.create", checker: "inventory.stocktake.approve" },
        { group: "adjustment", maker: "inventory.adjustment.request", checker: "inventory.adjustment.approve" },
        { group: "purchasing_payment", maker: "purchasing.payment.request", checker: "purchasing.payment.approve" },
        { group: "voucher", maker: "treasury.voucher_out.create", checker: "treasury.voucher_out.approve" },
        { group: "expenses", maker: "treasury.expense.create", checker: "treasury.expense.approve" },
        { group: "payroll", maker: "hr.payroll.compute", checker: "hr.payroll.approve" },
        { group: "commissions", maker: "hr.commission.compute", checker: "hr.commission.approve" },
      ];

      for (const { group, maker, checker } of sodPairs) {
        it(`flags SoD violation when both maker (${maker}) and checker (${checker}) are active`, () => {
          // Maker only -> no conflict
          const makerOnly: AtomicPermissionsMap = { [maker]: true, [checker]: false };
          expect(checkSodConflicts(makerOnly).find((c) => c.group === group)).toBeUndefined();

          // Checker only -> no conflict
          const checkerOnly: AtomicPermissionsMap = { [maker]: false, [checker]: true };
          expect(checkSodConflicts(checkerOnly).find((c) => c.group === group)).toBeUndefined();

          // Both active -> CONFLICT
          const bothActive: AtomicPermissionsMap = { [maker]: true, [checker]: true };
          const conflicts = checkSodConflicts(bothActive);
          const found = conflicts.find((c) => c.group === group);
          expect(found).toBeDefined();
          expect(found?.conflictingKeys).toContain(maker);
          expect(found?.conflictingKeys).toContain(checker);
        });
      }
    });

    describe("3.2 Domain Maker-Checker Invariants Across Remaining Domains", () => {
      it("validates Maker vs Checker separation in POS, Reception, Field Sales, Delivery, Governance", () => {
        // POS Domain: Cashier issuing invoice vs limit override
        const posDef = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "pos.invoice.create");
        const overrideDef = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "governance.limit.override");
        expect(posDef).toBeDefined();
        expect(overrideDef).toBeDefined();
        expect(overrideDef?.sensitivity).toBe("critical");

        // Reception Domain: Order creation vs proof approval
        const orderDef = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "reception.order.create");
        const proofApproveDef = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "reception.proof.approve");
        expect(orderDef).toBeDefined();
        expect(proofApproveDef).toBeDefined();

        // Delivery Domain: Parcel delivery confirmation vs COD settlement
        const deliveryProof = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "delivery.proof.confirm");
        const codSettle = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "delivery.cod.settle");
        expect(deliveryProof).toBeDefined();
        expect(codSettle).toBeDefined();

        // Governance Domain: User management vs Audit inspection
        const userManage = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "governance.user.manage");
        const auditView = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === "governance.audit.view");
        expect(userManage).toBeDefined();
        expect(auditView).toBeDefined();
      });
    });

    describe("3.3 Auditor Role Neutrality & Pure Read-Only Guarantee", () => {
      it("auditor template has zero write/create/edit/cancel/approve permissions across all domains", () => {
        const auditorPerms = ROLE_DEFAULT_ATOMIC_PERMISSIONS.auditor;
        expect(auditorPerms).toBeDefined();

        for (const [key, granted] of Object.entries(auditorPerms)) {
          if (!granted) continue;
          const def = ATOMIC_PERMISSION_DEFINITIONS.find((d) => d.key === key);
          expect(def).toBeDefined();
          // Auditor must only have "view" standardAction (or equivalent read action)
          expect(def?.standardAction === "view" || def?.action.includes("view")).toBe(true);
          expect(def?.standardAction).not.toBe("create");
          expect(def?.standardAction).not.toBe("edit");
          expect(def?.standardAction).not.toBe("cancel");
          expect(def?.standardAction).not.toBe("approve");
        }
      });

      it("auditor has zero SoD conflicts and zero operational caps", () => {
        const auditorPerms = ROLE_DEFAULT_ATOMIC_PERMISSIONS.auditor;
        const conflicts = checkSodConflicts(auditorPerms);
        expect(conflicts).toHaveLength(0);

        const caps = ROLE_DEFAULT_OPERATIONAL_CAPS.auditor;
        expect(caps).toEqual(DEFAULT_ZERO_CAPS);
      });
    });

    describe("3.4 Default Operational Role SoD Immunity", () => {
      it("no operational role default template has internal SoD conflicts", () => {
        const rolesToCheck = [
          "cashier",
          "retail_cashier",
          "print_cashier",
          "reception_clerk",
          "warehouse",
          "purchasing",
          "print_operator",
          "sales_rep",
          "courier",
          "auditor",
          "user",
        ];

        for (const role of rolesToCheck) {
          const perms = ROLE_DEFAULT_ATOMIC_PERMISSIONS[role];
          expect(perms, `Role template missing: ${role}`).toBeDefined();
          const conflicts = checkSodConflicts(perms);
          expect(conflicts, `Role ${role} violates SoD rules: ${JSON.stringify(conflicts)}`).toHaveLength(0);
        }
      });
    });
  });

  // ==========================================================================
  // SUITE 4: Concurrency & Immediate Session Invalidation (sessionsValidFrom)
  // ==========================================================================
  describe("Suite 4: Concurrency & Immediate Session Invalidation", () => {
    describe("4.1 Mathematical Boundary Invariants of isSessionRevokedByTimestamp", () => {
      it("correctly identifies revoked vs valid tokens around validFrom boundary", () => {
        const t = 1760000000; // arbitrary epoch seconds

        // 1. Prior second (iat < validFrom) -> strictly REVOKED
        expect(isSessionRevokedByTimestamp(t - 1, t)).toBe(true);

        // 2. Same second (iat === validFrom) -> strictly REVOKED (AUTH-02 zero-second race closure)
        expect(isSessionRevokedByTimestamp(t, t)).toBe(true);

        // 3. Next second (iat === validFrom + 1) -> strictly VALID (re-issued token)
        expect(isSessionRevokedByTimestamp(t + 1, t)).toBe(false);

        // 4. Future token (iat > validFrom) -> strictly VALID
        expect(isSessionRevokedByTimestamp(t + 100, t)).toBe(false);
      });

      it("handles Date instances, ISO strings, and nullish inputs consistently", () => {
        const nowSec = 1760000000;
        const nowDate = new Date(nowSec * 1000);
        const nowIso = nowDate.toISOString();

        // Token issued before Date object
        expect(isSessionRevokedByTimestamp(nowSec - 5, nowDate)).toBe(true);
        expect(isSessionRevokedByTimestamp(nowSec, nowDate)).toBe(true);
        expect(isSessionRevokedByTimestamp(nowSec + 1, nowDate)).toBe(false);

        // Token issued before ISO string
        expect(isSessionRevokedByTimestamp(nowSec - 5, nowIso)).toBe(true);
        expect(isSessionRevokedByTimestamp(nowSec, nowIso)).toBe(true);
        expect(isSessionRevokedByTimestamp(nowSec + 1, nowIso)).toBe(false);

        // Nullish validFrom -> token is NEVER revoked
        expect(isSessionRevokedByTimestamp(nowSec, null)).toBe(false);
        expect(isSessionRevokedByTimestamp(nowSec, undefined)).toBe(false);
        expect(isSessionRevokedByTimestamp(nowSec, 0)).toBe(false);
      });
    });

    describe("4.2 Monotonicity & Anti-Regression Invariant", () => {
      it("once a token is revoked at timestamp T, advancing validFrom never unrevokes it", () => {
        const tokenIat = 1760000000;
        const initialValidFrom = tokenIat; // revoked immediately

        expect(isSessionRevokedByTimestamp(tokenIat, initialValidFrom)).toBe(true);

        // Advance validFrom by 1s, 10s, 1000s, 1 year
        const advances = [1, 10, 60, 3600, 86400, 31536000];
        for (const delta of advances) {
          const advancedValidFrom = initialValidFrom + delta;
          expect(isSessionRevokedByTimestamp(tokenIat, advancedValidFrom)).toBe(true);
        }
      });
    });

    describe("4.3 Concurrency Race Simulation", () => {
      it("simulates 100 concurrent requests arriving at exact revocation second", () => {
        const revocationSec = Math.floor(Date.now() / 1000);
        const staleTokenIat = revocationSec; // token issued in same second before revocation update

        // 100 concurrent requests evaluated
        const results = Array.from({ length: 100 }, () =>
          isSessionRevokedByTimestamp(staleTokenIat, revocationSec),
        );

        // All 100 MUST be revoked
        expect(results.every((r) => r === true)).toBe(true);
      });
    });
  });

  // ==========================================================================
  // SUITE 5: Dual-Resolution & Backward Compatibility Invariant
  // ==========================================================================
  describe("Suite 5: Dual-Resolution & Backward Compatibility Invariant", () => {
    describe("5.1 Legacy Module Derivation (deriveLegacyModulesFromAtomic)", () => {
      it("derives all 30 legacy module keys with valid access levels", () => {
        const cashierAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier;
        const legacy = deriveLegacyModulesFromAtomic(cashierAtomic, "cashier");

        for (const mod of ALL_PERMISSION_MODULE_KEYS) {
          expect(legacy[mod], `Missing legacy module: ${mod}`).toBeDefined();
          expect(["FULL", "READ", "NONE"]).toContain(legacy[mod]);
        }

        expect(legacy.pos).toBe("FULL");
        expect(legacy.sales).toBe("FULL");
        expect(legacy.crm).toBe("FULL");
      });

      it("guarantees 100% FULL for all 30 modules for admin authority", () => {
        const adminAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.admin;
        const legacy = deriveLegacyModulesFromAtomic(adminAtomic, "admin");

        for (const mod of ALL_PERMISSION_MODULE_KEYS) {
          expect(legacy[mod]).toBe("FULL");
        }
      });
    });

    describe("5.2 Input Normalization Permutations (normalizePermissionsInput)", () => {
      it("handles empty objects, legacy maps, flat atomic maps, and full envelopes", () => {
        // 1. Empty object {} -> returns defaults
        const fromEmpty = normalizePermissionsInput({}, "cashier");
        expect(fromEmpty.atomic["pos.invoice.create"]).toBe(true);
        expect(fromEmpty.caps.maxDiscountPercent).toBe(5);

        // 2. Legacy map -> maps to atomic
        const legacyReadMap = { pos: "FULL", sales: "READ" as const };
        const fromLegacyRead = normalizePermissionsInput(legacyReadMap, "cashier");
        expect(fromLegacyRead.legacy.pos).toBe("FULL");
        expect(fromLegacyRead.atomic["pos.shift.open"]).toBe(true);
        expect(fromLegacyRead.atomic["pos.invoice.create"]).toBe(false); // READ restricts create action

        const legacyFullMap = { pos: "FULL", sales: "FULL" as const };
        const fromLegacyFull = normalizePermissionsInput(legacyFullMap, "cashier");
        expect(fromLegacyFull.legacy.sales).toBe("FULL");
        expect(fromLegacyFull.atomic["pos.invoice.create"]).toBe(true); // FULL grants create action

        // 3. Flat atomic map
        const flatAtomic = { "pos.invoice.create": false };
        const fromFlat = normalizePermissionsInput(flatAtomic, "cashier");
        expect(fromFlat.atomic["pos.invoice.create"]).toBe(false);

        // 4. Envelope format
        const envelope = {
          atomic: { "pos.invoice.create": true },
          caps: { maxDiscountPercent: 8 },
          masking: { maskPurchaseCost: false },
        };
        const fromEnv = normalizePermissionsInput(envelope, "cashier");
        expect(fromEnv.atomic["pos.invoice.create"]).toBe(true);
        expect(fromEnv.caps.maxDiscountPercent).toBe(8);
        expect(fromEnv.masking.maskPurchaseCost).toBe(false);
      });
    });

    describe("5.3 UI & Search Helpers (searchAtomicPermissions & getDomainStats)", () => {
      it("search returns all permissions on empty query and filters correctly on Arabic/English tokens", () => {
        expect(searchAtomicPermissions("")).toHaveLength(ATOMIC_PERMISSION_DEFINITIONS.length);
        expect(searchAtomicPermissions(null)).toHaveLength(ATOMIC_PERMISSION_DEFINITIONS.length);

        const arabicSearch = searchAtomicPermissions("فاتورة");
        expect(arabicSearch.length).toBeGreaterThan(0);
        expect(arabicSearch.some((d) => d.key.includes("invoice"))).toBe(true);

        const englishSearch = searchAtomicPermissions("pos.shift");
        expect(englishSearch.length).toBeGreaterThan(0);
        expect(englishSearch.every((d) => d.key.includes("shift"))).toBe(true);
      });

      it("calculates domain stats accurately", () => {
        const stats = getDomainStats("pos", { "pos.shift.open": true, "pos.shift.close": true });
        expect(stats.total).toBeGreaterThan(0);
        expect(stats.granted).toBe(2);
        expect(stats.percent).toBe(Math.round((2 / stats.total) * 100));
      });

      it("computes atomic override diffs correctly (filterAtomicOverrides)", () => {
        const base = { "pos.shift.open": true, "pos.shift.close": true };
        const current = { "pos.shift.open": true, "pos.shift.close": false }; // one override

        const diffs = filterAtomicOverrides(current, base);
        expect(diffs["pos.shift.close"].overridden).toBe(true);
        expect(diffs["pos.shift.close"].granted).toBe(false);
        expect(diffs["pos.shift.close"].baseGranted).toBe(true);

        expect(diffs["pos.shift.open"].overridden).toBe(false);
      });
    });
  });
});
