import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { PurchaseTenderInput } from "@shared/purchaseTender";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createPurchaseOrder,
  confirmPurchaseOrder,
  updatePurchaseOrder,
} from "../purchaseService";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { readPurchaseTenderTx } from "../purchase/tender";
import { getCardSummary } from "../cardAccountService";
import { computeExpectedCash } from "../shiftService";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import { getSupplierStatement } from "../reports/apAging";
import { getPurchaseIntegrityReport } from "../purchaseIntegrityService";
import {
  requestSupplierPayment,
  requestSupplierPaymentInTx,
  decideSupplierPayment,
  requestSupplierPaymentRefund,
  decideSupplierPaymentRefund,
} from "../purchase/supplierPayments";
import { withTx } from "../tx";
import {
  createVoucher,
  cancelVoucher,
  approveVoucher,
} from "../voucherService";
import { listSupplierAdvanceRefundSources } from "../purchase/advanceRefund";
import { listPurchasePriorPayments } from "../purchase/priorPayment";
import {
  loadSupplierAdvanceRefundLinks,
  readAdvanceRefundEvidence,
  ADVANCE_REFUND_ACTION,
  ADVANCE_REFUND_FRAGMENT_ACTION,
} from "../purchase/advanceRefundEvidence";
import { sha256, stableCanonical } from "../purchase/grniAccounting";
import {
  requestPurchaseReturn,
  decidePurchaseReturn,
  requestPurchaseReturnReversal,
  decidePurchaseReturnReversal,
} from "../purchase/returnGovernance";
import {
  createExchangeHouse,
  settleSupplierViaExchange,
  reverseExchangeTransaction,
} from "../exchangeHouseService";
import { truncateTables } from "./__testUtils__";

const maker = { userId: 1, branchId: 1, role: "admin" };
const owner = { userId: 2, branchId: 1, role: "manager", isOwner: true };
const db = () => getDb()!;
const tables = [
  "purchaseReturnReversalItems",
  "purchaseReturnReversals",
  "purchaseReturnReversalRequestItems",
  "purchaseReturnReversalRequests",
  "purchaseReturnItems",
  "purchaseReturns",
  "purchaseReturnRequestItems",
  "purchaseReturnRequests",
  "exchangeTransactions",
  "exchangeHouses",
  "idempotencyKeys",
  "auditLogs",
  "supplierBookSettlementAllocations",
  "supplierBookSettlementSources",
  "supplierPaymentRefundItems",
  "supplierPaymentRefunds",
  "supplierPaymentRefundRequestItems",
  "supplierPaymentRefundRequests",
  "supplierPaymentAllocations",
  "supplierPayments",
  "supplierPaymentRequestAllocations",
  "supplierPaymentRequests",
  "supplierInvoiceApprovalRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierInvoices",
  "goodsReceiptAccountingLinks",
  "goodsReceiptItems",
  "goodsReceipts",
  "purchaseOrderControlRequests",
  "purchaseOrderEvents",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accountingEntries",
  "expenses",
  "receipts",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "purchaseControlSettings",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "suppliers",
  "accounts",
  "users",
  "branches",
] as const;

beforeEach(async () => {
  await truncateTables(tables);
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "tender-maker",
        name: "منشئ",
        role: "admin",
        branchId: 1,
      },
      {
        id: 2,
        openId: "tender-owner",
        name: "معتمد",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "المورد", currentBalance: "0" });
  await db().insert(s.accounts).values({
    id: 50,
    code: "1150",
    name: "حساب البطاقة والبنك",
    type: "ASSET",
    systemRole: "CARD_BANK",
  });
  await db().insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    openingBalance: "500",
    status: "OPEN",
    openGuard: "1:1:RETAIL",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "2000",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 2,
  });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "TENDER-PAPER", costPrice: "0" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
});

