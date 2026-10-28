import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { createPurchaseOrder, confirmPurchaseOrder } from "../purchaseService";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { requestSupplierInvoiceApproval } from "../purchase/supplierInvoices";
import { requestGoodsReceiptReversal } from "../purchase/goodsReceipts";
import { settleSupplierViaExchange } from "../exchange/settleSupplier";
import { reverseExchangeTransaction } from "../exchange/reverse";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import {
  invoiceReservations,
  requestSupplierPayment,
} from "../purchase/supplierPayments";
import { withTx } from "../tx";

const db = () => getDb()!;
const maker = { userId: 1, branchId: 1, role: "admin" };
const owner = { userId: 2, branchId: 1, role: "admin", isOwner: true };
const manager = { userId: 3, branchId: 1, role: "manager" };

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, code: "AUDIT-A", name: "A", type: "MAIN" },
      { id: 2, code: "AUDIT-B", name: "B", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "audit-purchase-maker",
        name: "Maker",
        role: "admin",
        branchId: 1,
      },
      {
        id: 2,
        openId: "audit-purchase-owner",
        name: "Owner",
        role: "admin",
        branchId: 1,
        isOwner: true,
      },
      {
        id: 3,
        openId: "audit-purchase-manager",
        name: "Manager",
        role: "manager",
        branchId: 1,
      },
    ]);
  await db().insert(s.suppliers).values({ id: 1, name: "Audit supplier" });
  await db().insert(s.products).values({ id: 1, name: "Audit stock" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "AUDIT-PURCHASE", costPrice: "0" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(s.exchangeHouses).values({
    id: 1,
    name: "Audit house",
    balanceIqd: "1000000",
    balanceUsd: "0",
    balanceUsdCarryingIqd: "0",
    usdCostRate: "0",
  });
  await db().insert(s.exchangeTransactions).values({
    txnNumber: "AUDIT-EX-OPEN",
    exchangeHouseId: 1,
    branchId: 1,
    type: "OPENING",
    currency: "IQD",
    iqdAmount: "1000000",
    usdAmount: "0",
    balanceIqdAfter: "1000000",
    balanceUsdAfter: "0",
    createdBy: 1,
  });
});

async function postedPurchase({
  branchId = 1,
  quantity = "1",
  price = "100",
  rate = "1450",
  usdTotal = "100",
} = {}) {
  const created = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId,
      settlementType: "CREDIT",
      agreedCurrency: "USD",
      agreedRate: rate,
      usdTotal,
      clientRequestId: randomUUID(),
      items: [{ variantId: 1, productUnitId: 1, quantity, unitPrice: price }],
    },
    maker,
  );
  const submitted = await confirmPurchaseOrder(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "Audit full receipt request",
      clientRequestId: randomUUID(),
    },
    maker,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: randomUUID(),
      approve: true,
      confirmedFullReceipt: true,
      reason: "Audit confirmed source and full receipt",
    },
    owner,
  );
  const [order] = await db()
    .select()
    .from(s.purchaseOrders)
    .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
  const [receipt] = await db()
    .select()
    .from(s.goodsReceipts)
    .where(eq(s.goodsReceipts.purchaseOrderId, created.purchaseOrderId));
  const [receiptItem] = await db()
    .select()
    .from(s.goodsReceiptItems)
    .where(eq(s.goodsReceiptItems.goodsReceiptId, receipt.id));
  const [invoice] = await db()
    .select()
    .from(s.supplierInvoices)
    .where(
      and(
        eq(s.supplierInvoices.supplierId, 1),
        eq(s.supplierInvoices.branchId, branchId),
        eq(s.supplierInvoices.status, "POSTED"),
      ),
    );
  return { order, receipt, receiptItem, invoice };
}

function settlement(
  purchaseOrderId: number,
  amount = "100",
  requestId = randomUUID(),
) {
  return {
    exchangeHouseId: 1,
    branchId: 1,
    supplierId: 1,
    purchaseOrderId,
    currency: "IQD" as const,
    walletAmount: "148000",
    settledUsd: amount,
    clientRequestId: requestId,
  };
}

