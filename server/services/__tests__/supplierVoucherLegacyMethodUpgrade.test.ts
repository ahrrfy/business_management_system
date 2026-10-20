import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { approveVoucher, createVoucher } from "../voucherService";
import type { PaymentMethod } from "../voucher/types";

const db = () => getDb()!;
const owner = { userId: 9, branchId: 1, role: "manager" };

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 7,
        openId: "method-maker",
        name: "Maker",
        role: "accountant",
        branchId: 1,
      },
      {
        id: 9,
        openId: "method-owner",
        name: "Owner",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "Supplier", currentBalance: "100000.00" });
  await db().insert(s.products).values({ id: 1, name: "Item" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    variantName: "Default",
    sku: "METHOD-ITEM",
  });
  await db().insert(s.purchaseOrders).values({
    id: 1,
    poNumber: "PO-METHOD",
    supplierId: 1,
    branchId: 1,
    subtotal: "100000.00",
    total: "100000.00",
    paidAmount: "0.00",
    status: "RECEIVED",
  });
  await db()
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
      taxAmount: "0",
      shippingCost: "0",
      customsCost: "0",
      invoiceDiscount: "0",
      payloadCanonical: "{}",
      payloadHash: "0".repeat(64),
      revisionReason: "Test",
      createdBy: 7,
    });
  await db().insert(s.purchaseOrderRevisionItems).values({
    id: 1,
    revisionId: 1,
    lineNo: 1,
    variantId: 1,
    quantity: "1",
    baseQuantity: 1,
    listUnitPrice: "100000",
    unitPrice: "100000",
    lineTotal: "100000",
    productNameSnapshot: "Item",
  });
  await db().insert(s.receipts).values({
    direction: "IN",
    branchId: 1,
    amount: "100000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    partyType: "OTHER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 9,
  });
});

async function seedInvoice(origin: "NATIVE" | "LEGACY") {
  const postingEntryId = extractInsertId(
    await db().insert(s.accountingEntries).values({
      entryType: "PURCHASE",
      entryDate: "2026-01-01",
      amount: "100000.00",
      branchId: 1,
      supplierId: 1,
      purchaseOrderId: 1,
    }),
  );
  await db()
    .insert(s.supplierInvoices)
    .values({
      id: 1,
      invoiceNumber: "SI-METHOD",
      clientRequestId: "invoice-method",
      supplierId: 1,
      branchId: 1,
      origin,
      status: "POSTED",
      liabilityClass: origin === "NATIVE" ? "NATIVE_AP" : "LEGACY_AP",
      legacyPurchaseOrderId: origin === "LEGACY" ? 1 : null,
      legacySettlementEvidenceHash: origin === "LEGACY" ? "a".repeat(64) : null,
      paymentGate: "OPEN",
      invoiceDate: "2026-01-01",
      currency: "IQD",
      subtotal: "100000.00",
      totalAmount: "100000.00",
      payloadCanonical: "{}",
      payloadHash: "0".repeat(64),
      evidenceType: "OTHER",
      externalInvoiceNumber: "EXT-METHOD",
      externalNumberNorm: "EXTMETHOD",
      evidenceReference: "source",
      createdBy: 7,
      postingEntryId,
      postedBy: 9,
      postedAt: new Date(),
    });
  await db().insert(s.supplierInvoiceLines).values({
    supplierInvoiceId: 1,
    lineNo: 1,
    purchaseOrderRevisionItemId: 1,
    variantId: 1,
    description: "Item",
    invoicedBaseQuantity: 1,
    unitPriceIqd: "100000.00",
    netAmount: "100000.00",
    totalAmount: "100000.00",
  });
}

async function seedPending(method: PaymentMethod, origin: "NATIVE" | "LEGACY") {
  await seedInvoice(origin);
  // Existing historical receipt, deliberately bypassing today's creation adapter.
  return extractInsertId(
    await db()
      .insert(s.receipts)
      .values({
        voucherNumber: "PV-HIST-METHOD",
        direction: "OUT",
        branchId: 1,
        amount: "10000.00",
        paymentMethod: method,
        referenceNumber: "METHOD-REFERENCE",
        checkNumber: method === "CHECK" ? "CHECK-123" : null,
        partyType: "SUPPLIER",
        partyId: 1,
        description: "Historical pending supplier payment",
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        createdBy: 7,
      }),
  );
}

async function snapshot() {
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
    payments: await db().select().from(s.supplierPayments),
    allocations: await db().select().from(s.supplierPaymentAllocations),
  };
}

