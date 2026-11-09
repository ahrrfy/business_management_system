import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { recordCompanyStatement, recordStaffDeliveryConfirmation } from "../delivery/companyStatement";
import { recordDeliveryRemittance, recordDeliveryRemittanceInTx } from "../delivery/remittance";
import { payDeliveryFee, payPartyDeliveryFees } from "../delivery/fees";
import { listOpenConsignments, listPartyRemittances } from "../delivery/queries";
import { previewDailySettlementTx, settleDailyTx } from "../delivery/dailySettlement";
import { returnByBarcode } from "../delivery/barcodeReturnService";
import { mutateWorkflowAssignment } from "../delivery/workflow/assignment";
import { currentWorkflowActorTx, loadWorkflowPreviewTx } from "../delivery/workflow/preview";
import { cancelInvoiceDeliveryTx, invoiceDeliveryAmendmentTx } from "../delivery/invoiceAmendment";
import {
  confirmShipmentDelivery,
  cancelShipmentAssignment,
  markShipmentFailed,
  reassignShipmentDriver,
  returnShipment,
} from "../delivery/shipmentOperations";
import { returnConsignment } from "../delivery/returns";
import { consignmentReturnPreflight } from "../workOrder/refundPreflight";
import { openShift } from "../shiftService";
import { returnSale } from "../returnService";
import { courierRouter } from "../../routers/courierRouter";
import {
  acknowledgeConsignmentClaim,
  confirmConsignmentDelivery,
  listMyDeliveries,
  transitionConsignmentParcel,
} from "../delivery/courier";

const actor = { userId: 1, branchId: 1, role: "cashier" };
function db() {
  const value = getDb();
  if (!value) throw new Error("Isolated test DB is required");
  return value;
}
const confirm = {
  consignmentId: 11,
  collectedAmount: "300.00",
  evidence: "اتصال المندوب",
  clientRequestId: "confirm-group",
};

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الثاني", code: "B2", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "shipment-cashier", role: "cashier", branchId: 1 },
      { id: 2, openId: "shipment-driver", role: "courier", branchId: 1 },
    ]);
  await db()
    .insert(s.customers)
    .values({
      id: 1,
      name: "عميل الشحنة",
      currentBalance: "300.00",
      creditLimit: null,
    });
  await db()
    .insert(s.deliveryParties)
    .values({
      id: 1,
      name: "شركة التوصيل",
      partyType: "COMPANY",
      currentBalance: "0.00",
      isActive: true,
    });
  await db()
    .insert(s.deliveryPartyMembers)
    .values({
      partyId: 1,
      userId: 2,
      memberRole: "DRIVER",
      isActive: true,
      createdBy: 1,
    });
  await db()
    .insert(s.invoices)
    .values(
      [100, 200].map((total, index) => ({
        id: index + 1,
        invoiceNumber: `SHIPMENT-INV-${index + 1}`,
        sourceType: "POS" as const,
        branchId: 1,
        customerId: 1,
        subtotal: String(total),
        total: String(total),
        paidAmount: "0.00",
        createdBy: 1,
      })),
    );
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "SHIPMENT-NB", costPrice: "40.00" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 7 });
  await db()
    .insert(s.invoiceItems)
    .values(
      [100, 200].map((total, index) => ({
        invoiceId: index + 1,
        variantId: 1,
        quantity: String(index + 1),
        baseQuantity: index + 1,
        unitPrice: "100.00",
        unitCost: "40.00",
        lineCost: String(40 * (index + 1)),
        total: String(total),
      })),
    );
  await db()
    .insert(s.inventoryMovements)
    .values(
      [1, 2].map((quantity, index) => ({
        variantId: 1,
        branchId: 1,
        quantity,
        movementType: "OUT" as const,
        referenceType: "INVOICE",
        referenceId: index + 1,
        createdBy: 1,
      })),
    );
  await db()
    .insert(s.deliveryConsignments)
    .values(
      [100, 200].map((amount, index) => ({
        id: 11 + index,
        consignmentNumber: `SHIPMENT-CN-${11 + index}`,
        partyId: 1,
        branchId: 1,
        invoiceId: index + 1,
        sourceId: index + 1,
        sourceType: "INVOICE" as const,
        endCustomerId: 1,
        codAmount: String(amount),
        deliveryFee: index === 0 ? "5.00" : "0.00",
        feeCollection: "SHOP" as const,
        parcelStatus: "OUT_FOR_DELIVERY" as const,
        externalTrackingRef: index === 0 ? "SHIPMENT-TRACK" : null,
        dispatchedBy: 1,
      })),
    );
  await db()
    .insert(s.deliveryShipmentMembers)
    .values(
      [11, 12].map((consignmentId) => ({
        consignmentId,
        leaderConsignmentId: 11,
        createdBy: 1,
      })),
    );
});

async function snapshot() {
  return {
    cn: await db().select().from(s.deliveryConsignments),
    invoices: await db().select().from(s.invoices),
    party: await db().select().from(s.deliveryParties),
    customers: await db().select().from(s.customers),
    stock: await db().select().from(s.branchStock),
    movements: await db().select().from(s.inventoryMovements),
    entries: await db().select().from(s.accountingEntries),
    ledger: await db().select().from(s.deliveryLedgerEntries),
    events: await db().select().from(s.deliveryEvents),
    receipts: await db().select().from(s.receipts),
    remittances: await db().select().from(s.deliveryRemittances),
    remittanceLines: await db().select().from(s.deliveryRemittanceLines),
    statementHeaders: await db().select().from(s.deliveryCompanyStatements),
    statementBatches: await db().select().from(s.deliveryCompanyStatementBatches),
    keys: await db().select().from(s.idempotencyKeys),
  };
}

async function returnFeeLeader(fee: string, requestId: string) {
  await db().update(s.deliveryConsignments).set({ sourceType: "ONLINE_ORDER", deliveryFee: fee })
    .where(eq(s.deliveryConsignments.id, 11));
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 1)))[0];
  await returnSale({ invoiceId: 1, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
    restock: true, clientRequestId: requestId }, actor);
}

