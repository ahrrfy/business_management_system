import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money } from "../money";
import { correctSale, createSale, processPayment } from "../saleService";
import { returnSale } from "../returnService";
import {
  loadRefundCaps,
  loadRefundCapsByInvoiceIds,
} from "../returns/refundCaps";
import { loadCustomerReceiptInvoicePayments } from "../customerReceiptProjection";
import { getCustomerStatement } from "../reports/arAging";
import { autoSettleCustomerAccountTx } from "../reconciliation/autoSettlementService";
import { withGovernanceTx } from "../tx";
import { createVoucherTx } from "../voucher/create";
import {
  approveVoucher,
  cancelVoucher,
  createVoucher,
} from "../voucherService";

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const owner = { userId: 2, branchId: 1, role: "manager" as const };
const db = () => getDb()!;

beforeEach(async () => {
  // The shared test setup clears every table, including allocation children.
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "SECOND", code: "SECOND", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "receipt-maker",
        name: "Maker",
        role: "admin",
        branchId: 1,
        isOwner: false,
      },
      {
        id: 2,
        openId: "receipt-owner",
        name: "Owner",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.customers)
    .values([
      {
        id: 1,
        name: "Customer",
        currentBalance: "0",
        creditLimit: "9999999.00",
      },
      {
        id: 2,
        name: "Other customer",
        currentBalance: "0",
        creditLimit: "9999999.00",
      },
    ]);
  await db().insert(s.products).values({ id: 1, name: "Notebook" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "RECEIPT-FIFO", costPrice: "600.00" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "Piece",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 100 },
      { variantId: 1, branchId: 2, quantity: 100 },
    ]);
  await db().insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    status: "OPEN",
    openedAt: new Date(),
    openGuard: "1:1",
    openingBalance: "0",
  });
});

async function sale(quantity = 1, branchId = 1, customerId = 1) {
  const result = await createSale(
    {
      branchId,
      customerId,
      priceTier: "RETAIL",
      sourceType: "ORDER",
      lines: [{ variantId: 1, productUnitId: 1, quantity: String(quantity) }],
    },
    admin,
  );
  expect(result.status).toBe((await invoice(result.invoiceId)).status);
  return result.invoiceId;
}

function receiptInput(amount: string, clientRequestId: string) {
  return {
    voucherType: "RECEIPT" as const,
    branchId: 1,
    amount,
    paymentMethod: "CASH" as const,
    partyType: "CUSTOMER" as const,
    partyId: 1,
    invoiceId: null,
    description: "دفعة على حساب العميل",
    clientRequestId,
  };
}
const receive = (amount: string, key: string) =>
  createVoucher(receiptInput(amount, key), admin);
const nativePay = (invoiceId: number, amount: string, key: string) =>
  processPayment(
    {
      invoiceId,
      amount,
      method: "CASH",
      shiftId: 1,
      clientRequestId: key,
    },
    admin,
  );

async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
async function balance() {
  return (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0]
    .currentBalance;
}
async function settlement(receiptId: number) {
  const [header] = await db()
    .select()
    .from(s.customerReceiptSettlements)
    .where(eq(s.customerReceiptSettlements.receiptId, receiptId));
  expect(header).toBeTruthy();
  const allocations = await db()
    .select()
    .from(s.customerReceiptAllocations)
    .where(eq(s.customerReceiptAllocations.settlementId, header.id))
    .orderBy(s.customerReceiptAllocations.id);
  return { header, allocations };
}
async function cashNet() {
  const rows = await db().select().from(s.receipts);
  return rows
    .filter(
      (r) =>
        r.paymentMethod === "CASH" &&
        r.approvalStatus === "APPROVED" &&
        (r.status === "COMPLETED" || r.status === "REVERSED"),
    )
    .reduce(
      (sum, r) =>
        sum.plus(
          r.direction === "IN" ? money(r.amount) : money(r.amount).negated(),
        ),
      money(0),
    )
    .toFixed(2);
}
async function snapshot() {
  return {
    invoices: await db().select().from(s.invoices).orderBy(s.invoices.id),
    customers: await db().select().from(s.customers).orderBy(s.customers.id),
    receipts: await db().select().from(s.receipts).orderBy(s.receipts.id),
    entries: await db()
      .select()
      .from(s.accountingEntries)
      .orderBy(s.accountingEntries.id),
    settlements: await db()
      .select()
      .from(s.customerReceiptSettlements)
      .orderBy(s.customerReceiptSettlements.id),
    allocations: await db()
      .select()
      .from(s.customerReceiptAllocations)
      .orderBy(s.customerReceiptAllocations.id),
    creditUses: await db()
      .select()
      .from(s.customerReceiptCreditUses)
      .orderBy(s.customerReceiptCreditUses.id),
    keys: await db().select().from(s.idempotencyKeys),
  };
}

