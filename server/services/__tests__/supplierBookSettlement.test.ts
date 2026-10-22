import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import * as audit from "../auditService";
import { openPurchaseIntegrityCase } from "../purchase/integrityCases";
import { withGovernanceTx } from "../tx";
import { money, toDbMoney } from "../money";
import {
  adoptSupplierBookSettlement,
  adoptSupplierBookSettlementBatch,
  prepareSupplierBookVoucherTx,
  previewSupplierBookSettlement,
  unapplySupplierBookSettlementSourceTx,
  buildSupplierBookFifo,
} from "../purchase/supplierBookSettlement";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
const db = () => getDb()!;
const actor = { userId: 9, branchId: 1, role: "manager" };
beforeEach(async () => {
  vi.restoreAllMocks();
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 7,
        openId: "book-maker",
        name: "Maker",
        role: "accountant",
        branchId: 1,
      },
      {
        id: 9,
        openId: "book-owner",
        name: "Owner",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
});
async function fixture(
  options: {
    total?: string;
    opening?: string;
    payment?: string;
    credit?: string;
    usd?: boolean;
  } = {},
) {
  const total = options.total ?? "100.00",
    opening = options.opening ?? "30.00",
    payment = options.payment ?? "80.00",
    credit = options.credit ?? "0.00";
  const balance = toDbMoney(
    money(total).plus(opening).minus(payment).minus(credit),
  );
  await db()
    .insert(s.suppliers)
    .values({
      id: 1,
      name: "Book Supplier",
      currentBalance: balance,
      currentBalanceUsd: options.usd ? "1.00" : "0.00",
    });
  await db()
    .insert(s.purchaseOrders)
    .values({
      id: 1,
      poNumber: "BOOK-PO",
      supplierId: 1,
      branchId: 1,
      status: "RECEIVED",
      settlementType: "CREDIT",
      subtotal: total,
      total,
      paidAmount: "0.00",
      orderDate: new Date("2026-01-02T00:00:00Z"),
      agreedCurrency: options.usd ? "USD" : "IQD",
      usdTotal: options.usd ? "1.00" : null,
      agreedRate: options.usd ? "1450.1200" : null,
    });
  const postingEntryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PURCHASE",
        entryDate: new Date("2026-01-02T00:00:00Z"),
        supplierId: 1,
        branchId: 1,
        purchaseOrderId: 1,
        amount: total,
        purchaseLiabilityAccount: "AP",
        createdBy: 7,
      }),
  );
  await db()
    .insert(s.supplierInvoices)
    .values({
      id: 1,
      invoiceNumber: "BOOK-SIN",
      clientRequestId: "BOOK-INVOICE",
      origin: "LEGACY",
      liabilityClass: "LEGACY_UNKNOWN",
      paymentGate: "BLOCKED_REVIEW",
      legacyPurchaseOrderId: 1,
      supplierId: 1,
      branchId: 1,
      status: "POSTED",
      invoiceDate: "2026-01-02",
      currency: options.usd ? "USD" : "IQD",
      agreedRate: options.usd ? "1450.1200" : null,
      usdTotal: options.usd ? "1.00" : null,
      subtotal: total,
      totalAmount: total,
      payloadCanonical: "{}",
      payloadHash: "a".repeat(64),
      evidenceType: "LEGACY_LEDGER",
      legacySettlementEvidenceHash: "b".repeat(64),
      postingEntryId,
    });
  if (money(opening).gt(0))
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "OPENING",
        entryDate: new Date("2026-01-01T00:00:00Z"),
        supplierId: 1,
        branchId: null,
        amount: opening,
        createdBy: 7,
      });
  const receiptId = extractInsertId(
    await db()
      .insert(s.receipts)
      .values({
        direction: "OUT",
        branchId: 1,
        amount: payment,
        paymentMethod: "CARD",
        partyType: "SUPPLIER",
        partyId: 1,
        voucherNumber: "BOOK-PV",
        voucherDate: new Date("2026-01-03T00:00:00Z"),
        createdBy: 7,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 9,
        approvedAt: new Date("2026-01-03T00:00:00Z"),
      }),
  );
  const entryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PAYMENT_OUT",
        entryDate: new Date("2026-01-03T00:00:00Z"),
        supplierId: 1,
        branchId: 1,
        receiptId,
        amount: payment,
        paymentMethod: "CARD",
        createdBy: 7,
      }),
  );
  if (money(credit).gt(0))
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "RETURN",
        entryDate: new Date("2026-01-04T00:00:00Z"),
        supplierId: 1,
        branchId: 1,
        amount: toDbMoney(money(credit).negated()),
        purchaseLiabilityAccount: "AP",
        createdBy: 7,
      });
  return { entryId, receiptId, balance };
}
async function adopt(key = "BOOK-TEST-ADOPT") {
  const proposal = await previewSupplierBookSettlement({
    supplierId: 1,
    branchId: 1,
  });
  return {
    proposal,
    result: await adoptSupplierBookSettlement(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: key,
        expectedPlanHash: proposal.planHash,
      },
      actor,
    ),
  };
}
async function originals() {
  return {
    suppliers: (await db().select().from(s.suppliers)).map((r) => ({
      ...r,
      currentBalanceUsd: undefined,
      updatedAt: undefined,
    })),
    entries: await db().select().from(s.accountingEntries),
    receipts: await db().select().from(s.receipts),
    payments: await db().select().from(s.supplierPayments),
  };
}

