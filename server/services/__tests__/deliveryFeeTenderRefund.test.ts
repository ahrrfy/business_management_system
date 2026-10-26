import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createConfirmedPosSale,
  initiateExternalPaymentAttempt,
  confirmExternalPaymentAttempt,
  type ConfirmedPosSaleInput,
} from "../posExternalPayment";
import { returnConsignment } from "../delivery/returns";
import { returnShipment } from "../delivery/shipmentOperations";
import {
  approveDeliveryPaymentRefund,
  requestReturnedInvoiceFeeRefund,
} from "../delivery/paymentRefunds";
import { dispatchInvoiceShipment } from "../delivery/shipments";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { returnSale } from "../returnService";
import { reserveExternalRefundConfirmationTx } from "../externalRefundConfirmation";
import { withTx } from "../tx";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const cashier = { userId: 1, branchId: 1, role: "cashier" } as const;
const owner = { userId: 2, branchId: 1, role: "admin" } as const;
const deviceId = "FEE-RETURN-DEVICE";
const db = () => getDb()!;
let sequence = 0;
const key = () => `fee-refund-${Date.now()}-${++sequence}`;
const TABLES = [
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "documentEffects",
  "externalPaymentAttempts",
  "auditLogs",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "deliveryShipmentMembers",
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
];

beforeEach(async () => {
  await truncateTables(TABLES);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "fee-return-cashier",
        name: "Cashier",
        role: "cashier",
        branchId: 1,
      },
      {
        id: 2,
        openId: "fee-return-owner",
        name: "Owner",
        role: "admin",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "Buyer",
    currentBalance: "0",
    creditLimit: "1000000",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    partyType: "COMPANY",
    name: "Company",
    branchId: 1,
    currentBalance: "0",
    defaultFee: "5000",
  });
  await db().insert(s.products).values({ id: 1, name: "Book" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "FEE-RETURN-BOOK", costPrice: "1000" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "50000" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 20 });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    shiftType: "RECEPTION",
    openingBalance: "0",
    status: "OPEN",
    openGuard: "1:1:RECEPTION",
  });
  await db()
    .insert(s.doubleEntrySettings)
    .values({ id: 1, mode: "SHADOW", shadowCycleId: "fee-return-test" });
});

async function sale(method: "CASH" | "CARD", dispatch = true, held = true) {
  const input: ConfirmedPosSaleInput = {
    branchId: 1,
    shiftId: 1,
    customerId: 1,
    deviceId,
    sourceType: "POS",
    clientRequestId: key(),
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    payment: { method, amount: "50000" },
    ...(held ? { deliveryFeeHeld: "5000" } : {}),
    ...(dispatch
      ? {
          delivery: {
            partyId: 1,
            fee: "5000",
            feeCollection: "COUNTER",
            recipientPhone: "07700000000",
            externalTrackingRef: key(),
          },
        }
      : {}),
  };
  if (method === "CARD") {
    const proof = await initiateExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "POS",
        method,
        amount: held ? "55000" : "50000",
        reference: key(),
        requestId: key(),
        deviceId,
      },
      cashier,
    );
    await confirmExternalPaymentAttempt(
      { attemptId: proof.attemptId, branchId: 1, channel: "POS", deviceId },
      cashier,
    );
    input.payment = {
      method,
      amount: "50000",
      externalPaymentAttemptId: proof.attemptId,
    };
    if (held) input.deliveryFeeTender = { method, combinedWithPaymentIndex: 0 };
  }
  const result = await createConfirmedPosSale(input, cashier);
  const cn = (
    await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.invoiceId, result.invoiceId))
  )[0];
  return { ...result, cn };
}
async function rows(invoiceId: number) {
  return db()
    .select()
    .from(s.receipts)
    .where(eq(s.receipts.invoiceId, invoiceId));
}
async function invoice(invoiceId: number) {
  return (
    await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId))
  )[0];
}
async function balance() {
  return (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0]
    .currentBalance;
}
async function cashNet() {
  return (
    await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.paymentMethod, "CASH"),
          eq(s.receipts.status, "COMPLETED"),
        ),
      )
  )
    .reduce(
      (n, r) => n.plus(money(r.amount).times(r.direction === "IN" ? 1 : -1)),
      money(0),
    )
    .toFixed(2);
}
async function standaloneReturn(invoiceId: number) {
  const item = (
    await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, invoiceId))
  )[0];
  return returnSale(
    {
      invoiceId,
      lines: [{ invoiceItemId: item.id, baseQuantity: 1 }],
      restock: true,
      operatorReason: "returned separately",
      clientRequestId: key(),
    },
    owner,
  );
}