async function activeDelivery(
  invoiceId: number,
  status: "DISPATCHED" | "PARTIAL",
  parcelStatus: "ASSIGNED" | "DELIVERED",
) {
  const inv = await invoice(invoiceId);
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "COD carrier",
    partyType: "COMPANY",
    branchId: 1,
    currentBalance: "0",
    defaultFee: "0",
  });
  const [inserted] = await db()
    .insert(s.deliveryConsignments)
    .values({
      consignmentNumber: `CN-RECEIPT-${invoiceId}`,
      branchId: 1,
      partyId: 1,
      invoiceId,
      sourceType: "INVOICE",
      sourceId: invoiceId,
      endCustomerId: 1,
      codAmount: money(inv.total)
        .minus(inv.returnedTotal)
        .minus(inv.paidAmount)
        .toFixed(2),
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      status,
      parcelStatus,
      moneyStatus: status === "PARTIAL" ? "PARTIAL" : "UNSETTLED",
      dispatchedBy: 1,
    });
  return Number(inserted.insertId);
}

async function deliverySnapshot() {
  return {
    consignments: await db()
      .select()
      .from(s.deliveryConsignments)
      .orderBy(s.deliveryConsignments.id),
    parties: await db()
      .select()
      .from(s.deliveryParties)
      .orderBy(s.deliveryParties.id),
    events: await db()
      .select()
      .from(s.deliveryEvents)
      .orderBy(s.deliveryEvents.id),
    ledger: await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .orderBy(s.deliveryLedgerEntries.id),
  };
}

