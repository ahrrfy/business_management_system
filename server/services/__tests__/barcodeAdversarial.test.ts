/**
 * barcodeAdversarial.test.ts — EMPIRICAL CHALLENGER Adversarial Test Suite
 * 
 * Deep correctness & stress testing of the QR Code Verification subsystem:
 * - server/services/barcodeService.ts (verifyPayload, extractVerificationCode)
 * - server/routers/barcodeRouter.ts (barcode.verify procedure)
 * 
 * Test Scenarios:
 * 1. Identifier Format Variations & Case-insensitivity (ORD-100009, ord-100009, 100009, INV, WO, PO)
 * 2. Full URLs & Host / Path / Fragment Variations
 * 3. Query Parameter Variations (?ref, ?payload, ?p, ?id, ?number, relative paths)
 * 4. Corrupted HMAC Signatures & Payload Tampering
 * 5. Non-existent IDs & Boundary Rejections
 * 6. Large Payload Attacks (> 1000 chars, DoS / ReDoS attempts)
 * 7. Empty, Whitespace, Malformed, SQLi, and XSS Vectors
 * 8. tRPC Router Union Input Handling & Graceful Degradation
 */

import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import {
  verifyPayload,
  extractVerificationCode,
  invoiceBarcodeSet,
  workOrderBarcodeSet,
  purchaseOrderBarcodeSet,
} from "../barcodeService";

function publicCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: null,
  };
}

const caller = appRouter.createCaller(publicCtx());

async function seedTestData() {
  const d = getDb();
  if (!d) return;

  try {
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);

    // Ensure branch 1 exists
    await d
      .insert(s.branches)
      .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" })
      .onDuplicateKeyUpdate({ set: { name: "MAIN" } });

    // Ensure customer 1 exists
    await d
      .insert(s.customers)
      .values({ id: 1, name: "Empirical Tester", phone: "+9647700000000" })
      .onDuplicateKeyUpdate({ set: { name: "Empirical Tester" } });

    // Ensure supplier 1 exists
    await d
      .insert(s.suppliers)
      .values({ id: 1, name: "Empirical Supplier" })
      .onDuplicateKeyUpdate({ set: { name: "Empirical Supplier" } });

    // Seed online order ORD-100009
    await d
      .insert(s.onlineOrders)
      .values({
        id: 9,
        orderNumber: "ORD-100009",
        customerId: 1,
        branchId: 1,
        subtotal: "15000.00",
        total: "15000.00",
        status: "CONFIRMED",
        shippingAddress: "Baghdad - Jadriya",
        governorate: "baghdad",
      })
      .onDuplicateKeyUpdate({ set: { status: "CONFIRMED", total: "15000.00" } });

    // Seed sales invoice INV-1-20260806-00068
    await d
      .insert(s.invoices)
      .values({
        id: 68,
        invoiceNumber: "INV-1-20260806-00068",
        sourceType: "POS",
        branchId: 1,
        customerId: 1,
        invoiceDate: new Date("2026-08-06"),
        subtotal: "50000.00",
        total: "50000.00",
        status: "PAID",
        paidAmount: "50000.00",
      })
      .onDuplicateKeyUpdate({ set: { status: "PAID", total: "50000.00" } });

    // Seed work order WO-10001
    await d
      .insert(s.workOrders)
      .values({
        id: 1,
        orderNumber: "WO-10001",
        branchId: 1,
        customerId: 1,
        title: "Testing Service",
        quantity: 10,
        salePrice: "35000.00",
        status: "READY",
      })
      .onDuplicateKeyUpdate({ set: { salePrice: "35000.00" } });

    // Seed purchase order PO-2026-001
    await d
      .insert(s.purchaseOrders)
      .values({
        id: 1,
        poNumber: "PO-2026-001",
        supplierId: 1,
        branchId: 1,
        orderDate: new Date("2026-09-01"),
        subtotal: "120000.00",
        total: "120000.00",
        status: "CONFIRMED",
      })
      .onDuplicateKeyUpdate({ set: { total: "120000.00" } });

    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  } catch (err) {
    console.error("Critical test seeding error:", err);
    throw err;
  }
}