async function financialState(orderId: number) {
  const [order] = await db()
    .select()
    .from(s.purchaseOrders)
    .where(eq(s.purchaseOrders.id, orderId));
  const [supplier] = await db()
    .select()
    .from(s.suppliers)
    .where(eq(s.suppliers.id, 1));
  const [house] = await db()
    .select()
    .from(s.exchangeHouses)
    .where(eq(s.exchangeHouses.id, 1));
  const transactions = await db().select().from(s.exchangeTransactions);
  const receipts = await db().select().from(s.receipts);
  const entries = await db().select().from(s.accountingEntries);
  return { order, supplier, house, transactions, receipts, entries };
}

describe("audit 11-F01/11-F02 — canonical exchange purchase settlement", () => {
  it("rejects a manager crossing the actual purchase branch before any financial effect", async () => {
    const source = await postedPurchase({ branchId: 2 });
    const before = await financialState(source.order.id);
    await expect(
      settleSupplierViaExchange(settlement(source.order.id), manager),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await financialState(source.order.id)).toEqual(before);
  });

  it("rejects an administrator mixing the source branch with the operation branch", async () => {
    const source = await postedPurchase({ branchId: 2 });
    const before = await financialState(source.order.id);
    await expect(
      settleSupplierViaExchange(settlement(source.order.id), owner),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await financialState(source.order.id)).toEqual(before);
  });

  it("allocates the single exchange receipt, settles its invoice, replays, and reverses exactly once", async () => {
    const source = await postedPurchase();
    const command = settlement(source.order.id);
    const settled = await settleSupplierViaExchange(command, manager);
    const state = await financialState(source.order.id);
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, source.invoice.id));
    expect(invoice.paymentGate).toBe("SETTLED");
    const reserved = await withTx((tx) =>
      invoiceReservations(tx, [invoice.id]),
    );
    expect(reserved.posted.get(invoice.id)?.amount.toFixed(2)).toBe(
      "145000.00",
    );
    expect(reserved.posted.get(invoice.id)?.currencyAmount.toFixed(2)).toBe(
      "100.00",
    );
    expect(state.receipts).toHaveLength(1);
    expect(
      state.entries.filter((entry) => entry.entryType === "EXCHANGE_SETTLE"),
    ).toHaveLength(1);
    expect(state.supplier.currentBalance).toBe("0.00");
    expect(state.supplier.currentBalanceUsd).toBe("0.00");
    const [bookSource] = await db()
      .select()
      .from(s.supplierBookSettlementSources);
    const originalSource = JSON.parse(bookSource.sourceSnapshot);
    expect(originalSource.receipt.id).toBe(settled.receiptId);
    expect(originalSource.exchange.id).toBe(settled.txnId);
    expect(originalSource.entry.receiptId).toBe(settled.receiptId);
    const projection = (await loadPurchaseSettlements(db(), [state.order])).get(
      source.order.id,
    )!;
    expect(projection.requiresReview).toBe(false);
    expect(projection.remainingAmountIqd).toBe("0.00");
    expect(await settleSupplierViaExchange(command, manager)).toEqual(settled);
    expect(await financialState(source.order.id)).toEqual(state);
    await reverseExchangeTransaction(settled.txnId, owner);
    const reversed = await financialState(source.order.id);
    const [reopened] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, source.invoice.id));
    expect(reopened.paymentGate).toBe("OPEN");
    expect(reversed.order.paidAmount).toBe("0.00");
    expect(reversed.order.paidUsd).toBe("0.00");
    expect(reversed.supplier.currentBalance).toBe("145000.00");
    expect(reversed.supplier.currentBalanceUsd).toBe("100.00");
    expect(reversed.house.balanceIqd).toBe("1000000.00");
    const reversedReserved = await withTx((tx) =>
      invoiceReservations(tx, [invoice.id]),
    );
    expect(reversedReserved.posted.get(invoice.id)?.amount.toFixed(2)).toBe(
      "0.00",
    );
    await expect(
      reverseExchangeTransaction(settled.txnId, owner),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await financialState(source.order.id)).toEqual(reversed);
  });

  it("rejects a blocked formal invoice without changing the wallet, AP, or purchase caches", async () => {
    const source = await postedPurchase();
    await db()
      .update(s.supplierInvoices)
      .set({
        origin: "LEGACY",
        liabilityClass: "LEGACY_AP",
        legacyPurchaseOrderId: source.order.id,
        legacySettlementEvidenceHash: "a".repeat(64),
        paymentGate: "BLOCKED_REVIEW",
      })
      .where(eq(s.supplierInvoices.id, source.invoice.id));
    const before = await financialState(source.order.id);
    await expect(
      settleSupplierViaExchange(settlement(source.order.id), manager),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await financialState(source.order.id)).toEqual(before);
  });

  it("does not bypass a governed invoice by omitting the purchase source", async () => {
    const source = await postedPurchase();
    const before = await financialState(source.order.id);
    await expect(
      settleSupplierViaExchange(
        {
          exchangeHouseId: 1,
          branchId: 1,
          supplierId: 1,
          currency: "IQD",
          walletAmount: "145000",
          settledIqd: "145000",
          clientRequestId: randomUUID(),
        },
        manager,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await financialState(source.order.id)).toEqual(before);
  });

  it("does not pay an inactive supplier", async () => {
    const source = await postedPurchase();
    await db()
      .update(s.suppliers)
      .set({ isActive: false })
      .where(eq(s.suppliers.id, 1));
    const before = await financialState(source.order.id);
    await expect(
      settleSupplierViaExchange(settlement(source.order.id), manager),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await financialState(source.order.id)).toEqual(before);
  });

  it("does not consume an invoice reserved by a pending governed supplier payment", async () => {
    const source = await postedPurchase();
    await requestSupplierPayment(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: randomUUID(),
        currency: "USD",
        exchangeRate: "1450",
        amount: "1450",
        currencyAmount: "1",
        paymentMethod: "CARD",
        externalReference: "AUDIT-PENDING-CARD",
        evidenceType: "OTHER",
        evidenceReference: "Audit pending bank advice",
        reason: "Audit reserve supplier invoice",
        allocations: [
          {
            supplierInvoiceId: source.invoice.id,
            invoiceVersion: source.invoice.version,
            amount: "1450",
            currencyAmount: "1",
          },
        ],
      },
      maker,
    );
    const before = await financialState(source.order.id);
    await expect(
      settleSupplierViaExchange(settlement(source.order.id), manager),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await financialState(source.order.id)).toEqual(before);
  });

  it("rolls back the wallet, receipt, AP, and purchase if the canonical allocation cannot be stored", async () => {
    const source = await postedPurchase();
    const before = await financialState(source.order.id);
    await db().execute(
      sql.raw(
        "CREATE TRIGGER audit_exchange_allocation_failure BEFORE INSERT ON supplierBookSettlementAllocations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit allocation failure'",
      ),
    );
    try {
      await expect(
        settleSupplierViaExchange(settlement(source.order.id), manager),
      ).rejects.toBeDefined();
      expect(await financialState(source.order.id)).toEqual(before);
    } finally {
      await db().execute(
        sql.raw("DROP TRIGGER audit_exchange_allocation_failure"),
      );
    }
  });

  it("consumes the exact IQD source across partial USD payments and restores only the reversed portion", async () => {
    const source = await postedPurchase({
      quantity: "3",
      price: "0.3333",
      rate: "1.01",
      usdTotal: "1",
    });
    let last = 0;
    for (const amount of ["0.33", "0.33", "0.34"]) {
      const result = await settleSupplierViaExchange(
        { ...settlement(source.order.id, amount), walletAmount: "1.00" },
        manager,
      );
      last = result.txnId;
    }
    const state = await financialState(source.order.id);
    expect(state.receipts.map((row) => row.amount)).toEqual([
      "0.33",
      "0.34",
      "0.34",
    ]);
    expect(state.order.paidAmount).toBe("1.01");
    expect(state.order.paidUsd).toBe("1.00");
    expect(state.supplier.currentBalance).toBe("0.00");
    expect(state.supplier.currentBalanceUsd).toBe("0.00");
    await reverseExchangeTransaction(last, owner);
    const reversed = await financialState(source.order.id);
    expect(reversed.order.paidAmount).toBe("0.67");
    expect(reversed.order.paidUsd).toBe("0.66");
    expect(reversed.supplier.currentBalance).toBe("0.34");
    expect(reversed.supplier.currentBalanceUsd).toBe("0.34");
  });

  it("preserves a historical PO settlement with real purchase ledger evidence and no formal invoice", async () => {
    const orderId = extractInsertId(
      await db().insert(s.purchaseOrders).values({
        poNumber: "AUDIT-LEGACY-USD",
        supplierId: 1,
        branchId: 1,
        createdBy: 1,
        status: "RECEIVED",
        agreedCurrency: "USD",
        usdTotal: "100",
        agreedRate: "1450",
        subtotal: "145000",
        total: "145000",
      }),
    );
    await db().insert(s.accountingEntries).values({
      entryType: "PURCHASE",
      purchaseOrderId: orderId,
      branchId: 1,
      supplierId: 1,
      amount: "145000",
      entryDate: new Date(),
      createdBy: 1,
      dedupeKey: "AUDIT-LEGACY-PURCHASE",
    });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "145000", currentBalanceUsd: "100" })
      .where(eq(s.suppliers.id, 1));
    const settled = await settleSupplierViaExchange(
      settlement(orderId),
      manager,
    );
    const state = await financialState(orderId);
    expect(state.order.paidAmount).toBe("145000.00");
    expect(state.supplier.currentBalanceUsd).toBe("0.00");
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    await reverseExchangeTransaction(settled.txnId, owner);
    const reversed = await financialState(orderId);
    expect(reversed.order.paidAmount).toBe("0.00");
    expect(reversed.order.paidUsd).toBe("0.00");
    expect(reversed.supplier.currentBalance).toBe("145000.00");
    expect(reversed.supplier.currentBalanceUsd).toBe("100.00");
  });

  it("preserves the USD wallet carrying basis and FX while allocating and reversing the invoice", async () => {
    const source = await postedPurchase();
    await db()
      .update(s.exchangeHouses)
      .set({
        balanceUsd: "100",
        balanceUsdCarryingIqd: "140000",
        usdCostRate: "1400",
      })
      .where(eq(s.exchangeHouses.id, 1));
    await db()
      .update(s.exchangeTransactions)
      .set({ usdAmount: "100", exchangeRate: "1400", balanceUsdAfter: "100" })
      .where(eq(s.exchangeTransactions.txnNumber, "AUDIT-EX-OPEN"));
    const settled = await settleSupplierViaExchange(
      {
        ...settlement(source.order.id),
        currency: "USD",
        walletAmount: "100",
        exchangeRate: "1400",
      },
      manager,
    );
    const state = await financialState(source.order.id);
    expect(settled.fxDiff).toBe("5000.00");
    expect(state.house.balanceUsd).toBe("0.00");
    expect(state.house.balanceUsdCarryingIqd).toBe("0.00");
    expect(state.house.balanceIqd).toBe("1000000.00");
    expect(state.supplier.currentBalanceUsd).toBe("0.00");
    expect(state.receipts).toHaveLength(1);
    await reverseExchangeTransaction(settled.txnId, owner);
    const reversed = await financialState(source.order.id);
    expect(reversed.house.balanceUsd).toBe("100.00");
    expect(reversed.house.balanceUsdCarryingIqd).toBe("140000.00");
    expect(reversed.supplier.currentBalanceUsd).toBe("100.00");
    expect(reversed.order.paidAmount).toBe("0.00");
    expect(reversed.order.paidUsd).toBe("0.00");
  });
});