const card = (referenceNumber: string = randomUUID()): PurchaseTenderInput => ({
  mode: "CARD",
  accountId: 50,
  cardLastFour: "4321",
  referenceNumber,
});
async function draft(tender: PurchaseTenderInput, amount = "100") {
  return createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      tender,
      clientRequestId: randomUUID(),
      items: [
        { variantId: 1, productUnitId: 1, quantity: "1", unitPrice: amount },
      ],
    },
    maker,
  );
}
async function submit(created: Awaited<ReturnType<typeof draft>>) {
  const request = await confirmPurchaseOrder(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "إرسال الفاتورة للاعتماد",
      clientRequestId: randomUUID(),
    },
    maker,
  );
  return {
    requestId: request.requestId,
    decisionKey: randomUUID(),
    approve: true,
    reason: "تحققت من وصول البضاعة والسداد",
    confirmedFullReceipt: true,
  } as const;
}
async function approve(tender: PurchaseTenderInput, amount = "100") {
  const created = await draft(tender, amount);
  const decision = await submit(created);
  await decidePurchaseOrderControl(decision, owner);
  return { created, decision };
}
async function balances() {
  const [supplier] = await db()
    .select()
    .from(s.suppliers)
    .where(eq(s.suppliers.id, 1));
  return {
    supplier: supplier.currentBalance,
    drawer: await db().transaction(async (tx) =>
      (await computeExpectedCash(tx, 1, "500")).toFixed(2),
    ),
    treasury: await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    ),
    card: (
      await getCardSummary({ branchId: 1 }, { role: "admin", branchId: 1 })
    ).balance,
  };
}
async function previousPayment(amount: string) {
  // Existing approved advance, with its original receipt/GL/AP effect already
  // present before the purchase. Adoption must preserve these originals.
  const receiptId = extractInsertId(
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        amount,
        direction: "OUT",
        paymentMethod: "CARD",
        cardLastFour: "1111",
        referenceNumber: randomUUID(),
        partyType: "SUPPLIER",
        partyId: 1,
        description: "دفعة سابقة مثبتة",
        voucherNumber: `ADV-${randomUUID()}`,
        createdBy: 1,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 2,
        approvedAt: new Date("2026-01-01T00:00:00Z"),
        voucherDate: new Date("2026-01-01T00:00:00Z"),
      }),
  );
  await db()
    .insert(s.accountingEntries)
    .values({
      entryType: "PAYMENT_OUT",
      branchId: 1,
      supplierId: 1,
      receiptId,
      amount,
      entryDate: new Date("2026-01-01T00:00:00Z"),
      createdBy: 1,
    });
  await db()
    .update(s.suppliers)
    .set({ currentBalance: sql`${s.suppliers.currentBalance} - ${amount}` })
    .where(eq(s.suppliers.id, 1));
  return receiptId;
}

function refundInput(sourceReceiptId?: number, amount = "10") {
  return {
    voucherType: "RECEIPT" as const,
    branchId: 1,
    partyType: "SUPPLIER" as const,
    partyId: 1,
    paymentMethod: "CASH" as const,
    amount,
    description: "قبض استرداد دفعة المورد الأصلية",
    supplierAdvanceRefundReceiptId: sourceReceiptId,
    clientRequestId: randomUUID(),
  };
}
async function advance(sourceReceiptId: number) {
  const [row] = await db()
    .select()
    .from(s.supplierBookSettlementSources)
    .where(
      eq(s.supplierBookSettlementSources.sourceReceiptId, sourceReceiptId),
    );
  return row;
}
async function availability(sourceReceiptId: number) {
  return (
    await listSupplierAdvanceRefundSources(
      { supplierId: 1, branchId: 1 },
      maker,
    )
  ).find((row) => row.id === sourceReceiptId);
}

