import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import * as audit from "../auditService";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { withTx } from "../tx";
import { baghdadToday } from "../businessDay";
import * as businessDay from "../businessDay";
import { sha256 } from "../purchase/grniAccounting";
import { cancelVoucher } from "../voucherService";
import {
  requestSupplierPayment,
  requestSupplierPaymentRefund,
  listSupplierPaymentSources,
} from "../purchase/supplierPayments";

import {
  previewHistoricalSupplierSettlements,
  adoptHistoricalSupplierSettlement,
  previewHistoricalReceiptAssignment,
  adoptHistoricalReceiptAssignment,
  type HistoricalReceiptAssignment,
} from "../purchase/historicalSupplierSettlement";
const db = () => getDb()!;
const owner = { userId: 9, branchId: 1, role: "manager" };
const maker = { userId: 7, branchId: 1, role: "accountant" };
const originalDate = new Date("2026-01-03T12:00:00Z");
let receiptIds: number[];
let creditEntryIds: number[];

beforeEach(async () => {
  vi.restoreAllMocks();
  receiptIds = [];
  creditEntryIds = [];
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 7,
        openId: "history-maker",
        name: "المنشئ الأصلي",
        role: "accountant",
        branchId: 1,
      },
      {
        id: 9,
        openId: "history-owner",
        name: "مالك التصحيح",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد تاريخي", currentBalance: "0.00" });
  await db().insert(s.products).values({ id: 1, name: "صنف" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, variantName: "عادي", sku: "HIST-1" });
  for (const [id, total] of [
    [1, "60.00"],
    [2, "40.00"],
  ] as const) {
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        poNumber: `HPO-${id}`,
        supplierId: 1,
        branchId: 1,
        subtotal: total,
        total,
        paidAmount: total,
        status: "RECEIVED",
      });
    await db()
      .insert(s.purchaseOrderRevisions)
      .values({
        id,
        purchaseOrderId: id,
        revisionNo: 1,
        origin: "NATIVE",
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "IQD",
        settlementType: "CREDIT",
        subtotal: total,
        total,
        taxAmount: "0",
        shippingCost: "0",
        customsCost: "0",
        invoiceDiscount: "0",
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        revisionReason: "فاتورة تاريخية",
        createdBy: 7,
      });
    await db().insert(s.purchaseOrderRevisionItems).values({
      id,
      revisionId: id,
      lineNo: 1,
      variantId: 1,
      quantity: "1",
      baseQuantity: 1,
      listUnitPrice: total,
      unitPrice: total,
      lineTotal: total,
      productNameSnapshot: "صنف",
    });
    const entryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "PURCHASE",
          entryDate: `2026-01-0${id}`,
          createdAt: new Date(`2026-01-0${id}T12:00:00Z`),
          amount: total,
          branchId: 1,
          supplierId: 1,
          purchaseOrderId: id,
          createdBy: 7,
        }),
    );
    creditEntryIds.push(entryId);
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `HSI-${id}`,
        clientRequestId: `hist-invoice-${id}`,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: `2026-01-0${id}`,
        currency: "IQD",
        subtotal: total,
        totalAmount: total,
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        evidenceType: "OTHER",
        externalInvoiceNumber: `EXT-${id}`,
        externalNumberNorm: `EXT${id}`,
        evidenceReference: "أصل الفاتورة",
        createdBy: 7,
        postingEntryId: entryId,
        postedBy: 7,
        postedAt: originalDate,
      });
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: id,
      lineNo: 1,
      purchaseOrderRevisionItemId: id,
      variantId: 1,
      description: "بند",
      invoicedBaseQuantity: 1,
      unitPriceIqd: total,
      netAmount: total,
      totalAmount: total,
    });
  }
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "1000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    partyType: "OTHER",
    createdBy: 9,
    createdAt: originalDate,
  });
  for (const [index, amount] of ["70.00", "30.00"].entries()) {
    const receiptId = extractInsertId(
      await db()
        .insert(s.receipts)
        .values({
          branchId: 1,
          direction: "OUT",
          amount,
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          partyType: "SUPPLIER",
          partyId: 1,
          voucherNumber: `HPV-${index}`,
          createdBy: 7,
          approvedBy: 9,
          approvedAt: originalDate,
          createdAt: originalDate,
          voucherDate: originalDate,
          signatureHash: `original-signature-${index}`,
          description: "سداد تاريخي مثبت",
        }),
    );
    receiptIds.push(receiptId);
    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      amount,
      entryDate: "2026-01-03",
      createdAt: originalDate,
      supplierId: 1,
      branchId: 1,
      receiptId,
      purchaseLiabilityAccount: "AP",
      createdBy: 9,
    });
  }
});

