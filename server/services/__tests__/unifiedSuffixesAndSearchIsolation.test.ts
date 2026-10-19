/**
 * server/services/__tests__/challengerM5SuffixesSearchIsolation.test.ts
 *
 * Tier 5 White-Box Adversarial Hardening:
 * Suffixes, Concurrent Candidate Collision Safety, Malformed Inputs & Search Isolation,
 * and AnomalyWatch D6 Sequence Gap Tamper Detection.
 *
 * Role: challenger_m5_2 (Milestone 5 Adversarial Challenger 2)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql, eq, or } from "drizzle-orm";
import { getDb } from "../../db";
import {
  branches,
  customers,
  suppliers,
  invoices,
  workOrders,
  purchaseOrders,
  receptionDrafts,
  onlineOrders,
  deliveryConsignments,
  quotations,
  expenses,
  users,
} from "../../../drizzle/schema";
import {
  formatDocumentNumber,
  stripDocPrefix,
  docBarcode,
} from "@shared/documentNumber";
import {
  resolveDeliveryInvoiceNumber,
  resolveConsignmentNumber,
} from "../workOrder/helpers";
import {
  verifyPayload,
  extractVerificationCode,
} from "../barcodeService";
import {
  searchInvoices,
  searchWorkOrders,
  searchQuotations,
  searchPurchaseOrders,
  searchExpenses,
} from "../globalSearch/searchDocuments";
import { globalSearch } from "../globalSearch/orchestrator";
import { getAnomalyWatch } from "../reports/anomalyWatch";

function getActiveDb() {
  const d = getDb();
  if (!d) {
    throw new Error("Active database connection required for empirical stress verification");
  }
  return d;
}

const BRANCH_MAIN = 1;
const BRANCH_SALES = 2;
const TEST_CUST_ID = 8901;
const TEST_SUPP_ID = 8902;
const TEST_USER_ID = 8903;

async function setupBaseFixtures(d: ReturnType<typeof getActiveDb>) {
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

  await d
    .insert(branches)
    .values([
      { id: BRANCH_MAIN, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: BRANCH_SALES, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ])
    .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)` } });

  await d
    .insert(users)
    .values({
      id: TEST_USER_ID,
      openId: "challenger_admin",
      name: "Challenger Admin",
      role: "admin",
      loginMethod: "local",
      branchId: BRANCH_MAIN,
      isOwner: true,
    })
    .onDuplicateKeyUpdate({ set: { name: "Challenger Admin" } });

  await d
    .insert(customers)
    .values({
      id: TEST_CUST_ID,
      name: "Challenger Test Customer",
      phone: "+9647701112233",
    })
    .onDuplicateKeyUpdate({ set: { name: "Challenger Test Customer" } });

  await d
    .insert(suppliers)
    .values({
      id: TEST_SUPP_ID,
      name: "Challenger Test Supplier",
      phone: "+9647704445566",
    })
    .onDuplicateKeyUpdate({ set: { name: "Challenger Test Supplier" } });

  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

describe("Tier 5 Challenger Hardening: Suffixes, Malformed Inputs & Search Isolation", () => {
  // =========================================================================
  // 1. HIGH SIBLING SUFFIX GENERATION & DEEP HYPHEN STRUCTURES
  // =========================================================================
  describe("1. High Sibling Suffix Generation & Deep Hyphens", () => {
    it("ADV-SUF-01: formatDocumentNumber handles standard, high suffixes up to -100, and -999", () => {
      expect(formatDocumentNumber("100001", 0)).toBe("100001");
      expect(formatDocumentNumber("100001", undefined)).toBe("100001");
      expect(formatDocumentNumber("100001", 1)).toBe("100001-1");
      expect(formatDocumentNumber("100001", 2)).toBe("100001-2");
      expect(formatDocumentNumber("100001", 50)).toBe("100001-50");
      expect(formatDocumentNumber("100001", 100)).toBe("100001-100");
      expect(formatDocumentNumber("100001", 999)).toBe("100001-999");
      expect(formatDocumentNumber("100001", 10000)).toBe("100001-10000");
    });

    it("ADV-SUF-02: formatDocumentNumber rejects malformed, float, NaN, and negative indices safely", () => {
      expect(formatDocumentNumber("100001", -1)).toBe("100001");
      expect(formatDocumentNumber("100001", -100)).toBe("100001");
      expect(formatDocumentNumber("100001", -0)).toBe("100001");
      expect(formatDocumentNumber("100001", 1.5)).toBe("100001");
      expect(formatDocumentNumber("100001", 99.99)).toBe("100001");
      expect(formatDocumentNumber("100001", NaN)).toBe("100001");
      expect(formatDocumentNumber("100001", Infinity)).toBe("100001");
      expect(formatDocumentNumber("100001", -Infinity)).toBe("100001");
      expect(formatDocumentNumber("100001", null as any)).toBe("100001");
      expect(formatDocumentNumber("100001", "2" as any)).toBe("100001");
    });

    it("ADV-SUF-03: formatDocumentNumber handles deep hyphen structures in base tracking numbers", () => {
      // Base containing one hyphen (e.g. 100001-1)
      expect(formatDocumentNumber("100001-1", 1)).toBe("100001-1-1");
      expect(formatDocumentNumber("100001-1", 2)).toBe("100001-1-2");
      // Base containing deep hyphens (e.g. 100001-1-1)
      expect(formatDocumentNumber("100001-1-1", 3)).toBe("100001-1-1-3");
      // Base containing deep hyphens without suffix
      expect(formatDocumentNumber("100001-1-1", 0)).toBe("100001-1-1");
      expect(formatDocumentNumber("100001-1-1", undefined)).toBe("100001-1-1");
    });

    it("ADV-SUF-04: formatDocumentNumber safely treats empty and whitespace base strings", () => {
      expect(formatDocumentNumber("")).toBe("");
      expect(formatDocumentNumber("", 1)).toBe("");
      expect(formatDocumentNumber("   ")).toBe("");
      expect(formatDocumentNumber("   ", 2)).toBe("");
      expect(formatDocumentNumber(null as any)).toBe("");
      expect(formatDocumentNumber(null as any, 3)).toBe("");
      expect(formatDocumentNumber(undefined as any)).toBe("");
      expect(formatDocumentNumber(undefined as any, 4)).toBe("");
    });

    it("ADV-SUF-05: stripDocPrefix strips prefixes across high suffixes and deep hyphen structures", () => {
      // High suffixes up to -100 and beyond
      expect(stripDocPrefix("INV-100001-100")).toBe("100001-100");
      expect(stripDocPrefix("WO-100001-100")).toBe("100001-100");
      expect(stripDocPrefix("PO-100001-500")).toBe("100001-500");
      expect(stripDocPrefix("DRF-100001-9999")).toBe("100001-9999");

      // Deep hyphen structures
      expect(stripDocPrefix("INV-100001-1-1")).toBe("100001-1-1");
      expect(stripDocPrefix("WO-100001-1-1")).toBe("100001-1-1");
      expect(stripDocPrefix("WO-100001-2-1-3")).toBe("100001-2-1-3");

      // Case insensitivity & whitespace trimming
      expect(stripDocPrefix("inv-100001-100")).toBe("100001-100");
      expect(stripDocPrefix("  WO-100001-1-1  ")).toBe("100001-1-1");
      expect(stripDocPrefix("drf-100001-50")).toBe("100001-50");

      // Historical document preservation (MUST NOT be stripped)
      expect(stripDocPrefix("INV-1-20260818-00073")).toBe("INV-1-20260818-00073");
      expect(stripDocPrefix("WO-2-20260818-00012")).toBe("WO-2-20260818-00012");

      // Full DOC_PREFIXES support
      expect(stripDocPrefix("RET-100001-1")).toBe("100001-1");
      expect(stripDocPrefix("PAY-100001-2")).toBe("100001-2");
      expect(stripDocPrefix("REC-100001-3")).toBe("100001-3");
    });

    it("ADV-SUF-06: docBarcode creates and preserves barcode strings for high suffixes and deep hyphens", () => {
      expect(docBarcode("INV", "100001-100")).toBe("INV-100001-100");
      expect(docBarcode("WO", "100001-1-1")).toBe("WO-100001-1-1");
      // Idempotency: already prefixed
      expect(docBarcode("INV", "INV-100001-100")).toBe("INV-100001-100");
      expect(docBarcode("inv", "INV-100001-100")).toBe("INV-100001-100");
      expect(docBarcode("WO", "wo-100001-1-1")).toBe("wo-100001-1-1");
      // Empty & whitespace handling
      expect(docBarcode("INV", "")).toBe("");
      expect(docBarcode("INV", "   ")).toBe("");
    });
  });

  // =========================================================================
  // 2. SUFFIX COLLISION SAFETY & CONCURRENT CANDIDATE RESOLUTION
  // =========================================================================
  describe("2. Suffix Collision Safety & Concurrent Sibling Deliveries", () => {
    const COLLISION_BASE = "771000";

    beforeEach(async () => {
      const d = getActiveDb();
      await setupBaseFixtures(d);

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      // Clean test collision space
      await d.execute(sql`
        DELETE FROM invoices WHERE invoiceNumber = ${COLLISION_BASE} OR invoiceNumber LIKE ${`${COLLISION_BASE}-%`}
      `);
      await d.execute(sql`
        DELETE FROM deliveryConsignments WHERE consignmentNumber = ${COLLISION_BASE} OR consignmentNumber LIKE ${`${COLLISION_BASE}-%`}
      `);
      await d.execute(sql`
        DELETE FROM workOrders WHERE orderNumber = ${COLLISION_BASE} OR orderNumber LIKE ${`${COLLISION_BASE}-%`}
      `);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    });

    it("ADV-COL-01: Candidate resolution picks 100001-3 when 100001, 100001-1, 100001-2 already exist", async () => {
      const d = getActiveDb();
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

      // Seed existing sibling invoices: 771000, 771000-1, 771000-2
      await d.insert(invoices).values([
        {
          invoiceNumber: COLLISION_BASE,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "10000.00",
          total: "10000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
        {
          invoiceNumber: `${COLLISION_BASE}-1`,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "12000.00",
          total: "12000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
        {
          invoiceNumber: `${COLLISION_BASE}-2`,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "15000.00",
          total: "15000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
      ]);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      // Calling resolveDeliveryInvoiceNumber inside transaction for WO-771000
      let resolvedNumber = "";
      await d.transaction(async (tx) => {
        resolvedNumber = await resolveDeliveryInvoiceNumber(tx, `WO-${COLLISION_BASE}`, BRANCH_MAIN);
      });

      // MUST pick 771000-3
      expect(resolvedNumber).toBe(`${COLLISION_BASE}-3`);
    });

    it("ADV-COL-02: Deep sibling scale: candidate resolution scales to -100 without loop exhaustion or gap collisions", async () => {
      const d = getActiveDb();
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

      // Insert base and siblings 1 through 99
      const rowsToInsert = [
        {
          invoiceNumber: COLLISION_BASE,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "1000.00",
          total: "1000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
      ];
      for (let i = 1; i <= 99; i++) {
        rowsToInsert.push({
          invoiceNumber: `${COLLISION_BASE}-${i}`,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "1000.00",
          total: "1000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        });
      }
      await d.insert(invoices).values(rowsToInsert);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      let nextResolved = "";
      await d.transaction(async (tx) => {
        nextResolved = await resolveDeliveryInvoiceNumber(tx, COLLISION_BASE, BRANCH_MAIN);
      });

      // Candidate resolution must find 771000-100 without failure
      expect(nextResolved).toBe(`${COLLISION_BASE}-100`);
    });

    it("ADV-COL-03: Concurrent deliveries with existing siblings safely resolve 100001-3 and 100001-4 without ER_DUP_ENTRY", async () => {
      const d = getActiveDb();
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

      // Seed existing siblings: 771000, 771000-1, 771000-2
      await d.insert(invoices).values([
        {
          invoiceNumber: COLLISION_BASE,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "5000.00",
          total: "5000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
        {
          invoiceNumber: `${COLLISION_BASE}-1`,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "5000.00",
          total: "5000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
        {
          invoiceNumber: `${COLLISION_BASE}-2`,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "5000.00",
          total: "5000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
      ]);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      // Attempt two parallel concurrent transactions attempting to deliver orders for COLLISION_BASE
      let num1 = "";
      let num2 = "";
      let err1: any = null;
      let err2: any = null;

      const p1 = d
        .transaction(async (tx1) => {
          await tx1.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
          num1 = await resolveDeliveryInvoiceNumber(tx1, `WO-${COLLISION_BASE}`, BRANCH_MAIN);
          // Simulate some processing delay to stress concurrency
          await new Promise((r) => setTimeout(r, 40));
          await tx1.insert(invoices).values({
            invoiceNumber: num1,
            branchId: BRANCH_MAIN,
            customerId: TEST_CUST_ID,
            invoiceDate: new Date("2026-10-19"),
            subtotal: "6000.00",
            total: "6000.00",
            invoiceStatus: "PAID",
            createdBy: TEST_USER_ID,
          });
        })
        .catch((e) => {
          err1 = e;
        });

      const p2 = d
        .transaction(async (tx2) => {
          await tx2.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
          num2 = await resolveDeliveryInvoiceNumber(tx2, `WO-${COLLISION_BASE}`, BRANCH_MAIN);
          await new Promise((r) => setTimeout(r, 40));
          await tx2.insert(invoices).values({
            invoiceNumber: num2,
            branchId: BRANCH_MAIN,
            customerId: TEST_CUST_ID,
            invoiceDate: new Date("2026-10-19"),
            subtotal: "7000.00",
            total: "7000.00",
            invoiceStatus: "PAID",
            createdBy: TEST_USER_ID,
          });
        })
        .catch((e) => {
          err2 = e;
        });

      await Promise.all([p1, p2]);

      // Both transactions must complete without duplicate key errors
      expect(err1).toBeNull();
      expect(err2).toBeNull();

      // One must have received 771000-3, and the other 771000-4
      const resolvedSet = new Set([num1, num2]);
      expect(resolvedSet).toContain(`${COLLISION_BASE}-3`);
      expect(resolvedSet).toContain(`${COLLISION_BASE}-4`);
      expect(num1).not.toBe(num2);

      // Verify both are persisted in database
      const saved = await d
        .select({ num: invoices.invoiceNumber })
        .from(invoices)
        .where(
          or(
            eq(invoices.invoiceNumber, `${COLLISION_BASE}-3`),
            eq(invoices.invoiceNumber, `${COLLISION_BASE}-4`),
          ),
        );
      expect(saved).toHaveLength(2);
    });

    it("ADV-COL-04: Concurrent consignment resolution safely picks sequential sibling suffixes", async () => {
      const d = getActiveDb();
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

      // Seed deliveryConsignments: 771000, 771000-1, 771000-2
      await d.insert(deliveryConsignments).values([
        {
          consignmentNumber: COLLISION_BASE,
          branchId: BRANCH_MAIN,
          partyId: 1,
          invoiceId: 101,
          sourceType: "INVOICE",
          sourceId: 101,
          codAmount: "1000.00",
          deliveryFee: "500.00",
          consignmentStatus: "DELIVERED",
        },
        {
          consignmentNumber: `${COLLISION_BASE}-1`,
          branchId: BRANCH_MAIN,
          partyId: 1,
          invoiceId: 102,
          sourceType: "INVOICE",
          sourceId: 102,
          codAmount: "1000.00",
          deliveryFee: "500.00",
          consignmentStatus: "DELIVERED",
        },
        {
          consignmentNumber: `${COLLISION_BASE}-2`,
          branchId: BRANCH_MAIN,
          partyId: 1,
          invoiceId: 103,
          sourceType: "INVOICE",
          sourceId: 103,
          codAmount: "1000.00",
          deliveryFee: "500.00",
          consignmentStatus: "DELIVERED",
        },
      ]);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      let num1 = "";
      let num2 = "";
      let err1: any = null;
      let err2: any = null;

      const p1 = d
        .transaction(async (tx1) => {
          await tx1.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
          num1 = await resolveConsignmentNumber(tx1, COLLISION_BASE, BRANCH_MAIN);
          await new Promise((r) => setTimeout(r, 40));
          await tx1.insert(deliveryConsignments).values({
            consignmentNumber: num1,
            branchId: BRANCH_MAIN,
            partyId: 1,
            invoiceId: 104,
            sourceType: "INVOICE",
            sourceId: 104,
            codAmount: "1000.00",
            deliveryFee: "500.00",
            consignmentStatus: "DELIVERED",
          });
        })
        .catch((e) => {
          err1 = e;
        });

      const p2 = d
        .transaction(async (tx2) => {
          await tx2.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
          num2 = await resolveConsignmentNumber(tx2, COLLISION_BASE, BRANCH_MAIN);
          await new Promise((r) => setTimeout(r, 40));
          await tx2.insert(deliveryConsignments).values({
            consignmentNumber: num2,
            branchId: BRANCH_MAIN,
            partyId: 1,
            invoiceId: 105,
            sourceType: "INVOICE",
            sourceId: 105,
            codAmount: "1000.00",
            deliveryFee: "500.00",
            consignmentStatus: "DELIVERED",
          });
        })
        .catch((e) => {
          err2 = e;
        });

      await Promise.all([p1, p2]);

      expect(err1).toBeNull();
      expect(err2).toBeNull();
      const consignSet = new Set([num1, num2]);
      expect(consignSet).toContain(`${COLLISION_BASE}-3`);
      expect(consignSet).toContain(`${COLLISION_BASE}-4`);
    });

    it("ADV-COL-05: Re-delivering a suffixed sibling work order (WO-771000-1) after reverseDelivery allocates next free suffix", async () => {
      const d = getActiveDb();
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

      await d.insert(invoices).values([
        {
          invoiceNumber: `${COLLISION_BASE}-1`,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "5000.00",
          total: "5000.00",
          invoiceStatus: "RETURNED",
          createdBy: TEST_USER_ID,
        },
        {
          invoiceNumber: `${COLLISION_BASE}-2`,
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: new Date("2026-10-19"),
          subtotal: "5000.00",
          total: "5000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
      ]);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      let redeliveredInvoiceNum = "";
      await d.transaction(async (tx) => {
        redeliveredInvoiceNum = await resolveDeliveryInvoiceNumber(
          tx,
          `WO-${COLLISION_BASE}-1`,
          BRANCH_MAIN,
        );
      });

      expect(redeliveredInvoiceNum).toBe(`${COLLISION_BASE}-3`);
    });

    it("ADV-COL-06: Immutable consignment revision for a suffixed source (771000-1) allocates next free suffix", async () => {
      const d = getActiveDb();
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

      await d.insert(deliveryConsignments).values([
        {
          consignmentNumber: `${COLLISION_BASE}-1`,
          branchId: BRANCH_MAIN,
          partyId: 1,
          invoiceId: 201,
          sourceType: "WORK_ORDER",
          sourceId: 201,
          codAmount: "1000.00",
          deliveryFee: "500.00",
          consignmentStatus: "RETURNED",
        },
      ]);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      let revisionConsignmentNum = "";
      await d.transaction(async (tx) => {
        revisionConsignmentNum = await resolveConsignmentNumber(
          tx,
          `WO-${COLLISION_BASE}-1`,
          BRANCH_MAIN,
        );
      });

      expect(revisionConsignmentNum).toBe(`${COLLISION_BASE}-2`);
    });
  });

  // =========================================================================
  // 3. BARCODE SCANNING & SEARCH FUZZING (SQLi, UNICODE, MALFORMED)
  // =========================================================================
  describe("3. Barcode Scanning & Global Search Fuzzing", () => {
    const FUZZ_INV_NUM = "772001";
    const FUZZ_WO_NUM = "772002";

    beforeEach(async () => {
      const d = getActiveDb();
      await setupBaseFixtures(d);

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      await d.execute(sql`DELETE FROM invoices WHERE invoiceNumber IN (${FUZZ_INV_NUM}, ${`INV-${FUZZ_INV_NUM}`})`);
      await d.execute(sql`DELETE FROM workOrders WHERE orderNumber IN (${FUZZ_WO_NUM}, ${`WO-${FUZZ_WO_NUM}`})`);

      // Seed valid target documents for verification
      await d.insert(invoices).values({
        invoiceNumber: FUZZ_INV_NUM,
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        invoiceDate: new Date("2026-10-19"),
        subtotal: "45000.00",
        total: "45000.00",
        invoiceStatus: "PAID",
        createdBy: TEST_USER_ID,
      });

      await d.insert(workOrders).values({
        orderNumber: FUZZ_WO_NUM,
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        title: "Fuzz Test Work Order",
        status: "IN_PROGRESS",
        createdBy: TEST_USER_ID,
        createdAt: new Date("2026-10-19"),
      });

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    });

    const SQLI_VECTORS = [
      "' OR 1=1 --",
      "'; DROP TABLE invoices; --",
      "\" OR \"1\"=\"1",
      "1' UNION SELECT * FROM users --",
      "100001' AND SLEEP(1) --",
      "INV-100001' OR '1'='1",
      "' OR 'x'='x",
      "\\'; DROP TABLE invoices; --",
      "100001'; SELECT BENCHMARK(1000000, MD5(1)); --",
    ];

    const UNICODE_VECTORS = [
      "١٠٠٠٠١", // Arabic Eastern numerals
      "\u200B\u200C\u200D\uFEFF100001", // Zero-width spaces & joiners
      "\u202E100001\u202C", // Right-to-Left Override
      "INV-100001💥⚡🔥", // Emojis
      "ІNV-100001", // Cyrillic homoglyph for Latin 'I'
      "INV-100001-测试", // Chinese characters
      "INV-100001-تجربة", // Arabic text
      "NULL\0BYTE", // Null byte injection
    ];

    const MALFORMED_VECTORS = [
      "---",
      "----100001",
      "100001-",
      "100001--1",
      "-100001",
      "INV---100001",
      "INV--100001--",
      "   \r\n\t  INV-100001  \r\n\t   ",
      "/verify/../../../../etc/passwd",
      "https://example.com/verify?payload='><script>alert(1)</script>",
      "A".repeat(2000), // Huge buffer
      "-".repeat(500),
    ];

    it("ADV-FUZZ-01: verifyPayload returns valid: false for all SQLi probes without crashing or throwing", async () => {
      for (const vector of SQLI_VECTORS) {
        const result = await verifyPayload(vector);
        expect(result).toBeDefined();
        expect(result.valid).toBe(false);
      }
    });

    it("ADV-FUZZ-02: verifyPayload returns valid: false for Unicode, homoglyphs, and null bytes safely", async () => {
      for (const vector of UNICODE_VECTORS) {
        const result = await verifyPayload(vector);
        expect(result).toBeDefined();
        expect(result.valid).toBe(false);
      }
    });

    it("ADV-FUZZ-03: verifyPayload returns valid: false for extreme malformed inputs and path traversals", async () => {
      for (const vector of MALFORMED_VECTORS) {
        const result = await verifyPayload(vector);
        expect(result).toBeDefined();
        expect(result.valid).toBe(false);
      }
    });

    it("ADV-FUZZ-04: verifyPayload correctly authenticates clean and prefixed document numbers", async () => {
      // Clean document number
      const cleanInv = await verifyPayload(FUZZ_INV_NUM);
      expect(cleanInv.valid).toBe(true);
      expect(cleanInv.docType).toBe("INV");
      expect(cleanInv.number).toBe(FUZZ_INV_NUM);

      // Prefixed document number
      const prefixedInv = await verifyPayload(`INV-${FUZZ_INV_NUM}`);
      expect(prefixedInv.valid).toBe(true);
      expect(prefixedInv.docType).toBe("INV");
      expect(prefixedInv.number).toBe(FUZZ_INV_NUM);

      // Clean work order
      const cleanWo = await verifyPayload(FUZZ_WO_NUM);
      expect(cleanWo.valid).toBe(true);
      expect(cleanWo.docType).toBe("WO");
      expect(cleanWo.number).toBe(FUZZ_WO_NUM);

      // Prefixed work order
      const prefixedWo = await verifyPayload(`WO-${FUZZ_WO_NUM}`);
      expect(prefixedWo.valid).toBe(true);
      expect(prefixedWo.docType).toBe("WO");
      expect(prefixedWo.number).toBe(FUZZ_WO_NUM);
    });

    it("ADV-FUZZ-05: searchDocuments executes all SQLi and fuzz probes without SQL syntax crashes", async () => {
      const d = getActiveDb();

      // Run across searchInvoices, searchWorkOrders, searchQuotations, searchPurchaseOrders, searchExpenses
      for (const probe of [...SQLI_VECTORS, ...UNICODE_VECTORS, ...MALFORMED_VECTORS.slice(0, 5)]) {
        // Must not throw SQL syntax errors (escLike & parameterized bindings protect queries)
        const invResults = await searchInvoices(d, "DOC_NUMBER", probe, 5, BRANCH_MAIN);
        expect(Array.isArray(invResults)).toBe(true);

        const woResults = await searchWorkOrders(d, "DOC_NUMBER", probe, 5, BRANCH_MAIN);
        expect(Array.isArray(woResults)).toBe(true);

        const textResults = await searchInvoices(d, "TEXT", probe, 5, BRANCH_MAIN);
        expect(Array.isArray(textResults)).toBe(true);
      }
    });

    it("ADV-FUZZ-06: Global search strictly maintains branch isolation under prefixed & stripped queries", async () => {
      const d = getActiveDb();
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

      const BRANCH2_INV_NUM = "772099";
      await d.execute(sql`DELETE FROM invoices WHERE invoiceNumber = ${BRANCH2_INV_NUM}`);

      // Insert invoice belonging to BRANCH_SALES (2)
      await d.insert(invoices).values({
        invoiceNumber: BRANCH2_INV_NUM,
        branchId: BRANCH_SALES,
        customerId: TEST_CUST_ID,
        invoiceDate: new Date("2026-10-19"),
        subtotal: "90000.00",
        total: "90000.00",
        invoiceStatus: "PAID",
        createdBy: TEST_USER_ID,
      });
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      // Search scoped to BRANCH_MAIN (1) for BRANCH2_INV_NUM
      const resBare = await searchInvoices(d, "DOC_NUMBER", BRANCH2_INV_NUM, 10, BRANCH_MAIN);
      expect(resBare).toHaveLength(0);

      const resPrefixed = await searchInvoices(d, "DOC_NUMBER", `INV-${BRANCH2_INV_NUM}`, 10, BRANCH_MAIN);
      expect(resPrefixed).toHaveLength(0);

      // Search scoped to BRANCH_SALES (2) correctly finds it
      const resBranch2 = await searchInvoices(d, "DOC_NUMBER", `INV-${BRANCH2_INV_NUM}`, 10, BRANCH_SALES);
      expect(resBranch2).toHaveLength(1);
      expect(resBranch2[0].title).toBe(BRANCH2_INV_NUM);
    });
  });

  // =========================================================================
  // 4. ANOMALYWATCH D6 TAMPER DETECTION & DELAYED LIFECYCLE AUDIT
  // =========================================================================
  describe("4. AnomalyWatch D6 Sequence Gap Tamper Detection", () => {
    const AUDIT_DATE_STR = "2026-10-19";
    const BASE_START = 880001;

    beforeEach(async () => {
      const d = getActiveDb();
      await setupBaseFixtures(d);

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      // Clean existing records in the test range
      await d.execute(sql`
        DELETE FROM invoices WHERE invoiceNumber REGEXP '^88[0-9]{4}'
      `);
      await d.execute(sql`
        DELETE FROM workOrders WHERE orderNumber REGEXP '^88[0-9]{4}'
      `);
      await d.execute(sql`
        DELETE FROM receptionDrafts WHERE draftNumber REGEXP '^88[0-9]{4}'
      `);
      await d.execute(sql`
        DELETE FROM purchaseOrders WHERE poNumber REGEXP '^88[0-9]{4}'
      `);
      await d.execute(sql`
        DELETE FROM onlineOrders WHERE orderNumber REGEXP '^88[0-9]{4}'
      `);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    });

    it("ADV-D6-01: Baseline continuous sequence across diverse document types produces ZERO gap alarms", async () => {
      const d = getActiveDb();
      const testDate = new Date(`${AUDIT_DATE_STR}T10:00:00.000Z`);

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      // Continuous 5 transactions across various document types:
      // 880001: Reception Draft
      await d.insert(receptionDrafts).values({
        draftNumber: String(BASE_START),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        draftStatus: "CONVERTED",
        commitRequestId: "11111111-1111-1111-1111-111111111111",
        createdBy: TEST_USER_ID,
        createdAt: testDate,
      });

      // 880002: Work Order
      await d.insert(workOrders).values({
        orderNumber: String(BASE_START + 1),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        title: "Work Order 2",
        status: "READY",
        createdBy: TEST_USER_ID,
        createdAt: testDate,
      });

      // 880003: Sale Invoice
      await d.insert(invoices).values({
        invoiceNumber: String(BASE_START + 2),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        invoiceDate: testDate,
        subtotal: "2000.00",
        total: "2000.00",
        invoiceStatus: "PAID",
        createdBy: TEST_USER_ID,
      });

      // 880004: Purchase Order
      await d.insert(purchaseOrders).values({
        poNumber: String(BASE_START + 3),
        branchId: BRANCH_MAIN,
        supplierId: TEST_SUPP_ID,
        orderDate: testDate,
        subtotal: "3000.00",
        total: "3000.00",
        status: "CONFIRMED",
        createdBy: TEST_USER_ID,
        createdAt: testDate,
      });

      // 880005: Online Order with ORD- prefix
      await d.insert(onlineOrders).values({
        orderNumber: `ORD-${BASE_START + 4}`,
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        orderDate: testDate,
        subtotal: "4000.00",
        total: "4000.00",
        status: "CONFIRMED",
        createdAt: testDate,
      });
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      const report = await getAnomalyWatch({ from: AUDIT_DATE_STR, to: AUDIT_DATE_STR });

      // Must be 100% clean
      const unifiedGaps = report.sequenceGaps.rows.filter((r) => r.branchName.includes("موحد"));
      expect(unifiedGaps).toHaveLength(0);
      expect(report.kpis.sequenceGapDays).toBe(0);
    });

    it("ADV-D6-02: Tamper Detection: physical SQL delete of middle transaction is immediately flagged", async () => {
      const d = getActiveDb();
      const testDate = new Date(`${AUDIT_DATE_STR}T10:00:00.000Z`);

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      // Continuous 5 transactions: 880001, 880002, 880003, 880004, ORD-880005
      await d.insert(receptionDrafts).values({
        draftNumber: String(BASE_START),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        draftStatus: "CONVERTED",
        commitRequestId: "22222222-2222-2222-2222-222222222222",
        createdBy: TEST_USER_ID,
        createdAt: testDate,
      });
      await d.insert(workOrders).values({
        orderNumber: String(BASE_START + 1),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        title: "Work Order 2",
        status: "READY",
        createdBy: TEST_USER_ID,
        createdAt: testDate,
      });
      await d.insert(invoices).values({
        invoiceNumber: String(BASE_START + 2),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        invoiceDate: testDate,
        subtotal: "2000.00",
        total: "2000.00",
        invoiceStatus: "PAID",
        createdBy: TEST_USER_ID,
      });
      await d.insert(purchaseOrders).values({
        poNumber: String(BASE_START + 3),
        branchId: BRANCH_MAIN,
        supplierId: TEST_SUPP_ID,
        orderDate: testDate,
        subtotal: "3000.00",
        total: "3000.00",
        status: "CONFIRMED",
        createdBy: TEST_USER_ID,
        createdAt: testDate,
      });
      await d.insert(onlineOrders).values({
        orderNumber: `ORD-${BASE_START + 4}`,
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        orderDate: testDate,
        subtotal: "4000.00",
        total: "4000.00",
        status: "CONFIRMED",
        createdAt: testDate,
      });

      // TAMPER: Attacker physically deletes middle invoice 880003 directly from database
      await d.execute(sql`DELETE FROM invoices WHERE invoiceNumber = ${String(BASE_START + 2)}`);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      const report = await getAnomalyWatch({ from: AUDIT_DATE_STR, to: AUDIT_DATE_STR });

      // Detector D6 MUST immediately detect the sequence gap
      const unifiedGaps = report.sequenceGaps.rows.filter((r) => r.branchName.includes("موحد"));
      expect(unifiedGaps.length).toBeGreaterThanOrEqual(1);

      const gap = unifiedGaps[0];
      expect(gap.minSeq).toBe(BASE_START);
      expect(gap.maxSeq).toBe(BASE_START + 4);
      expect(gap.actualCount).toBe(4); // 4 remaining
      expect(gap.missing).toBe(1); // Exactly 1 missing (880003)
      expect(report.kpis.sequenceGapDays).toBeGreaterThanOrEqual(1);
    });

    it("ADV-D6-03: Delayed lifecycle delivery originating >90 days (120 days) ago causes ZERO false alarms today", async () => {
      const d = getActiveDb();
      const todayDate = new Date(`${AUDIT_DATE_STR}T10:00:00.000Z`);
      // 120 days ago (> 90 days)
      const historicalDate = new Date(todayDate.getTime() - 120 * 86400 * 1000);

      const HISTORICAL_TRACKING = 870001;

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      // 1. Transaction started 120 days ago: Reception Draft 870001
      await d.insert(receptionDrafts).values({
        draftNumber: String(HISTORICAL_TRACKING),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        draftStatus: "CONVERTED",
        commitRequestId: "33333333-3333-3333-3333-333333333333",
        createdBy: TEST_USER_ID,
        createdAt: historicalDate,
      });

      // 2. Continuous transactions originating TODAY: 880001, 880002, 880003
      await d.insert(invoices).values({
        invoiceNumber: String(BASE_START),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        invoiceDate: todayDate,
        subtotal: "1000.00",
        total: "1000.00",
        invoiceStatus: "PAID",
        createdBy: TEST_USER_ID,
      });
      await d.insert(workOrders).values({
        orderNumber: String(BASE_START + 1),
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        title: "Today Order",
        status: "READY",
        createdBy: TEST_USER_ID,
        createdAt: todayDate,
      });
      await d.insert(purchaseOrders).values({
        poNumber: String(BASE_START + 2),
        branchId: BRANCH_MAIN,
        supplierId: TEST_SUPP_ID,
        orderDate: todayDate,
        subtotal: "2000.00",
        total: "2000.00",
        status: "CONFIRMED",
        createdBy: TEST_USER_ID,
        createdAt: todayDate,
      });

      // 3. The 120-day-old order is delivered TODAY, creating an invoice with number 870001-1
      await d.insert(invoices).values({
        invoiceNumber: `${HISTORICAL_TRACKING}-1`,
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        invoiceDate: todayDate,
        subtotal: "5000.00",
        total: "5000.00",
        invoiceStatus: "PAID",
        createdBy: TEST_USER_ID,
      });
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      // Run AnomalyWatch for TODAY
      const report = await getAnomalyWatch({ from: AUDIT_DATE_STR, to: AUDIT_DATE_STR });

      const unifiedGaps = report.sequenceGaps.rows.filter((r) => r.branchName.includes("موحد"));
      expect(unifiedGaps).toHaveLength(0);
      expect(report.kpis.sequenceGapDays).toBe(0);
    });

    it("ADV-D6-04: Legacy <100000 work orders (5001) and invoices (10001, 10002) do not pollute the >=100000 unified pool", async () => {
      const d = getActiveDb();
      const todayDate = new Date(`${AUDIT_DATE_STR}T10:00:00.000Z`);

      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      await d.execute(sql`DELETE FROM invoices WHERE invoiceNumber IN ('10001', '10002')`);
      await d.execute(sql`DELETE FROM workOrders WHERE orderNumber = '5001'`);

      // Legacy work order (5001) and contiguous legacy invoices (10001, 10002)
      await d.insert(workOrders).values({
        orderNumber: "5001",
        branchId: BRANCH_MAIN,
        customerId: TEST_CUST_ID,
        title: "Legacy Work Order",
        status: "READY",
        createdBy: TEST_USER_ID,
        createdAt: todayDate,
      });
      await d.insert(invoices).values([
        {
          invoiceNumber: "10001",
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: todayDate,
          subtotal: "1000.00",
          total: "1000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
        {
          invoiceNumber: "10002",
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: todayDate,
          subtotal: "1000.00",
          total: "1000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
        // Contiguous unified transactions (880001, 880002)
        {
          invoiceNumber: String(BASE_START),
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: todayDate,
          subtotal: "1000.00",
          total: "1000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
        {
          invoiceNumber: String(BASE_START + 1),
          branchId: BRANCH_MAIN,
          customerId: TEST_CUST_ID,
          invoiceDate: todayDate,
          subtotal: "1000.00",
          total: "1000.00",
          invoiceStatus: "PAID",
          createdBy: TEST_USER_ID,
        },
      ]);
      await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

      const report = await getAnomalyWatch({ from: AUDIT_DATE_STR, to: AUDIT_DATE_STR });
      expect(report.sequenceGaps.rows).toHaveLength(0);
      expect(report.kpis.sequenceGapDays).toBe(0);

      await d.execute(sql`DELETE FROM invoices WHERE invoiceNumber IN ('10001', '10002')`);
      await d.execute(sql`DELETE FROM workOrders WHERE orderNumber = '5001'`);
    });
  });
});
