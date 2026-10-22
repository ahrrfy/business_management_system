import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createVoucher,
  approveVoucher,
  rejectVoucher,
} from "../voucherService";
import {
  decideSupplierPayment,
  requestSupplierPayment,
} from "../purchase/supplierPayments";
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

const reviewer = { userId: 8, branchId: 1, role: "accountant", isOwner: true };
beforeEach(async () => {
  vi.stubEnv("ROLLOUT_OWNER_ONLY_APPROVAL", "OFF");
  await db().insert(s.users).values({
    id: 8,
    openId: "voucher-reviewer",
    name: "مراجع",
    role: "accountant",
    branchId: 1,
  });
});
afterEach(() => vi.unstubAllEnvs());
async function pendingRequest() {
  const [request] = await db().select().from(s.supplierPaymentRequests);
  return request;
}
function decision(requestId: number, action: "APPROVE" | "REJECT" = "APPROVE") {
  return {
    requestId,
    decisionKey: randomUUID(),
    action,
    reviewReason: "مراجعة سداد المورد",
  };
}
async function decideNative(
  requestId: number,
  action: "APPROVE" | "REJECT" = "APPROVE",
) {
  return decideSupplierPayment(decision(requestId, action), owner);
}
async function setNet(balance: string) {
  await db()
    .update(s.suppliers)
    .set({ currentBalance: balance })
    .where(eq(s.suppliers.id, 1));
}

describe("linked supplier voucher owner and net AP boundary", () => {
  it.each(["CARD", "TRANSFER", "WALLET"] as const)(
    "requires the actual active DB owner for native %s approval even with policy OFF",
    async (paymentMethod) => {
      await createVoucher(
        {
          ...input(),
          paymentMethod,
          cardLastFour: paymentMethod === "CARD" ? "1234" : undefined,
        },
        maker,
      );
      const request = await pendingRequest();
      const before = await state();
      await expect(
        decideSupplierPayment(decision(request.id), reviewer),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await state()).toEqual(before);
      await decideNative(request.id);
      const after = await state();
      expect(after.payments).toHaveLength(1);
      expect(after.suppliers[0].currentBalance).toBe("50000.00");
      expect(after.receipts[0].approvedBy).toBe(owner.userId);
    },
  );
  it("rejects an inactive DB owner despite a forged owner flag", async () => {
    await createVoucher(input(), maker);
    const request = await pendingRequest();
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, owner.userId));
    const before = await state();
    await expect(
      decideSupplierPayment(decision(request.id), { ...owner, isOwner: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await state()).toEqual(before);
  });
  it.each(["voucher", "native"] as const)(
    "blocks %s approval when net AP is below otherwise payable invoice debt",
    async (endpoint) => {
      await setNet("40000.00");
      const voucher = await createVoucher(input(), maker);
      const request = await pendingRequest();
      const before = await state();
      const approval =
        endpoint === "voucher"
          ? approveVoucher(voucher.receiptId, owner)
          : decideNative(request.id);
      await expect(approval).rejects.toThrow(/الرصيد المستحق للمورد/);
      expect(await state()).toEqual(before);
    },
  );
  it.each(["voucher", "native"] as const)(
    "allows the exact locked net through %s and preserves valid replay at zero balance",
    async (endpoint) => {
      await setNet("50000.00");
      const voucher = await createVoucher(input(), maker);
      const request = await pendingRequest();
      const payload = decision(request.id);
      if (endpoint === "voucher")
        await approveVoucher(voucher.receiptId, owner);
      else await decideSupplierPayment(payload, owner);
      const before = await state();
      expect(before.suppliers[0].currentBalance).toBe("0.00");
      expect(before.payments).toHaveLength(1);
      if (endpoint === "voucher")
        expect((await approveVoucher(voucher.receiptId, owner)).replayed).toBe(
          true,
        );
      else
        expect((await decideSupplierPayment(payload, owner)).idempotent).toBe(
          true,
        );
      expect(await state()).toEqual(before);
    },
  );
  it.each(["voucher", "native"] as const)(
    "rechecks changed net before %s approval and still permits rejection/release",
    async (endpoint) => {
      const voucher = await createVoucher(input(), maker);
      const request = await pendingRequest();
      await setNet("49999.99");
      const before = await state();
      await expect(
        endpoint === "voucher"
          ? approveVoucher(voucher.receiptId, owner)
          : decideNative(request.id),
      ).rejects.toThrow(/الرصيد المستحق للمورد/);
      expect(await state()).toEqual(before);
      if (endpoint === "voucher")
        await rejectVoucher(voucher.receiptId, owner, "انخفض صافي المستحق");
      else await decideNative(request.id, "REJECT");
      const after = await state();
      expect(after.suppliers[0].currentBalance).toBe("49999.99");
      expect(after.payments).toHaveLength(0);
      expect(after.entries).toEqual(before.entries);
      expect(after.requests[0].status).toBe("REJECTED");
      expect(
        after.requestAllocations.every((row) => row.activeInvoiceGuard == null),
      ).toBe(true);
      expect(after.receipts[0].approvalStatus).toBe("REJECTED");
    },
  );
  it("preserves unlinked native owner-policy and invoice-based settlement with return credits", async () => {
    await setNet("27702.00");
    const request = await requestSupplierPayment(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: randomUUID(),
        currency: "IQD",
        amount: "100000.00",
        currencyAmount: "100000.00",
        paymentMethod: "TRANSFER",
        externalReference: "ORIGINAL-BANK-REF",
        evidenceType: "TRANSFER_RECEIPT",
        evidenceReference: "saved-bank-evidence",
        reason: "سداد أصلي مستقل عن السندات",
        allocations: [
          {
            supplierInvoiceId: 1,
            invoiceVersion: 1,
            amount: "60000.00",
            currencyAmount: "60000.00",
          },
          {
            supplierInvoiceId: 2,
            invoiceVersion: 1,
            amount: "40000.00",
            currencyAmount: "40000.00",
          },
        ],
      },
      maker,
    );
    // Independent accountant remains allowed by the general legacy policy.
    await decideSupplierPayment(decision(request.requestId), {
      ...reviewer,
      isOwner: false,
    });
    const after = await state();
    expect(after.payments).toHaveLength(1);
    expect(after.suppliers[0].currentBalance).toBe("-72298.00");
  });
});
