import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { cancelVoucher } from "../voucher/cancel";
import { approveVoucher, rejectVoucher } from "../voucher/approval";
import { reverseExchangeTransaction } from "../exchange/reverse";
import {
  assertSupplierInvoiceReversalDependenciesClear,
  decideSupplierInvoiceApproval,
} from "../purchase/supplierInvoices";
import { sha256 } from "../purchase/grniAccounting";
import * as audit from "../auditService";

const db = () => getDb()!;
const maker = { userId: 1, branchId: 1, role: "admin" };
const owner = { userId: 2, branchId: 1, role: "manager" };
const snapshot = "{}";
let openingId: number;

beforeEach(async () => {
  vi.restoreAllMocks();
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "book-reversal-maker",
        name: "Maker",
        role: "admin",
        branchId: 1,
        isOwner: false,
      },
      {
        id: 2,
        openId: "book-reversal-owner",
        name: "Owner",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "Book supplier", currentBalance: "75.00" });
  openingId = extractInsertId(
    await db().insert(s.accountingEntries).values({
      entryType: "OPENING",
      entryDate: new Date(),
      supplierId: 1,
      branchId: 1,
      amount: "100.00",
      dedupeKey: "BOOK-REV-OPENING",
    }),
  );
});

async function sourceFixture(exchange = false) {
  const receiptId = extractInsertId(
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "OUT",
        amount: "25.00",
        paymentMethod: exchange ? "EXCHANGE" : "CARD",
        partyType: "SUPPLIER",
        partyId: 1,
        voucherNumber: "BOOK-REV-PV",
        voucherDate: new Date(),
        cardLastFour: exchange ? null : "1234",
        createdBy: 1,
        approvedBy: 2,
        approvedAt: new Date(),
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        description: "Existing historical payment",
      }),
  );
  let exchangeId: number | null = null;
  if (exchange) {
    await db()
      .insert(s.exchangeHouses)
      .values({ id: 1, name: "Book exchange", balanceIqd: "-25.00" });
    exchangeId = extractInsertId(
      await db().insert(s.exchangeTransactions).values({
        txnNumber: "BOOK-EX-1",
        exchangeHouseId: 1,
        branchId: 1,
        type: "SETTLE",
        currency: "IQD",
        iqdAmount: "25.00",
        settledIqd: "25.00",
        supplierId: 1,
        receiptId,
        createdBy: 1,
      }),
    );
  }
  const entryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: exchange ? "EXCHANGE_SETTLE" : "PAYMENT_OUT",
        entryDate: new Date(),
        supplierId: 1,
        branchId: 1,
        receiptId,
        amount: "25.00",
        paymentMethod: exchange ? "EXCHANGE" : "CARD",
        createdBy: 1,
        exchangeHouseId: exchange ? 1 : null,
        dedupeKey: exchange ? "EXSETTLE:BOOK-EX-1" : "BOOK-REV-PAYMENT",
      }),
  );
  const sourceSnapshot = JSON.stringify({
    entry: (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.id, entryId))
    )[0],
    receipt: (
      await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId))
    )[0],
    exchange:
      exchangeId == null
        ? null
        : (
            await db()
              .select()
              .from(s.exchangeTransactions)
              .where(eq(s.exchangeTransactions.id, exchangeId))
          )[0],
  });
  const targetSnapshot = JSON.stringify({
    opening: (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.id, openingId))
    )[0],
  });
  const sourceId = extractInsertId(
    await db()
      .insert(s.supplierBookSettlementSources)
      .values({
        supplierId: 1,
        branchId: 1,
        sourceAccountingEntryId: entryId,
        sourceReceiptId: receiptId,
        sourceExchangeTransactionId: exchangeId,
        kind: "PAYMENT",
        amount: "25.00",
        sourceSnapshot,
        sourceHash: sha256(sourceSnapshot),
        planHash: sha256(snapshot),
        adoptionKey: "book-reversal-adoption",
        adoptedBy: 2,
        reversalHistory: "[]",
      }),
  );
  await db()
    .insert(s.supplierBookSettlementAllocations)
    .values({
      sourceId,
      openingEntryId: openingId,
      allocatedAmount: "25.00",
      allocatedCurrencyAmount: "25.00",
      targetSnapshot,
      targetHash: sha256(targetSnapshot),
    });
  return { receiptId, sourceId, exchangeId };
}

async function sourceState(sourceId: number) {
  return (
    await db()
      .select()
      .from(s.supplierBookSettlementSources)
      .where(eq(s.supplierBookSettlementSources.id, sourceId))
  )[0]!;
}

