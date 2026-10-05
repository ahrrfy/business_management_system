import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  decideSupplierPayment,
  decideSupplierPaymentRefund,
  listPendingSupplierPaymentRefundRequests,
  requestSupplierPayment,
  requestSupplierPaymentRefund,
  type RequestSupplierPaymentInput,
  type RequestSupplierPaymentRefundInput,
} from "../purchase/supplierPayments";
import { computeExpectedCash } from "../shiftService";
import { withTx } from "../tx";

const payer = { userId: 7, branchId: 1, role: "purchasing" };
const reviewer = { userId: 8, branchId: 1, role: "accountant" };
const db = () => getDb()!;
afterEach(() => vi.unstubAllEnvs());

function input(): RequestSupplierPaymentInput {
  return {
    supplierId: 1,
    branchId: 1,
    requestKey: randomUUID(),
    currency: "IQD",
    amount: "10000.00",
    currencyAmount: "10000.00",
    paymentMethod: "CASH",
    evidenceType: "CASH_ACKNOWLEDGEMENT",
    evidenceReference: "supplier-receipt-1",
    reason: "سداد فاتورة المورد",
    allocations: [
      {
        supplierInvoiceId: 1,
        invoiceVersion: 1,
        amount: "10000.00",
        currencyAmount: "10000.00",
      },
    ],
  };
}

function decision(requestId: number) {
  return {
    requestId,
    decisionKey: randomUUID(),
    action: "APPROVE" as const,
    reviewReason: "اعتماد دفع المورد",
  };
}

async function balances() {
  return withTx(
    async (tx) => ({
      payer: (await computeExpectedCash(tx, 100, "50000.00")).toFixed(2),
      reviewer: (await computeExpectedCash(tx, 101, "70000.00")).toFixed(2),
    }),
    { gate: "NONE" },
  );
}

async function refundInput(): Promise<RequestSupplierPaymentRefundInput> {
  const requested = await requestSupplierPayment(input(), payer);
  await decideSupplierPayment(decision(requested.requestId), reviewer);
  const [payment] = await db().select().from(schema.supplierPayments);
  const [allocation] = await db()
    .select()
    .from(schema.supplierPaymentAllocations);
  return {
    supplierPaymentId: Number(payment.id),
    expectedPaymentVersion: Number(payment.version),
    requestKey: randomUUID(),
    refundMethod: "CASH",
    evidenceType: "CASH_RECEIPT",
    evidenceReference: "supplier-refund-1",
    reason: "استلام استرداد من المورد",
    allocations: [
      {
        supplierPaymentAllocationId: Number(allocation.id),
        amount: "3000.00",
        currencyAmount: "3000.00",
      },
    ],
  };
}