async function snapshot() {
  return {
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
    suppliers: await db().select().from(s.suppliers),
    invoices: await db().select().from(s.supplierInvoices),
    orders: await db().select().from(s.purchaseOrders),
    requests: await db().select().from(s.supplierPaymentRequests),
    requestAllocations: await db()
      .select()
      .from(s.supplierPaymentRequestAllocations),
    payments: await db().select().from(s.supplierPayments),
    allocations: await db().select().from(s.supplierPaymentAllocations),
    audit: await db().select().from(s.auditLogs),
  };
}
const preview = () => previewHistoricalSupplierSettlements({ supplierId: 1 });
const adopt = (episode: { episodeId: string; evidenceHash: string }) =>
  adoptHistoricalSupplierSettlement(
    { episodeId: episode.episodeId, evidenceHash: episode.evidenceHash },
    owner,
  );

async function seedKnownNativePair(invoiceSnapshot = "{}") {
  // Same closed episode: invoice1=60, invoice2=40, known native out40,
  // then the unallocated historical out60.
  for (const [index, amount] of ["40.00", "60.00"].entries()) {
    await db()
      .update(s.receipts)
      .set({ amount })
      .where(eq(s.receipts.id, receiptIds[index]));
    await db()
      .update(s.accountingEntries)
      .set({ amount })
      .where(eq(s.accountingEntries.receiptId, receiptIds[index]));
  }
  const [entry] = await db()
    .select()
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.receiptId, receiptIds[0]));
  await db()
    .insert(s.supplierPaymentRequests)
    .values({
      id: 100,
      requestKey: "KNOWN-NATIVE",
      supplierId: 1,
      branchId: 1,
      currency: "IQD",
      requestedAmount: "40.00",
      requestedCurrencyAmount: "40.00",
      paymentMethod: "CASH",
      payloadCanonical: "{}",
      payloadHash: sha256("{}"),
      evidenceType: "PAYMENT_ORDER",
      evidenceReference: "known-native-evidence",
      evidenceHash: "b".repeat(64),
      reason: "known native payment",
      status: "APPROVED",
      requestedBy: 7,
      reviewedBy: 9,
      reviewedAt: originalDate,
      decisionKey: "known-native-approved",
      decisionHash: "c".repeat(64),
      appliedAt: originalDate,
    });
  await db()
    .insert(s.supplierPaymentRequestAllocations)
    .values({
      id: 100,
      requestId: 100,
      supplierInvoiceId: 2,
      invoiceVersion: 1,
      requestedAmount: "40.00",
      requestedCurrencyAmount: "40.00",
      invoiceSnapshot,
      invoiceHash: sha256("{}"),
    });
  await db()
    .insert(s.supplierPayments)
    .values({
      id: 100,
      paymentNumber: "KNOWN-NATIVE",
      requestId: 100,
      supplierId: 1,
      branchId: 1,
      currency: "IQD",
      amount: "40.00",
      currencyAmount: "40.00",
      paymentMethod: "CASH",
      receiptId: receiptIds[0],
      accountingEntryId: entry.id,
      payloadCanonical: "{}",
      payloadHash: sha256("{}"),
      postedBy: 9,
      postedAt: originalDate,
    });
  await db()
    .insert(s.supplierPaymentAllocations)
    .values({
      id: 100,
      supplierPaymentId: 100,
      requestAllocationId: 100,
      supplierInvoiceId: 2,
      allocatedAmount: "40.00",
      allocatedCurrencyAmount: "40.00",
      invoiceHash: sha256("{}"),
    });
  await db()
    .update(s.supplierPaymentRequestAllocations)
    .set({ activeInvoiceGuard: null })
    .where(eq(s.supplierPaymentRequestAllocations.id, 100));
  await db()
    .update(s.supplierInvoices)
    .set({ paymentGate: "SETTLED", version: 2 })
    .where(eq(s.supplierInvoices.id, 2));
}