describe("purchase advance refund public voucher lifecycle", () => {
  it("preserves large allocation evidence beyond the old audit cap through replay and cancellation", async () => {
    const sourceId = await previousPayment("400");
    await approve({ mode: "DRAWER", previousReceiptId: sourceId }, "1");
    const [templateInvoice] = await db().select().from(s.supplierInvoices);
    const [templateOrder] = await db().select().from(s.purchaseOrders);
    const [templateAllocation] = await db()
      .select()
      .from(s.supplierBookSettlementAllocations);
    // 400 targets exceed 8192 bytes even when allocation IDs start at one.
    // Expand a valid posted fixture to separately owned invoice targets;
    // the refund, retry and cancellation themselves use the public services.
    for (let index = 1; index < 400; index++) {
      const { id: _orderId, ...order } = templateOrder;
      const orderId = extractInsertId(
        await db()
          .insert(s.purchaseOrders)
          .values({
            ...order,
            poNumber: `LARGE-${index}`,
            currentRevisionId: null,
            approvedRevisionId: null,
          }),
      );
      const { id: _invoiceId, ...invoice } = templateInvoice;
      const postingEntryId = extractInsertId(
        await db()
          .insert(s.accountingEntries)
          .values({
            branchId: 1,
            supplierId: 1,
            purchaseOrderId: orderId,
            entryType: "PURCHASE",
            amount: "1",
            purchaseLiabilityAccount: "AP",
            createdBy: 1,
            entryDate: new Date(),
          }),
      );
      const invoiceId = extractInsertId(
        await db()
          .insert(s.supplierInvoices)
          .values({
            ...invoice,
            origin: "LEGACY",
            liabilityClass: "LEGACY_AP",
            legacySettlementEvidenceHash: sha256(`large:${index}`),
            postingEntryId,
            invoiceNumber: `LARGE-INV-${index}`,
            clientRequestId: randomUUID(),
            externalInvoiceNumber: null,
            externalNumberNorm: null,
            legacyPurchaseOrderId: orderId,
          }),
      );
      const snapshot = stableCanonical({
        ...invoice,
        id: invoiceId,
        legacyPurchaseOrderId: orderId,
      });
      await db()
        .insert(s.supplierBookSettlementAllocations)
        .values({
          sourceId: templateAllocation.sourceId,
          supplierInvoiceId: invoiceId,
          allocatedAmount: "1",
          allocatedCurrencyAmount: "1",
          targetSnapshot: snapshot,
          targetHash: sha256(snapshot),
        });
    }
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "0" })
      .where(eq(s.suppliers.id, 1));
    const input = refundInput(sourceId, "400");
    const refund = await createVoucher(input, maker);
    const evidence = await readAdvanceRefundEvidence(db(), refund.receiptId);
    expect(evidence?.allocations).toHaveLength(400);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          data: evidence,
          hash: sha256(stableCanonical(evidence)),
        }),
      ),
    ).toBeGreaterThan(8192);
    const chunks = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, ADVANCE_REFUND_FRAGMENT_ACTION));
    expect(chunks.length).toBeGreaterThan(10);
    expect(
      chunks.every(
        (row) => Buffer.byteLength(JSON.stringify(row.newValue)) < 8192,
      ),
    ).toBe(true);
    expect((await createVoucher(input, maker)).receiptId).toBe(
      refund.receiptId,
    );
    const cancellation = await cancelVoucher(refund.receiptId, maker);
    await approveVoucher(cancellation.approvalReceiptId!, owner);
    expect((await advance(sourceId)).reversedAmount).toBe("0.00");
    expect(
      (await db().select().from(s.supplierBookSettlementAllocations)).every(
        (row) => row.reversedAmount === "0.00",
      ),
    ).toBe(true);
    expect((await balances()).supplier).toBe("0.00");
    expect(
      (await readAdvanceRefundEvidence(db(), refund.receiptId))?.allocations,
    ).toHaveLength(400);
  }, 120000);

  it("accepts an owned governed cash return before and after its formal reversal", async () => {
    await approve(card());
    const [invoice] = await db().select().from(s.supplierInvoices);
    const [allocation] = await db()
      .select()
      .from(s.supplierInvoiceMatchAllocations);
    const request = await requestPurchaseReturn(
      {
        supplierInvoiceId: invoice.id,
        matchRunId: allocation.matchRunId,
        expectedInvoiceVersion: invoice.version,
        requestKey: randomUUID(),
        settlement: "CASH",
        paymentMethod: "CASH",
        evidenceType: "RETURN_NOTE",
        evidenceReference: randomUUID(),
        reason: "إعادة بضاعة معيبة واسترداد ثمنها",
        lines: [{ matchAllocationId: allocation.id, baseQuantity: 1 }],
      },
      maker,
    );
    await decidePurchaseReturn(
      {
        requestId: request.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "تحققنا من البضاعة والمبلغ",
      },
      owner,
    );
    const sourceId = await previousPayment("150");
    expect((await availability(sourceId))?.unusedAmount).toBe("150.00");
    const [returned] = await db().select().from(s.purchaseReturns);
    const [item] = await db().select().from(s.purchaseReturnItems);
    const reverse = await requestPurchaseReturnReversal(
      {
        purchaseReturnId: returned.id,
        expectedReturnVersion: returned.version,
        requestKey: randomUUID(),
        evidenceType: "SIGNED_APPROVAL",
        evidenceReference: randomUUID(),
        reason: "عكس المرتجع بعد التحقق من الخطأ",
        lines: [{ purchaseReturnItemId: item.id, baseQuantity: 1 }],
      },
      maker,
    );
    await decidePurchaseReturnReversal(
      {
        requestId: reverse.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "اعتماد عكس المرتجع",
      },
      owner,
    );
    expect((await availability(sourceId))?.unusedAmount).toBe("150.00");
    await createVoucher(refundInput(sourceId), maker);
    expect((await availability(sourceId))?.unusedAmount).toBe("140.00");
  });

  it("accepts only the owned exchange reversal pair, not a public copied reference", async () => {
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "100" })
      .where(eq(s.suppliers.id, 1));
    const house = await createExchangeHouse(
      { name: "صيرفة اختبار الاسترداد" },
      maker,
    );
    const settled = await settleSupplierViaExchange(
      {
        exchangeHouseId: house.id,
        branchId: 1,
        supplierId: 1,
        currency: "IQD",
        walletAmount: "100",
        settledIqd: "100",
        confirmNegative: true,
      },
      maker,
    );
    await reverseExchangeTransaction(settled.txnId, owner);
    const sourceId = await previousPayment("150");
    expect((await availability(sourceId))?.unusedAmount).toBe("150.00");
    await createVoucher(refundInput(sourceId), maker);
    expect((await availability(sourceId))?.unusedAmount).toBe("140.00");
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "IN",
        amount: "100",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        voucherNumber: "FORGED-REV",
        referenceNumber: `REV-EX-${settled.txnNumber}`,
      });
    await expect(availability(sourceId)).rejects.toThrow(/غير مربوط/);
  });

  it.each(["PURCHASE-RETURN:999", "REV-EX-EX-1-999"])(
    "does not trust a public supplier receipt reference %s",
    async (referenceNumber) => {
      await createVoucher({ ...refundInput(), referenceNumber }, maker);
      const sourceId = await previousPayment("150");
      await expect(availability(sourceId)).rejects.toThrow(/غير مربوط/);
    },
  );

  it("recognizes a canonical full OUT cancellation while rejecting a fabricated cancellation reference", async () => {
    const original = await previousPayment("100");
    expect((await cancelVoucher(original, owner)).status).toBe("REVERSED");
    const sourceId = await previousPayment("150");
    expect((await availability(sourceId))?.unusedAmount).toBe("150.00");
    await expect(
      createVoucher(
        { ...refundInput(), referenceNumber: `CANCEL-VCH-${original}` },
        maker,
      ),
    ).rejects.toThrow();
  });
  it("does not let pending original cancellation expose an unbound refund bypass", async () => {
    const sourceId = await previousPayment("150");
    const cancellation = await cancelVoucher(sourceId, maker);
    expect(cancellation.status).toBe("PENDING_APPROVAL");
    await expect(createVoucher(refundInput(), maker)).rejects.toThrow(
      /سند الصرف الأصلي/,
    );
    expect((await balances()).supplier).toBe("-150.00");
  });
  it("rejects unbound supplier IN against a live native CARD payment", async () => {
    await approve(card());
    const before = await balances();
    await expect(createVoucher(refundInput(), maker)).rejects.toThrow(
      /استرداد دفعات الموردين/,
    );
    expect(await balances()).toEqual(before);
    expect((await db().select().from(s.supplierInvoices))[0].paymentGate).toBe(
      "SETTLED",
    );
  });
  it("binds CARD-source refund received as CASH, replays once, and spends only the remaining40 plus new10", async () => {
    const sourceId = await previousPayment("150");
    await approve({ mode: "DRAWER", previousReceiptId: sourceId });
    expect((await availability(sourceId))?.unusedAmount).toBe("50.00");
    const input = refundInput(sourceId);
    const refund = await createVoucher(input, maker);
    expect(
      await loadSupplierAdvanceRefundLinks(db(), refund.receiptId),
    ).toMatchObject({ kind: "ADVANCE_REFUND", sourceReceiptId: sourceId });
    expect(await loadSupplierAdvanceRefundLinks(db(), sourceId)).toMatchObject({
      kind: "ADVANCE_SOURCE",
      refundReceiptIds: [refund.receiptId],
    });
    expect(await createVoucher(input, maker)).toEqual(refund);
    expect((await availability(sourceId))?.unusedAmount).toBe("40.00");
    expect((await balances()).supplier).toBe("-40.00");
    expect((await balances()).drawer).toBe("510.00");
    await expect(createVoucher(refundInput(), maker)).rejects.toThrow(
      /سند الصرف الأصلي/,
    );
    await approve({ mode: "TREASURY", previousReceiptId: sourceId }, "50");
    expect((await availability(sourceId))?.unusedAmount).toBe("0.00");
    expect((await balances()).supplier).toBe("0.00");
    expect((await balances()).treasury).toBe("1990.00");
    const payments = await db().select().from(s.supplierPayments);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe("10.00");
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, refund.receiptId))
      )[0],
    ).toMatchObject({
      direction: "IN",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
    });
  });

  it("adopts an unclaimed OUT before first invoice and does not reuse refunded money", async () => {
    const sourceId = await previousPayment("150");
    await createVoucher(refundInput(sourceId), maker);
    expect((await availability(sourceId))?.unusedAmount).toBe("140.00");
    expect(
      await db().select().from(s.supplierBookSettlementAllocations),
    ).toHaveLength(0);
    await approve({ mode: "TREASURY", previousReceiptId: sourceId }, "150");
    expect((await balances()).supplier).toBe("0.00");
    expect((await balances()).treasury).toBe("1990.00");
  });

  it("cancels the refund once, restoring original-source capacity and actual cash", async () => {
    const sourceId = await previousPayment("150");
    await approve({ mode: "DRAWER", previousReceiptId: sourceId });
    const refund = await createVoucher(refundInput(sourceId), maker);
    const cancelled = await cancelVoucher(refund.receiptId, owner);
    expect(cancelled.status).toBe("REVERSED");
    const cancellationId = (await loadSupplierAdvanceRefundLinks(
      db(),
      sourceId,
    ))!.cancellationReceiptIds[0];
    expect(
      await loadSupplierAdvanceRefundLinks(db(), cancellationId),
    ).toMatchObject({
      kind: "ADVANCE_REFUND_CANCELLATION",
      sourceReceiptId: sourceId,
      refundedReceiptId: refund.receiptId,
    });
    expect((await advance(sourceId)).reversedAmount).toBe("0.00");
    expect((await availability(sourceId))?.unusedAmount).toBe("50.00");
    expect((await balances()).supplier).toBe("-50.00");
    expect((await balances()).drawer).toBe("500.00");
    if (cancelled.approvalReceiptId)
      await approveVoucher(cancelled.approvalReceiptId, owner);
    await expect(cancelVoucher(refund.receiptId, owner)).rejects.toThrow(
      /ملغى/,
    );
    expect((await availability(sourceId))?.unusedAmount).toBe("50.00");
  });

  it("does not overallocate on refund cancellation after a new native payment; restored advance can fund a new invoice", async () => {
    const sourceId = await previousPayment("150");
    await approve({ mode: "DRAWER", previousReceiptId: sourceId });
    const refund = await createVoucher(refundInput(sourceId, "70"), maker);
    const [invoice] = await db().select().from(s.supplierInvoices);
    const payment = await requestSupplierPayment(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: randomUUID(),
        currency: "IQD",
        amount: "20",
        currencyAmount: "20",
        paymentMethod: "CARD",
        externalReference: randomUUID(),
        evidenceType: "BANK_ADVICE",
        evidenceReference: "سداد فعلي مستقل",
        reason: "إكمال الفاتورة بعد الاسترداد",
        allocations: [
          {
            supplierInvoiceId: invoice.id,
            invoiceVersion: invoice.version,
            amount: "20",
            currencyAmount: "20",
          },
        ],
      },
      maker,
    );
    await decideSupplierPayment(
      {
        requestId: payment.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "تحققت من السداد",
      },
      owner,
    );
    await cancelVoucher(refund.receiptId, owner);
    expect((await availability(sourceId))?.unusedAmount).toBe("70.00");
    expect(
      (
        await db()
          .select()
          .from(s.supplierInvoices)
          .where(eq(s.supplierInvoices.id, invoice.id))
      )[0].paymentGate,
    ).toBe("SETTLED");
    await approve({ mode: "DRAWER", previousReceiptId: sourceId }, "70");
    expect((await availability(sourceId))?.unusedAmount).toBe("0.00");
    expect((await balances()).supplier).toBe("0.00");
    const allocations = await db()
      .select()
      .from(s.supplierBookSettlementAllocations);
    expect(allocations.map((row) => row.allocatedAmount)).toEqual([
      "100.00",
      "70.00",
    ]);
    expect(allocations[0].reversedAmount).toBe("20.00");
  });

  it("blocks full original cancellation after partial refund and permits exactly the linked remainder", async () => {
    const sourceId = await previousPayment("150");
    await approve({ mode: "DRAWER", previousReceiptId: sourceId });
    await createVoucher(refundInput(sourceId), maker);
    await expect(cancelVoucher(sourceId, owner)).rejects.toThrow(/المتبقي/);
    await createVoucher(refundInput(sourceId, "140"), maker);
    expect((await advance(sourceId)).status).toBe("REVERSED");
    expect((await balances()).supplier).toBe("100.00");
    expect((await db().select().from(s.supplierInvoices))[0].paymentGate).toBe(
      "OPEN",
    );
    await expect(createVoucher(refundInput(sourceId), maker)).rejects.toThrow();
  });

  it("rejects ambiguous historical unbound IN rather than infer its original from supplier balance", async () => {
    await createVoucher(refundInput(), maker);
    const sourceId = await previousPayment("150");
    await expect(createVoucher(refundInput(sourceId), maker)).rejects.toThrow(
      /غير مربوط/,
    );
    await expect(
      listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).rejects.toThrow(/غير مربوط/);
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
  });

  it("rejects another source on replay and rejects foreign supplier or branch", async () => {
    const sourceId = await previousPayment("150");
    const other = await previousPayment("30");
    const input = refundInput(sourceId);
    await createVoucher(input, maker);
    await expect(
      createVoucher({ ...input, supplierAdvanceRefundReceiptId: other }, maker),
    ).rejects.toThrow(/مختلف/);
    await db().insert(s.suppliers).values({ id: 2, name: "مورد آخر" });
    await expect(
      createVoucher({ ...refundInput(sourceId), partyId: 2 }, maker),
    ).rejects.toThrow(/المورد والفرع/);
    await db()
      .insert(s.branches)
      .values({ id: 2, code: "OTHER", name: "فرع آخر", type: "SALES" });
    await expect(
      createVoucher({ ...refundInput(sourceId), branchId: 2 }, maker),
    ).rejects.toThrow(/المورد والفرع/);
    await expect(
      createVoucher({ ...refundInput(), branchId: 2 }, maker),
    ).rejects.toThrow(/سند الصرف الأصلي/);
    expect((await advance(sourceId)).reversedAmount).toBe("10.00");
  });

  it("serializes concurrent refunds against the same original amount", async () => {
    const sourceId = await previousPayment("150");
    const results = await Promise.allSettled([
      createVoucher(refundInput(sourceId, "100"), maker),
      createVoucher(refundInput(sourceId, "100"), maker),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect((await advance(sourceId)).reversedAmount).toBe("100.00");
    expect((await availability(sourceId))?.unusedAmount).toBe("50.00");
  });
});
