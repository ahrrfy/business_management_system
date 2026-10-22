import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createVoucher,
  approveVoucher,
  rejectVoucher,
  cancelVoucher,
  getVoucher,
} from "../voucherService";
import { requestSupplierPayment } from "../purchase/supplierPayments";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { withGovernanceTx, withTx } from "../tx";
import {
  recordSupplierBookVoucherMarkerTx,
  SUPPLIER_BOOK_VOUCHER_REQUEST_ACTION,
} from "../voucher/supplierSettlement";
import * as core from "../purchase/supplierBookSettlement";
import { money, toDbMoney } from "../money";
import type { VoucherInput } from "../voucher/types";
const db = () => getDb()!;
const owner = { userId: 9, branchId: 1, role: "manager" };
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 9,
    openId: "book-owner",
    name: "مالك",
    role: "manager",
    isOwner: true,
    branchId: 1,
  });
  await db().insert(s.users).values({
    id: 7,
    openId: "book-maker",
    name: "محاسب",
    role: "accountant",
    branchId: 1,
  });
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد", currentBalance: "100000.00" });
  await db().insert(s.products).values({ id: 1, name: "صنف" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, variantName: "صنف", sku: "BOOK-TEST" });
  for (const [id, amount] of [
    [1, "60000.00"],
    [2, "40000.00"],
  ] as const) {
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        poNumber: `PO-${id}`,
        supplierId: 1,
        branchId: 1,
        subtotal: amount,
        total: amount,
        paidAmount: "0.00",
        status: "RECEIVED",
      });
    const entry = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "PURCHASE",
        entryDate: "2026-10-01",
        amount,
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: id,
      }),
    );
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
        subtotal: amount,
        total: amount,
        taxAmount: "0.00",
        shippingCost: "0.00",
        customsCost: "0.00",
        invoiceDiscount: "0.00",
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        revisionReason: "اختبار",
        createdBy: 9,
      });
    await db().insert(s.purchaseOrderRevisionItems).values({
      id,
      revisionId: id,
      lineNo: 1,
      variantId: 1,
      quantity: "1.000",
      baseQuantity: 1,
      listUnitPrice: amount,
      unitPrice: amount,
      lineTotal: amount,
      productNameSnapshot: "صنف",
    });
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `SI-${id}`,
        clientRequestId: `book-invoice-${id}`,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: "2026-10-01",
        currency: "IQD",
        subtotal: amount,
        totalAmount: amount,
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        externalInvoiceNumber: `EXT-${id}`,
        externalNumberNorm: `EXT${id}`,
        evidenceType: "OTHER",
        evidenceReference: "invoice",
        createdBy: 9,
        postingEntryId: entry,
        postedBy: 9,
        postedAt: new Date(),
      });
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: id,
      lineNo: 1,
      purchaseOrderRevisionItemId: id,
      variantId: 1,
      description: "صنف",
      invoicedBaseQuantity: 1,
      unitPriceIqd: amount,
      netAmount: amount,
      totalAmount: amount,
    });
  }
});

