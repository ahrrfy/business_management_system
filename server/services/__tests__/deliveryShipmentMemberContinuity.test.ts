import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { cancelSale } from "../sale/cancel";
import { returnSale } from "../returnService";
import { openShift } from "../shiftService";
import { withTx } from "../tx";
import { money } from "../money";
import { recordDeliveryFeeHeldInTx } from "../delivery/feeHeld";
import { dispatchInvoiceShipment, getShipmentDetails, listShipmentInvoiceCandidates, shipmentFeeDeliveryProvenTx } from "../delivery/shipments";
import { cancelShipmentAssignment, confirmShipmentDelivery, returnShipment } from "../delivery/shipmentOperations";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { ledgerFeeDue, payDeliveryFee, payPartyDeliveryFees } from "../delivery/fees";
import { confirmConsignmentDelivery, listMyDeliveries, transitionConsignmentParcel } from "../delivery/courier";
import { recordCompanyStatement } from "../delivery/companyStatement";
import { listOpenConsignments } from "../delivery/queries";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const db = () => getDb()!;

beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "continuity-admin", name: "مدير", role: "admin", branchId: 1 });
  await db().insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0", creditLimit: "1000000" });
  await db().insert(s.deliveryParties).values({ id: 1, name: "شركة", partyType: "COMPANY", branchId: 1, currentBalance: "0", defaultFee: "0" });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "CONTINUITY-1", costPrice: "500" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true });
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000" });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
});

async function shipment(feeCollection: "SHOP" | "COUNTER" | "COURIER" = "SHOP") {
  const sales = [];
  for (const index of [1, 2]) sales.push(await createSale({ branchId: 1, sourceType: "POS", customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }], clientRequestId: `continuity-sale-${index}` }, actor));
  if (feeCollection === "COUNTER") {
    const [shift] = await db().select().from(s.shifts);
    await withTx(tx => recordDeliveryFeeHeldInTx(tx, { invoiceId: sales[0].invoiceId, branchId: 1,
      shiftId: shift.id, amount: money(1500), actorUserId: 1, description: "أمانة الشحنة" }));
  }
  return dispatchInvoiceShipment({ invoiceId: sales[0].invoiceId, invoiceIds: sales.map(sale => sale.invoiceId),
    partyId: 1, deliveryFee: "1500", feeCollection, externalTrackingRef: "CONTINUITY-TRACK",
    recipientPhone: "07701234567", clientRequestId: "continuity-dispatch" }, actor);
}

const cancel = (invoiceId: number) => cancelSale({ invoiceId, reason: "إلغاء فاتورة من الشحنة", refundPaymentMethod: "CASH",
  clientRequestId: `continuity-cancel-${invoiceId}`, enforceOperationalDecision: true }, actor);

async function returnInvoice(invoiceId: number, quantity: number) {
  const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId));
  return returnSale({ invoiceId, lines: [{ invoiceItemId: item.id, baseQuantity: quantity }], restock: true,
    operatorReason: "مرتجع مستقل من الشحنة", clientRequestId: `continuity-return-${invoiceId}-${quantity}` }, actor);
}

async function returnEffects() {
  return Promise.all([
    db().select().from(s.invoices), db().select().from(s.invoiceItems),
    db().select().from(s.receipts), db().select().from(s.accountingEntries),
    db().select().from(s.inventoryMovements), db().select().from(s.branchStock),
    db().select().from(s.customers), db().select().from(s.deliveryParties),
    db().select().from(s.deliveryConsignments), db().select().from(s.deliveryLedgerEntries),
  ]);
}

async function confirmAndRemit(consignmentId: number, collectedAmount = "10000") {
  const input = { consignmentId, collectedAmount, evidence: "اتصال شركة التوصيل", clientRequestId: "continuity-confirm" };
  await confirmShipmentDelivery(input, actor);
  expect(await confirmShipmentDelivery(input, actor)).toMatchObject({ idempotentReplay: true });
  const details = (await getShipmentDetails(consignmentId, actor))!;
  const invoiceRows = await db().select().from(s.invoices);
  const lines = details.members.filter(row => row.parcelStatus === "DELIVERED")
    .map(row => ({ consignmentId: Number(row.id), collectedAmount: invoiceRows.find(invoice => invoice.id === row.invoiceId)!.paidAmount }));
  const remit = { branchId: 1, partyId: 1, lines, countedCash: collectedAmount, shiftType: "RECEPTION" as const,
    clientRequestId: "continuity-remit" };
  await recordDeliveryRemittance(remit, actor);
  expect(await recordDeliveryRemittance(remit, actor)).toMatchObject({ idempotentReplay: true });
  return (await getShipmentDetails(consignmentId, actor))!;
}

