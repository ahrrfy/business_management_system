import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createFulfillmentRequest,
  reassignFulfillmentRequest,
  releaseFulfillmentRequest,
} from "../fulfillment/requests";
import { processPayment } from "../sale/payment";
import {
  initiateExternalPaymentAttempt,
  confirmExternalPaymentAttempt,
} from "../posExternalPayment";
import {
  acknowledgeConsignmentClaim,
  confirmConsignmentDelivery,
} from "../delivery/courier";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { cancelShipmentAssignment } from "../delivery/shipmentOperations";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { openShift } from "../shiftService";

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
async function dispatchRequest(grouped = false) {
  if (grouped)
    await db().insert(s.invoices).values({
      id: 2,
      invoiceNumber: "FC-PAID-MEMBER",
      branchId: 1,
      customerId: 1,
      total: "2000",
      subtotal: "2000",
      paidAmount: "2000",
      status: "PAID",
      paymentMode: "COD",
      createdBy: 2,
    });
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
      sources: grouped
        ? [{ invoiceId: 1 }, { invoiceId: 2 }]
        : [{ invoiceId: 1 }],
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
  it.each([false, true])(
    "rebases the replacement claim after a real counter payment (grouped=%s), then collects and remits the full remaining 6000 exactly once",
    async (grouped) => {
      const sent = await dispatchRequest(grouped);
      await payCard();
      const [oldClaim] = await db()
        .select()
        .from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.id, sent.consignmentId));
      await acknowledgeConsignmentClaim(
        {
          consignmentId: sent.consignmentId,
          expectedClaimVersion: oldClaim.codClaimVersion,
          clientRequestId: "fc-before-reassign-ack",
        },
        { userId: 3 },
      );
      const originalReceipts = await db().select().from(s.receipts);
      const originalEvents = await db().select().from(s.deliveryEvents);
      const originalLedger = await db().select().from(s.deliveryLedgerEntries);
      const stockBefore = await db().select().from(s.inventoryMovements);
      const salesBefore = (
        await db().select().from(s.accountingEntries)
      ).filter((r) => r.entryType === "SALE");
      await cancelShipmentAssignment(
        {
          consignmentId: sent.consignmentId,
          reason: "تأجيل التوصيل بعد قبض الكاونتر",
          clientRequestId: "fc-reassign-cancel",
        },
        admin,
      );
      const released = (
        await db().select().from(s.deliveryLedgerEntries)
      ).filter((r) => r.entryType === "COD_RELEASED");
      expect(released.map((r) => r.amount).sort()).toEqual([
        "4000.00",
        "6000.00",
      ]);
      const reassign = {
        id: sent.request.id,
        expectedVersion: sent.request.version,
        consignmentId: sent.consignmentId,
        clientRequestId: "fc-reassign",
      };
      await reassignFulfillmentRequest(reassign, admin);
      const claims = await db().select().from(s.deliveryConsignments);
      const replacement = claims.find((r) => r.id === sent.consignmentId)!;
      expect(replacement).toMatchObject({
        codAmount: "6000.00",
        counterSettledAmount: "0.00",
        codClaimVersion: oldClaim.codClaimVersion + 1,
      });
      expect(claims.every((r) => r.counterSettledAmount === "0.00")).toBe(true);
      expect(replacement.courierAckClaimVersion).not.toBe(
        replacement.codClaimVersion,
      );
      const replacementEvents = await db().select().from(s.deliveryEvents);
      const replacementLedger = await db()
        .select()
        .from(s.deliveryLedgerEntries);
      await reassignFulfillmentRequest(reassign, admin);
      expect(await db().select().from(s.deliveryEvents)).toEqual(
        replacementEvents,
      );
      expect(await db().select().from(s.deliveryLedgerEntries)).toEqual(
        replacementLedger,
      );
      expect(await db().select().from(s.receipts)).toEqual(originalReceipts);
      expect(
        replacementEvents.filter((r) =>
          originalEvents.some((old) => old.id === r.id),
        ),
      ).toEqual(originalEvents);
      expect(
        replacementLedger.filter((r) =>
          originalLedger.some((old) => old.id === r.id),
        ),
      ).toEqual(originalLedger);
      expect(
        replacementEvents.find(
          (r) =>
            r.eventType === "COD_CLAIM_CHANGED" &&
            r.consignmentId === replacement.id &&
            (r.payload as { claimVersion?: number } | null)?.claimVersion ===
              replacement.codClaimVersion,
        )?.payload,
      ).toMatchObject({
        invoiceId: 1,
        claimVersion: replacement.codClaimVersion,
        ackRequired: true,
      });
      await expect(
        acknowledgeConsignmentClaim(
          {
            consignmentId: sent.consignmentId,
            expectedClaimVersion: oldClaim.codClaimVersion,
            clientRequestId: "fc-stale-reassign-ack",
          },
          { userId: 3 },
        ),
      ).rejects.toThrow(/تغيرت المطالبة/);
      await acknowledgeConsignmentClaim(
        {
          consignmentId: sent.consignmentId,
          expectedClaimVersion: replacement.codClaimVersion,
          clientRequestId: "fc-reassign-ack",
        },
        { userId: 3 },
      );
      const collect = {
        consignmentId: sent.consignmentId,
        collectedAmount: "6000",
        clientRequestId: "fc-reassign-collect",
      };
      await confirmConsignmentDelivery(collect, { userId: 3 });
      await confirmConsignmentDelivery(collect, { userId: 3 });
      await openShift(
        { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
        admin,
      );
      const remit = {
        branchId: 1,
        partyId: 1,
        lines: [{ consignmentId: sent.consignmentId, collectedAmount: "6000" }],
        countedCash: "6000",
        shiftType: "RECEPTION" as const,
        clientRequestId: "fc-reassign-remit",
      };
      await recordDeliveryRemittance(remit, admin);
      await recordDeliveryRemittance(remit, admin);
      const invoices = await db().select().from(s.invoices);
      expect(invoices.find((r) => r.id === 1)?.paidAmount).toBe("10000.00");
      expect(invoices).toHaveLength(grouped ? 2 : 1);
      expect((await db().select().from(s.customers))[0].currentBalance).toBe(
        "0.00",
      );
      expect(
        (await db().select().from(s.deliveryParties))[0].currentBalance,
      ).toBe("0.00");
      expect(
        (await db().select().from(s.deliveryConsignments)).find(
          (r) => r.id === sent.consignmentId,
        ),
      ).toMatchObject({
        codAmount: "6000.00",
        counterSettledAmount: "0.00",
        collectedAmount: "6000.00",
        moneyStatus: "SETTLED",
      });
      const receipts = await db().select().from(s.receipts);
      expect(receipts.filter((r) => r.paymentMethod === "CARD")).toEqual(
        originalReceipts,
      );
      expect(receipts.filter((r) => r.paymentMethod === "CASH")).toHaveLength(
        1,
      );
      expect(receipts.find((r) => r.paymentMethod === "CASH")?.amount).toBe(
        "6000.00",
      );
      expect(await db().select().from(s.inventoryMovements)).toEqual(
        stockBefore,
      );
      expect(
        (await db().select().from(s.accountingEntries)).filter(
          (r) => r.entryType === "SALE",
        ),
      ).toEqual(salesBefore);
      const finalLedger = await db().select().from(s.deliveryLedgerEntries);
      const total = (type: string) =>
        finalLedger
          .filter((r) => r.entryType === type)
          .reduce((sum, r) => sum + Number(r.amount), 0);
      expect(total("COD_ASSIGNED")).toBe(16000);
      expect(total("COD_RELEASED")).toBe(10000);
      expect(total("COD_REMITTED")).toBe(6000);
    },
  );

  it("keeps a legacy reassignment without counter settlement at its original COD and replays the replacement claim once", async () => {
    const first = await dispatchInvoiceToDelivery(
      {
        invoiceId: 1,
        partyId: 1,
        deliveryFee: "0",
        clientRequestId: "fc-legacy-first",
      },
      admin,
    );
    await cancelShipmentAssignment(
      {
        consignmentId: first.consignmentId,
        reason: "إعادة جدولة",
        clientRequestId: "fc-legacy-cancel",
      },
      admin,
    );
    const input = {
      invoiceId: 1,
      partyId: 1,
      deliveryFee: "0",
      clientRequestId: "fc-legacy-reassign",
    };
    await dispatchInvoiceToDelivery(input, admin);
    const [claim] = await db().select().from(s.deliveryConsignments);
    const events = await db().select().from(s.deliveryEvents);
    await dispatchInvoiceToDelivery(input, admin);
    expect((await db().select().from(s.deliveryConsignments))[0]).toEqual(
      claim,
    );
    expect(claim).toMatchObject({
      id: first.consignmentId,
      codAmount: "10000.00",
      counterSettledAmount: "0.00",
      codClaimVersion: 2,
    });
    expect(await db().select().from(s.deliveryEvents)).toEqual(events);
    expect(
      events.filter((r) => r.eventType === "COD_CLAIM_CHANGED"),
    ).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
  });

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