describe("historical supplier voucher payment-method upgrade", () => {
  it.each(["CHECK"] as const)(
    "retains creation and approval of a %s voucher against unadopted legacy purchase debt",
    async (method) => {
      // A genuine unadopted legacy balance has no invoice row. Current schema
      // forbids a LEGACY invoice with a null classification evidence hash.
      await db().insert(s.accountingEntries).values({
        entryType: "PURCHASE",
        entryDate: "2026-01-01",
        amount: "100000.00",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
      });
      const input = {
        voucherType: "PAYMENT" as const,
        branchId: 1,
        amount: "10000.00",
        paymentMethod: method,
        partyType: "SUPPLIER" as const,
        partyId: 1,
        description: "Legacy supplier payment",
        referenceNumber: "LEGACY-REFERENCE",
        checkNumber: method === "CHECK" ? "CHECK-123" : null,
        clientRequestId: `LEGACY-CREATE-${method}`,
      };
      const created = await createVoucher(input, {
        userId: 7,
        branchId: 1,
        role: "accountant",
      });
      await approveVoucher(created.receiptId, owner);
      const after = await snapshot();
      expect(after.suppliers[0].currentBalance).toBe("90000.00");
      expect(
        after.receipts.find((row) => row.id === created.receiptId),
      ).toMatchObject({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        paymentMethod: method,
      });
      expect(after.requests).toHaveLength(0);
      expect(after.payments).toHaveLength(0);
      expect(after.allocations).toHaveLength(0);
    },
  );

  it("rejects new CHECK creation against evidenced eligible legacy AP atomically", async () => {
    await seedInvoice("LEGACY");
    const before = await snapshot();
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "10000.00",
          paymentMethod: "CHECK",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "Evidenced legacy invoice requires supported settlement",
          referenceNumber: "LEGACY-CHECK-REF",
          checkNumber: "CHECK-123",
          clientRequestId: "ELIGIBLE-LEGACY-CHECK",
        },
        { userId: 7, branchId: 1, role: "accountant" },
      ),
    ).rejects.toThrow("طريقة الدفع غير مدعومة لتسوية فواتير المورد المؤهلة");
    expect(await snapshot()).toEqual(before);
  });

  it.each(["CHECK"] as const)(
    "retains generic approval for an existing %s voucher with only legacy AP",
    async (method) => {
      const receiptId = await seedPending(method, "LEGACY");
      await approveVoucher(receiptId, owner);
      const after = await snapshot();
      expect(after.receipts.find((row) => row.id === receiptId)).toMatchObject({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        paymentMethod: method,
      });
      expect(after.suppliers[0].currentBalance).toBe("90000.00");
      expect(
        after.entries.filter((row) => row.receiptId === receiptId),
      ).toHaveLength(1);
      expect(after.requests).toHaveLength(0);
      expect(after.requestAllocations).toHaveLength(0);
      expect(after.payments).toHaveLength(0);
      expect(after.allocations).toHaveLength(0);
      await approveVoucher(receiptId, owner);
      expect(await snapshot()).toEqual(after);
    },
  );

  it("retains the dedicated-workflow restriction on generic EXCHANGE creation", async () => {
    await seedInvoice("LEGACY");
    const before = await snapshot();
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "10000.00",
          paymentMethod: "EXCHANGE",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "Exchange requires dedicated workflow",
          referenceNumber: "EXCHANGE-REF",
          clientRequestId: "LEGACY-EXCHANGE-BLOCKED",
        },
        { userId: 7, branchId: 1, role: "accountant" },
      ),
    ).rejects.toThrow("سند الصيرفة يُنشأ حصراً");
    expect(await snapshot()).toEqual(before);
  });

  it("retains the generic EXCHANGE posting restriction for a historical legacy voucher", async () => {
    const receiptId = await seedPending("EXCHANGE", "LEGACY");
    const before = await snapshot();
    await expect(approveVoucher(receiptId, owner)).rejects.toThrow(
      "تعذر تحديد الحساب المقابل للسند",
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each(["CHECK", "EXCHANGE"] as const)(
    "still rejects %s against native AP without partial financial writes",
    async (method) => {
      const receiptId = await seedPending(method, "NATIVE");
      const before = await snapshot();
      await expect(approveVoucher(receiptId, owner)).rejects.toThrow(
        "السند العام لا يسدد الفاتورة",
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["CASH", "CARD", "TRANSFER", "WALLET"] as const)(
    "still upgrades historical %s into exactly one native payment",
    async (method) => {
      const receiptId = await seedPending(method, "NATIVE");
      await approveVoucher(receiptId, owner);
      const after = await snapshot();
      expect(after.suppliers[0].currentBalance).toBe("90000.00");
      expect(after.requests).toHaveLength(1);
      expect(after.payments).toHaveLength(1);
      expect(after.payments[0]).toMatchObject({
        receiptId,
        paymentMethod: method,
        amount: "10000.00",
      });
      expect(after.allocations).toHaveLength(1);
      expect(after.allocations[0]).toMatchObject({
        supplierInvoiceId: 1,
        allocatedAmount: "10000.00",
      });
      expect(
        after.entries.filter((row) => row.receiptId === receiptId),
      ).toHaveLength(1);
      await approveVoucher(receiptId, owner);
      expect(await snapshot()).toEqual(after);
    },
  );
});
