import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { canCrossBranches, resolveActorBranchId } from "../branchAuthority";
import { PERM_OVERRIDE, VALID_MODULE_KEYS } from "../../routers/userRouter";
import {
  isLegacySessionAllowed,
  validateUserForSession,
  isSessionRevokedByTimestamp,
} from "../../auth/session";

describe("Milestone 2 Iteration 2 - Adversarial Challenger Stress Suite", () => {
  // ─── 1. resolveActorBranchId Stress Tests ─────────────────────────────
  describe("1. resolveActorBranchId - Confinement & Input Fuzzing", () => {
    it("Cashier cannot bypass confinement by sending negative inputBranchId", () => {
      const cashierCtx = { user: { role: "cashier", isOwner: false, branchId: 1 } };
      expect(resolveActorBranchId(cashierCtx, -1)).toBe(1);
      expect(resolveActorBranchId(cashierCtx, -99999)).toBe(1);
    });

    it("Cashier cannot bypass confinement by sending float inputBranchId", () => {
      const cashierCtx = { user: { role: "cashier", isOwner: false, branchId: 1 } };
      expect(resolveActorBranchId(cashierCtx, 2.5)).toBe(1);
      expect(resolveActorBranchId(cashierCtx, 99.99)).toBe(1);
    });

    it("Cashier cannot bypass confinement by sending string or arbitrary inputBranchId", () => {
      const cashierCtx = { user: { role: "cashier", isOwner: false, branchId: 1 } };
      expect(resolveActorBranchId(cashierCtx, "2" as any)).toBe(1);
      expect(resolveActorBranchId(cashierCtx, "admin_branch" as any)).toBe(1);
    });

    it("Cashier cannot bypass confinement by sending large branch IDs", () => {
      const cashierCtx = { user: { role: "cashier", isOwner: false, branchId: 1 } };
      expect(resolveActorBranchId(cashierCtx, 999999999)).toBe(1);
    });

    it("Cashier with null branchId throws FORBIDDEN even when sending inputBranchId", () => {
      const unassignedCashier = { user: { role: "cashier", isOwner: false, branchId: null } };
      expect(() => resolveActorBranchId(unassignedCashier, 1)).toThrowError(TRPCError);
      try {
        resolveActorBranchId(unassignedCashier, 1);
      } catch (err: any) {
        expect(err.code).toBe("FORBIDDEN");
        expect(err.message).toContain("لا فرع مُسنَد لهذا المستخدم");
      }
    });

    it("Non-elevated roles (warehouse, accountant, purchasing, etc.) are strictly confined", () => {
      const roles = ["warehouse", "accountant", "purchasing", "sales_rep", "courier", "user"];
      for (const role of roles) {
        const ctx = { user: { role, isOwner: false, branchId: 3 } };
        expect(resolveActorBranchId(ctx, 5)).toBe(3);
        expect(resolveActorBranchId(ctx, -1)).toBe(3);
        expect(resolveActorBranchId(ctx, 0)).toBe(3);
      }
    });

    it("Branch manager without isOwner is strictly confined to assigned branch", () => {
      const managerCtx = { user: { role: "manager", isOwner: false, branchId: 2 } };
      expect(resolveActorBranchId(managerCtx, 1)).toBe(2);
      expect(resolveActorBranchId(managerCtx, 99)).toBe(2);
    });

    it("Admin with branchId = 1 successfully gets branch 2 when passing inputBranchId = 2", () => {
      const adminCtx = { user: { role: "admin", isOwner: false, branchId: 1 } };
      expect(resolveActorBranchId(adminCtx, 2)).toBe(2);
    });

    it("Admin passing inputBranchId = 0 throws BAD_REQUEST", () => {
      const adminCtx = { user: { role: "admin", isOwner: false, branchId: 1 } };
      expect(() => resolveActorBranchId(adminCtx, 0)).toThrowError(TRPCError);
      try {
        resolveActorBranchId(adminCtx, 0);
      } catch (err: any) {
        expect(err.code).toBe("BAD_REQUEST");
        expect(err.message).toContain("معرف الفرع غير صالح");
      }
    });

    it("Admin passing inputBranchId = -1 throws BAD_REQUEST", () => {
      const adminCtx = { user: { role: "admin", isOwner: false, branchId: 1 } };
      expect(() => resolveActorBranchId(adminCtx, -1)).toThrowError(TRPCError);
      try {
        resolveActorBranchId(adminCtx, -1);
      } catch (err: any) {
        expect(err.code).toBe("BAD_REQUEST");
        expect(err.message).toContain("معرف الفرع غير صالح");
      }
    });

    it("Admin passing inputBranchId = NaN throws BAD_REQUEST", () => {
      const adminCtx = { user: { role: "admin", isOwner: false, branchId: 1 } };
      expect(() => resolveActorBranchId(adminCtx, NaN)).toThrowError(TRPCError);
      try {
        resolveActorBranchId(adminCtx, NaN);
      } catch (err: any) {
        expect(err.code).toBe("BAD_REQUEST");
        expect(err.message).toContain("معرف الفرع غير صالح");
      }
    });

    it("Admin passing inputBranchId = null falls back to assigned branch or throws BAD_REQUEST", () => {
      const adminWithBranch = { user: { role: "admin", isOwner: false, branchId: 1 } };
      expect(resolveActorBranchId(adminWithBranch, null)).toBe(1);

      const adminWithoutBranch = { user: { role: "admin", isOwner: false, branchId: null } };
      expect(() => resolveActorBranchId(adminWithoutBranch, null)).toThrowError(TRPCError);
      try {
        resolveActorBranchId(adminWithoutBranch, null);
      } catch (err: any) {
        expect(err.code).toBe("BAD_REQUEST");
        expect(err.message).toContain("يجب تحديد الفرع (branchId)");
      }
    });

    it("Admin passing inputBranchId = undefined falls back to assigned branch or throws BAD_REQUEST", () => {
      const adminWithBranch = { user: { role: "admin", isOwner: false, branchId: 1 } };
      expect(resolveActorBranchId(adminWithBranch, undefined)).toBe(1);

      const adminWithoutBranch = { user: { role: "admin", isOwner: false, branchId: null } };
      expect(() => resolveActorBranchId(adminWithoutBranch, undefined)).toThrowError(TRPCError);
      try {
        resolveActorBranchId(adminWithoutBranch, undefined);
      } catch (err: any) {
        expect(err.code).toBe("BAD_REQUEST");
        expect(err.message).toContain("يجب تحديد الفرع (branchId)");
      }
    });
  });

  // ─── 2. PERM_OVERRIDE Injection & Module Restriction Stress Tests ─────
  describe("2. PERM_OVERRIDE - Prototype Pollution & Module Injection", () => {
    it("Demonstrates __proto__ behavior and rejects prototype pollution", () => {
      // In V8, JSON.parse('{"__proto__": "FULL"}') creates an object with own property __proto__.
      // Zod's z.record() defensively drops/strips __proto__ during parsing, resulting in data: {}.
      // Thus, __proto__ never enters permissionsOverride and cannot pollute the prototype or grant access.
      const parsedJson = JSON.parse('{"__proto__": "FULL"}');
      const result = PERM_OVERRIDE.safeParse(parsedJson);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
      expect((Object.prototype as any).FULL).toBeUndefined();

      // If an unauthorized module is included alongside __proto__, it is strictly rejected:
      const maliciousPayload = JSON.parse('{"__proto__": "FULL", "unauthorized_module": "FULL"}');
      const maliciousResult = PERM_OVERRIDE.safeParse(maliciousPayload);
      expect(maliciousResult.success).toBe(false);
    });

    it("Rejects special properties (constructor, toString, valueOf)", () => {
      const specialKeys = ["constructor", "toString", "valueOf", "hasOwnProperty", "__defineGetter__"];
      for (const key of specialKeys) {
        const payload = JSON.parse(`{"${key}": "FULL"}`);
        const result = PERM_OVERRIDE.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.error.issues.find((i) => i.path.includes(key));
          expect(issue).toBeDefined();
        }
      }
    });

    it("Rejects uppercase and mixed-case module keys", () => {
      const uppercaseKeys = ["POS", "SALES", "Inventory", "CrM", "PURCHASES"];
      for (const key of uppercaseKeys) {
        const payload = { [key]: "FULL" };
        const result = PERM_OVERRIDE.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });

    it("Rejects module keys with leading, trailing, or internal whitespace", () => {
      const whitespaceKeys = [" pos", "pos ", " pos ", "sales\n", "\tsales", "inven tory"];
      for (const key of whitespaceKeys) {
        const payload = { [key]: "FULL" };
        const result = PERM_OVERRIDE.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });

    it("Rejects arbitrary injection keys not present in ALL_PERMISSION_MODULE_KEYS", () => {
      const arbitraryKeys = ["admin", "root", "superuser", "sudo", "*", "drop_table", "../../../etc/passwd"];
      for (const key of arbitraryKeys) {
        const payload = { [key]: "FULL" };
        const result = PERM_OVERRIDE.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });

    it("Accepts valid permission overrides containing genuine module keys", () => {
      const validPayload = {
        pos: "FULL",
        sales: "READ",
        inventory: "NONE",
        treasury: "READ",
      };
      const result = PERM_OVERRIDE.safeParse(validPayload);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(validPayload);
    });

    it("Rejects invalid access levels even on valid module keys", () => {
      const invalidLevels = ["ADMIN", "WRITE", "full", "read", "none", "1", 1, true, null];
      for (const level of invalidLevels) {
        const payload = { pos: level };
        const result = PERM_OVERRIDE.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });
  });

  // ─── 3. Session Validators Stress Tests ───────────────────────────────
  describe("3. Session Validators - Revocation & Token Version", () => {
    it("isSessionRevokedByTimestamp strictly revokes tokens with iat <= validFromSec", () => {
      // Exact second match (AUTH-02 atomic second closure)
      expect(isSessionRevokedByTimestamp(1000, 1000)).toBe(true);

      // Prior issued token
      expect(isSessionRevokedByTimestamp(999, 1000)).toBe(true);

      // Subsequent issued token (re-issued cookie after password change: validFromSec + 1)
      expect(isSessionRevokedByTimestamp(1001, 1000)).toBe(false);
    });

    it("isSessionRevokedByTimestamp handles Date object and ISO string inputs correctly", () => {
      const validFromDate = new Date("2026-09-29T12:00:00.000Z");
      const validFromSec = Math.floor(validFromDate.getTime() / 1000);

      expect(isSessionRevokedByTimestamp(validFromSec - 10, validFromDate)).toBe(true);
      expect(isSessionRevokedByTimestamp(validFromSec, validFromDate)).toBe(true);
      expect(isSessionRevokedByTimestamp(validFromSec + 1, validFromDate)).toBe(false);

      expect(isSessionRevokedByTimestamp(validFromSec - 5, "2026-09-29T12:00:00.000Z")).toBe(true);
      expect(isSessionRevokedByTimestamp(validFromSec + 5, "2026-09-29T12:00:00.000Z")).toBe(false);
    });

    it("isSessionRevokedByTimestamp returns false when validFrom is null, undefined, or 0", () => {
      expect(isSessionRevokedByTimestamp(1000, null)).toBe(false);
      expect(isSessionRevokedByTimestamp(1000, undefined)).toBe(false);
      expect(isSessionRevokedByTimestamp(1000, 0)).toBe(false);
    });

    it("validateUserForSession rejects inactive, suspended, or expired users", () => {
      const now = Date.now();

      // Inactive
      expect(validateUserForSession({ isActive: false })).toBe(false);
      expect(validateUserForSession({ isActive: null })).toBe(false);

      // Suspended / non-ACTIVE status
      expect(validateUserForSession({ isActive: true, status: "SUSPENDED" })).toBe(false);
      expect(validateUserForSession({ isActive: true, status: "INACTIVE" })).toBe(false);

      // Expired access
      expect(validateUserForSession({ isActive: true, accessExpiresAt: new Date(now - 1000) }, null, now)).toBe(false);
      expect(validateUserForSession({ isActive: true, accessExpiresAt: new Date(now + 60000) }, null, now)).toBe(true);
    });

    it("validateUserForSession enforces tokenVersion matching when both user and token specify it", () => {
      // Mismatched tokenVersion
      expect(validateUserForSession({ isActive: true, tokenVersion: 3 }, 2)).toBe(false);
      expect(validateUserForSession({ isActive: true, tokenVersion: 1 }, 2)).toBe(false);

      // Matched tokenVersion
      expect(validateUserForSession({ isActive: true, tokenVersion: 3 }, 3)).toBe(true);

      // Token has no version, user has version
      expect(validateUserForSession({ isActive: true, tokenVersion: 3 }, null)).toBe(true);
      expect(validateUserForSession({ isActive: true, tokenVersion: 3 }, undefined)).toBe(true);

      // User has no version, token has version
      expect(validateUserForSession({ isActive: true, tokenVersion: null }, 3)).toBe(true);
    });

    it("Revocation via sessionsValidFrom cannot be bypassed even if tokenVersion matches", () => {
      const user = {
        id: 1,
        isActive: true,
        status: "ACTIVE",
        tokenVersion: 2,
        sessionsValidFrom: new Date("2026-09-29T12:00:00.000Z"),
      };
      const validFromSec = Math.floor(user.sessionsValidFrom.getTime() / 1000);

      // An old token with iat <= validFromSec and matching tokenVersion = 2
      const oldSession = { uid: 1, iat: validFromSec - 10, tokenVersion: 2 };

      // 1) validateUserForSession alone passes:
      expect(validateUserForSession(user, oldSession.tokenVersion)).toBe(true);

      // 2) BUT isSessionRevokedByTimestamp catches it:
      expect(isSessionRevokedByTimestamp(oldSession.iat, validFromSec)).toBe(true);
      // Demonstrating that session revocation is independent of and cannot be bypassed by tokenVersion!
    });

    it("Legacy session gating: isLegacySessionAllowed respects ALLOW_LEGACY_SESSIONS and DISABLE_LEGACY_SESSIONS", () => {
      // Modern session with sid always allowed
      expect(isLegacySessionAllowed(true, { ALLOW_LEGACY_SESSIONS: "false" })).toBe(true);
      expect(isLegacySessionAllowed(true, { DISABLE_LEGACY_SESSIONS: "true" })).toBe(true);

      // Legacy session without sid
      expect(isLegacySessionAllowed(false, {})).toBe(true);
      expect(isLegacySessionAllowed(false, { ALLOW_LEGACY_SESSIONS: "true" })).toBe(true);
      expect(isLegacySessionAllowed(false, { ALLOW_LEGACY_SESSIONS: "false" })).toBe(false);
      expect(isLegacySessionAllowed(false, { DISABLE_LEGACY_SESSIONS: "true" })).toBe(false);
    });
  });
});