beforeEach(async () => {
  vi.stubEnv("ROLLOUT_OWNER_ONLY_APPROVAL", "off");
  await db()
    .insert(schema.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(schema.users)
    .values([
      {
        id: 7,
        openId: "payer-source-maker",
        name: "دافع",
        role: "purchasing",
        branchId: 1,
      },
      {
        id: 8,
        openId: "payer-source-reviewer",
        name: "مراجع",
        role: "accountant",
        branchId: 1,
      },
    ]);
  await db()
    .insert(schema.shifts)
    .values([
      {
        id: 100,
        branchId: 1,
        userId: 7,
        openingBalance: "50000.00",
        status: "OPEN",
      },
      {
        id: 101,
        branchId: 1,
        userId: 8,
        openingBalance: "70000.00",
        status: "OPEN",
      },
    ]);
  await db()
    .insert(schema.suppliers)
    .values({ id: 1, name: "مورد", currentBalance: "100000.00" });
  const entry = await db().insert(schema.accountingEntries).values({
    entryType: "PURCHASE",
    amount: "100000.00",
    branchId: 1,
    supplierId: 1,
    entryDate: "2026-01-01",
  });
  await db()
    .insert(schema.supplierInvoices)
    .values({
      id: 1,
      invoiceNumber: "SI-PAYER-1",
      clientRequestId: "payer-invoice-1",
      supplierId: 1,
      branchId: 1,
      status: "POSTED",
      liabilityClass: "NATIVE_AP",
      paymentGate: "OPEN",
      invoiceDate: "2026-01-01",
      currency: "IQD",
      subtotal: "100000.00",
      totalAmount: "100000.00",
      payloadCanonical: "{}",
      payloadHash: "0".repeat(64),
      evidenceType: "OTHER",
      externalInvoiceNumber: "EXT-PAYER-1",
      externalNumberNorm: "EXTPAYER1",
      evidenceReference: "invoice-evidence",
      createdBy: 7,
      postingEntryId: extractInsertId(entry),
      postedBy: 8,
      postedAt: new Date(),
    });
});

describe("supplier payment payer and refund receiver cash sources", () => {
  it("credits only the requester's receiving drawer when another drawer owner approves a refund", async () => {
    const requested = await requestSupplierPaymentRefund(
      await refundInput(),
      payer,
    );
    expect(await balances()).toEqual({
      payer: "40000.00",
      reviewer: "70000.00",
    });
    const pending = await listPendingSupplierPaymentRefundRequests(
      { branchId: 1, limit: 50 },
      payer,
    );
    expect(pending.rows[0].cashSource).toEqual({
      mode: "DRAWER",
      shiftId: 100,
      receiverUserId: 7,
    });
    const approve = decision(requested.requestId);
    await decideSupplierPaymentRefund(approve, reviewer);
    expect(await decideSupplierPaymentRefund(approve, reviewer)).toMatchObject({
      status: "APPROVED",
      idempotent: true,
    });
    expect(await balances()).toEqual({
      payer: "43000.00",
      reviewer: "70000.00",
    });
    const [receipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.direction, "IN"));
    expect(receipt).toMatchObject({
      shiftId: 100,
      cashBucket: "DRAWER",
      createdBy: 7,
      approvedBy: 8,
    });
    const [ledger] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(eq(schema.accountingEntries.entryType, "PAYMENT_IN"));
    expect(ledger.createdBy).toBe(7);
    const [refund] = await db().select().from(schema.supplierPaymentRefunds);
    expect(refund.postedBy).toBe(8);
  });

  it("freezes refund receiver and hash across replay, and never replaces a closed receiving drawer", async () => {
    const refund = await refundInput();
    await expect(
      requestSupplierPaymentRefund(
        { ...refund, cashSource: { mode: "DRAWER", shiftId: 101 } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      requestSupplierPaymentRefund(
        { ...refund, cashSource: { mode: "TREASURY" } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const requested = await requestSupplierPaymentRefund(refund, payer);
    const [before] = await db()
      .select()
      .from(schema.supplierPaymentRefundRequests);
    expect(JSON.parse(before.payloadCanonical).cashSource).toEqual({
      mode: "DRAWER",
      shiftId: 100,
      receiverUserId: 7,
    });
    await expect(
      requestSupplierPaymentRefund(refund, reviewer),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      requestSupplierPaymentRefund(
        { ...refund, cashSource: { mode: "TREASURY" } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db()
      .update(schema.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(schema.shifts.id, 100));
    await db()
      .insert(schema.shifts)
      .values({
        id: 102,
        branchId: 1,
        userId: 7,
        openingBalance: "90000.00",
        status: "OPEN",
      });
    expect(await requestSupplierPaymentRefund(refund, payer)).toMatchObject({
      requestId: requested.requestId,
      idempotent: true,
    });
    const [after] = await db()
      .select()
      .from(schema.supplierPaymentRefundRequests);
    expect(after.payloadCanonical).toBe(before.payloadCanonical);
    expect(after.payloadHash).toBe(before.payloadHash);
    await expect(
      decideSupplierPaymentRefund(decision(requested.requestId), reviewer),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db().select().from(schema.supplierPaymentRefunds),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(schema.receipts)
        .where(eq(schema.receipts.direction, "IN")),
    ).toHaveLength(0);
    expect(await balances()).toEqual({
      payer: "40000.00",
      reviewer: "70000.00",
    });
    expect(
      await withTx(
        async (tx) =>
          (await computeExpectedCash(tx, 102, "90000.00")).toFixed(2),
        { gate: "NONE" },
      ),
    ).toBe("90000.00");
    expect(
      await decideSupplierPaymentRefund(
        { ...decision(requested.requestId), action: "REJECT" },
        reviewer,
      ),
    ).toMatchObject({ status: "REJECTED" });
  });

  it("blocks legacy source-less cash refunds while preserving request replay and rejection", async () => {
    const refund = await refundInput();
    const requested = await requestSupplierPaymentRefund(refund, payer);
    const [request] = await db()
      .select()
      .from(schema.supplierPaymentRefundRequests);
    const payload = JSON.parse(request.payloadCanonical);
    delete payload.cashSource;
    delete payload.branchId;
    const canonical = JSON.stringify(payload);
    await db()
      .update(schema.supplierPaymentRefundRequests)
      .set({
        payloadCanonical: canonical,
        payloadHash: createHash("sha256").update(canonical).digest("hex"),
      })
      .where(eq(schema.supplierPaymentRefundRequests.id, requested.requestId));
    expect(await requestSupplierPaymentRefund(refund, payer)).toMatchObject({
      idempotent: true,
    });
    expect(
      (
        await listPendingSupplierPaymentRefundRequests(
          { branchId: 1, limit: 50 },
          payer,
        )
      ).rows[0].cashSource,
    ).toBeNull();
    await expect(
      decideSupplierPaymentRefund(decision(requested.requestId), reviewer),
    ).rejects.toThrow(/أعد تقديمه بمصدر نقد صريح/);
    const reject = {
      ...decision(requested.requestId),
      action: "REJECT" as const,
    };
    expect(await decideSupplierPaymentRefund(reject, reviewer)).toMatchObject({
      status: "REJECTED",
    });
    expect(await decideSupplierPaymentRefund(reject, reviewer)).toMatchObject({
      status: "REJECTED",
      idempotent: true,
    });
    expect(await balances()).toEqual({
      payer: "40000.00",
      reviewer: "70000.00",
    });
  });

  it("charges only the requester drawer when another drawer owner approves", async () => {
    const requested = await requestSupplierPayment(input(), payer);
    expect(await balances()).toEqual({
      payer: "50000.00",
      reviewer: "70000.00",
    });
    await decideSupplierPayment(decision(requested.requestId), reviewer);
    expect(await balances()).toEqual({
      payer: "40000.00",
      reviewer: "70000.00",
    });
    const [receipt] = await db().select().from(schema.receipts);
    expect(receipt).toMatchObject({
      shiftId: 100,
      cashBucket: "DRAWER",
      createdBy: 7,
      approvedBy: 8,
    });
    const [ledger] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(eq(schema.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(ledger.createdBy).toBe(7);
    const [payment] = await db().select().from(schema.supplierPayments);
    expect(payment.postedBy).toBe(8);
  });

  it("keeps replay source and hash stable after the original drawer closes, but blocks approval", async () => {
    const paymentInput = input();
    const requested = await requestSupplierPayment(paymentInput, payer);
    const [before] = await db().select().from(schema.supplierPaymentRequests);
    expect(JSON.parse(before.payloadCanonical).cashSource).toEqual({
      mode: "DRAWER",
      shiftId: 100,
      payerUserId: 7,
    });
    await db()
      .update(schema.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(schema.shifts.id, 100));
    await db().insert(schema.shifts).values({
      id: 102,
      branchId: 1,
      userId: 7,
      openingBalance: "90000.00",
      status: "OPEN",
    });
    expect(await requestSupplierPayment(paymentInput, payer)).toMatchObject({
      requestId: requested.requestId,
      idempotent: true,
    });
    const [after] = await db().select().from(schema.supplierPaymentRequests);
    expect(after.payloadCanonical).toBe(before.payloadCanonical);
    expect(after.payloadHash).toBe(before.payloadHash);
    await expect(
      decideSupplierPayment(decision(requested.requestId), reviewer),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(schema.receipts)).toHaveLength(0);
    expect(
      await withTx(
        async (tx) =>
          (await computeExpectedCash(tx, 102, "90000.00")).toFixed(2),
        { gate: "NONE" },
      ),
    ).toBe("90000.00");
    expect(await balances()).toEqual({
      payer: "50000.00",
      reviewer: "70000.00",
    });
  });

  it("denies another user's drawer, a different branch drawer, and unauthorized treasury selection", async () => {
    await expect(
      requestSupplierPayment(
        { ...input(), cashSource: { mode: "DRAWER", shiftId: 101 } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db()
      .insert(schema.shifts)
      .values({ id: 103, branchId: 2, userId: 7, status: "OPEN" });
    await expect(
      requestSupplierPayment(
        { ...input(), cashSource: { mode: "DRAWER", shiftId: 103 } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      requestSupplierPayment(
        { ...input(), cashSource: { mode: "TREASURY" } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await db().select().from(schema.supplierPaymentRequests),
    ).toHaveLength(0);
  });

  it("denies source changes and requester changes when a request key is replayed", async () => {
    const paymentInput = input();
    await requestSupplierPayment(paymentInput, payer);
    await expect(
      requestSupplierPayment(
        { ...paymentInput, cashSource: { mode: "TREASURY" } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      requestSupplierPayment(paymentInput, reviewer),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await db().select().from(schema.supplierPaymentRequests),
    ).toHaveLength(1);
  });

  it("keeps noncash payments outside drawers and rejects any cash source supplied for them", async () => {
    const paymentInput = {
      ...input(),
      paymentMethod: "TRANSFER" as const,
      externalReference: "bank-transfer-1",
    };
    await expect(
      requestSupplierPayment(
        { ...paymentInput, cashSource: { mode: "DRAWER", shiftId: 100 } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const requested = await requestSupplierPayment(paymentInput, payer);
    const decide = decision(requested.requestId);
    await decideSupplierPayment(decide, reviewer);
    expect(await decideSupplierPayment(decide, reviewer)).toMatchObject({
      status: "APPROVED",
      idempotent: true,
    });
    expect(await balances()).toEqual({
      payer: "50000.00",
      reviewer: "70000.00",
    });
    const [receipt] = await db().select().from(schema.receipts);
    expect(receipt).toMatchObject({
      shiftId: null,
      cashBucket: null,
      paymentMethod: "TRANSFER",
    });
    const [payment] = await db().select().from(schema.supplierPayments);
    const [allocation] = await db()
      .select()
      .from(schema.supplierPaymentAllocations);
    const refund: RequestSupplierPaymentRefundInput = {
      supplierPaymentId: Number(payment.id),
      expectedPaymentVersion: Number(payment.version),
      requestKey: randomUUID(),
      refundMethod: "TRANSFER",
      externalReference: "bank-refund-1",
      evidenceType: "BANK_ADVICE",
      evidenceReference: "bank-refund-evidence",
      reason: "استرداد غير نقدي",
      allocations: [
        {
          supplierPaymentAllocationId: Number(allocation.id),
          amount: "3000.00",
          currencyAmount: "3000.00",
        },
      ],
    };
    await expect(
      requestSupplierPaymentRefund(
        { ...refund, cashSource: { mode: "DRAWER", shiftId: 100 } },
        payer,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const refundRequest = await requestSupplierPaymentRefund(refund, payer);
    expect(await requestSupplierPaymentRefund(refund, payer)).toMatchObject({
      idempotent: true,
    });
    await decideSupplierPaymentRefund(
      decision(refundRequest.requestId),
      reviewer,
    );
    const [refundReceipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.direction, "IN"));
    expect(refundReceipt).toMatchObject({
      shiftId: null,
      cashBucket: null,
      paymentMethod: "TRANSFER",
      createdBy: 7,
      approvedBy: 8,
    });
    expect(await balances()).toEqual({
      payer: "50000.00",
      reviewer: "70000.00",
    });
  });

  it("requires resubmission of legacy cash requests while retaining rejection and request replay", async () => {
    const paymentInput = input();
    const requested = await requestSupplierPayment(paymentInput, payer);
    const [request] = await db().select().from(schema.supplierPaymentRequests);
    const payload = JSON.parse(request.payloadCanonical);
    delete payload.cashSource;
    const canonical = JSON.stringify(payload);
    await db()
      .update(schema.supplierPaymentRequests)
      .set({
        payloadCanonical: canonical,
        payloadHash: createHash("sha256").update(canonical).digest("hex"),
      })
      .where(eq(schema.supplierPaymentRequests.id, requested.requestId));
    expect(await requestSupplierPayment(paymentInput, payer)).toMatchObject({
      idempotent: true,
    });
    await expect(
      decideSupplierPayment(decision(requested.requestId), reviewer),
    ).rejects.toThrow(/أعد تقديمه بمصدر نقد صريح/);
    const reject = {
      ...decision(requested.requestId),
      action: "REJECT" as const,
    };
    expect(await decideSupplierPayment(reject, reviewer)).toMatchObject({
      status: "REJECTED",
    });
    expect(await decideSupplierPayment(reject, reviewer)).toMatchObject({
      status: "REJECTED",
      idempotent: true,
    });
    expect(await db().select().from(schema.receipts)).toHaveLength(0);
  });

  it("rejects altered canonical evidence rather than choosing a new cash source", async () => {
    const requested = await requestSupplierPayment(input(), payer);
    const [request] = await db().select().from(schema.supplierPaymentRequests);
    const payload = JSON.parse(request.payloadCanonical);
    payload.cashSource.shiftId = 101;
    await db()
      .update(schema.supplierPaymentRequests)
      .set({ payloadCanonical: JSON.stringify(payload) })
      .where(eq(schema.supplierPaymentRequests.id, requested.requestId));
    await expect(
      decideSupplierPayment(decision(requested.requestId), reviewer),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(schema.receipts)).toHaveLength(0);
  });

  it("does not silently fall back to treasury even for an owner with no drawer", async () => {
    const owner = { userId: 9, branchId: 1, role: "manager" };
    await db().insert(schema.users).values({
      id: 9,
      openId: "payer-source-owner",
      role: "manager",
      branchId: 1,
      isOwner: true,
    });
    await expect(requestSupplierPayment(input(), owner)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      requestSupplierPayment(
        { ...input(), cashSource: { mode: "TREASURY", shiftId: 100 } },
        owner,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await db().insert(schema.receipts).values({
      branchId: 1,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: "50000.00",
      paymentMethod: "CASH",
      partyType: "OTHER",
      description: "رصيد خزينة اختبار",
      createdBy: 9,
      approvedBy: 9,
      approvalStatus: "APPROVED",
      status: "COMPLETED",
    });
    const requested = await requestSupplierPayment(
      { ...input(), cashSource: { mode: "TREASURY" } },
      owner,
    );
    expect(requested.status).toBe("APPROVED");
    const [receipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.direction, "OUT"));
    expect(receipt).toMatchObject({
      cashBucket: "TREASURY",
      shiftId: null,
      createdBy: 9,
      approvedBy: 9,
    });
    expect(await balances()).toEqual({
      payer: "50000.00",
      reviewer: "70000.00",
    });
    const [payment] = await db().select().from(schema.supplierPayments);
    const [allocation] = await db()
      .select()
      .from(schema.supplierPaymentAllocations);
    const refund: RequestSupplierPaymentRefundInput = {
      supplierPaymentId: Number(payment.id),
      expectedPaymentVersion: Number(payment.version),
      requestKey: randomUUID(),
      refundMethod: "CASH",
      evidenceType: "CASH_RECEIPT",
      evidenceReference: "owner-treasury-refund",
      reason: "استرداد إلى الخزينة",
      allocations: [
        {
          supplierPaymentAllocationId: Number(allocation.id),
          amount: "3000.00",
          currencyAmount: "3000.00",
        },
      ],
    };
    await expect(
      requestSupplierPaymentRefund(refund, owner),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const refundRequest = await requestSupplierPaymentRefund(
      { ...refund, cashSource: { mode: "TREASURY" } },
      owner,
    );
    expect(refundRequest.status).toBe("APPROVED");
    const [refundReceipt] = await db()
      .select()
      .from(schema.receipts)
      .where(
        eq(
          schema.receipts.referenceNumber,
          `SUPPLIER-REFUND-REQ:${refundRequest.requestId}`,
        ),
      );
    expect(refundReceipt).toMatchObject({
      shiftId: null,
      cashBucket: "TREASURY",
      createdBy: 9,
      approvedBy: 9,
    });
    expect(await balances()).toEqual({
      payer: "50000.00",
      reviewer: "70000.00",
    });
  });
});