describe("BOOK source reversal lifecycle", () => {
  it("keeps a pending cancellation allocated, then releases it with the one real voucher reversal", async () => {
    const original = await sourceFixture();
    const cancellation = await cancelVoucher(original.receiptId, maker);
    expect(cancellation.status).toBe("PENDING_APPROVAL");
    expect((await sourceState(original.sourceId)).reversedAmount).toBe("0.00");
    await approveVoucher(cancellation.approvalReceiptId!, owner);
    expect((await sourceState(original.sourceId)).status).toBe("REVERSED");
    expect(
      (await db().select().from(s.supplierBookSettlementAllocations))[0]!
        .reversedAmount,
    ).toBe("25.00");
    expect((await db().select().from(s.suppliers))[0]!.currentBalance).toBe(
      "100.00",
    );
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(3);
    await approveVoucher(cancellation.approvalReceiptId!, owner);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(3);
  });

  it("leaves BOOK allocations active when cancellation is rejected", async () => {
    const original = await sourceFixture();
    const cancellation = await cancelVoucher(original.receiptId, maker);
    await rejectVoucher(
      cancellation.approvalReceiptId!,
      owner,
      "رفض إلغاء السند الأصلي",
    );
    expect((await sourceState(original.sourceId)).status).toBe("APPLIED");
    expect((await db().select().from(s.suppliers))[0]!.currentBalance).toBe(
      "75.00",
    );
  });

  it("owner inline cancellation releases BOOK allocations under the same transaction", async () => {
    const original = await sourceFixture();
    expect((await cancelVoucher(original.receiptId, owner)).status).toBe(
      "REVERSED",
    );
    expect((await sourceState(original.sourceId)).reversedAmount).toBe("25.00");
  });

  it("rolls back the financial cancellation and BOOK release if its audit fails", async () => {
    const original = await sourceFixture();
    const cancellation = await cancelVoucher(original.receiptId, maker);
    vi.spyOn(audit, "logAuditTx").mockRejectedValue(
      new Error("audit unavailable"),
    );
    await expect(
      approveVoucher(cancellation.approvalReceiptId!, owner),
    ).rejects.toThrow("audit unavailable");
    expect((await sourceState(original.sourceId)).status).toBe("APPLIED");
    expect((await db().select().from(s.suppliers))[0]!.currentBalance).toBe(
      "75.00",
    );
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, original.receiptId))
      )[0]!.status,
    ).toBe("COMPLETED");
  });

  it("releases exchange BOOK allocations and restores the original AP once", async () => {
    const original = await sourceFixture(true);
    await reverseExchangeTransaction(original.exchangeId!, owner);
    expect((await sourceState(original.sourceId)).status).toBe("REVERSED");
    expect((await db().select().from(s.suppliers))[0]!.currentBalance).toBe(
      "100.00",
    );
    expect((await db().select().from(s.exchangeHouses))[0]!.balanceIqd).toBe(
      "0.00",
    );
    await expect(
      reverseExchangeTransaction(original.exchangeId!, owner),
    ).rejects.toThrow();
    expect((await sourceState(original.sourceId)).reversedAmount).toBe("25.00");
  });

  it.each(["PAYMENT", "CREDIT"] as const)(
    "blocks invoice reversal with active BOOK %s evidence",
    async (kind) => {
      const source = await sourceFixture();
      const postingEntryId = extractInsertId(
        await db().insert(s.accountingEntries).values({
          entryType: "ADJUST",
          supplierId: 1,
          branchId: 1,
          amount: "100.00",
          entryDate: new Date(),
          dedupeKey: "BOOK-REV-INVOICE",
        }),
      );
      const invoiceId = extractInsertId(
        await db()
          .insert(s.supplierInvoices)
          .values({
            invoiceNumber: "BOOK-REV-SIN",
            clientRequestId: "book-rev-invoice",
            supplierId: 1,
            branchId: 1,
            status: "POSTED",
            invoiceDate: "2026-01-01",
            currency: "IQD",
            subtotal: "100.00",
            totalAmount: "100.00",
            payloadCanonical: snapshot,
            payloadHash: sha256(snapshot),
            evidenceType: "OTHER",
            externalInvoiceNumber: "BOOK-EXT-1",
            externalNumberNorm: "BOOKEXT1",
            evidenceReference: "مستند فاتورة أصلي",
            createdBy: 1,
            postedBy: 1,
            postingEntryId,
            postedAt: new Date(),
          }),
      );
      await db()
        .update(s.supplierBookSettlementAllocations)
        .set({ openingEntryId: null, supplierInvoiceId: invoiceId });
      if (kind === "CREDIT")
        await db()
          .update(s.supplierBookSettlementSources)
          .set({ kind, sourceReceiptId: null });
      const requestId = extractInsertId(
        await db()
          .insert(s.supplierInvoiceApprovalRequests)
          .values({
            requestKey: "book-rev-request",
            supplierInvoiceId: invoiceId,
            branchId: 1,
            kind: "REVERSE_INVOICE",
            baseInvoiceVersion: 1,
            pendingGuard: `REVERSE_INVOICE:${invoiceId}`,
            payloadCanonical: snapshot,
            payloadHash: sha256(snapshot),
            reason: "عكس فاتورة موثق",
            requestedBy: 1,
          }),
      );
      await expect(
        decideSupplierInvoiceApproval(
          {
            requestId,
            decisionKey: "book-rev-decision",
            action: "APPROVE",
            reviewReason: "عكس فاتورة موثق",
          },
          owner,
        ),
      ).rejects.toThrow(/تسوية دفترية/);
      expect((await db().select().from(s.supplierInvoices))[0]!.status).toBe(
        "POSTED",
      );
      expect((await sourceState(source.sourceId)).status).toBe("APPLIED");
    },
  );

  it("allows cleared BOOK totals while retaining the existing native-payment dependency", () => {
    expect(() =>
      assertSupplierInvoiceReversalDependenciesClear({
        bookTotals: { paidAmount: "0.00", creditedAmount: "0.00" },
        paymentAllocations: [],
        purchaseReturns: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertSupplierInvoiceReversalDependenciesClear({
        bookTotals: { paidAmount: "0.00", creditedAmount: "0.00" },
        paymentAllocations: [
          { allocatedAmount: "1.00", refundedAmount: "0.00" },
        ],
        purchaseReturns: [],
      }),
    ).toThrow(/تخصيص سداد/);
  });
});