describe("delivery returns retain the actual original payment rails", () => {
  it("fully paid CARD goods plus fee stays pending until owner confirms real provider refunds; replay changes neither cash nor AR", async () => {
    const sold = await sale("CARD");
    // A closed shift proves that a card return has no implicit drawer dependency.
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(s.shifts.id, 1));
    const requestKey = key();
    const returned = await returnConsignment(sold.cn.id, {
      ...cashier,
      clientRequestId: requestKey,
      returnReason: "customer refused",
    });
    const pending = (await rows(sold.invoiceId)).filter(
      (r) => r.direction === "OUT",
    );
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.amount).sort()).toEqual([
      "5000.00",
      "50000.00",
    ]);
    expect(
      pending.every(
        (r) =>
          r.paymentMethod === "CARD" &&
          r.cashBucket == null &&
          r.status === "PENDING" &&
          r.approvalStatus === "PENDING_APPROVAL",
      ),
    ).toBe(true);
    expect((await invoice(sold.invoiceId)).paidAmount).toBe("50000.00");
    expect(await balance()).toBe("-50000.00");
    expect(await cashNet()).toBe("0.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(20);
    expect(
      await returnConsignment(sold.cn.id, {
        ...cashier,
        clientRequestId: requestKey,
        returnReason: "customer refused",
      }),
    ).toMatchObject({ idempotentReplay: true });
    expect(
      (await rows(sold.invoiceId)).filter((r) => r.direction === "OUT"),
    ).toHaveLength(2);
    await expect(
      approveDeliveryPaymentRefund(
        {
          receiptId: pending[0].id,
          providerReference: "REFUND-CARD-1",
          clientRequestId: key(),
        },
        cashier,
      ),
    ).rejects.toThrow();
    for (const pendingReceipt of pending) {
      const confirmation = {
        receiptId: pendingReceipt.id,
        providerReference: `REFUND-${pendingReceipt.id}`,
        clientRequestId: key(),
      };
      expect(
        await approveDeliveryPaymentRefund(confirmation, owner),
      ).toMatchObject({ replayed: false });
      expect(
        await approveDeliveryPaymentRefund(confirmation, owner),
      ).toMatchObject({ replayed: true });
    }
    expect(await invoice(sold.invoiceId)).toMatchObject({
      status: "RETURNED",
      paidAmount: "0.00",
      returnedTotal: "50000.00",
    });
    expect(await balance()).toBe("0.00");
    expect(await cashNet()).toBe("0.00");
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, sold.invoiceId));
    expect(
      entries
        .filter((e) => e.entryType === "DELIVERY_FEE_HELD")
        .reduce((n, e) => n.plus(e.amount), money(0))
        .toFixed(2),
    ).toBe("0.00");
    expect(entries.filter((e) => e.entryType === "PAYMENT_OUT")).toHaveLength(
      1,
    );
    expect(returned).toHaveProperty("pendingFeeRefundReceiptId");
  });

  it("one external refund success cannot approve both goods and fee requests", async () => {
    const sold = await sale("CARD");
    await returnConsignment(sold.cn.id, {
      ...cashier,
      returnReason: "return",
      clientRequestId: key(),
    });
    const pending = (await rows(sold.invoiceId)).filter(
      (r) => r.direction === "OUT",
    );
    await approveDeliveryPaymentRefund(
      {
        receiptId: pending[0].id,
        providerReference: "SHARED-PROVIDER-REF",
        clientRequestId: key(),
      },
      owner,
    );
    await expect(
      approveDeliveryPaymentRefund(
        {
          receiptId: pending[1].id,
          providerReference: "shared-provider-ref",
          clientRequestId: key(),
        },
        owner,
      ),
    ).rejects.toThrow();
    expect(
      (await rows(sold.invoiceId)).filter(
        (r) => r.direction === "OUT" && r.status === "COMPLETED",
      ),
    ).toHaveLength(1);
    await expect(
      withTx((tx) =>
        reserveExternalRefundConfirmationTx(tx, {
          receiptId: 999,
          method: "CARD",
          reference: "SHARED-PROVIDER-REF",
        }),
      ),
    ).rejects.toThrow();
  });

  it("legacy CASH returns the exact goods and fee receipts from the guarded drawer once", async () => {
    const sold = await sale("CASH"),
      requestKey = key();
    expect(await cashNet()).toBe("55000.00");
    await returnShipment(
      {
        consignmentId: sold.cn.id,
        reason: "customer refused",
        clientRequestId: requestKey,
        refundShiftId: 1,
      },
      cashier,
    );
    expect(
      await returnShipment(
        {
          consignmentId: sold.cn.id,
          reason: "customer refused",
          clientRequestId: requestKey,
          refundShiftId: 1,
        },
        cashier,
      ),
    ).toMatchObject({ idempotentReplay: true });
    const refunded = (await rows(sold.invoiceId)).filter(
      (r) => r.direction === "OUT",
    );
    expect(refunded).toHaveLength(2);
    expect(
      refunded.every(
        (r) =>
          r.paymentMethod === "CASH" &&
          r.cashBucket === "DRAWER" &&
          r.status === "COMPLETED",
      ),
    ).toBe(true);
    expect(await cashNet()).toBe("0.00");
    expect(await balance()).toBe("0.00");
    expect((await invoice(sold.invoiceId)).paidAmount).toBe("0.00");
  });

  it("separate returnSale can recover the original held card fee explicitly without restocking or refunding goods again", async () => {
    const sold = await sale("CARD");
    await standaloneReturn(sold.invoiceId);
    const stock = (await db().select().from(s.branchStock))[0].quantity;
    const request = {
      consignmentId: sold.cn.id,
      reason: "return completed separately",
      clientRequestId: key(),
    };
    const pending = await requestReturnedInvoiceFeeRefund(request, cashier);
    expect(pending.pendingFeeRefundReceiptId).toBeTypeOf("number");
    expect(
      await requestReturnedInvoiceFeeRefund(request, cashier),
    ).toMatchObject({
      pendingFeeRefundReceiptId: pending.pendingFeeRefundReceiptId,
      replayed: true,
    });
    const fee = (await rows(sold.invoiceId)).find(
      (r) => r.id === pending.pendingFeeRefundReceiptId,
    )!;
    expect(fee).toMatchObject({
      paymentMethod: "CARD",
      amount: "5000.00",
      status: "PENDING",
      cashBucket: null,
    });
    await approveDeliveryPaymentRefund(
      {
        receiptId: fee.id,
        providerReference: "LATE-FEE-REFUND",
        clientRequestId: key(),
      },
      owner,
    );
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(stock);
    expect(await cashNet()).toBe("0.00");
  });

  it("the original group fee waits for the final independently returned member", async () => {
    const first = await sale("CARD"),
      second = await sale("CARD", false, false);
    const originalReceipts = await rows(first.invoiceId);
    await cancelDeliveryAssignment(
      {
        consignmentId: first.cn.id,
        reason: "regroup before physical dispatch",
        clientRequestId: key(),
        physicalHeldConfirmed: true,
      },
      owner,
    );
    expect(await rows(first.invoiceId)).toEqual(originalReceipts);
    const group = await dispatchInvoiceShipment(
      {
        invoiceId: first.invoiceId,
        invoiceIds: [first.invoiceId, second.invoiceId],
        partyId: 1,
        deliveryFee: "5000",
        feeCollection: "COUNTER",
        externalTrackingRef: first.cn.externalTrackingRef,
        recipientPhone: "07700000000",
        clientRequestId: key(),
      },
      owner,
    );
    expect(group.leaderConsignmentId).toBe(first.cn.id);
    await standaloneReturn(first.invoiceId);
    await expect(
      requestReturnedInvoiceFeeRefund(
        {
          consignmentId: group.leaderConsignmentId,
          reason: "first member only",
          clientRequestId: key(),
        },
        cashier,
      ),
    ).rejects.toThrow(/عضو|نشط/);
    await standaloneReturn(second.invoiceId);
    const pending = await requestReturnedInvoiceFeeRefund(
      {
        consignmentId: group.leaderConsignmentId,
        reason: "all members returned",
        clientRequestId: key(),
      },
      cashier,
    );
    expect(pending.pendingFeeRefundReceiptId).toBeTypeOf("number");
    expect(
      (await rows(first.invoiceId)).filter(
        (r) =>
          r.direction === "OUT" &&
          r.referenceNumber === `DLV-FEE-INV-${first.invoiceId}`,
      ),
    ).toHaveLength(1);
    expect(await cashNet()).toBe("0.00");
  });
});
