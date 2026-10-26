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
import {
  createExchangeHouse,
  settleSupplierViaExchange,
  reverseExchangeTransaction,
} from "../exchangeHouseService";

const db = () => getDb()!;
const order = { id: 1, branchId: 1, supplierId: 1 };
beforeEach(async () => {
  await truncateTables([
    "supplierBookSettlementAllocations",
    "supplierBookSettlementSources",
    "exchangeTransactions",
    "exchangeHouses",
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
  if (targetOrderId !== 1) {
    const [first] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, 1));
    await db()
      .insert(s.purchaseOrders)
      .values({
        ...first,
        id: targetOrderId,
        poNumber: `EVIDENCE-PO-${targetOrderId}`,
      });
  }
  const invoiceId = extractInsertId(
    await db()
      .insert(s.supplierInvoices)
      .values({
        invoiceNumber: "EVIDENCE-SI",
        clientRequestId: "EVIDENCE-SI",
        origin: "LEGACY",
        liabilityClass: "LEGACY_AP",
        legacyPurchaseOrderId: targetOrderId,
        legacySettlementEvidenceHash: "3".repeat(64),
        status: "POSTED",
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
  return { id, sourceId, allocationId, invoiceId };
}

describe("purchase receipt evidence projection", () => {
  it("scopes a prior source with more than500 other purchase allocations before the evidence bound", async () => {
    const prior = await bookAllocation();
    const [first] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, prior.invoiceId));
    const other = Array.from({ length: 501 }, (_, index) => ({
      orderId: index + 2,
      invoiceId: prior.invoiceId + 1000 + index,
    }));
    await db()
      .insert(s.purchaseOrders)
      .values(
        other.map(({ orderId }) => ({
          id: orderId,
          poNumber: `OTHER-${orderId}`,
          supplierId: 1,
          branchId: 1,
          subtotal: "0.01",
          total: "0.01",
          settlementType: "CASH" as const,
          status: "RECEIVED" as const,
          createdBy: 7,
        })),
      );
    await db()
      .insert(s.supplierInvoices)
      .values(
        other.map(({ orderId, invoiceId }) => ({
          ...first,
          id: invoiceId,
          invoiceNumber: `OTHER-${invoiceId}`,
          clientRequestId: `OTHER-${invoiceId}`,
          legacyPurchaseOrderId: orderId,
          subtotal: "0.01",
          totalAmount: "0.01",
          externalInvoiceNumber: null,
          externalNumberNorm: null,
        })),
      );
    await db()
      .insert(s.supplierBookSettlementAllocations)
      .values(
        other.map(({ orderId, invoiceId }) => {
          const targetSnapshot = stableCanonical({
            purchaseOrderId: orderId,
            invoice: { id: invoiceId, supplierId: 1, branchId: 1 },
          });
          return {
            sourceId: prior.sourceId,
            supplierInvoiceId: invoiceId,
            allocatedAmount: "0.01",
            allocatedCurrencyAmount: "0.01",
            targetSnapshot,
            targetHash: sha256(targetSnapshot),
          };
        }),
      );
    const tender = { mode: "TREASURY" as const, previousReceiptId: prior.id };
    expect(
      await loadPurchasePaymentEvidence(db(), order, tender),
    ).toMatchObject([{ id: prior.id, allocatedAmount: "100.00" }]);
    expect(
      await loadPurchasePaymentEvidence(db(), { ...order, id: 502 }, tender),
    ).toMatchObject([{ id: prior.id, allocatedAmount: "0.01" }]);
  });

  it("projects the real PO-linked exchange OUT and its verified reversal IN without writing evidence", async () => {
    const actor = { userId: 7, branchId: 1, role: "manager", isOwner: true };
    const reverser = { ...actor, userId: 8 };
    await db()
      .insert(s.users)
      .values({
        id: 8,
        openId: "evidence-reverser",
        name: "Reverser",
        role: "manager",
        branchId: 1,
        isOwner: true,
      });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "100", currentBalanceUsd: "1" })
      .where(eq(s.suppliers.id, 1));
    await db()
      .update(s.purchaseOrders)
      .set({ agreedCurrency: "USD", usdTotal: "1", agreedRate: "100" })
      .where(eq(s.purchaseOrders.id, 1));
    const house = await createExchangeHouse(
      { name: "Evidence exchange" },
      actor,
    );
    const settled = await settleSupplierViaExchange(
      {
        exchangeHouseId: house.id,
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
        currency: "IQD",
        walletAmount: "100",
        settledUsd: "1",
        confirmNegative: true,
      },
      actor,
    );
    const before = await db().select().from(s.receipts);
    const projected = await loadPurchasePaymentEvidence(db(), order, null);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: settled.receiptId,
      voucherNumber: settled.voucherNumber,
      direction: "OUT",
      paymentMethod: "EXCHANGE",
      amount: "100.00",
      referenceNumber: settled.txnNumber,
      status: "COMPLETED",
    });
    expect(await db().select().from(s.receipts)).toEqual(before);
    await reverseExchangeTransaction(settled.txnId, reverser);
    const afterReverse = await db().select().from(s.receipts);
    const reversed = await loadPurchasePaymentEvidence(db(), order, null);
    expect(reversed).toHaveLength(2);
    expect(reversed[0]).toMatchObject({
      id: settled.receiptId,
      direction: "OUT",
      paymentMethod: "EXCHANGE",
      amount: "100.00",
      status: "REVERSED",
    });
    expect(reversed[1]).toMatchObject({
      direction: "IN",
      paymentMethod: "EXCHANGE",
      amount: "100.00",
      referenceNumber: `REV-EX-${settled.txnNumber}`,
      status: "COMPLETED",
    });
    expect(await db().select().from(s.receipts)).toEqual(afterReverse);
    await db()
      .update(s.receipts)
      .set({ amount: "99" })
      .where(eq(s.receipts.id, reversed[1].id));
    await expect(
      loadPurchasePaymentEvidence(db(), order, null),
    ).rejects.toThrow(/عكس الصيرفة/);
  });
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
