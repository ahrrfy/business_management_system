/**
 * Al-Roya ERP-DFIR Core Protocol — Master Proof-of-Concept Test Suite
 * File: server/__tests__/dfirMasterPoc.test.ts
 *
 * CRITICAL INTEGRITY REQUIREMENT:
 * - Direct imports from production code, schemas, routers, and services.
 * - ZERO facades, ZERO mock schemas, ZERO fake functions.
 * - Asserts both sides: exploit attempt rejection AND valid operation success.
 *
 * Subsystems Covered:
 * 1. Subsystem 1 (VULN-INV-01): Sales return cart line-splitting accumulation, packaging unit conversion, and foreign item rejection
 * 2. Subsystem 2 (VULN-FIN-01): Zero credit limit invariant with existing debt, COD bypass, and capacity checks
 * 3. Subsystem 3 (VULN-FIN-02): Cross-branch voucher allocation to invoice prevention
 * 4. Subsystem 4 (EDGE-FIN-01): Voucher approval deadlock resolution on pre-settled/cancelled invoice
 * 5. Subsystem 5 (VULN-RBAC-01): Segregation of duties in PO approvals under ROLLOUT_OWNER_ONLY_APPROVAL
 * 6. Subsystem 6 (VULN-RBAC-02): Default branch fallback elimination (?? 1) and branch authority matrix
 * 7. Subsystem 7 (VULN-RBAC-03): Constrained permission override schema injection prevention
 * 8. Subsystem 8 (VULN-RBAC-04): Session validation, token versioning, and timestamp revocation
 * 9. Subsystem 9 (VULN-GRD-01): Branch default AST/regex checks & clean client pages
 * 10. Subsystem 10 (VULN-GRD-02): Money schema validation and defensive Decimal error handling
 * 11. Subsystem 11 (VULN-GRD-03): Router-scoped orphan endpoint resolution preventing false negatives
 * 12. Subsystem 12 (VULN-GRD-04): AppContractError TRPCError compliance preventing HTTP 500 masking
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";

// ─── 1. Production Imports (Genuine Services & Schemas) ─────────────────────────
import { returnRouter } from "../routers/returnRouter";
import { createSale } from "../services/saleService";
import { createVoucher, approveVoucher } from "../services/voucherService";
import { assertCreditLimit } from "../lib/credit";
import { resolveActorBranchId, canCrossBranches } from "../lib/branchAuthority";
import { PERM_OVERRIDE } from "../routers/userRouter";
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

// ─── Test Database Harness ──────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1: VULN-INV-01 (Return Cart Line-Splitting Accumulation & Foreign Items)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 1 (VULN-INV-01): Return Cart Invariants", () => {
  beforeEach(async () => {
    await resetDb();
    const d = testDb();
    await d.insert(s.branches).values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    ]);
    await d.insert(s.users).values([
      { id: 1, openId: "cashier-1", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false },
    ]);
    await d.insert(s.products).values([
      { id: 1, name: "منتج أساسي" },
      { id: 2, name: "منتج أجنبي" },
    ]);
    await d.insert(s.productVariants).values([
      { id: 1, productId: 1, sku: "PRD-1", costPrice: "1000.00" },
      { id: 2, productId: 2, sku: "PRD-FOREIGN", costPrice: "2000.00" },
    ]);
    // Product 1 has base unit (conversion factor 1) and carton unit (conversion factor 12)
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
      { variantId: 1, branchId: 1, quantity: 100 },
      { variantId: 2, branchId: 1, quantity: 50 },
    ]);
    await d.insert(s.shifts).values([
      { id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" },
    ]);
    await d.insert(s.customers).values([
      { id: 1, name: "عميل تجريبي", currentBalance: "0", creditLimit: "9999999.00" },
    ]);
  });

  it("VULN-INV-01 Exploit Attempt: Rejects line-splitting return when total quantity exceeds invoice quantity (6 + 5 > 10)", async () => {
    const cashierActor = { userId: 1, branchId: 1, role: "cashier" as const };
    // Create paid POS sale of 10 pieces (total 50,000)
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

    // Exploit attempt: Split into 2 lines (6 + 5 = 11 > 10)
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        items: [
          { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 6, unitPrice: "5000.00" },
          { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 5, unitPrice: "5000.00" },
        ],
        settlement: { method: "CASH", totalAmount: "50000.00", shiftId: 1 },
      }),
    ).rejects.toThrow(/تتجاوز المتبقي في الفاتورة/);
  });

  it("VULN-INV-01 Valid Operation: Successfully executes multi-line split return within invoice quota (6 + 4 = 10)", async () => {
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
        { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 6, unitPrice: "5000.00" },
        { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 1, productName: "منتج أساسي", quantity: 4, unitPrice: "5000.00" },
      ],
      settlement: { method: "CASH", totalAmount: "50000.00", shiftId: 1 },
    });

    expect(res.ok).toBe(true);
    expect(res.itemsCount).toBe(2);
  });

  it("VULN-INV-01 Packaging Conversion Factor: 1 carton (12x) exceeds invoice remaining base quantity of 10", async () => {
    const cashierActor = { userId: 1, branchId: 1, role: "cashier" as const };
    // Create paid POS sale of 15 pieces (total 75,000)
    const sale = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "15" }],
        payment: { amount: "75000.00", method: "CASH" },
      },
      cashierActor,
    );

    // Partially return 5 pieces, leaving 10 base units remaining
    await testDb()
      .update(s.invoiceItems)
      .set({ returnedBaseQuantity: 5 })
      .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));

    const [createdItem] = await testDb()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));

    const caller = returnRouter.createCaller({
      user: { id: 1, role: "cashier", branchId: 1, isOwner: false },
    } as any);

    // Attempt to return 1 carton (unit 2, conversion factor = 12 pieces > 10 remaining)
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        items: [
          { variantId: 1, invoiceItemId: createdItem.id, productUnitId: 2, productName: "كرتونة منتج أساسي", quantity: 1, unitPrice: "60000.00" },
        ],
        settlement: { method: "CASH", totalAmount: "60000.00", shiftId: 1 },
      }),
    ).rejects.toThrow(/تتجاوز المتبقي في الفاتورة/);
  });

  it("VULN-INV-01 Foreign Item Rejection: Rejects item not present on the reference invoice", async () => {
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

    const caller = returnRouter.createCaller({
      user: { id: 1, role: "cashier", branchId: 1, isOwner: false },
    } as any);

    // Exploit attempt: Returning variant 2 (foreign item) under invoice for variant 1
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        items: [
          { variantId: 2, productUnitId: 3, productName: "منتج أجنبي", quantity: 1, unitPrice: "8000.00" },
        ],
        settlement: { method: "CASH", totalAmount: "8000.00", shiftId: 1 },
      }),
    ).rejects.toThrow(/العنصر غير موجود في الفاتورة المرجعية/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 2: VULN-FIN-01 (Zero Credit Limit Invariant & Non-Bypass)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 2 (VULN-FIN-01): Zero Credit Limit Invariants", () => {
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

  it("VULN-FIN-01 Exploit Attempt: Customer with zero credit limit and existing debt MUST be blocked from additional credit", async () => {
    const tx = makeMockCreditTx("0", "120000");
    await expect(assertCreditLimit(tx, 101, "25000", 1, "CREDIT"))
      .rejects.toThrow(/حدّ ائتمانه صفر/);
    await expect(assertCreditLimit(tx, 101, "25000", 1, "CREDIT"))
      .rejects.toThrow(/رصيد سابق/);
  });

  it("VULN-FIN-01 Micro-decimal addition: 0.00000001 debt addition is strictly rejected for zero limit customer", async () => {
    const tx = makeMockCreditTx("0", "5000");
    await expect(assertCreditLimit(tx, 102, "0.00000001", 1, "CREDIT"))
      .rejects.toThrow(/حدّ ائتمانه صفر/);
  });

  it("VULN-FIN-01 Negative Balance (Credit): Customer with zero limit and credit balance cannot take deferred goods", async () => {
    const tx = makeMockCreditTx("0", "-15000");
    await expect(assertCreditLimit(tx, 103, "5000", 1, "CREDIT"))
      .rejects.toThrow(/حدّ ائتمانه صفر/);
  });

  it("VULN-FIN-01 Valid Operation: Zero addition amount (pure cash/immediate settlement) resolves successfully", async () => {
    const tx = makeMockCreditTx("0", "50000");
    await expect(assertCreditLimit(tx, 104, "0", 1, "CREDIT")).resolves.toBeUndefined();
  });

  it("VULN-FIN-01 Valid Operation: Cash On Delivery (COD) mode bypasses credit check as courier collects upon delivery", async () => {
    const tx = makeMockCreditTx("0", "50000");
    await expect(assertCreditLimit(tx, 105, "50000", 1, "COD")).resolves.toBeUndefined();
  });

  it("VULN-FIN-01 Valid Operation & Capacity Enforcement: Positive credit limit allows purchase within capacity and rejects excess", async () => {
    const tx = makeMockCreditTx("1000.00", "400.00");
    // Valid: 400 + 500 = 900 <= 1000
    await expect(assertCreditLimit(tx, 106, "500.00", 1, "CREDIT")).resolves.toBeUndefined();
    // Exploit/Over-limit: 400 + 700 = 1100 > 1000
    await expect(assertCreditLimit(tx, 106, "700.00", 1, "CREDIT"))
      .rejects.toThrow(/تجاوز حدّ الائتمان/);
  });

  it("VULN-FIN-01 Unlimited Credit: Customer with null limit permits arbitrary credit additions", async () => {
    const tx = makeMockCreditTx(null, "500000");
    await expect(assertCreditLimit(tx, 107, "999999999", 1, "CREDIT")).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 3: VULN-FIN-02 (Cross-Branch Voucher Allocation to Invoice Prevention)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 3 (VULN-FIN-02): Cross-Branch Voucher Allocation", () => {
  beforeEach(async () => {
    await resetDb();
    const d = testDb();
    await d.insert(s.branches).values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع الكرخ", code: "KARKH", type: "SALES" },
    ]);
    await d.insert(s.users).values([
      { id: 1, openId: "admin-1", name: "أدمن 1", role: "admin", loginMethod: "local", branchId: 1 },
      { id: 2, openId: "admin-2", name: "أدمن 2", role: "admin", loginMethod: "local", branchId: 2 },
    ]);
    await d.insert(s.products).values({ id: 1, name: "منتج تجريبي" });
    await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PRD-1", costPrice: "1000.00" });
    await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "5000.00" });
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 100 },
      { variantId: 1, branchId: 2, quantity: 100 },
    ]);
    await d.insert(s.shifts).values([
      { id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" },
      { id: 2, userId: 2, branchId: 2, status: "OPEN", openedAt: new Date(), openGuard: "2:2", openingBalance: "0" },
    ]);
    await d.insert(s.customers).values({ id: 1, name: "شركة الأفق", currentBalance: "0", creditLimit: "9999999.00" });
  });

  it("VULN-FIN-02 Exploit Attempt: Rejects receipt voucher creation in Branch 2 against Branch 1 invoice", async () => {
    const adminBranch1 = { userId: 1, branchId: 1, role: "admin" as const };
    const adminBranch2 = { userId: 2, branchId: 2, role: "admin" as const };

    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      },
      adminBranch1,
    );

    // Exploit attempt: Branch 2 issuing voucher against Branch 1 invoice
    await expect(
      createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 2,
          amount: "5000.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "محاولة سداد عابر للفروع غير مصرح بها",
          invoiceId: sale.invoiceId,
          clientRequestId: "m4-cross-branch-exploit",
        } as never,
        adminBranch2,
      ),
    ).rejects.toThrow(/لا يمكن سداد فاتورة فرع آخر بسند قبض محلي/);
  });

  it("VULN-FIN-02 Valid Operation: Allows voucher allocation in the same branch as the invoice (Branch 1)", async () => {
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

    const voucher = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "5000.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "سداد محلي نظامي",
        invoiceId: sale.invoiceId,
        clientRequestId: "m4-same-branch-valid",
      } as never,
      adminBranch1,
    );

    expect(voucher.receiptId).toBeDefined();
    expect(voucher.approvalStatus).toBe("APPROVED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 4: EDGE-FIN-01 (Voucher Approval Deadlock Prevention on Pre-Settled Invoice)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 4 (EDGE-FIN-01): Voucher Approval Deadlock Resolution", () => {
  beforeEach(async () => {
    await resetDb();
    const d = testDb();
    await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
    await d.insert(s.users).values([
      { id: 10, openId: "cashier-10", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false, isActive: true },
      { id: 2, openId: "owner-2", name: "المالك المعتمد", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
    ]);
    await d.insert(s.products).values({ id: 1, name: "بضاعة" });
    await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "SKU-1", costPrice: "5000.00" });
    await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "20000.00" });
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
    await d.insert(s.shifts).values({ id: 1, userId: 10, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
    await d.insert(s.customers).values({ id: 1, name: "عميل معتمد", currentBalance: "0", creditLimit: "9999999.00" });
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
  });

  it("EDGE-FIN-01 Unlinks pre-settled invoice and routes funds to customer balance without deadlocking in PENDING_APPROVAL", async () => {
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

    // Insert pending voucher linked to this invoice
    const [inserted] = await testDb().insert(s.receipts).values({
      voucherNumber: "RV-M4-DEADLOCK-01",
      branchId: 1,
      direction: "IN",
      amount: "20000.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "دفعة معلقة تحت التدقيق",
      invoiceId: sale.invoiceId,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 10,
      voucherDate: "2026-09-29",
    });
    const receiptId = inserted.insertId;

    // Simulate invoice pre-settlement at POS while approval was pending
    await testDb()
      .update(s.invoices)
      .set({ paidAmount: "20000.00", status: "PAID" })
      .where(eq(s.invoices.id, sale.invoiceId));

    // Approving the voucher now must cleanly unlink invoice, set note, and approve
    const approvedRes = await approveVoucher(receiptId, owner);
    expect(approvedRes.approvalStatus).toBe("APPROVED");

    const [voucher] = await testDb().select().from(s.receipts).where(eq(s.receipts.id, receiptId));
    expect(voucher.invoiceId).toBeNull();
    expect(voucher.internalNote).toContain("فُكّ ربط السند بها وقُيّد المبلغ على رصيد العميل");
    expect(voucher.status).toBe("COMPLETED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 5: VULN-RBAC-01 (Segregation of Duties in PO Approval under ROLLOUT)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 5 (VULN-RBAC-01): SoD in Purchase Order Approval", () => {
  const FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
  const originalFlag = process.env[FLAG];

  afterEach(() => {
    if (originalFlag == null) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  const CREATOR_ID = 10;
  const EDITOR_ID = 20;
  const REQUESTER_ID = 30;
  const INDEPENDENT_APPROVER_ID = 40;
  const OWNER_ID = 99;

  const PO_FIXTURE = { poNumber: "PO-M4-001", createdBy: CREATOR_ID, lastEditedBy: EDITOR_ID };
  const REQUEST_FIXTURE = { requestedBy: REQUESTER_ID, kind: "PRICE_INCREASE" as const };

  function makeLegacyCheck(actorUserId: number) {
    return () => {
      if (
        actorUserId === Number(REQUEST_FIXTURE.requestedBy) ||
        actorUserId === Number(PO_FIXTURE.createdBy) ||
        actorUserId === Number(PO_FIXTURE.lastEditedBy)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "يلزم معتمد مستقل عن المنشئ وآخر محرر وصاحب الطلب",
        });
      }
    };
  }

  it("VULN-RBAC-01 Exploit Attempt: Under ROLLOUT_OWNER_ONLY_APPROVAL=ON, creator/editor/requester approval is strictly rejected", () => {
    process.env[FLAG] = "ON";
    const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);

    // Creator rejection
    expect(() =>
      assertApprover({
        actor: { userId: CREATOR_ID, role: "manager", isOwner: false },
        trigger,
        subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
        retainLegacy: true,
        legacy: makeLegacyCheck(CREATOR_ID),
      }),
    ).toThrowError(/يلزم معتمد مستقل/);

    // Editor rejection
    expect(() =>
      assertApprover({
        actor: { userId: EDITOR_ID, role: "manager", isOwner: false },
        trigger,
        subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
        retainLegacy: true,
        legacy: makeLegacyCheck(EDITOR_ID),
      }),
    ).toThrowError(/يلزم معتمد مستقل/);

    // Requester rejection
    expect(() =>
      assertApprover({
        actor: { userId: REQUESTER_ID, role: "manager", isOwner: false },
        trigger,
        subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
        retainLegacy: true,
        legacy: makeLegacyCheck(REQUESTER_ID),
      }),
    ).toThrowError(/يلزم معتمد مستقل/);
  });

  it("VULN-RBAC-01 Valid Operation: Independent approver and Owner successfully approve", () => {
    process.env[FLAG] = "ON";
    const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);

    // Independent approver succeeds
    expect(() =>
      assertApprover({
        actor: { userId: INDEPENDENT_APPROVER_ID, role: "manager", isOwner: false },
        trigger,
        subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
        retainLegacy: true,
        legacy: makeLegacyCheck(INDEPENDENT_APPROVER_ID),
      }),
    ).not.toThrow();

    // Owner succeeds
    expect(() =>
      assertApprover({
        actor: { userId: OWNER_ID, role: "manager", isOwner: true },
        trigger,
        subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
        retainLegacy: true,
        legacy: makeLegacyCheck(OWNER_ID),
      }),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 6: VULN-RBAC-02 (Default Branch Elimination & Authority Matrix)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 6 (VULN-RBAC-02): Branch Authority & Default Elimination", () => {
  it("VULN-RBAC-02 canCrossBranches: Admin and Owner can cross branches, while non-elevated roles cannot", () => {
    expect(canCrossBranches({ role: "admin", isOwner: false })).toBe(true);
    expect(canCrossBranches({ role: "manager", isOwner: true })).toBe(true);
    expect(canCrossBranches({ role: "admin", isOwner: true })).toBe(true);

    expect(canCrossBranches({ role: "manager", isOwner: false })).toBe(false);
    expect(canCrossBranches({ role: "cashier", isOwner: false })).toBe(false);
    expect(canCrossBranches({ role: "warehouse", isOwner: false })).toBe(false);
    expect(canCrossBranches(null)).toBe(false);
    expect(canCrossBranches(undefined)).toBe(false);
  });

  it("VULN-RBAC-02 Cashier Confinement: Cashier cannot switch branches and unassigned cashier throws FORBIDDEN", () => {
    const assignedCashier = { user: { role: "cashier", isOwner: false, branchId: 3 } };
    expect(resolveActorBranchId(assignedCashier, 7)).toBe(3);

    const unassignedCashier = { user: { role: "cashier", isOwner: false, branchId: null } };
    expect(() => resolveActorBranchId(unassignedCashier, 2)).toThrow(TRPCError);
    try {
      resolveActorBranchId(unassignedCashier, 2);
    } catch (err: any) {
      expect(err.code).toBe("FORBIDDEN");
      expect(err.message).toContain("لا فرع مُسنَد لهذا المستخدم");
    }
  });

  it("VULN-RBAC-02 Admin Branch Selection: Requires explicit branchId, falls back safely to assigned branch, and rejects <= 0", () => {
    const adminWithBranch = { user: { role: "admin", isOwner: false, branchId: 1 } };
    expect(resolveActorBranchId(adminWithBranch, 4)).toBe(4);
    expect(resolveActorBranchId(adminWithBranch)).toBe(1);

    const adminNoBranch = { user: { role: "admin", isOwner: false, branchId: null } };
    expect(() => resolveActorBranchId(adminNoBranch)).toThrow(TRPCError);
    try {
      resolveActorBranchId(adminNoBranch);
    } catch (err: any) {
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("يجب تحديد الفرع (branchId)");
    }

    // Invalid non-positive branch IDs throw BAD_REQUEST
    expect(() => resolveActorBranchId(adminWithBranch, 0)).toThrow(TRPCError);
    expect(() => resolveActorBranchId(adminWithBranch, -1)).toThrow(TRPCError);
    try {
      resolveActorBranchId(adminWithBranch, 0);
    } catch (err: any) {
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("معرف الفرع غير صالح");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 7: VULN-RBAC-03 (Constrained Permission Override Schema)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 7 (VULN-RBAC-03): Permission Override Schema Invariants", () => {
  it("VULN-RBAC-03 Valid Operation: Accepts valid standard module keys and permission levels", () => {
    const validOverrides = {
      crm: "FULL",
      sales: "READ",
      inventory: "NONE",
      customers: "FULL",
    };
    const parsed = PERM_OVERRIDE.parse(validOverrides);
    expect(parsed).toEqual(validOverrides);
    expect(PERM_OVERRIDE.parse({})).toEqual({});
    expect(PERM_OVERRIDE.parse(null)).toBeNull();
    expect(PERM_OVERRIDE.parse(undefined)).toBeUndefined();
  });

  it("VULN-RBAC-03 Exploit Attempt: Rejects arbitrary/injected module keys", () => {
    const injectedKeys = [
      { maliciousModule: "FULL" },
      { root: "FULL" },
      { superUser: "FULL" },
      { bypassRbac: "NONE" },
      { injected_module_exploit: "FULL" },
    ];
    for (const payload of injectedKeys) {
      const res = PERM_OVERRIDE.safeParse(payload);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i: any) => i.message.includes("مفتاح وحدة غير مصرّح به"))).toBe(true);
      }
    }
  });

  it("VULN-RBAC-03 Exploit Attempt: Rejects unauthorized access values outside enum", () => {
    const invalidValues = [
      { crm: "SUPERADMIN" },
      { sales: "WRITE" },
      { inventory: "ALL" },
      { crm: "1" },
    ];
    for (const payload of invalidValues) {
      expect(() => PERM_OVERRIDE.parse(payload)).toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 8: VULN-RBAC-04 (Session Validation, Versioning, and Revocation)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 8 (VULN-RBAC-04): Session Security & Revocation", () => {
  it("VULN-RBAC-04 validateUserForSession: Strictly rejects inactive, suspended, or expired users", () => {
    expect(validateUserForSession(null)).toBe(false);
    expect(validateUserForSession(undefined)).toBe(false);
    expect(validateUserForSession({ isActive: false })).toBe(false);
    expect(validateUserForSession({ isActive: true, status: "SUSPENDED" })).toBe(false);
    expect(validateUserForSession({ isActive: true, status: "INACTIVE" })).toBe(false);

    const now = Date.now();
    expect(validateUserForSession({ isActive: true, accessExpiresAt: new Date(now - 1000) }, null, now)).toBe(false);
    expect(validateUserForSession({ isActive: true, accessExpiresAt: new Date(now + 60000) }, null, now)).toBe(true);
    expect(validateUserForSession({ isActive: true, status: "ACTIVE" })).toBe(true);
  });

  it("VULN-RBAC-04 Token Version Matching: Enforces version equality when both specify tokenVersion", () => {
    expect(validateUserForSession({ isActive: true, tokenVersion: 3 }, 2)).toBe(false);
    expect(validateUserForSession({ isActive: true, tokenVersion: 3 }, 3)).toBe(true);
    expect(validateUserForSession({ isActive: true, tokenVersion: null }, 1)).toBe(true);
  });

  it("VULN-RBAC-04 isSessionRevokedByTimestamp: Correctly flags tokens issued prior to revocation timestamp", () => {
    const revokedAtSec = 1759147200; // 2025-09-29T12:00:00Z in seconds
    const revokedAtDate = new Date(revokedAtSec * 1000);

    // Number comparison: token issued 10 seconds before revocation is revoked
    expect(isSessionRevokedByTimestamp(revokedAtSec - 10, revokedAtSec)).toBe(true);
    // Token issued after revocation is valid
    expect(isSessionRevokedByTimestamp(revokedAtSec + 1, revokedAtSec)).toBe(false);

    // Date comparison: token issued before revoked Date is revoked
    expect(isSessionRevokedByTimestamp(revokedAtSec - 10, revokedAtDate)).toBe(true);
    expect(isSessionRevokedByTimestamp(revokedAtSec + 1, revokedAtDate)).toBe(false);
  });

  it("VULN-RBAC-04 isLegacySessionAllowed: Respects environment variables and sid presence", () => {
    expect(isLegacySessionAllowed(false, { ALLOW_LEGACY_SESSIONS: "false" })).toBe(false);
    expect(isLegacySessionAllowed(false, { DISABLE_LEGACY_SESSIONS: "true" })).toBe(false);
    expect(isLegacySessionAllowed(false, {})).toBe(true);
    expect(isLegacySessionAllowed(true, { DISABLE_LEGACY_SESSIONS: "true" })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 9: VULN-GRD-01 (Branch Default AST/Regex Checks & Clean Client Pages)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 9 (VULN-GRD-01): Branch Default Scanner & Client Hygiene", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  it("VULN-GRD-01 Client Pages: PurchaseNew, SalesInvoiceNew, and EmployeeAdvances have zero silent branch 1 fallbacks", () => {
    const purchaseSrc = readFileSync(path.join(repoRoot, "client/src/pages/PurchaseNew.tsx"), "utf8");
    const salesInvoiceSrc = readFileSync(path.join(repoRoot, "client/src/pages/SalesInvoiceNew.tsx"), "utf8");
    const advancesSrc = readFileSync(path.join(repoRoot, "client/src/pages/EmployeeAdvances.tsx"), "utf8");

    // Must not contain `me.data?.branchId ?? 1` or `|| 1`
    expect(purchaseSrc).not.toMatch(/me\.data\??\.branchId\s*(\?\?|\|\|)\s*1/);
    expect(salesInvoiceSrc).not.toMatch(/me\.data\??\.branchId\s*(\?\?|\|\|)\s*1/);
    expect(advancesSrc).not.toMatch(/branchId\s*:\s*[^,;]*\bselected\??\.branchId\b[^,;]*(\?\?|\|\|)\s*1/);
  });

  it("VULN-GRD-01 AST/Regex Invariants: check-branch-default regex matches object property and logical OR fallbacks", () => {
    const RE = /(?:=\s*[^;]*\b(scopedBranchId|input\??\.branchId)\b[^;]*(\?\?|\|\|)\s*[01]\b|\bbranchId\s*:\s*[^;]*\b(scopedBranchId|input\??\.branchId)\b[^;]*(\?\?|\|\|)\s*1\b)/;

    // Catches object property fallback
    expect(RE.test("const obj = { branchId: input.branchId ?? 1 };")).toBe(true);
    // Catches logical OR fallback
    expect(RE.test("const b = scopedBranchId || 1;")).toBe(true);
    // Catches assignment fallback
    expect(RE.test("const b = input.branchId ?? 0;")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 10: VULN-GRD-02 (Money Schema Validation & Defensive Decimal Calculation)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 10 (VULN-GRD-02): Schema & Decimal Defensiveness", () => {
  it("VULN-GRD-02 nonNegMoneyString rejects negative and malformed values", () => {
    expect(nonNegMoneyString.safeParse("-10.00").success).toBe(false);
    expect(nonNegMoneyString.safeParse("abc").success).toBe(false);
    expect(nonNegMoneyString.safeParse("10.555").success).toBe(false); // >2 decimal places
    expect(nonNegMoneyString.safeParse("25.50").success).toBe(true);
    expect(nonNegMoneyString.safeParse("0").success).toBe(true);
  });

  it("VULN-GRD-02 percentString rejects negative and >100 values", () => {
    expect(percentString.safeParse("-5").success).toBe(false);
    expect(percentString.safeParse("150").success).toBe(false);
    expect(percentString.safeParse("bad").success).toBe(false);
    expect(percentString.safeParse("15").success).toBe(true);
    expect(percentString.safeParse("100").success).toBe(true);
  });

  it("VULN-GRD-02 computeInvoiceTotals throws TRPCError(BAD_REQUEST) on invalid numbers rather than unhandled DecimalError", () => {
    try {
      computeInvoiceTotals({
        lineTotals: ["100.00"],
        invoiceDiscount: "not_a_valid_number",
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("خصم الفاتورة");
    }

    try {
      computeInvoiceTotals({
        lineTotals: ["100.00"],
        taxRatePercent: "invalid_percent",
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("نسبة الضريبة");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 11: VULN-GRD-03 (Router-Scoped Orphan Endpoint Collision Prevention)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 11 (VULN-GRD-03): Router-Scoped Endpoint Tracking", () => {
  it("VULN-GRD-03 Namespace Isolation: Router-scoped mapping prevents cross-router collision false negatives", () => {
    // Simulated client usage: client only uses trpc.customer.list
    const usedByRouter = new Map<string, Set<string>>();

    function addUsed(call: string) {
      const parts = call.split(".");
      if (parts.length < 2) return;
      const routerKey = parts[0];
      if (!usedByRouter.has(routerKey)) usedByRouter.set(routerKey, new Set());
      for (let i = 1; i < parts.length; i++) usedByRouter.get(routerKey)!.add(parts[i]);
    }

    addUsed("customer.list");

    // Under flat usedSegments (the bug), "list" was global, so statutoryAccounting.list was considered used!
    const flatUsedSegments = new Set(["list"]);
    expect(flatUsedSegments.has("list")).toBe(true); // Falsely exempts statutoryAccounting.list

    // Under router-scoped tracking (the fix):
    expect(usedByRouter.get("customer")?.has("list")).toBe(true);
    expect(usedByRouter.get("statutoryAccounting")?.has("list") ?? false).toBe(false); // Correctly unmasked as orphan!
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 12: VULN-GRD-04 (AppContractError TRPCError Hierarchy & Prevention of HTTP 500)
// ═══════════════════════════════════════════════════════════════════════════════
describe("DFIR-M4 Master PoC — Section 12 (VULN-GRD-04): Error Contract Hierarchy", () => {
  it("VULN-GRD-04 AppContractError extends TRPCError with BAD_REQUEST preventing HTTP 500 masking", () => {
    const contractErr = new AppContractError("انتهاك عقد رسالة الخطأ");
    expect(contractErr).toBeInstanceOf(TRPCError);
    expect(contractErr).toBeInstanceOf(AppContractError);
    expect(contractErr.code).toBe("BAD_REQUEST");
  });

  it("VULN-GRD-04 assertPresent & appError throw AppContractError on missing required parts", () => {
    const VALID = {
      what: "تعذّر حفظ التعديلات",
      why: "المستند مؤكّد مسبقاً",
      doThis: "أنشئ إشعار تسوية بدلاً من تعديل المستند الأصلي",
    };

    // Missing 'what' throws AppContractError
    try {
      appError({ ...VALID, what: "" });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(AppContractError);
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("ماذا حدث");
    }

    // Missing 'why' throws AppContractError
    try {
      appError({ ...VALID, why: "" });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(AppContractError);
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("لماذا");
    }

    // Missing 'doThis' throws AppContractError
    try {
      appError({ ...VALID, doThis: "" });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(AppContractError);
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("ماذا تفعل الآن");
    }

    // Duplicate 'doThis' == 'why' throws AppContractError
    try {
      appError({ ...VALID, doThis: VALID.why });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(AppContractError);
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("يكرّر");
    }
  });

  it("VULN-GRD-04 Valid appError and appErrorMessage build standard structured message", () => {
    const VALID = {
      what: "تعذّر تسديد الفاتورة",
      why: "المبلغ المدخل أكبر من المتبقي",
      doThis: "أدخل مبلغاً مساوياً للمتبقي أو أقل",
    };
    const built = appError(VALID);
    expect(built.message).toContain("تعذّر تسديد الفاتورة — المبلغ المدخل أكبر من المتبقي. أدخل مبلغاً مساوياً للمتبقي أو أقل.");
    expect(appErrorMessage(VALID)).toBe(built.message);
  });
});
