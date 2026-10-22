import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
import {
  adoptCustomerReceiptHistory,
  previewCustomerReceiptHistory,
} from "../customerReceiptHistory";
import { money } from "../money";
import {
  loadRefundCaps,
  loadRefundCapsByInvoiceIds,
} from "../returns/refundCaps";
import { withTx } from "../tx";
import { approveVoucher, cancelVoucher } from "../voucherService";

const db = () => getDb()!;
const owner = { userId: 2, branchId: 1, role: "manager" as const };
const createdAt = new Date("2026-10-01T10:00:00Z");
const openingCash = "60.00";

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "history-refund-maker",
        role: "admin",
        branchId: 1,
        isOwner: false,
      },
      {
        id: 2,
        openId: "history-refund-owner",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.customers)
    .values({
      id: 1,
      name: "History refund customer",
      currentBalance: "0.00",
      creditLimit: "9999999.00",
    });
  // Independent opening cash lets reversal reach the refund dependency guard:
  // its rejection must not be caused by an insufficient drawer balance.
  await db()
    .insert(s.shifts)
    .values({
      id: 1,
      userId: 1,
      branchId: 1,
      status: "OPEN",
      openGuard: "1:1",
      openingBalance: openingCash,
    });
  await db().insert(s.invoices).values({
    id: 1,
    invoiceNumber: "HISTORY-REFUNDED-1",
    sourceType: "ORDER",
    sourceId: "history-refund-1",
    branchId: 1,
    customerId: 1,
    invoiceDate: createdAt,
    subtotal: "100.00",
    total: "100.00",
    returnedTotal: "60.00",
    paidAmount: "40.00",
    paymentMethod: "CASH",
    status: "PAID",
  });
  await db()
    .insert(s.receipts)
    .values([
      {
        id: 1001,
        branchId: 1,
        shiftId: 1,
        direction: "IN",
        amount: "100.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        partyType: "CUSTOMER",
        partyId: 1,
        invoiceId: null,
        voucherNumber: "RV-1-HISTORY-REFUND",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        createdBy: 1,
        createdAt,
      },
      {
        id: 1002,
        branchId: 1,
        shiftId: 1,
        direction: "OUT",
        amount: "60.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        partyType: "CUSTOMER",
        partyId: 1,
        invoiceId: 1,
        voucherNumber: "PV-1-HISTORY-REFUND",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        createdBy: 1,
        createdAt,
      },
    ]);
  await db()
    .insert(s.accountingEntries)
    .values([
      {
        entryType: "SALE",
        amount: "100.00",
        branchId: 1,
        customerId: 1,
        invoiceId: 1,
        entryDate: createdAt,
        createdAt,
      },
      {
        entryType: "RETURN",
        amount: "-60.00",
        branchId: 1,
        customerId: 1,
        invoiceId: 1,
        entryDate: createdAt,
        createdAt,
      },
      {
        entryType: "PAYMENT_IN",
        amount: "100.00",
        branchId: 1,
        customerId: 1,
        receiptId: 1001,
        entryDate: createdAt,
        createdAt,
      },
      {
        entryType: "PAYMENT_OUT",
        amount: "60.00",
        branchId: 1,
        customerId: 1,
        invoiceId: 1,
        receiptId: 1002,
        entryDate: createdAt,
        createdAt,
      },
    ]);
});

async function financialState() {
  const invoice = (
    await db().select().from(s.invoices).where(eq(s.invoices.id, 1))
  )[0];
  const customer = (
    await db().select().from(s.customers).where(eq(s.customers.id, 1))
  )[0];
  const entries = await db()
    .select()
    .from(s.accountingEntries)
    .orderBy(s.accountingEntries.id);
  const ledgerAr = entries
    .reduce(
      (balance, entry) =>
        entry.entryType === "PAYMENT_IN"
          ? balance.minus(entry.amount)
          : balance.plus(entry.amount),
      money(0),
    )
    .toFixed(2);
  const drawer = await withTx((tx) =>
    computeDrawerCashBalance(tx, 1, openingCash),
  );
  return {
    paid: invoice.paidAmount,
    status: invoice.status,
    returned: invoice.returnedTotal,
    ar: customer.currentBalance,
    ledgerAr,
    drawer: drawer.toFixed(2),
    receiptCash: drawer.minus(openingCash).toFixed(2),
  };
}
async function moneySnapshot() {
  return {
    invoices: await db().select().from(s.invoices).orderBy(s.invoices.id),
    customers: await db().select().from(s.customers).orderBy(s.customers.id),
    receipts: await db().select().from(s.receipts).orderBy(s.receipts.id),
    ledger: await db()
      .select()
      .from(s.accountingEntries)
      .orderBy(s.accountingEntries.id),
  };
}
async function allSnapshot() {
  return {
    ...(await moneySnapshot()),
    headers: await db()
      .select()
      .from(s.customerReceiptSettlements)
      .orderBy(s.customerReceiptSettlements.id),
    allocations: await db()
      .select()
      .from(s.customerReceiptAllocations)
      .orderBy(s.customerReceiptAllocations.id),
  };
}
async function assertPool(amount: string) {
  const single = await loadRefundCaps(db(), 1);
  const batch = (await loadRefundCapsByInvoiceIds(db(), [1])).get(1)!;
  for (const caps of [single, batch]) expect(caps.pool.toFixed(2)).toBe(amount);
}