const maker = { userId: 7, branchId: 1, role: "accountant" };
async function mixed() {
  await db()
    .update(s.supplierInvoices)
    .set({
      origin: "LEGACY",
      liabilityClass: "LEGACY_UNKNOWN",
      paymentGate: "BLOCKED_REVIEW",
      legacyPurchaseOrderId: 1,
      legacySettlementEvidenceHash: "a".repeat(64),
    })
    .where(eq(s.supplierInvoices.id, 1));
  const opening = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "OPENING",
        supplierId: 1,
        branchId: null,
        amount: "50000.00",
        entryDate: new Date("2026-01-01T00:00:00Z"),
      }),
  );
  const oldReceipt = extractInsertId(
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "OUT",
        partyType: "SUPPLIER",
        partyId: 1,
        amount: "20000.00",
        paymentMethod: "TRANSFER",
        referenceNumber: "BANK-OLD",
        voucherNumber: "PV-OLD",
        createdBy: 7,
        approvedBy: 9,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        voucherDate: new Date("2026-10-02T00:00:00Z"),
      }),
  );
  await db()
    .insert(s.accountingEntries)
    .values({
      entryType: "PAYMENT_OUT",
      supplierId: 1,
      branchId: 1,
      receiptId: oldReceipt,
      amount: "20000.00",
      entryDate: new Date("2026-10-02T00:00:00Z"),
    });
  const creditEntry = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "RETURN",
        supplierId: 1,
        branchId: 1,
        purchaseOrderId: 1,
        amount: "-10000.00",
        entryDate: new Date("2026-10-03T00:00:00Z"),
        dedupeKey: "PURCHASE_RETURN:1",
      }),
  );
  await db().insert(s.purchaseReturns).values({
    id: 1,
    returnNumber: "RETURN-PO",
    clientRequestId: "return-po",
    origin: "LEGACY",
    supplierId: 1,
    branchId: 1,
    supplierInvoiceId: null,
    purchaseOrderId: 1,
    accountingEntryId: creditEntry,
    settlement: "CREDIT",
    totalAmount: "10000.00",
    netAmount: "10000.00",
    creditOffsetAmount: "10000.00",
    createdBy: 9,
    createdByNameSnapshot: "owner",
  });
  await db()
    .update(s.suppliers)
    .set({ currentBalance: "120000.00" })
    .where(eq(s.suppliers.id, 1));
  return { opening, oldReceipt };
}
const input = (amount = "120000.00"): VoucherInput => ({
  voucherType: "PAYMENT",
  branchId: 1,
  partyType: "SUPPLIER",
  partyId: 1,
  paymentMethod: "TRANSFER",
  referenceNumber: "BANK-NEW",
  description: "تسوية كامل الذمة",
  amount,
  clientRequestId: randomUUID(),
});
async function financial() {
  return {
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
    suppliers: await db().select().from(s.suppliers),
    sources: await db().select().from(s.supplierBookSettlementSources),
    allocations: await db().select().from(s.supplierBookSettlementAllocations),
  };
}
describe("live generic supplier BOOK voucher", () => {
  it("rejects an oversized 150-allocation audit marker atomically without a pending receipt or marker residue", async () => {
    const before = await financial();
    const beforeMarkers = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, SUPPLIER_BOOK_VOUCHER_REQUEST_ACTION));
    const request: VoucherInput = {
      ...input("150.00"),
      supplierAllocations: Array.from({ length: 150 }, (_, index) => ({
        supplierInvoiceId: index + 1,
        invoiceVersion: 1,
        amount: "1.00",
      })),
    };
    expect(
      Buffer.byteLength(JSON.stringify(request.supplierAllocations), "utf8"),
    ).toBeGreaterThan(8192);
    await expect(
      withGovernanceTx(async (tx) => {
        const receiptId = extractInsertId(
          await tx
            .insert(s.receipts)
            .values({
              branchId: 1,
              direction: "OUT",
              partyType: "SUPPLIER",
              partyId: 1,
              amount: request.amount,
              paymentMethod: "TRANSFER",
              referenceNumber: "MARKER-BOUNDARY",
              voucherNumber: "PV-MARKER-BOUNDARY",
              createdBy: maker.userId,
              status: "PENDING",
              approvalStatus: "PENDING_APPROVAL",
            }),
        );
        await recordSupplierBookVoucherMarkerTx(
          tx,
          receiptId,
          request,
          {
            mode: "BOOK",
            supplierId: 1,
            branchId: 1,
            amount: request.amount,
            evidenceHash: "a".repeat(64),
          },
          maker,
        );
      }),
    ).rejects.toThrow(/أكبر من الحد الآمن/);
    expect(await financial()).toEqual(before);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, SUPPLIER_BOOK_VOUCHER_REQUEST_ACTION)),
    ).toEqual(beforeMarkers);
  });
  it.each([
    { mode: "DRAWER" as const, shiftId: 1 },
    { mode: "TREASURY" as const, shiftId: 1 },
  ])(
    "rejects unsupported BOOK cash source without silently switching it",
    async (source) => {
      await mixed();
      const before = await financial();
      await expect(
        createVoucher(
          { ...input(), paymentMethod: "CASH", supplierCashSource: source },
          owner,
        ),
      ).rejects.toThrow(/الخزينة الإدارية/);
      expect(await financial()).toEqual(before);
    },
  );
  it("rejects a noncash source and an approval-time drawer override", async () => {
    await mixed();
    await expect(
      createVoucher(
        { ...input(), supplierCashSource: { mode: "TREASURY" } },
        maker,
      ),
    ).rejects.toThrow(/الخزينة الإدارية/);
    const pending = await createVoucher(
      { ...input("20000.00"), paymentMethod: "CASH" },
      maker,
    );
    const before = await financial();
    await expect(
      approveVoucher(pending.receiptId, owner, {
        cashSource: { mode: "DRAWER", shiftId: 1 },
      }),
    ).rejects.toThrow(/الخزينة الإدارية/);
    expect(await financial()).toEqual(before);
  });
  it("preserves an explicit versioned manual invoice allocation and replay intent while default remains FIFO", async () => {
    await mixed();
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 2));
    const request = {
      ...input("20000.00"),
      supplierAllocations: [
        {
          supplierInvoiceId: 2,
          invoiceVersion: invoice.version,
          amount: "20000.00",
        },
      ],
    };
    const pending = await createVoucher(request, maker);
    await approveVoucher(pending.receiptId, owner);
    const [source] = await db()
      .select()
      .from(s.supplierBookSettlementSources)
      .where(
        eq(s.supplierBookSettlementSources.sourceReceiptId, pending.receiptId),
      );
    const allocations = await db()
      .select()
      .from(s.supplierBookSettlementAllocations)
      .where(eq(s.supplierBookSettlementAllocations.sourceId, source.id));
    expect(allocations).toMatchObject([
      { supplierInvoiceId: 2, allocatedAmount: "20000.00" },
    ]);
    await expect(
      createVoucher({ ...request, supplierAllocations: undefined }, maker),
    ).rejects.toThrow(/مدخلات تسوية دفترية مختلفة/);
    expect((await createVoucher(request, maker)).receiptId).toBe(
      pending.receiptId,
    );
  });
  it("posts cash once and governed cancellation restores the original whole BOOK source once", async () => {
    await mixed();
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "200000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      createdBy: 9,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    const beforeCash = await withTx((tx) => computeTreasuryCashBalance(tx, 1));
    const request = {
      ...input(),
      paymentMethod: "CASH" as const,
      referenceNumber: null,
    };
    const paid = await createVoucher(request, owner);
    expect(
      toDbMoney(
        beforeCash.minus(
          await withTx((tx) => computeTreasuryCashBalance(tx, 1)),
        ),
      ),
    ).toBe("120000.00");
    const cancelled = await cancelVoucher(paid.receiptId, owner);
    expect(cancelled).toBeTruthy();
    expect(
      toDbMoney(await withTx((tx) => computeTreasuryCashBalance(tx, 1))),
    ).toBe(toDbMoney(beforeCash));
    const [supplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("120000.00");
    const [source] = await db()
      .select()
      .from(s.supplierBookSettlementSources)
      .where(
        eq(s.supplierBookSettlementSources.sourceReceiptId, paid.receiptId),
      );
    expect(source.status).toBe("REVERSED");
  });
  it("serializes competing pending receipts against net AP and rejects an unproven legacy target atomically", async () => {
    await mixed();
    const results = await Promise.allSettled([
      createVoucher(input("70000.00"), maker),
      createVoucher(input("70000.00"), maker),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const pending = results.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof createVoucher>>>;
    await rejectVoucher(pending.value.receiptId, owner, "رفض الحجز");
    await db()
      .update(s.accountingEntries)
      .set({ amount: "59999.00" })
      .where(
        and(
          eq(s.accountingEntries.purchaseOrderId, 1),
          eq(s.accountingEntries.entryType, "PURCHASE"),
        ),
      );
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "119999.00" })
      .where(eq(s.suppliers.id, 1));
    const before = await financial();
    await expect(createVoucher(input("50000.00"), owner)).rejects.toThrow(
      /إثبات أصل الذمة/,
    );
    expect(await financial()).toEqual(before);
  });
  it("settles full mixed opening, proven UNKNOWN and native AP once with PO-only credit preserved", async () => {
    const { opening, oldReceipt } = await mixed();
    const before = await financial();
    const request = input();
    const created = await createVoucher(request, owner);
    expect(created.approvalStatus).toBe("APPROVED");
    const after = await financial();
    expect(after.receipts.length - before.receipts.length).toBe(1);
    expect(after.entries.length - before.entries.length).toBe(1);
    expect(after.suppliers[0].currentBalance).toBe("0.00");
    expect(after.sources.map((row) => row.sourceReceiptId)).toEqual(
      expect.arrayContaining([oldReceipt, created.receiptId]),
    );
    const newSource = after.sources.find(
      (row) => row.sourceReceiptId === created.receiptId,
    )!;
    const allocations = after.allocations.filter(
      (row) => row.sourceId === newSource.id,
    );
    expect(
      allocations.map((row) => [
        row.supplierInvoiceId ?? "OPENING",
        row.allocatedAmount,
      ]),
    ).toEqual([
      ["OPENING", "30000.00"],
      [1, "50000.00"],
      [2, "40000.00"],
    ]);
    expect(allocations[0].openingEntryId).toBe(opening);
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
    expect((await getVoucher(created.receiptId))?.bookSettlement?.kind).toBe(
      "BOOK",
    );
    expect(await createVoucher(request, owner)).toMatchObject({
      receiptId: created.receiptId,
    });
    await approveVoucher(created.receiptId, owner);
    expect(await financial()).toEqual(after);
  });
  it("reserves maker pending amount, blocks native competing requests, and releases on rejection", async () => {
    await mixed();
    const before = await financial();
    const request = input("70000.00");
    const pending = await createVoucher(request, maker);
    expect(pending.approvalStatus).toBe("PENDING_APPROVAL");
    expect((await financial()).entries).toEqual(before.entries);
    expect((await financial()).sources).toHaveLength(0);
    await expect(createVoucher(input("50000.01"), maker)).rejects.toThrow();
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 2));
    await expect(
      requestSupplierPayment(
        {
          supplierId: 1,
          branchId: 1,
          requestKey: "NATIVE-COMPETING",
          currency: "IQD",
          amount: "1000.00",
          currencyAmount: "1000.00",
          paymentMethod: "TRANSFER",
          externalReference: "BANK",
          evidenceType: "BANK_ADVICE",
          evidenceReference: "BANK",
          reason: "competing",
          allocations: [
            {
              supplierInvoiceId: 2,
              invoiceVersion: invoice.version,
              amount: "1000.00",
              currencyAmount: "1000.00",
            },
          ],
        },
        maker,
      ),
    ).rejects.toThrow(/سند تسوية دفترية معلق/);
    await rejectVoucher(pending.receiptId, owner, "إلغاء الطلب قبل الصرف");
    const replacement = await createVoucher(input(), owner);
    expect(replacement.approvalStatus).toBe("APPROVED");
  });
  it("revalidates changed net AP before approval and keeps rejected receipt replay harmless", async () => {
    await mixed();
    const pending = await createVoucher(input(), maker);
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "119999.00" })
      .where(eq(s.suppliers.id, 1));
    const before = await financial();
    await expect(approveVoucher(pending.receiptId, owner)).rejects.toThrow();
    expect(await financial()).toEqual(before);
    await rejectVoucher(pending.receiptId, owner, "رفض بعد تغير الذمة");
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
  });
  it("rolls back the original posting and marker if BOOK application fails", async () => {
    await mixed();
    const before = await financial();
    const spy = vi
      .spyOn(core, "applySupplierBookVoucherTx")
      .mockRejectedValueOnce(new Error("BOOK-INJECTED"));
    try {
      await expect(createVoucher(input(), owner)).rejects.toThrow(
        "BOOK-INJECTED",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await financial()).toEqual(before);
  });
  it("keeps pure-native vouchers on the native linked request path", async () => {
    const result = await createVoucher(input("20000.00"), owner);
    expect(result.approvalStatus).toBe("APPROVED");
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    expect(await db().select().from(s.supplierPayments)).toHaveLength(1);
  });
});
