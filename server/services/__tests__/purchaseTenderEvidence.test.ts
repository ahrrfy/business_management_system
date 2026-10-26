import React from "react";
import { Router } from "wouter";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PurchasePaymentEvidence,
  purchasePaymentEvidencePrintText,
} from "@/components/purchases/PurchasePaymentEvidence";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { sha256, stableCanonical } from "../purchase/grniAccounting";
import { loadPurchasePaymentEvidence } from "../purchase/paymentEvidence";
import { purchasePaymentSourceLabel } from "@shared/purchasePaymentEvidence";
import { truncateTables } from "./__testUtils__";

const db = () => getDb()!;
const order = { id: 1, branchId: 1, supplierId: 1 };
beforeEach(async () => {
  await truncateTables([
    "supplierBookSettlementAllocations",
    "supplierBookSettlementSources",
    "supplierInvoices",
    "accountingEntries",
    "receipts",
    "purchaseOrders",
    "suppliers",
    "users",
    "branches",
  ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "OTHER", code: "OTHER", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 7,
    openId: "evidence-owner",
    name: "Owner",
    role: "manager",
    branchId: 1,
    isOwner: true,
  });
  await db()
    .insert(s.suppliers)
    .values([
      { id: 1, name: "Supplier" },
      { id: 2, name: "Other" },
    ]);
  await db()
    .insert(s.purchaseOrders)
    .values({
      id: 1,
      poNumber: "EVIDENCE-PO-1",
      supplierId: 1,
      branchId: 1,
      createdBy: 7,
      status: "RECEIVED",
      settlementType: "CASH",
      subtotal: "100",
      total: "100",
      agreedCurrency: "IQD",
      orderDate: new Date("2026-01-02T00:00:00Z"),
    });
});

async function receipt({
  linked = true,
  direction = "OUT",
  status = "COMPLETED",
  supplierId = 1,
  branchId = 1,
  amount = "100.00",
}: {
  linked?: boolean;
  direction?: "IN" | "OUT";
  status?: "COMPLETED" | "REVERSED";
  supplierId?: number;
  branchId?: number;
  amount?: string;
} = {}) {
  const id = extractInsertId(
    await db().insert(s.receipts).values({
      direction,
      status,
      branchId,
      amount,
      paymentMethod: "CARD",
      partyType: "SUPPLIER",
      partyId: supplierId,
      referenceNumber: "BANK-ORIGINAL",
      cardLastFour: "1234",
      approvalStatus: "APPROVED",
      createdBy: 7,
    }),
  );
  const entryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: direction === "OUT" ? "PAYMENT_OUT" : "PAYMENT_IN",
        purchaseOrderId: linked ? 1 : null,
        branchId,
        supplierId,
        receiptId: id,
        amount,
        createdBy: 7,
        entryDate: new Date("2026-01-02T00:00:00Z"),
      }),
  );
  return { id, entryId };
}
async function bookAllocation(targetOrderId = 1) {
  const { id, entryId } = await receipt({ linked: false, amount: "150.00" });
  const [original] = await db()
    .select()
    .from(s.receipts)
    .where(eq(s.receipts.id, id));
  const invoiceId = extractInsertId(
    await db()
      .insert(s.supplierInvoices)
      .values({
        invoiceNumber: "EVIDENCE-SI",
        clientRequestId: "EVIDENCE-SI",
        supplierId: 1,
        branchId: 1,
        invoiceDate: "2026-01-02",
        currency: "IQD",
        subtotal: "100",
        totalAmount: "100",
        payloadCanonical: "{}",
        payloadHash: "1".repeat(64),
        externalInvoiceNumber: "EVIDENCE-EXTERNAL",
        externalNumberNorm: "EVIDENCEEXTERNAL",
        evidenceReference: "EVIDENCE-DOCUMENT",
        evidenceType: "OTHER",
        createdBy: 7,
      }),
  );
  const snapshot = stableCanonical(
    JSON.parse(
      JSON.stringify({
        purpose: "PURCHASE_ADVANCE",
        version: 1,
        receipt: original,
      }),
    ),
  );
  const sourceId = extractInsertId(
    await db()
      .insert(s.supplierBookSettlementSources)
      .values({
        supplierId: 1,
        branchId: 1,
        sourceAccountingEntryId: entryId,
        sourceReceiptId: id,
        kind: "PAYMENT",
        amount: "150",
        sourceSnapshot: snapshot,
        sourceHash: sha256(snapshot),
        planHash: "2".repeat(64),
        adoptionKey: "EVIDENCE-BOOK",
        adoptedBy: 7,
        reversalHistory: "[]",
      }),
  );
  const target = stableCanonical({
    purchaseOrderId: targetOrderId,
    invoice: { id: invoiceId, supplierId: 1, branchId: 1 },
  });
  const allocationId = extractInsertId(
    await db()
      .insert(s.supplierBookSettlementAllocations)
      .values({
        sourceId,
        supplierInvoiceId: invoiceId,
        allocatedAmount: "100",
        allocatedCurrencyAmount: "100",
        targetSnapshot: target,
        targetHash: sha256(target),
      }),
  );
  return { id, sourceId, allocationId };
}

