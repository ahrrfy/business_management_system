import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { autoSettleSupplierAccountTx } from "../reconciliation/autoSettlementService";
import {
  decideSupplierPayment,
  requestSupplierPayment,
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
} from "../purchase/supplierPayments";
import { withTx } from "../tx";
import {
  approveVoucher,
  cancelVoucher,
  createVoucher,
} from "../voucherService";

const maker = { userId: 7, branchId: 1, role: "purchasing" };
const owner = { userId: 9, branchId: 1, role: "manager" };
const d = () => {
  const db = getDb();
  if (!db) throw new Error("test database missing");
  return db;
};

beforeEach(async () => {
  vi.stubEnv("ROLLOUT_OWNER_ONLY_APPROVAL", "off");
  await d()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d()
    .insert(s.users)
    .values([
      {
        id: 7,
        openId: "native-payment-maker",
        name: "طالب",
        role: "purchasing",
        branchId: 1,
      },
      {
        id: 9,
        openId: "native-payment-owner",
        name: "مالك",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await d()
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد", currentBalance: "100000.00" });
});
afterEach(() => vi.unstubAllEnvs());

async function postedNativeInvoice() {
  const entry = await d().insert(s.accountingEntries).values({
    entryType: "PURCHASE",
    entryDate: "2026-01-01",
    amount: "100000.00",
    branchId: 1,
    supplierId: 1,
  });
  await d()
    .insert(s.supplierInvoices)
    .values({
      id: 1,
      invoiceNumber: "SI-NATIVE-GUARD",
      clientRequestId: "native-guard-invoice",
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
      externalInvoiceNumber: "EXT-NATIVE-GUARD",
      externalNumberNorm: "EXTNATIVEGUARD",
      evidenceReference: "invoice-evidence",
      createdBy: owner.userId,
      postingEntryId: extractInsertId(entry),
      postedBy: owner.userId,
      postedAt: new Date(),
    });
}

async function linkedNativeOrder(paidAmount = "0.00") {
  await d().insert(s.products).values({ id: 1, name: "صنف الاختبار" });
  await d().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    variantName: "افتراضي",
    sku: "NATIVE-GUARD",
  });
  await d().insert(s.purchaseOrders).values({
    id: 1,
    poNumber: "PO-NATIVE-GUARD",
    supplierId: 1,
    branchId: 1,
    subtotal: "100000.00",
    total: "100000.00",
    paidAmount,
    status: "RECEIVED",
  });
  await d()
    .insert(s.purchaseOrderRevisions)
    .values({
      id: 1,
      purchaseOrderId: 1,
      revisionNo: 1,
      origin: "NATIVE",
      supplierId: 1,
      branchId: 1,
      agreedCurrency: "IQD",
      settlementType: "CREDIT",
      subtotal: "100000.00",
      total: "100000.00",
      taxAmount: "0.00",
      shippingCost: "0.00",
      customsCost: "0.00",
      invoiceDiscount: "0.00",
      payloadCanonical: "{}",
      payloadHash: "0".repeat(64),
      revisionReason: "طلب اختبار",
      createdBy: maker.userId,
    });
  await d().insert(s.purchaseOrderRevisionItems).values({
    id: 1,
    revisionId: 1,
    lineNo: 1,
    variantId: 1,
    quantity: "1.000",
    baseQuantity: 1,
    listUnitPrice: "100000.00",
    unitPrice: "100000.00",
    lineTotal: "100000.00",
    productNameSnapshot: "صنف الاختبار",
  });
  await d().insert(s.supplierInvoiceLines).values({
    supplierInvoiceId: 1,
    lineNo: 1,
    purchaseOrderRevisionItemId: 1,
    variantId: 1,
    description: "بند اختبار",
    invoicedBaseQuantity: 1,
    unitPriceIqd: "100000.00",
    netAmount: "100000.00",
    totalAmount: "100000.00",
  });
}

function voucherInput(voucherType: "PAYMENT" | "RECEIPT" = "PAYMENT") {
  return {
    voucherType,
    branchId: 1,
    amount: "10000.00",
    paymentMethod: "TRANSFER" as const,
    partyType: "SUPPLIER" as const,
    partyId: 1,
    description: "اختبار سند المورد",
    referenceNumber: `TR-${randomUUID()}`,
    clientRequestId: randomUUID(),
  };
}

function paymentInput() {
  return {
    supplierId: 1,
    branchId: 1,
    requestKey: randomUUID(),
    currency: "IQD" as const,
    amount: "10000.00",
    currencyAmount: "10000.00",
    paymentMethod: "TRANSFER" as const,
    externalReference: `TR-${randomUUID()}`,
    evidenceType: "TRANSFER_RECEIPT" as const,
    evidenceReference: "bank-transfer-evidence",
    reason: "سداد صريح لفاتورة المورد",
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

async function financialState() {
  const [supplier] = await d().select().from(s.suppliers);
  return {
    receipts: await d().select().from(s.receipts),
    entries: await d().select().from(s.accountingEntries),
    payments: await d().select().from(s.supplierPayments),
    requests: await d().select().from(s.supplierPaymentRequests),
    allocations: await d().select().from(s.supplierPaymentAllocations),
    balance: supplier.currentBalance,
  };
}

describe("native supplier AP payment guards", () => {
  it.each([maker, owner])(
    "rejects generic payment atomically for actor $userId, including the owner",
    async (actor) => {
      await postedNativeInvoice();
      const before = await financialState();
      await expect(createVoucher(voucherInput(), actor)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(await financialState()).toEqual(before);
      expect(await d().select().from(s.idempotencyKeys)).toHaveLength(0);
    },
  );

  it("rechecks a pending generic voucher if native AP was posted after creation", async () => {
    const voucher = await createVoucher(voucherInput(), maker);
    await postedNativeInvoice();
    const before = await financialState();
    await expect(
      approveVoucher(voucher.receiptId, owner),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await financialState()).toEqual(before);
    const [receipt] = await d()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, voucher.receiptId));
    expect(receipt).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
    });
  });

  it("allows the governed OUT reversal of a historical supplier IN voucher", async () => {
    const original = await createVoucher(voucherInput("RECEIPT"), maker);
    await postedNativeInvoice();
    const cancellation = await cancelVoucher(original.receiptId, maker);
    await approveVoucher(Number(cancellation.approvalReceiptId), owner);
    const [supplier] = await d().select().from(s.suppliers);
    expect(supplier.currentBalance).toBe("100000.00");
    const [originalAfter] = await d()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, original.receiptId));
    expect(originalAfter.status).toBe("REVERSED");
    expect(await d().select().from(s.supplierPaymentAllocations)).toHaveLength(
      0,
    );
  });

  it("does not FIFO-settle a native-linked purchase order from the supplier balance", async () => {
    await postedNativeInvoice();
    await linkedNativeOrder();
    await d()
      .update(s.suppliers)
      .set({ currentBalance: "0.00" })
      .where(eq(s.suppliers.id, 1));
    const result = await withTx((tx) =>
      autoSettleSupplierAccountTx(tx, 1, owner),
    );
    expect(result.totalSettledAmount).toBe("0.00");
    const [order] = await d().select().from(s.purchaseOrders);
    const [invoice] = await d().select().from(s.supplierInvoices);
    expect(order.paidAmount).toBe("0.00");
    expect(invoice.paymentGate).toBe("OPEN");
  });

  it("blocks a native payment request when historical PO paid cache exceeds allocations", async () => {
    await postedNativeInvoice();
    await linkedNativeOrder("100000.00");
    const before = await financialState();
    await expect(requestSupplierPayment(paymentInput(), owner)).rejects.toThrow(
      /قضية نزاهة شراء/,
    );
    expect(await financialState()).toEqual(before);
  });

  it("blocks a prior native PO ledger payment without allocations even when its paid cache is zero", async () => {
    await postedNativeInvoice();
    await linkedNativeOrder();
    const receipt = await d().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "10000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      partyType: "SUPPLIER",
      partyId: 1,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: owner.userId,
    });
    await d()
      .insert(s.accountingEntries)
      .values({
        entryType: "PAYMENT_OUT",
        entryDate: "2026-01-01",
        amount: "10000.00",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
        receiptId: extractInsertId(receipt),
        createdBy: owner.userId,
      });
    await d()
      .update(s.suppliers)
      .set({ currentBalance: "90000.00" })
      .where(eq(s.suppliers.id, 1));
    const before = await financialState();
    await expect(requestSupplierPayment(paymentInput(), maker)).rejects.toThrow(
      /قضية نزاهة شراء/,
    );
    expect(await financialState()).toEqual(before);
  });

  it("permits an explicit native payment when the PO cache and allocation evidence are zero", async () => {
    await postedNativeInvoice();
    await linkedNativeOrder();
    const requested = await requestSupplierPayment(paymentInput(), maker);
    expect(requested.status).toBe("PENDING");
    expect(await d().select().from(s.receipts)).toHaveLength(0);
    expect((await financialState()).balance).toBe("100000.00");
    const decided = await decideSupplierPayment(
      {
        requestId: requested.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "اعتماد مستقل للسداد الصريح",
      },
      owner,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );
    expect(decided.status).toBe("APPROVED");
    const after = await financialState();
    expect(after.balance).toBe("90000.00");
    expect(after.receipts).toHaveLength(1);
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].allocatedAmount).toBe("10000.00");
    await expect(createVoucher(voucherInput(), maker)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await financialState()).toEqual(after);
  });

  it("rechecks historical projection integrity at native payment approval", async () => {
    await postedNativeInvoice();
    await linkedNativeOrder();
    const requested = await requestSupplierPayment(paymentInput(), maker);
    await d()
      .update(s.purchaseOrders)
      .set({ paidAmount: "100000.00" })
      .where(eq(s.purchaseOrders.id, 1));
    const before = await financialState();
    await expect(
      decideSupplierPayment(
        {
          requestId: requested.requestId,
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "اعتماد طلب السداد",
        },
        owner,
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      ),
    ).rejects.toThrow(/قضية نزاهة شراء/);
    expect(await financialState()).toEqual(before);
  });
});