describe("owned full-source supplier book settlement", () => {
  it("replays maximum accepted scope request keys within the persisted audit width", async () => {
    await fixture();
    const p = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    const request = {
      supplierId: 1,
      branchId: 1,
      requestKey: "K".repeat(80),
      expectedPlanHash: p.planHash,
    };
    const applied = await adoptSupplierBookSettlement(request, actor);
    expect((await adoptSupplierBookSettlement(request, actor)).replayed).toBe(
      true,
    );
    expect(applied.sourceIds).toHaveLength(1);
    const records = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "supplier.bookSettlement.adopt"));
    expect(records).toHaveLength(1);
    expect(records[0].entityId!.length).toBeLessThanOrEqual(50);
  });
  it("bounds batch audit identifiers and case evidence for thirty real bigint source identities", async () => {
    await fixture({ total: "100.00", opening: "0.00", payment: "1.00" });
    await db()
      .insert(s.receipts)
      .values(
        Array.from({ length: 29 }, (_, i) => ({
          branchId: 1,
          direction: "OUT" as const,
          partyType: "SUPPLIER" as const,
          partyId: 1,
          amount: "1.00",
          paymentMethod: "CARD" as const,
          voucherNumber: `BOOK-LARGE-${i}`,
          voucherDate: new Date("2026-01-03T00:00:00Z"),
          status: "COMPLETED" as const,
          approvalStatus: "APPROVED" as const,
          createdBy: 7,
          approvedBy: 9,
        })),
      );
    const extra = (await db().select().from(s.receipts)).filter((r) =>
      r.voucherNumber?.startsWith("BOOK-LARGE-"),
    );
    await db()
      .insert(s.accountingEntries)
      .values(
        extra.map((r) => ({
          entryType: "PAYMENT_OUT" as const,
          supplierId: 1,
          branchId: 1,
          receiptId: r.id,
          amount: "1.00",
          entryDate: new Date("2026-01-03T00:00:00Z"),
          createdBy: 7,
        })),
      );
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "70.00" })
      .where(eq(s.suppliers.id, 1));
    // Isolated test DB only: real bigint IDs exercise the external 500-character evidence contract.
    await db().execute(
      sql`ALTER TABLE supplierBookSettlementSources AUTO_INCREMENT = 1000000000000`,
    );
    const issue = await openPurchaseIntegrityCase(
      {
        caseKey: "BOOK-LARGE-CASE",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
        supplierInvoiceId: 1,
        code: "LEGACY_AP_CLASSIFICATION",
        severity: "HIGH",
        title: "Legacy classification",
        description: "Original purchase proof",
        reason: "Source evidence",
        evidence: { invoiceId: 1 },
      },
      actor,
    );
    const p = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    const request = {
      requestKey: "B".repeat(60),
      plans: [{ supplierId: 1, branchId: 1, expectedPlanHash: p.planHash }],
    };
    const result = await adoptSupplierBookSettlementBatch(request, actor);
    expect(result.results[0].sourceIds).toHaveLength(30);
    expect(result.results[0].resolvedCaseIds).toEqual([issue.caseId]);
    expect(
      (await adoptSupplierBookSettlementBatch(request, actor)).replayed,
    ).toBe(true);
    const [closed] = await db().select().from(s.purchaseIntegrityCases);
    expect(closed.status).toBe("RESOLVED");
    expect(closed.resolutionEvidenceReference!.length).toBeLessThanOrEqual(500);
    expect(closed.resolutionEvidenceReference).toContain("SOURCES_SHA256:");
  });
  it("automatically splits a real CARD source over opening and legacy invoice without a fabricated bank reference or cash/AP", async () => {
    await fixture();
    const issue = await openPurchaseIntegrityCase(
      {
        caseKey: "BOOK-CLASSIFY-CASE",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
        supplierInvoiceId: 1,
        code: "LEGACY_AP_CLASSIFICATION",
        severity: "HIGH",
        title: "Legacy AP classification",
        description:
          "An existing CREDIT purchase has a matching original liability entry",
        reason: "Historical proof needs classification",
        evidence: { invoiceId: 1 },
      },
      actor,
    );
    const before = await originals();
    const { proposal, result } = await adopt();
    expect(proposal.sources).toHaveLength(1);
    expect(
      proposal.sources[0].allocations.map((a) => [
        a.openingEntryId != null ? "OPENING" : "INVOICE",
        a.amount,
      ]),
    ).toEqual([
      ["OPENING", "30.00"],
      ["INVOICE", "50.00"],
    ]);
    expect(await originals()).toEqual(before);
    const [invoice] = await db().select().from(s.supplierInvoices);
    expect(invoice.liabilityClass).toBe("LEGACY_AP");
    expect(invoice.legacySettledAmount).toBe("0.00");
    expect(invoice.paymentGate).toBe("OPEN");
    expect(result.resolvedCaseIds).toEqual([issue.caseId]);
    expect((await db().select().from(s.purchaseIntegrityCases))[0].status).toBe(
      "RESOLVED",
    );
    expect((await db().select().from(s.purchaseOrders))[0].paidAmount).toBe(
      "50.00",
    );
    const snapshot = await db().select().from(s.supplierBookSettlementSources);
    expect(
      JSON.parse(snapshot[0].sourceSnapshot).receipt.referenceNumber,
    ).toBeNull();
    const replay = await adoptSupplierBookSettlement(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: "BOOK-TEST-ADOPT",
        expectedPlanHash: proposal.planHash,
      },
      actor,
    );
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await db().select().from(s.supplierBookSettlementSources)).toEqual(
      snapshot,
    );
    expect(await originals()).toEqual(before);
  });
  it("separates unbound credit and allows an exact zero USD book residual without a tender payment", async () => {
    await fixture({
      opening: "0.00",
      total: "1450.12",
      payment: "1449.28",
      credit: "0.84",
      usd: true,
    });
    const before = await originals();
    await adopt();
    const source = await db().select().from(s.supplierBookSettlementSources);
    const rows = await db().select().from(s.supplierBookSettlementAllocations);
    const credit = source.find((r) => r.kind === "CREDIT")!;
    expect(
      rows.find((r) => r.sourceId === credit.id)?.allocatedCurrencyAmount,
    ).toBe("0.00");
    expect((await db().select().from(s.supplierInvoices))[0].paymentGate).toBe(
      "SETTLED",
    );
    expect((await db().select().from(s.purchaseOrders))[0].paidAmount).toBe(
      "1449.28",
    );
    expect((await db().select().from(s.purchaseOrders))[0].paidUsd).toBe(
      "1.00",
    );
    expect((await db().select().from(s.suppliers))[0].currentBalanceUsd).toBe(
      "0.00",
    );
    expect(await originals()).toEqual(before);
    const order = (await db().select().from(s.purchaseOrders))[0];
    const projection = (await loadPurchaseSettlements(db(), [order])).get(1)!;
    expect(projection.remainingAmountIqd).toBe("0.00");
    expect(projection.returnedAmountIqd).toBe("0.84");
    expect(projection.returnedAmountCurrency).toBe("0.00");
    const paidSource = source.find((r) => r.kind === "PAYMENT")!;
    await withGovernanceTx((tx) =>
      unapplySupplierBookSettlementSourceTx(
        tx,
        {
          sourceAccountingEntryId: paidSource.sourceAccountingEntryId,
          amount: "700.00",
          reversalKey: "BOOK-USD-UNDO-PART",
        },
        actor,
      ),
    );
    expect((await db().select().from(s.suppliers))[0].currentBalanceUsd).toBe(
      "0.48",
    );
    await withGovernanceTx((tx) =>
      unapplySupplierBookSettlementSourceTx(
        tx,
        {
          sourceAccountingEntryId: paidSource.sourceAccountingEntryId,
          amount: "749.28",
          reversalKey: "BOOK-USD-UNDO-FULL",
        },
        actor,
      ),
    );
    expect((await db().select().from(s.suppliers))[0].currentBalanceUsd).toBe(
      "1.00",
    );
  });
  it("rejects changed source proof and an impersonated owner before writing allocations", async () => {
    const { entryId } = await fixture();
    const p = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    await expect(
      adoptSupplierBookSettlement(
        {
          supplierId: 1,
          branchId: 1,
          requestKey: "BOOK-STALE-OWNER",
          expectedPlanHash: p.planHash,
        },
        { ...actor, userId: 7 },
      ),
    ).rejects.toThrow();
    await db()
      .update(s.accountingEntries)
      .set({ notes: "changed source" })
      .where(eq(s.accountingEntries.id, entryId));
    await expect(
      adoptSupplierBookSettlement(
        {
          supplierId: 1,
          branchId: 1,
          requestKey: "BOOK-STALE-OWNER",
          expectedPlanHash: p.planHash,
        },
        actor,
      ),
    ).rejects.toThrow(/تغير/);
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    expect(
      (await db().select().from(s.supplierInvoices))[0].liabilityClass,
    ).toBe("LEGACY_UNKNOWN");
  });
  it("rolls back classification, source ownership, allocations and caches if the final audit fails", async () => {
    await fixture();
    const p = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    const before = await originals();
    const real = audit.logAuditTx;
    vi.spyOn(audit, "logAuditTx").mockImplementation(async (...args) => {
      if (args[2].action === "supplier.bookSettlement.adopt")
        throw new Error("audit failed");
      return real(...args);
    });
    await expect(
      adoptSupplierBookSettlement(
        {
          supplierId: 1,
          branchId: 1,
          requestKey: "BOOK-AUDIT-ROLLBACK",
          expectedPlanHash: p.planHash,
        },
        actor,
      ),
    ).rejects.toThrow("audit failed");
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    expect(
      await db().select().from(s.supplierBookSettlementAllocations),
    ).toHaveLength(0);
    expect(
      (await db().select().from(s.supplierInvoices))[0].liabilityClass,
    ).toBe("LEGACY_UNKNOWN");
    expect((await db().select().from(s.purchaseOrders))[0].paidAmount).toBe(
      "0.00",
    );
    expect(await originals()).toEqual(before);
  });
  it("partially and fully unapplies the newest target first with stable reversal keys", async () => {
    const { entryId } = await fixture();
    await adopt();
    const undo = (amount: string, key: string) =>
      withGovernanceTx((tx) =>
        unapplySupplierBookSettlementSourceTx(
          tx,
          { sourceAccountingEntryId: entryId, amount, reversalKey: key },
          actor,
        ),
      );
    await undo("20.00", "BOOK-UNDO-20");
    await undo("20.00", "BOOK-UNDO-20");
    expect((await db().select().from(s.purchaseOrders))[0].paidAmount).toBe(
      "30.00",
    );
    await expect(undo("21.00", "BOOK-UNDO-20")).rejects.toThrow(/مكرر/);
    await undo("60.00", "BOOK-UNDO-REST");
    expect(
      (await db().select().from(s.supplierBookSettlementSources))[0].status,
    ).toBe("REVERSED");
    expect((await db().select().from(s.purchaseOrders))[0].paidAmount).toBe(
      "0.00",
    );
    expect((await db().select().from(s.supplierInvoices))[0].paymentGate).toBe(
      "OPEN",
    );
    await expect(undo("0.01", "BOOK-UNDO-OVER")).rejects.toThrow(/يتجاوز/);
  });
  it("rejects a source that cannot be covered instead of inventing an opening invoice", () => {
    expect(() =>
      buildSupplierBookFifo(
        [],
        [
          {
            entryId: 1,
            receiptId: 1,
            exchangeId: null,
            kind: "PAYMENT",
            date: "2026-01-01",
            amount: "10.00",
            snapshot: {},
          },
        ],
      ),
    ).toThrow(/بالكامل/);
  });
  it("rolls back the entire supplier batch when its later scope fails, then replays a valid batch once", async () => {
    await fixture();
    const p = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    const before = await originals();
    await expect(
      adoptSupplierBookSettlementBatch(
        {
          requestKey: "BOOK-BATCH-ROLLBACK",
          plans: [
            { supplierId: 1, branchId: 1, expectedPlanHash: p.planHash },
            { supplierId: 2, branchId: 1, expectedPlanHash: "f".repeat(64) },
          ],
        },
        actor,
      ),
    ).rejects.toThrow();
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    expect(
      (await db().select().from(s.supplierInvoices))[0].liabilityClass,
    ).toBe("LEGACY_UNKNOWN");
    expect(await originals()).toEqual(before);
    const request = {
      requestKey: "BOOK-BATCH-ROLLBACK",
      plans: [{ supplierId: 1, branchId: 1, expectedPlanHash: p.planHash }],
    };
    const applied = await adoptSupplierBookSettlementBatch(request, actor);
    const replayed = await adoptSupplierBookSettlementBatch(request, actor);
    expect(applied.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.results.every((r) => r.replayed)).toBe(true);
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(1);
  });
  it("uses ascending opening identities within the same day", () => {
    const targets = [20, 10].map((id) => ({
      supplierInvoiceId: null,
      openingEntryId: id,
      date: "2026-01-01",
      order: id,
      amount: "10.00",
      total: "10.00",
      currencyTotal: "10.00",
      currencyUsed: "0.00",
      snapshot: { id },
    }));
    const plan = buildSupplierBookFifo(targets, [
      {
        entryId: 1,
        receiptId: 1,
        exchangeId: null,
        kind: "PAYMENT",
        date: "2026-01-02",
        amount: "10.00",
        snapshot: {},
      },
    ]);
    expect(plan.sources[0].allocations[0].openingEntryId).toBe(10);
  });
  it("settles the individual invoice while its shared purchase order remains partly unpaid", async () => {
    await fixture({ opening: "0.00", payment: "100.00" });
    const [first] = await db().select().from(s.supplierInvoices);
    await db()
      .update(s.supplierInvoices)
      .set({ liabilityClass: "LEGACY_AP", paymentGate: "OPEN" })
      .where(eq(s.supplierInvoices.id, 1));
    const entryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "PURCHASE",
          entryDate: new Date("2026-01-03T00:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 1,
          amount: "100.00",
          purchaseLiabilityAccount: "AP",
          createdBy: 7,
        }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        ...first,
        id: 2,
        invoiceNumber: "BOOK-SIN-2",
        clientRequestId: "BOOK-INVOICE-2",
        postingEntryId: entryId,
        invoiceDate: "2026-01-03",
        liabilityClass: "LEGACY_AP",
        paymentGate: "OPEN",
      });
    await db()
      .update(s.purchaseOrders)
      .set({ total: "200.00", subtotal: "200.00" })
      .where(eq(s.purchaseOrders.id, 1));
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "100.00" })
      .where(eq(s.suppliers.id, 1));
    await adopt();
    const invoices = await db().select().from(s.supplierInvoices);
    expect(invoices.find((i) => i.id === 1)?.paymentGate).toBe("SETTLED");
    expect(invoices.find((i) => i.id === 2)?.paymentGate).toBe("OPEN");
    expect((await db().select().from(s.purchaseOrders))[0].paidAmount).toBe(
      "100.00",
    );
  });
  it("proves, classifies, and settles multi-batch LEGACY_UNKNOWN invoices on a single PO with a PO-only credit return", async () => {
    await fixture({ opening: "0.00", payment: "80.00" });
    const [first] = await db().select().from(s.supplierInvoices);
    const secondPurchaseEntryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "PURCHASE",
          entryDate: new Date("2026-01-03T00:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 1,
          amount: "50.00",
          purchaseLiabilityAccount: "AP",
          createdBy: 7,
        }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        ...first,
        id: 2,
        invoiceNumber: "BOOK-SIN-2",
        clientRequestId: "BOOK-INVOICE-2",
        postingEntryId: secondPurchaseEntryId,
        invoiceDate: "2026-01-03",
        subtotal: "50.00",
        totalAmount: "50.00",
        liabilityClass: "LEGACY_UNKNOWN",
        paymentGate: "BLOCKED_REVIEW",
      });
    const returnEntryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "RETURN",
          entryDate: new Date("2026-01-03T00:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 1,
          amount: "-30.00",
          createdBy: 7,
        }),
    );
    await db()
      .insert(s.purchaseReturns)
      .values({
        returnNumber: `RET-${returnEntryId}`,
        clientRequestId: `ret-${returnEntryId}`,
        origin: "LEGACY",
        supplierInvoiceId: null,
        purchaseOrderId: 1,
        supplierId: 1,
        branchId: 1,
        accountingEntryId: returnEntryId,
        settlement: "CREDIT",
        netAmount: "30.00",
        totalAmount: "30.00",
        creditOffsetAmount: "30.00",
        createdBy: 7,
        createdByNameSnapshot: "owner",
      });
    await db()
      .update(s.purchaseOrders)
      .set({ total: "150.00", subtotal: "150.00" })
      .where(eq(s.purchaseOrders.id, 1));
    // Total AP: 100 + 50 - 30 (return) - 80 (payment) = 40.00
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "40.00" })
      .where(eq(s.suppliers.id, 1));
    await adopt();
    const invoices = await db().select().from(s.supplierInvoices);
    const inv1 = invoices.find((i) => i.id === 1)!;
    const inv2 = invoices.find((i) => i.id === 2)!;
    expect(inv1.liabilityClass).toBe("LEGACY_AP");
    expect(inv2.liabilityClass).toBe("LEGACY_AP");
    // Invoice 1 (100) has 30 credit + 70 payment = 100 -> SETTLED
    expect(inv1.paymentGate).toBe("SETTLED");
    // Invoice 2 (50) has 10 payment -> OPEN (40 remaining)
    expect(inv2.paymentGate).toBe("OPEN");
    const [order] = await db().select().from(s.purchaseOrders);
    expect(order.paidAmount).toBe("80.00");
    const projection = (await loadPurchaseSettlements(db(), [order])).get(1)!;
    expect(projection).toMatchObject({
      recognizedAmountIqd: "150.00",
      returnedAmountIqd: "30.00",
      paidAmountIqd: "80.00",
      remainingAmountIqd: "40.00",
      requiresReview: false,
    });
  });
  it("proves and unblocks multi-batch LEGACY_AP + BLOCKED_REVIEW invoices on a PO with a PO-only credit return and resolves LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS cases", async () => {
    await fixture({ opening: "0.00", payment: "20.00" });
    await db()
      .update(s.supplierInvoices)
      .set({
        liabilityClass: "LEGACY_AP",
        paymentGate: "BLOCKED_REVIEW",
      })
      .where(eq(s.supplierInvoices.id, 1));
    const [first] = await db().select().from(s.supplierInvoices);
    const secondPurchaseEntryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "PURCHASE",
          entryDate: new Date("2026-01-03T00:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 1,
          amount: "50.00",
          purchaseLiabilityAccount: "AP",
          createdBy: 7,
        }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        ...first,
        id: 2,
        invoiceNumber: "BOOK-SIN-2",
        clientRequestId: "BOOK-INVOICE-2",
        postingEntryId: secondPurchaseEntryId,
        invoiceDate: "2026-01-03",
        subtotal: "50.00",
        totalAmount: "50.00",
        liabilityClass: "LEGACY_AP",
        paymentGate: "BLOCKED_REVIEW",
      });
    // PO-only credit return of 100.00 fully covers invoice 1 (100.00) with 0 payment needed on invoice 1
    const returnEntryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "RETURN",
          entryDate: new Date("2026-01-03T00:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 1,
          amount: "-100.00",
          createdBy: 7,
        }),
    );
    await db()
      .insert(s.purchaseReturns)
      .values({
        returnNumber: `RET-${returnEntryId}`,
        clientRequestId: `ret-${returnEntryId}`,
        origin: "LEGACY",
        supplierInvoiceId: null,
        purchaseOrderId: 1,
        supplierId: 1,
        branchId: 1,
        accountingEntryId: returnEntryId,
        settlement: "CREDIT",
        netAmount: "100.00",
        totalAmount: "100.00",
        creditOffsetAmount: "100.00",
        createdBy: 7,
        createdByNameSnapshot: "owner",
      });
    await db()
      .update(s.purchaseOrders)
      .set({ total: "150.00", subtotal: "150.00" })
      .where(eq(s.purchaseOrders.id, 1));
    // Total AP: 100 + 50 - 100 (return) - 20 (payment) = 30.00
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "30.00" })
      .where(eq(s.suppliers.id, 1));
    await openPurchaseIntegrityCase(
      {
        caseKey: "MULTI-BATCH-AMBIGUOUS-1",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
        supplierInvoiceId: 1,
        code: "LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS",
        severity: "HIGH",
        title: "Multi-invoice PO ambiguity",
        description: "Multi-invoice PO had candidateInvoiceCount > 1",
        reason: "Historical migration blocked review",
        evidence: { invoiceId: 1 },
      },
      actor,
    );
    await openPurchaseIntegrityCase(
      {
        caseKey: "MULTI-BATCH-AMBIGUOUS-2",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
        supplierInvoiceId: 2,
        code: "LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS",
        severity: "HIGH",
        title: "Multi-invoice PO ambiguity",
        description: "Multi-invoice PO had candidateInvoiceCount > 1",
        reason: "Historical migration blocked review",
        evidence: { invoiceId: 2 },
      },
      actor,
    );

    // prepareSupplierBookVoucherTx should also prepare a plan instead of returning null on provable BLOCKED_REVIEW
    await withGovernanceTx(async (tx) => {
      const prepared = await prepareSupplierBookVoucherTx(
        tx,
        {
          supplierId: 1,
          branchId: 1,
          amount: "10.00",
        },
        actor,
      );
      expect(prepared).not.toBeNull();
    });

    await adopt();
    const invoices = await db().select().from(s.supplierInvoices);
    const inv1 = invoices.find((i) => i.id === 1)!;
    const inv2 = invoices.find((i) => i.id === 2)!;
    // Invoice 1 (100) is 100% settled by the PO-only credit return even with 0 payment allocated to it
    expect(inv1.paymentGate).toBe("SETTLED");
    // Invoice 2 (50) has 20 payment -> OPEN (30 remaining)
    expect(inv2.paymentGate).toBe("OPEN");
    const cases = await db().select().from(s.purchaseIntegrityCases);
    expect(cases.every((c) => c.status === "RESOLVED")).toBe(true);
  });
  it("ignores a compensating CANCEL-VCH-* OUT receipt paired with a REVERSED IN PAYMENT_IN receipt and fails closed on an unmatched CANCEL-VCH-* receipt", async () => {
    await fixture({ opening: "0.00", payment: "80.00" });
    const reversedInReceiptId = extractInsertId(
      await db()
        .insert(s.receipts)
        .values({
          direction: "IN",
          branchId: 1,
          amount: "50.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          voucherNumber: "IN-VCH-1",
          voucherDate: new Date("2026-01-04T00:00:00Z"),
          createdBy: 7,
          status: "REVERSED",
          approvalStatus: "APPROVED",
          approvedBy: 9,
          approvedAt: new Date("2026-01-04T00:00:00Z"),
        }),
    );
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PAYMENT_IN",
        entryDate: new Date("2026-01-04T00:00:00Z"),
        supplierId: 1,
        branchId: 1,
        receiptId: reversedInReceiptId,
        amount: "50.00",
        createdBy: 7,
      });
    const cancelOutReceiptId = extractInsertId(
      await db()
        .insert(s.receipts)
        .values({
          direction: "OUT",
          branchId: 1,
          amount: "50.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          voucherNumber: "OUT-CANCEL-1",
          referenceNumber: `CANCEL-VCH-${reversedInReceiptId}`,
          voucherDate: new Date("2026-01-04T00:00:00Z"),
          createdBy: 7,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          approvedBy: 9,
          approvedAt: new Date("2026-01-04T00:00:00Z"),
        }),
    );
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PAYMENT_OUT",
        entryDate: new Date("2026-01-04T00:00:00Z"),
        supplierId: 1,
        branchId: 1,
        receiptId: cancelOutReceiptId,
        amount: "50.00",
        createdBy: 7,
      });

    const preview = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    expect(preview.remaining).toBe("20.00");
    expect(preview.sources).toHaveLength(1);

    // Corrupting the CANCEL-VCH reference to a non-existent receipt ID must fail closed
    await db()
      .update(s.receipts)
      .set({ referenceNumber: "CANCEL-VCH-999999" })
      .where(eq(s.receipts.id, cancelOutReceiptId));
    await expect(
      previewSupplierBookSettlement({ supplierId: 1, branchId: 1 }),
    ).rejects.toThrow(/لا يملك سند قبض أصلي معكوساً مطابقاً/);
  });
});