describe("shipment continuity after independent invoice changes", () => {
  it.each((["SHOP", "COUNTER", "COURIER"] as const).flatMap(mode => [0, 1].map(index => ({ mode, index }))))
  ("$mode: cancels member $index while the other still confirms, remits and keeps one fee", async ({ mode, index }) => {
    const group = await shipment(mode);
    const originalReceipts = await db().select().from(s.receipts);
    await cancel(Number(group.members[index].invoiceId));
    expect(await db().select().from(s.receipts)).toEqual(originalReceipts);
    expect(await withTx(tx => shipmentFeeDeliveryProvenTx(tx, group.leaderConsignmentId))).toBe(false);
    const details = await confirmAndRemit(group.leaderConsignmentId);
    expect(details.members[index]).toMatchObject({ parcelStatus: "CANCELLED", invoiceRemaining: "0.00" });
    expect(details.members[1 - index]).toMatchObject({ parcelStatus: "DELIVERED", collectedAmount: "10000.00" });
    expect(details.remainingAmount).toBe("0.00");
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(2);
    expect((await db().select().from(s.deliveryLedgerEntries)).filter(row => row.entryType === "FEE_EARNED"))
      .toMatchObject([{ consignmentId: group.leaderConsignmentId, amount: "1500.00" }]);
    expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe("0.00");
    expect(details.members[0].externalTrackingRef).toBe("CONTINUITY-TRACK");
    expect(await withTx(tx => shipmentFeeDeliveryProvenTx(tx, group.leaderConsignmentId))).toBe(true);
    expect(await withTx(tx => ledgerFeeDue(tx, group.leaderConsignmentId))).toEqual(money(mode === "COURIER" ? 0 : 1500));
    if (mode !== "COURIER") expect((await listOpenConsignments(1, 1)).rows).toMatchObject([
      { id: group.leaderConsignmentId, feeDue: "1500.00" },
    ]);
    if (mode !== "COURIER") {
      const [shift] = await db().select().from(s.shifts);
      if (index === 0) {
        const input = { consignmentId: group.leaderConsignmentId, shiftId: shift.id, clientRequestId: "continuity-pay-fee" };
        await payDeliveryFee(input, actor);
        expect(await payDeliveryFee(input, actor)).toMatchObject({ replay: true });
      } else await payPartyDeliveryFees({ branchId: 1, partyId: 1, shiftId: shift.id, clientRequestId: "continuity-pay-fees" }, actor);
      expect((await db().select().from(s.deliveryLedgerEntries)).filter(row => row.entryType === "FEE_PAID"))
        .toMatchObject([{ consignmentId: group.leaderConsignmentId, amount: "1500.00" }]);
    }
    if (mode === "COUNTER") {
      const entries = await db().select().from(s.accountingEntries);
      expect(entries.filter(row => row.entryType === "DELIVERY_FEE_HELD").reduce((sum, row) => sum.plus(row.amount), money(0)).toFixed(2)).toBe("0.00");
    }
  });

  it.each([0, 1])("fully returns member %s while the survivor confirms and remits", async index => {
    const group = await shipment("COUNTER");
    const receipts = await db().select().from(s.receipts);
    await returnInvoice(Number(group.members[index].invoiceId), 10);
    expect(await db().select().from(s.receipts)).toEqual(receipts);
    const details = await confirmAndRemit(group.leaderConsignmentId);
    expect(details.members[index]).toMatchObject({ parcelStatus: "RETURNED", invoiceRemaining: "0.00", operational: false });
    expect(details.members[1 - index]).toMatchObject({ parcelStatus: "DELIVERED", collectedAmount: "10000.00" });
    expect((await db().select().from(s.deliveryLedgerEntries)).filter(row => row.entryType === "FEE_EARNED")).toHaveLength(1);
  });

  it("partial returns adjust each invoice independently before one confirmation and remittance", async () => {
    const group = await shipment();
    await returnInvoice(Number(group.members[0].invoiceId), 2);
    await returnInvoice(Number(group.members[1].invoiceId), 3);
    const before = (await getShipmentDetails(group.leaderConsignmentId, actor))!;
    expect(before.members.map(row => row.invoiceRemaining)).toEqual(["8000.00", "7000.00"]);
    expect(before.members.map(row => row.parcelStatus)).toEqual(["OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY"]);
    const details = await confirmAndRemit(group.leaderConsignmentId, "15000");
    expect(details.members.map(row => row.collectedAmount)).toEqual(["8000.00", "7000.00"]);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(85);
  });

  it("returns the surviving goods and refunds the original held fee once after its invoice was cancelled", async () => {
    const group = await shipment("COUNTER");
    await cancel(Number(group.members[0].invoiceId));
    const input = { consignmentId: group.leaderConsignmentId, reason: "وصلت البضاعة المتبقية للمكتبة", clientRequestId: "continuity-physical-return" };
    await returnShipment(input, actor);
    expect(await returnShipment(input, actor)).toMatchObject({ idempotentReplay: true });
    const receipts = await db().select().from(s.receipts);
    expect(receipts.filter(row => row.direction === "OUT")).toMatchObject([{ invoiceId: group.members[0].invoiceId, amount: "1500.00" }]);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
    const details = (await getShipmentDetails(group.leaderConsignmentId, actor))!;
    expect(details.members.map(row => row.parcelStatus)).toEqual(["CANCELLED", "RETURNED"]);
  });

  it("rolls back collection and fee accrual if the next remaining invoice rejects confirmation", async () => {
    const group = await shipment();
    await returnInvoice(Number(group.members[0].invoiceId), 2);
    await db().update(s.deliveryConsignments).set({ returnDeclaredAt: new Date() }).where(eq(s.deliveryConsignments.id, group.members[1].id));
    const snapshot = () => Promise.all([db().select().from(s.invoices), db().select().from(s.deliveryConsignments), db().select().from(s.deliveryLedgerEntries),
      db().select().from(s.accountingEntries), db().select().from(s.deliveryParties), db().select().from(s.idempotencyKeys)]);
    const before = await snapshot();
    await expect(confirmShipmentDelivery({ consignmentId: group.leaderConsignmentId, collectedAmount: "18000", evidence: "اتصال الشركة", clientRequestId: "continuity-failed" }, actor)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await snapshot()).toEqual(before);
  });

  it("company statement needs only surviving invoices after cancellation of the leader", async () => {
    const group = await shipment();
    await cancel(Number(group.members[0].invoiceId));
    const input = { branchId: 1, partyId: 1, statementNumber: "CONTINUITY-STATEMENT", lines: [{ consignmentId: group.members[1].id, collectedAmount: "10000" }],
      countedCash: "10000", shiftType: "RECEPTION" as const, clientRequestId: "continuity-statement" };
    expect(await recordCompanyStatement(input, actor)).toMatchObject({ deliveriesConfirmed: 1, collectedTotal: "10000.00" });
    expect(await recordCompanyStatement(input, actor)).toMatchObject({ idempotentReplay: true });
  });

  it.each([0, 1])("redispatches the surviving original member after invoice %s exits and its shipment assignment is cancelled", async index => {
    const group = await shipment("COUNTER");
    const deadId = Number(group.members[index].invoiceId);
    const survivorId = Number(group.members[1 - index].invoiceId);
    await cancel(deadId);
    await cancelShipmentAssignment({ consignmentId: group.leaderConsignmentId, reason: "إعادة جدولة التوصيل", clientRequestId: "continuity-cancel-assignment" }, actor);
    const choices = await listShipmentInvoiceCandidates(survivorId, actor);
    expect(choices.requiredInvoiceIds).toEqual([survivorId]);
    expect(choices.candidates).toHaveLength(0);
    const input = { invoiceId: survivorId, invoiceIds: [survivorId], partyId: 1, deliveryFee: "1500", feeCollection: "COUNTER" as const,
      externalTrackingRef: "CONTINUITY-TRACK", recipientPhone: "07701234567", clientRequestId: "continuity-redispatch" };
    expect(await dispatchInvoiceShipment(input, actor)).toMatchObject({ leaderConsignmentId: group.leaderConsignmentId });
    expect(await dispatchInvoiceShipment(input, actor)).toMatchObject({ idempotentReplay: true });
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, deadId)))[0].status).toBe("CANCELLED");
    const details = await confirmAndRemit(group.leaderConsignmentId);
    expect(details.members[index].parcelStatus).toBe("CANCELLED");
    expect(details.members[1 - index].parcelStatus).toBe("DELIVERED");
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(2);
  });

  it("redispatches a live leader to a new party without changing its closed follower or historical party ledger", async () => {
    const group = await shipment("SHOP");
    const leader = group.members[0];
    const closed = group.members[1];
    await cancel(Number(closed.invoiceId));
    await cancelShipmentAssignment({ consignmentId: group.leaderConsignmentId, reason: "تغيير جهة التوصيل", clientRequestId: "new-party-cancel" }, actor);
    const [closedBefore] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, closed.id));
    const oldLedger = await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.partyId, 1));
    await db().insert(s.deliveryParties).values({ id: 2, name: "شركة جديدة", partyType: "COMPANY", branchId: 1, currentBalance: "0", defaultFee: "0" });
    const dispatch = { invoiceId: Number(leader.invoiceId), invoiceIds: [Number(leader.invoiceId)], partyId: 2,
      deliveryFee: "1500", feeCollection: "SHOP" as const, externalTrackingRef: "NEW-PARTY-TRACK", clientRequestId: "new-party-dispatch" };
    expect(await dispatchInvoiceShipment(dispatch, actor)).toMatchObject({ leaderConsignmentId: group.leaderConsignmentId });
    expect(await dispatchInvoiceShipment(dispatch, actor)).toMatchObject({ idempotentReplay: true });
    const details = await getShipmentDetails(Number(closed.id), actor);
    expect(await getShipmentDetails(group.leaderConsignmentId, actor)).toEqual(details);
    expect(details!.members.map(row => [Number(row.partyId), row.operational])).toEqual([[2, true], [1, false]]);
    expect(await withTx(tx => shipmentFeeDeliveryProvenTx(tx, group.leaderConsignmentId))).toBe(false);
    const confirm = { consignmentId: Number(closed.id), collectedAmount: "10000", evidence: "اتصال الشركة الجديدة", clientRequestId: "new-party-confirm" };
    await confirmShipmentDelivery(confirm, actor);
    expect(await confirmShipmentDelivery(confirm, actor)).toMatchObject({ idempotentReplay: true });
    expect(await withTx(tx => shipmentFeeDeliveryProvenTx(tx, group.leaderConsignmentId))).toBe(true);
    expect(await withTx(tx => shipmentFeeDeliveryProvenTx(tx, Number(closed.id)))).toBe(false);
    const fees = (await db().select().from(s.deliveryLedgerEntries)).filter(row => row.entryType === "FEE_EARNED");
    expect(fees).toMatchObject([{ partyId: 2, consignmentId: group.leaderConsignmentId, amount: "1500.00" }]);
    expect(await withTx(tx => ledgerFeeDue(tx, group.leaderConsignmentId))).toEqual(money(1500));
    const remit = { branchId: 1, partyId: 2, lines: [{ consignmentId: group.leaderConsignmentId, collectedAmount: "10000" }],
      countedCash: "10000", shiftType: "RECEPTION" as const, clientRequestId: "new-party-remit" };
    await recordDeliveryRemittance(remit, actor);
    expect(await recordDeliveryRemittance(remit, actor)).toMatchObject({ idempotentReplay: true });
    const [shift] = await db().select().from(s.shifts);
    await payPartyDeliveryFees({ branchId: 1, partyId: 2, shiftId: shift.id, clientRequestId: "new-party-fee" }, actor);
    expect(await withTx(tx => ledgerFeeDue(tx, group.leaderConsignmentId))).toEqual(money(0));
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, closed.id)))[0]).toEqual(closedBefore);
    expect(await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.partyId, 1))).toEqual(oldLedger);
    expect((await db().select().from(s.deliveryParties)).map(row => row.currentBalance)).toEqual(["0.00", "0.00"]);
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(90);
  });

  it("courier keeps the original tracking and fee after the leader exits, then confirms the survivor", async () => {
    const group = await shipment("COURIER");
    await db().insert(s.users).values({ id: 2, openId: "continuity-driver", role: "courier", branchId: 1 });
    await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 2, memberRole: "DRIVER", isActive: true, createdBy: 1 });
    await db().update(s.deliveryConsignments).set({ parcelStatus: "ASSIGNED" }).where(eq(s.deliveryConsignments.id, group.members[1].id));
    await cancel(Number(group.members[0].invoiceId));
    const listed = await listMyDeliveries(2);
    expect(listed.toDeliver).toMatchObject([{ id: group.leaderConsignmentId, externalTrackingRef: "CONTINUITY-TRACK", courierFee: "1500.00", codDue: "10000.00" }]);
    for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) await transitionConsignmentParcel({ consignmentId: group.leaderConsignmentId, toStatus, clientRequestId: `continuity-${toStatus}` }, { userId: 2 });
    const input = { consignmentId: group.leaderConsignmentId, clientRequestId: "continuity-portal" };
    expect(await confirmConsignmentDelivery(input, { userId: 2 })).toMatchObject({ consignmentId: group.leaderConsignmentId });
    expect(await confirmConsignmentDelivery(input, { userId: 2 })).toMatchObject({ alreadyDelivered: true });
    expect((await getShipmentDetails(group.leaderConsignmentId, actor))!.members[0].parcelStatus).toBe("CANCELLED");
  });

  it("returns one collected invoice before remittance, reversing only its unremitted custody", async () => {
    const group = await shipment();
    await confirmShipmentDelivery({ consignmentId: group.leaderConsignmentId, collectedAmount: "20000", evidence: "اتصال الشركة", clientRequestId: "continuity-post-collection" }, actor);
    const survivorId = Number(group.members[1].invoiceId);
    const survivor = (await db().select().from(s.invoices).where(eq(s.invoices.id, survivorId)))[0];
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, group.members[1].id)))[0];
    const result = await returnInvoice(Number(group.members[0].invoiceId), 10);
    expect(result.refundReceiptId).toBeNull();
    const effects = await returnEffects();
    // Receipt IDs are execution-only adapter metadata; replay retains the public return outcome.
    expect(await returnInvoice(Number(group.members[0].invoiceId), 10)).toEqual({
      invoiceId: Number(group.members[0].invoiceId), returnedTotal: "10000.00", fullyReturned: true,
      pendingRefundAmount: "0.00", pendingRefundVoucherNumber: null, idempotentReplay: true,
    });
    expect(await returnEffects()).toEqual(effects);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, survivorId)))[0]).toEqual(survivor);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, group.members[1].id)))[0]).toEqual(cn);
    expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe("10000.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(90);
    await recordDeliveryRemittance({ branchId: 1, partyId: 1, lines: [{ consignmentId: group.members[1].id, collectedAmount: "10000" }], countedCash: "10000",
      shiftType: "RECEPTION", clientRequestId: "continuity-survivor-remit" }, actor);
    expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.deliveryLedgerEntries)).filter(row => row.entryType === "FEE_EARNED")).toHaveLength(1);
  });

  it("partially returns one remitted invoice with an explicit drawer refund and preserves its sibling", async () => {
    const group = await shipment();
    await confirmAndRemit(group.leaderConsignmentId, "20000");
    const targetId = Number(group.members[0].invoiceId);
    const survivorId = Number(group.members[1].invoiceId);
    const survivor = (await db().select().from(s.invoices).where(eq(s.invoices.id, survivorId)))[0];
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, group.members[1].id)))[0];
    const ledger = (await db().select().from(s.deliveryLedgerEntries)).filter(row => row.consignmentId === group.members[1].id);
    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, targetId));
    const [shift] = await db().select().from(s.shifts);
    const input = { invoiceId: targetId, lines: [{ invoiceItemId: item.id, baseQuantity: 2 }], restock: true,
      refund: { method: "CASH" as const, amount: "2000", shiftId: shift.id }, operatorReason: "رد جزئي بعد التوريد", clientRequestId: "continuity-after-remit-return" };
    const result = await returnSale(input, actor);
    expect(result.refundReceiptId).toBeTruthy();
    expect("refundReceiptIds" in result && result.refundReceiptIds).toEqual([result.refundReceiptId]);
    const effects = await returnEffects();
    expect(await returnSale(input, actor)).toEqual({
      invoiceId: targetId, returnedTotal: "2000.00", fullyReturned: false,
      pendingRefundAmount: "0.00", pendingRefundVoucherNumber: null, idempotentReplay: true,
    });
    expect(await returnEffects()).toEqual(effects);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, survivorId)))[0]).toEqual(survivor);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, group.members[1].id)))[0]).toEqual(cn);
    expect((await db().select().from(s.deliveryLedgerEntries)).filter(row => row.consignmentId === group.members[1].id)).toEqual(ledger);
    expect((await db().select().from(s.receipts)).filter(row => row.direction === "OUT")).toMatchObject([{ invoiceId: targetId, amount: "2000.00" }]);
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(82);
    expect((await db().select().from(s.deliveryLedgerEntries)).filter(row => row.entryType === "FEE_EARNED")).toHaveLength(1);
  });
});
