/**
 * documentVerification.test.ts — E2E & Domain Verification Suite
 * Covers Tiers 1-4 for QR Code Document Verification per TEST_INFRA.md and PROJECT.md:
 *  - Tier 1: Feature Coverage (ORD-100009, INV-*, WO-*, PO-*, HMAC payloads)
 *  - Tier 2: Boundary & Corner Cases (empty, corrupted, non-existent, URL variations, 1000-char limits)
 *  - Tier 3: Cross-Feature Combinations (QR URLs from printInvoiceA4 and shippingLabel)
 *  - Tier 4: Real-World Scenarios (physical parcel scanning, document authenticity validation)
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import {
  verifyPayload,
  invoiceBarcodeSet,
  workOrderBarcodeSet,
  purchaseOrderBarcodeSet,
  customerBarcodeSet,
} from "../barcodeService";
import { resolveShippingLabelQrTarget } from "@/lib/printing/shippingLabel";

function publicCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: null,
  };
}

const caller = appRouter.createCaller(publicCtx());

async function safeSeedDatabase() {
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
      .values({ id: 1, name: "Customer Test", phone: "+9647701234567" })
      .onDuplicateKeyUpdate({ set: { name: "Customer Test" } });

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
        shippingAddress: "Baghdad - Karrada",
        governorate: "baghdad",
      })
      .onDuplicateKeyUpdate({ set: { status: "CONFIRMED", total: "15000.00" } });

    // Seed sales invoice INV-1-20260806-00068
    await d
      .insert(s.invoices)
      .values({
        id: 68,
        invoiceNumber: "INV-1-20260806-00068",
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
        title: "Poster Printing Service",
        quantity: "50",
        salePrice: "35000.00",
      })
      .catch(() => {});

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
      })
      .catch(() => {});

    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  } catch (err) {
    // If DB seeding fails, tests continue
  }
}

describe("Document Verification Suite (Tiers 1-4)", () => {
  beforeEach(async () => {
    await safeSeedDatabase();
  });

  // --------------------------------------------------------------------------
  // Tier 1: Feature Coverage
  // --------------------------------------------------------------------------
  describe("Tier 1: Feature Coverage (Core Document Verification)", () => {
    it("1.1 verifies valid online order ORD-100009 successfully", async () => {
      const res = await verifyPayload("ORD-100009");
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("ORD");
      expect(res.number).toBe("ORD-100009");
      expect(res.amount).toBeDefined();
    });

    it("1.2 verifies valid sales invoice INV-1-20260806-00068 successfully", async () => {
      const res = await verifyPayload("INV-1-20260806-00068");
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("INV");
      expect(res.number).toBe("INV-1-20260806-00068");
    });

    it("1.3 verifies valid work order WO-10001 successfully", async () => {
      const res = await verifyPayload("WO-10001");
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("WO");
      expect(res.number).toBe("WO-10001");
    });

    it("1.4 verifies valid purchase order PO-2026-001 successfully", async () => {
      const res = await verifyPayload("PO-2026-001");
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("PO");
      expect(res.number).toBe("PO-2026-001");
    });

    it("1.5 verifies 6-part HMAC signed invoice payload", async () => {
      const barcodeSet = invoiceBarcodeSet({
        invoiceNumber: "INV-1001",
        invoiceDate: "2026-09-29",
        total: "75000",
        branchId: 1,
      });

      const res = await verifyPayload(barcodeSet.qrPayload);
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("INV");
      expect(res.number).toBe("INV-1001");
      expect(res.date).toBe("2026-09-29");
      expect(res.amount).toBe("75000");
      expect(res.branchId).toBe(1);
    });

    it("1.6 verifies 6-part HMAC signed work order payload", async () => {
      const barcodeSet = workOrderBarcodeSet({
        orderNumber: "WO-2002",
        createdAt: new Date("2026-09-29"),
        branchId: 1,
      });

      const res = await verifyPayload(barcodeSet.qrPayload);
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("WO");
      expect(res.number).toBe("WO-2002");
      expect(res.branchId).toBe(1);
    });

    it("1.7 verifies 6-part HMAC signed purchase order payload", async () => {
      const barcodeSet = purchaseOrderBarcodeSet({
        poNumber: "PO-3003",
        createdAt: new Date("2026-09-29"),
        branchId: 1,
      });

      const res = await verifyPayload(barcodeSet.qrPayload);
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("PO");
      expect(res.number).toBe("PO-3003");
      expect(res.branchId).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Tier 2: Boundary & Corner Cases
  // --------------------------------------------------------------------------
  describe("Tier 2: Boundary & Corner Cases", () => {
    it("2.1 handles empty string, whitespace, and invalid structures safely", async () => {
      const emptyRes = await verifyPayload("");
      expect(emptyRes.valid).toBe(false);

      const spaceRes = await verifyPayload("   ");
      expect(spaceRes.valid).toBe(false);

      const invalidDelimiter = await verifyPayload("foo#bar#baz");
      expect(invalidDelimiter.valid).toBe(false);

      // tRPC procedure handles empty payload safely
      const routerEmptyRes = await caller.barcode.verify({ payload: "" });
      expect(routerEmptyRes.valid).toBe(false);
    });

    it("2.2 rejects corrupted HMAC signatures", async () => {
      const barcodeSet = invoiceBarcodeSet({
        invoiceNumber: "INV-1002",
        invoiceDate: "2026-09-29",
        total: "40000",
        branchId: 1,
      });

      const parts = barcodeSet.qrPayload.split("|");
      // Corrupt signature
      parts[5] = "deadbeef1234";
      const corruptedSigPayload = parts.join("|");

      const res1 = await verifyPayload(corruptedSigPayload);
      expect(res1.valid).toBe(false);

      // Corrupt amount while keeping original signature
      parts[3] = "99999999";
      const tamperedAmountPayload = parts.join("|");

      const res2 = await verifyPayload(tamperedAmountPayload);
      expect(res2.valid).toBe(false);
    });

    it("2.3 rejects non-existent document numbers gracefully", async () => {
      const nonExistentOrd = await verifyPayload("ORD-999999");
      expect(nonExistentOrd.valid).toBe(false);

      const nonExistentInv = await verifyPayload("INV-999999");
      expect(nonExistentInv.valid).toBe(false);

      const nonExistentWo = await verifyPayload("WO-999999");
      expect(nonExistentWo.valid).toBe(false);

      const nonExistentPo = await verifyPayload("PO-999999");
      expect(nonExistentPo.valid).toBe(false);
    });

    it("2.4 handles various URL formats and parameter encodings", async () => {
      const urls = [
        "https://srv1548487.hstgr.cloud/verify?ref=ORD-100009",
        "http://localhost:5173/verify?payload=ORD-100009",
        "http://localhost:5173/verify?p=ORD-100009",
        "http://localhost:5173/verify?id=ORD-100009",
        "http://localhost:5173/verify/ORD-100009",
      ];

      for (const url of urls) {
        const res = await verifyPayload(url);
        expect(res.valid).toBe(true);
        expect(res.number).toBe("ORD-100009");
      }
    });

    it("2.5 handles URL with encoded HMAC signature payload", async () => {
      const barcodeSet = invoiceBarcodeSet({
        invoiceNumber: "INV-1003",
        invoiceDate: "2026-09-29",
        total: "25000",
        branchId: 1,
      });

      const urlWithPayload = `https://srv1548487.hstgr.cloud/verify?payload=${encodeURIComponent(barcodeSet.qrPayload)}`;
      const res1 = await verifyPayload(urlWithPayload);
      expect(res1.valid).toBe(true);
      expect(res1.number).toBe("INV-1003");

      const urlWithP = `https://srv1548487.hstgr.cloud/verify?p=${encodeURIComponent(barcodeSet.qrPayload)}`;
      const res2 = await verifyPayload(urlWithP);
      expect(res2.valid).toBe(true);
      expect(res2.number).toBe("INV-1003");
    });

    it("2.6 validates maximum payload length bounds (<= 1000 accepted, > 1000 rejected)", async () => {
      // 1000 chars payload
      const validChars = "ORD-100009" + " ".repeat(1000 - "ORD-100009".length);
      const res1000 = await caller.barcode.verify({ payload: validChars });
      expect(res1000).toBeDefined();

      // > 1000 chars payload rejected by Zod schema
      const hugePayload = "X".repeat(1001);
      await expect(caller.barcode.verify({ payload: hugePayload })).rejects.toThrow();

      // verifyPayload rejects > 1000 chars
      const serviceHugeRes = await verifyPayload(hugePayload);
      expect(serviceHugeRes.valid).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Tier 3: Cross-Feature Combinations
  // --------------------------------------------------------------------------
  describe("Tier 3: Cross-Feature Combinations", () => {
    it("3.1 QR URL generated by shippingLabel resolves and verifies", async () => {
      const targetUrl = resolveShippingLabelQrTarget(
        { orderNumber: "ORD-100009" },
        "https://srv1548487.hstgr.cloud"
      );

      expect(targetUrl).toBe("https://srv1548487.hstgr.cloud/verify?ref=ORD-100009");

      // Verify URL via verifyPayload
      const res = await verifyPayload(targetUrl!);
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("ORD");
      expect(res.number).toBe("ORD-100009");
    });

    it("3.2 QR URL for sales invoice resolves and verifies", async () => {
      const invoiceRefUrl = "https://srv1548487.hstgr.cloud/verify?ref=INV-1-20260806-00068";

      const res = await verifyPayload(invoiceRefUrl);
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("INV");
      expect(res.number).toBe("INV-1-20260806-00068");
    });

    it("3.3 QR URL for work order resolves and verifies", async () => {
      const workOrderRefUrl = "https://srv1548487.hstgr.cloud/verify?ref=WO-10001";

      const res = await verifyPayload(workOrderRefUrl);
      expect(res.valid).toBe(true);
      expect(res.docType).toBe("WO");
      expect(res.number).toBe("WO-10001");
    });
  });

  // --------------------------------------------------------------------------
  // Tier 4: Real-World Scenarios
  // --------------------------------------------------------------------------
  describe("Tier 4: Real-World Scenarios", () => {
    it("4.1 end-to-end customer scan simulation of shipping label QR code", async () => {
      // Step 1: Customer receives physical parcel labeled with ORD-100009
      const parcelQrUrl = resolveShippingLabelQrTarget(
        { orderNumber: "ORD-100009" },
        "https://srv1548487.hstgr.cloud"
      );
      expect(parcelQrUrl).toBeTruthy();

      // Step 2: Smartphone camera decodes URL and issues public verification query
      const publicResult = await caller.barcode.verify({ payload: parcelQrUrl! });

      // Step 3: Authenticity confirmation and document display
      expect(publicResult.valid).toBe(true);
      expect(publicResult.docType).toBe("ORD");
      expect(publicResult.number).toBe("ORD-100009");
    });

    it("4.2 rejects tampered QR code attempting to forge order status", async () => {
      const tamperedUrl = "https://srv1548487.hstgr.cloud/verify?ref=ORD-100009-FORGED";
      const result = await caller.barcode.verify({ payload: tamperedUrl });
      expect(result.valid).toBe(false);
    });

    it("4.3 end-to-end customer scan simulation of sales invoice receipt", async () => {
      // Customer receives receipt with scannable URL
      const receiptVerifyUrl = "http://localhost:5173/verify?ref=INV-1-20260806-00068";
      const result = await caller.barcode.verify({ payload: receiptVerifyUrl });

      expect(result.valid).toBe(true);
      expect(result.docType).toBe("INV");
      expect(result.number).toBe("INV-1-20260806-00068");
    });
  });
});
