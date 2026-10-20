import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ledger from "../ledgerService";
import * as nativePayments from "../purchase/supplierPayments";
import * as voucherSettlement from "../voucher/supplierSettlement";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createVoucher,
  approveVoucher,
  cancelVoucher,
  rejectVoucher,
  getVoucher,
} from "../voucherService";
import {
  decideSupplierPayment,
  requestSupplierPayment,
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
  requestSupplierPaymentRefund,
  decideSupplierPaymentRefund,
  listSupplierPaymentRefundSources,
} from "../purchase/supplierPayments";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import { getSupplierStatement } from "../reports/apAging";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { withTx } from "../tx";
import { cumulativeCurrencyDelta } from "../purchase/supplierVoucherCurrency";
import { money, toDbMoney } from "../money";
import type { VoucherInput } from "../voucher/types";

const maker = { userId: 7, branchId: 1, role: "accountant" };
const owner = { userId: 9, branchId: 1, role: "manager" };
const db = () => getDb()!;
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "OTHER", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 7,
        openId: "voucher-supplier-maker",
        name: "طالب",
        role: "accountant",
        branchId: 1,
      },
      {
        id: 9,
        openId: "voucher-supplier-owner",
        name: "مالك",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "شركة المورد", currentBalance: "100000.00" });
  await db().insert(s.products).values({ id: 1, name: "صنف" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    variantName: "افتراضي",
    sku: "VOUCHER-ITEM",
  });
  for (const [id, total, date] of [
    [1, "60000.00", "2026-10-10"],
    [2, "40000.00", "2026-09-01"],
  ] as const) {
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        poNumber: `PO-${id}`,
        supplierId: 1,
        branchId: 1,
        subtotal: total,
        total,
        paidAmount: "0.00",
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
        taxAmount: "0.00",
        shippingCost: "0.00",
        customsCost: "0.00",
        invoiceDiscount: "0.00",
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        revisionReason: "فاتورة اختبار",
        createdBy: 7,
      });
    await db().insert(s.purchaseOrderRevisionItems).values({
      id,
      revisionId: id,
      lineNo: 1,
      variantId: 1,
      quantity: "1.000",
      baseQuantity: 1,
      listUnitPrice: total,
      unitPrice: total,
      lineTotal: total,
      productNameSnapshot: "صنف",
    });
    const entry = await db().insert(s.accountingEntries).values({
      entryType: "PURCHASE",
      entryDate: date,
      amount: total,
      branchId: 1,
      supplierId: 1,
      purchaseOrderId: id,
    });
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `SI-${id}`,
        clientRequestId: `invoice-${id}`,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: date,
        currency: "IQD",
        subtotal: total,
        totalAmount: total,
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        evidenceType: "OTHER",
        externalInvoiceNumber: `EXT-${id}`,
        externalNumberNorm: `EXT${id}`,
        evidenceReference: "invoice-evidence",
        createdBy: 9,
        postingEntryId: extractInsertId(entry),
        postedBy: 9,
        postedAt: new Date(),
      });
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: id,
      lineNo: 1,
      purchaseOrderRevisionItemId: id,
      variantId: 1,
      description: "بند اختبار",
      invoicedBaseQuantity: 1,
      unitPriceIqd: total,
      netAmount: total,
      totalAmount: total,
    });
  }
});

