import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createFulfillmentRequest,
  releaseFulfillmentRequest,
} from "../fulfillment/requests";
import { processPayment } from "../sale/payment";
import {
  initiateExternalPaymentAttempt,
  confirmExternalPaymentAttempt,
} from "../posExternalPayment";
import { confirmConsignmentDelivery } from "../delivery/courier";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";

const admin = { userId: 1, branchId: 1, role: "admin" };
const cashier = { userId: 2, branchId: 1, role: "cashier" };
function db() {
  const d = getDb();
  if (!d) throw new Error("isolated test DB required");
  return d;
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "fc-admin", role: "admin", branchId: 1 },
      { id: 2, openId: "fc-cashier", role: "cashier", branchId: 1 },
      { id: 3, openId: "fc-driver", role: "courier", branchId: 1 },
    ]);
  await db()
    .insert(s.customers)
    .values({
      id: 1,
      name: "عميل التوصيل",
      phone: "+9647701234567",
      currentBalance: "10000",
      creditLimit: null,
    });
  await db()
    .insert(s.deliveryParties)
    .values({
      id: 1,
      name: "مندوب الطلب",
      partyType: "INDIVIDUAL",
      userId: 3,
      currentBalance: "0",
      isActive: true,
    });
  await db()
    .insert(s.deliveryPartyMembers)
    .values({
      partyId: 1,
      userId: 3,
      memberRole: "DRIVER",
      isActive: true,
      createdBy: 1,
    });
  await db()
    .insert(s.invoices)
    .values({
      id: 1,
      invoiceNumber: "FC-INVOICE-1",
      branchId: 1,
      customerId: 1,
      total: "10000",
      subtotal: "10000",
      paidAmount: "0",
      status: "PENDING",
      paymentMode: "COD",
      createdBy: 2,
    });
});
async function dispatchRequest() {
  const request = await createFulfillmentRequest(
    {
      branchId: 1,
      customerId: 1,
      recipientName: "عميل التوصيل",
      recipientPhone: "07701234567",
      deliveryAddress: "بغداد / المنصور",
      partyId: 1,
      deliveryFee: "1000",
      feeCollection: "COURIER",
      sources: [{ invoiceId: 1 }],
      clientRequestId: "fc-request-create",
    },
    admin,
  );
  return releaseFulfillmentRequest(
    {
      id: request.id,
      expectedVersion: request.version,
      clientRequestId: "fc-request-release",
    },
    admin,
  );
}
async function payCard(amount = "4000", key = "fc-card-pay") {
  const deviceId = "FULFILLMENT-COUNTER-DEVICE";
  const attempt = await initiateExternalPaymentAttempt(
    {
      branchId: 1,
      channel: "SALES_COLLECTION",
      method: "CARD",
      amount,
      reference: `FC-CARD-${key}`,
      requestId: `${key}-proof`,
      deviceId,
      invoiceId: 1,
    },
    cashier,
  );
  await confirmExternalPaymentAttempt(
    {
      branchId: 1,
      channel: "SALES_COLLECTION",
      attemptId: attempt.attemptId,
      deviceId,
    },
    cashier,
  );
  const input = {
    invoiceId: 1,
    amount,
    method: "CARD" as const,
    clientRequestId: key,
    externalPaymentAttemptId: attempt.attemptId,
    externalPaymentDeviceId: deviceId,
  };
  return { input, result: await processPayment(input, cashier) };
}

describe("request goods collection while courier is in transit", () => {
  it("posts the actual CARD receipt once, releases exposure atomically, and requires a new courier claim ACK", async () => {
    const sent = await dispatchRequest();
    const [before] = await db().select().from(s.deliveryConsignments);
    const paid = await payCard();
    await processPayment(paid.input, cashier);
    const [invoice] = await db().select().from(s.invoices);
    const receipts = await db().select().from(s.receipts);
    const [cn] = await db().select().from(s.deliveryConsignments);
    expect(invoice).toMatchObject({ paidAmount: "4000.00", status: "PARTIALLY_PAID" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      invoiceId: 1,
      amount: "4000.00",
      paymentMethod: "CARD",
      cashBucket: null,
      shiftId: null,
    });
    expect(cn).toMatchObject({
      id: sent.consignmentId,
      codAmount: "10000.00",
      counterSettledAmount: "4000.00",
      collectedAmount: "0.00",
      parcelStatus: "OUT_FOR_DELIVERY",
      status: "DISPATCHED",
      codClaimVersion: before.codClaimVersion + 1,
    });
    expect(cn.courierAckClaimVersion).not.toBe(cn.codClaimVersion);
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "6000.00",
    );
    expect(
      (await db().select().from(s.deliveryLedgerEntries)).filter(
        (r) => r.entryType === "COD_RELEASED",
      ),
    ).toHaveLength(1);
    const changed = (await db().select().from(s.deliveryEvents)).filter(
      (r) => r.eventType === "COD_CLAIM_CHANGED",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0].payload).toMatchObject({
      invoiceId: 1,
      receiptId: receipts[0].id,
      claimVersion: cn.codClaimVersion,
      ackRequired: true,
    });
    expect("notice" in paid.result && paid.result.notice).toMatch(
      /مطالبة الناقل/,
    );
  });
  it("records proven old courier cash as real custody with a refund liability, never as a second invoice payment", async () => {
    const sent = await dispatchRequest();
    await payCard();
    await confirmConsignmentDelivery(
      {
        consignmentId: sent.consignmentId,
        collectedAmount: "10000",
        collectionEvidence:
          "قبض المندوب المبلغ القديم قبل استلام تحديث الكاونتر",
        clientRequestId: "fc-old-courier-cash",
      },
      { userId: 3 },
    );
    const [invoice] = await db().select().from(s.invoices);
    expect(invoice.paidAmount).toBe("10000.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "0.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    const entries = await db().select().from(s.accountingEntries);
    expect(
      entries.find((r) =>
        r.dedupeKey?.startsWith("FULFILLMENT_COURIER_EXCESS:"),
      )?.amount,
    ).toBe("4000.00");
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("10000.00");
  });
  it("keeps legacy in-transit invoices blocked and leaves a confirmed CARD proof recoverable", async () => {
    await dispatchInvoiceToDelivery(
      {
        invoiceId: 1,
        partyId: 1,
        deliveryFee: "0",
        clientRequestId: "fc-legacy-dispatch",
      },
      admin,
    );
    await expect(payCard()).rejects.toThrow(/بالطريق مع المندوب/);
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(
      (await db().select().from(s.deliveryConsignments))[0]
        .counterSettledAmount,
    ).toBe("0.00");
    expect((await db().select().from(s.externalPaymentAttempts))[0].state).toBe(
      "CONFIRMED",
    );
  });
});
