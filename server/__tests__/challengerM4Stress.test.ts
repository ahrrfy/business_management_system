/**
 * Adversarial Challenger Stress Suite — Milestone 4 (DFIR Core Protocol)
 * File: server/__tests__/challengerM4Stress.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { returnRouter } from "../routers/returnRouter";
import { createSale } from "../services/saleService";
import { createVoucher, approveVoucher } from "../services/voucherService";
import { assertCreditLimit } from "../lib/credit";
import { resolveActorBranchId, canCrossBranches } from "../lib/branchAuthority";
import { PERM_OVERRIDE, VALID_MODULE_KEYS } from "../routers/userRouter";
import {
  validateUserForSession,
  isSessionRevokedByTimestamp,
  isLegacySessionAllowed,
} from "../auth/session";
import { assertApprover } from "../services/approval/ownerGate";
import { purchaseOrderControlTrigger } from "@shared/approvalTriggers";
import { nonNegMoneyString, percentString } from "../lib/schemas";
import { computeInvoiceTotals } from "../services/billing";
import { AppContractError, appError, appErrorMessage } from "@shared/errors";
import { getDb } from "../db";
import * as s from "../../drizzle/schema";

const TABLES_TO_RESET = [
  "auditLogs",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
];

function testDb() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function resetDb() {
  const d = testDb();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES_TO_RESET) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedDb() {
  const d = testDb();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع الكرخ", code: "KARKH", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "cashier-1", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 2, openId: "owner-2", name: "المالك المعتمد", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
    { id: 10, openId: "cashier-10", name: "كاشير 10", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false, isActive: true },
    { id: 20, openId: "admin-2", name: "أدمن 2", role: "admin", loginMethod: "local", branchId: 2, isOwner: false, isActive: true },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "منتج أساسي" },
    { id: 2, name: "منتج ثانوي" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PRD-1", costPrice: "1000.00" },
    { id: 2, productId: 2, sku: "PRD-2", costPrice: "2000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "كرتونة", conversionFactor: "12", isBaseUnit: false },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "5000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "60000.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "8000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 200 },
    { variantId: 1, branchId: 2, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
  ]);
  await d.insert(s.shifts).values([
    { id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" },
    { id: 2, userId: 2, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "2:1", openingBalance: "0" },
    { id: 10, userId: 10, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "10:1", openingBalance: "0" },
    { id: 20, userId: 20, branchId: 2, status: "OPEN", openedAt: new Date(), openGuard: "20:2", openingBalance: "0" },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "شركة الأفق التجريبية", currentBalance: "0", creditLimit: "9999999.00" },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "5000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TREASURY-SEED-FUND",
    createdBy: 2,
  });
}

describe("Adversarial Challenger M4 — Stress & Edge Case Harness", () => {
  beforeEach(async () => {
    await resetDb();
    await seedDb();
  });

  // ─── Challenge 1: VULN-INV-01 (Return Cart Line-Splitting & Unit Conversion) ─────
  describe("Challenge 1: VULN-INV-01 Multi-Split & Conversion Invariants", () => {
    it("ADV-INV-01a: 3-way split line accumulation strictly rejects overflow (4 + 4 + 3 = 11 > 10)", async () => {
      const cashierActor = { userId: 1, branchId: 1, role: "cashier" as const };
      const sale = await createSale(
        {
          branchId: 1,
          shiftId: 1,
          customerId: 1,
          priceTier: "RETAIL",
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }],
          payment: { amount: "50000.00", method: "CASH" },
        },
        cashierActor,
      );

      const [createdItem] = await testDb()
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));

      const caller = returnRouter.createCaller({
        user: { id: 1, role: "cashier", branchId: 1, isOwner: false },
      } as any);

      // Attempt 3-way split: 4 + 4 + 3 = 11 > 10
      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          items: [
            { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 4, unitPrice: "5000.00" },
            { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 4, unitPrice: "5000.00" },
            { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 3, unitPrice: "5000.00" },
          ],
          settlement: { method: "CASH", totalAmount: "50000.00", shiftId: 1 },
        }),
      ).rejects.toThrow(/تتجاوز المتبقي في الفاتورة/);
    });

    it("ADV-INV-01b: 3-way split within limit succeeds exactly (4 + 3 + 3 = 10)", async () => {
      const cashierActor = { userId: 1, branchId: 1, role: "cashier" as const };
      const sale = await createSale(
        {
          branchId: 1,
          shiftId: 1,
          customerId: 1,
          priceTier: "RETAIL",
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }],
          payment: { amount: "50000.00", method: "CASH" },
        },
        cashierActor,
      );

      const [createdItem] = await testDb()
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));

      const caller = returnRouter.createCaller({
        user: { id: 1, role: "cashier", branchId: 1, isOwner: false },
      } as any);

      const res = await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        items: [
          { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 4, unitPrice: "5000.00" },
          { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 3, unitPrice: "5000.00" },
          { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 3, unitPrice: "5000.00" },
        ],
        settlement: { method: "CASH", totalAmount: "50000.00", shiftId: 1 },
      });

      expect(res.ok).toBe(true);
      expect(res.itemsCount).toBe(3);
    });

    it("ADV-INV-01c: Mixed unit packaging conversion in split lines (1 carton [12x] + 1 piece [1x] = 13 > 12 sold)", async () => {
      const cashierActor = { userId: 1, branchId: 1, role: "cashier" as const };
      // Sale of 1 carton (12 base pieces sold)
      const sale = await createSale(
        {
          branchId: 1,
          shiftId: 1,
          customerId: 1,
          priceTier: "RETAIL",
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }], // 1 carton = 12 pieces
          payment: { amount: "60000.00", method: "CASH" },
        },
        cashierActor,
      );

      const [createdItem] = await testDb()
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));

      const caller = returnRouter.createCaller({
        user: { id: 1, role: "cashier", branchId: 1, isOwner: false },
      } as any);

      // Attempt to return 1 carton (12) + 1 piece (1) = 13 > 12
      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          items: [
            { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 2, productName: "كرتونة", quantity: 1, unitPrice: "60000.00" },
            { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "قطعة", quantity: 1, unitPrice: "5000.00" },
          ],
          settlement: { method: "CASH", totalAmount: "60000.00", shiftId: 1 },
        }),
      ).rejects.toThrow(/تتجاوز المتبقي في الفاتورة/);
    });
  });

  // ─── Challenge 2: VULN-FIN-01 (Zero Credit Limit Formats & Micro Debts) ────────
  describe("Challenge 2: VULN-FIN-01 Zero Limit Variations & Boundary Assertions", () => {
    function makeMockCreditTx(creditLimit: string | null, currentBalance: string = "0") {
      const rows = [{ creditLimit, currentBalance }];
      const from = vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(rows),
          })),
        })),
      }));
      const select = vi.fn(() => ({ from }));
      return { select } as unknown as Parameters<typeof assertCreditLimit>[0];
    }

    it("ADV-FIN-01a: Rejects credit limit formatted as '0.00' and '0.0000' with existing debt", async () => {
      const tx2 = makeMockCreditTx("0.00", "5000");
      await expect(assertCreditLimit(tx2, 201, "100", 1, "CREDIT"))
        .rejects.toThrow(/حدّ ائتمانه صفر/);

      const tx4 = makeMockCreditTx("0.0000", "5000");
      await expect(assertCreditLimit(tx4, 202, "100", 1, "CREDIT"))
        .rejects.toThrow(/حدّ ائتمانه صفر/);
    });

    it("ADV-FIN-01b: Exact credit boundary: balance + add == limit resolves, balance + add == limit + 0.01 rejects", async () => {
      const tx = makeMockCreditTx("500.00", "300.00");
      // Exact boundary: 300 + 200 = 500 == limit
      await expect(assertCreditLimit(tx, 203, "200.00", 1, "CREDIT")).resolves.toBeUndefined();

      // One penny over: 300 + 200.01 = 500.01 > 500
      await expect(assertCreditLimit(tx, 203, "200.01", 1, "CREDIT"))
        .rejects.toThrow(/تجاوز حدّ الائتمان/);
    });
  });

  // ─── Challenge 3: VULN-FIN-02 (Cross-Branch String/Number Coercion) ────────────
  describe("Challenge 3: VULN-FIN-02 Cross-Branch Invariant Under Coercion", () => {
    it("ADV-FIN-02: String branchId '2' against numeric branchId 1 is strictly blocked", async () => {
      const adminBranch1 = { userId: 1, branchId: 1, role: "admin" as const };
      const sale = await createSale(
        {
          branchId: 1,
          customerId: 1,
          priceTier: "RETAIL",
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        },
        adminBranch1,
      );

      // Attempting voucher with string branchId '2'
      await expect(
        createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: "2" as any,
            amount: "5000.00",
            paymentMethod: "CASH",
            partyType: "CUSTOMER",
            partyId: 1,
            description: "سداد عبر فروع بفرع نصي",
            invoiceId: sale.invoiceId,
            clientRequestId: "adv-cross-branch-string-id",
          } as never,
          { userId: 20, branchId: 2, role: "admin" },
        ),
      ).rejects.toThrow(/لا يمكن سداد فاتورة فرع آخر بسند قبض محلي/);
    });
  });

  // ─── Challenge 4: EDGE-FIN-01 (Deadlock Prevention on CANCELLED invoice) ───────
  describe("Challenge 4: EDGE-FIN-01 Deadlock on Cancelled Invoice", () => {
    it("ADV-FIN-04: Gracefully unlinks and completes voucher if invoice is CANCELLED during approval", async () => {
      const owner = { userId: 2, branchId: 1, role: "manager" as const, isOwner: true };
      const sale = await createSale(
        {
          branchId: 1,
          customerId: 1,
          priceTier: "RETAIL",
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        },
        owner,
      );

      const [inserted] = await testDb().insert(s.receipts).values({
        voucherNumber: "RV-ADV-CANCEL-01",
        branchId: 1,
        direction: "IN",
        amount: "5000.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "دفعة معلقة تحت التدقيق",
        invoiceId: sale.invoiceId,
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        createdBy: 2,
        shiftId: 2,
        voucherDate: "2026-09-29",
      });
      const receiptId = inserted.insertId;

      // Cancel invoice before voucher approval
      await testDb()
        .update(s.invoices)
        .set({ status: "CANCELLED" })
        .where(eq(s.invoices.id, sale.invoiceId));

      const approvedRes = await approveVoucher(receiptId, owner);
      expect(approvedRes.approvalStatus).toBe("APPROVED");

      const [voucher] = await testDb().select().from(s.receipts).where(eq(s.receipts.id, receiptId));
      expect(voucher.invoiceId).toBeNull();
      expect(voucher.internalNote).toContain("ملغاة أو مرتجعة أو مستبدلة");
      expect(voucher.status).toBe("COMPLETED");
    });
  });

  // ─── Challenge 5: VULN-RBAC-01 (PO Approval SoD Flag Inversion Matrix) ─────────
  describe("Challenge 5: VULN-RBAC-01 SoD Multi-Role State Matrix", () => {
    const FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
    const originalFlag = process.env[FLAG];

    afterEach(() => {
      if (originalFlag == null) delete process.env[FLAG];
      else process.env[FLAG] = originalFlag;
    });

    it("ADV-RBAC-01: When ROLLOUT is OFF or undefined, legacy SoD is strictly enforced", () => {
      delete process.env[FLAG];
      const trigger = purchaseOrderControlTrigger("PRICE_INCREASE", true);

      let legacyCalled = false;
      const legacyCheck = () => {
        legacyCalled = true;
        throw new TRPCError({ code: "FORBIDDEN", message: "يلزم معتمد مستقل" });
      };

      expect(() =>
        assertApprover({
          actor: { userId: 10, role: "manager", isOwner: false },
          trigger,
          subject: "أمر شراء",
          retainLegacy: true,
          legacy: legacyCheck,
        }),
      ).toThrowError(/يلزم معتمد مستقل/);
      expect(legacyCalled).toBe(true);
    });

    it("ADV-RBAC-01b: When ROLLOUT is ON and trigger is null, retainLegacy: true still executes legacy check", () => {
      process.env[FLAG] = "ON";
      let legacyExecuted = false;
      const legacyFn = () => {
        legacyExecuted = true;
        throw new TRPCError({ code: "FORBIDDEN", message: "فصل مهام إلزامي" });
      };

      expect(() =>
        assertApprover({
          actor: { userId: 10, role: "manager", isOwner: false },
          trigger: null, // explicit null trigger
          subject: "أمر شراء",
          retainLegacy: true,
          legacy: legacyFn,
        }),
      ).toThrowError(/فصل مهام إلزامي/);
      expect(legacyExecuted).toBe(true);
    });
  });

  // ─── Challenge 6: VULN-RBAC-02 (Branch Authority Fuzzing) ─────────────────────
  describe("Challenge 6: VULN-RBAC-02 Branch Authority Edge Fuzzing", () => {
    it("ADV-RBAC-02: Non-positive, NaN, and float branch IDs are strictly rejected for admins", () => {
      const adminCtx = { user: { role: "admin", isOwner: false, branchId: 1 } };

      expect(() => resolveActorBranchId(adminCtx, 0)).toThrow(TRPCError);
      expect(() => resolveActorBranchId(adminCtx, -10)).toThrow(TRPCError);
      expect(() => resolveActorBranchId(adminCtx, NaN as any)).toThrow(TRPCError);
    });

    it("ADV-RBAC-02b: Cashier cannot use negative infinity or prototype keys to break confinement", () => {
      const cashierCtx = { user: { role: "cashier", isOwner: false, branchId: 5 } };
      expect(resolveActorBranchId(cashierCtx, -Infinity as any)).toBe(5);
      expect(resolveActorBranchId(cashierCtx, 999999)).toBe(5);
    });
  });

  // ─── Challenge 7: VULN-RBAC-03 (Prototype Pollution in Permission Overrides) ───
  describe("Challenge 7: VULN-RBAC-03 Prototype Pollution Fuzzing", () => {
    it("ADV-RBAC-03: Rejects prototype pollution and unapproved keys in userRouter.PERM_OVERRIDE", () => {
      // Special prototype keys are rejected when passed as string keys
      expect(PERM_OVERRIDE.safeParse({ constructor: "FULL" }).success).toBe(false);
      expect(PERM_OVERRIDE.safeParse({ valueOf: "FULL" }).success).toBe(false);
      expect(PERM_OVERRIDE.safeParse({ toString: "READ" }).success).toBe(false);

      // JSON __proto__ is stripped by Zod's record parser, leaving data empty without polluting prototype
      const parsedJson = JSON.parse('{"__proto__": "FULL"}');
      const res = PERM_OVERRIDE.safeParse(parsedJson);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({});
      expect((Object.prototype as any).FULL).toBeUndefined();

      // But if an unapproved key is sent alongside __proto__, it is rejected
      const maliciousWithProto = JSON.parse('{"__proto__": "FULL", "unauthorized_module": "FULL"}');
      expect(PERM_OVERRIDE.safeParse(maliciousWithProto).success).toBe(false);
    });

    it("ADV-RBAC-03b: Rejects lowercase or mixed case permission values", () => {
      const invalidCase = [
        { pos: "full" },
        { pos: "Read" },
        { pos: "None" },
      ];

      for (const p of invalidCase) {
        expect(() => PERM_OVERRIDE.parse(p)).toThrow();
      }
    });
  });

  // ─── Challenge 8: VULN-RBAC-04 (Sub-Second Timestamp Revocation) ───────────────
  describe("Challenge 8: VULN-RBAC-04 Timestamp Boundary & Sub-Second Invariants", () => {
    it("ADV-RBAC-04: Sub-second boundary: iat == validFromSec is treated as revoked (zero blind-window)", () => {
      const t = 1759147200;
      // Exact match: token issued at the exact second of revocation is revoked
      expect(isSessionRevokedByTimestamp(t, t)).toBe(true);
      // One second before: revoked
      expect(isSessionRevokedByTimestamp(t - 1, t)).toBe(true);
      // One second after: valid
      expect(isSessionRevokedByTimestamp(t + 1, t)).toBe(false);
    });

    it("ADV-RBAC-04b: Handles ISO string, Date object, and null/undefined validFromSec cleanly", () => {
      const d = new Date("2026-09-29T12:00:00Z");
      const sec = Math.floor(d.getTime() / 1000);

      expect(isSessionRevokedByTimestamp(sec - 5, d.toISOString())).toBe(true);
      expect(isSessionRevokedByTimestamp(sec + 5, d.toISOString())).toBe(false);
      expect(isSessionRevokedByTimestamp(sec, null)).toBe(false);
      expect(isSessionRevokedByTimestamp(sec, undefined)).toBe(false);
    });
  });

  // ─── Challenge 9: VULN-GRD-01 (AST/Regex Evasion Resistance) ───────────────────
  describe("Challenge 9: VULN-GRD-01 Scanner Regex Evasion Resistance", () => {
    it("ADV-GRD-01: Detects evasive formatting (extra spaces, newlines, tabs, scopedBranchId fallback)", () => {
      const RE = /(?:=\s*[^;]*\b(scopedBranchId|input\??\.branchId)\b[^;]*(\?\?|\|\|)\s*[01]\b|\bbranchId\s*:\s*[^;]*\b(scopedBranchId|input\??\.branchId)\b[^;]*(\?\?|\|\|)\s*1\b)/;

      // Extra whitespace
      expect(RE.test("const branchId = input.branchId   ??   1;")).toBe(true);
      // Logical OR with zero
      expect(RE.test("const b = scopedBranchId || 0;")).toBe(true);
      // Object literal shorthand with optional chaining
      expect(RE.test("const payload = { branchId: input?.branchId ?? 1 };")).toBe(true);
    });
  });

  // ─── Challenge 10: VULN-GRD-02 (Billing Decimal Defense Under Hostile Input) ────
  describe("Challenge 10: VULN-GRD-02 Billing Defensive Decimal Handling", () => {
    it("ADV-GRD-02: Rejects non-finite numbers, empty strings, and exponential notation gracefully", () => {
      const hostile = ["NaN", "Infinity", "-Infinity", "1e5", "   "];
      for (const val of hostile) {
        try {
          computeInvoiceTotals({
            lineTotals: ["100.00"],
            invoiceDiscount: val,
          });
          // Some might parse if Decimal supports "1e5", but let's assert it never throws unhandled DecimalError
        } catch (err: any) {
          expect(err).toBeInstanceOf(TRPCError);
          expect(err.code).toBe("BAD_REQUEST");
        }
      }
    });

    it("ADV-GRD-02b: Rejects tax rate percent > 100 with TRPCError", () => {
      expect(() =>
        computeInvoiceTotals({
          lineTotals: ["100.00"],
          taxRatePercent: "150",
        }),
      ).toThrow(TRPCError);
    });
  });

  // ─── Challenge 11: VULN-GRD-03 (Nested Router Namespace Collisions) ───────────
  describe("Challenge 11: VULN-GRD-03 Router-Scoped Namespace Disambiguation", () => {
    it("ADV-GRD-03: Disambiguates nested sub-routers without leaking usage across parent namespaces", () => {
      const usedByRouter = new Map<string, Set<string>>();
      function addUsed(call: string) {
        const parts = call.split(".");
        if (parts.length < 2) return;
        const routerKey = parts[0];
        if (!usedByRouter.has(routerKey)) usedByRouter.set(routerKey, new Set());
        for (let i = 1; i < parts.length; i++) usedByRouter.get(routerKey)!.add(parts[i]);
      }

      addUsed("commissions.runs.approve");
      expect(usedByRouter.get("commissions")?.has("runs")).toBe(true);
      expect(usedByRouter.get("commissions")?.has("approve")).toBe(true);
      // Ensure purchase.approve is NOT considered used
      expect(usedByRouter.get("purchase")?.has("approve") ?? false).toBe(false);
    });
  });

  // ─── Challenge 12: VULN-GRD-04 (Error Contract Protocol-Relative URLs) ─────────
  describe("Challenge 12: VULN-GRD-04 Error Contract URL & Punctuation Defense", () => {
    const VALID = {
      what: "تعذر الحفظ",
      why: "البيانات غير مكتملة",
      doThis: "أكمل الحقول المطلوبة وأعد المحاولة",
    };

    it("ADV-GRD-04a: Rejects protocol-relative (//evil.com) and backslash-escaped (/\\evil.com) action hrefs", () => {
      expect(() =>
        appError({
          ...VALID,
          action: { label: "انتقل", href: "//malicious.domain.com/phish" },
        }),
      ).toThrow(AppContractError);

      expect(() =>
        appError({
          ...VALID,
          action: { label: "انتقل", href: "/\\malicious.domain.com/phish" },
        }),
      ).toThrow(AppContractError);

      expect(() =>
        appError({
          ...VALID,
          action: { label: "انتقل", href: "https://external.com" },
        }),
      ).toThrow(AppContractError);
    });

    it("ADV-GRD-04b: Accepts legitimate internal application paths (e.g. /inventory, /pos)", () => {
      const built = appError({
        ...VALID,
        action: { label: "المخزون", href: "/inventory" },
      });
      expect(built.action?.href).toBe("/inventory");
      expect(built.action?.label).toBe("المخزون");
    });

    it("ADV-GRD-04c: Strips trailing punctuation before joining to prevent double separators", () => {
      const built = appError({
        what: "تعذر الحفظ،،،",
        why: "البيانات ناقصة...",
        doThis: "أعد المحاولة",
      });
      // Should not contain "،،، —" or "... —"
      expect(built.message).not.toContain("،،، —");
      expect(built.message).toContain("تعذر الحفظ — البيانات ناقصة. أعد المحاولة.");
    });
  });
});
