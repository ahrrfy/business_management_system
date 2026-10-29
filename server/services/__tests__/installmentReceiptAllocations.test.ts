import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb, getPool } from "../../db";
import {
  createPlan,
  getPlan,
  payLine,
  cancelPlan,
  bounceCheck,
  listPlans,
  dueSoon,
} from "../installmentService";
import {
  createVoucher,
  cancelVoucher,
  approveVoucher,
  rejectVoucher,
} from "../voucherService";
import { createVoucherTx } from "../voucher/create";
import { withTx, withGovernanceTx } from "../tx";
import { applyCustomerReceiptCreditTx } from "../customerReceiptSettlement";
import { processPayment } from "../sale/payment";
import { money } from "../money";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import { saveInstallmentReceiptClaimTx } from "../installment/receiptClaims";
import { lockInstallmentPlanTx } from "../installment/receiptAllocations";
import { extractInsertId } from "../../lib/insertId";
import { installmentRouter } from "../../routers/installmentRouter";
import { router } from "../../trpc";
import type { TrpcContext } from "../../context";
import {
  initiateExternalPaymentAttempt,
  confirmExternalPaymentAttempt,
} from "../posExternalPayment";
import * as shiftService from "../shiftService";
const actor = { userId: 1, branchId: 1, role: "admin" as const };
const owner = { userId: 2, branchId: 1, role: "admin" as const };
const db = () => getDb()!;
const installmentApi = router({ installments: installmentRouter });
function caller(userId = 1, role = "admin", branchId = 1) {
  return installmentApi.createCaller({ req: { headers: {} }, res: {},
    user: { id: userId, role, branchId, isActive: true } } as TrpcContext);
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "installment-actor",
    name: "Collector",
    role: "admin",
  });
  await db().insert(s.users).values({
    id: 2,
    openId: "installment-owner",
    name: "Owner",
    role: "admin",
    isOwner: true,
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "Actual collection", currentBalance: "100000.00" });
  await db().insert(s.invoices).values({
    id: 1,
    invoiceNumber: "INST-ACTUAL-1",
    branchId: 1,
    customerId: 1,
    sourceType: "POS",
    subtotal: "100000.00",
    total: "100000.00",
    paidAmount: "0.00",
    status: "PENDING",
  });
});
async function plan() {
  const { planId } = await createPlan(
    {
      clientRequestId: crypto.randomUUID(),
      customerId: 1,
      invoiceId: 1,
      branchId: 1,
      totalAmount: "100000.00",
      lines: [
        { dueDate: "2026-11-01", amount: "50000.00", kind: "CASH" },
        { dueDate: "2026-12-01", amount: "50000.00", kind: "CASH" },
      ],
    },
    actor,
  );
  return getPlan(planId);
}
async function collect(amount: string) {
  return createVoucher(
    {
      voucherType: "RECEIPT",
      partyType: "CUSTOMER",
      partyId: 1,
      branchId: 1,
      invoiceId: 1,
      amount,
      paymentMethod: "CASH",
      description: "Actual invoice collection",
      clientRequestId: crypto.randomUUID(),
    },
    actor,
  );
}
async function reverse(receiptId: number) {
  const request = await cancelVoucher(receiptId, actor);
  if (request.approvalReceiptId != null)
    await approveVoucher(request.approvalReceiptId, owner);
  return request;
}
async function snapshot() {
  return {
    invoices: await db().select().from(s.invoices),
    customers: await db().select().from(s.customers),
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
    journals: await db().select().from(s.journalEntries),
    journalLines: await db().select().from(s.journalLines),
    history: await db().select().from(s.installmentReceiptAllocations),
    keys: await db().select().from(s.idempotencyKeys),
  };
}
async function historicalVoucher() {
  const p = await plan();
  const line = p.lines[0];
  const receiptId = extractInsertId(await db().insert(s.receipts).values({
    invoiceId: 1, branchId: 1, partyType: "CUSTOMER", partyId: 1,
    direction: "IN", amount: "50000.00", paymentMethod: "CHECK",
    voucherNumber: "HISTORICAL-CHECK-1", checkNumber: "BANK-CHECK-1",
    voucherDate: new Date("2026-10-29T00:00:00Z"), status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1,
  }));
  await db().update(s.installmentLines).set({ kind: "CHECK", checkNumber: "BANK-CHECK-1",
    allocationHistoryReady: false, status: "PAID", receiptId }).where(eq(s.installmentLines.id, line.id));
  await db().insert(s.accountingEntries).values({ branchId: 1, customerId: 1, receiptId,
    entryType: "PAYMENT_IN", amount: "50000.00", entryDate: new Date("2026-10-29T00:00:00Z") });
  await db().update(s.invoices).set({ paidAmount: "50000.00", status: "PARTIALLY_PAID" }).where(eq(s.invoices.id, 1));
  await db().update(s.customers).set({ currentBalance: "50000.00" }).where(eq(s.customers.id, 1));
  return { p, line, receiptId };
}
async function activeLedger() {
  await db().insert(s.accounts).values([
    { code: "INV-AR", name: "AR", type: "ASSET", systemRole: "AR" },
    { code: "INV-CASH", name: "Cash", type: "ASSET", systemRole: "CASH" },
    { code: "INV-CHECK", name: "Checks", type: "ASSET", systemRole: "CHECKS_RECEIVABLE" },
  ]);
  await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "ACTIVE", shadowCycleId: "inverse",
    shadowOpeningHash: "a".repeat(64), policyApprovalReference: "Inverse",
    policyApprovalPolicyHash: POSTING_POLICY_HASH, policyApprovalCycleId: "inverse",
    policyApprovalOpeningHash: "a".repeat(64), policyAccountantName: "Test", policyApprovedAt: new Date(), policyApprovedBy: 2 });
}
describe("actual receipt installment history", () => {
  it("native API adopts proven CHECK and partial CASH source history while preserving original schedule", async () => {
    const { p, receiptId } = await historicalVoucher();
    await caller().installments.adoptLegacyHistory({ planId: p.id });
    let current = await caller().installments.get({ planId: p.id });
    expect(current.reconciliationRequired).toBe(false);
    expect(current.lines[0].paymentHistory[0].receiptId).toBe(receiptId);
    expect(current.lines.map(l => l.amount)).toEqual(["50000.00", "50000.00"]);
    const saved = await snapshot();
    await caller().installments.adoptLegacyHistory({ planId: p.id });
    expect(await snapshot()).toEqual(saved);
    await caller().installments.bounce({ lineId: p.lines[0].id });
    expect((await getPlan(p.id)).lines[0].paidAmount).toBe("0.00");
  });
  it("native API adopts directly proven partial CASH and collects only the remaining portion", async () => {
    const { p, line, receiptId } = await historicalVoucher();
    await db().update(s.receipts).set({ amount: "20000.00", paymentMethod: "CASH", cashBucket: "TREASURY" }).where(eq(s.receipts.id, receiptId));
    await db().update(s.accountingEntries).set({ amount: "20000.00" }).where(eq(s.accountingEntries.receiptId, receiptId));
    await db().update(s.installmentLines).set({ status: "PENDING", kind: "CASH" }).where(eq(s.installmentLines.id, line.id));
    await db().update(s.invoices).set({ paidAmount: "20000.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.customers).set({ currentBalance: "80000.00" }).where(eq(s.customers.id, 1));
    await caller().installments.adoptLegacyHistory({ planId: p.id });
    expect((await getPlan(p.id)).lines[0]).toMatchObject({ paidAmount: "20000.00", remainingAmount: "30000.00" });
    const paid = await caller().installments.pay({ lineId: line.id, clientRequestId: crypto.randomUUID() });
    expect((await db().select().from(s.receipts).where(eq(s.receipts.id, paid.receiptId)))[0].amount).toBe("30000.00");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("50000.00");
  });
  it.each(["missing", "account-only", "mismatch", "unknown"])("native adoption refuses %s evidence without any financial or history write", async kind => {
    const { p, line, receiptId } = await historicalVoucher();
    if (kind === "missing") await db().delete(s.accountingEntries).where(eq(s.accountingEntries.receiptId, receiptId));
    if (kind === "account-only") await db().update(s.receipts).set({ invoiceId: null }).where(eq(s.receipts.id, receiptId));
    if (kind === "mismatch") await db().update(s.accountingEntries).set({ amount: "40000.00" }).where(eq(s.accountingEntries.receiptId, receiptId));
    if (kind === "unknown") await db().update(s.installmentLines).set({ receiptId: null }).where(eq(s.installmentLines.id, line.id));
    const before = await snapshot();
    await expect(caller().installments.adoptLegacyHistory({ planId: p.id })).rejects.toThrow(/مطابقة/);
    expect(await snapshot()).toEqual(before);
    expect((await getPlan(p.id)).reconciliationRequired).toBe(true);
  });
  it("native adoption enforces stored active authority and branch restriction", async () => {
    const p = await plan();
    const stale = caller();
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 1));
    const before = await snapshot();
    await expect(stale.installments.adoptLegacyHistory({ planId: p.id })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await db().update(s.users).set({ isActive: true }).where(eq(s.users.id, 1));
    await expect(caller(1, "manager", 2).installments.adoptLegacyHistory({ planId: p.id })).rejects.toThrow();
  });
  it("native API adopts empty legacy CASH history without money then collects exact remainder once", async () => {
    const p = await plan();
    await db().update(s.installmentLines).set({ allocationHistoryReady: false }).where(eq(s.installmentLines.planId, p.id));
    await db().delete(s.idempotencyKeys).where(eq(s.idempotencyKeys.operation, "installment.scope"));
    const before = await snapshot();
    expect((await caller().installments.get({ planId: p.id })).reconciliationRequired).toBe(true);
    await caller().installments.adoptLegacyHistory({ planId: p.id });
    const after = await snapshot();
    for (const key of ["invoices", "customers", "receipts", "entries", "journals", "history"] as const)
      expect(after[key]).toEqual(before[key]);
    expect((await caller().installments.get({ planId: p.id })).reconciliationRequired).toBe(false);
    const input = { lineId: p.lines[0].id, clientRequestId: crypto.randomUUID() };
    const payment = await caller().installments.pay(input);
    expect(await caller().installments.pay(input)).toEqual(payment);
    expect((await getPlan(p.id)).lines[0].remainingAmount).toBe("0.00");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("50000.00");
  });
  it("eligible historical CHECK voucher supports one native cancellation and approval replay", async () => {
    const { p, receiptId } = await historicalVoucher();
    await caller().installments.adoptLegacyHistory({ planId: p.id });
    const request = await cancelVoucher(receiptId, actor);
    expect(request.status).toBe("PENDING_APPROVAL");
    expect(request.approvalReceiptId).toBeTypeOf("number");
    await Promise.all([approveVoucher(request.approvalReceiptId!, owner), approveVoucher(request.approvalReceiptId!, owner)]);
    const saved = await snapshot();
    await approveVoucher(request.approvalReceiptId!, owner);
    expect(await snapshot()).toEqual(saved);
    expect(saved.invoices[0].paidAmount).toBe("0.00");
    expect(saved.customers[0].currentBalance).toBe("100000.00");
  });
  it.each([false, true])("consumed CHECK cannot reverse CASH refill via cancellation requested before bounce=%s", async (requestedBefore) => {
    await activeLedger();
    const { line, receiptId } = await historicalVoucher();
    let request = requestedBefore ? await cancelVoucher(receiptId, actor) : null;
    await bounceCheck({ lineId: line.id }, actor);
    const replacement = await payLine({ lineId: line.id, clientRequestId: crypto.randomUUID() }, actor);
    const before = await snapshot();
    expect(before.journals).toHaveLength(2);
    expect(before.journalLines).toHaveLength(4);
    if (!request) {
      try { request = await cancelVoucher(receiptId, actor); }
      catch (error) { expect(String(error)).toMatch(/معكوس/); }
    }
    if (request) {
      const pending = await snapshot();
      await expect(approveVoucher(request.approvalReceiptId!, owner)).rejects.toThrow(/معكوس/);
      expect(await snapshot()).toEqual(pending);
    }
    const after = await snapshot();
    expect(after.invoices).toEqual(before.invoices);
    expect(after.customers).toEqual(before.customers);
    expect(after.entries).toEqual(before.entries);
    expect(after.journals).toEqual(before.journals);
    expect(after.history).toEqual(before.history);
    expect(after.receipts.find(r => r.id === receiptId)).toEqual(before.receipts.find(r => r.id === receiptId));
    expect(after.receipts.find(r => r.id === replacement.receiptId)).toEqual(before.receipts.find(r => r.id === replacement.receiptId));
    await reverse(replacement.receiptId);
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("100000.00");
  });
  it("source-less partial OUT preserves one larger allocation and exposes reconciliation before further collection", async () => {
    const p = await plan();
    await collect("50000.00");
    const history = await db().select().from(s.installmentReceiptAllocations);
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe("50000.00");
    const input = {
      voucherType: "PAYMENT" as const,
      partyType: "CUSTOMER" as const,
      partyId: 1,
      branchId: 1,
      invoiceId: 1,
      amount: "20000.00",
      paymentMethod: "CASH" as const,
      description: "Partial refund without original-source selection",
      clientRequestId: crypto.randomUUID(),
    };
    const refund = await createVoucher(input, actor);
    await approveVoucher(refund.receiptId, owner);
    await approveVoucher(refund.receiptId, owner);
    expect(await db().select().from(s.installmentReceiptAllocations)).toEqual(
      history,
    );
    const current = await getPlan(p.id);
    expect(current.invoiceNetPaidAmount).toBe("30000.00");
    expect(current.invoiceRemainingAmount).toBe("70000.00");
    expect(current.reconciliationRequired).toBe(true);
    expect(current.lines[0].paidAmount).toBe("50000.00");
    expect((await listPlans({})).rows[0].reconciliationRequired).toBe(true);
    expect((await dueSoon({ days: 90 }))[0].reconciliationRequired).toBe(true);
    const before = await snapshot();
    await expect(
      payLine(
        { lineId: p.lines[1].id, clientRequestId: crypto.randomUUID() },
        actor,
      ),
    ).rejects.toThrow(/مطابقة/);
    await expect(
      cancelPlan({ planId: p.id, clientRequestId: crypto.randomUUID() }, actor),
    ).rejects.toThrow(/مطابقة/);
    await expect(bounceCheck({ lineId: p.lines[0].id }, actor)).rejects.toThrow(
      /مطابقة/,
    );
    expect(await snapshot()).toEqual(before);
    expect(before.receipts).toHaveLength(2);
    expect(before.entries).toHaveLength(2);
    expect(before.customers[0].currentBalance).toBe("70000.00");
    const exposed = JSON.stringify(current);
    for (const privateField of [
      "allocationHeadId",
      "pendingAllocationClaimId",
      "payloadHash",
      "cardLastFour",
      "attachmentUrl",
      "internalNote",
    ])
      expect(exposed).not.toContain(privateField);
  });
  it("saved cash request replays after drawer closes; changed payload and reversed old request cannot recollect", async () => {
    const p = await plan();
    await db().insert(s.users).values({
      id: 3,
      openId: "A04-cashier",
      name: "Cashier",
      role: "cashier",
    });
    await db().insert(s.shifts).values({
      id: 1,
      userId: 3,
      branchId: 1,
      status: "OPEN",
      openedAt: new Date(),
      openGuard: "3:1",
      openingBalance: "0",
    });
    const cashier = { userId: 3, branchId: 1, role: "cashier" as const };
    const request = {
      lineId: p.lines[0].id,
      clientRequestId: crypto.randomUUID(),
      note: "exact saved payload",
    };
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nativeRoute = shiftService.shiftIdForCashTx;
    let calls = 0,
      routeFailed = false;
    const route = vi
      .spyOn(shiftService, "shiftIdForCashTx")
      .mockImplementation(async (...args) => {
        if (++calls === 1) {
          entered();
          await releasePromise;
        }
        try {
          return await nativeRoute(...args);
        } catch (error) {
          routeFailed = true;
          throw error;
        }
      });
    const earlyMiss = payLine(request, cashier);
    await enteredPromise;
    let first: Awaited<ReturnType<typeof payLine>>;
    try {
      first = await payLine(request, cashier);
      await db()
        .update(s.shifts)
        .set({ status: "CLOSED", closedAt: new Date() })
        .where(eq(s.shifts.id, 1));
    } finally {
      release();
    }
    try {
      expect(await earlyMiss).toEqual(first!);
      expect(routeFailed).toBe(true);
    } finally {
      route.mockRestore();
    }
    expect(await payLine(request, cashier)).toEqual(first);
    await expect(
      payLine({ ...request, note: "changed" }, cashier),
    ).rejects.toThrow(/idempotency/);
    // A separate real treasury collection exercises reversal without reopening the closed drawer.
    const reversibleRequest = {
      lineId: p.lines[1].id,
      clientRequestId: crypto.randomUUID(),
    };
    const reversible = await payLine(reversibleRequest, actor);
    await reverse(reversible.receiptId);
    const before = await snapshot();
    await expect(payLine(reversibleRequest, actor)).rejects.toThrow(/معكوسة/);
    expect(await snapshot()).toEqual(before);
  });
  it("ordinary 10k leaves 40k; native collection charges only that remainder once", async () => {
    const p = await plan();
    await collect("10000.00");
    const request = {
      lineId: p.lines[0].id,
      clientRequestId: crypto.randomUUID(),
      paymentMethod: "CASH" as const,
    };
    const first = await payLine(request, actor);
    expect(await payLine(request, actor)).toEqual(first);
    const [invoice] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, 1));
    expect(invoice.paidAmount).toBe("50000.00");
    const actual = await db().select().from(s.receipts);
    expect(actual.map((r) => r.amount).sort()).toEqual([
      "10000.00",
      "40000.00",
    ]);
    const history = await db().select().from(s.installmentReceiptAllocations);
    expect(history.map((r) => r.amount).sort()).toEqual([
      "10000.00",
      "40000.00",
    ]);
    await expect(
      db()
        .update(s.installmentReceiptAllocations)
        .set({ amount: "1.00" })
        .where(eq(s.installmentReceiptAllocations.id, history[0].id)),
    ).rejects.toThrow();
    await expect(
      db()
        .delete(s.installmentReceiptAllocations)
        .where(eq(s.installmentReceiptAllocations.id, history[0].id)),
    ).rejects.toThrow();
    await expect(
      db()
        .delete(s.receipts)
        .where(eq(s.receipts.id, history[0].sourceReceiptId)),
    ).rejects.toThrow();
    const [customer] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, 1));
    expect(customer.currentBalance).toBe("50000.00");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
  });
  it("completed plan reopens only the exact reversed 10k and accepts a fresh 10k", async () => {
    const p = await plan();
    const original = await collect("10000.00");
    await payLine(
      { lineId: p.lines[0].id, clientRequestId: crypto.randomUUID() },
      actor,
    );
    await payLine(
      { lineId: p.lines[1].id, clientRequestId: crypto.randomUUID() },
      actor,
    );
    expect((await getPlan(p.id)).status).toBe("COMPLETED");
    await reverse(original.receiptId);
    const reopened = await getPlan(p.id);
    expect(reopened.status).toBe("ACTIVE");
    expect(reopened.lines.map((l) => l.remainingAmount)).toEqual([
      "10000.00",
      "0.00",
    ]);
    await payLine(
      { lineId: p.lines[0].id, clientRequestId: crypto.randomUUID() },
      actor,
    );
    expect((await getPlan(p.id)).status).toBe("COMPLETED");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
      "100000.00",
    );
  });
  it("selected later line stays selected; partial payment blocks cancellation and full inverse permits it", async () => {
    const p = await plan();
    const later = await payLine(
      { lineId: p.lines[1].id, clientRequestId: crypto.randomUUID() },
      actor,
    );
    expect((await getPlan(p.id)).lines.map((l) => l.paidAmount)).toEqual([
      "0.00",
      "50000.00",
    ]);
    const partial = await collect("10000.00");
    await expect(
      cancelPlan({ planId: p.id, clientRequestId: crypto.randomUUID() }, actor),
    ).rejects.toThrow();
    await reverse(later.receiptId);
    await reverse(partial.receiptId);
    await cancelPlan(
      { planId: p.id, clientRequestId: crypto.randomUUID() },
      actor,
    );
    expect((await getPlan(p.id)).status).toBe("CANCELLED");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
  });
  it("native FIFO 80k maps exact 30k/50k invoice portions and reverses that source", async () => {
    await db()
      .update(s.invoices)
      .set({ subtotal: "30000.00", total: "30000.00" })
      .where(eq(s.invoices.id, 1));
    await db().insert(s.invoices).values({
      id: 2,
      invoiceNumber: "FIFO-2",
      branchId: 1,
      customerId: 1,
      sourceType: "POS",
      subtotal: "50000.00",
      total: "50000.00",
      paidAmount: "0.00",
      status: "PENDING",
    });
    for (const [invoiceId, amount] of [
      [1, "30000.00"],
      [2, "50000.00"],
    ] as const)
      await createPlan(
        {
          clientRequestId: crypto.randomUUID(),
          customerId: 1,
          branchId: 1,
          invoiceId,
          totalAmount: amount,
          lines: [{ amount, dueDate: "2026-11-01", kind: "CASH" }],
        },
        actor,
      );
    const original = await createVoucher(
      {
        voucherType: "RECEIPT",
        partyType: "CUSTOMER",
        partyId: 1,
        branchId: 1,
        amount: "80000.00",
        paymentMethod: "CASH",
        description: "FIFO",
        clientRequestId: crypto.randomUUID(),
      },
      actor,
    );
    expect(
      (await db().select().from(s.installmentReceiptAllocations))
        .map((r) => r.amount)
        .sort(),
    ).toEqual(["30000.00", "50000.00"]);
    await reverse(original.receiptId);
    expect(
      (await db().select().from(s.invoices)).map((r) => r.paidAmount),
    ).toEqual(["0.00", "0.00"]);
    expect(
      (await db().select().from(s.installmentReceiptAllocations)).filter(
        (r) => r.reversesAllocationId != null,
      ),
    ).toHaveLength(2);
  });
  it("existing customer credit uses the real original receipt without another collection", async () => {
    await db()
      .update(s.invoices)
      .set({ status: "CANCELLED" })
      .where(eq(s.invoices.id, 1));
    await db()
      .update(s.customers)
      .set({ currentBalance: "0.00" })
      .where(eq(s.customers.id, 1));
    const receipt = await createVoucher(
      {
        voucherType: "RECEIPT",
        partyType: "CUSTOMER",
        partyId: 1,
        branchId: 1,
        amount: "20000.00",
        paymentMethod: "CASH",
        description: "Advance",
        clientRequestId: crypto.randomUUID(),
      },
      actor,
    );
    await db()
      .update(s.invoices)
      .set({ status: "PENDING" })
      .where(eq(s.invoices.id, 1));
    const p = await plan();
    await withGovernanceTx((tx) =>
      applyCustomerReceiptCreditTx(tx, 1, money("10000"), actor),
    );
    await withGovernanceTx((tx) =>
      applyCustomerReceiptCreditTx(tx, 1, money("10000"), actor),
    );
    const rows = await db().select().from(s.installmentReceiptAllocations);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sourceReceiptId === receipt.receiptId)).toBe(
      true,
    );
    expect((await getPlan(p.id)).lines[0].remainingAmount).toBe("30000.00");
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    await reverse(receipt.receiptId);
    expect((await getPlan(p.id)).lines[0].remainingAmount).toBe("50000.00");
  });
  it("ACTIVE journals post once and full rollback removes cash/AR/invoice/history/GL together", async () => {
    await db()
      .insert(s.accounts)
      .values([
        { code: "A04-AR", name: "AR", type: "ASSET", systemRole: "AR" },
        { code: "A04-CASH", name: "Cash", type: "ASSET", systemRole: "CASH" },
      ]);
    await db()
      .insert(s.doubleEntrySettings)
      .values({
        id: 1,
        mode: "ACTIVE",
        shadowCycleId: "a04",
        shadowOpeningHash: "a".repeat(64),
        policyApprovalReference: "A04",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: "a04",
        policyApprovalOpeningHash: "a".repeat(64),
        policyAccountantName: "Test",
        policyApprovedAt: new Date(),
        policyApprovedBy: 2,
      });
    await plan();
    const before = await snapshot();
    await expect(
      withTx(async (tx) => {
        await createVoucherTx(
          tx,
          {
            voucherType: "RECEIPT",
            branchId: 1,
            partyType: "CUSTOMER",
            partyId: 1,
            invoiceId: 1,
            amount: "10000.00",
            paymentMethod: "CASH",
            description: "Rollback",
            clientRequestId: crypto.randomUUID(),
          },
          actor,
        );
        throw new Error("forced atomic rollback");
      }),
    ).rejects.toThrow("forced atomic rollback");
    expect(await snapshot()).toEqual(before);
    await collect("10000.00");
    expect(await db().select().from(s.journalEntries)).toHaveLength(1);
    expect(await db().select().from(s.journalLines)).toHaveLength(2);
  });
  it("historical proven CHECK reverses actual invoice allocation once; replacement CASH cannot bounce", async () => {
    const p = await plan();
    const line = p.lines[0];
    await db()
      .update(s.installmentLines)
      .set({
        kind: "CHECK",
        checkNumber: "OLD-1",
        allocationHistoryReady: false,
        status: "PAID",
      })
      .where(eq(s.installmentLines.id, line.id));
    const receiptId = extractInsertId(
      await db().insert(s.receipts).values({
        invoiceId: 1,
        branchId: 1,
        partyType: "CUSTOMER",
        partyId: 1,
        direction: "IN",
        amount: "50000.00",
        paymentMethod: "CHECK",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        createdBy: 1,
      }),
    );
    await db()
      .update(s.installmentLines)
      .set({ receiptId })
      .where(eq(s.installmentLines.id, line.id));
    await db().insert(s.accountingEntries).values({
      branchId: 1,
      customerId: 1,
      receiptId,
      entryType: "PAYMENT_IN",
      amount: "50000.00",
      entryDate: new Date("2026-10-29T00:00:00Z"),
    });
    await db()
      .update(s.invoices)
      .set({ paidAmount: "50000.00", status: "PARTIALLY_PAID" })
      .where(eq(s.invoices.id, 1));
    await db()
      .update(s.customers)
      .set({ currentBalance: "50000.00" })
      .where(eq(s.customers.id, 1));
    await bounceCheck({ lineId: line.id }, actor);
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "100000.00",
    );
    await expect(bounceCheck({ lineId: line.id }, actor)).rejects.toThrow();
    await payLine(
      { lineId: line.id, clientRequestId: crypto.randomUUID() },
      actor,
    );
    await expect(bounceCheck({ lineId: line.id }, actor)).rejects.toThrow();
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
      "50000.00",
    );
  });
  it("pending native receipt is zero-effect, blocks cancel, retains latest receipt/claim after rejection", async () => {
    const p = await plan();
    const lineId = p.lines[0].id;
    const receiptId = extractInsertId(
      await db().insert(s.receipts).values({
        invoiceId: 1,
        branchId: 1,
        partyType: "CUSTOMER",
        partyId: 1,
        direction: "IN",
        amount: "50000.00",
        paymentMethod: "CASH",
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        createdBy: 1,
        voucherNumber: "LEGACY-PENDING",
      }),
    );
    await withTx(async (tx) => {
      await tx
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, 1))
        .for("update");
      const locked = await lockInstallmentPlanTx(tx, p.id);
      const [receipt] = await tx
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, receiptId));
      await saveInstallmentReceiptClaimTx(
        tx,
        lineId,
        locked!.plan,
        receipt,
        true,
      );
    });
    await expect(
      cancelPlan({ planId: p.id, clientRequestId: crypto.randomUUID() }, actor),
    ).rejects.toThrow();
    await rejectVoucher(receiptId, owner, "historical pending rejected");
    const [line] = await db()
      .select()
      .from(s.installmentLines)
      .where(eq(s.installmentLines.id, lineId));
    expect(line.pendingAllocationClaimId).toBeNull();
    expect(line.receiptId).toBe(receiptId);
    expect(
      await db()
        .select()
        .from(s.idempotencyKeys)
        .where(eq(s.idempotencyKeys.operation, "installment.receipt")),
    ).toHaveLength(1);
    expect(
      await db().select().from(s.installmentReceiptAllocations),
    ).toHaveLength(0);
    await cancelPlan(
      { planId: p.id, clientRequestId: crypto.randomUUID() },
      actor,
    );
  });
  it.each(["100000.00", "10000.00"])(
    "native approval clears the pending pointer after competing payment %s",
    async (competingAmount) => {
      const p = await plan();
      const lineId = p.lines[0].id;
      const receiptId = extractInsertId(
        await db().insert(s.receipts).values({
          invoiceId: 1,
          branchId: 1,
          partyType: "CUSTOMER",
          partyId: 1,
          direction: "IN",
          amount: "50000.00",
          paymentMethod: "CASH",
          status: "PENDING",
          approvalStatus: "PENDING_APPROVAL",
          createdBy: 1,
          voucherNumber: "OLD-PENDING-APPROVE",
        }),
      );
      await withTx(async (tx) => {
        await tx
          .select()
          .from(s.invoices)
          .where(eq(s.invoices.id, 1))
          .for("update");
        const locked = await lockInstallmentPlanTx(tx, p.id);
        const [receipt] = await tx
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, receiptId));
        await saveInstallmentReceiptClaimTx(
          tx,
          lineId,
          locked!.plan,
          receipt,
          true,
        );
      });
      await collect(competingAmount);
      const history = await db().select().from(s.installmentReceiptAllocations);
      expect((await getPlan(p.id)).status).toBe(
        competingAmount === "100000.00" ? "COMPLETED" : "ACTIVE",
      );
      await approveVoucher(receiptId, owner);
      const [line] = await db()
        .select()
        .from(s.installmentLines)
        .where(eq(s.installmentLines.id, lineId));
      expect(line.pendingAllocationClaimId).toBeNull();
      expect(line.receiptId).not.toBeNull();
      expect(
        await db()
          .select()
          .from(s.idempotencyKeys)
          .where(eq(s.idempotencyKeys.operation, "installment.receipt")),
      ).toHaveLength(1);
      const finalHistory = await db()
        .select()
        .from(s.installmentReceiptAllocations);
      if (competingAmount === "100000.00")
        expect(finalHistory).toEqual(history);
      else
        expect(finalHistory.map((row) => row.amount).sort()).toEqual([
          "10000.00",
          "10000.00",
          "40000.00",
        ]);
      expect(
        (
          await db()
            .select()
            .from(s.receipts)
            .where(eq(s.receipts.id, receiptId))
        )[0].invoiceId,
      ).toBeNull();
      expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
        competingAmount === "100000.00" ? "100000.00" : "60000.00",
      );
      expect((await db().select().from(s.customers))[0].currentBalance).toBe(
        competingAmount === "100000.00" ? "-50000.00" : "40000.00",
      );
    },
  );
  it("confirmed installment external evidence binds the actual remaining 40k and replays its receipt", async () => {
    const p = await plan();
    await collect("10000.00");
    const deviceId = "A04-INSTALLMENT";
    const attempt = await initiateExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "SALES_COLLECTION",
        method: "TRANSFER",
        amount: "40000.00",
        reference: "A04-PARTIAL-TRANSFER",
        requestId: crypto.randomUUID(),
        deviceId,
        businessBinding: { type: "INSTALLMENT_LINE", id: p.lines[0].id },
        verificationPolicy: "INDEPENDENT_APPROVAL",
      },
      actor,
    );
    await confirmExternalPaymentAttempt(
      {
        attemptId: attempt.attemptId,
        branchId: 1,
        channel: "SALES_COLLECTION",
        deviceId,
        verificationPolicy: "INDEPENDENT_APPROVAL",
        businessBinding: { type: "INSTALLMENT_LINE", id: p.lines[0].id },
      },
      owner,
    );
    const request = {
      lineId: p.lines[0].id,
      clientRequestId: crypto.randomUUID(),
      paymentMethod: "TRANSFER" as const,
      externalPaymentAttemptId: attempt.attemptId,
      deviceId,
      referenceNumber: "A04-PARTIAL-TRANSFER",
    };
    const paid = await payLine(request, owner);
    expect(await payLine(request, owner)).toEqual(paid);
    expect((await getPlan(p.id)).lines[0].remainingAmount).toBe("0.00");
    expect(
      (await db().select().from(s.receipts)).map((r) => r.amount).sort(),
    ).toEqual(["10000.00", "40000.00"]);
  });
  it("competing ordinary receipt and native selected collection cannot overpay one 50k plan", async () => {
    await db()
      .update(s.invoices)
      .set({ total: "50000.00", subtotal: "50000.00" })
      .where(eq(s.invoices.id, 1));
    await db()
      .update(s.customers)
      .set({ currentBalance: "50000.00" })
      .where(eq(s.customers.id, 1));
    const { planId } = await createPlan(
      {
        clientRequestId: crypto.randomUUID(),
        customerId: 1,
        branchId: 1,
        invoiceId: 1,
        totalAmount: "50000.00",
        lines: [{ amount: "50000.00", dueDate: "2026-11-01", kind: "CASH" }],
      },
      actor,
    );
    const p = await getPlan(planId);
    const results = await Promise.allSettled([
      collect("10000.00"),
      payLine(
        { lineId: p.lines[0].id, clientRequestId: crypto.randomUUID() },
        actor,
      ),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const current = await getPlan(planId);
    expect(current.lines[0].paidAmount).toBe("50000.00");
    expect(current.reconciliationRequired).toBe(false);
    const receiptTotal = (await db().select().from(s.receipts)).reduce(
      (sum, receipt) => sum.plus(receipt.amount),
      money(0),
    );
    expect(receiptTotal.toFixed(2)).toBe("50000.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "0.00",
    );
  });
  it("old RR snapshot waits on invoice then reads the committed current head, not stale SUM", async () => {
    const p = await plan();
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    };
    const snapshotRead = deferred(),
      writerHeld = deferred(),
      release = deferred();
    let readerId = 0;
    const reader = withTx(async (tx) => {
      const [ids] = (await tx.execute(
        sql`SELECT CONNECTION_ID() AS id`,
      )) as unknown as [{ id: number }[]];
      readerId = ids[0].id;
      expect(
        await tx.select().from(s.installmentReceiptAllocations),
      ).toHaveLength(0);
      snapshotRead.resolve();
      await writerHeld.promise;
      await tx
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, 1))
        .for("update");
      const state = await lockInstallmentPlanTx(tx, p.id);
      expect(state!.lines[0].paid.toFixed(2)).toBe("10000.00");
      expect(state!.lines[0].remaining.toFixed(2)).toBe("40000.00");
      expect(
        await tx.select().from(s.installmentReceiptAllocations),
      ).toHaveLength(0); // old consistent snapshot really exists
    });
    await snapshotRead.promise;
    const writer = withTx(async (tx) => {
      await createVoucherTx(
        tx,
        {
          voucherType: "RECEIPT",
          branchId: 1,
          invoiceId: 1,
          partyType: "CUSTOMER",
          partyId: 1,
          amount: "10000.00",
          paymentMethod: "CASH",
          description: "Current read barrier",
          clientRequestId: crypto.randomUUID(),
        },
        actor,
      );
      writerHeld.resolve();
      await release.promise;
    });
    try {
      await writerHeld.promise;
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const [rows] = await getPool().query(
          "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?",
          [readerId],
        );
        if (Number((rows as { n: number }[])[0].n) > 0) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([reader, writer]);
    }
  });
  it("holding an existing allocation chain does not block unrelated FIRST allocation", async () => {
    const p = await plan();
    await collect("10000.00");
    await db()
      .insert(s.customers)
      .values({ id: 2, name: "Unrelated", currentBalance: "100000.00" });
    await db().insert(s.invoices).values({
      id: 2,
      invoiceNumber: "UNRELATED-2",
      branchId: 1,
      customerId: 2,
      sourceType: "POS",
      subtotal: "100000.00",
      total: "100000.00",
      paidAmount: "0.00",
      status: "PENDING",
    });
    await createPlan(
      {
        clientRequestId: crypto.randomUUID(),
        customerId: 2,
        invoiceId: 2,
        branchId: 1,
        totalAmount: "100000.00",
        lines: [{ dueDate: "2026-11-01", amount: "100000.00", kind: "CASH" }],
      },
      actor,
    );
    await withTx(async (tx) => {
      await tx
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, 1))
        .for("update");
      await lockInstallmentPlanTx(tx, p.id);
      const unrelated = await withTx(async (other) => {
        await other.execute(sql`SET SESSION innodb_lock_wait_timeout=3`);
        return createVoucherTx(
          other,
          {
            voucherType: "RECEIPT",
            branchId: 1,
            invoiceId: 2,
            partyType: "CUSTOMER",
            partyId: 2,
            amount: "1000.00",
            paymentMethod: "TRANSFER",
            referenceNumber: "REAL-TRANSFER-2",
            description: "Unrelated first",
            clientRequestId: crypto.randomUUID(),
          },
          actor,
        );
      });
      expect(unrelated.receiptId).toBeGreaterThan(0);
    });
    expect(
      (await db().select().from(s.installmentReceiptAllocations)).filter(
        (r) => r.invoiceId === 2,
      ),
    ).toHaveLength(1);
  });
  it("native mixed cash/confirmed transfer legs each allocate exactly their actual receipt", async () => {
    const p = await plan();
    await db().insert(s.shifts).values({
      id: 1,
      userId: 1,
      branchId: 1,
      status: "OPEN",
      openedAt: new Date(),
      openGuard: "1:1",
      openingBalance: "0",
    });
    const deviceId = "A04-MIXED";
    const attempt = await initiateExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "SALES_COLLECTION",
        method: "TRANSFER",
        amount: "20000.00",
        reference: "ACTUAL-MIXED-TRANSFER",
        requestId: crypto.randomUUID(),
        deviceId,
      },
      actor,
    );
    await confirmExternalPaymentAttempt(
      {
        attemptId: attempt.attemptId,
        branchId: 1,
        channel: "SALES_COLLECTION",
        deviceId,
      },
      actor,
    );
    await processPayment(
      {
        invoiceId: 1,
        shiftId: 1,
        clientRequestId: crypto.randomUUID(),
        payments: [
          { amount: "10000.00", method: "CASH" },
          {
            amount: "20000.00",
            method: "TRANSFER",
            reference: "ACTUAL-MIXED-TRANSFER",
            externalPaymentAttemptId: attempt.attemptId,
            externalPaymentDeviceId: deviceId,
          },
        ],
      },
      actor,
    );
    expect((await getPlan(p.id)).lines[0].remainingAmount).toBe("20000.00");
    expect(
      (await db().select().from(s.installmentReceiptAllocations))
        .map((r) => r.amount)
        .sort(),
    ).toEqual(["10000.00", "20000.00"]);
    const nonCash = (await db().select().from(s.receipts)).find(
      (r) => r.paymentMethod === "TRANSFER",
    )!;
    expect(nonCash.cashBucket).toBeNull();
    expect(nonCash.shiftId).toBeNull();
  });
});