describe("purchase receipt evidence projection", () => {
  it("returns original card receipt and PO-linked refund history in deterministic order", async () => {
    const original = await receipt({ status: "REVERSED" });
    const refund = await receipt({ direction: "IN", amount: "25.00" });
    const rows = await loadPurchasePaymentEvidence(db(), order, null);
    expect(rows.map((row) => row.id)).toEqual([original.id, refund.id]);
    expect(rows[0]).toMatchObject({
      direction: "OUT",
      amount: "100.00",
      referenceNumber: "BANK-ORIGINAL",
      cardLastFour: "1234",
      status: "REVERSED",
    });
    expect(rows[1]).toMatchObject({ direction: "IN", amount: "25.00" });
  });
  it("does not turn an unallocated draft selection into executed payment", async () => {
    const prior = await receipt({ linked: false });
    expect(
      await loadPurchasePaymentEvidence(db(), order, {
        mode: "DRAWER",
        previousReceiptId: prior.id,
      }),
    ).toEqual([]);
  });
  it("shows allocated amount separately from the larger original receipt and original card identity", async () => {
    const prior = await bookAllocation();
    const rows = await loadPurchasePaymentEvidence(db(), order, {
      mode: "CARD",
      accountId: 9,
      referenceNumber: "UNUSED-INTENT",
      cardLastFour: "9876",
      previousReceiptId: prior.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: prior.id,
      allocatedAmount: "100.00",
      amount: "150.00",
      referenceNumber: "BANK-ORIGINAL",
      cardLastFour: "1234",
    });
    expect(purchasePaymentSourceLabel(rows[0]!)).toContain("1234");
    const renderedEvidence = {
      tender: {
        mode: "CARD" as const,
        accountId: 9,
        referenceNumber: "UNUSED-INTENT",
        cardLastFour: "9876",
        previousReceiptId: prior.id,
      },
      paymentReceipts: rows,
    };
    const printed = purchasePaymentEvidencePrintText(renderedEvidence);
    expect(printed).toContain("المصدر المحدد");
    expect(printed).toContain("9876");
    expect(printed).toContain("1234");
    expect(printed).toContain("BANK-ORIGINAL");
    expect(printed).toContain("100");
    expect(printed).toContain("150");
    const html = renderToStaticMarkup(
      React.createElement(Router, {
        ssrPath: "/",
        children: React.createElement(
          PurchasePaymentEvidence,
          renderedEvidence,
        ),
      }),
    );
    expect(html).toContain(`/treasury?tab=vouchers&amp;voucherId=${prior.id}`);
    expect(html).toContain("السداد الفعلي المرتبط بالفاتورة");
  });
  it("excludes allocations proven to belong to another purchase order", async () => {
    const prior = await bookAllocation(2);
    expect(
      await loadPurchasePaymentEvidence(db(), order, {
        mode: "TREASURY",
        previousReceiptId: prior.id,
      }),
    ).toEqual([]);
  });
  it("fails closed when the allocation hash has changed", async () => {
    const prior = await bookAllocation();
    await db()
      .update(s.supplierBookSettlementAllocations)
      .set({ targetHash: "0".repeat(64) })
      .where(eq(s.supplierBookSettlementAllocations.id, prior.allocationId));
    await expect(
      loadPurchasePaymentEvidence(db(), order, {
        mode: "DRAWER",
        previousReceiptId: prior.id,
      }),
    ).rejects.toThrow(/بصمة/);
  });
  it("retains original receipt history when its allocation was fully reversed", async () => {
    const prior = await bookAllocation();
    await db()
      .update(s.supplierBookSettlementAllocations)
      .set({ reversedAmount: "100", reversedCurrencyAmount: "100" })
      .where(eq(s.supplierBookSettlementAllocations.id, prior.allocationId));
    const rows = await loadPurchasePaymentEvidence(db(), order, {
      mode: "DRAWER",
      previousReceiptId: prior.id,
    });
    expect(rows[0]).toMatchObject({
      amount: "150.00",
      allocatedAmount: "0.00",
      status: "COMPLETED",
    });
  });
  it("rejects modified immutable receipt documentary fields", async () => {
    const prior = await bookAllocation();
    await db()
      .update(s.receipts)
      .set({ referenceNumber: "ALTERED" })
      .where(eq(s.receipts.id, prior.id));
    await expect(
      loadPurchasePaymentEvidence(db(), order, {
        mode: "DRAWER",
        previousReceiptId: prior.id,
      }),
    ).rejects.toThrow(/دليله الأصلي/);
  });
  it("keeps branch and supplier evidence isolated and leaves receipts unchanged", async () => {
    await receipt({ supplierId: 2 });
    await receipt({ branchId: 2 });
    const included = await receipt();
    const before = await db().select().from(s.receipts);
    expect(
      (await loadPurchasePaymentEvidence(db(), order, null)).map(
        (row) => row.id,
      ),
    ).toEqual([included.id]);
    expect(await db().select().from(s.receipts)).toEqual(before);
  });
});