function input(amount = "50000.00"): VoucherInput {
  return {
    voucherType: "PAYMENT",
    branchId: 1,
    amount,
    paymentMethod: "TRANSFER",
    partyType: "SUPPLIER",
    partyId: 1,
    description: "تسديد فواتير المورد",
    referenceNumber: `BANK-${randomUUID()}`,
    clientRequestId: randomUUID(),
  };
}
async function state() {
  return {
    suppliers: await db().select().from(s.suppliers),
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
    invoices: await db().select().from(s.supplierInvoices),
    orders: await db().select().from(s.purchaseOrders),
    requests: await db().select().from(s.supplierPaymentRequests),
    requestAllocations: await db()
      .select()
      .from(s.supplierPaymentRequestAllocations),
    allocations: await db().select().from(s.supplierPaymentAllocations),
    payments: await db().select().from(s.supplierPayments),
  };
}
async function expectPaid(amount: string, expected: Record<number, string>) {
  const after = await state();
  expect(after.suppliers[0].currentBalance).toBe(amount);
  expect(after.receipts).toHaveLength(1);
  expect(after.receipts[0]).toMatchObject({
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "SUPPLIER",
    createdBy: 7,
    approvedBy: 9,
  });
  expect(after.receipts[0].signatureHash).toHaveLength(64);
  expect(
    after.entries.filter((row) => row.entryType === "PAYMENT_OUT"),
  ).toHaveLength(1);
  expect(after.payments).toHaveLength(1);
  expect(after.payments[0].receiptId).toBe(after.receipts[0].id);
  expect(
    Object.fromEntries(
      after.allocations.map((row) => [
        row.supplierInvoiceId,
        row.allocatedAmount,
      ]),
    ),
  ).toEqual(expected);
  const projection = await loadPurchaseSettlements(db(), after.orders);
  for (const order of after.orders)
    expect(projection.get(order.id)?.paidAmountIqd).toBe(
      expected[order.id] ?? "0.00",
    );
  const statement = await getSupplierStatement(1, { branchId: 1 });
  expect(statement?.summary.currentBalance).toBe(amount);
  expect(statement?.summary.unpaid).toBe(amount);
  expect(statement?.summary.unallocatedPayments).toBe("0.00");
  expect(
    statement?.payments.filter((row) => row.entryType === "PAYMENT_OUT"),
  ).toHaveLength(1);
  return after;
}

