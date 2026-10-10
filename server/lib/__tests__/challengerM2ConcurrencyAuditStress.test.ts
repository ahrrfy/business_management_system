/**
 * server/lib/__tests__/challengerM2ConcurrencyAuditStress.test.ts
 *
 * Adversarial Challenger 2 Stress Suite for Milestone 2 (Database Schema & Persistence - R3):
 *  1. Migration Integrity & MySQL 8 DDL Collision Resistance:
 *     - Strict validation of DDL syntax in 0390_comprehensive_permission_matrix_caps.sql
 *     - Verification of journal ordering, non-empty chunks, timestamp monotonicity, and tag consistency
 *     - Verification of column mapping in drizzle/schema.ts
 *  2. Session Invalidation Stress & Concurrency:
 *     - userService.updateUser session revocation trigger on atomicPermissions / operationalCaps
 *     - roleService.updateRole multi-user cascade session invalidation for users sharing customRoleId
 *     - roleService.setRoleActive cascade invalidation on role activation/deactivation
 *     - Invariant verification of isSessionRevokedByTimestamp (boundary conditions, sub-second race window, fuzzing)
 *     - Preservation of active sessions when updating non-governance fields (e.g. phone, jobTitle)
 *  3. Audit Logging Fidelity & Data Integrity:
 *     - Exact capture of previous (oldValue) and updated (newValue) states in userRouter.update
 *     - Exact capture of previous (oldValue) and updated (newValue) states in roleRouter.update
 *     - Audit payload preservation in auditService.redactAuditValue (zero data corruption or unwanted truncation under 8KB cap)
 *     - Fuzzing audit value payload with 75+ full atomic keys and complex operational caps
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { roles, users } from "../../../drizzle/schema";
import { isSessionRevokedByTimestamp } from "../../auth/session";
import { redactAuditValue } from "../../services/auditService";
import * as auditService from "../../services/auditService";
import * as txModule from "../../services/tx";
import * as userService from "../../services/userService";
import * as roleService from "../../services/roleService";
import { userRouter } from "../../routers/userRouter";
import { roleRouter } from "../../routers/roleRouter";
import {
  ATOMIC_PERMISSION_DEFINITIONS,
  ALL_ATOMIC_PERMISSION_KEYS,
  type AtomicPermissionsMap,
  type OperationalCaps,
} from "@shared/atomicPermissions";

describe("Milestone 2 Challenger 2: Adversarial Stress & Verification Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Section 1: Migration Integrity & MySQL 8 DDL Collision Resistance
  // ==========================================================================
  describe("1. Migration Integrity & MySQL 8 DDL Collision Resistance", () => {
    const migrationRelativePath = "drizzle/migrations/0393_comprehensive_permission_matrix_caps.sql";
    const journalRelativePath = "drizzle/migrations/meta/_journal.json";

    it("1.1 Migration SQL file exists and consists of valid, non-empty MySQL 8 statements", () => {
      const fullPath = path.resolve(process.cwd(), migrationRelativePath);
      expect(existsSync(fullPath)).toBe(true);

      const content = readFileSync(fullPath, "utf8");
      expect(content.trim().length).toBeGreaterThan(0);

      // Split by Drizzle statement-breakpoint
      const chunks = content.split("--> statement-breakpoint").map((c) => c.trim()).filter(Boolean);
      expect(chunks.length).toBe(4);

      // MySQL 8 ALTER TABLE validation:
      // In MySQL 8, JSON columns cannot have default literal values (e.g. DEFAULT '{}'), so 'json NULL' is valid DDL.
      const expectedStatements = [
        "ALTER TABLE `roles` ADD COLUMN `atomicPermissions` json NULL;",
        "ALTER TABLE `roles` ADD COLUMN `operationalCaps` json NULL;",
        "ALTER TABLE `users` ADD COLUMN `atomicPermissions` json NULL;",
        "ALTER TABLE `users` ADD COLUMN `operationalCaps` json NULL;",
      ];

      for (let i = 0; i < expectedStatements.length; i++) {
        expect(chunks[i]).toBe(expectedStatements[i]);
      }
    });

    it("1.2 Does NOT contain illegal MySQL JSON default literal values", () => {
      const fullPath = path.resolve(process.cwd(), migrationRelativePath);
      const content = readFileSync(fullPath, "utf8");

      // MySQL 8 rejects ALTER TABLE ... ADD COLUMN col JSON NOT NULL DEFAULT '{}'
      expect(content).not.toMatch(/json\s+NOT\s+NULL\s+DEFAULT\s+'/i);
      expect(content).not.toMatch(/json\s+DEFAULT\s+'/i);
    });

    it("1.3 Migration journal entry 393 is valid, monotonic, and collision-resistant", () => {
      const fullPath = path.resolve(process.cwd(), journalRelativePath);
      expect(existsSync(fullPath)).toBe(true);

      const journal = JSON.parse(readFileSync(fullPath, "utf8"));
      expect(Array.isArray(journal.entries)).toBe(true);

      const entry = journal.entries.find(
        (e: { tag: string }) => e.tag === "0393_comprehensive_permission_matrix_caps",
      );
      expect(entry).toBeDefined();
      expect(entry.idx).toBe(393);
      expect(entry.version).toBe("5");
      expect(entry.breakpoints).toBe(true);

      const entryWhen = Number(entry.when);
      expect(entryWhen).toBeGreaterThan(0);

      // Adversarial check: verify that no prior migration entry has when >= entry.when
      const priorEntries = journal.entries.slice(0, journal.entries.indexOf(entry));
      for (const prior of priorEntries) {
        expect(Number(prior.when)).toBeLessThan(entryWhen);
      }

      // Verify no duplicate tags in journal
      const tags = journal.entries.map((e: { tag: string }) => e.tag);
      const uniqueTags = new Set(tags);
      expect(tags.length).toBe(uniqueTags.size);
    });

    it("1.4 Drizzle schema directly matches migration columns on users and roles tables", () => {
      expect(users.atomicPermissions.name).toBe("atomicPermissions");
      expect(users.atomicPermissions.dataType).toBe("json");
      expect(users.atomicPermissions.notNull).toBe(false);

      expect(users.operationalCaps.name).toBe("operationalCaps");
      expect(users.operationalCaps.dataType).toBe("json");
      expect(users.operationalCaps.notNull).toBe(false);

      expect(roles.atomicPermissions.name).toBe("atomicPermissions");
      expect(roles.atomicPermissions.dataType).toBe("json");
      expect(roles.atomicPermissions.notNull).toBe(false);

      expect(roles.operationalCaps.name).toBe("operationalCaps");
      expect(roles.operationalCaps.dataType).toBe("json");
      expect(roles.operationalCaps.notNull).toBe(false);
    });
  });

  // ==========================================================================
  // Section 2: Session Invalidation Stress Testing & Revocation Invariants
  // ==========================================================================
  describe("2. Session Invalidation Stress Testing & Revocation Invariants", () => {
    describe("2.1 isSessionRevokedByTimestamp Invariants", () => {
      it("Sub-second race condition: token issued at exactly validFromSec MUST be revoked", () => {
        const timestamp = 1788148800; // e.g. epoch in seconds
        // iat === validFromSec must return true to close the zero-second window
        expect(isSessionRevokedByTimestamp(timestamp, timestamp)).toBe(true);
      });

      it("Stale token: token issued before validFromSec MUST be revoked", () => {
        const validFromSec = 1788148800;
        expect(isSessionRevokedByTimestamp(validFromSec - 1, validFromSec)).toBe(true);
        expect(isSessionRevokedByTimestamp(validFromSec - 3600, validFromSec)).toBe(true);
      });

      it("Fresh token: token issued after validFromSec MUST be accepted", () => {
        const validFromSec = 1788148800;
        expect(isSessionRevokedByTimestamp(validFromSec + 1, validFromSec)).toBe(false);
        expect(isSessionRevokedByTimestamp(validFromSec + 100, validFromSec)).toBe(false);
      });

      it("Null/undefined/zero validFrom: token is NOT revoked", () => {
        const iat = 1788148800;
        expect(isSessionRevokedByTimestamp(iat, null)).toBe(false);
        expect(isSessionRevokedByTimestamp(iat, undefined)).toBe(false);
        expect(isSessionRevokedByTimestamp(iat, 0)).toBe(false);
      });

      it("Date object validFrom: handles Date instances accurately", () => {
        const validFromDate = new Date("2026-10-10T12:00:00.000Z");
        const validFromSec = Math.floor(validFromDate.getTime() / 1000);

        expect(isSessionRevokedByTimestamp(validFromSec - 10, validFromDate)).toBe(true);
        expect(isSessionRevokedByTimestamp(validFromSec, validFromDate)).toBe(true);
        expect(isSessionRevokedByTimestamp(validFromSec + 1, validFromDate)).toBe(false);
      });

      it("Fuzzing timestamp invariants across 1,000 synthetic test cases", () => {
        const base = 1700000000;
        for (let i = 0; i < 1000; i++) {
          const delta = Math.floor(Math.random() * 2000) - 1000; // -1000 to +1000
          const iat = base + delta;
          const validFrom = base;
          const isRevoked = isSessionRevokedByTimestamp(iat, validFrom);
          if (iat <= validFrom) {
            expect(isRevoked).toBe(true);
          } else {
            expect(isRevoked).toBe(false);
          }
        }
      });
    });

    describe("2.2 userService.updateUser Session Invalidation Trigger", () => {
      it("Updating atomicPermissions triggers patch.sessionsValidFrom = new Date()", async () => {
        let capturedPatch: any = null;
        const fakeTx = {
          select: () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [{ id: 42, role: "cashier", isOwner: false, email: "u@t.local" }],
                }),
              }),
            }),
          }),
          update: () => ({
            set: (patch: any) => {
              capturedPatch = patch;
              return {
                where: async () => {},
              };
            },
          }),
        };

        const beforeNow = Date.now();
        vi.spyOn(txModule, "withTx").mockImplementation(async (cb: any) => cb(fakeTx));

        const res = await userService.updateUser(
          {
            userId: 42,
            atomicPermissions: { "pos.invoice.create": false },
          },
          { userId: 1, role: "admin", isOwner: true },
        );

        expect(res.changed).toBe(true);
        expect(capturedPatch).toBeDefined();
        expect(capturedPatch.atomicPermissions).toEqual({ "pos.invoice.create": false });
        expect(capturedPatch.sessionsValidFrom).toBeInstanceOf(Date);
        expect(capturedPatch.sessionsValidFrom.getTime()).toBeGreaterThanOrEqual(beforeNow);
      });

      it("Updating operationalCaps triggers patch.sessionsValidFrom = new Date()", async () => {
        let capturedPatch: any = null;
        const fakeTx = {
          select: () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [{ id: 43, role: "cashier", isOwner: false, email: "u2@t.local" }],
                }),
              }),
            }),
          }),
          update: () => ({
            set: (patch: any) => {
              capturedPatch = patch;
              return {
                where: async () => {},
              };
            },
          }),
        };

        const beforeNow = Date.now();
        vi.spyOn(txModule, "withTx").mockImplementation(async (cb: any) => cb(fakeTx));

        const res = await userService.updateUser(
          {
            userId: 43,
            operationalCaps: { maxDiscountPercent: 5 },
          },
          { userId: 1, role: "admin", isOwner: true },
        );

        expect(res.changed).toBe(true);
        expect(capturedPatch).toBeDefined();
        expect(capturedPatch.operationalCaps).toEqual({ maxDiscountPercent: 5 });
        expect(capturedPatch.sessionsValidFrom).toBeInstanceOf(Date);
        expect(capturedPatch.sessionsValidFrom.getTime()).toBeGreaterThanOrEqual(beforeNow);
      });

      it("Updating null atomicPermissions/operationalCaps (clearing overrides) also invalidates sessions", async () => {
        let capturedPatch: any = null;
        const fakeTx = {
          select: () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [
                    {
                      id: 44,
                      role: "cashier",
                      isOwner: false,
                      email: "u3@t.local",
                      atomicPermissions: { "pos.sale.view": true },
                      operationalCaps: { maxDiscountPercent: 20 },
                    },
                  ],
                }),
              }),
            }),
          }),
          update: () => ({
            set: (patch: any) => {
              capturedPatch = patch;
              return {
                where: async () => {},
              };
            },
          }),
        };

        vi.spyOn(txModule, "withTx").mockImplementation(async (cb: any) => cb(fakeTx));

        const res = await userService.updateUser(
          {
            userId: 44,
            atomicPermissions: null,
            operationalCaps: null,
          },
          { userId: 1, role: "admin", isOwner: true },
        );

        expect(res.changed).toBe(true);
        expect(capturedPatch.atomicPermissions).toBeNull();
        expect(capturedPatch.operationalCaps).toBeNull();
        expect(capturedPatch.sessionsValidFrom).toBeInstanceOf(Date);
      });

      it("Updating ONLY non-governance fields (e.g. phone) does NOT invalidate user sessions", async () => {
        let capturedPatch: any = null;
        const fakeTx = {
          select: () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [{ id: 45, role: "cashier", isOwner: false, email: "u4@t.local" }],
                }),
              }),
            }),
          }),
          update: () => ({
            set: (patch: any) => {
              capturedPatch = patch;
              return {
                where: async () => {},
              };
            },
          }),
        };

        vi.spyOn(txModule, "withTx").mockImplementation(async (cb: any) => cb(fakeTx));

        const res = await userService.updateUser(
          {
            userId: 45,
            phone: "07700000000",
            jobTitle: "محاسب متدرب",
          },
          { userId: 1, role: "admin", isOwner: true },
        );

        expect(res.changed).toBe(true);
        expect(capturedPatch.phone).toBe("07700000000");
        expect(capturedPatch.jobTitle).toBe("محاسب متدرب");
        // Must NOT invalidate session for benign personal info edits
        expect(capturedPatch.sessionsValidFrom).toBeUndefined();
      });
    });

    describe("2.3 roleService.updateRole & setRoleActive Multi-User Cascade Invalidation", () => {
      it("updateRole invalidates sessions of ALL users assigned to that custom role", async () => {
        const updateCalls: Array<{ table: any; patch: any; where: any }> = [];
        const fakeTx = {
          select: () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [
                    { id: 77, label: "كاشير فرعي", baseRole: "cashier", isSystem: false },
                  ],
                }),
              }),
            }),
          }),
          update: (table: any) => ({
            set: (patch: any) => ({
              where: async (where: any) => {
                updateCalls.push({ table, patch, where });
              },
            }),
          }),
        };

        vi.spyOn(txModule, "withTx").mockImplementation(async (cb: any) => cb(fakeTx));

        const beforeNow = Date.now();
        const res = await roleService.updateRole(
          {
            id: 77,
            atomicPermissions: { "pos.drawer.open": true },
            operationalCaps: { maxDiscountPercent: 12 },
          },
          { userId: 1, branchId: 1, role: "admin" },
        );

        expect(res.changed).toBe(true);
        expect(updateCalls.length).toBe(2);

        // 1st update: on roles table
        expect(updateCalls[0].table).toBe(roles);
        expect(updateCalls[0].patch.atomicPermissions).toEqual({ "pos.drawer.open": true });
        expect(updateCalls[0].patch.operationalCaps).toEqual({ maxDiscountPercent: 12 });

        // 2nd update: on users table cascading sessionsValidFrom = new Date() where customRoleId == 77
        expect(updateCalls[1].table).toBe(users);
        expect(updateCalls[1].patch.sessionsValidFrom).toBeInstanceOf(Date);
        expect(updateCalls[1].patch.sessionsValidFrom.getTime()).toBeGreaterThanOrEqual(beforeNow);
      });

      it("setRoleActive invalidates sessions of ALL users assigned to that custom role", async () => {
        const updateCalls: Array<{ table: any; patch: any }> = [];
        const fakeTx = {
          select: () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [{ id: 88, label: "دور تجريبي" }],
                }),
              }),
            }),
          }),
          update: (table: any) => ({
            set: (patch: any) => ({
              where: async () => {
                updateCalls.push({ table, patch });
              },
            }),
          }),
        };

        vi.spyOn(txModule, "withTx").mockImplementation(async (cb: any) => cb(fakeTx));

        await roleService.setRoleActive(88, true, { userId: 1, branchId: 1, role: "admin" });

        expect(updateCalls.length).toBe(2);
        expect(updateCalls[0].table).toBe(roles);
        expect(updateCalls[0].patch.isActive).toBe(true);

        expect(updateCalls[1].table).toBe(users);
        expect(updateCalls[1].patch.sessionsValidFrom).toBeInstanceOf(Date);
      });
    });
  });

  // ==========================================================================
  // Section 3: Audit Logging Fidelity (Exact State Capture in Routers)
  // ==========================================================================
  describe("3. Audit Logging Fidelity & Exact State Capture", () => {
    const adminCtx = {
      user: {
        id: 1,
        role: "admin",
        branchId: 1,
        isOwner: true,
      },
      req: {
        ip: "127.0.0.1",
        headers: {},
      },
    } as any;

    describe("3.1 userRouter.update Audit Diff Capture", () => {
      it("Captures exact oldValue and newValue for atomicPermissions and operationalCaps", async () => {
        const mockBeforeUser = {
          id: 50,
          name: "أحمد الموظف",
          email: "ahmed@alroya.local",
          username: "ahmed",
          role: "cashier",
          branchId: 1,
          customRoleId: null,
          isOwner: false,
          permissionsOverride: null,
          atomicPermissions: { "pos.invoice.create": true },
          operationalCaps: { maxDiscountPercent: 10, maxDiscountAmountIqd: "50000.00" },
        };

        vi.spyOn(userService, "getUser").mockResolvedValue(mockBeforeUser as any);
        vi.spyOn(userService, "updateUser").mockResolvedValue({ userId: 50, changed: true });
        const logAuditSpy = vi.spyOn(auditService, "logAudit").mockResolvedValue(true);

        const caller = userRouter.createCaller(adminCtx);

        const updateInput = {
          userId: 50,
          atomicPermissions: { "pos.invoice.create": false, "pos.drawer.open": true },
          operationalCaps: { maxDiscountPercent: 20, maxDiscountAmountIqd: "100000.00" },
        };

        await caller.update(updateInput);

        // Find the specific specialized audit record for user.update
        const userUpdateAuditCall = logAuditSpy.mock.calls.find(
          ([, data]) => data.action === "user.update",
        );
        expect(userUpdateAuditCall).toBeDefined();

        const [source, auditData] = userUpdateAuditCall!;
        expect(source.user?.id).toBe(adminCtx.user.id);
        expect(auditData.entityType).toBe("user");
        expect(auditData.entityId).toBe(50);

        // Verify oldValue contains previous atomicPermissions & operationalCaps exactly
        const oldVal = auditData.oldValue as any;
        expect(oldVal.atomicPermissions).toEqual({ "pos.invoice.create": true });
        expect(oldVal.operationalCaps).toEqual({
          maxDiscountPercent: 10,
          maxDiscountAmountIqd: "50000.00",
        });

        // Verify newValue contains incoming atomicPermissions & operationalCaps exactly
        const newVal = auditData.newValue as any;
        expect(newVal.atomicPermissions).toEqual({
          "pos.invoice.create": false,
          "pos.drawer.open": true,
        });
        expect(newVal.operationalCaps).toEqual({
          maxDiscountPercent: 20,
          maxDiscountAmountIqd: "100000.00",
        });
      });

      it("Handles before state having null atomicPermissions and operationalCaps", async () => {
        const mockBeforeUser = {
          id: 51,
          name: "سارة كاشير",
          email: "sara@alroya.local",
          username: "sara",
          role: "cashier",
          branchId: 2,
          customRoleId: null,
          isOwner: false,
          permissionsOverride: null,
          atomicPermissions: null,
          operationalCaps: null,
        };

        vi.spyOn(userService, "getUser").mockResolvedValue(mockBeforeUser as any);
        vi.spyOn(userService, "updateUser").mockResolvedValue({ userId: 51, changed: true });
        const logAuditSpy = vi.spyOn(auditService, "logAudit").mockResolvedValue(true);

        const caller = userRouter.createCaller(adminCtx);

        await caller.update({
          userId: 51,
          atomicPermissions: { "pos.shift.open": true },
        });

        const userUpdateAuditCall = logAuditSpy.mock.calls.find(
          ([, data]) => data.action === "user.update",
        );
        expect(userUpdateAuditCall).toBeDefined();

        const auditData = userUpdateAuditCall![1];
        const oldVal = auditData.oldValue as any;
        expect(oldVal.atomicPermissions).toBeNull();
        expect(oldVal.operationalCaps).toBeNull();

        const newVal = auditData.newValue as any;
        expect(newVal.atomicPermissions).toEqual({ "pos.shift.open": true });
      });
    });

    describe("3.2 roleRouter.update Audit Diff Capture", () => {
      it("Captures exact oldValue and newValue for atomicPermissions and operationalCaps on role edit", async () => {
        const mockBeforeRole = {
          id: 15,
          key: "custom_cashier",
          label: "كاشير صالة",
          baseRole: "cashier",
          permissions: { pos: "FULL" },
          atomicPermissions: { "pos.invoice.create": true },
          operationalCaps: { maxDiscountPercent: 5 },
        };

        vi.spyOn(roleService, "getRole").mockResolvedValue(mockBeforeRole as any);
        vi.spyOn(roleService, "updateRole").mockResolvedValue({ id: 15, changed: true });
        const logAuditSpy = vi.spyOn(auditService, "logAudit").mockResolvedValue(true);

        const caller = roleRouter.createCaller(adminCtx);

        const updateInput = {
          id: 15,
          label: "كاشير صالة متقدم",
          atomicPermissions: { "pos.invoice.create": true, "pos.return.create": true },
          operationalCaps: { maxDiscountPercent: 15 },
        };

        await caller.update(updateInput);

        const roleUpdateAuditCall = logAuditSpy.mock.calls.find(
          ([, data]) => data.action === "role.update",
        );
        expect(roleUpdateAuditCall).toBeDefined();

        const auditData = roleUpdateAuditCall![1];
        expect(auditData.action).toBe("role.update");
        expect(auditData.entityType).toBe("role");
        expect(auditData.entityId).toBe(15);

        // Verify oldValue
        const oldVal = auditData.oldValue as any;
        expect(oldVal.atomicPermissions).toEqual({ "pos.invoice.create": true });
        expect(oldVal.operationalCaps).toEqual({ maxDiscountPercent: 5 });

        // Verify newValue
        const newVal = auditData.newValue as any;
        expect(newVal.atomicPermissions).toEqual({
          "pos.invoice.create": true,
          "pos.return.create": true,
        });
        expect(newVal.operationalCaps).toEqual({ maxDiscountPercent: 15 });
      });
    });

    describe("3.3 auditService.redactAuditValue Preservation & Sizing Stress", () => {
      it("Preserves a complete full catalog atomic permissions map without modification or truncation", () => {
        // Construct full map of all 75+ keys
        const fullAtomicMap: AtomicPermissionsMap = {};
        for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
          fullAtomicMap[def.key] = true;
        }

        expect(Object.keys(fullAtomicMap).length).toBeGreaterThanOrEqual(75);

        const redacted = redactAuditValue(fullAtomicMap);
        expect(redacted).toEqual(fullAtomicMap);

        // Verify payload size is well below MAX_AUDIT_VALUE_BYTES (8KB)
        const serializedBytes = Buffer.byteLength(JSON.stringify(redacted), "utf8");
        expect(serializedBytes).toBeLessThan(8192);
        expect(serializedBytes).toBeGreaterThan(1500); // typically ~2.5KB
      });

      it("Preserves full OperationalCaps structure without modification or truncation", () => {
        const fullCaps: OperationalCaps = {
          maxDiscountPercent: 25,
          maxDiscountAmountIqd: "100000.00",
          maxCreditSaleLimitIqd: "1000000.00",
          maxPaymentVoucherAmountIqd: "5000000.00",
          maxExpenseVoucherAmountIqd: "2500000.00",
          maxRefundAmountIqd: "50000.00",
        };

        const redacted = redactAuditValue(fullCaps);
        expect(redacted).toEqual(fullCaps);
      });

      it("Safely protects against malicious oversized values exceeding 8KB", () => {
        const hugeMap: Record<string, boolean> = {};
        // Generate 500 keys to exceed 8KB
        for (let i = 0; i < 500; i++) {
          hugeMap[`pos.custom_domain_test_key_oversized_stress_padding_${i}.action`] = true;
        }

        const serializedRaw = JSON.stringify(hugeMap);
        const rawBytes = Buffer.byteLength(serializedRaw, "utf8");
        expect(rawBytes).toBeGreaterThan(8192);

        const redacted = redactAuditValue(hugeMap) as any;
        expect(redacted._truncated).toBe(true);
        expect(redacted._originalBytes).toBe(rawBytes);
        expect(typeof redacted._preview).toBe("string");
      });
    });
  });
});