async function seedLaterReturn(poId: number) {
  const entryId = extractInsertId(
    await db().insert(s.accountingEntries).values({
      entryType: "RETURN",
      amount: "-1.00",
      entryDate: "2026-01-04",
      purchaseOrderId: poId,
      supplierId: 1,
      branchId: 1,
      createdBy: 7,
    }),
  );
  await db().insert(s.purchaseReturns).values({
    returnNumber: "LATER-RETURN",
    clientRequestId: "LATER-RETURN",
    origin: "LEGACY",
    purchaseOrderId: poId,
    supplierInvoiceId: poId,
    supplierId: 1,
    branchId: 1,
    accountingEntryId: entryId,
    netAmount: "1.00",
    totalAmount: "1.00",
    creditOffsetAmount: "1.00",
    settlement: "CREDIT",
    createdBy: 7,
    createdByNameSnapshot: "original",
    reason: "later unrelated return",
  });
  await db()
    .update(s.suppliers)
    .set({ currentBalance: "-1.00" })
    .where(eq(s.suppliers.id, 1));
}

describe("historical supplier settlement evidence adoption", () => {
  const assignmentInput = (): HistoricalReceiptAssignment => ({
    version: 1,
    assignmentKey: "OWNER-FULL-RECEIPT-TEST",
    supplierId: 1,
    branchId: 1,
    receiptId: receiptIds[0],
    assignmentDate: baghdadToday(),
    ownerStatement:
      "I explicitly accept this complete corrective assignment of the existing receipt; it does not claim the original split.",
    allocations: [
      { supplierInvoiceId: 1, invoiceVersion: 1, amount: "60.00" },
      { supplierInvoiceId: 2, invoiceVersion: 1, amount: "10.00" },
    ],
  });
  const assignmentPreview = (input = assignmentInput()) =>
    previewHistoricalReceiptAssignment(input);
  const applyAssignment = (
    input: HistoricalReceiptAssignment,
    evidenceHash: string,
  ) =>
    adoptHistoricalReceiptAssignment(
      { assignment: input, evidenceHash, ownerAccepted: true },
      owner,
    );

  it("assigns the entire existing treasury receipt explicitly, including a partial invoice, with unchanged money and exact replay", async () => {
    const input = assignmentInput();
    const before = await snapshot();
    const cashBefore = await withTx((tx) => computeTreasuryCashBalance(tx, 1));
    const report = await assignmentPreview(input);
    expect(await snapshot()).toEqual(before);
    expect(report.episodes).toHaveLength(1);
    const episode = report.episodes[0];
    expect(episode.total).toBe("70.00");
    expect(episode.receiptIds).toEqual([receiptIds[0]]);
    const result = await applyAssignment(input, episode.evidenceHash);
    const after = await snapshot();
    expect(after.entries).toEqual(before.entries);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.suppliers).toEqual(before.suppliers);
    expect(
      (await withTx((tx) => computeTreasuryCashBalance(tx, 1))).eq(cashBefore),
    ).toBe(true);
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0].amount).toBe("70.00");
    expect(after.orders.map((row) => row.paidAmount)).toEqual([
      "60.00",
      "10.00",
    ]);
    expect(after.invoices.map((row) => row.paymentGate)).toEqual([
      "SETTLED",
      "OPEN",
    ]);
    expect(result.assignment?.input).toEqual(input);
    expect(result.assignment?.acceptedBy).toBe(9);
    vi.spyOn(businessDay, "baghdadToday").mockReturnValue("2099-01-01");
    expect((await applyAssignment(input, episode.evidenceHash)).replayed).toBe(
      true,
    );
    expect(await snapshot()).toEqual(after);
    await expect(
      applyAssignment(
        {
          ...input,
          ownerStatement: `${input.ownerStatement} Changed acceptance.`,
        },
        episode.evidenceHash,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(after);
  });

  it("requires explicit acceptance and the active database owner for assignment", async () => {
    const assignment = assignmentInput();
    const evidenceHash = (await assignmentPreview()).episodes[0].evidenceHash;
    const before = await snapshot();
    await expect(
      adoptHistoricalReceiptAssignment(
        { assignment, evidenceHash, ownerAccepted: false as true },
        owner,
      ),
    ).rejects.toThrow();
    await expect(
      adoptHistoricalReceiptAssignment(
        { assignment, evidenceHash, ownerAccepted: true },
        maker,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects backdated acceptance on a new assignment", async () => {
    const input = { ...assignmentInput(), assignmentDate: "2026-01-04" };
    const episode = (await assignmentPreview(input)).episodes[0];
    const before = await snapshot();
    await expect(
      applyAssignment(input, episode.evidenceHash),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "PARTIAL_HEADER",
    "OVERALLOCATED",
    "STALE_VERSION",
    "FUTURE_RECOGNITION",
    "RETURN",
    "LEGACY_SOURCE_CLAIM",
    "NOT_TREASURY",
  ])("rejects invalid explicit assignment evidence: %s", async (kind) => {
    const input = assignmentInput();
    if (kind === "PARTIAL_HEADER") input.allocations[1].amount = "9.00";
    if (kind === "OVERALLOCATED") {
      input.allocations[0].amount = "61.00";
      input.allocations[1].amount = "9.00";
    }
    if (kind === "STALE_VERSION") input.allocations[0].invoiceVersion = 2;
    if (kind === "FUTURE_RECOGNITION")
      await db()
        .update(s.accountingEntries)
        .set({ createdAt: new Date("2026-01-04T00:00:00Z") })
        .where(eq(s.accountingEntries.id, creditEntryIds[0]));
    if (kind === "RETURN") await seedLaterReturn(1);
    if (kind === "NOT_TREASURY")
      await db()
        .update(s.receipts)
        .set({ cashBucket: null })
        .where(eq(s.receipts.id, receiptIds[0]));
    if (kind === "LEGACY_SOURCE_CLAIM") {
      const [entry] = await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, receiptIds[0]));
      await db()
        .insert(s.legacySupplierInvoiceSettlements)
        .values({
          supplierInvoiceId: 1,
          sourceAccountingEntryId: entry.id,
          sourceReceiptId: receiptIds[0],
          direction: "PAYMENT_OUT",
          amount: "70.00",
          evidenceSnapshot: "{}",
          evidenceHash: "a".repeat(64),
        });
    }
    const before = await snapshot();
    expect((await assignmentPreview(input)).episodes).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects stale source evidence and rolls back assignment on audit failure", async () => {
    const input = assignmentInput();
    const episode = (await assignmentPreview(input)).episodes[0];
    await db()
      .update(s.receipts)
      .set({ description: "Changed source evidence" })
      .where(eq(s.receipts.id, receiptIds[0]));
    const before = await snapshot();
    await expect(
      applyAssignment(input, episode.evidenceHash),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const fresh = (await assignmentPreview(input)).episodes[0];
    vi.spyOn(audit, "logAuditTx").mockRejectedValueOnce(
      new Error("assignment audit failed"),
    );
    await expect(applyAssignment(input, fresh.evidenceHash)).rejects.toThrow(
      "assignment audit failed",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("adopts only residual evidence in a closed mixed episode, preserving known native pairs and later unrelated returns", async () => {
    await seedKnownNativePair();
    await seedLaterReturn(2);
    const report = await preview();
    expect(report.episodes).toHaveLength(1);
    const episode = report.episodes[0];
    expect(episode.invoiceIds).toEqual([1]);
    expect(episode.receiptIds).toEqual([receiptIds[1]]);
    expect(episode.total).toBe("60.00");
    const before = await snapshot();
    const cashBefore = await withTx((tx) => computeTreasuryCashBalance(tx, 1));
    const result = await adopt(episode);
    const after = await snapshot();
    expect(result.paymentIds).toHaveLength(1);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.entries).toEqual(before.entries);
    expect(after.suppliers).toEqual(before.suppliers);
    expect(after.payments.find((row) => row.id === 100)).toEqual(
      before.payments[0],
    );
    expect(after.allocations.find((row) => row.id === 100)).toEqual(
      before.allocations[0],
    );
    expect(after.requests.find((row) => row.id === 100)).toEqual(
      before.requests[0],
    );
    expect(after.requestAllocations.find((row) => row.id === 100)).toEqual(
      before.requestAllocations[0],
    );
    expect(after.invoices.find((row) => row.id === 2)).toEqual(
      before.invoices.find((row) => row.id === 2),
    );
    expect(
      (await withTx((tx) => computeTreasuryCashBalance(tx, 1))).eq(cashBefore),
    ).toBe(true);
    expect(
      after.allocations.find((row) => row.supplierInvoiceId === 1)
        ?.allocatedAmount,
    ).toBe("60.00");
  });

  it.each([
    "BAD_AMOUNT",
    "REFUND",
    "UNKNOWN_SOURCE",
    "PAYLOAD_HASH",
    "SNAPSHOT_HASH",
    "ACTOR",
  ])("retains rejection for an unproved known pair: %s", async (kind) => {
    await seedKnownNativePair(
      kind === "SNAPSHOT_HASH" ? '{"changed":true}' : "{}",
    );
    if (kind === "BAD_AMOUNT")
      await db()
        .update(s.supplierPayments)
        .set({ amount: "41.00", currencyAmount: "41.00" })
        .where(eq(s.supplierPayments.id, 100));
    if (kind === "REFUND")
      await db()
        .update(s.supplierPaymentAllocations)
        .set({ refundedAmount: "1.00", refundedCurrencyAmount: "1.00" })
        .where(eq(s.supplierPaymentAllocations.id, 100));
    if (kind === "UNKNOWN_SOURCE")
      await db()
        .update(s.receipts)
        .set({ cashBucket: null })
        .where(eq(s.receipts.id, receiptIds[0]));
    if (kind === "PAYLOAD_HASH")
      await db()
        .update(s.supplierPayments)
        .set({ payloadHash: "f".repeat(64) })
        .where(eq(s.supplierPayments.id, 100));
    if (kind === "ACTOR")
      await db()
        .update(s.supplierPayments)
        .set({ postedBy: 7 })
        .where(eq(s.supplierPayments.id, 100));
    const before = await snapshot();
    expect((await preview()).episodes).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it("still rejects a return against the residual invoice", async () => {
    await seedKnownNativePair();
    await seedLaterReturn(1);
    expect((await preview()).episodes).toHaveLength(0);
  });

  it("invalidates the residual evidence hash when removed native proof changes", async () => {
    await seedKnownNativePair();
    const episode = (await preview()).episodes[0];
    await db()
      .update(s.supplierPaymentRequests)
      .set({ reason: "changed original evidence" })
      .where(eq(s.supplierPaymentRequests.id, 100));
    const before = await snapshot();
    await expect(adopt(episode)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("previews a closed episode read-only and allocates each historical payment FIFO", async () => {
    const before = await snapshot();
    const report = await preview();
    expect(await snapshot()).toEqual(before);
    expect(report.episodes).toHaveLength(1);
    expect(report.reconciliations[0]).toMatchObject({
      currentBalance: "0.00",
      ledgerBalance: "0.00",
      matches: true,
    });
    expect(
      report.episodes[0].payments.map((p: any) =>
        p.allocations.map((a: any) => [a.supplierInvoiceId, a.amount]),
      ),
    ).toEqual([
      [
        [1, "60.00"],
        [2, "10.00"],
      ],
      [[2, "30.00"]],
    ]);
  });
  it("adopts without changing originals, cash or AP and derives caches without incrementing old paid values", async () => {
    const episode = (await preview()).episodes[0];
    const before = await snapshot();
    const cashBefore = await withTx((tx) => computeTreasuryCashBalance(tx, 1));
    const result = await adopt(episode);
    const after = await snapshot();
    expect(after.receipts).toEqual(before.receipts);
    expect(after.entries).toEqual(before.entries);
    expect(after.suppliers).toEqual(before.suppliers);
    expect(
      (await withTx((tx) => computeTreasuryCashBalance(tx, 1))).toFixed(2),
    ).toBe(cashBefore.toFixed(2));
    expect(result.replayed).toBe(false);
    expect(result.paymentIds).toHaveLength(2);
    expect(after.allocations.map((a) => a.allocatedAmount)).toEqual([
      "60.00",
      "10.00",
      "30.00",
    ]);
    expect(after.invoices.map((i) => [i.version, i.paymentGate])).toEqual([
      [2, "SETTLED"],
      [3, "SETTLED"],
    ]);
    expect(after.orders.map((o) => o.paidAmount)).toEqual(["60.00", "40.00"]);
    expect(
      after.requests.every(
        (r) =>
          r.status === "APPROVED" &&
          r.requestedBy === 7 &&
          r.reviewedBy === 9 &&
          r.requestedAt > originalDate,
      ),
    ).toBe(true);
    expect(
      after.requestAllocations.every((a) => a.activeInvoiceGuard === null),
    ).toBe(true);
    const payload = JSON.parse(after.requests[0].payloadCanonical);
    expect(payload.cashSource).toEqual({
      mode: "TREASURY",
      shiftId: null,
      payerUserId: 7,
    });
    expect(payload.historicalEvidence).toMatchObject({
      episodeId: episode.episodeId,
      evidenceHash: episode.evidenceHash,
      adoptedBy: 9,
    });
    expect(
      after.audit.filter(
        (a) => a.action === "supplier.historicalSettlement.adopt",
      ),
    ).toHaveLength(1);
    await expect(cancelVoucher(receiptIds[0], owner)).rejects.toThrow();
  });
  it("serializes concurrent adoption and replays the same evidence once", async () => {
    const episode = (await preview()).episodes[0];
    const results = await Promise.all([adopt(episode), adopt(episode)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results[0].paymentIds).toEqual(results[1].paymentIds);
    expect((await snapshot()).payments).toHaveLength(2);
    await expect(
      adopt({ ...episode, evidenceHash: "a".repeat(64) }),
    ).rejects.toThrow();
  });
  it("rejects a stale source hash and cache/ledger mismatch without writes", async () => {
    const episode = (await preview()).episodes[0];
    await db()
      .update(s.receipts)
      .set({ description: "تغير الدليل الأصلي" })
      .where(eq(s.receipts.id, receiptIds[0]));
    const before = await snapshot();
    await expect(adopt(episode)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "1.00" })
      .where(eq(s.suppliers.id, 1));
    expect((await preview()).episodes).toHaveLength(0);
  });
  it("requires current database owner authority, ignoring caller claims", async () => {
    const episode = (await preview()).episodes[0];
    await expect(
      adoptHistoricalSupplierSettlement(episode, {
        ...maker,
        isOwner: true,
        role: "admin",
      }),
    ).rejects.toThrow();
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, 9));
    await expect(adopt(episode)).rejects.toThrow();
    expect((await snapshot()).payments).toHaveLength(0);
  });
  it("rolls back every adoption write when transactional audit fails", async () => {
    const episode = (await preview()).episodes[0];
    const before = await snapshot();
    vi.spyOn(audit, "logAuditTx").mockRejectedValueOnce(
      new Error("injected audit failure"),
    );
    await expect(adopt(episode)).rejects.toThrow("injected audit failure");
    expect(await snapshot()).toEqual(before);
  });
  it.each([
    "USD",
    "OPENING",
    "REVERSED",
    "CANCELLATION",
    "MISSING_NONCASH_REFERENCE",
  ])("excludes unsupported %s evidence", async (kind) => {
    if (kind === "MISSING_NONCASH_REFERENCE")
      await db()
        .update(s.receipts)
        .set({
          paymentMethod: "TRANSFER",
          cashBucket: null,
          referenceNumber: null,
        })
        .where(eq(s.receipts.id, receiptIds[0]));
    if (kind === "USD")
      await db()
        .update(s.supplierInvoices)
        .set({ currency: "USD", agreedRate: "1.0000", usdTotal: "60.00" })
        .where(eq(s.supplierInvoices.id, 1));
    if (kind === "OPENING")
      await db()
        .update(s.accountingEntries)
        .set({ entryType: "OPENING" })
        .where(eq(s.accountingEntries.id, creditEntryIds[0]));
    if (kind === "REVERSED")
      await db()
        .update(s.receipts)
        .set({ status: "REVERSED" })
        .where(eq(s.receipts.id, receiptIds[0]));
    if (kind === "CANCELLATION")
      await db()
        .insert(s.receipts)
        .values({
          direction: "IN",
          branchId: 1,
          amount: "70.00",
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          referenceNumber: `CANCEL-VCH-${receiptIds[0]}`,
          status: "PENDING",
          approvalStatus: "PENDING_APPROVAL",
          createdBy: 9,
        });
    const report = await preview();
    expect(report.episodes).toHaveLength(0);
    expect(report.excluded.length).toBeGreaterThan(0);
  });
  it("excludes invoices held by an active native reservation", async () => {
    // This variation has an unmaintained PO cache; the reservation engine correctly rejects the paid-cache fixture above.
    await db().update(s.purchaseOrders).set({ paidAmount: "0.00" });
    await requestSupplierPayment(
      {
        requestKey: "HIST-RESERVE",
        supplierId: 1,
        branchId: 1,
        currency: "IQD",
        amount: "1.00",
        currencyAmount: "1.00",
        paymentMethod: "TRANSFER",
        externalReference: "BANK-RESERVE",
        evidenceType: "PAYMENT_ORDER",
        evidenceReference: "HIST-RESERVE",
        reason: "حجز اختبار",
        allocations: [
          {
            supplierInvoiceId: 1,
            invoiceVersion: 1,
            amount: "1.00",
            currencyAmount: "1.00",
          },
        ],
      },
      maker,
    );
    const report = await preview();
    expect(report.episodes).toHaveLength(0);
    expect(report.excluded.length).toBeGreaterThan(0);
  });
  it("excludes a legacy return linked only to the same purchase order", async () => {
    await db().insert(s.purchaseReturns).values({
      returnNumber: "HIST-LEGACY-RETURN",
      clientRequestId: "HIST-LEGACY-RETURN",
      origin: "LEGACY",
      purchaseOrderId: 1,
      supplierId: 1,
      branchId: 1,
      supplierInvoiceId: null,
      netAmount: "1.00",
      totalAmount: "1.00",
      creditOffsetAmount: "1.00",
      settlement: "CREDIT",
      createdBy: 7,
      createdByNameSnapshot: "المنشئ الأصلي",
      reason: "مرتجع قديم يتطلب مراجعة",
    });
    expect((await preview()).episodes).toHaveLength(0);
  });
  it("fingerprints dates even when every other source field is unchanged", async () => {
    const episode = (await preview()).episodes[0];
    await db()
      .update(s.receipts)
      .set({ createdAt: new Date(originalDate.getTime() + 1000) })
      .where(eq(s.receipts.id, receiptIds[0]));
    await expect(adopt(episode)).rejects.toThrow();
    expect((await snapshot()).payments).toHaveLength(0);
  });
  it("serializes a generic cancellation racing historical adoption", async () => {
    const episode = (await preview()).episodes[0];
    const [adoption, cancellation] = await Promise.allSettled([
      adopt(episode),
      cancelVoucher(receiptIds[0], owner),
    ]);
    const after = await snapshot();
    const cancellations = after.receipts.filter(
      (row) => row.referenceNumber === `CANCEL-VCH-${receiptIds[0]}`,
    );
    if (adoption.status === "fulfilled") {
      expect(cancellation.status).toBe("rejected");
      expect(cancellations).toHaveLength(0);
      expect(after.payments).toHaveLength(2);
      expect(after.suppliers[0].currentBalance).toBe("0.00");
    } else {
      expect(cancellation.status).toBe("fulfilled");
      expect(cancellations).toHaveLength(1);
      expect(after.payments).toHaveLength(0);
      expect(["PENDING_APPROVAL", "APPROVED"]).toContain(
        cancellations[0].approvalStatus,
      );
      expect(after.suppliers[0].currentBalance).toBe(
        cancellations[0].approvalStatus === "APPROVED" ? "70.00" : "0.00",
      );
    }
  });
  it("allows zero-net fully refunded native allocations without reusing their sources", async () => {
    await db().update(s.purchaseOrders).set({ paidAmount: "0.00" });
    const request = await requestSupplierPayment(
      {
        requestKey: "HIST-FUTURE-NATIVE",
        supplierId: 1,
        branchId: 1,
        currency: "IQD",
        amount: "10.00",
        currencyAmount: "10.00",
        paymentMethod: "TRANSFER",
        externalReference: "BANK-HIST-NATIVE",
        evidenceType: "BANK_ADVICE",
        evidenceReference: "BANK-HIST-NATIVE",
        reason: "دفعة لاحقة أعيدت بالكامل",
        allocations: [
          {
            supplierInvoiceId: 1,
            invoiceVersion: 1,
            amount: "10.00",
            currencyAmount: "10.00",
          },
        ],
      },
      owner,
    );
    const [payment] = await db()
      .select()
      .from(s.supplierPayments)
      .where(eq(s.supplierPayments.requestId, request.requestId));
    const [allocation] = await db()
      .select()
      .from(s.supplierPaymentAllocations)
      .where(eq(s.supplierPaymentAllocations.supplierPaymentId, payment.id));
    await requestSupplierPaymentRefund(
      {
        supplierPaymentId: payment.id,
        expectedPaymentVersion: payment.version,
        requestKey: "HIST-FUTURE-REFUND",
        refundMethod: "TRANSFER",
        externalReference: "BANK-HIST-REFUND",
        evidenceType: "BANK_ADVICE",
        evidenceReference: "BANK-HIST-REFUND",
        reason: "رد كامل للدفعة اللاحقة",
        allocations: [
          {
            supplierPaymentAllocationId: allocation.id,
            amount: "10.00",
            currencyAmount: "10.00",
          },
        ],
      },
      owner,
    );
    const report = await preview();
    expect(report.episodes).toHaveLength(1);
    expect(report.episodes[0].receiptIds).toEqual(receiptIds);
    const before = await snapshot();
    await adopt(report.episodes[0]);
    const after = await snapshot();
    expect(after.receipts).toEqual(before.receipts);
    expect(after.entries).toEqual(before.entries);
    expect(after.suppliers).toEqual(before.suppliers);
    expect(after.payments).toHaveLength(3);
  });
  it("ignores unrelated supplier contact edits when validating financial evidence", async () => {
    const episode = (await preview()).episodes[0];
    await db()
      .update(s.suppliers)
      .set({ phone: "+9647000000000" })
      .where(eq(s.suppliers.id, 1));
    await expect(adopt(episode)).resolves.toMatchObject({ replayed: false });
    expect((await snapshot()).suppliers[0].phone).toBe("+9647000000000");
  });
  it("supports a governed partial refund of an adopted payment exactly once", async () => {
    const adopted = await adopt((await preview()).episodes[0]);
    const [payment] = await db()
      .select()
      .from(s.supplierPayments)
      .where(eq(s.supplierPayments.id, adopted.paymentIds[0]));
    const [allocation] = await db()
      .select()
      .from(s.supplierPaymentAllocations)
      .where(eq(s.supplierPaymentAllocations.supplierPaymentId, payment.id));
    const before = await snapshot();
    const cashBefore = await withTx((tx) => computeTreasuryCashBalance(tx, 1));
    const input = {
      supplierPaymentId: payment.id,
      expectedPaymentVersion: payment.version,
      requestKey: "HIST-ADOPTED-PARTIAL-REFUND",
      refundMethod: "CASH" as const,
      cashSource: { mode: "TREASURY" as const },
      evidenceType: "CASH_RECEIPT" as const,
      evidenceReference: "HIST-ADOPTED-PARTIAL-REFUND",
      reason: "استرداد جزئي فعلي من دفعة تاريخية معتمدة",
      allocations: [
        {
          supplierPaymentAllocationId: allocation.id,
          amount: "20.00",
          currencyAmount: "20.00",
        },
      ],
    };
    const refund = await requestSupplierPaymentRefund(input, owner);
    expect(refund.status).toBe("APPROVED");
    const after = await snapshot();
    expect(after.suppliers[0].currentBalance).toBe("20.00");
    expect(
      (await withTx((tx) => computeTreasuryCashBalance(tx, 1)))
        .minus(cashBefore)
        .toFixed(2),
    ).toBe("20.00");
    expect(after.orders.map((row) => row.paidAmount)).toEqual([
      "40.00",
      "40.00",
    ]);
    expect(after.invoices.map((row) => row.paymentGate)).toEqual([
      "OPEN",
      "SETTLED",
    ]);
    const sources = await listSupplierPaymentSources(
      { supplierId: 1, branchId: 1 },
      owner,
    );
    expect(sources.rows.map((row) => [row.id, row.remainingAmount])).toEqual([
      [1, "20.00"],
    ]);
    expect(after.receipts.filter((row) => receiptIds.includes(row.id))).toEqual(
      before.receipts.filter((row) => receiptIds.includes(row.id)),
    );
    expect(
      after.entries.filter((row) =>
        before.entries.some((old) => old.id === row.id),
      ),
    ).toEqual(before.entries);
    await requestSupplierPaymentRefund(input, owner);
    expect(await snapshot()).toEqual(after);
    await expect(cancelVoucher(receiptIds[0], owner)).rejects.toThrow();
  });
});