describe("one physical shipment with independent invoice accounting", () => {
  it("rejects a stale courier display even after another device acknowledges the new claim, and replays success", async () => {
    await db().update(s.deliveryConsignments).set({ assignedUserId: 2 });
    const oldView = (await listMyDeliveries(2)).toDeliver.find((row) => row.id === 11)!;
    expect(oldView).toMatchObject({ codClaimVersion: 1, codDue: "300.00" });
    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2));
    await returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "claim-view-return" }, actor);
    const currentView = (await listMyDeliveries(2)).toDeliver.find((row) => row.id === 11)!;
    const view = { expectedConsignmentIds: currentView.consignmentIds!, expectedClaimAmount: currentView.codDue,
      expectedConsignmentClaims: currentView.consignmentClaims!.map(({ consignmentId, amount }) => ({ consignmentId, amount })) };
    const caller = courierRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1", method: "POST" }, res: {}, sessionId: null, platformAdmin: null,
      user: { id: 2, role: "courier", branchId: 1, permissionsOverride: null, totpEnabledAt: new Date(), isActive: true },
    } as never);
    const beforeAck = await snapshot();
    await expect(caller.acknowledgeConsignmentClaim({ consignmentId: 11, expectedClaimVersion: 2,
      clientRequestId: "claim-view-ack-no-amount" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.acknowledgeConsignmentClaim({ consignmentId: 11, expectedClaimVersion: 2, ...view,
      expectedConsignmentClaims: [{ consignmentId: 11, amount: "150.00" }, { consignmentId: 12, amount: "50.00" }],
      clientRequestId: "claim-view-ack-offset" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(beforeAck);
    const ack = { consignmentId: 11, expectedClaimVersion: 2, ...view, clientRequestId: "claim-view-other-device-ack" };
    await caller.acknowledgeConsignmentClaim(ack);
    const before = await snapshot();
    await expect(caller.confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 1,
      clientRequestId: "claim-view-stale" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.confirmConsignmentDelivery({ consignmentId: 11,
      clientRequestId: "claim-view-old-client" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2,
      clientRequestId: "claim-view-no-amount" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(view).toEqual({ expectedConsignmentIds: [11, 12], expectedClaimAmount: "200.00",
      expectedConsignmentClaims: [{ consignmentId: 11, amount: "100.00" }, { consignmentId: 12, amount: "100.00" }] });
    await expect(caller.confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2,
      ...view, expectedClaimAmount: "300.00", clientRequestId: "claim-view-stale-amount" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2,
      ...view, expectedConsignmentClaims: [{ consignmentId: 11, amount: "150.00" }, { consignmentId: 12, amount: "50.00" }],
      clientRequestId: "claim-view-offset-amounts" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2,
      expectedClaimAmount: "200.00", expectedConsignmentIds: [11, 12], clientRequestId: "claim-view-no-members-amounts" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(before);
    const current = { consignmentId: 11, expectedClaimVersion: 2, ...view, clientRequestId: "claim-view-current" };
    expect(await caller.confirmConsignmentDelivery(current)).toMatchObject({ collectedAmount: "200.00" });
    await db().update(s.deliveryConsignments).set({ codClaimVersion: 3 }).where(eq(s.deliveryConsignments.id, 11));
    const after = await snapshot();
    expect(await caller.acknowledgeConsignmentClaim(ack)).toMatchObject({ claimVersion: 2 });
    expect(await caller.confirmConsignmentDelivery(current)).toMatchObject({ alreadyDelivered: true });
    expect(await snapshot()).toEqual(after);
    await expect(caller.confirmConsignmentDelivery({ ...current, expectedClaimVersion: 3 }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await db().update(s.deliveryConsignments).set({ parcelStatus: "RETURNED" });
    const afterClosingMembers = await snapshot();
    const closedAckReplays = await Promise.all([
      caller.acknowledgeConsignmentClaim(ack),
      caller.acknowledgeConsignmentClaim(ack),
    ]);
    for (const replay of closedAckReplays)
      expect(replay).toMatchObject({ consignmentId: 11, claimVersion: 2, acknowledgedAt: expect.any(Date) });
    expect(await caller.confirmConsignmentDelivery(current)).toMatchObject({ alreadyDelivered: true });
    expect(await snapshot()).toEqual(afterClosingMembers);
    await expect(caller.acknowledgeConsignmentClaim({ ...ack, expectedClaimAmount: "201.00" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.acknowledgeConsignmentClaim({ ...ack, clientRequestId: "new-closed-claim-ack" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.confirmConsignmentDelivery({ ...current, expectedClaimAmount: "201.00" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await db().update(s.deliveryPartyMembers).set({ isActive: false }).where(eq(s.deliveryPartyMembers.userId, 2));
    await expect(acknowledgeConsignmentClaim(ack, { userId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.deliveryPartyMembers).set({ isActive: true }).where(eq(s.deliveryPartyMembers.userId, 2));
    expect(await snapshot()).toEqual(afterClosingMembers);
    await db().insert(s.users).values({ id: 3, openId: "shipment-other-driver", role: "courier", branchId: 1 });
    await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 3, memberRole: "DRIVER", isActive: true, createdBy: 1 });
    const beforeOther = await snapshot();
    await expect(acknowledgeConsignmentClaim(ack, { userId: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirmConsignmentDelivery(current, { userId: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await snapshot()).toEqual(beforeOther);
  });
  it("rejects an acknowledgement and confirmation from a mixed read when member claims change but their total does not", async () => {
    await db().update(s.deliveryConsignments).set({ codClaimVersion: 2 }).where(eq(s.deliveryConsignments.id, 11));
    const oldRow = (await listMyDeliveries(2)).toDeliver.find((row) => row.id === 11)!;
    const oldView = { expectedConsignmentIds: oldRow.consignmentIds!, expectedClaimAmount: oldRow.codDue,
      expectedConsignmentClaims: oldRow.consignmentClaims!.map(({ consignmentId, amount }) => ({ consignmentId, amount })) };
    await db().update(s.invoices).set({ total: "50.00", subtotal: "50.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.invoices).set({ total: "250.00", subtotal: "250.00" }).where(eq(s.invoices.id, 2));
    await db().update(s.deliveryConsignments).set({ codAmount: "50.00" }).where(eq(s.deliveryConsignments.id, 11));
    await db().update(s.deliveryConsignments).set({ codAmount: "250.00" }).where(eq(s.deliveryConsignments.id, 12));
    const newRow = (await listMyDeliveries(2)).toDeliver.find((row) => row.id === 11)!;
    expect(newRow.codDue).toBe(oldRow.codDue);
    expect(newRow.consignmentClaims).toMatchObject([{ consignmentId: 11, amount: "50.00" }, { consignmentId: 12, amount: "250.00" }]);
    const before = await snapshot();
    await expect(acknowledgeConsignmentClaim({ consignmentId: 11, expectedClaimVersion: 2, ...oldView,
      clientRequestId: "mixed-read-ack" }, { userId: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2, ...oldView,
      clientRequestId: "mixed-read-confirm" }, { userId: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(before);
    const newView = { expectedConsignmentIds: newRow.consignmentIds!, expectedClaimAmount: newRow.codDue,
      expectedConsignmentClaims: newRow.consignmentClaims!.map(({ consignmentId, amount }) => ({ consignmentId, amount })) };
    await acknowledgeConsignmentClaim({ consignmentId: 11, expectedClaimVersion: 2, ...newView,
      clientRequestId: "mixed-read-fresh-ack" }, { userId: 2 });
    expect(await confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2, ...newView,
      clientRequestId: "mixed-read-fresh-confirm" }, { userId: 2 })).toMatchObject({ collectedAmount: "300.00" });
  });
  it("does not guess allocations for a partial courier amount on a multi-invoice shipment", async () => {
    const before = await snapshot();
    await expect(confirmConsignmentDelivery({ consignmentId: 11, collectedAmount: "100.00",
      shortfallReason: "OTHER", clientRequestId: "shipment-courier-partial-ambiguous" }, { userId: 2 }))
      .rejects.toThrow(/كامل|فواتير/);
    expect(await snapshot()).toEqual(before);
  });

  it("refreshes the leader claim when one member invoice is partially returned before delivery", async () => {
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2)))[0];
    await returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "shipment-return-member" }, actor);
    const beforeAck = (await listMyDeliveries(2)).toDeliver.find((row) => row.id === 11)!;
    expect(beforeAck.codDue).toBe("200.00");
    expect(beforeAck.orderTotal).toBe("200.00");
    expect(beforeAck.codClaimVersion).toBe(2);
    const view = { expectedClaimAmount: beforeAck.codDue, expectedConsignmentIds: beforeAck.consignmentIds,
      expectedConsignmentClaims: beforeAck.consignmentClaims };
    await expect(confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2, ...view, clientRequestId: "shipment-return-confirm" },
      { userId: 2 }, undefined, { requireFullCollection: true })).rejects.toThrow(/أقر/);
    await expect(confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2, ...view, collectedAmount: "200.00", clientRequestId: "shipment-return-explicit" },
      { userId: 2 }, undefined, { requireFullCollection: true })).rejects.toThrow(/أقر/);
    await acknowledgeConsignmentClaim({ consignmentId: 11, expectedClaimVersion: 2, ...view,
      clientRequestId: "shipment-return-ack" }, { userId: 2 });
    await confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2, ...view, clientRequestId: "shipment-return-confirm" },
      { userId: 2 }, undefined, { requireFullCollection: true });
    const invoices = await db().select().from(s.invoices).orderBy(s.invoices.id);
    expect(invoices.map((invoice) => Number(invoice.paidAmount))).toEqual([100, 100]);
  });

  it("rolls back a return if a live shipment member belongs to another party", async () => {
    await db().insert(s.deliveryParties).values({ id: 2, name: "جهة أخرى", partyType: "COMPANY", currentBalance: "0.00", isActive: true });
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "SHIPMENT-INV-3", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "SHIPMENT-CN-13", partyId: 2,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "INVOICE", codAmount: "50.00", deliveryFee: "0.00",
      feeCollection: "SHOP", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    await db().insert(s.deliveryShipmentMembers).values({ consignmentId: 13, leaderConsignmentId: 11, createdBy: 1 });
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2)))[0];
    const before = await snapshot();
    await expect(returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "shipment-return-wrong-party" }, actor)).rejects.toThrow(/الشحنة|الجهة/);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back the last listed member return when the shipment leader membership is missing", async () => {
    await db().delete(s.deliveryShipmentMembers).where(eq(s.deliveryShipmentMembers.consignmentId, 11));
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2)))[0];
    const before = await snapshot();
    await expect(returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }],
      restock: true, clientRequestId: "shipment-return-missing-leader" }, actor)).rejects.toThrow(/الشحنة|قائد/);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the leader claim visible when its invoice is fully returned and another member remains", async () => {
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 1)))[0];
    await returnSale({ invoiceId: 1, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "shipment-return-leader" }, actor);
    const row = (await listMyDeliveries(2)).toDeliver.find((entry) => entry.id === 11)!;
    expect(row.codDue).toBe("200.00");
    expect(row.codClaimVersion).toBe(2);
    expect(row.consignmentIds).toEqual([12]);
    expect(row.consignmentClaims).toMatchObject([{ consignmentId: 12, amount: "200.00" }]);
    await acknowledgeConsignmentClaim({ consignmentId: 11, expectedClaimVersion: 2, expectedClaimAmount: row.codDue,
      expectedConsignmentIds: row.consignmentIds, expectedConsignmentClaims: row.consignmentClaims,
      clientRequestId: "shipment-return-leader-ack" }, { userId: 2 });
    await confirmConsignmentDelivery({ consignmentId: 11, expectedClaimVersion: 2, expectedClaimAmount: row.codDue,
      expectedConsignmentIds: row.consignmentIds, expectedConsignmentClaims: row.consignmentClaims, clientRequestId: "shipment-return-leader-confirm" },
      { userId: 2 }, undefined, { requireFullCollection: true });
    const invoices = await db().select().from(s.invoices).orderBy(s.invoices.id);
    expect(invoices.map((invoice) => Number(invoice.paidAmount))).toEqual([0, 200]);
  });

  it("lets the newly assigned courier acknowledge a surviving shipment whose leader was returned", async () => {
    await db().update(s.deliveryConsignments).set({ assignedUserId: 2 });
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 1)))[0];
    await returnSale({ invoiceId: 1, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "shipment-return-reassign-leader" }, actor);
    await db().insert(s.users).values({ id: 3, openId: "shipment-new-driver", role: "courier", branchId: 1 });
    await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 3, memberRole: "DRIVER", isActive: true, createdBy: 1 });
    await reassignShipmentDriver({ consignmentId: 11, assignedUserId: 3, clientRequestId: "shipment-return-reassign" }, actor);
    const row = (await listMyDeliveries(3)).toDeliver.find((entry) => entry.id === 11)!;
    expect(row.codClaimVersion).toBe(2);
    await expect(acknowledgeConsignmentClaim({ consignmentId: 11, expectedClaimVersion: 2,
      clientRequestId: "shipment-old-driver-ack" }, { userId: 2 })).rejects.toThrow(/سائق/);
    const newDriverAck = { consignmentId: 11, expectedClaimVersion: 2, expectedClaimAmount: row.codDue,
      expectedConsignmentIds: row.consignmentIds, expectedConsignmentClaims: row.consignmentClaims,
      clientRequestId: "shipment-new-driver-ack" };
    await acknowledgeConsignmentClaim(newDriverAck, { userId: 3 });
    await db().update(s.deliveryConsignments).set({ parcelStatus: "RETURNED" }).where(eq(s.deliveryConsignments.id, 12));
    const closed = await snapshot();
    expect(await acknowledgeConsignmentClaim(newDriverAck, { userId: 3 })).toMatchObject({ claimVersion: 2 });
    await expect(acknowledgeConsignmentClaim(newDriverAck, { userId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await snapshot()).toEqual(closed);
  });

  it("replays the acknowledged version after the current claim acknowledgement is reset", async () => {
    await db().update(s.deliveryConsignments).set({ assignedUserId: 2 });
    const ack = { consignmentId: 11, expectedClaimVersion: 1, clientRequestId: "old-claim-ack-replay" };
    await acknowledgeConsignmentClaim(ack, { userId: 2 });
    await db().update(s.deliveryConsignments).set({ parcelStatus: "RETURNED" });
    await db().update(s.deliveryConsignments).set({ codClaimVersion: 2, courierAckClaimVersion: 0, courierAckAt: null })
      .where(eq(s.deliveryConsignments.id, 11));
    const closed = await snapshot();
    expect(await acknowledgeConsignmentClaim(ack, { userId: 2 })).toMatchObject({
      consignmentId: 11, claimVersion: 1, acknowledgedAt: null,
    });
    expect(await snapshot()).toEqual(closed);
  });

  it("keeps older and newer acknowledgements distinct after the shipment closes", async () => {
    await db().update(s.deliveryConsignments).set({ assignedUserId: 2 });
    const oldAck = { consignmentId: 11, expectedClaimVersion: 1, clientRequestId: "old-version-ack" };
    await acknowledgeConsignmentClaim(oldAck, { userId: 2 });
    await db().update(s.deliveryConsignments).set({ codClaimVersion: 2 }).where(eq(s.deliveryConsignments.id, 11));
    const row = (await listMyDeliveries(2)).toDeliver.find((entry) => entry.id === 11)!;
    const newAck = { consignmentId: 11, expectedClaimVersion: 2, expectedClaimAmount: row.codDue,
      expectedConsignmentIds: row.consignmentIds, expectedConsignmentClaims: row.consignmentClaims,
      clientRequestId: "new-version-ack" };
    await acknowledgeConsignmentClaim(newAck, { userId: 2 });
    await db().update(s.deliveryConsignments).set({ parcelStatus: "RETURNED" });
    const closed = await snapshot();
    expect(await acknowledgeConsignmentClaim(oldAck, { userId: 2 })).toMatchObject({ claimVersion: 1, acknowledgedAt: null });
    expect(await acknowledgeConsignmentClaim(newAck, { userId: 2 })).toMatchObject({ claimVersion: 2, acknowledgedAt: expect.any(Date) });
    expect(await snapshot()).toEqual(closed);
  });

  it("settles each invoice of a company shipment at its net amount after a partial return", async () => {
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2)))[0];
    await returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "shipment-statement-return" }, actor);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-NET-1",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "100.00" }],
      countedCash: "200.00", targetShiftId: shift.shiftId, clientRequestId: "shipment-statement-return-remit" }, actor);
    const state = await snapshot();
    expect(state.invoices.map((invoice) => Number(invoice.paidAmount))).toEqual([100, 100]);
    expect(state.invoices.map((invoice) => Number(invoice.returnedTotal))).toEqual([0, 100]);
    expect(state.remittanceLines.map((line) => [Number(line.consignmentId), Number(line.grossApplied)]))
      .toEqual([[11, 100], [12, 100]]);
    expect(Number(state.party[0].currentBalance)).toBe(0);
  });

  it("corrects an earlier full collection proof after a returned item and remits only the net shipment", async () => {
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "shipment-old-full-proof" },
      { userId: 2 }, undefined, { requireFullCollection: true });
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2)))[0];
    await returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "shipment-return-after-old-proof" }, actor);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-NET-2",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "100.00" }],
      countedCash: "200.00", targetShiftId: shift.shiftId, clientRequestId: "shipment-return-after-proof-remit" }, actor);
    const state = await snapshot();
    expect(state.invoices.map((invoice) => Number(invoice.paidAmount))).toEqual([100, 100]);
    expect(state.invoices.map((invoice) => Number(invoice.returnedTotal))).toEqual([0, 100]);
    expect(state.remittanceLines.map((line) => [Number(line.consignmentId), Number(line.grossApplied)]))
      .toEqual([[11, 100], [12, 100]]);
    expect(state.ledger.filter((line) => Number(line.consignmentId) === 12 &&
      ["COD_COLLECTED", "COD_RETURNED", "COD_REMITTED"].includes(line.entryType))
      .map((line) => [line.entryType, Number(line.amount)]))
      .toEqual([["COD_COLLECTED", 200], ["COD_RETURNED", 100], ["COD_REMITTED", 100]]);
    expect(Number(state.party[0].currentBalance)).toBe(0);
  });

  it("withholds the shipment's own shop fee when its fee-bearing leader was returned", async () => {
    await returnFeeLeader("5.00", "return-fee-leader");
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "OTHER-FEE-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "OTHER-FEE-CN", partyId: 1,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "ONLINE_ORDER", codAmount: "50.00", deliveryFee: "7.00",
      feeCollection: "SHOP", parcelStatus: "DELIVERED", dispatchedBy: 1 });
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:13:FEE_EARNED", partyId: 1, branchId: 1,
      consignmentId: 13, entryType: "FEE_EARNED", amount: "7.00", createdBy: 1 });
    const otherBefore = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 13)))[0];
    const open = await listOpenConsignments(1, 1, { limit: 500 });
    expect(open.rows.find((row) => Number(row.id) === 12)?.feeWithholdingCash).toBe("5.00");
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const input = { branchId: 1, partyId: 1, statementNumber: "RETURN-FEE-1",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "195.00",
      deductionsTotal: "5.00", targetShiftId: shift.shiftId, clientRequestId: "return-fee-statement" };
    const result = await recordCompanyStatement(input, actor);
    expect(result).toMatchObject({ collectedTotal: "200.00", netRemitted: "195.00" });
    const state = await snapshot();
    expect(state.remittanceLines).toMatchObject([{ consignmentId: 12, grossApplied: "200.00", feeOffset: "5.00", cashReceived: "195.00" }]);
    expect(state.ledger.filter((line) => line.entryType === "FEE_OFFSET"))
      .toMatchObject([{ consignmentId: 11, amount: "5.00" }]);
    expect(state.cn.find((row) => Number(row.id) === 13)).toEqual(otherBefore);
    expect(state.ledger.filter((line) => Number(line.consignmentId) === 13).map((line) => line.entryType))
      .toEqual(["FEE_EARNED"]);
    expect(await recordCompanyStatement(input, actor)).toMatchObject({ idempotentReplay: true });
    expect(await snapshot()).toEqual(state);
  });

  it("previews and settles a returned leader's fee in the daily settlement of its surviving invoice", async () => {
    await returnFeeLeader("5.00", "return-fee-daily");
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmShipmentDelivery({ consignmentId: 11, collectedAmount: "200.00", evidence: "تأكيد الشركة",
      clientRequestId: "return-fee-daily-confirm" }, actor);
    const preview = await withTx((tx) => previewDailySettlementTx(tx, { branchId: 1, partyId: 1 }, actor));
    expect(preview.net).toBe("195.00");
    expect(preview.lines).toMatchObject([{ consignmentId: 12, remaining: "200.00", feeWithholding: "5.00" }]);
    await withTx((tx) => settleDailyTx(tx, { branchId: 1, partyId: 1, countedCash: preview.net,
      expectedLines: preview.lines.map((line) => ({ consignmentId: line.consignmentId, remaining: line.remaining })),
      clientRequestId: "return-fee-daily-remit" }, actor));
    expect((await snapshot()).ledger.filter((line) => line.entryType === "FEE_OFFSET"))
      .toMatchObject([{ consignmentId: 11, amount: "5.00" }]);
  });

  it("does not preview a partial shipment while another invoice is still in transit", async () => {
    await returnFeeLeader("5.00", "return-fee-incomplete-preview");
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "INCOMPLETE-SHIPMENT-INV", sourceType: "POS",
      branchId: 1, customerId: 1, subtotal: "100.00", total: "100.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "INCOMPLETE-SHIPMENT-CN",
      partyId: 1, branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "INVOICE", codAmount: "100.00",
      deliveryFee: "0.00", feeCollection: "SHOP", status: "DISPATCHED", parcelStatus: "DELIVERED",
      moneyStatus: "UNSETTLED", dispatchedBy: 1 });
    await db().insert(s.deliveryShipmentMembers).values({ consignmentId: 13, leaderConsignmentId: 11, createdBy: 1 });
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:11:FEE_EARNED", partyId: 1, branchId: 1,
      consignmentId: 11, entryType: "FEE_EARNED", amount: "5.00", createdBy: 1 });
    await expect(withTx((tx) => previewDailySettlementTx(tx, { branchId: 1, partyId: 1 }, actor)))
      .rejects.toThrow(/فواتير أخرى للشحنة/);
  });

  it("distributes a returned leader fee only across cash lines of the same shipment", async () => {
    await returnFeeLeader("250.00", "return-fee-split");
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "SAME-GROUP-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "100.00", total: "100.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "SAME-GROUP-CN", partyId: 1,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "INVOICE", codAmount: "100.00", deliveryFee: "0.00",
      feeCollection: "SHOP", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    await db().insert(s.deliveryShipmentMembers).values({ consignmentId: 13, leaderConsignmentId: 11, createdBy: 1 });
    await db().update(s.customers).set({ currentBalance: "300.00" }).where(eq(s.customers.id, 1));
    const rows = await listOpenConsignments(1, 1, { limit: 500 });
    expect(rows.rows.filter((row) => [12, 13].includes(Number(row.id))).map((row) => row.feeWithholdingCash)).toEqual(["200.00", "50.00"]);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-FEE-SPLIT",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }, { consignmentId: 13, collectedAmount: "100.00" }],
      countedCash: "50.00", targetShiftId: shift.shiftId, clientRequestId: "return-fee-split-remit" }, actor);
    const state = await snapshot();
    expect(state.remittanceLines.map((line) => [Number(line.consignmentId), Number(line.feeOffset), Number(line.cashReceived)]))
      .toEqual([[12, 200, 0], [13, 50, 50]]);
    expect(state.ledger.filter((line) => line.entryType === "FEE_OFFSET"))
      .toMatchObject([{ consignmentId: 11, amount: "250.00" }]);
  });

  it("rolls back the whole company statement if the selected shipment cannot cover its fee", async () => {
    await returnFeeLeader("201.00", "return-fee-too-large");
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-FEE-TOO-LARGE",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "0.00",
      targetShiftId: shift.shiftId, clientRequestId: "return-fee-too-large-remit" }, actor)).rejects.toThrow(/أجرة الشحنة/);
    expect(await snapshot()).toEqual(before);
  });

  it("uses an order-independent commission on the returned leader's original fee once", async () => {
    await returnFeeLeader("10.00", "return-fee-commission");
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values({ partyId: 1, ruleType: "PERCENT_OF_FEE", percentValue: "50.00", isActive: true });
    const rows = await listOpenConsignments(1, 1, { limit: 500 });
    expect(rows.rows.find((row) => Number(row.id) === 12)?.feeWithholdingCash).toBe("5.00");
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const result = await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-FEE-COMMISSION",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "195.00",
      targetShiftId: shift.shiftId, clientRequestId: "return-fee-commission-remit" }, actor);
    expect(result.netRemitted).toBe("195.00");
    const state = await snapshot();
    expect(state.remittanceLines).toMatchObject([{ consignmentId: 12, feeOffset: "5.00" }]);
    expect(state.ledger.filter((line) => line.entryType === "FEE_OFFSET"))
      .toMatchObject([{ consignmentId: 11, amount: "10.00" }]);
  });

  it("uses the selected commission rule even if a later order-based rule exists", async () => {
    await returnFeeLeader("10.00", "return-fee-selected-commission");
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values([
      { partyId: 1, ruleType: "PERCENT_OF_FEE", percentValue: "50.00", isActive: true },
      { partyId: 1, ruleType: "PERCENT_OF_ORDER", percentValue: "5.00", isActive: true },
    ]);
    const rows = await listOpenConsignments(1, 1, { limit: 500 });
    expect(rows.rows.find((row) => Number(row.id) === 12)).toMatchObject({ feeWithholdingBlocked: false, feeWithholdingCash: "5.00" });
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const result = await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-FEE-SELECTED-RULE",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "195.00",
      targetShiftId: shift.shiftId, clientRequestId: "return-fee-selected-rule-remit" }, actor);
    expect(result.netRemitted).toBe("195.00");
  });

  it("does not guess an order-based commission for a returned fee-bearing invoice", async () => {
    await returnFeeLeader("10.00", "return-fee-order-commission");
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values({ partyId: 1, ruleType: "PERCENT_OF_ORDER", percentValue: "5.00", isActive: true });
    const rows = await listOpenConsignments(1, 1, { limit: 500 });
    expect(rows.rows.find((row) => Number(row.id) === 12)?.feeWithholdingBlocked).toBe(true);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-FEE-ORDER",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "200.00",
      targetShiftId: shift.shiftId, clientRequestId: "return-fee-order-remit" }, actor)).rejects.toThrow(/العمولة/);
    expect(await snapshot()).toEqual(before);
  });

  it("does not settle an order-based commission on a returned fee leader using only its invoice", async () => {
    await returnFeeLeader("10.00", "bulk-return-fee-order-commission");
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values({ partyId: 1, ruleType: "PERCENT_OF_ORDER", percentValue: "5.00", minGuarantee: "1.00", isActive: true });
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().insert(s.receipts).values({ branchId: 1, shiftId: shift.shiftId, direction: "IN", amount: "20.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", referenceNumber: "BULK-ORDER-TEST-FUND", createdBy: 1 });
    await confirmShipmentDelivery({ consignmentId: 11, collectedAmount: "200.00", evidence: "تأكيد الشركة",
      clientRequestId: "bulk-return-fee-order-confirm" }, actor);
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "BULK-OTHER-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "100.00", total: "100.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "BULK-OTHER-CN", partyId: 1,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "ONLINE_ORDER", codAmount: "100.00", deliveryFee: "5.00",
      feeCollection: "SHOP", parcelStatus: "DELIVERED", dispatchedBy: 1 });
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:13:FEE_EARNED", partyId: 1, branchId: 1,
      consignmentId: 13, entryType: "FEE_EARNED", amount: "5.00", createdBy: 1 });
    const before = await snapshot();
    await expect(payPartyDeliveryFees({ partyId: 1, branchId: 1, shiftId: shift.shiftId,
      clientRequestId: "bulk-return-order-fee-pay" }, actor)).rejects.toThrow(/العمولة|الشحنة/);
    expect(await snapshot()).toEqual(before);
  });

  it("does not guess an order-based commission for a prepaid fee leader of a multi-invoice shipment", async () => {
    await db().update(s.invoices).set({ paidAmount: "100.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.deliveryConsignments).set({ sourceType: "ONLINE_ORDER", codAmount: "0.00", deliveryFee: "10.00" })
      .where(eq(s.deliveryConsignments.id, 11));
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values({ partyId: 1, ruleType: "PERCENT_OF_ORDER", percentValue: "5.00", isActive: true });
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().insert(s.receipts).values({ branchId: 1, shiftId: shift.shiftId, direction: "IN", amount: "20.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", referenceNumber: "BULK-PREPAID-TEST-FUND", createdBy: 1 });
    await confirmShipmentDelivery({ consignmentId: 11, collectedAmount: "200.00", evidence: "تأكيد الشركة",
      clientRequestId: "bulk-prepaid-fee-order-confirm" }, actor);
    const before = await snapshot();
    await expect(payPartyDeliveryFees({ partyId: 1, branchId: 1, shiftId: shift.shiftId,
      clientRequestId: "bulk-prepaid-order-fee-pay" }, actor)).rejects.toThrow(/العمولة|الشحنة/);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the order-based commission available when the fee owner's invoice still has a live claim", async () => {
    await db().update(s.deliveryConsignments).set({ sourceType: "ONLINE_ORDER", deliveryFee: "10.00" })
      .where(eq(s.deliveryConsignments.id, 11));
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values({ partyId: 1, ruleType: "PERCENT_OF_ORDER", percentValue: "5.00", isActive: true });
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().insert(s.receipts).values({ branchId: 1, shiftId: shift.shiftId, direction: "IN", amount: "20.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", referenceNumber: "BULK-LIVE-ORDER-FUND", createdBy: 1 });
    await confirmShipmentDelivery({ consignmentId: 11, collectedAmount: "300.00", evidence: "تأكيد الشركة",
      clientRequestId: "bulk-live-fee-order-confirm" }, actor);
    const result = await payPartyDeliveryFees({ partyId: 1, branchId: 1, shiftId: shift.shiftId,
      clientRequestId: "bulk-live-order-fee-pay" }, actor);
    expect(result).toMatchObject({ count: 1, paidTotal: "5.00" });
  });

  it("counts an exact historical shortfall snapshot once when checking a live fee owner", async () => {
    await db().update(s.deliveryConsignments).set({ sourceType: "ONLINE_ORDER", deliveryFee: "10.00" })
      .where(eq(s.deliveryConsignments.id, 11));
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values({ partyId: 1, ruleType: "PERCENT_OF_ORDER", percentValue: "5.00", isActive: true });
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().insert(s.receipts).values({ branchId: 1, shiftId: shift.shiftId, direction: "IN", amount: "20.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", referenceNumber: "BULK-SHORTFALL-FUND", createdBy: 1 });
    await confirmShipmentDelivery({ consignmentId: 11, collectedAmount: "300.00", evidence: "تأكيد الشركة",
      clientRequestId: "bulk-shortfall-fee-confirm" }, actor);
    await db().insert(s.deliveryLedgerEntries).values([
      { eventKey: "CN:11:SHORTFALL_ASSIGNED", partyId: 1, branchId: 1, consignmentId: 11,
        entryType: "SHORTFALL_ASSIGNED", amount: "60.00", createdBy: 1 },
      { eventKey: "BACKFILL:CN:11:SHORTFALL_ASSIGNED", partyId: 1, branchId: 1, consignmentId: 11,
        entryType: "SHORTFALL_ASSIGNED", amount: "60.00", createdBy: 1 },
    ]);
    const result = await payPartyDeliveryFees({ partyId: 1, branchId: 1, shiftId: shift.shiftId,
      clientRequestId: "bulk-shortfall-order-fee-pay" }, actor);
    expect(result).toMatchObject({ count: 1, paidTotal: "5.00" });
  });

  it("rejects a detached fee with conflicting ledger branch evidence", async () => {
    await returnFeeLeader("5.00", "return-fee-wrong-branch");
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:11:FEE_EARNED", partyId: 1, branchId: 2,
      consignmentId: 11, entryType: "FEE_EARNED", amount: "5.00", createdBy: 1 });
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "RETURN-FEE-WRONG-BRANCH",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "195.00",
      targetShiftId: shift.shiftId, clientRequestId: "return-fee-wrong-branch-remit" }, actor)).rejects.toThrow(/الأجرة|الفرع|الجهة/);
    expect(await snapshot()).toEqual(before);
  });

  it("does not withhold a closed member's fee ledger from a different party when its fee column is zero", async () => {
    await returnFeeLeader("0.00", "return-fee-hidden-party");
    await db().insert(s.deliveryParties).values({ id: 2, name: "جهة أخرى", partyType: "COMPANY", currentBalance: "0.00", isActive: true });
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "HIDDEN-FEE-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "10.00", total: "10.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "HIDDEN-FEE-CN", partyId: 2,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "ONLINE_ORDER", codAmount: "10.00", deliveryFee: "0.00",
      feeCollection: "SHOP", status: "RETURNED", parcelStatus: "RETURNED", moneyStatus: "CANCELLED", dispatchedBy: 1 });
    await db().insert(s.deliveryShipmentMembers).values({ consignmentId: 13, leaderConsignmentId: 11, createdBy: 1 });
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:13:FEE_EARNED", partyId: 2, branchId: 1,
      consignmentId: 13, entryType: "FEE_EARNED", amount: "5.00", createdBy: 1 });
    const open = await listOpenConsignments(1, 1, { limit: 500 });
    expect(open.rows.find((row) => Number(row.id) === 12)?.feeWithholdingBlocked).toBe(true);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "HIDDEN-FEE-WRONG-PARTY",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "195.00",
      targetShiftId: shift.shiftId, clientRequestId: "hidden-fee-wrong-party-remit" }, actor)).rejects.toThrow(/الأجرة|الجهة/);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps a closed member with no fee balance from blocking its surviving shipment", async () => {
    await returnFeeLeader("0.00", "return-fee-closed-no-balance");
    await db().insert(s.deliveryParties).values({ id: 2, name: "جهة سابقة", partyType: "COMPANY", currentBalance: "0.00", isActive: true });
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "CLOSED-NO-FEE-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "10.00", total: "10.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "CLOSED-NO-FEE-CN", partyId: 2,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "ONLINE_ORDER", codAmount: "10.00", deliveryFee: "0.00",
      feeCollection: "SHOP", status: "RETURNED", parcelStatus: "RETURNED", moneyStatus: "CANCELLED", dispatchedBy: 1 });
    await db().insert(s.deliveryShipmentMembers).values({ consignmentId: 13, leaderConsignmentId: 11, createdBy: 1 });
    const open = await listOpenConsignments(1, 1, { limit: 500 });
    expect(open.rows.find((row) => Number(row.id) === 12)?.feeWithholdingBlocked).toBe(false);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const result = await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "CLOSED-NO-FEE",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "200.00",
      targetShiftId: shift.shiftId, clientRequestId: "closed-no-fee-remit" }, actor);
    expect(result.netRemitted).toBe("200.00");
  });

  it("counts an exact legacy fee snapshot once and blocks an ambiguous one", async () => {
    await returnFeeLeader("5.00", "return-fee-legacy-snapshot");
    await db().insert(s.deliveryLedgerEntries).values([
      { eventKey: "CN:11:FEE_EARNED", partyId: 1, branchId: 1, consignmentId: 11,
        entryType: "FEE_EARNED", amount: "5.00", createdBy: 1 },
      { eventKey: "BACKFILL:CN:11:FEE_EARNED", partyId: 1, branchId: 1, consignmentId: 11,
        entryType: "FEE_EARNED", amount: "5.00", createdBy: 1 },
    ]);
    const exact = await listOpenConsignments(1, 1, { limit: 500 });
    expect(exact.rows.find((row) => Number(row.id) === 12)).toMatchObject({ feeWithholdingCash: "5.00", feeWithholdingBlocked: false });
    await db().update(s.deliveryLedgerEntries).set({ amount: "4.00" })
      .where(eq(s.deliveryLedgerEntries.eventKey, "BACKFILL:CN:11:FEE_EARNED"));
    const ambiguous = await listOpenConsignments(1, 1, { limit: 500 });
    expect(ambiguous.rows.find((row) => Number(row.id) === 12)?.feeWithholdingBlocked).toBe(true);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "AMBIGUOUS-LEGACY-FEE",
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "195.00",
      targetShiftId: shift.shiftId, clientRequestId: "ambiguous-legacy-fee-remit" }, actor)).rejects.toThrow(/الأجرة/);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps a different shipment available when one shipment has invalid fee evidence", async () => {
    await returnFeeLeader("5.00", "return-fee-invalid-preview");
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:11:FEE_EARNED", partyId: 1, branchId: 2,
      consignmentId: 11, entryType: "FEE_EARNED", amount: "5.00", createdBy: 1 });
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "SAFE-OTHER-SHIPMENT", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "SAFE-OTHER-CN", partyId: 1,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "INVOICE", codAmount: "50.00", deliveryFee: "0.00",
      feeCollection: "SHOP", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    const open = await listOpenConsignments(1, 1, { limit: 500 });
    expect(open.rows.find((row) => Number(row.id) === 12)?.feeWithholdingBlocked).toBe(true);
    expect(open.rows.find((row) => Number(row.id) === 13)?.feeWithholdingBlocked).toBe(false);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const result = await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "SAFE-OTHER-STATEMENT",
      lines: [{ consignmentId: 13, collectedAmount: "50.00" }], countedCash: "50.00",
      targetShiftId: shift.shiftId, clientRequestId: "safe-other-remit" }, actor);
    expect(result.netRemitted).toBe("50.00");
  });

  it("rejects a standalone shipment fee whose ledger belongs to a different branch", async () => {
    await db().delete(s.deliveryShipmentMembers);
    await db().update(s.deliveryConsignments).set({ sourceType: "ONLINE_ORDER", deliveryFee: "5.00" })
      .where(eq(s.deliveryConsignments.id, 12));
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 12, clientRequestId: "single-fee-confirm" }, { userId: 2 });
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:12:INVALID-FEE-TEST", partyId: 1, branchId: 2,
      consignmentId: 12, entryType: "FEE_EARNED", amount: "1.00", createdBy: 1 });
    const open = await listOpenConsignments(1, 1, { limit: 500 });
    expect(open.rows.find((row) => Number(row.id) === 12)?.feeWithholdingBlocked).toBe(true);
    const before = await snapshot();
    await expect(recordDeliveryRemittance({ branchId: 1, partyId: 1, requireFullShipment: true,
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "194.00",
      targetShiftId: shift.shiftId, clientRequestId: "single-invalid-fee-remit" }, actor)).rejects.toThrow(/الأجرة|الفرع/);
    expect(await snapshot()).toEqual(before);
    await expect(payDeliveryFee({ consignmentId: 12, shiftId: shift.shiftId, clientRequestId: "single-invalid-fee-pay" }, actor))
      .rejects.toThrow(/الأجرة|الفرع/);
    await expect(payPartyDeliveryFees({ partyId: 1, branchId: 1, shiftId: shift.shiftId, clientRequestId: "batch-invalid-fee-pay" }, actor))
      .rejects.toThrow(/الأجرة|الفرع/);
    expect(await snapshot()).toEqual(before);
    await db().insert(s.deliveryParties).values({ id: 2, name: "جهة أخرى", partyType: "COMPANY", currentBalance: "0.00", isActive: true });
    await db().update(s.deliveryLedgerEntries).set({ branchId: 1, partyId: 2 })
      .where(eq(s.deliveryLedgerEntries.eventKey, "CN:12:INVALID-FEE-TEST"));
    const wrongParty = await snapshot();
    await expect(payDeliveryFee({ consignmentId: 12, shiftId: shift.shiftId, clientRequestId: "single-wrong-party-fee-pay" }, actor))
      .rejects.toThrow(/الأجرة|الجهة/);
    await expect(payPartyDeliveryFees({ partyId: 1, branchId: 1, shiftId: shift.shiftId, clientRequestId: "batch-wrong-party-fee-pay" }, actor))
      .rejects.toThrow(/الأجرة|الجهة/);
    expect(await snapshot()).toEqual(wrongParty);
    await db().delete(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.eventKey, "CN:12:INVALID-FEE-TEST"));
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "BACKFILL:CN:12:FEE_EARNED", partyId: 1, branchId: 1,
      consignmentId: 12, entryType: "FEE_EARNED", amount: "4.00", createdBy: 1 });
    const ambiguous = await snapshot();
    await expect(payDeliveryFee({ consignmentId: 12, shiftId: shift.shiftId, clientRequestId: "single-ambiguous-fee-pay" }, actor))
      .rejects.toThrow(/الأجرة/);
    await expect(payPartyDeliveryFees({ partyId: 1, branchId: 1, shiftId: shift.shiftId, clientRequestId: "batch-ambiguous-fee-pay" }, actor))
      .rejects.toThrow(/الأجرة/);
    expect(await snapshot()).toEqual(ambiguous);
  });

  it("does not offset a detached fee paid after the remittance transaction's earlier snapshot", async () => {
    await returnFeeLeader("5.00", "return-fee-snapshot");
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().insert(s.receipts).values({ branchId: 1, shiftId: shift.shiftId, direction: "IN",
      amount: "5.00", paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED",
      referenceNumber: "FEE-SNAPSHOT-TEST-FUND", createdBy: 1 });
    await confirmShipmentDelivery({ consignmentId: 11, collectedAmount: "200.00", evidence: "تأكيد الشركة",
      clientRequestId: "return-fee-snapshot-confirm" }, actor);
    let release!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { announce = resolve; });
    const pending = withTx(async (tx) => {
      await tx.select().from(s.invoices).where(eq(s.invoices.id, 2));
      announce();
      await gate;
      return recordDeliveryRemittanceInTx(tx, { branchId: 1, partyId: 1, requireFullShipment: true,
        lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "195.00",
        targetShiftId: shift.shiftId, clientRequestId: "return-fee-snapshot-remit" }, actor);
    });
    await ready;
    try { await payDeliveryFee({ consignmentId: 11, shiftId: shift.shiftId, clientRequestId: "return-fee-snapshot-pay" }, actor); }
    finally { release(); }
    await expect(pending).rejects.toThrow(/النقد|الصافي/);
    const state = await snapshot();
    expect(state.ledger.filter((line) => line.entryType === "FEE_PAID")).toHaveLength(1);
    expect(state.ledger.filter((line) => line.entryType === "FEE_OFFSET")).toHaveLength(0);
    expect(state.remittances).toHaveLength(0);
  });

  it("does not omit a sibling whose shortfall changed after an earlier transaction snapshot", async () => {
    await db().update(s.deliveryConsignments).set({ parcelStatus: "DELIVERED" }).where(eq(s.deliveryConsignments.id, 11));
    await db().update(s.deliveryConsignments).set({ parcelStatus: "DELIVERED", codAmount: "100.00" }).where(eq(s.deliveryConsignments.id, 12));
    await db().update(s.invoices).set({ paidAmount: "100.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.invoices).set({ subtotal: "100.00", total: "100.00", paidAmount: "100.00" }).where(eq(s.invoices.id, 2));
    await db().update(s.deliveryParties).set({ currentBalance: "200.00" }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.deliveryLedgerEntries).values([
      { eventKey: "CN:11:COD_COLLECTED", partyId: 1, branchId: 1, consignmentId: 11,
        entryType: "COD_COLLECTED", amount: "100.00", createdBy: 1 },
      { eventKey: "CN:12:COD_COLLECTED", partyId: 1, branchId: 1, consignmentId: 12,
        entryType: "COD_COLLECTED", amount: "20.00", createdBy: 1 },
      { eventKey: "CN:12:SHORTFALL_ASSIGNED", partyId: 1, branchId: 1, consignmentId: 12,
        entryType: "SHORTFALL_ASSIGNED", amount: "80.00", createdBy: 1 },
    ]);
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    let release!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { announce = resolve; });
    const pending = withTx(async (tx) => {
      await tx.select().from(s.invoices).where(eq(s.invoices.id, 2));
      announce();
      await gate;
      return recordDeliveryRemittanceInTx(tx, { branchId: 1, partyId: 1, requireFullShipment: true,
        lines: [{ consignmentId: 11, collectedAmount: "100.00" }], countedCash: "100.00",
        targetShiftId: shift.shiftId, clientRequestId: "sibling-shortfall-snapshot-remit" }, actor);
    });
    await ready;
    try {
      await withTx(async (tx) => {
        await tx.update(s.deliveryConsignments).set({ counterSettledAmount: "50.00" }).where(eq(s.deliveryConsignments.id, 12));
        await tx.update(s.invoices).set({ returnedTotal: "50.00", paidAmount: "50.00" }).where(eq(s.invoices.id, 2));
        await tx.update(s.deliveryParties).set({ currentBalance: "150.00" }).where(eq(s.deliveryParties.id, 1));
        await tx.insert(s.deliveryLedgerEntries).values({ eventKey: "CN:12:SHORTFALL_SETTLED:RETURN", partyId: 1,
          branchId: 1, consignmentId: 12, entryType: "SHORTFALL_SETTLED", amount: "50.00", createdBy: 1 });
      });
    } finally { release(); }
    await expect(pending).rejects.toThrow(/جزء|الشحنة/);
    expect((await snapshot()).remittances).toHaveLength(0);
  });

  it("uses the current commission rule after an earlier transaction snapshot", async () => {
    await returnFeeLeader("5.00", "return-fee-rule-snapshot");
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    const [rule] = await db().insert(s.courierCommissionRules).values({ partyId: 1, ruleType: "PERCENT_OF_FEE",
      percentValue: "50.00", isActive: true }).$returningId();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmShipmentDelivery({ consignmentId: 11, collectedAmount: "200.00", evidence: "تأكيد الشركة",
      clientRequestId: "return-fee-rule-snapshot-confirm" }, actor);
    let release!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { announce = resolve; });
    const pending = withTx(async (tx) => {
      await tx.select().from(s.courierCommissionRules).where(eq(s.courierCommissionRules.id, Number(rule.id)));
      announce();
      await gate;
      return recordDeliveryRemittanceInTx(tx, { branchId: 1, partyId: 1, requireFullShipment: true,
        lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "197.50",
        targetShiftId: shift.shiftId, clientRequestId: "return-fee-rule-snapshot-remit" }, actor);
    });
    await ready;
    try { await db().update(s.courierCommissionRules).set({ percentValue: "100.00" }).where(eq(s.courierCommissionRules.id, Number(rule.id))); }
    finally { release(); }
    await expect(pending).rejects.toThrow(/النقد|الصافي|التوريد|المبلغ/);
    const state = await snapshot();
    expect(state.ledger.filter((line) => line.entryType === "FEE_OFFSET")).toHaveLength(0);
    expect(state.remittances).toHaveLength(0);
  });

  it("courier portal shows one physical shipment and confirms all invoice amounts", async () => {
    const listed = await listMyDeliveries(2);
    expect(listed.toDeliver).toHaveLength(1);
    expect(listed.toDeliver[0]).toMatchObject({
      id: 11,
      codDue: "300.00",
      consignmentDeliveryFee: "5.00",
      shipmentMemberCount: 2,
      consignmentIds: [11, 12],
    });
    expect(listed.toDeliver[0].invoiceReferences).toEqual(
      expect.arrayContaining(["SHIPMENT-INV-1", "SHIPMENT-INV-2"]),
    );
    const result = await confirmConsignmentDelivery(
      { consignmentId: 12, clientRequestId: "portal-group" },
      { userId: 2 },
    );
    expect(result).toMatchObject({
      consignmentId: 11,
      collectedAmount: "300.00",
    });
    const state = await snapshot();
    expect(state.cn.map((row) => row.parcelStatus)).toEqual([
      "DELIVERED",
      "DELIVERED",
    ]);
    expect(state.invoices.map((row) => row.paidAmount)).toEqual([
      "100.00",
      "200.00",
    ]);
    expect(
      (
        await confirmConsignmentDelivery(
          { consignmentId: 11, clientRequestId: "portal-group" },
          { userId: 2 },
        )
      ).alreadyDelivered,
    ).toBe(true);
    expect(await snapshot()).toEqual(state);
  });

  it("courier parcel failure fans out atomically with no financial effects", async () => {
    const before = await snapshot();
    const input = {
      consignmentId: 12,
      toStatus: "FAILED" as const,
      reason: "العميل غير متاح",
      clientRequestId: "portal-fail-all",
    };
    await transitionConsignmentParcel(input, { userId: 2 });
    const state = await snapshot();
    expect(state.cn.map((row) => row.parcelStatus)).toEqual([
      "FAILED",
      "FAILED",
    ]);
    expect(state.invoices).toEqual(before.invoices);
    expect(state.ledger).toEqual(before.ledger);
    expect(
      (await transitionConsignmentParcel(input, { userId: 2 })).replay,
    ).toBe(true);
    expect(await snapshot()).toEqual(state);
  });

  it("confirms all invoices and one fee, replay has no second effect", async () => {
    expect(
      (await confirmShipmentDelivery(confirm, actor)).consignmentIds,
    ).toEqual([11, 12]);
    const state = await snapshot();
    expect(state.cn.map((row) => row.parcelStatus)).toEqual([
      "DELIVERED",
      "DELIVERED",
    ]);
    expect(state.invoices.map((row) => row.paidAmount)).toEqual([
      "100.00",
      "200.00",
    ]);
    expect(state.party[0].currentBalance).toBe("300.00");
    expect(state.customers[0].currentBalance).toBe("0.00");
    expect(state.receipts).toHaveLength(0);
    expect(
      state.ledger
        .filter((row) => row.entryType === "FEE_EARNED")
        .map((row) => row.amount),
    ).toEqual(["5.00"]);
    expect(
      (await confirmShipmentDelivery({ ...confirm, consignmentId: 12 }, actor))
        .idempotentReplay,
    ).toBe(true);
    expect(await snapshot()).toEqual(state);
  });

  it("rejects partial customer collection without changing any shipment invoice", async () => {
    const before = await snapshot();
    await expect(confirmShipmentDelivery(
      { ...confirm, collectedAmount: "299.99", shortfallReason: "OTHER" },
      actor,
    )).rejects.toThrow(/لا يطابق/);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects zero collection on a shipment with unpaid invoices", async () => {
    const before = await snapshot();
    await expect(confirmShipmentDelivery(
      { ...confirm, collectedAmount: "0.00", shortfallReason: "OTHER" },
      actor,
    )).rejects.toThrow(/لا يطابق/);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back the first invoice if the second member rejects delivery", async () => {
    await db()
      .update(s.deliveryConsignments)
      .set({ returnDeclaredAt: new Date() })
      .where(eq(s.deliveryConsignments.id, 12));
    const before = await snapshot();
    await expect(confirmShipmentDelivery(confirm, actor)).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" },
    );
    expect(await snapshot()).toEqual(before);
  });

  it("rejects overcollection and altered payload replay without changes", async () => {
    const before = await snapshot();
    await expect(
      confirmShipmentDelivery({ ...confirm, collectedAmount: "300.01" }, actor),
    ).rejects.toThrow(/لا يطابق/);
    expect(await snapshot()).toEqual(before);
    await confirmShipmentDelivery(confirm, actor);
    const after = await snapshot();
    await expect(
      confirmShipmentDelivery({ ...confirm, evidence: "مصدر مختلف" }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(after);
  });

  it("checks branch scope even for a successful replay", async () => {
    await confirmShipmentDelivery(confirm, actor);
    const before = await snapshot();
    await expect(
      confirmShipmentDelivery(confirm, { ...actor, branchId: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      confirmShipmentDelivery(confirm, { ...actor, branchId: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await snapshot()).toEqual(before);
  });

  it("direct single invoice cancellation/return cannot split a shipment", async () => {
    const before = await snapshot();
    await expect(
      cancelDeliveryAssignment(
        {
          consignmentId: 12,
          reason: "طلب العميل",
          clientRequestId: "single-cancel",
        },
        actor,
      ),
    ).rejects.toThrow(/الشحنة/);
    await expect(
      returnConsignment(11, {
        ...actor,
        returnReason: "رفض العميل",
        clientRequestId: "single-return",
      }),
    ).rejects.toThrow(/الشحنة/);
    expect(await snapshot()).toEqual(before);
  });

  it("cancels the whole assignment without touching invoices, cash or stock", async () => {
    const before = await snapshot();
    const input = {
      consignmentId: 12,
      reason: "طلب العميل الاستلام من الفرع",
      clientRequestId: "cancel-all",
      physicalHeldConfirmed: true,
    };
    await cancelShipmentAssignment(input, actor);
    const after = await snapshot();
    expect(after.cn.map((row) => row.parcelStatus)).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.stock).toEqual(before.stock);
    expect(after.receipts).toEqual(before.receipts);
    expect(
      after.ledger
        .filter((row) => row.entryType === "COD_RELEASED")
        .map((row) => row.amount),
    ).toEqual(["100.00", "200.00"]);
    expect(
      (await cancelShipmentAssignment(input, actor)).idempotentReplay,
    ).toBe(true);
    expect(await snapshot()).toEqual(after);
  });

  it("failure and driver reassignment propagate to every member, including company followers without tracking", async () => {
    await markShipmentFailed(
      {
        consignmentId: 12,
        reason: "العميل غير متاح",
        clientRequestId: "fail-all",
      },
      actor,
    );
    expect((await snapshot()).cn.map((row) => row.parcelStatus)).toEqual([
      "FAILED",
      "FAILED",
    ]);
    await reassignShipmentDriver(
      { consignmentId: 11, assignedUserId: 2, clientRequestId: "reassign-all" },
      actor,
    );
    const rows = (await snapshot()).cn;
    expect(rows.map((row) => row.assignedUserId)).toEqual([2, 2]);
    expect(rows.map((row) => row.parcelStatus)).toEqual([
      "OUT_FOR_DELIVERY",
      "OUT_FOR_DELIVERY",
    ]);
    expect(rows.map((row) => row.externalTrackingRef)).toEqual([
      "SHIPMENT-TRACK",
      null,
    ]);
  });

  it("returns all inventory and invoice obligations exactly once, including a barcode on a follower", async () => {
    const result = await returnByBarcode(
      {
        barcode: "SHIPMENT-CN-12",
        returnReason: "رفض العميل",
        clientRequestId: "barcode-return-all",
      },
      actor,
    );
    expect(result.consignmentId).toBe(11);
    const state = await snapshot();
    expect(state.cn.map((row) => row.parcelStatus)).toEqual([
      "RETURNED",
      "RETURNED",
    ]);
    expect(state.stock[0].quantity).toBe(10);
    expect(state.customers[0].currentBalance).toBe("0.00");
    expect(state.invoices.map((row) => row.returnedTotal)).toEqual([
      "100.00",
      "200.00",
    ]);
    expect(
      state.movements
        .filter((row) => row.referenceType === "DELIVERY_RETURN")
        .map((row) => row.quantity),
    ).toEqual([1, 2]);
    expect(
      (
        await returnShipment(
          {
            consignmentId: 12,
            reason: "رفض العميل",
            clientRequestId: "barcode-return-all",
          },
          actor,
        )
      ).idempotentReplay,
    ).toBe(true);
    expect(await snapshot()).toEqual(state);
  });

  it("company statement rejects half of an unconfirmed physical shipment before writing", async () => {
    const before = await snapshot();
    await expect(
      recordCompanyStatement(
        {
          branchId: 1,
          partyId: 1,
          statementNumber: "HALF-SHIPMENT",
          lines: [{ consignmentId: 11, collectedAmount: "0.00" }],
          countedCash: "0.00",
          clientRequestId: "half-statement",
        },
        actor,
      ),
    ).rejects.toThrow(/شحنة/);
    expect(await snapshot()).toEqual(before);
  });

  it("does not remit only one invoice of a shipment already collected from the customer", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "group-collected" }, { userId: 2 });
    const before = await snapshot();
    await expect(recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "DELIVERED-HALF",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }],
      countedCash: "100.00", clientRequestId: "delivered-half-statement",
    }, actor)).rejects.toThrow(/شحنة/);
    expect(await snapshot()).toEqual(before);
  });

  it("settles all invoices of the selected shipment exactly once", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const input = {
      branchId: 1, partyId: 1, statementNumber: "COMPLETE-SHIPMENT",
      lines: [
        { consignmentId: 11, collectedAmount: "100.00" },
        { consignmentId: 12, collectedAmount: "200.00" },
      ], countedCash: "300.00", clientRequestId: "complete-shipment-statement",
    };
    const first = await recordCompanyStatement(input, actor);
    const after = await snapshot();
    expect(after.invoices.map((row) => row.paidAmount)).toEqual(["100.00", "200.00"]);
    expect(after.cn.map((row) => row.collectedAmount)).toEqual(["100.00", "200.00"]);
    expect(after.party[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.deliveryRemittanceLines)).map((row) => [row.consignmentId, row.grossApplied]))
      .toEqual([[11, "100.00"], [12, "200.00"]]);
    expect((await recordCompanyStatement(input, actor)).remittanceId).toBe(first.remittanceId);
    expect(await snapshot()).toEqual(after);
  });

  it.each(["0.00", "99.00", "101.00"])("rejects statement invoice amount %s when the due is 100", async (amount) => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: `WRONG-${amount}`,
      lines: [{ consignmentId: 11, collectedAmount: amount }, { consignmentId: 12, collectedAmount: "200.00" }],
      countedCash: String(Number(amount) + 200), clientRequestId: `wrong-amount-${amount}`,
    }, actor)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a stale delivery claim when the actual invoice increased", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().update(s.invoices).set({ total: "120.00", subtotal: "120.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.customers).set({ currentBalance: "320.00" }).where(eq(s.customers.id, 1));
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "STALE-INVOICE",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "200.00" }],
      countedCash: "300.00", clientRequestId: "stale-invoice-claim" }, actor)).rejects.toThrow(/الفاتورة/);
    expect(await snapshot()).toEqual(before);
  });

  it("does not close a zero-COD consignment whose invoice still requires cash", async () => {
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "ZERO-COD-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "ZERO-COD-CN", partyId: 1, branchId: 1,
      invoiceId: 3, sourceId: 3, sourceType: "INVOICE", endCustomerId: 1, codAmount: "0.00", deliveryFee: "0.00",
      feeCollection: "COURIER", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    const before = await snapshot();
    await expect(recordStaffDeliveryConfirmation({ consignmentId: 13, collectedAmount: "0", evidence: "اتصال المندوب",
      clientRequestId: "zero-cod-staff" }, actor, { requireFullCollection: true })).rejects.toThrow(/الفاتورة/);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a short counted cash receipt and rolls back every shipment invoice", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "SHORT-GROUP-CASH",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "200.00" }],
      countedCash: "299.00", clientRequestId: "short-group-cash",
    }, actor)).rejects.toThrow(/النقد/);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a zero-valued line used to hide an unpaid shipment member", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "zero-member-collected" }, { userId: 2 });
    const before = await snapshot();
    await expect(recordDeliveryRemittance({
      branchId: 1, partyId: 1, requireFullShipment: true,
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "0.00" }],
      countedCash: "100.00", clientRequestId: "zero-member-remittance",
    }, actor)).rejects.toThrow(/الشحنة/);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back a mixed company statement when a zero line has no explicit responsibility", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "MIXED-SAME-SHIPMENT",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "0.00", zeroDeliveryConfirmed: true }],
      countedCash: "100.00", targetShiftId: shift.shiftId, clientRequestId: "mixed-same-shipment" }, actor))
      .rejects.toThrow(/مسؤولية/);
    expect(await snapshot()).toEqual(before);
  });

  it("does not assign a zero line shortfall from a reason without an explicit responsibility", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const before = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "MIXED-ZERO-SHORTFALL",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" },
        { consignmentId: 12, collectedAmount: "0.00", shortfallReason: "OTHER", zeroDeliveryConfirmed: true }],
      countedCash: "100.00", targetShiftId: shift.shiftId, clientRequestId: "mixed-zero-shortfall" }, actor))
      .rejects.toThrow(/مسؤولي/);
    expect(await snapshot()).toEqual(before);
  });

  it("leaves an unrelated shipment and invoice untouched when settling the selected group", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "OTHER-INV", sourceType: "POS", branchId: 1, customerId: 1,
      subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "OTHER-CN", partyId: 1, branchId: 1,
      invoiceId: 3, sourceId: 3, sourceType: "INVOICE", endCustomerId: 1,
      codAmount: "50.00", deliveryFee: "0.00", feeCollection: "COURIER", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    await db().update(s.customers).set({ currentBalance: "350.00" }).where(eq(s.customers.id, 1));
    const before = await snapshot();
    await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "SELECTED-ONLY",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "200.00" }],
      countedCash: "300.00", clientRequestId: "selected-shipment-only" }, actor);
    const after = await snapshot();
    expect(after.cn.find((row) => row.id === 13)).toEqual(before.cn.find((row) => row.id === 13));
    expect(after.invoices.find((row) => row.id === 3)).toEqual(before.invoices.find((row) => row.id === 3));
    expect(after.customers[0].currentBalance).toBe("50.00");
    expect((await db().select().from(s.deliveryRemittanceLines)).map((row) => row.consignmentId)).toEqual([11, 12]);
  });

  it("links separate shipment batches to the same original company statement without repeating a receipt", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "BATCH-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "BATCH-CN", partyId: 1,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "INVOICE", endCustomerId: 1,
      codAmount: "50.00", deliveryFee: "0.00", feeCollection: "COURIER", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    await db().update(s.customers).set({ currentBalance: "350.00" }).where(eq(s.customers.id, 1));
    const first = await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "SAME-ORIGINAL",
      statementDate: "2026-10-01", attachmentUrl: "/statements/original.pdf",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "200.00" }],
      countedCash: "300.00", clientRequestId: "batch-original-first" }, actor);
    const next = { branchId: 1, partyId: 1, statementNumber: "SAME-ORIGINAL", appendToStatement: true,
      lines: [{ consignmentId: 13, collectedAmount: "50.00" }], countedCash: "50.00", clientRequestId: "batch-original-second" };
    const before = await snapshot();
    await expect(recordCompanyStatement({ ...next, appendToStatement: false }, actor)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await expect(recordCompanyStatement({ ...next, statementDate: "2026-11-01" }, actor)).rejects.toThrow(/تاريخ/);
    await expect(recordCompanyStatement({ ...next, attachmentUrl: "/statements/other.pdf" }, actor)).rejects.toThrow(/مرفق/);
    await expect(recordCompanyStatement({ ...next, deductionsTotal: "10.00", countedCash: "40.00" }, actor)).rejects.toThrow(/استقطاع/);
    expect(await snapshot()).toEqual(before);
    const second = await recordCompanyStatement(next, actor);
    expect(second.remittanceId).not.toBe(first.remittanceId);
    expect((await recordCompanyStatement(next, actor)).remittanceId).toBe(second.remittanceId);
    expect(await db().select().from(s.deliveryCompanyStatements)).toHaveLength(1);
    expect(await db().select().from(s.deliveryCompanyStatementBatches)).toHaveLength(2);
    const history = await listPartyRemittances(1);
    expect(history.map((row) => row.companyStatementNumber)).toEqual(["SAME-ORIGINAL", "SAME-ORIGINAL"]);
    expect(history.map((row) => row.statementAttachmentUrl)).toEqual(["/statements/original.pdf", "/statements/original.pdf"]);
    expect((await db().select().from(s.deliveryRemittances)).map((row) => row.deductionsTotal)).toEqual(["0.00", "0.00"]);
    expect(await db().select().from(s.deliveryRemittanceLines)).toHaveLength(3);
    expect((await db().select().from(s.receipts)).filter((row) => row.direction === "IN")).toHaveLength(2);
    const saved = await snapshot();
    await expect(recordCompanyStatement({ ...next, appendToStatement: false }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(recordCompanyStatement({ ...next, clientRequestId: "duplicate-batch-second" }, actor)).rejects.toThrow(/سابق/);
    expect(await snapshot()).toEqual(saved);
  });

  it("links a pre-existing statement receipt without rewriting it when continuing a historical shipment", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "legacy-batch-collected" }, { userId: 2 });
    const first = await recordDeliveryRemittance({ branchId: 1, partyId: 1,
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }], countedCash: "100.00",
      companyStatement: { statementNumber: "LEGACY-ORIGINAL" }, clientRequestId: "legacy-batch-first" }, actor);
    const old = (await db().select().from(s.deliveryRemittances).where(eq(s.deliveryRemittances.id, first.remittanceId)))[0];
    await db().update(s.deliveryRemittanceLines).set({ legacySnapshot: true })
      .where(eq(s.deliveryRemittanceLines.remittanceId, first.remittanceId));
    const uncertain = await snapshot();
    await expect(recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "LEGACY-ORIGINAL", appendToStatement: true,
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "200.00", clientRequestId: "legacy-batch-uncertain" }, actor)).rejects.toThrow(/تاريخي/);
    expect(await snapshot()).toEqual(uncertain);
    await db().update(s.deliveryRemittanceLines).set({ legacySnapshot: false })
      .where(eq(s.deliveryRemittanceLines.remittanceId, first.remittanceId));
    await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "LEGACY-ORIGINAL", appendToStatement: true,
      lines: [{ consignmentId: 12, collectedAmount: "200.00" }], countedCash: "200.00", clientRequestId: "legacy-batch-second" }, actor);
    expect((await db().select().from(s.deliveryRemittances).where(eq(s.deliveryRemittances.id, first.remittanceId)))[0]).toEqual(old);
    expect(await db().select().from(s.deliveryCompanyStatements)).toHaveLength(1);
    expect(await db().select().from(s.deliveryCompanyStatementBatches)).toHaveLength(2);
    expect((await listPartyRemittances(1)).map((row) => row.companyStatementNumber)).toEqual(["LEGACY-ORIGINAL", "LEGACY-ORIGINAL"]);
  });

  it("prevents the whole statement fee from being deducted again across two shipment batches", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await db().update(s.deliveryConsignments).set({ sourceType: "ONLINE_ORDER" }).where(eq(s.deliveryConsignments.id, 11));
    await db().insert(s.invoices).values({ id: 3, invoiceNumber: "FEE-BATCH-INV", sourceType: "POS", branchId: 1,
      customerId: 1, subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: 13, consignmentNumber: "FEE-BATCH-CN", partyId: 1,
      branchId: 1, invoiceId: 3, sourceId: 3, sourceType: "ONLINE_ORDER", endCustomerId: 1,
      codAmount: "50.00", deliveryFee: "5.00", feeCollection: "SHOP", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    await db().update(s.customers).set({ currentBalance: "350.00" }).where(eq(s.customers.id, 1));
    const first = { branchId: 1, partyId: 1, statementNumber: "FEE-BATCHES",
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "200.00" }],
      deductionsTotal: "10.00", countedCash: "290.00", clientRequestId: "fee-batch-first" };
    const before = await snapshot();
    await expect(recordCompanyStatement(first, actor)).rejects.toThrow(/استقطاع/);
    expect(await snapshot()).toEqual(before);
    await expect(recordCompanyStatement({ ...first, deductionsTotal: "2.50", countedCash: "297.50" }, actor)).rejects.toThrow(/الأجور/);
    expect(await snapshot()).toEqual(before);
    await recordCompanyStatement({ ...first, deductionsTotal: "5.00", countedCash: "295.00" }, actor);
    await recordCompanyStatement({ branchId: 1, partyId: 1, statementNumber: "FEE-BATCHES", appendToStatement: true,
      lines: [{ consignmentId: 13, collectedAmount: "50.00" }], deductionsTotal: "5.00", countedCash: "45.00",
      clientRequestId: "fee-batch-second" }, actor);
    const remittances = await db().select().from(s.deliveryRemittances);
    expect(remittances.map((row) => row.feesTotal)).toEqual(["5.00", "5.00"]);
    expect(remittances.map((row) => row.deductionsTotal)).toEqual(["0.00", "0.00"]);
    expect(remittances.map((row) => row.netRemitted)).toEqual(["295.00", "45.00"]);
    expect((await db().select().from(s.invoices)).map((row) => row.paidAmount)).toEqual(["100.00", "200.00", "50.00"]);
  });

  it("serializes concurrent remittances for the same shipment without a second receipt", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "race-collected" }, { userId: 2 });
    const input = { branchId: 1, partyId: 1, requireFullShipment: true,
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "200.00" }],
      countedCash: "300.00" };
    const result = await Promise.allSettled([
      recordDeliveryRemittance({ ...input, clientRequestId: "race-remit-first" }, actor),
      recordDeliveryRemittance({ ...input, clientRequestId: "race-remit-second" }, actor),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(1);
    expect(await db().select().from(s.deliveryRemittanceLines)).toHaveLength(2);
  });

  it("daily settlement refuses a different shipment even when the aggregate cash is unchanged", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "daily-group-collected" }, { userId: 2 });
    const preview = await withTx((tx) => previewDailySettlementTx(tx, { branchId: 1, partyId: 1 }, actor));
    const lines = preview.lines.map((line) => ({ consignmentId: line.consignmentId, remaining: line.remaining }));
    const input = { branchId: 1, partyId: 1, countedCash: preview.net, expectedLines: lines, clientRequestId: "daily-group-settle" };
    const before = await snapshot();
    await expect(withTx((tx) => settleDailyTx(tx, { ...input,
      expectedLines: [{ ...lines[0], consignmentId: 999 }, ...lines.slice(1)] }, actor))).rejects.toThrow(/شحنات التسوية/);
    expect(await snapshot()).toEqual(before);
    const result = await withTx((tx) => settleDailyTx(tx, input, actor));
    const after = await snapshot();
    expect((await withTx((tx) => settleDailyTx(tx, input, actor))).remittanceId).toBe(result.remittanceId);
    expect(await snapshot()).toEqual(after);
  });

  it("rejects using another shipment's proven custody for an unproven invoice", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "other-group-collected" }, { userId: 2 });
    await db().insert(s.invoices).values({
      id: 3, invoiceNumber: "UNPROVEN-INV", sourceType: "POS", branchId: 1, customerId: 1,
      subtotal: "50.00", total: "50.00", paidAmount: "0.00", createdBy: 1,
    });
    await db().insert(s.deliveryConsignments).values({
      id: 13, consignmentNumber: "UNPROVEN-CN", partyId: 1, branchId: 1,
      invoiceId: 3, sourceId: 3, sourceType: "INVOICE", endCustomerId: 1,
      codAmount: "50.00", deliveryFee: "0.00", feeCollection: "SHOP",
      parcelStatus: "DELIVERED", dispatchedBy: 1,
    });
    const before = await snapshot();
    await expect(recordDeliveryRemittance({
      branchId: 1, partyId: 1, lines: [{ consignmentId: 13, collectedAmount: "50.00" }],
      countedCash: "50.00", clientRequestId: "unproven-invoice-remit",
    }, actor)).rejects.toThrow(/يثبت|المثبت/);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects conflicting ledger branch evidence without posting any shipment money", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmConsignmentDelivery({ consignmentId: 11, clientRequestId: "wrong-branch-collected" }, { userId: 2 });
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "CN:11:WRONG-BRANCH-TEST", partyId: 1,
      consignmentId: 11, branchId: 2, entryType: "COD_COLLECTED", amount: "1.00", createdBy: 1 });
    const before = await snapshot();
    await expect(recordDeliveryRemittance({ branchId: 1, partyId: 1, requireFullShipment: true,
      lines: [{ consignmentId: 11, collectedAmount: "100.00" }, { consignmentId: 12, collectedAmount: "200.00" }],
      countedCash: "300.00", clientRequestId: "wrong-branch-remittance" }, actor)).rejects.toThrow(/الفرع/);
    expect(await snapshot()).toEqual(before);
  });

  it("refund preflight sums every deposit and the one held fee before judging drawer sufficiency", async () => {
    await db().insert(s.receipts).values({ receiptNumber: "SHIPMENT-TEST-FUNDING", direction: "IN", branchId: 1, amount: "40.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 });
    const shift = await openShift(
      { branchId: 1, openingBalance: "40.00", shiftType: "RECEPTION" },
      actor,
    );
    await db()
      .update(s.invoices)
      .set({ paidAmount: "10.00" })
      .where(eq(s.invoices.id, 1));
    await db()
      .update(s.invoices)
      .set({ paidAmount: "30.00" })
      .where(eq(s.invoices.id, 2));
    // Historical documented goods CASH is separate from this shift's opening cash.
    // Invoice scalar paidAmount alone must never authorize a cash refund.
    await db().insert(s.receipts).values([
      { receiptNumber: "SHIPMENT-GOODS-IN-1", direction: "IN", branchId: 1, invoiceId: 1, customerId: 1, partyType: "CUSTOMER", amount: "10.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 },
      { receiptNumber: "SHIPMENT-GOODS-IN-2", direction: "IN", branchId: 1, invoiceId: 2, customerId: 1, partyType: "CUSTOMER", amount: "30.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 },
    ]);
    await db()
      .insert(s.receipts)
      .values({
        receiptNumber: "SHIPMENT-FEE-IN",
        direction: "IN",
        branchId: 1,
        invoiceId: 1,
        amount: "5.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        shiftId: shift.shiftId,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "DLV-FEE-INV-1",
        createdBy: 1,
      });
    const preflight = await withTx((tx) =>
      consignmentReturnPreflight(tx, 12, { exposeCash: true }),
    );
    expect(preflight?.estimatedCashOut).toBe("45.00");
    expect(
      preflight?.drawers.find((row) => row.shiftId === shift.shiftId)
        ?.sufficient,
    ).toBe(true);
    await db()
      .update(s.shifts)
      .set({ openingBalance: "39.00" })
      .where(eq(s.shifts.id, shift.shiftId));
    const insufficient = await withTx((tx) =>
      consignmentReturnPreflight(tx, 11, { exposeCash: true }),
    );
    expect(insufficient?.estimatedCashOut).toBe("45.00");
    expect(
      insufficient?.drawers.find((row) => row.shiftId === shift.shiftId)
        ?.sufficient,
    ).toBe(false);
  });

  it("withholds full shipment fee across siblings when positive leader COD is smaller than shipment fee", async () => {
    await db().update(s.deliveryParties).set({ partyType: "INDIVIDUAL" }).where(eq(s.deliveryParties.id, 1));
    await db().update(s.invoices).set({ paidAmount: "98.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.customers).set({ currentBalance: "202.00" }).where(eq(s.customers.id, 1));
    await db().update(s.deliveryConsignments)
      .set({ sourceType: "ONLINE_ORDER", codAmount: "2.00", deliveryFee: "5.00" })
      .where(eq(s.deliveryConsignments.id, 11));

    const openBeforeConfirm = await listOpenConsignments(1, 1);
    expect(openBeforeConfirm.rows.map((r) => [r.id, r.feeWithholdingCash, r.feeWithholdingBlocked, r.shipmentCollectibleDue])).toEqual([
      [11, "2.00", false, "202.00"],
      [12, "3.00", false, "202.00"],
    ]);

    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmShipmentDelivery({
      consignmentId: 11,
      collectedAmount: "202.00",
      evidence: "تأكيد استلام العميل",
      clientRequestId: "small-leader-cod-confirm",
    }, actor);

    const openAfterConfirm = await listOpenConsignments(1, 1);
    expect(openAfterConfirm.rows.map((r) => [r.id, r.feeWithholdingCash, r.feeWithholdingBlocked])).toEqual([
      [11, "2.00", false],
      [12, "3.00", false],
    ]);

    const preview = await withTx((tx) =>
      previewDailySettlementTx(tx, { partyId: 1, branchId: 1 }, actor),
    );
    expect(preview).toMatchObject({
      expectedCash: "202.00",
      deductions: "5.00",
      net: "197.00",
    });
    expect(preview.lines).toMatchObject([
      { consignmentId: 11, remaining: "2.00", feeWithholding: "2.00" },
      { consignmentId: 12, remaining: "200.00", feeWithholding: "3.00" },
    ]);

    const settled = await withTx((tx) =>
      settleDailyTx(tx, {
        partyId: 1,
        branchId: 1,
        countedCash: "197.00",
        targetShiftId: shift.shiftId,
        clientRequestId: "small-leader-cod-settle-daily",
      }, actor),
    );
    expect(settled).toMatchObject({
      collectedTotal: "202.00",
      feesTotal: "5.00",
      netRemitted: "197.00",
      status: "BALANCED",
    });

    const state = await snapshot();
    expect(state.party[0]?.currentBalance).toBe("0.00");
    expect(state.receipts.map((r) => [r.direction, r.amount])).toEqual([
      ["IN", "202.00"],
      ["OUT", "5.00"],
    ]);
    const remLines = await db().select().from(s.deliveryRemittanceLines);
    expect(remLines.map((l) => [l.consignmentId, l.grossApplied, l.feeOffset, l.cashReceived])).toEqual([
      [11, "2.00", "2.00", "0.00"],
      [12, "200.00", "3.00", "197.00"],
    ]);
    expect(state.ledger.filter((e) => e.entryType === "FEE_OFFSET")).toHaveLength(1);
    expect(state.cn.map((c) => [c.id, c.status, c.moneyStatus, Boolean(c.feeSettledAt)])).toEqual([
      [11, "DELIVERED", "SETTLED", true],
      [12, "DELIVERED", "SETTLED", false],
    ]);
  });

  it("withholds order-based commission across siblings when positive leader COD is smaller than commission", async () => {
    await db().update(s.invoices).set({ paidAmount: "98.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.customers).set({ currentBalance: "202.00" }).where(eq(s.customers.id, 1));
    await db().update(s.deliveryConsignments)
      .set({ sourceType: "ONLINE_ORDER", codAmount: "2.00", deliveryFee: "10.00" })
      .where(eq(s.deliveryConsignments.id, 11));
    await db().update(s.deliveryParties).set({ useCommissionForSettlement: true }).where(eq(s.deliveryParties.id, 1));
    await db().insert(s.courierCommissionRules).values({
      partyId: 1,
      ruleType: "PERCENT_OF_ORDER",
      percentValue: "5.00",
      isActive: true,
    });

    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    await confirmShipmentDelivery({
      consignmentId: 11,
      collectedAmount: "202.00",
      evidence: "تأكيد استلام العميل",
      clientRequestId: "small-leader-commission-confirm",
    }, actor);

    const openAfterConfirm = await listOpenConsignments(1, 1);
    expect(openAfterConfirm.rows.map((r) => [r.id, r.feeWithholdingCash, r.feeWithholdingBlocked])).toEqual([
      [11, "2.00", false],
      [12, "3.00", false],
    ]);

    const rem = await recordDeliveryRemittance({
      branchId: 1,
      partyId: 1,
      requireFullShipment: true,
      targetShiftId: shift.shiftId,
      lines: [
        { consignmentId: 11, collectedAmount: "2.00" },
        { consignmentId: 12, collectedAmount: "200.00" },
      ],
      countedCash: "197.00",
      clientRequestId: "small-leader-commission-remit",
    }, actor);
    expect(rem).toMatchObject({
      collectedTotal: "202.00",
      feesTotal: "5.00",
      netRemitted: "197.00",
    });

    const state = await snapshot();
    expect(state.party[0]?.currentBalance).toBe("0.00");
    expect(state.ledger.filter((e) => e.entryType === "FEE_OFFSET").map((e) => e.amount)).toEqual(["10.00"]);
    expect(state.receipts.map((r) => [r.direction, r.amount])).toEqual([
      ["IN", "202.00"],
      ["OUT", "5.00"],
    ]);
  });

  it("settles a delivery company 3-invoice shipment (small leader COD + follower COD + zero-COD invoice) in 1 step via recordCompanyStatement", async () => {
    await db().insert(s.invoices).values({
      id: 3,
      invoiceNumber: "SHIPMENT-INV-3",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "50.00",
      total: "50.00",
      paidAmount: "50.00",
      status: "PAID",
      createdBy: 1,
    });
    await db().update(s.invoices).set({ paidAmount: "98.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.customers).set({ currentBalance: "202.00" }).where(eq(s.customers.id, 1));
    await db().update(s.deliveryConsignments)
      .set({ sourceType: "ONLINE_ORDER", codAmount: "2.00", deliveryFee: "5.00" })
      .where(eq(s.deliveryConsignments.id, 11));
    await db().insert(s.deliveryConsignments).values({
      id: 13,
      consignmentNumber: "SHIPMENT-CN-13",
      partyId: 1,
      branchId: 1,
      invoiceId: 3,
      sourceId: 3,
      sourceType: "INVOICE",
      endCustomerId: 1,
      codAmount: "0.00",
      deliveryFee: "0.00",
      feeCollection: "COURIER",
      moneyStatus: "NOT_APPLICABLE",
      parcelStatus: "OUT_FOR_DELIVERY",
      dispatchedBy: 1,
    });
    await db().insert(s.deliveryShipmentMembers).values({
      consignmentId: 13,
      leaderConsignmentId: 11,
      createdBy: 1,
    });

    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const stmt = await recordCompanyStatement({
      branchId: 1,
      partyId: 1,
      targetShiftId: shift.shiftId,
      statementNumber: "STMT-MULTI-3INV",
      deductionsTotal: "5.00",
      countedCash: "197.00",
      lines: [
        { consignmentId: 11, collectedAmount: "2.00", expectedDue: "2.00", expectedProven: "0.00" },
        { consignmentId: 12, collectedAmount: "200.00", expectedDue: "200.00", expectedProven: "0.00" },
        { consignmentId: 13, collectedAmount: "0.00", expectedDue: "0.00", expectedProven: "0.00", zeroDeliveryConfirmed: true },
      ],
      clientRequestId: "stmt-multi-3inv-req",
    }, actor);

    expect(stmt).toMatchObject({
      statementNumber: "STMT-MULTI-3INV",
      deliveriesConfirmed: 3,
      collectedTotal: "202.00",
      netRemitted: "197.00",
    });

    const state = await snapshot();
    expect(state.party[0]?.currentBalance).toBe("0.00");
    expect(state.cn.map((c) => [c.id, c.parcelStatus, c.status, c.moneyStatus])).toEqual([
      [11, "DELIVERED", "DELIVERED", "SETTLED"],
      [12, "DELIVERED", "DELIVERED", "SETTLED"],
      [13, "DELIVERED", "DELIVERED", "NOT_APPLICABLE"],
    ]);
    expect(state.receipts.map((r) => [r.direction, r.amount])).toEqual([
      ["IN", "202.00"],
      ["OUT", "5.00"],
    ]);
  });

  it("allows 1-step workflow reassign on OUT_FOR_DELIVERY without handover and clears stale carrier tracking when switching COMPANY -> INDIVIDUAL", async () => {
    await db().insert(s.deliveryParties).values({
      id: 2,
      name: "مندوب خاص",
      partyType: "INDIVIDUAL",
      branchId: 1,
      currentBalance: "0.00",
      isActive: true,
    });
    await db().insert(s.users).values({
      id: 3,
      openId: "ind-driver",
      role: "courier",
      branchId: 1,
    });
    await db().insert(s.deliveryPartyMembers).values({
      partyId: 2,
      userId: 3,
      memberRole: "DRIVER",
      isActive: true,
      createdBy: 1,
    });
    const managerActor = { userId: 1, branchId: 1, role: "admin" };
    await db().update(s.users).set({ role: "admin" }).where(eq(s.users.id, 1));

    const preview = await withTx((tx) =>
      currentWorkflowActorTx(tx, managerActor, 1).then((a) => loadWorkflowPreviewTx(tx, { kind: "consignment", id: 11 }, a.current, 1)),
    );
    expect(preview.actions.find((a) => a.action === "reassign")?.allowed).toBe(true);

    const reassigned = await mutateWorkflowAssignment(
      {
        source: {
          kind: "consignment",
          id: 11,
          expectedVersion: preview.source.version,
        },
        branchId: 1,
        action: "reassign",
        reason: "تحويل فوري لمندوب المكتبة قبل خروج الطرد",
        partyId: 2,
        assignedUserId: 3,
        clientRequestId: "part-j-1step-reassign-ind",
      },
      managerActor,
    );
    expect(reassigned.consignmentId).toBe(11);

    const allConsignments = await db().select().from(s.deliveryConsignments);
    const activeRows = allConsignments.filter((c) => c.status === "DISPATCHED");
    expect(activeRows).toHaveLength(2);
    expect(activeRows.every((c) => c.partyId === 2)).toBe(true);
    expect(activeRows.every((c) => c.externalTrackingRef == null)).toBe(true);
  });

  it("preserves workOrderDisposition RETURN_TO_READY through returnByBarcode on a multi-invoice shipment containing a work order", async () => {
    await db().insert(s.workOrders).values({
      id: 50,
      orderNumber: "WO-50",
      branchId: 1,
      customerId: 1,
      contactName: "عميل الشحنة",
      contactPhone: "07701234567",
      title: "مطبوعات تجريبية",
      status: "DELIVERED",
      hasDelivery: true,
      salePrice: "100.00",
      deposit: "0.00",
      invoiceId: 1,
      createdBy: 1,
    });
    await db()
      .update(s.invoices)
      .set({ sourceType: "WORKORDER" })
      .where(eq(s.invoices.id, 1));
    await db()
      .update(s.deliveryConsignments)
      .set({ workOrderId: 50, sourceType: "WORK_ORDER", sourceId: 50 })
      .where(eq(s.deliveryConsignments.id, 11));

    const res = await returnByBarcode(
      {
        barcode: "SHIPMENT-CN-11",
        returnReason: "تأجيل استلام من العميل مع بقاء الطلب جاهزاً",
        workOrderDisposition: "RETURN_TO_READY",
        clientRequestId: "part-j-wo-return-ready",
      },
      actor,
    );
    expect(res.consignmentId).toBe(11);

    const [wo] = await db()
      .select()
      .from(s.workOrders)
      .where(eq(s.workOrders.id, 50));
    expect(wo?.status).toBe("READY");

    const [inv1] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, 1));
    expect(inv1?.status).toBe("PENDING");
  });

  it("bumps shipment leader codClaimVersion when a non-leader member invoice is cancelled via cancelInvoiceDeliveryTx", async () => {
    const [leaderBefore] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, 11));
    expect(leaderBefore?.codClaimVersion).toBe(1);

    await withTx(async (tx) => {
      const state = await invoiceDeliveryAmendmentTx(tx, 2);
      expect(state).not.toBeNull();
      await cancelInvoiceDeliveryTx(
        tx,
        state!,
        actor,
        "part-j-member-cancel-bump",
        "إلغاء الفاتورة الثانية ضمن الشحنة الموحدة",
      );
    });

    const [leaderAfter] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, 11));
    const [memberAfter] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, 12));
    expect(memberAfter?.status).toBe("CANCELLED");
    expect(leaderAfter?.codClaimVersion).toBe(2);
  });
});