describe("audit 12-F03 — GRNI source residual", () => {
  async function reversiblePurchase() {
    const source = await postedPurchase({
      quantity: "3",
      price: "0.3333",
      rate: "1",
      usdTotal: "1",
    });
    expect(source.receiptItem.netAmount).toBe("1.00");
    expect(source.receiptItem.unitCostIqd).toBe("0.33");
    await requestSupplierInvoiceApproval(
      {
        supplierInvoiceId: source.invoice.id,
        expectedInvoiceVersion: source.invoice.version,
        kind: "REVERSE_INVOICE",
        requestKey: randomUUID(),
        reason: "Audit reverse formal invoice before GRN",
        evidenceType: "OTHER",
        evidenceReference: "Audit original invoice correction",
      },
      owner,
    );
    return source;
  }

  async function reverseQuantity(
    source: Awaited<ReturnType<typeof postedPurchase>>,
    quantity: number,
    requestKey = randomUUID(),
  ) {
    const [receipt] = await db()
      .select()
      .from(s.goodsReceipts)
      .where(eq(s.goodsReceipts.id, source.receipt.id));
    const command = {
      goodsReceiptId: receipt.id,
      expectedReceiptVersion: receipt.version,
      requestKey,
      reason: "Audit exact original GRNI reversal",
      lines: [
        { goodsReceiptItemId: source.receiptItem.id, baseQuantity: quantity },
      ],
    };
    await requestGoodsReceiptReversal(command, owner);
    return command;
  }

  it("reverses all original IQD value although the stored unit cost is rounded", async () => {
    const source = await reversiblePurchase();
    const command = await reverseQuantity(source, 3);
    const [reversal] = await db()
      .select()
      .from(s.goodsReceiptReversals)
      .where(eq(s.goodsReceiptReversals.goodsReceiptId, source.receipt.id));
    expect(reversal.netAmount).toBe("1.00");
    const [item] = await db()
      .select()
      .from(s.purchaseOrderItems)
      .where(
        eq(s.purchaseOrderItems.id, source.receiptItem.purchaseOrderItemId),
      );
    expect(item.receivedNet).toBe("0.00");
    expect(item.receivedUsd).toBe("0.00");
    await requestGoodsReceiptReversal(command, owner);
    expect(await db().select().from(s.goodsReceiptReversals)).toHaveLength(1);
  });

  it("uses cumulative source deltas across three partial reversals", async () => {
    const source = await reversiblePurchase();
    for (let count = 0; count < 3; count++) await reverseQuantity(source, 1);
    const reversals = await db()
      .select()
      .from(s.goodsReceiptReversals)
      .where(eq(s.goodsReceiptReversals.goodsReceiptId, source.receipt.id))
      .orderBy(s.goodsReceiptReversals.id);
    expect(reversals.map((row) => row.netAmount)).toEqual([
      "0.33",
      "0.34",
      "0.33",
    ]);
    const [receipt] = await db()
      .select()
      .from(s.goodsReceipts)
      .where(eq(s.goodsReceipts.id, source.receipt.id));
    expect(receipt.status).toBe("REVERSED");
    const [total] = await db()
      .select({
        amount: sql<string>`SUM(${s.goodsReceiptReversalItems.netAmount})`,
      })
      .from(s.goodsReceiptReversalItems)
      .where(
        eq(
          s.goodsReceiptReversalItems.goodsReceiptItemId,
          source.receiptItem.id,
        ),
      );
    expect(total.amount).toBe("1.00");
  });

  it("absorbs the actual residual left by historical rounded partial reversals", async () => {
    const source = await reversiblePurchase();
    await reverseQuantity(source, 1);
    await reverseQuantity(source, 1);
    const reversals = await db()
      .select()
      .from(s.goodsReceiptReversalItems)
      .where(
        eq(
          s.goodsReceiptReversalItems.goodsReceiptItemId,
          source.receiptItem.id,
        ),
      )
      .orderBy(s.goodsReceiptReversalItems.id);
    // The old writer used 0.33 per unit. Preserve that recorded historical
    // amount and prove the final reversal derives from the actual source trail.
    await db()
      .update(s.goodsReceiptReversalItems)
      .set({ netAmount: "0.33", totalAmount: "0.33" })
      .where(eq(s.goodsReceiptReversalItems.id, reversals[1].id));
    await db()
      .update(s.goodsReceiptReversals)
      .set({ netAmount: "0.33", totalAmount: "0.33" })
      .where(eq(s.goodsReceiptReversals.id, reversals[1].reversalId));
    await db()
      .update(s.purchaseOrderItems)
      .set({ receivedNet: "0.34" })
      .where(
        eq(s.purchaseOrderItems.id, source.receiptItem.purchaseOrderItemId),
      );
    await reverseQuantity(source, 1);
    const [last] = await db()
      .select()
      .from(s.goodsReceiptReversalItems)
      .where(
        eq(
          s.goodsReceiptReversalItems.goodsReceiptItemId,
          source.receiptItem.id,
        ),
      )
      .orderBy(sql`${s.goodsReceiptReversalItems.id} DESC`)
      .limit(1);
    expect(last.netAmount).toBe("0.34");
    const [item] = await db()
      .select()
      .from(s.purchaseOrderItems)
      .where(
        eq(s.purchaseOrderItems.id, source.receiptItem.purchaseOrderItemId),
      );
    expect(item.receivedNet).toBe("0.00");
  });
});