describe("historical customer receipt after an actual invoice refund", () => {
  it("adopts gross historical funding through a prior refund and reverses OUT before IN exactly once", async () => {
    expect(await financialState()).toEqual({
      paid: "40.00",
      status: "PAID",
      returned: "60.00",
      ar: "0.00",
      ledgerAr: "0.00",
      drawer: "100.00",
      receiptCash: "40.00",
    });
    expect((await loadRefundCaps(db(), 1)).nonCourierNet?.toFixed(2)).toBe(
      "-60.00",
    );
    const before = await moneySnapshot();
    const preview = await previewCustomerReceiptHistory({
      receiptIds: [1001],
      cutoffUtc: "2026-10-21T09:26:51.000Z",
    });
    expect(preview.totals).toMatchObject({
      existingPaidLinked: "100.00",
      newInvoiceAllocation: "0.00",
      accountAmount: "0.00",
      unallocatedAmount: "0.00",
      newCash: "0.00",
      newLedgerEntries: 0,
      newCustomerBalanceEffect: "0.00",
    });
    expect(preview.sources[0].allocations).toEqual([
      { invoiceId: 1, amount: "100.00", applyAmount: "0.00" },
    ]);
    expect(await moneySnapshot()).toEqual(before);
    const input = {
      ...preview.input,
      evidenceHash: preview.evidenceHash,
      batchKey: "history-prior-refund",
    };
    expect((await adoptCustomerReceiptHistory(input, owner)).mode).toBe(
      "APPLIED",
    );
    expect(await moneySnapshot()).toEqual(before);
    expect(
      (await db().select().from(s.customerReceiptAllocations))[0],
    ).toMatchObject({
      invoiceId: 1,
      originalInvoiceId: 1,
      amount: "100.00",
      originalAmount: "100.00",
    });
    await assertPool("40.00");
    const adopted = await allSnapshot();
    expect((await adoptCustomerReceiptHistory(input, owner)).mode).toBe(
      "REPLAY_VERIFIED",
    );
    expect(await allSnapshot()).toEqual(adopted);

    await expect(cancelVoucher(1001, owner)).rejects.toThrow(
      /رد منفذ|مستند الرد/,
    );
    expect(await allSnapshot()).toEqual(adopted);
    await assertPool("40.00");

    const refundInverse = await cancelVoucher(1002, owner);
    expect(refundInverse.status).toBe("REVERSED");
    expect(await financialState()).toEqual({
      paid: "100.00",
      status: "PAID",
      returned: "60.00",
      ar: "-60.00",
      ledgerAr: "-60.00",
      drawer: "160.00",
      receiptCash: "100.00",
    });
    await assertPool("100.00");
    const afterRefundInverse = await allSnapshot();
    await approveVoucher(Number(refundInverse.approvalReceiptId), owner);
    await expect(cancelVoucher(1002, owner)).rejects.toThrow(/ملغى بالفعل/);
    expect(await allSnapshot()).toEqual(afterRefundInverse);

    const receiptInverse = await cancelVoucher(1001, owner);
    expect(receiptInverse.status).toBe("REVERSED");
    expect(await financialState()).toEqual({
      paid: "0.00",
      status: "PENDING",
      returned: "60.00",
      ar: "40.00",
      ledgerAr: "40.00",
      drawer: "60.00",
      receiptCash: "0.00",
    });
    await assertPool("0.00");
    const final = await allSnapshot();
    expect(final.receipts).toHaveLength(4);
    expect(final.ledger).toHaveLength(6);
    expect(final.receipts.find((row) => row.id === 1001)).toMatchObject({
      invoiceId: null,
      amount: "100.00",
      status: "REVERSED",
    });
    expect(final.headers[0].reversalReceiptId).toBe(
      receiptInverse.approvalReceiptId,
    );
    expect(final.allocations[0]).toMatchObject({
      amount: "100.00",
      originalAmount: "100.00",
    });
    await approveVoucher(Number(receiptInverse.approvalReceiptId), owner);
    await expect(cancelVoucher(1001, owner)).rejects.toThrow(/ملغى بالفعل/);
    expect((await adoptCustomerReceiptHistory(input, owner)).mode).toBe(
      "REPLAY_VERIFIED",
    );
    expect(await allSnapshot()).toEqual(final);
  });
});
