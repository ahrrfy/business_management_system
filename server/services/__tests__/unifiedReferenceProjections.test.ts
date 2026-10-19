/**
 * server/services/__tests__/empiricalQueryProjectionsChallenger.test.ts
 *
 * EMPIRICAL CHALLENGER TEST SUITE (Milestone 3 - Challenger 2)
 *
 * Objectives:
 * 1. Empirically verify `movementsRich` query:
 *    - Insert inventory movements with various reference types (INVOICE, WORK_ORDER, PURCHASE_ORDER, TRANSFER).
 *    - Query `movementsRich` with search filter `q` / `pat` matching `documentNumber`.
 *    - Verify filtering by document number works cleanly (exact, partial, suffix, SQL escaping).
 *    - Verify that projected rows include `documentNumber`.
 * 2. Empirically verify Treasury movements query (`getRecentMovements`):
 *    - Verify that rows correctly project `invoiceNumber` and `workOrderNumber`.
 *    - Verify that the card machine `referenceNumber` is preserved, isolated, and NOT overridden or conflated.
 * 3. Empirically verify Customer Statement payments query (`getCustomerStatement`):
 *    - Verify that payments on invoices return `invoiceNumber`.
 *    - Verify that the correct `INV-...` badge string is produced without duplication or integer ID leaks.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx, type Actor } from "../tx";
import { appRouter } from "../../routers";
import { getRecentMovements } from "../treasury/movements";
import { getCustomerStatement } from "../reports/arAging";

const adminActor: Actor = { userId: 1, branchId: 1, role: "admin" };

function makeCtx(user: any) {
  const res = { cookie() {}, clearCookie() {} };
  const req = { headers: {} as Record<string, string> };
  return { req, res, user } as any;
}

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function cleanAndSeed() {
  await withTx(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    const tables = [
      "inventoryMovements",
      "receipts",
      "expenses",
      "invoices",
      "invoiceItems",
      "workOrders",
      "branchStock",
      "productPrices",
      "productUnits",
      "productVariants",
      "products",
      "shifts",
      "customers",
      "suppliers",
      "branches",
      "users",
    ];
    for (const t of tables) {
      await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    }
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    // 1. Branches
    await tx.insert(s.branches).values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ]);

    // 2. Users
    await tx.insert(s.users).values([
      {
        id: 1,
        openId: "admin-u1",
        name: "مدير النظام",
        email: "admin@test.local",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
    ]);

    // 3. Customer
    await tx.insert(s.customers).values([
      {
        id: 10,
        name: "شركة النور للطباعة",
        phone: "07700000010",
        creditLimit: "5000000.00",
        currentBalance: "0.00",
      },
    ]);

    // 4. Products & Variants & Units
    await tx.insert(s.products).values({ id: 1, name: "ورق طباعة A4", isService: false });
    await tx.insert(s.productVariants).values({
      id: 1,
      productId: 1,
      sku: "PAP-A4-01",
      costPrice: "5000.00",
    });
    await tx.insert(s.productUnits).values([
      { id: 1, variantId: 1, unitName: "ماDesk", conversionFactor: "1", isBaseUnit: true, isActive: true },
    ]);

    // 5. Shift
    await tx.insert(s.shifts).values([
      {
        id: 1,
        userId: 1,
        branchId: 1,
        shiftNumber: "SHIFT-2026-001",
        status: "OPEN",
        startingCash: "0.00",
      },
    ]);
  });
}

beforeEach(async () => {
  await cleanAndSeed();
});

describe("EMPIRICAL CHALLENGER: UI Query Projections & Human Reference Integrity", () => {
  describe("1. Inventory Movements (`movementsRich` Query & documentNumber Search)", () => {
    it("EMP-MOV-01: Projected rows expose documentNumber across all reference types without leakage", async () => {
      const d = db();
      const now = new Date();

      // Insert movements across various reference types
      await d.insert(s.inventoryMovements).values([
        {
          id: 101,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 5,
          signedDelta: -5,
          referenceType: "INVOICE",
          referenceId: 501,
          documentNumber: "100010",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 102,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 3,
          signedDelta: -3,
          referenceType: "WORK_ORDER",
          referenceId: 602,
          documentNumber: "100011-1",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 103,
          variantId: 1,
          branchId: 1,
          movementType: "IN",
          quantity: 20,
          signedDelta: 20,
          referenceType: "PURCHASE_ORDER",
          referenceId: 703,
          documentNumber: "100012",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 104,
          variantId: 1,
          branchId: 1,
          movementType: "TRANSFER_OUT",
          quantity: 2,
          signedDelta: -2,
          referenceType: "TRANSFER",
          referenceId: 804,
          relatedBranchId: 2,
          documentNumber: "100013",
          createdBy: 1,
          createdAt: now,
        },
        // Historical movement without documentNumber
        {
          id: 105,
          variantId: 1,
          branchId: 1,
          movementType: "IN",
          quantity: 10,
          signedDelta: 10,
          referenceType: "INVOICE",
          referenceId: 905,
          documentNumber: null,
          createdBy: 1,
          createdAt: now,
        },
      ]);

      const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));
      const result = await caller.inventory.movementsRich({ limit: 50 });

      expect(result.rows.length).toBe(5);

      const mapByDoc = new Map(result.rows.map((r) => [r.documentNumber, r]));

      const invRow = mapByDoc.get("100010");
      expect(invRow).toBeDefined();
      expect(invRow?.referenceType).toBe("INVOICE");
      expect(invRow?.referenceId).toBe(501);

      const woRow = mapByDoc.get("100011-1");
      expect(woRow).toBeDefined();
      expect(woRow?.referenceType).toBe("WORK_ORDER");
      expect(woRow?.referenceId).toBe(602);

      const poRow = mapByDoc.get("100012");
      expect(poRow).toBeDefined();
      expect(poRow?.referenceType).toBe("PURCHASE_ORDER");
      expect(poRow?.referenceId).toBe(703);

      const trRow = mapByDoc.get("100013");
      expect(trRow).toBeDefined();
      expect(trRow?.referenceType).toBe("TRANSFER");
      expect(trRow?.referenceId).toBe(804);
      expect(trRow?.relatedBranchId).toBe(2);

      const nullRow = mapByDoc.get(null);
      expect(nullRow).toBeDefined();
      expect(nullRow?.referenceId).toBe(905);
      expect(nullRow?.documentNumber).toBeNull();
    });

    it("EMP-MOV-02: Search filter `q` matches documentNumber cleanly for each reference type", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.inventoryMovements).values([
        {
          id: 201,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 1,
          signedDelta: -1,
          referenceType: "INVOICE",
          referenceId: 11,
          documentNumber: "100010",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 202,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 1,
          signedDelta: -1,
          referenceType: "WORK_ORDER",
          referenceId: 22,
          documentNumber: "100011-1",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 203,
          variantId: 1,
          branchId: 1,
          movementType: "IN",
          quantity: 1,
          signedDelta: 1,
          referenceType: "PURCHASE_ORDER",
          referenceId: 33,
          documentNumber: "100012",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 204,
          variantId: 1,
          branchId: 1,
          movementType: "TRANSFER_OUT",
          quantity: 1,
          signedDelta: -1,
          referenceType: "TRANSFER",
          referenceId: 44,
          documentNumber: "100013",
          createdBy: 1,
          createdAt: now,
        },
      ]);

      const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));

      // 1. Search INVOICE documentNumber
      const invSearch = await caller.inventory.movementsRich({ q: "100010" });
      expect(invSearch.rows.length).toBe(1);
      expect(invSearch.rows[0].documentNumber).toBe("100010");
      expect(invSearch.rows[0].referenceType).toBe("INVOICE");

      // 2. Search WORK_ORDER suffix documentNumber
      const woSearch = await caller.inventory.movementsRich({ q: "100011-1" });
      expect(woSearch.rows.length).toBe(1);
      expect(woSearch.rows[0].documentNumber).toBe("100011-1");
      expect(woSearch.rows[0].referenceType).toBe("WORK_ORDER");

      // 3. Search PURCHASE_ORDER documentNumber
      const poSearch = await caller.inventory.movementsRich({ q: "100012" });
      expect(poSearch.rows.length).toBe(1);
      expect(poSearch.rows[0].documentNumber).toBe("100012");
      expect(poSearch.rows[0].referenceType).toBe("PURCHASE_ORDER");

      // 4. Search TRANSFER documentNumber
      const trSearch = await caller.inventory.movementsRich({ q: "100013" });
      expect(trSearch.rows.length).toBe(1);
      expect(trSearch.rows[0].documentNumber).toBe("100013");
      expect(trSearch.rows[0].referenceType).toBe("TRANSFER");

      // 5. Non-existent documentNumber returns empty set
      const emptySearch = await caller.inventory.movementsRich({ q: "999999" });
      expect(emptySearch.rows.length).toBe(0);
      expect(emptySearch.total).toBe(0);
    });

    it("EMP-MOV-03: Sibling suffixes and partial pattern matching distinguish documents accurately", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.inventoryMovements).values([
        {
          id: 301,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 2,
          signedDelta: -2,
          referenceType: "WORK_ORDER",
          referenceId: 301,
          documentNumber: "100020-1",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 302,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 3,
          signedDelta: -3,
          referenceType: "WORK_ORDER",
          referenceId: 302,
          documentNumber: "100020-2",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 303,
          variantId: 1,
          branchId: 1,
          movementType: "IN",
          quantity: 10,
          signedDelta: 10,
          referenceType: "INVOICE",
          referenceId: 303,
          documentNumber: "100020",
          createdBy: 1,
          createdAt: now,
        },
      ]);

      const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));

      // Specific suffix -1 matches only -1
      const resSuffix1 = await caller.inventory.movementsRich({ q: "100020-1" });
      expect(resSuffix1.rows.length).toBe(1);
      expect(resSuffix1.rows[0].documentNumber).toBe("100020-1");

      // Specific suffix -2 matches only -2
      const resSuffix2 = await caller.inventory.movementsRich({ q: "100020-2" });
      expect(resSuffix2.rows.length).toBe(1);
      expect(resSuffix2.rows[0].documentNumber).toBe("100020-2");

      // Base number matches base document AND all sibling children
      const resBase = await caller.inventory.movementsRich({ q: "100020" });
      expect(resBase.rows.length).toBe(3);
      const docs = resBase.rows.map((r) => r.documentNumber).sort();
      expect(docs).toEqual(["100020", "100020-1", "100020-2"]);
    });

    it("EMP-MOV-04: SQL wildcard characters in document numbers are properly escaped", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.inventoryMovements).values([
        {
          id: 401,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 1,
          signedDelta: -1,
          referenceType: "INVOICE",
          referenceId: 401,
          documentNumber: "DOC_100",
          createdBy: 1,
          createdAt: now,
        },
        {
          id: 402,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 1,
          signedDelta: -1,
          referenceType: "INVOICE",
          referenceId: 402,
          documentNumber: "DOCX100",
          createdBy: 1,
          createdAt: now,
        },
      ]);

      const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));

      // Without escaping, 'DOC_100' would match 'DOCX100' because '_' is a single-character wildcard.
      // With proper escaping, it MUST match only 'DOC_100'.
      const searchRes = await caller.inventory.movementsRich({ q: "DOC_100" });
      expect(searchRes.rows.length).toBe(1);
      expect(searchRes.rows[0].documentNumber).toBe("DOC_100");
    });
  });

  describe("2. Treasury Movements (`getRecentMovements` & Reference Isolation)", () => {
    it("EMP-TRS-01: Correctly projects invoiceNumber and preserves card machine referenceNumber", async () => {
      const d = db();
      const now = new Date();

      // Create an invoice
      await d.insert(s.invoices).values({
        id: 50,
        invoiceNumber: "100030",
        sourceType: "POS",
        branchId: 1,
        shiftId: 1,
        customerId: 10,
        subtotal: "75000.00",
        total: "75000.00",
        paidAmount: "75000.00",
        status: "PAID",
      });

      // Create a receipt paying this invoice via card terminal
      await d.insert(s.receipts).values({
        id: 701,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "75000.00",
        paymentMethod: "CARD",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "AUTH-POS-987654", // Card machine slip authorization code
        invoiceId: 50,
        createdBy: 1,
        partyType: "CUSTOMER",
        partyId: 10,
        createdAt: now,
      });

      const movements = await getRecentMovements(
        { branchId: 1, limit: 10 },
        { scopedBranchId: null, role: "admin", userId: 1 },
      );

      const target = movements.find((m) => m.rawId === 701);
      expect(target).toBeDefined();

      // Invariants:
      // 1. invoiceNumber must be resolved from the invoices table ("100030")
      expect(target?.invoiceNumber).toBe("100030");
      expect(target?.invoiceId).toBe(50);

      // 2. referenceNumber must remain the exact card slip authorization code
      expect(target?.referenceNumber).toBe("AUTH-POS-987654");

      // 3. Document number and payment card reference must NEVER overwrite each other
      expect(target?.invoiceNumber).not.toBe(target?.referenceNumber);

      // 4. Provenance payload includes docType: "invoice" with docNumber: "100030"
      expect(target?.provenance?.docRefs).toBeDefined();
      const invDocRef = target?.provenance?.docRefs.find((r) => r.docType === "invoice");
      expect(invDocRef).toBeDefined();
      expect(invDocRef?.docNumber).toBe("100030");
      expect(invDocRef?.docNumber).not.toBe("AUTH-POS-987654");
    });

    it("EMP-TRS-02: Correctly projects workOrderNumber and isolates payment reference", async () => {
      const d = db();
      const now = new Date();

      // Create a work order
      await d.insert(s.workOrders).values({
        id: 60,
        orderNumber: "100031-1",
        branchId: 1,
        customerId: 10,
        title: "طباعة دروع تخرج",
        salePrice: "25000.00",
      });

      // Create a deposit receipt for this work order
      await d.insert(s.receipts).values({
        id: 702,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "25000.00",
        paymentMethod: "CARD",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "AUTH-WO-456123",
        workOrderId: 60,
        createdBy: 1,
        partyType: "CUSTOMER",
        partyId: 10,
        createdAt: now,
      });

      const movements = await getRecentMovements(
        { branchId: 1, limit: 10 },
        { scopedBranchId: null, role: "admin", userId: 1 },
      );

      const target = movements.find((m) => m.rawId === 702);
      expect(target).toBeDefined();

      expect(target?.workOrderNumber).toBe("100031-1");
      expect(target?.workOrderId).toBe(60);
      expect(target?.referenceNumber).toBe("AUTH-WO-456123");
      expect(target?.invoiceNumber).toBeNull();

      const woDocRef = target?.provenance?.docRefs.find((r) => r.docType === "work_order");
      expect(woDocRef).toBeDefined();
      expect(woDocRef?.docNumber).toBe("100031-1");
      expect(woDocRef?.docNumber).not.toBe("AUTH-WO-456123");
    });

    it("EMP-TRS-03: Projects both invoiceNumber and workOrderNumber when both are linked", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.invoices).values({
        id: 70,
        invoiceNumber: "100032",
        sourceType: "WORKORDER",
        branchId: 1,
        shiftId: 1,
        customerId: 10,
        subtotal: "120000.00",
        total: "120000.00",
        paidAmount: "120000.00",
        status: "PAID",
      });

      await d.insert(s.workOrders).values({
        id: 71,
        orderNumber: "100032-1",
        branchId: 1,
        customerId: 10,
        title: "بروشورات مؤتمر",
        salePrice: "120000.00",
      });

      await d.insert(s.receipts).values({
        id: 703,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "120000.00",
        paymentMethod: "CARD",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "AUTH-DUAL-789",
        invoiceId: 70,
        workOrderId: 71,
        createdBy: 1,
        partyType: "CUSTOMER",
        partyId: 10,
        createdAt: now,
      });

      const movements = await getRecentMovements(
        { branchId: 1, limit: 10 },
        { scopedBranchId: null, role: "admin", userId: 1 },
      );

      const target = movements.find((m) => m.rawId === 703);
      expect(target).toBeDefined();

      expect(target?.invoiceNumber).toBe("100032");
      expect(target?.workOrderNumber).toBe("100032-1");
      expect(target?.referenceNumber).toBe("AUTH-DUAL-789");
    });

    it("EMP-TRS-04: Standalone receipt preserves referenceNumber with null invoice/workOrder numbers", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.receipts).values({
        id: 704,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "15000.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "MANUAL-REC-999",
        invoiceId: null,
        workOrderId: null,
        createdBy: 1,
        partyType: "OTHER",
        createdAt: now,
      });

      const movements = await getRecentMovements(
        { branchId: 1, limit: 10 },
        { scopedBranchId: null, role: "admin", userId: 1 },
      );

      const target = movements.find((m) => m.rawId === 704);
      expect(target).toBeDefined();

      expect(target?.referenceNumber).toBe("MANUAL-REC-999");
      expect(target?.invoiceNumber).toBeNull();
      expect(target?.workOrderNumber).toBeNull();
    });
  });

  describe("3. Customer Statement (`getCustomerStatement` & Badge Formatting)", () => {
    it("EMP-CST-01: Statement payment resolves invoiceNumber and generates clean INV-... badge", async () => {
      const d = db();
      const now = new Date();

      // Create an invoice with unified tracking number
      await d.insert(s.invoices).values({
        id: 80,
        invoiceNumber: "100040",
        sourceType: "POS",
        branchId: 1,
        shiftId: 1,
        customerId: 10,
        subtotal: "100000.00",
        total: "100000.00",
        paidAmount: "60000.00",
        status: "PARTIALLY_PAID",
      });

      // Create a receipt payment linked to this invoice
      await d.insert(s.receipts).values({
        id: 801,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "60000.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        invoiceId: 80,
        createdBy: 1,
        partyType: "CUSTOMER",
        partyId: 10,
        createdAt: now,
      });

      const statement = await getCustomerStatement(10);
      expect(statement).not.toBeNull();

      const pay = statement?.payments.find((p) => p.id === 801);
      expect(pay).toBeDefined();

      // 1. invoiceNumber must be resolved from invoices table
      expect(pay?.invoiceNumber).toBe("100040");
      expect(pay?.invoiceId).toBe(80);

      // 2. UI badge formatter rule:
      // p.invoiceNumber.startsWith("INV-") ? p.invoiceNumber : `INV-${p.invoiceNumber}`
      const badgeDisplay = pay?.invoiceNumber
        ? pay.invoiceNumber.startsWith("INV-")
          ? pay.invoiceNumber
          : `INV-${pay.invoiceNumber}`
        : pay?.invoiceId
        ? `#${pay.invoiceId}`
        : `#${pay?.id}`;

      expect(badgeDisplay).toBe("INV-100040");
      expect(badgeDisplay).not.toContain("#80");

      // 3. Provenance docRef test
      const invRef = pay?.provenance?.docRefs?.find((r) => r.docType === "invoice");
      expect(invRef).toBeDefined();
      expect(invRef?.docNumber).toBe("INV-100040");
    });

    it("EMP-CST-02: Historical legacy invoice with INV- prefix does not duplicate prefix", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.invoices).values({
        id: 81,
        invoiceNumber: "INV-2026-LEGACY-01",
        sourceType: "POS",
        branchId: 1,
        shiftId: 1,
        customerId: 10,
        subtotal: "40000.00",
        total: "40000.00",
        paidAmount: "40000.00",
        status: "PAID",
      });

      await d.insert(s.receipts).values({
        id: 802,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "40000.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        invoiceId: 81,
        createdBy: 1,
        partyType: "CUSTOMER",
        partyId: 10,
        createdAt: now,
      });

      const statement = await getCustomerStatement(10);
      const pay = statement?.payments.find((p) => p.id === 802);
      expect(pay).toBeDefined();

      expect(pay?.invoiceNumber).toBe("INV-2026-LEGACY-01");

      const badgeDisplay = pay?.invoiceNumber
        ? pay.invoiceNumber.startsWith("INV-")
          ? pay.invoiceNumber
          : `INV-${pay.invoiceNumber}`
        : pay?.invoiceId
        ? `#${pay.invoiceId}`
        : `#${pay?.id}`;

      // Must NOT become INV-INV-2026-LEGACY-01
      expect(badgeDisplay).toBe("INV-2026-LEGACY-01");
    });

    it("EMP-CST-03: Multiple partial payments on the same invoice share the identical invoiceNumber", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.invoices).values({
        id: 82,
        invoiceNumber: "100042",
        sourceType: "POS",
        branchId: 1,
        shiftId: 1,
        customerId: 10,
        subtotal: "150000.00",
        total: "150000.00",
        paidAmount: "100000.00",
        status: "PARTIALLY_PAID",
      });

      await d.insert(s.receipts).values([
        {
          id: 803,
          branchId: 1,
          shiftId: 1,
          direction: "IN",
          amount: "50000.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          invoiceId: 82,
          createdBy: 1,
          partyType: "CUSTOMER",
          partyId: 10,
          createdAt: new Date(now.getTime() - 60000),
        },
        {
          id: 804,
          branchId: 1,
          shiftId: 1,
          direction: "IN",
          amount: "50000.00",
          paymentMethod: "CARD",
          cashBucket: "DRAWER",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          invoiceId: 82,
          createdBy: 1,
          partyType: "CUSTOMER",
          partyId: 10,
          createdAt: now,
        },
      ]);

      const statement = await getCustomerStatement(10);
      const matched = statement?.payments.filter((p) => p.invoiceId === 82);

      expect(matched?.length).toBe(2);
      expect(matched?.[0].invoiceNumber).toBe("100042");
      expect(matched?.[1].invoiceNumber).toBe("100042");
    });

    it("EMP-CST-04: Standalone payment without invoice is marked isStandalone with null invoiceNumber", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.receipts).values({
        id: 805,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "30000.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        voucherNumber: "VOUCH-ADVANCE-01",
        invoiceId: null,
        createdBy: 1,
        partyType: "CUSTOMER",
        partyId: 10,
        createdAt: now,
      });

      const statement = await getCustomerStatement(10);
      const pay = statement?.payments.find((p) => p.id === 805);
      expect(pay).toBeDefined();

      expect(pay?.isStandalone).toBe(true);
      expect(pay?.invoiceNumber).toBeNull();
      expect(pay?.invoiceId).toBeNull();
      expect(pay?.voucherNumber).toBe("VOUCH-ADVANCE-01");
    });

    it("EMP-CST-05: Synthetic statement payments (COD, RETURN) include invoiceNumber from invoices table", async () => {
      const d = db();
      const now = new Date();

      await d.insert(s.invoices).values({
        id: 83,
        invoiceNumber: "100043",
        sourceType: "POS",
        branchId: 1,
        shiftId: 1,
        customerId: 10,
        subtotal: "80000.00",
        total: "80000.00",
        paidAmount: "50000.00",
        returnedTotal: "30000.00",
        status: "PAID",
      });

      await d.insert(s.accountingEntries).values([
        {
          id: 9001,
          entryDate: now,
          entryType: "PAYMENT_IN",
          branchId: 1,
          customerId: 10,
          invoiceId: 83,
          receiptId: null,
          amount: "50000.00",
          notes: "تحصيل مندوب التوصيل",
          createdBy: 1,
        },
        {
          id: 9002,
          entryDate: now,
          entryType: "RETURN",
          branchId: 1,
          customerId: 10,
          invoiceId: 83,
          receiptId: null,
          amount: "-30000.00",
          notes: "مرتجع مبيعات آجلة",
          createdBy: 1,
        },
      ]);

      const statement = await getCustomerStatement(10);
      const codPay = statement?.payments.find((p) => p.paymentMethod === "COD" && p.invoiceId === 83);
      const retPay = statement?.payments.find((p) => p.paymentMethod === "RETURN" && p.invoiceId === 83);

      expect(codPay?.invoiceNumber).toBe("100043");
      expect(codPay?.provenance?.docRefs?.find((r) => r.docType === "invoice")?.docNumber).toBe("INV-100043");
      expect(retPay?.invoiceNumber).toBe("100043");
      expect(retPay?.provenance?.docRefs?.find((r) => r.docType === "invoice")?.docNumber).toBe("INV-100043");
    });
  });
});