describe("Adversarial QR Code Verification Suite", () => {
  beforeEach(async () => {
    await seedTestData();
  });

  // ==========================================================================
  // Category 1: Identifier Format Variations & Case Insensitivity
  // ==========================================================================
  it("1. Resolves all document identifier formats, case variations, and numeric IDs", async () => {
    // 1.1 Canonical ORD-100009
    const resUpper = await verifyPayload("ORD-100009");
    expect(resUpper.valid).toBe(true);
    expect(resUpper.docType).toBe("ORD");
    expect(resUpper.number).toBe("ORD-100009");
    expect(resUpper.amount).toBe("15000.00");
    expect(resUpper.customerName).toBe("Empirical Tester");

    // 1.2 Lowercase ord-100009
    const resLower = await verifyPayload("ord-100009");
    expect(resLower.valid).toBe(true);
    expect(resLower.docType).toBe("ORD");
    expect(resLower.number).toBe("ORD-100009");

    // 1.3 Mixed-case Ord-100009
    const resMixed = await verifyPayload("Ord-100009");
    expect(resMixed.valid).toBe(true);
    expect(resMixed.docType).toBe("ORD");

    // 1.4 Bare numeric part 100009
    const resNum = await verifyPayload("100009");
    expect(resNum.valid).toBe(true);
    expect(resNum.docType).toBe("ORD");
    expect(resNum.number).toBe("ORD-100009");

    // 1.5 Primary key ID 9
    const resPk = await verifyPayload("9");
    expect(resPk.valid).toBe(true);

    // 1.6 Invoices (canonical and lowercase)
    const resInvUpper = await verifyPayload("INV-1-20260806-00068");
    expect(resInvUpper.valid).toBe(true);
    expect(resInvUpper.docType).toBe("INV");
    expect(resInvUpper.number).toBe("INV-1-20260806-00068");

    const resInvLower = await verifyPayload("inv-1-20260806-00068");
    expect(resInvLower.valid).toBe(true);
    expect(resInvLower.docType).toBe("INV");

    // 1.7 Work Orders (canonical and lowercase)
    const resWoUpper = await verifyPayload("WO-10001");
    expect(resWoUpper.valid).toBe(true);
    expect(resWoUpper.docType).toBe("WO");

    const resWoLower = await verifyPayload("wo-10001");
    expect(resWoLower.valid).toBe(true);
    expect(resWoLower.docType).toBe("WO");

    // 1.8 Purchase Orders (canonical and lowercase)
    const resPoUpper = await verifyPayload("PO-2026-001");
    expect(resPoUpper.valid).toBe(true);
    expect(resPoUpper.docType).toBe("PO");

    const resPoLower = await verifyPayload("po-2026-001");
    expect(resPoLower.valid).toBe(true);
    expect(resPoLower.docType).toBe("PO");
  });

  // ==========================================================================
  // Category 2: Full URLs & Host / Path / Fragment Variations
  // ==========================================================================
  it("2. Resolves full URLs with various hosts, ports, paths, fragments, and queries", async () => {
    const urlVariations = [
      "https://srv1548487.hstgr.cloud/verify?ref=ORD-100009",
      "http://localhost:5173/verify/ORD-100009",
      "http://localhost:3000/verify/ORD-100009",
      "http://localhost:8080/verify/ORD-100009",
      "https://srv1548487.hstgr.cloud/verify?ref=ORD-100009#details",
      "https://srv1548487.hstgr.cloud/verify?utm_source=camera&ref=ORD-100009&lang=ar",
      "https://srv1548487.hstgr.cloud/verify?ref=ORD%2D100009",
      "https://alroya.iq/verify/ord-100009",
      "https://srv1548487.hstgr.cloud/verify?ref=ord-100009",
      "https://srv1548487.hstgr.cloud/verify?ref=100009",
      "https://srv1548487.hstgr.cloud/verify/100009",
    ];

    for (const url of urlVariations) {
      const res = await verifyPayload(url);
      expect(res.valid, `Failed for URL: ${url}`).toBe(true);
      expect(res.number).toBe("ORD-100009");
    }
  });

  // ==========================================================================
  // Category 3: Query Parameter Variations & Relative Paths
  // ==========================================================================
  it("3. Resolves all supported query parameters and relative path variations", async () => {
    const queryVariations = [
      "?ref=ORD-100009",
      "?payload=ORD-100009",
      "?p=ORD-100009",
      "?id=ORD-100009",
      "?number=ORD-100009",
      "/verify?ref=ORD-100009",
      "/verify?payload=ORD-100009",
      "/verify?p=ORD-100009",
      "/verify?id=ORD-100009",
      "/verify?number=ORD-100009",
      "/verify/ORD-100009",
    ];

    for (const qv of queryVariations) {
      const res = await verifyPayload(qv);
      expect(res.valid, `Failed for query/path: ${qv}`).toBe(true);
      expect(res.number).toBe("ORD-100009");
    }
  });

  // ==========================================================================
  // Category 4: Corrupted HMAC Signatures & Tampering
  // ==========================================================================
  it("4. Accurately verifies valid HMAC signatures and rejects corrupted/tampered ones", async () => {
    // 4.1 Valid HMAC payload
    const bSet = invoiceBarcodeSet({
      invoiceNumber: "INV-9901",
      invoiceDate: "2026-09-29",
      total: "80000",
      branchId: 1,
    });

    const resValid = await verifyPayload(bSet.qrPayload);
    expect(resValid.valid).toBe(true);
    expect(resValid.docType).toBe("INV");
    expect(resValid.number).toBe("INV-9901");
    expect(resValid.amount).toBe("80000");

    // 4.2 Corrupted signature hex
    const parts1 = bSet.qrPayload.split("|");
    parts1[5] = "000000000000";
    expect((await verifyPayload(parts1.join("|"))).valid).toBe(false);

    // 4.3 Tampered total amount (80000 -> 1000)
    const parts2 = bSet.qrPayload.split("|");
    parts2[3] = "1000";
    expect((await verifyPayload(parts2.join("|"))).valid).toBe(false);

    // 4.4 Tampered branchId (1 -> 2)
    const parts3 = bSet.qrPayload.split("|");
    parts3[4] = "2";
    expect((await verifyPayload(parts3.join("|"))).valid).toBe(false);

    // 4.5 Tampered docType (INV -> WO)
    const parts4 = bSet.qrPayload.split("|");
    parts4[0] = "WO";
    expect((await verifyPayload(parts4.join("|"))).valid).toBe(false);

    // 4.6 Truncated pipe payloads
    expect((await verifyPayload("INV|1001|2026-09-29|75000")).valid).toBe(false);
    expect((await verifyPayload("INV|1001|2026-09-29|75000|1|")).valid).toBe(false);
  });

  // ==========================================================================
  // Category 5: Non-existent IDs & Boundary Rejections
  // ==========================================================================
  it("5. Gracefully rejects non-existent document IDs across all categories", async () => {
    const nonExistentCodes = [
      "ORD-999999",
      "ord-999999",
      "INV-999999",
      "inv-999999",
      "WO-999999",
      "wo-999999",
      "PO-999999",
      "po-999999",
      "999999",
      "RANDOM_STRING_XYZ_123",
      "CUST-99999",
    ];

    for (const code of nonExistentCodes) {
      const res = await verifyPayload(code);
      expect(res.valid, `Expected invalid for: ${code}`).toBe(false);
    }
  });

  // ==========================================================================
  // Category 6: Large Payload Attacks & DoS Defense
  // ==========================================================================
  it("6. Defends against large payloads, boundary lengths, and ReDoS attacks", async () => {
    // 6.1 > 1000 characters to verifyPayload
    const payload1001 = "A".repeat(1001);
    expect((await verifyPayload(payload1001)).valid).toBe(false);

    // 6.2 10,000 characters without memory leak or lag
    const startTime10k = Date.now();
    const res10k = await verifyPayload("X".repeat(10000));
    const elapsed10k = Date.now() - startTime10k;
    expect(res10k.valid).toBe(false);
    expect(elapsed10k).toBeLessThan(100);

    // 6.3 tRPC caller boundary (> 1000 rejected by Zod schema)
    const hugeInput = "ORD-100009" + "Z".repeat(1000);
    await expect(caller.barcode.verify({ payload: hugeInput })).rejects.toThrow();

    // 6.4 Boundary test: exactly 1000 chars
    const paddedValid = "ORD-100009" + " ".repeat(1000 - "ORD-100009".length);
    expect(paddedValid.length).toBe(1000);
    const resBoundary = await verifyPayload(paddedValid);
    expect(resBoundary.valid).toBe(true);
    expect(resBoundary.number).toBe("ORD-100009");

    // 6.5 Nested query strings without ReDoS
    const attackQuery = "https://srv1548487.hstgr.cloud/verify?" + "a=1&".repeat(100) + "ref=ORD-100009";
    const startTimeReDos = Date.now();
    const resReDos = await verifyPayload(attackQuery);
    const elapsedReDos = Date.now() - startTimeReDos;
    expect(resReDos.valid).toBe(true);
    expect(resReDos.number).toBe("ORD-100009");
    expect(elapsedReDos).toBeLessThan(150);
  });

  // ==========================================================================
  // Category 7: Empty, Whitespace, Malformed, SQLi, and XSS Vectors
  // ==========================================================================
  it("7. Safely neutralizes empty strings, injection vectors, and malformed inputs", async () => {
    // 7.1 Empty and whitespace
    expect((await verifyPayload("")).valid).toBe(false);
    expect((await verifyPayload("   ")).valid).toBe(false);
    expect((await verifyPayload("\t\r\n  ")).valid).toBe(false);

    // 7.2 SQL Injection vectors
    const sqliVectors = [
      "' OR '1'='1",
      "ORD-100009' OR '1'='1",
      "'; DROP TABLE online_orders; --",
      "1 UNION SELECT 1, 2, 3, 4, 5, 6",
      "ORD-100009' AND SLEEP(5) --",
    ];
    for (const vector of sqliVectors) {
      expect((await verifyPayload(vector)).valid).toBe(false);
    }

    // 7.3 XSS vectors
    const xssVectors = [
      "<script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      "javascript:alert(1)",
    ];
    for (const vector of xssVectors) {
      expect((await verifyPayload(vector)).valid).toBe(false);
    }

    // 7.4 Path traversal
    expect((await verifyPayload("/verify/../../../../etc/passwd")).valid).toBe(false);

    // 7.5 Malformed URL strings
    const malformedUrls = [
      "http://[::1:invalid/verify",
      "https://",
      "http:///verify?ref=",
      "verify:ORD-100009",
    ];
    for (const url of malformedUrls) {
      const res = await verifyPayload(url);
      expect(typeof res.valid).toBe("boolean");
    }
  });

  // ==========================================================================
  // Category 8: tRPC Router Union Input Handling & Graceful Degradation
  // ==========================================================================
  it("8. Validates tRPC barcode.verify procedure across all schema input variations", async () => {
    // 8.1 Via payload
    const resPayload = await caller.barcode.verify({ payload: "ORD-100009" });
    expect(resPayload.valid).toBe(true);
    expect(resPayload.number).toBe("ORD-100009");

    // 8.2 Via ref
    const resRef = await caller.barcode.verify({ ref: "ORD-100009" });
    expect(resRef.valid).toBe(true);
    expect(resRef.number).toBe("ORD-100009");

    // 8.3 Via id
    const resId = await caller.barcode.verify({ id: "ORD-100009" });
    expect(resId.valid).toBe(true);
    expect(resId.number).toBe("ORD-100009");

    // 8.4 Via number
    const resNumber = await caller.barcode.verify({ number: "ORD-100009" });
    expect(resNumber.valid).toBe(true);
    expect(resNumber.number).toBe("ORD-100009");

    // 8.5 Empty string payload returns valid: false
    const resEmptyPayload = await caller.barcode.verify({ payload: "" });
    expect(resEmptyPayload.valid).toBe(false);

    // 8.6 Empty object {} returns valid: false
    const resEmpty = await caller.barcode.verify({});
    expect(resEmpty.valid).toBe(false);

    // 8.7 Non-existent ref returns valid: false
    const resNonExistent = await caller.barcode.verify({ ref: "ORD-999999" });
    expect(resNonExistent.valid).toBe(false);

    // 8.8 When payload is whitespace, fallback selects 'ref' and successfully verifies:
    const resBoth = await caller.barcode.verify({ payload: "   ", ref: "ORD-100009" });
    expect(resBoth.valid).toBe(true);
  });
});