describe("generic customer receipts allocate FIFO atomically", () => {
  it("rejects cancelling a FIFO deposit after dispatch without changing the invoice or carrier COD snapshot", async () => {
    const cod = await sale(2);
    const deposit = await receive("1000.00", "fifo-deposit-before-dispatch");
    await activeDelivery(cod, "DISPATCHED", "ASSIGNED");
    expect((await invoice(cod)).paidAmount).toBe("1000.00");
    expect((await deliverySnapshot()).consignments[0].codAmount).toBe(
      "1000.00",
    );
    const cancellation = await cancelVoucher(deposit.receiptId, admin);
    expect(cancellation.status).toBe("PENDING_APPROVAL");
    const before = await snapshot();
    const deliveryBefore = await deliverySnapshot();
    await expect(
      approveVoucher(Number(cancellation.approvalReceiptId), owner),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await deliverySnapshot()).toEqual(deliveryBefore);
    expect(await invoice(cod)).toMatchObject({
      paidAmount: "1000.00",
      status: "PARTIALLY_PAID",
    });
    expect(await balance()).toBe("1000.00");
    expect(await cashNet()).toBe("1000.00");
    expect(
      (await settlement(deposit.receiptId)).header.reversalReceiptId,
    ).toBeNull();
  });

  it.each([
    ["DISPATCHED", "ASSIGNED"],
    ["PARTIAL", "DELIVERED"],
  ] as const)(
    "skips active COD %s/%s without hiding its debt as account allocation or touching delivery",
    async (status, parcel) => {
      const cod = await sale();
      await activeDelivery(cod, status, parcel);
      const ordinary = await sale();
      const deliveryBefore = await deliverySnapshot();
      const receipt = await receive("1500.00", `cod-skip-${status}`);
      expect((await invoice(cod)).paidAmount).toBe("0.00");
      expect(await invoice(ordinary)).toMatchObject({
        paidAmount: "1000.00",
        status: "PAID",
      });
      const source = await settlement(receipt.receiptId);
      expect(source.header).toMatchObject({
        accountAmount: "0.00",
        unallocatedAmount: "500.00",
      });
      expect(source.allocations.map((a) => [a.invoiceId, a.amount])).toEqual([
        [ordinary, "1000.00"],
      ]);
      expect(await deliverySnapshot()).toEqual(deliveryBefore);
      const cancellation = await cancelVoucher(receipt.receiptId, admin);
      await approveVoucher(Number(cancellation.approvalReceiptId), owner);
      expect((await invoice(cod)).paidAmount).toBe("0.00");
      expect((await invoice(ordinary)).paidAmount).toBe("0.00");
      expect(await balance()).toBe("2000.00");
      expect(await cashNet()).toBe("0.00");
      expect(await deliverySnapshot()).toEqual(deliveryBefore);
    },
  );

  it("does not invent customer collection from SETTLED status when the courier collected amount is zero", async () => {
    const id = await sale();
    const cnId = await activeDelivery(id, "DISPATCHED", "DELIVERED");
    await db()
      .update(s.deliveryConsignments)
      .set({ status: "DELIVERED", moneyStatus: "SETTLED" })
      .where(eq(s.deliveryConsignments.id, cnId));
    const before = await snapshot();
    const deliveryBefore = await deliverySnapshot();
    await withGovernanceTx((tx) => autoSettleCustomerAccountTx(tx, 1, admin));
    expect(await snapshot()).toEqual(before);
    expect(await deliverySnapshot()).toEqual(deliveryBefore);
    expect(await invoice(id)).toMatchObject({
      paidAmount: "0.00",
      status: "PENDING",
    });
    expect(await balance()).toBe("1000.00");
  });

  it("keeps tracked credit away from active COD through legacy reconciliation, then applies it after the carrier obligation is finalized", async () => {
    const cod = await sale();
    const consignmentId = await activeDelivery(cod, "PARTIAL", "DELIVERED");
    const receipt = await receive("1500.00", "cod-prepaid-credit");
    const before = await snapshot();
    const deliveryBefore = await deliverySnapshot();
    await withGovernanceTx((tx) => autoSettleCustomerAccountTx(tx, 1, admin));
    expect(await snapshot()).toEqual(before);
    expect(await deliverySnapshot()).toEqual(deliveryBefore);
    expect((await settlement(receipt.receiptId)).header).toMatchObject({
      accountAmount: "0.00",
      unallocatedAmount: "1500.00",
    });
    // Fixture for completed delivery with no remaining carrier obligation: the
    // invoice's unpaid 1000 remains customer debt. No collection is fabricated.
    await db()
      .update(s.deliveryConsignments)
      .set({
        status: "DELIVERED",
        parcelStatus: "DELIVERED",
        moneyStatus: "SETTLED",
        codAmount: "0.00",
        settledAt: new Date(),
      })
      .where(eq(s.deliveryConsignments.id, consignmentId));
    const deliveryFinal = await deliverySnapshot();
    const receiptsBefore = await db()
      .select()
      .from(s.receipts)
      .orderBy(s.receipts.id);
    const entriesBefore = await db()
      .select()
      .from(s.accountingEntries)
      .orderBy(s.accountingEntries.id);
    await withGovernanceTx((tx) => autoSettleCustomerAccountTx(tx, 1, admin));
    expect(await invoice(cod)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    expect((await settlement(receipt.receiptId)).header.unallocatedAmount).toBe(
      "500.00",
    );
    expect(await db().select().from(s.receipts).orderBy(s.receipts.id)).toEqual(
      receiptsBefore,
    );
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .orderBy(s.accountingEntries.id),
    ).toEqual(entriesBefore);
    expect(await deliverySnapshot()).toEqual(deliveryFinal);
    expect(await cashNet()).toBe("1500.00");
    expect(await balance()).toBe("-500.00");
  });

  it("rejects linked IN and OUT while COD remains active, then permits the inverse after native unassignment", async () => {
    const cod = await sale();
    const original = await createVoucher(
      { ...receiptInput("500.00", "linked-before-cod"), invoiceId: cod },
      admin,
    );
    const consignmentId = await activeDelivery(cod, "PARTIAL", "DELIVERED");
    const deliveryBefore = await deliverySnapshot();
    const before = await snapshot();
    await expect(
      createVoucher(
        { ...receiptInput("500.00", "linked-active-cod"), invoiceId: cod },
        admin,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const cancellation = await cancelVoucher(original.receiptId, admin);
    const beforeRejectedApproval = await snapshot();
    await expect(
      approveVoucher(Number(cancellation.approvalReceiptId), owner),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(beforeRejectedApproval);
    expect(await deliverySnapshot()).toEqual(deliveryBefore);
    // Existing assignment released by its native workflow; this fixture change
    // adds no collection, refund or accounting entry.
    await db()
      .update(s.deliveryConsignments)
      .set({
        status: "CANCELLED",
        moneyStatus: "SETTLED",
        parcelStatus: "CANCELLED",
      })
      .where(eq(s.deliveryConsignments.id, consignmentId));
    const deliveryUnassigned = await deliverySnapshot();
    await approveVoucher(Number(cancellation.approvalReceiptId), owner);
    expect((await invoice(cod)).paidAmount).toBe("0.00");
    expect(await balance()).toBe("1000.00");
    expect(await cashNet()).toBe("0.00");
    expect(await deliverySnapshot()).toEqual(deliveryUnassigned);
  });

  it("serializes competing receipts without over-allocation and retains their exact excess as credit", async () => {
    const first = await sale();
    const second = await sale();
    const results = await Promise.all([
      receive("1500.00", "competing-receipt-a"),
      receive("1000.00", "competing-receipt-b"),
    ]);
    expect(new Set(results.map((r) => r.receiptId)).size).toBe(2);
    expect(await invoice(first)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    expect(await invoice(second)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    const sources = await Promise.all(
      results.map((r) => settlement(r.receiptId)),
    );
    const allocated = sources.flatMap((source) => source.allocations);
    for (const id of [first, second]) {
      expect(
        allocated
          .filter((a) => a.invoiceId === id)
          .reduce((sum, a) => sum.plus(a.amount), money(0))
          .toFixed(2),
      ).toBe("1000.00");
    }
    expect(
      sources
        .reduce(
          (sum, source) => sum.plus(source.header.unallocatedAmount),
          money(0),
        )
        .toFixed(2),
    ).toBe("500.00");
    expect(await balance()).toBe("-500.00");
    expect(await cashNet()).toBe("2500.00");
    expect(await db().select().from(s.receipts)).toHaveLength(2);
  });

  it("reverses an actual bound refund after a return without reviving the terminal invoice", async () => {
    const id = await sale();
    await createVoucher(
      { ...receiptInput("1000.00", "bound-paid"), invoiceId: id },
      admin,
    );
    const refund = await createVoucher(
      {
        ...receiptInput("400.00", "bound-refund"),
        voucherType: "PAYMENT",
        invoiceId: id,
      },
      admin,
    );
    await approveVoucher(refund.receiptId, owner, {
      cashSource: { mode: "DRAWER", shiftId: 1 },
    });
    const [item] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, id));
    await returnSale(
      {
        invoiceId: id,
        lines: [{ invoiceItemId: item.id, baseQuantity: 1 }],
        refund: null,
        restock: true,
        clientRequestId: "return-before-refund-inverse",
      },
      admin,
    );
    expect((await invoice(id)).status).toBe("RETURNED");
    const inverse = await cancelVoucher(refund.receiptId, admin);
    await approveVoucher(Number(inverse.approvalReceiptId), owner);
    expect(await invoice(id)).toMatchObject({
      status: "RETURNED",
      paidAmount: "1000.00",
    });
    expect(await balance()).toBe("-1000.00");
    expect(await cashNet()).toBe("1000.00");
    expect((await loadRefundCaps(db(), id)).pool.toFixed(2)).toBe("1000.00");
  });

  it("uses a proven advance on a future invoice without creating another receipt or cash entry", async () => {
    const advance = await receive("2000.00", "future-advance");
    expect((await settlement(advance.receiptId)).header.unallocatedAmount).toBe(
      "2000.00",
    );
    const id = await sale();
    expect(await invoice(id)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    const applied = await settlement(advance.receiptId);
    expect(applied.header.unallocatedAmount).toBe("1000.00");
    expect(applied.allocations.map((a) => [a.invoiceId, a.amount])).toEqual([
      [id, "1000.00"],
    ]);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(await balance()).toBe("-1000.00");
    expect(await cashNet()).toBe("2000.00");
  });

  it("consumes refunded advance credit, restores it on refund reversal, and prevents cancelling spent credit twice", async () => {
    const advance = await receive("2000.00", "advance-refund");
    const id = await sale();
    const refund = await createVoucher(
      { ...receiptInput("1000.00", "refund-advance"), voucherType: "PAYMENT" },
      admin,
    );
    expect(refund.approvalStatus).toBe("PENDING_APPROVAL");
    await approveVoucher(refund.receiptId, owner, {
      cashSource: { mode: "DRAWER", shiftId: 1 },
    });
    expect((await settlement(advance.receiptId)).header).toMatchObject({
      unallocatedAmount: "0.00",
      refundedAmount: "1000.00",
    });
    expect(await balance()).toBe("0.00");
    const originalCancellation = await cancelVoucher(advance.receiptId, admin);
    const beforeRejectedApproval = await snapshot();
    await expect(
      approveVoucher(Number(originalCancellation.approvalReceiptId), owner),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(beforeRejectedApproval);

    const refundCancellation = await cancelVoucher(refund.receiptId, admin);
    await approveVoucher(Number(refundCancellation.approvalReceiptId), owner);
    expect((await settlement(advance.receiptId)).header).toMatchObject({
      unallocatedAmount: "1000.00",
      refundedAmount: "0.00",
    });
    expect(await balance()).toBe("-1000.00");
    expect((await invoice(id)).paidAmount).toBe("1000.00");
    await approveVoucher(Number(originalCancellation.approvalReceiptId), owner);
    expect((await invoice(id)).paidAmount).toBe("0.00");
    expect(await balance()).toBe("1000.00");
    expect(await cashNet()).toBe("0.00");
  });

  it("projects each invoice's real portion and original cash rail while the customer statement counts the source once", async () => {
    const first = await sale();
    const second = await sale();
    const result = await receive("1500.00", "projection-portions");
    const batch = await loadRefundCapsByInvoiceIds(db(), [first, second]);
    for (const [id, expected] of [
      [first, "1000.00"],
      [second, "500.00"],
    ] as const) {
      const single = await loadRefundCaps(db(), id);
      for (const caps of [single, batch.get(id)!]) {
        expect(caps.pool.toFixed(2)).toBe(expected);
        expect(caps.grossIn.toFixed(2)).toBe(expected);
        expect(caps.netByMethod.get("CASH")?.toFixed(2)).toBe(expected);
        expect(caps.netByMethod.get("CARD")?.toFixed(2)).toBe("0.00");
        expect(caps.cashReceiptShiftIds).toEqual([1]);
        expect(caps.cashNetByShift.get(1)?.toFixed(2)).toBe(expected);
      }
      expect(await loadCustomerReceiptInvoicePayments(db(), id)).toEqual([
        expect.objectContaining({
          id: result.receiptId,
          amount: expected,
          sourceAmount: "1500.00",
          direction: "IN",
          paymentMethod: "CASH",
          isAllocated: true,
        }),
      ]);
    }
    const statement = await getCustomerStatement(1);
    expect(
      statement?.payments.filter((p) => p.id === result.receiptId),
    ).toHaveLength(1);
    expect(
      statement?.payments.find((p) => p.id === result.receiptId)?.amount,
    ).toBe("1500.00");
    expect(statement?.summary.currentBalance).toBe("500.00");
    expect(statement?.summary.totalPaid).toBe("1500.00");
  });

  it("carries only the corrected invoice's portion while preserving the shared original receipt and the other invoice", async () => {
    const first = await sale(2);
    const second = await sale();
    const result = await receive("2500.00", "correction-shared-source");
    const [sourceBefore] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, result.receiptId));
    const otherBefore = await invoice(second);
    const corrected = await correctSale(
      {
        originalInvoiceId: first,
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        clientRequestId: "correct-shared-source",
      },
      admin,
    );
    expect((await invoice(first)).status).toBe("SUPERSEDED");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      paidAmount: "2000.00",
      status: "PAID",
    });
    expect(await invoice(second)).toEqual(otherBefore);
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, result.receiptId))
      )[0],
    ).toEqual(sourceBefore);
    const portions = (await settlement(result.receiptId)).allocations;
    expect(portions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invoiceId: corrected.correctedInvoiceId,
          originalInvoiceId: first,
          amount: "2000.00",
        }),
        expect.objectContaining({ invoiceId: second, amount: "500.00" }),
      ]),
    );
    expect(await balance()).toBe("500.00");
    expect(await cashNet()).toBe("2500.00");
    const after = await snapshot();
    await correctSale(
      {
        originalInvoiceId: first,
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        clientRequestId: "correct-shared-source",
      },
      admin,
    );
    expect(await snapshot()).toEqual(after);
  });

  it("a CREDIT decrease settles the oldest existing remainder before retaining advance for a future invoice", async () => {
    const first = await sale(2);
    const second = await sale();
    const result = await receive("2500.00", "correction-release");
    const corrected = await correctSale(
      {
        originalInvoiceId: first,
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        overpayHandling: "CREDIT",
      },
      admin,
    );
    expect(corrected.overpay).toBe("1000.00");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    expect(await invoice(second)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    expect((await settlement(result.receiptId)).header.unallocatedAmount).toBe(
      "500.00",
    );
    expect(await balance()).toBe("-500.00");
    expect(await cashNet()).toBe("2500.00");
    const future = await sale();
    expect(await invoice(future)).toMatchObject({
      paidAmount: "500.00",
      status: "PARTIALLY_PAID",
    });
    expect((await settlement(result.receiptId)).header.unallocatedAmount).toBe(
      "0.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(await balance()).toBe("500.00");
  });

  it("a correction CASH_REFUND keeps the gross source portion and subtracts the real refund only once from its cap", async () => {
    const first = await sale(2);
    const second = await sale();
    const result = await receive("2500.00", "correction-cash-refund");
    const [sourceBefore] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, result.receiptId));
    const corrected = await correctSale(
      {
        originalInvoiceId: first,
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        overpayHandling: "CASH_REFUND",
        overpayRefundShiftId: 1,
      },
      admin,
    );
    expect(corrected.overpay).toBe("1000.00");
    expect(corrected.overpayHandled).toBe("CASH_REFUND");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    expect((await invoice(second)).paidAmount).toBe("500.00");
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, result.receiptId))
      )[0],
    ).toEqual(sourceBefore);
    const source = await settlement(result.receiptId);
    expect(source.header.unallocatedAmount).toBe("0.00");
    expect(
      source.allocations.find(
        (a) => a.invoiceId === corrected.correctedInvoiceId,
      )?.amount,
    ).toBe("2000.00");
    const caps = await loadRefundCaps(db(), corrected.correctedInvoiceId);
    const batch = (
      await loadRefundCapsByInvoiceIds(db(), [corrected.correctedInvoiceId])
    ).get(corrected.correctedInvoiceId)!;
    for (const cap of [caps, batch]) {
      expect(cap.grossIn.toFixed(2)).toBe("2000.00");
      expect(cap.grossOut.toFixed(2)).toBe("1000.00");
      expect(cap.pool.toFixed(2)).toBe("1000.00");
    }
    expect(await cashNet()).toBe("1500.00");
    expect(await balance()).toBe("500.00");
  });

  it("an actual returned/refunded invoice exhausts its portion and blocks reversing the shared receipt a second time", async () => {
    const first = await sale();
    const second = await sale();
    const result = await receive("1500.00", "return-shared-source");
    const [item] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, first));
    const input = {
      invoiceId: first,
      lines: [{ invoiceItemId: item.id, baseQuantity: 1 }],
      refund: { amount: "1000.00", method: "CASH" as const, shiftId: 1 },
      restock: true,
      clientRequestId: "return-shared-portion",
    };
    await returnSale(input, admin);
    expect((await loadRefundCaps(db(), first)).pool.toFixed(2)).toBe("0.00");
    expect((await loadRefundCaps(db(), second)).pool.toFixed(2)).toBe("500.00");
    expect(await cashNet()).toBe("500.00");
    const afterReturn = await snapshot();
    await returnSale(input, admin);
    expect(await snapshot()).toEqual(afterReturn);
    const request = await cancelVoucher(result.receiptId, admin);
    const beforeRejectedApproval = await snapshot();
    await expect(
      approveVoucher(Number(request.approvalReceiptId), owner),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(beforeRejectedApproval);
  });

  it("orders by invoice date before ID and partially settles the second invoice with one cash/AR effect", async () => {
    const newer = await sale(2);
    const older = await sale(1);
    await db()
      .update(s.invoices)
      .set({ invoiceDate: new Date("2026-09-02T12:00:00Z") })
      .where(eq(s.invoices.id, newer));
    await db()
      .update(s.invoices)
      .set({ invoiceDate: new Date("2026-09-01T12:00:00Z") })
      .where(eq(s.invoices.id, older));
    const result = await receive("1500.00", "fifo-date");
    expect(await invoice(older)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    expect(await invoice(newer)).toMatchObject({
      paidAmount: "500.00",
      status: "PARTIALLY_PAID",
    });
    const { header, allocations } = await settlement(result.receiptId);
    expect(header).toMatchObject({
      amount: "1500.00",
      unallocatedAmount: "0.00",
    });
    expect(allocations.map((a) => [a.invoiceId, a.amount])).toEqual([
      [older, "1000.00"],
      [newer, "500.00"],
    ]);
    expect(await balance()).toBe("1500.00");
    expect(await cashNet()).toBe("1500.00");
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, result.receiptId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "PAYMENT_IN",
      amount: "1500.00",
      customerId: 1,
    });
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, result.receiptId))
      )[0].invoiceId,
    ).toBeNull();
  });

  it("breaks equal-date ties by ID and allocates every subsequent receipt against the current remainder", async () => {
    const first = await sale();
    const second = await sale();
    await db()
      .update(s.invoices)
      .set({ invoiceDate: new Date("2026-09-01T12:00:00Z") });
    await receive("400.00", "fifo-first");
    const next = await receive("900.00", "fifo-next");
    expect(
      (await settlement(next.receiptId)).allocations.map((a) => [
        a.invoiceId,
        a.amount,
      ]),
    ).toEqual([
      [first, "600.00"],
      [second, "300.00"],
    ]);
    expect(await invoice(first)).toMatchObject({
      paidAmount: "1000.00",
      status: "PAID",
    });
    expect(await invoice(second)).toMatchObject({
      paidAmount: "300.00",
      status: "PARTIALLY_PAID",
    });
    expect(await balance()).toBe("700.00");
    expect(await cashNet()).toBe("1300.00");
  });

  it("settles both invoices fully and records excess as unallocated customer credit", async () => {
    const first = await sale();
    const second = await sale(2);
    const result = await receive("3500.00", "fifo-excess");
    const { header, allocations } = await settlement(result.receiptId);
    expect(header).toMatchObject({
      amount: "3500.00",
      unallocatedAmount: "500.00",
      initialUnallocatedAmount: "500.00",
    });
    expect(allocations.map((a) => a.amount)).toEqual(["1000.00", "2000.00"]);
    expect((await invoice(first)).status).toBe("PAID");
    expect((await invoice(second)).status).toBe("PAID");
    expect(await balance()).toBe("-500.00");
    expect(await cashNet()).toBe("3500.00");
  });

  it("replays the original allocation without paying a newly created invoice; changed amount fails closed", async () => {
    await sale();
    const original = await receive("1000.00", "fifo-replay");
    const later = await sale();
    const before = await snapshot();
    expect((await receive("1000.00", "fifo-replay")).receiptId).toBe(
      original.receiptId,
    );
    expect(await snapshot()).toEqual(before);
    await expect(receive("1100.00", "fifo-replay")).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect((await invoice(later)).paidAmount).toBe("0.00");
  });

  it("cancellation is effect-free until owner approval, then restores only this receipt's exact portions", async () => {
    const first = await sale();
    const second = await sale();
    const original = await receive("1500.00", "fifo-cancel");
    await nativePay(second, "200.00", "native-after-fifo");
    const request = await cancelVoucher(original.receiptId, admin);
    expect(request.status).toBe("PENDING_APPROVAL");
    expect((await invoice(first)).paidAmount).toBe("1000.00");
    expect((await invoice(second)).paidAmount).toBe("700.00");
    expect(await balance()).toBe("300.00");
    expect(await cashNet()).toBe("1700.00");
    const reversalId = Number(request.approvalReceiptId);
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, reversalId))
      )[0],
    ).toMatchObject({ direction: "OUT", status: "PENDING" });
    await approveVoucher(reversalId, owner);
    expect(await invoice(first)).toMatchObject({
      paidAmount: "0.00",
      status: "PENDING",
    });
    expect(await invoice(second)).toMatchObject({
      paidAmount: "200.00",
      status: "PARTIALLY_PAID",
    });
    expect(await balance()).toBe("1800.00");
    expect(await cashNet()).toBe("200.00");
    expect(
      (await settlement(original.receiptId)).header.reversalReceiptId,
    ).toBe(reversalId);
    const after = await snapshot();
    await approveVoucher(reversalId, owner);
    expect(await snapshot()).toEqual(after);
  });

  it("cancels both the allocated and excess portions without turning excess into invoice debt", async () => {
    const id = await sale();
    const original = await receive("1500.00", "cancel-excess");
    const request = await cancelVoucher(original.receiptId, admin);
    await approveVoucher(Number(request.approvalReceiptId), owner);
    expect(await invoice(id)).toMatchObject({
      paidAmount: "0.00",
      status: "PENDING",
    });
    expect(await balance()).toBe("1000.00");
    expect(await cashNet()).toBe("0.00");
  });

  it("approves a historical pending generic receipt against current remainders exactly once", async () => {
    const first = await sale();
    const second = await sale();
    const [inserted] = await db().insert(s.receipts).values({
      voucherNumber: "RV-PENDING-CUSTOMER-FIFO",
      branchId: 1,
      direction: "IN",
      amount: "1500.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "قبض تاريخي معلق للمراجعة",
      invoiceId: null,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 1,
    });
    const receiptId = Number(inserted.insertId);
    expect(await db().select().from(s.customerReceiptSettlements)).toHaveLength(
      0,
    );
    expect(await balance()).toBe("2000.00");
    await nativePay(first, "500.00", "native-before-approval");
    await approveVoucher(receiptId, owner);
    expect(
      (await settlement(receiptId)).allocations.map((a) => [
        a.invoiceId,
        a.amount,
      ]),
    ).toEqual([
      [first, "500.00"],
      [second, "1000.00"],
    ]);
    expect((await invoice(first)).status).toBe("PAID");
    expect((await invoice(second)).status).toBe("PAID");
    expect(await balance()).toBe("0.00");
    expect(await cashNet()).toBe("2000.00");
    const after = await snapshot();
    await approveVoucher(receiptId, owner);
    expect(await snapshot()).toEqual(after);
  });

  it("rolls back receipt, ledger, AR, invoice allocation and replay key when the surrounding transaction fails", async () => {
    await sale(2);
    const before = await snapshot();
    await expect(
      withGovernanceTx(async (tx) => {
        const result = await createVoucherTx(
          tx,
          receiptInput("1500.00", "fifo-rollback"),
          admin,
        );
        const rows = await tx
          .select()
          .from(s.customerReceiptSettlements)
          .where(eq(s.customerReceiptSettlements.receiptId, result.receiptId));
        expect(rows).toHaveLength(1);
        const paid = await tx.select().from(s.invoices);
        expect(paid[0].paidAmount).toBe("1500.00");
        throw new Error("injected failure after allocation");
      }),
    ).rejects.toThrow("injected failure after allocation");
    expect(await snapshot()).toEqual(before);
    await receive("1500.00", "fifo-rollback");
    expect(await balance()).toBe("500.00");
  });

  it("excludes another branch, another customer and all dead invoice states", async () => {
    const foreignBranch = await sale(1, 2);
    const foreignCustomer = await sale(1, 1, 2);
    const dead: number[] = [];
    for (const status of ["CANCELLED", "RETURNED", "SUPERSEDED"] as const) {
      const id = await sale();
      await db()
        .update(s.invoices)
        .set({ status })
        .where(eq(s.invoices.id, id));
      dead.push(id);
    }
    const active = await sale(2);
    const result = await receive("500.00", "fifo-scope");
    expect(
      (await settlement(result.receiptId)).allocations.map((a) => a.invoiceId),
    ).toEqual([active]);
    for (const id of [foreignBranch, foreignCustomer, ...dead])
      expect((await invoice(id)).paidAmount).toBe("0.00");
    expect((await invoice(active)).paidAmount).toBe("500.00");
    expect(await cashNet()).toBe("500.00");
  });

  it("the native payment path rejects duplicate or excessive collection after generic FIFO allocation", async () => {
    const full = await sale();
    const partial = await sale();
    await receive("1500.00", "fifo-native-guard");
    const before = await snapshot();
    await expect(
      nativePay(full, "1000.00", "duplicate-native"),
    ).rejects.toThrow(/مدفوعة بالكامل|لا يوجد مبلغ مستحق/);
    await expect(nativePay(partial, "501.00", "excess-native")).rejects.toThrow(
      /تتجاوز المتبقي/,
    );
    expect(await snapshot()).toEqual(before);
    await nativePay(partial, "500.00", "remaining-native");
    expect((await invoice(partial)).status).toBe("PAID");
    expect(await balance()).toBe("0.00");
    expect(await cashNet()).toBe("2000.00");
  });
});