describe("supplier voucher native settlement", () => {
  it("reserves FIFO without money, then pays oldest fully and next partially with one receipt", async () => {
    const voucher = await createVoucher(input(), maker);
    expect(voucher.approvalStatus).toBe("PENDING_APPROVAL");
    const pending = await state();
    expect(pending.suppliers[0].currentBalance).toBe("100000.00");
    expect(pending.allocations).toHaveLength(0);
    expect(
      pending.entries.filter((row) => row.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
    expect(
      pending.requestAllocations
        .map((row) => [row.supplierInvoiceId, row.requestedAmount])
        .sort(),
    ).toEqual([
      [1, "10000.00"],
      [2, "40000.00"],
    ]);
    await approveVoucher(voucher.receiptId, owner);
    const after = await expectPaid("50000.00", {
      1: "10000.00",
      2: "40000.00",
    });
    expect(after.invoices.find((row) => row.id === 2)?.paymentGate).toBe(
      "SETTLED",
    );
    expect(after.invoices.find((row) => row.id === 1)?.paymentGate).toBe(
      "OPEN",
    );
    expect(
      (await getVoucher(voucher.receiptId))?.supplierSettlement?.allocations,
    ).toHaveLength(2);
  });
  it("settles all invoice and PO balances on a full payment", async () => {
    const voucher = await createVoucher(input("100000.00"), maker);
    await approveVoucher(voucher.receiptId, owner);
    const after = await expectPaid("0.00", { 1: "60000.00", 2: "40000.00" });
    expect(after.invoices.every((row) => row.paymentGate === "SETTLED")).toBe(
      true,
    );
  });
  it("uses the edited distribution rather than overwriting it with FIFO", async () => {
    const voucher = await createVoucher(
      {
        ...input("20000.00"),
        supplierAllocations: [
          { supplierInvoiceId: 1, invoiceVersion: 1, amount: "20000.00" },
        ],
      },
      maker,
    );
    await approveVoucher(voucher.receiptId, owner);
    await expectPaid("80000.00", { 1: "20000.00" });
  });
  it("does not repeat creation, approval, allocation or disbursement on retries", async () => {
    const payload = input();
    const first = await createVoucher(payload, maker);
    expect((await createVoucher(payload, maker)).receiptId).toBe(
      first.receiptId,
    );
    await approveVoucher(first.receiptId, owner);
    const after = await state();
    expect((await approveVoucher(first.receiptId, owner)).replayed).toBe(true);
    expect((await createVoucher(payload, maker)).receiptId).toBe(
      first.receiptId,
    );
    expect(await state()).toEqual(after);
  });
  it("rejects a reused create key with a changed distribution", async () => {
    const payload = {
      ...input("20000.00"),
      supplierAllocations: [
        { supplierInvoiceId: 1, invoiceVersion: 1, amount: "20000.00" },
      ],
    };
    await createVoucher(payload, maker);
    const before = await state();
    await expect(
      createVoucher(
        {
          ...payload,
          supplierAllocations: [
            { supplierInvoiceId: 2, invoiceVersion: 1, amount: "20000.00" },
          ],
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it.each([false, true])(
    "rejects switching allocation mode on replay after approval=%s",
    async (approved) => {
      const payload = {
        ...input("20000.00"),
        supplierAllocations: [
          { supplierInvoiceId: 2, invoiceVersion: 1, amount: "20000.00" },
        ],
      };
      const voucher = await createVoucher(payload, maker);
      if (approved) await approveVoucher(voucher.receiptId, owner);
      const before = await state();
      const { supplierAllocations: _allocations, ...omitted } = payload;
      await expect(createVoucher(omitted, maker)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect((await createVoucher(payload, maker)).receiptId).toBe(
        voucher.receiptId,
      );
      expect(await state()).toEqual(before);
    },
  );
  it("rejects automatic-to-manual replay even when the resulting allocation is identical", async () => {
    const payload = input("20000.00");
    await createVoucher(payload, maker);
    const before = await state();
    await expect(
      createVoucher(
        {
          ...payload,
          supplierAllocations: [
            { supplierInvoiceId: 2, invoiceVersion: 1, amount: "20000.00" },
          ],
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it("accepts normalized manual rows in another order on replay", async () => {
    const payload = {
      ...input(),
      supplierAllocations: [
        { supplierInvoiceId: 1, invoiceVersion: 1, amount: "10000.00" },
        { supplierInvoiceId: 2, invoiceVersion: 1, amount: "40000.00" },
      ],
    };
    const voucher = await createVoucher(payload, maker);
    expect(
      (
        await createVoucher(
          {
            ...payload,
            supplierAllocations: [
              { ...payload.supplierAllocations[1], amount: "40000" },
              { ...payload.supplierAllocations[0], amount: "10000" },
            ],
          },
          maker,
        )
      ).receiptId,
    ).toBe(voucher.receiptId);
  });
  it("fails closed when a new linked request loses its original input proof", async () => {
    const payload = input();
    await createVoucher(payload, maker);
    await db()
      .delete(s.idempotencyKeys)
      .where(
        eq(s.idempotencyKeys.operation, "voucher.supplierSettlementInput"),
      );
    const before = await state();
    await expect(createVoucher(payload, maker)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await state()).toEqual(before);
  });
  it.each([
    "HISTORICAL_SUPPLIER_SETTLEMENT_ADOPTION",
    "OWNER_ACCEPTED_FULL_RECEIPT_ASSIGNMENT",
  ])("preserves original omitted-input replay after %s", async (kind) => {
    const payload = input();
    const voucher = await createVoucher(payload, maker);
    await db()
      .delete(s.idempotencyKeys)
      .where(
        eq(s.idempotencyKeys.operation, "voucher.supplierSettlementInput"),
      );
    const [request] = await db().select().from(s.supplierPaymentRequests);
    const canonical = JSON.stringify({
      ...JSON.parse(request.payloadCanonical),
      historicalEvidence: {
        kind,
        originalReceiptId: voucher.receiptId,
      },
    });
    await db()
      .update(s.supplierPaymentRequests)
      .set({
        payloadCanonical: canonical,
        payloadHash: createHash("sha256").update(canonical).digest("hex"),
      })
      .where(eq(s.supplierPaymentRequests.id, request.id));
    const before = await state();
    expect((await createVoucher(payload, maker)).receiptId).toBe(
      voucher.receiptId,
    );
    await expect(
      createVoucher(
        {
          ...payload,
          supplierAllocations: [
            { supplierInvoiceId: 2, invoiceVersion: 1, amount: "40000.00" },
            { supplierInvoiceId: 1, invoiceVersion: 1, amount: "10000.00" },
          ],
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it("cannot duplicate cash via native and voucher approval races", async () => {
    const voucher = await createVoucher(input(), maker);
    const [request] = await db().select().from(s.supplierPaymentRequests);
    const outcomes = await Promise.allSettled([
      approveVoucher(voucher.receiptId, owner),
      decideSupplierPayment(
        {
          requestId: request.id,
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "اعتماد نفس دفعة المورد",
        },
        owner,
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      ),
    ]);
    expect(outcomes.some((result) => result.status === "fulfilled")).toBe(true);
    await expectPaid("50000.00", { 1: "10000.00", 2: "40000.00" });
  });
  it.each(["reject", "withdraw"])(
    "releases reservations on %s with zero financial effects",
    async (action) => {
      const voucher = await createVoucher(input(), maker);
      if (action === "reject")
        await rejectVoucher(voucher.receiptId, owner, "إعادة مراجعة التوزيع");
      else await cancelVoucher(voucher.receiptId, maker);
      const after = await state();
      expect(after.suppliers[0].currentBalance).toBe("100000.00");
      expect(after.payments).toHaveLength(0);
      expect(after.requests[0].status).toBe("REJECTED");
      expect(
        after.requestAllocations.every((row) => row.activeInvoiceGuard == null),
      ).toBe(true);
      expect((await createVoucher(input(), maker)).approvalStatus).toBe(
        "PENDING_APPROVAL",
      );
    },
  );
  it.each(["total", "version", "branch", "supplier"])(
    "rejects an invalid manual %s atomically",
    async (problem) => {
      if (problem === "branch")
        await db()
          .update(s.supplierInvoices)
          .set({ branchId: 2 })
          .where(eq(s.supplierInvoices.id, 1));
      if (problem === "supplier") {
        await db().insert(s.suppliers).values({ id: 2, name: "مورد آخر" });
        await db()
          .update(s.supplierInvoices)
          .set({ supplierId: 2 })
          .where(eq(s.supplierInvoices.id, 1));
      }
      const before = await state();
      await expect(
        createVoucher(
          {
            ...input("20000.00"),
            supplierAllocations: [
              {
                supplierInvoiceId: 1,
                invoiceVersion: problem === "version" ? 2 : 1,
                amount: problem === "total" ? "19999.00" : "20000.00",
              },
            ],
          },
          maker,
        ),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
    },
  );
  it("rolls back approval when the frozen invoice version changes", async () => {
    const voucher = await createVoucher(input(), maker);
    await db()
      .update(s.supplierInvoices)
      .set({ version: 2 })
      .where(eq(s.supplierInvoices.id, 2));
    const before = await state();
    await expect(
      approveVoucher(voucher.receiptId, owner),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it("rejects overpayment without creating a receipt or lowering the balance", async () => {
    const before = await state();
    await expect(createVoucher(input("100001.00"), maker)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("rolls back every cash and payable effect when treasury funds are insufficient", async () => {
    const voucher = await createVoucher(
      { ...input(), paymentMethod: "CASH" },
      maker,
    );
    const before = await state();
    await expect(approveVoucher(voucher.receiptId, owner)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("deducts actual treasury cash and AP once when approving a cash supplier voucher", async () => {
    await db().insert(s.receipts).values({
      direction: "IN",
      branchId: 1,
      amount: "100000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 9,
    });
    const balance = () =>
      withTx(
        async (tx) => (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
        { gate: "NONE" },
      );
    const voucher = await createVoucher(
      { ...input(), paymentMethod: "CASH" },
      maker,
    );
    expect(await balance()).toBe("100000.00");
    await approveVoucher(voucher.receiptId, owner);
    await approveVoucher(voucher.receiptId, owner);
    const after = await state();
    expect(await balance()).toBe("50000.00");
    expect(after.suppliers[0].currentBalance).toBe("50000.00");
    expect(
      after.receipts.filter((row) => row.direction === "OUT"),
    ).toHaveLength(1);
    expect(
      after.entries.filter((row) => row.entryType === "PAYMENT_OUT"),
    ).toHaveLength(1);
  });
  it("rolls back materialized receipt, ledger and allocations if the AP adjustment fails", async () => {
    const voucher = await createVoucher(input(), maker);
    const before = await state();
    const failure = vi
      .spyOn(ledger, "adjustSupplierBalance")
      .mockRejectedValueOnce(new Error("simulated AP write failure"));
    try {
      await expect(approveVoucher(voucher.receiptId, owner)).rejects.toThrow(
        "simulated AP write failure",
      );
      expect(await state()).toEqual(before);
    } finally {
      failure.mockRestore();
    }
    await approveVoucher(voucher.receiptId, owner);
    await expectPaid("50000.00", { 1: "10000.00", 2: "40000.00" });
  });
  it("keeps deferred voucher creation available to a delegated maker without native approval permission", async () => {
    await db()
      .update(s.users)
      .set({
        operationPolicy: {
          version: 1,
          grants: {
            "operation.vouchers.create": true,
            "operation.supplierPayments.decidePayment": false,
          },
        },
      })
      .where(eq(s.users.id, maker.userId));
    const voucher = await createVoucher(
      { ...input(), paymentMethod: "CASH" },
      maker,
    );
    expect(voucher.approvalStatus).toBe("PENDING_APPROVAL");
    expect((await state()).suppliers[0].currentBalance).toBe("100000.00");
    await expect(
      approveVoucher(voucher.receiptId, maker),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("does not lock past allocations during FIFO preflight before the canonical aggregate", async () => {
    const paid = await createVoucher(input("20000.00"), maker);
    await approveVoucher(paid.receiptId, owner);
    const original = nativePayments.requestSupplierPaymentInTx;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const observation = vi
      .spyOn(nativePayments, "requestSupplierPaymentInTx")
      .mockImplementationOnce(async (...args) => {
        reached();
        return original(...args);
      });
    let pending!: ReturnType<typeof createVoucher>;
    try {
      await withTx(async (tx) => {
        await tx
          .select()
          .from(s.purchaseOrders)
          .where(eq(s.purchaseOrders.id, 2))
          .for("update");
        pending = createVoucher(input("5000.00"), maker);
        await entered;
        // A real native approver can lock its older allocation while creation waits for its PO.
        await tx.select().from(s.supplierPaymentAllocations).for("update");
      });
      await pending;
    } finally {
      observation.mockRestore();
    }
    expect((await state()).suppliers[0].currentBalance).toBe("80000.00");
  });
  it.each([1, 2, 3])(
    "serializes a historical voucher upgrade with cancellation (race %i)",
    async () => {
      const receiptId = extractInsertId(
        await db()
          .insert(s.receipts)
          .values({
            voucherNumber: `PV-HIST-${randomUUID()}`,
            direction: "OUT",
            branchId: 1,
            amount: "50000.00",
            paymentMethod: "TRANSFER",
            referenceNumber: "HIST-BANK",
            partyType: "SUPPLIER",
            partyId: 1,
            description: "سند معلق قبل ترحيل فاتورة المورد",
            status: "PENDING",
            approvalStatus: "PENDING_APPROVAL",
            createdBy: 7,
          }),
      );
      const results = await Promise.allSettled([
        approveVoucher(receiptId, owner),
        cancelVoucher(receiptId, maker),
      ]);
      expect(results.some((row) => row.status === "fulfilled")).toBe(true);
      const after = await state();
      const paid = after.payments.length === 1;
      expect(after.suppliers[0].currentBalance).toBe(
        paid ? "50000.00" : "100000.00",
      );
      expect(after.receipts).toHaveLength(1);
      expect(
        after.entries.filter((row) => row.entryType === "PAYMENT_OUT"),
      ).toHaveLength(paid ? 1 : 0);
      expect(
        after.entries.filter((row) => row.entryType === "PAYMENT_IN"),
      ).toHaveLength(0);
      expect(after.allocations).toHaveLength(paid ? 2 : 0);
    },
  );
  it("holds the supplier barrier across a paused historical cancellation before receipt locking", async () => {
    const receiptId = extractInsertId(
      await db()
        .insert(s.receipts)
        .values({
          voucherNumber: `PV-HIST-LOCK-${randomUUID()}`,
          direction: "OUT",
          branchId: 1,
          amount: "50000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "HIST-LOCK-BANK",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "سند تاريخي معلق",
          status: "PENDING",
          approvalStatus: "PENDING_APPROVAL",
          createdBy: 7,
        }),
    );
    let observed!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalWithdrawal =
      voucherSettlement.withdrawSupplierVoucherSettlementTx;
    const withdrawal = vi
      .spyOn(voucherSettlement, "withdrawSupplierVoucherSettlementTx")
      .mockImplementationOnce(async (...args) => {
        const result = await originalWithdrawal(...args);
        observed();
        await release;
        return result;
      });
    const originalRequest = nativePayments.requestSupplierPaymentInTx;
    const request = vi
      .spyOn(nativePayments, "requestSupplierPaymentInTx")
      .mockImplementationOnce(async (...args) => {
        await args[0].execute(sql`SET SESSION innodb_lock_wait_timeout = 1`);
        try {
          return await originalRequest(...args);
        } finally {
          await args[0].execute(sql`SET SESSION innodb_lock_wait_timeout = 50`);
        }
      });
    const cancellation = cancelVoucher(receiptId, maker);
    try {
      await paused;
      // A current-read native upgrade must wait on the cancellation's supplier row.
      await expect(approveVoucher(receiptId, owner)).rejects.toMatchObject({
        cause: { code: "ER_LOCK_WAIT_TIMEOUT" },
      });
    } finally {
      resume();
      withdrawal.mockRestore();
      request.mockRestore();
      await cancellation;
    }
    const after = await state();
    expect(after.receipts[0].status).toBe("REVERSED");
    expect(after.suppliers[0].currentBalance).toBe("100000.00");
    expect(after.payments).toHaveLength(0);
    expect(after.allocations).toHaveLength(0);
  });
  it("reserves its internal request namespace against public native calls", async () => {
    const before = await state();
    await expect(
      requestSupplierPayment(
        {
          supplierId: 1,
          branchId: 1,
          requestKey: "VOUCHER-SUPPLIER:123",
          currency: "IQD",
          amount: "10000",
          currencyAmount: "10000",
          paymentMethod: "TRANSFER",
          externalReference: "BANK",
          evidenceType: "PAYMENT_ORDER",
          evidenceReference: "PV",
          reason: "محاولة مفتاح محجوز",
          allocations: [
            {
              supplierInvoiceId: 1,
              invoiceVersion: 1,
              amount: "10000",
              currencyAmount: "10000",
            },
          ],
        },
        maker,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("routes an approved voucher cancellation to the governed native refund path", async () => {
    const voucher = await createVoucher(input(), maker);
    await approveVoucher(voucher.receiptId, owner);
    const before = await state();
    await expect(cancelVoucher(voucher.receiptId, owner)).rejects.toThrow(
      /استرداد/,
    );
    expect(await state()).toEqual(before);
  });
});

async function dollarInvoices() {
  await db()
    .update(s.suppliers)
    .set({ currentBalance: "467000.00", currentBalanceUsd: "300.00" })
    .where(eq(s.suppliers.id, 1));
  for (const [id, total, usd, rate] of [
    [1, "157000.00", "100.00", "1570.0000"],
    [2, "310000.00", "200.00", "1550.0000"],
  ] as const) {
    await db()
      .update(s.purchaseOrders)
      .set({
        total,
        subtotal: total,
        agreedCurrency: "USD",
        usdTotal: usd,
        agreedRate: rate,
      })
      .where(eq(s.purchaseOrders.id, id));
    await db()
      .update(s.purchaseOrderRevisions)
      .set({
        total,
        subtotal: total,
        agreedCurrency: "USD",
        usdTotal: usd,
        agreedRate: rate,
      })
      .where(eq(s.purchaseOrderRevisions.id, id));
    await db()
      .update(s.supplierInvoices)
      .set({
        currency: "USD",
        totalAmount: total,
        subtotal: total,
        usdTotal: usd,
        agreedRate: rate,
      })
      .where(eq(s.supplierInvoices.id, id));
    await db()
      .update(s.accountingEntries)
      .set({ amount: total })
      .where(eq(s.accountingEntries.purchaseOrderId, id));
  }
}

describe("IQD voucher against invoice currencies", () => {
  it("settles different USD rates FIFO and closes both currency balances exactly", async () => {
    await dollarInvoices();
    const payload = input("400000.00");
    const voucher = await createVoucher(payload, maker);
    await approveVoucher(voucher.receiptId, owner);
    const after = await state();
    expect(after.payments).toHaveLength(1);
    expect(after.receipts).toHaveLength(1);
    expect(
      after.allocations.map((r) => [
        r.supplierInvoiceId,
        r.allocatedAmount,
        r.allocatedCurrencyAmount,
      ]),
    ).toEqual([
      [1, "90000.00", "57.32"],
      [2, "310000.00", "200.00"],
    ]);
    expect(after.suppliers[0]).toMatchObject({
      currentBalance: "67000.00",
      currentBalanceUsd: "42.68",
    });
    expect(after.orders.find((r) => r.id === 1)?.paidUsd).toBe("57.32");
    expect(after.orders.find((r) => r.id === 2)?.paidUsd).toBe("200.00");
    expect(
      (await getSupplierStatement(1, { branchId: 1 }))?.summary.unpaid,
    ).toBe("67000.00");
    expect((await createVoucher(payload, maker)).receiptId).toBe(
      voucher.receiptId,
    );
    expect(await state()).toEqual(after);
    const final = await createVoucher(input("67000.00"), maker);
    await approveVoucher(final.receiptId, owner);
    const closed = await state();
    expect(closed.suppliers[0]).toMatchObject({
      currentBalance: "0.00",
      currentBalanceUsd: "0.00",
    });
    expect(closed.invoices.every((r) => r.paymentGate === "SETTLED")).toBe(
      true,
    );
    expect(closed.orders.find((r) => r.id === 1)?.paidUsd).toBe("100.00");
  });
  it("refunds the exact original USD allocations cumulatively using a single IQD receipt", async () => {
    await dollarInvoices();
    const voucher = await createVoucher(input("400000.00"), maker);
    await approveVoucher(voucher.receiptId, owner);
    const paid = await state();
    const allocation = paid.allocations.find((r) => r.supplierInvoiceId === 1)!;
    async function refund(amount: string, version: number) {
      const request = await requestSupplierPaymentRefund(
        {
          supplierPaymentId: paid.payments[0].id,
          expectedPaymentVersion: version,
          requestKey: randomUUID(),
          refundMethod: "TRANSFER",
          externalReference: randomUUID(),
          evidenceType: "BANK_ADVICE",
          evidenceReference: "BANK",
          reason: "استرداد جزء من سداد الدولار بالدينار",
          allocations: [
            {
              supplierPaymentAllocationId: allocation.id,
              amount,
              currencyAmount: amount,
            },
          ],
        },
        maker,
      );
      return decideSupplierPaymentRefund(
        {
          requestId: request.requestId,
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "اعتماد الاسترداد",
        },
        owner,
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      );
    }
    await refund("1000.00", 1);
    expect((await state()).suppliers[0].currentBalanceUsd).toBe("43.32");
    await refund("89000.00", 2);
    const after = await state();
    expect(after.suppliers[0]).toMatchObject({
      currentBalance: "157000.00",
      currentBalanceUsd: "100.00",
    });
    expect(after.orders.find((r) => r.id === 1)?.paidUsd).toBe("0.00");
    expect(
      after.allocations.find((r) => r.id === allocation.id)
        ?.refundedCurrencyAmount,
    ).toBe("57.32");
    expect(
      (await listSupplierPaymentRefundSources({ branchId: 1 }, maker)).rows,
    ).toHaveLength(1);
    expect(
      after.entries.filter((r) => r.entryType === "PAYMENT_OUT"),
    ).toHaveLength(1);
    expect(
      after.entries.filter((r) => r.entryType === "PAYMENT_IN"),
    ).toHaveLength(2);
  });
  it("rejects rate changes even without a version bump and leaves every financial row unchanged", async () => {
    await dollarInvoices();
    const voucher = await createVoucher(input("400000.00"), maker);
    await db()
      .update(s.supplierInvoices)
      .set({ agreedRate: "1600.0000" })
      .where(eq(s.supplierInvoices.id, 1));
    const before = await state();
    await expect(approveVoucher(voucher.receiptId, owner)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("rolls IQD, USD, receipts, allocations and PO caches back together on failure", async () => {
    await dollarInvoices();
    const voucher = await createVoucher(input("400000.00"), maker);
    const before = await state();
    const spy = vi
      .spyOn(ledger, "adjustSupplierBalanceUsd")
      .mockRejectedValueOnce(new Error("USD ledger failure"));
    try {
      await expect(approveVoucher(voucher.receiptId, owner)).rejects.toThrow(
        "USD ledger failure",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await state()).toEqual(before);
  });
  it("settles mixed IQD and USD invoices in the same receipt", async () => {
    await dollarInvoices();
    await db()
      .update(s.supplierInvoices)
      .set({ currency: "IQD", usdTotal: null, agreedRate: null })
      .where(eq(s.supplierInvoices.id, 1));
    await db()
      .update(s.purchaseOrders)
      .set({ agreedCurrency: "IQD", usdTotal: null, agreedRate: null })
      .where(eq(s.purchaseOrders.id, 1));
    await db()
      .update(s.suppliers)
      .set({ currentBalanceUsd: "200.00" })
      .where(eq(s.suppliers.id, 1));
    const voucher = await createVoucher(input("400000.00"), maker);
    await approveVoucher(voucher.receiptId, owner);
    const after = await state();
    expect(after.suppliers[0]).toMatchObject({
      currentBalance: "67000.00",
      currentBalanceUsd: "0.00",
    });
    expect(
      after.allocations.find((r) => r.supplierInvoiceId === 1)
        ?.allocatedCurrencyAmount,
    ).toBe("90000.00");
  });
});

it("prevents accumulated FX rounding across many partial settlements", () => {
  let paid = money(0), usd = money(0);
  for (let index = 0; index < 157; index++) {
    usd = usd.plus(cumulativeCurrencyDelta("157000.00", "100.00", toDbMoney(paid), toDbMoney(usd), "1000.00"));
    paid = paid.plus(1000);
  }
  expect(toDbMoney(usd)).toBe("100.00");
  expect(() => cumulativeCurrencyDelta("157000.00", "100.00", "0.00", "0.00", "0.01")).toThrow(/دقة عملة/);
});
