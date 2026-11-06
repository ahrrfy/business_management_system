import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
} from "../../../drizzle/fulfillmentSchema";
import {
  createFulfillmentCharge,
  approveFulfillmentCharge,
  refundFulfillmentCharge,
} from "../fulfillment/charges";
import { returnConsignment } from "../delivery/returns";
import { returnByBarcode } from "../delivery/barcodeReturnService";
import * as s from "../../../drizzle/schema";
import type { WorkflowDispatchSource } from "../../../shared/deliveryWorkflow";
import { getDb } from "../../db";
import { dispatchWorkflowBatch } from "../delivery/workflow/dispatch";
import { previewWorkflowSource } from "../delivery/workflow/preview";
import { mutateWorkflowAssignment } from "../delivery/workflow/assignment";
import { receiveWorkflowReturn } from "../delivery/workflow/returns";
import { confirmWorkflowDelivery } from "../delivery/workflow/collection";
import { PHYSICAL_RETURN_RECEIVED, physicalReturnReceiptExistsSql, physicalReturnReceiptTx } from "../delivery/workflow/returnReceipt";
import { acknowledgeConsignmentClaim, confirmConsignmentDelivery, listMyDeliveries } from "../delivery/courier";
import { withTx } from "../tx";
import { returnSale } from "../returnService";
import { reconcileDeliveryOnReturnTx } from "../delivery/returnReconciliation";
import { returnShipment } from "../delivery/shipmentOperations";
import { recordDeliveryRemittance } from "../delivery/remittance";
import {
  listOpenConsignments,
  listPartyObligations,
} from "../delivery/queries";

const actor = { userId: 1, branchId: 1, role: "admin" };
function db() {
  const value = getDb();
  if (!value) throw new Error("Isolated DB required");
  return value;
}
async function courierSnapshot(id: number) {
  const row = (await listMyDeliveries(2)).toDeliver.find((entry) => entry.id === id)!;
  return { expectedClaimAmount: row.codDue, expectedConsignmentIds: row.consignmentIds ?? [id],
    expectedConsignmentClaims: row.consignmentClaims };
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "physical-return-owner",
    role: "admin",
    isOwner: true,
    branchId: 1,
  });
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل العهدة",
    phone: "07701234567",
    currentBalance: "200.00",
    creditLimit: null,
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    partyType: "INDIVIDUAL",
    name: "ناقل خارجي محدد",
    branchId: 1,
    userId: null,
    isActive: true,
    currentBalance: "0.00",
  });
  await db().insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    shiftType: "RETAIL",
    status: "OPEN",
    openingBalance: "0",
    openGuard: "1:1:RETAIL",
  });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "PHYSICAL-RETURN",
    costPrice: "40.00",
  });
  await db()
    .insert(s.branchStock)
    .values({ branchId: 1, variantId: 1, quantity: 8 });
  for (const id of [1, 2]) {
    await db()
      .insert(s.invoices)
      .values({
        id,
        invoiceNumber: String(92000 + id),
        branchId: 1,
        customerId: 1,
        subtotal: "100.00",
        total: "100.00",
        costTotal: "40.00",
        paidAmount: "0.00",
        paymentMode: "COD",
        createdBy: 1,
      });
    await db().insert(s.invoiceItems).values({
      invoiceId: id,
      variantId: 1,
      quantity: "1",
      baseQuantity: 1,
      unitPrice: "100.00",
      unitCost: "40.00",
      lineCost: "40.00",
      total: "100.00",
    });
    await db().insert(s.inventoryMovements).values({
      variantId: 1,
      branchId: 1,
      quantity: 1,
      movementType: "OUT",
      referenceType: "INVOICE",
      referenceId: id,
      createdBy: 1,
    });
  }
});
async function source(id: number): Promise<WorkflowDispatchSource> {
  const p = await previewWorkflowSource(
    { source: { kind: "consignment", id }, station: "return", branchId: 1 },
    actor,
  );
  return {
    kind: p.source.kind,
    id: p.source.id,
    expectedVersion: p.source.version,
  };
}
async function dispatch(invoiceIds = [1, 2]) {
  const sources: WorkflowDispatchSource[] = [];
  for (const id of invoiceIds) {
    const p = await previewWorkflowSource(
      { source: { kind: "invoice", id }, station: "dispatch", branchId: 1 },
      actor,
    );
    sources.push({
      kind: p.source.kind,
      id: p.source.id,
      expectedVersion: p.source.version,
    });
  }
  const dispatched = await dispatchWorkflowBatch(
    {
      sources,
      branchId: 1,
      partyId: 1,
      deliveryFee: "0.00",
      feeCollection: "COURIER",
      recipientName: "عميل العهدة",
      recipientPhone: "07701234567",
      deliveryAddress: "بغداد المنصور قرب المكتبة",
      clientRequestId: "physical-original-dispatch",
    },
    actor,
  );
  const p = await previewWorkflowSource(
    {
      source: { kind: "consignment", id: dispatched.consignmentId },
      station: "return",
      branchId: 1,
    },
    actor,
  );
  return { ...dispatched, consignmentIds: p.group!.consignmentIds };
}
async function declare(id: number) {
  return mutateWorkflowAssignment(
    {
      source: await source(id),
      branchId: 1,
      action: "declareReturn",
      reason: "العميل يطلب رجوع الطرود",
      clientRequestId: "physical-declare-original",
    },
    actor,
  );
}
async function receive(id: number, ids: number[], key: string) {
  const input = {
    source: await source(id),
    branchId: 1,
    inspected: true as const,
    evidence: "استلمت الطرود المحددة وفحصتها سليمة بعهدة المكتبة",
    receivedConsignmentIds: ids,
    clientRequestId: key,
  };
  return { input, result: await receiveWorkflowReturn(input, actor) };
}
async function economics() {
  return {
    invoices: await db().select().from(s.invoices),
    items: await db().select().from(s.invoiceItems),
    customers: await db().select().from(s.customers),
    stock: await db().select().from(s.branchStock),
    movements: await db().select().from(s.inventoryMovements),
    receipts: await db().select().from(s.receipts),
    accounting: await db().select().from(s.accountingEntries),
    journals: await db().select().from(s.journalEntries),
    lines: await db().select().from(s.journalLines),
    parties: await db().select().from(s.deliveryParties),
    ledger: await db().select().from(s.deliveryLedgerEntries),
  };
}
describe("physical return receipt separate from commercial and money actions", () => {
  it("matches numeric work-order identifiers consistently in receipt readers", async () => {
    await db().insert(s.workOrders).values({ id: 1, orderNumber: "RETURN-WORK-1", branchId: 1, title: "عمل مسترجع" });
    await db().insert(s.deliveryConsignments).values({
      id: 100, consignmentNumber: "RETURN-WORK-CN-1", branchId: 1, partyId: 1,
      sourceType: "WORK_ORDER", sourceId: 1, invoiceId: 1, workOrderId: 1, codAmount: "0.00",
      parcelStatus: "RETURNED", returnedAt: new Date(),
    });
    const [row] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 100));
    const payload = {
      version: 1, inspected: true, branchId: row.branchId, sourceType: row.sourceType, sourceId: row.sourceId,
      invoiceId: row.invoiceId, workOrderId: row.workOrderId, fulfillmentRequestId: row.fulfillmentRequestId,
      claimVersion: row.codClaimVersion, dispatchedAt: row.dispatchedAt.toISOString(), evidence: "دليل استلام كافٍ",
    };
    await db().insert(s.deliveryEvents).values({
      eventKey: "numeric-work-order-receipt", consignmentId: 100, eventType: PHYSICAL_RETURN_RECEIVED, payload, actorUserId: 1,
    });
    const valid = async () => {
      const [projection] = await db().select({ physical: physicalReturnReceiptExistsSql() })
        .from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 100));
      return [Boolean(await withTx((tx) => physicalReturnReceiptTx(tx, row))), Boolean(projection.physical)];
    };
    await db().update(s.deliveryEvents).set({ payload: sql`JSON_SET(${s.deliveryEvents.payload}, '$.workOrderId', CAST('1.0' AS JSON))` })
      .where(eq(s.deliveryEvents.eventKey, "numeric-work-order-receipt"));
    expect(await valid()).toEqual([true, true]);
    await db().update(s.deliveryEvents).set({ payload: { ...payload, workOrderId: "1" } })
      .where(eq(s.deliveryEvents.eventKey, "numeric-work-order-receipt"));
    expect(await valid()).toEqual([false, false]);
  });

  it("retains the original inspected receipt after a partial sale return of that received parcel", async () => {
    await db().update(s.invoiceItems).set({ quantity: "2", baseQuantity: 2, unitPrice: "50.00" })
      .where(eq(s.invoiceItems.invoiceId, 1));
    await db().update(s.inventoryMovements).set({ quantity: 2 }).where(and(
      eq(s.inventoryMovements.referenceType, "INVOICE"), eq(s.inventoryMovements.referenceId, 1)));
    const shipment = await dispatch();
    const leaderId = shipment.consignmentId;
    await receive(leaderId, [leaderId], "physical-leader-before-sale-return");
    const [before] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 1));
    await returnSale({ invoiceId: 1, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "physical-received-partial-sale-return" }, actor);
    const [after] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(after.codClaimVersion).toBe(before.codClaimVersion);
    expect(after.returnedAt?.getTime()).toBe(before.returnedAt?.getTime());
    expect(await withTx((tx) => physicalReturnReceiptTx(tx, after))).not.toBeNull();
    const [projection] = await db().select({ physical: physicalReturnReceiptExistsSql() })
      .from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(Boolean(projection.physical)).toBe(true);
    await receive(leaderId, [shipment.consignmentIds.find((id) => id !== leaderId)!], "physical-other-after-partial-return");
    const commercial = { barcode: shipment.consignmentNumber,
      returnReason: "إرجاع تجاري بعد الاستلام الفعلي والمرتجع الجزئي",
      clientRequestId: "physical-commercial-after-partial" };
    await expect(returnByBarcode(commercial, actor)).rejects.toThrow(/استكمل مرتجع/);
    await returnSale({ invoiceId: 1, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "physical-received-complete-sale-return" }, actor);
    await expect(returnByBarcode(commercial, actor)).resolves.toBeDefined();
  });

  it("keeps a received leader's receipt linked while an active member's changed claim requires acknowledgement", async () => {
    await db().update(s.invoiceItems).set({ quantity: "2", baseQuantity: 2, unitPrice: "50.00" })
      .where(eq(s.invoiceItems.invoiceId, 2));
    await db().update(s.inventoryMovements).set({ quantity: 2 }).where(and(
      eq(s.inventoryMovements.referenceType, "INVOICE"), eq(s.inventoryMovements.referenceId, 2)));
    const shipment = await dispatch();
    const leaderId = shipment.consignmentId;
    await receive(leaderId, [leaderId], "physical-leader-received-first");
    const [afterReceipt] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(afterReceipt.codClaimVersion).toBe(2);
    expect(await withTx((tx) => physicalReturnReceiptTx(tx, afterReceipt))).not.toBeNull();
    const [receiptProjection] = await db().select({ physical: physicalReturnReceiptExistsSql() })
      .from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(Boolean(receiptProjection.physical)).toBe(true);
    await db().insert(s.users).values({ id: 2, openId: "physical-claim-driver", role: "courier", branchId: 1 });
    await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 2, memberRole: "DRIVER", isActive: true, createdBy: 1 });
    const [originalReceipt] = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.eventType, PHYSICAL_RETURN_RECEIVED));
    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2));
    await returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true, clientRequestId: "physical-leader-member-sale-return" }, actor);
    const [leader] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(leader.codClaimVersion).toBe(3);
    const changes = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.eventType, "COD_CLAIM_CHANGED"));
    const change = changes.find((event) => (event.payload as { source?: string })?.source === "SALE_RETURN")!;
    expect(change.payload).toMatchObject({ physicalReturnReceiptEventId: originalReceipt.id, claimVersion: 3 });
    expect((await withTx((tx) => physicalReturnReceiptTx(tx, leader)))?.id).toBe(originalReceipt.id);
    const [projection] = await db().select({ physical: physicalReturnReceiptExistsSql() })
      .from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(Boolean(projection.physical)).toBe(true);
    const currentPreview = await previewWorkflowSource({ source: { kind: "consignment", id: leaderId }, station: "return", branchId: 1 }, actor);
    expect(currentPreview.returnState?.members.find((member) => member.consignmentId === leaderId)?.received).toBe(true);
    const receiptPayload = originalReceipt.payload as Record<string, unknown>;
    const changePayload = change.payload as Record<string, unknown>;
    const expectReceiptValidity = async (valid: boolean) => {
      const [row] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
      const [view] = await db().select({ physical: physicalReturnReceiptExistsSql() })
        .from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
      expect(Boolean(await withTx((tx) => physicalReturnReceiptTx(tx, row)))).toBe(valid);
      expect(Boolean(view.physical)).toBe(valid);
    };
    for (const altered of [
      { evidence: " \u00a0\ufeff " }, { claimVersion: "1" }, { inspected: "true" }, { invoiceId: "1" }, { sourceType: "invoice" },
    ]) {
      await db().update(s.deliveryEvents).set({ payload: { ...receiptPayload, ...altered } }).where(eq(s.deliveryEvents.id, originalReceipt.id));
      await expectReceiptValidity(false);
    }
    for (const [path, value] of [
      ["$.version", "1.0"], ["$.branchId", "1.0"],
      ["$.sourceId", `${receiptPayload.sourceId}.0`], ["$.invoiceId", `${receiptPayload.invoiceId}.0`],
      ["$.fulfillmentRequestId", `${receiptPayload.fulfillmentRequestId}.0`], ["$.claimVersion", "1.0"],
    ]) {
      await db().update(s.deliveryEvents).set({ payload: receiptPayload }).where(eq(s.deliveryEvents.id, originalReceipt.id));
      await db().update(s.deliveryEvents).set({ payload: sql`JSON_SET(${s.deliveryEvents.payload}, ${path}, CAST(${value} AS JSON))` })
        .where(eq(s.deliveryEvents.id, originalReceipt.id));
      await expectReceiptValidity(true);
    }
    for (const value of ["1.5", "-1", "9007199254740992"]) {
      await db().update(s.deliveryEvents).set({ payload: receiptPayload }).where(eq(s.deliveryEvents.id, originalReceipt.id));
      await db().update(s.deliveryEvents).set({ payload: sql`JSON_SET(${s.deliveryEvents.payload}, '$.claimVersion', CAST(${value} AS JSON))` })
        .where(eq(s.deliveryEvents.id, originalReceipt.id));
      await expectReceiptValidity(false);
    }
    await db().update(s.deliveryEvents).set({ payload: { ...receiptPayload, evidence: "\u00a0😀😀😀\ufeff" } }).where(eq(s.deliveryEvents.id, originalReceipt.id));
    await expectReceiptValidity(true); // Three astral characters are six UTF-16 code units after trim.
    await db().update(s.deliveryEvents).set({ payload: receiptPayload }).where(eq(s.deliveryEvents.id, originalReceipt.id));
    for (const altered of [{ claimVersion: "3" }, { physicalReturnReceiptEventId: String(originalReceipt.id) }]) {
      await db().update(s.deliveryEvents).set({ payload: { ...changePayload, ...altered } }).where(eq(s.deliveryEvents.id, change.id));
      await expectReceiptValidity(false);
    }
    await db().update(s.deliveryEvents).set({ payload: changePayload }).where(eq(s.deliveryEvents.id, change.id));
    await db().update(s.deliveryEvents).set({ payload: sql`JSON_SET(${s.deliveryEvents.payload}, '$.claimVersion', CAST('3.0' AS JSON), '$.physicalReturnReceiptEventId', CAST(${`${originalReceipt.id}.0`} AS JSON))` })
      .where(eq(s.deliveryEvents.id, change.id));
    await expectReceiptValidity(true);
    await db().update(s.deliveryEvents).set({ payload: changePayload }).where(eq(s.deliveryEvents.id, change.id));
    const view = await courierSnapshot(leaderId);
    expect(view.expectedConsignmentIds).toEqual([shipment.consignmentIds.find((id) => id !== leaderId)]);
    await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 3, ...view, clientRequestId: "received-leader-no-ack" },
      { userId: 2 }, undefined, { requireFullCollection: true })).rejects.toThrow(/أقر/);
    await acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 3, ...view,
      clientRequestId: "received-leader-ack-claim" }, { userId: 2 });
    await confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 3, ...view, clientRequestId: "received-leader-ack-deliver" },
      { userId: 2 }, undefined, { requireFullCollection: true });
    const [after] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect((await withTx((tx) => physicalReturnReceiptTx(tx, after)))?.id).toBe(originalReceipt.id);
    // An unrelated increment never inherits the historical receipt by age alone.
    await db().update(s.deliveryConsignments).set({ codClaimVersion: 4 }).where(eq(s.deliveryConsignments.id, leaderId));
    const [unrelated] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(await withTx((tx) => physicalReturnReceiptTx(tx, unrelated))).toBeNull();
    const [unrelatedProjection] = await db().select({ physical: physicalReturnReceiptExistsSql() })
      .from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(Boolean(unrelatedProjection.physical)).toBe(false);
    await db().update(s.deliveryConsignments).set({ codClaimVersion: 3 }).where(eq(s.deliveryConsignments.id, leaderId));
    await expectReceiptValidity(true);
    // Both readers intentionally inspect only the latest 30 receipt events.
    await db().insert(s.deliveryEvents).values(Array.from({ length: 30 }, (_, index) => ({
      eventKey: `invalid-receipt-window-${leaderId}-${index}`,
      consignmentId: leaderId, eventType: PHYSICAL_RETURN_RECEIVED, payload: {}, actorUserId: 1,
    })));
    await expectReceiptValidity(false);
  });

  for (const legacy of [false, true]) {
    it(`${legacy ? "legacy" : "new"} physical member receipt invalidates the old group claim exactly once`, async () => {
      await db().update(s.invoiceItems).set({ quantity: "2", baseQuantity: 2, unitPrice: "50.00" })
        .where(eq(s.invoiceItems.invoiceId, 2));
      await db().update(s.inventoryMovements).set({ quantity: 2 }).where(and(
        eq(s.inventoryMovements.referenceType, "INVOICE"), eq(s.inventoryMovements.referenceId, 2)));
      const shipment = await dispatch();
      const leaderId = shipment.consignmentId;
      const memberId = shipment.consignmentIds.find((id) => id !== leaderId)!;
      await db().insert(s.users).values({ id: 2, openId: "receipt-version-driver", role: "courier", branchId: 1 });
      await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 2, memberRole: "DRIVER", isActive: true, createdBy: 1 });
      await acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 1,
        clientRequestId: "ack-before-physical-member" }, { userId: 2 });
      const received = await receive(leaderId, [memberId], "physical-remove-member");
      expect((await receiveWorkflowReturn(received.input, actor)).idempotentReplay).toBe(true);
      const [physicalChange] = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.eventType, "COD_CLAIM_CHANGED"));
      const [receipt] = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.eventType, PHYSICAL_RETURN_RECEIVED));
      expect(physicalChange.payload).toMatchObject({ source: "PHYSICAL_RETURN", claimVersion: 2, removedReceiptEventIds: [receipt.id] });
      if (legacy) {
        // Simulate the pre-fix database state: physical receipt exists, but its
        // membership change was never versioned or recorded on the leader.
        await db().delete(s.deliveryEvents).where(eq(s.deliveryEvents.id, physicalChange.id));
        await db().update(s.deliveryConsignments).set({ codClaimVersion: 1 }).where(eq(s.deliveryConsignments.id, leaderId));
        const before = await Promise.all([db().select().from(s.deliveryConsignments), db().select().from(s.invoices),
          db().select().from(s.deliveryLedgerEntries), db().select().from(s.deliveryEvents)]);
        await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 1,
          expectedClaimAmount: "100.00", clientRequestId: "legacy-members-missing" }, { userId: 2 }))
          .rejects.toMatchObject({ code: "CONFLICT" });
        await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 1,
          expectedConsignmentIds: [leaderId, memberId], expectedClaimAmount: "200.00",
          expectedConsignmentClaims: [{ consignmentId: leaderId, amount: "100.00" }, { consignmentId: memberId, amount: "100.00" }],
          clientRequestId: "legacy-members-stale" }, { userId: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await Promise.all([db().select().from(s.deliveryConsignments), db().select().from(s.invoices),
          db().select().from(s.deliveryLedgerEntries), db().select().from(s.deliveryEvents)])).toEqual(before);
      }
      const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, 2));
      for (const key of ["first", "second"]) {
        await returnSale({ invoiceId: 2, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
          restock: true, clientRequestId: `receipt-member-return-${key}` }, actor);
        const [leader] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
        const [member] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, memberId));
        expect(leader.codClaimVersion).toBe(2);
        expect((await withTx((tx) => physicalReturnReceiptTx(tx, member)))?.id).toBe(receipt.id);
      }
      await expect(acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 1,
        clientRequestId: "stale-receipt-claim-ack" }, { userId: 2 })).rejects.toThrow(/تغيرت المطالبة/);
      const view = await courierSnapshot(leaderId);
      await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 2, ...view, clientRequestId: "receipt-member-no-ack" },
        { userId: 2 }, undefined, { requireFullCollection: true })).rejects.toThrow(/أقر/);
      await acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 2, ...view,
        clientRequestId: "receipt-member-ack" }, { userId: 2 });
      await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 2, ...view, clientRequestId: "receipt-member-deliver" },
        { userId: 2 }, undefined, { requireFullCollection: true })).resolves.toBeDefined();
    });
  }

  it("versions removal of a fully returned member even when its live claim is zero", async () => {
    const shipment = await dispatch();
    const leaderId = shipment.consignmentId;
    const memberId = shipment.consignmentIds.find((id) => id !== leaderId)!;
    await db().insert(s.users).values({ id: 2, openId: "zero-claim-member-driver", role: "courier", branchId: 1 });
    await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 2, memberRole: "DRIVER", isActive: true, createdBy: 1 });
    await acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 1,
      clientRequestId: "ack-before-zero-member-return" }, { userId: 2 });
    // A previously settled member can leave the physical group without releasing additional COD.
    await db().update(s.invoices).set({ paidAmount: "100.00" }).where(eq(s.invoices.id, 2));
    await db().update(s.deliveryConsignments).set({ counterSettledAmount: "100.00" }).where(eq(s.deliveryConsignments.id, memberId));
    await withTx((tx) => reconcileDeliveryOnReturnTx(tx, { invoiceId: 2, returnedTotal: "100.00", isFullReturn: true,
      actor, clientRequestId: "full-return-zero-member" }));
    const [leader] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(leader.codClaimVersion).toBe(2);
    const [change] = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.eventType, "COD_CLAIM_CHANGED"));
    expect(change.payload).toMatchObject({ source: "SALE_RETURN", amountReleased: "0.00", claimVersion: 2 });
    const view = await courierSnapshot(leaderId);
    await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 2, ...view, clientRequestId: "zero-member-no-ack" },
      { userId: 2 }, undefined, { requireFullCollection: true })).rejects.toThrow(/أقر/);
    await acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 2, ...view,
      clientRequestId: "ack-after-zero-member-return" }, { userId: 2 });
    await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 2, ...view, clientRequestId: "zero-member-deliver" },
      { userId: 2 }, undefined, { requireFullCollection: true })).resolves.toBeDefined();
  });

  it("versions a multi-parcel receipt once and preserves the leader receipt across a later receipt", async () => {
    for (const id of [3, 4]) {
      await db().insert(s.invoices).values({ id, invoiceNumber: String(92000 + id), sourceType: "POS", branchId: 1, customerId: 1,
        subtotal: "100.00", total: "100.00", costTotal: "40.00", paidAmount: "0.00", paymentMode: "COD", createdBy: 1 });
      await db().insert(s.invoiceItems).values({ invoiceId: id, variantId: 1, quantity: "1", baseQuantity: 1,
        unitPrice: "100.00", unitCost: "40.00", lineCost: "40.00", total: "100.00" });
    }
    const shipment = await dispatch([1, 2, 3, 4]);
    const leaderId = shipment.consignmentId;
    const others = shipment.consignmentIds.filter((id) => id !== leaderId);
    await db().insert(s.users).values({ id: 2, openId: "receipt-batch-driver", role: "courier", branchId: 1 });
    await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 2, memberRole: "DRIVER", isActive: true, createdBy: 1 });
    await acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 1,
      clientRequestId: "ack-before-batch-receipt" }, { userId: 2 });
    const first = await receive(leaderId, [leaderId, others[0]!], "physical-batch-two-members");
    expect((await receiveWorkflowReturn(first.input, actor)).idempotentReplay).toBe(true);
    let [leader] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(leader.codClaimVersion).toBe(2);
    const firstReceipt = await withTx((tx) => physicalReturnReceiptTx(tx, leader));
    expect(firstReceipt).not.toBeNull();
    let claimChanges = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.eventType, "COD_CLAIM_CHANGED"));
    expect(claimChanges).toHaveLength(1);
    expect((claimChanges[0].payload as { removedReceiptEventIds: number[] }).removedReceiptEventIds).toHaveLength(2);
    await receive(leaderId, [others[1]!], "physical-batch-later-member");
    [leader] = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(leader.codClaimVersion).toBe(3);
    expect((await withTx((tx) => physicalReturnReceiptTx(tx, leader)))?.id).toBe(firstReceipt?.id);
    const [projection] = await db().select({ physical: physicalReturnReceiptExistsSql() })
      .from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, leaderId));
    expect(Boolean(projection.physical)).toBe(true);
    claimChanges = await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.eventType, "COD_CLAIM_CHANGED"));
    expect(claimChanges).toHaveLength(2);
    const view = await courierSnapshot(leaderId);
    await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 3, ...view, clientRequestId: "batch-receipt-no-ack" },
      { userId: 2 }, undefined, { requireFullCollection: true })).rejects.toThrow(/أقر/);
    await acknowledgeConsignmentClaim({ consignmentId: leaderId, expectedClaimVersion: 3, ...view,
      clientRequestId: "batch-receipt-current-ack" }, { userId: 2 });
    await expect(confirmConsignmentDelivery({ consignmentId: leaderId, expectedClaimVersion: 3, ...view, clientRequestId: "batch-receipt-deliver" },
      { userId: 2 }, undefined, { requireFullCollection: true })).resolves.toBeDefined();
  });

  it("keeps legacy barcode financial return usable after full inspected receipt while rejecting partial physical groups without effects", async () => {
    const shipment = await dispatch();
    await declare(shipment.consignmentId);
    await receive(
      shipment.consignmentId,
      [shipment.consignmentIds[0]!],
      "physical-barcode-first-parcel",
    );
    const financial = {
      barcode: shipment.consignmentNumber,
      returnReason: "مرتجع تجاري صريح بعد وصول وفحص كل الطرود",
      clientRequestId: "physical-barcode-commercial",
    };
    const partial = await economics();
    await expect(returnByBarcode(financial, actor)).rejects.toThrow(
      /استلم وافحص كل طرد/,
    );
    expect(await economics()).toEqual(partial);
    await receive(
      shipment.consignmentId,
      [shipment.consignmentIds[1]!],
      "physical-barcode-second-parcel",
    );
    await returnByBarcode(financial, actor);
    const completed = await economics();
    expect(completed.stock[0]?.quantity).toBe(10);
    expect(
      completed.movements.filter((row) => row.movementType === "OUT"),
    ).toHaveLength(2);
    expect(
      completed.movements.filter(
        (row) =>
          row.movementType === "RETURN" &&
          row.referenceType === "DELIVERY_RETURN",
      ),
    ).toHaveLength(2);
    await returnByBarcode(financial, actor);
    expect(await economics()).toEqual(completed);
  });

  it("closes a real charge-only FR after actual courier collection, remittance and refund without clearing its historical cash", async () => {
    const charge = await createFulfillmentCharge(
      {
        branchId: 1,
        customerId: 1,
        category: "SERVICE",
        description: "تجهيز مستقل قابل لإثبات القبض والرد",
        amount: "1000.00",
        externalCost: "0.00",
        clientRequestId: "fr-ancestry-create-charge",
      },
      actor,
    );
    await approveFulfillmentCharge(
      {
        id: charge.id,
        expectedVersion: charge.version,
        clientRequestId: "fr-ancestry-approve-charge",
      },
      actor,
    );
    const preview = await previewWorkflowSource(
      {
        source: { kind: "charge", id: charge.id },
        station: "dispatch",
        branchId: 1,
      },
      actor,
    );
    const dispatched = await dispatchWorkflowBatch(
      {
        sources: [
          {
            kind: preview.source.kind,
            id: preview.source.id,
            expectedVersion: preview.source.version,
          },
        ],
        branchId: 1,
        partyId: 1,
        deliveryFee: "0.00",
        feeCollection: "COURIER",
        recipientName: "عميل العهدة",
        recipientPhone: "07701234567",
        deliveryAddress: "بغداد المنصور قرب المكتبة",
        clientRequestId: "fr-ancestry-dispatch-charge",
      },
      actor,
    );
    const id = dispatched.consignmentId;
    await confirmWorkflowDelivery(
      {
        source: await source(id),
        branchId: 1,
        evidence: "ثبت قبض الناقل كامل أجر التجهيز المستقل",
        clientRequestId: "fr-ancestry-actual-collection",
      },
      actor,
    );
    const receipt = await receive(id, [id], "fr-ancestry-physical-receipt");
    expect(receipt.result).toMatchObject({
      commercialActionRequired: false,
      sourceClosureRequired: true,
      refundActionRequired: false,
    });
    const close = {
      ...actor,
      returnReason: "إغلاق مصدر الشحنة بعد رد قبض الأجر الفعلي",
      clientRequestId: "fr-ancestry-close-source",
    };
    await expect(returnConsignment(id, close)).rejects.toThrow(/عهدة لم تسو/);
    await recordDeliveryRemittance(
      {
        branchId: 1,
        partyId: 1,
        targetShiftId: 1,
        shiftType: "RETAIL",
        lines: [{ consignmentId: id, collectedAmount: "1000.00" }],
        countedCash: "1000.00",
        clientRequestId: "fr-ancestry-actual-remittance",
      },
      actor,
    );
    await expect(returnConsignment(id, close)).rejects.toThrow(/عهدة لم تسو/);
    const [remitted] = await db()
      .select()
      .from(fulfillmentChargePayments)
      .where(eq(fulfillmentChargePayments.kind, "COURIER_REMITTANCE"));
    expect(remitted?.originalPaymentId).toBeTypeOf("number");
    const [currentCharge] = await db()
      .select()
      .from(fulfillmentCharges)
      .where(eq(fulfillmentCharges.id, charge.id));
    const refunded = await refundFulfillmentCharge(
      {
        id: charge.id,
        expectedVersion: currentCharge!.version,
        originalPaymentId: remitted!.id,
        amount: "1000.00",
        reason: "رد كامل قبض التجهيز على تخصيص التوريد الحقيقي",
        clientRequestId: "fr-ancestry-actual-charge-refund",
      },
      actor,
    );
    const [out] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, refunded.receiptId));
    expect(out).toMatchObject({
      direction: "OUT",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      amount: "1000.00",
    });
    const before = await economics();
    const chargesBefore = await db().select().from(fulfillmentCharges);
    const allocationsBefore = await db()
      .select()
      .from(fulfillmentChargePayments);
    await returnConsignment(id, close);
    const [cn] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, id));
    expect(cn).toMatchObject({
      invoiceId: null,
      sourceType: "FULFILLMENT_REQUEST",
      status: "RETURNED",
      parcelStatus: "RETURNED",
      collectedAmount: "1000.00",
    });
    expect(await economics()).toEqual(before);
    expect(await db().select().from(fulfillmentCharges)).toEqual(chargesBefore);
    expect(await db().select().from(fulfillmentChargePayments)).toEqual(
      allocationsBefore,
    );
    const closed = await previewWorkflowSource(
      { source: { kind: "consignment", id }, station: "return", branchId: 1 },
      actor,
    );
    expect(closed.returnState).toMatchObject({
      received: true,
      commercialActionRequired: false,
      sourceClosureRequired: false,
    });
    await returnConsignment(id, close);
    expect(await economics()).toEqual(before);
    expect(await db().select().from(fulfillmentChargePayments)).toEqual(
      allocationsBefore,
    );
  });

  it("receives only explicit actual members, preserves every economic effect, and replays stale original proof safely", async () => {
    const shipment = await dispatch();
    await declare(shipment.consignmentId);
    const before = await economics();
    const ids = shipment.consignmentIds;
    const first = await receive(
      shipment.consignmentId,
      [ids[0]!],
      "physical-receive-member-one",
    );
    expect(first.result).toMatchObject({
      mode: "PHYSICAL_RECEIPT",
      consignmentIds: [ids[0]],
      commercialActionRequired: true,
    });
    expect(await economics()).toEqual(before);
    const p = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: ids[1]! },
        station: "return",
        branchId: 1,
      },
      actor,
    );
    expect(p.returnState).toMatchObject({
      received: false,
      commercialActionRequired: true,
      heldCustomerOwned: true,
    });
    expect(p.returnState?.members.map((r) => r.received)).toEqual([
      true,
      false,
    ]);
    expect(p.returnState?.members.map((r) => r.canReceive)).toEqual([
      false,
      true,
    ]);
    expect(
      (await receiveWorkflowReturn(first.input, actor)).idempotentReplay,
    ).toBe(true);
    await expect(
      receiveWorkflowReturn(
        {
          ...first.input,
          receivedConsignmentIds: [ids[1]!],
          clientRequestId: "physical-stale-other-member",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await receive(
      shipment.consignmentId,
      [ids[1]!],
      "physical-receive-member-two",
    );
    expect(await economics()).toEqual(before);
    expect(
      (await db().select().from(s.deliveryEvents)).filter(
        (r) => r.eventType === PHYSICAL_RETURN_RECEIVED,
      ),
    ).toHaveLength(2);
    expect(
      (await db().select().from(s.deliveryConsignments)).map((r) => r.status),
    ).toEqual(["DISPATCHED", "DISPATCHED"]);
  });
  it("rejects an implicit whole group and foreign member before any receipt", async () => {
    const shipment = await dispatch();
    const input = {
      source: await source(shipment.consignmentId),
      branchId: 1,
      inspected: true as const,
      evidence: "استلام وفحص فعلي",
      clientRequestId: "physical-explicit-subset",
    };
    const before = await economics();
    await expect(receiveWorkflowReturn(input, actor)).rejects.toThrow(
      /حدد كل طرد/,
    );
    await expect(
      receiveWorkflowReturn(
        { ...input, receivedConsignmentIds: [999999] },
        actor,
      ),
    ).rejects.toThrow(/حدد كل طرد/);
    expect(await economics()).toEqual(before);
  });
  it("allows a later explicit native commercial return exactly once after proven physical receipt", async () => {
    const shipment = await dispatch();
    await declare(shipment.consignmentId);
    await receive(
      shipment.consignmentId,
      shipment.consignmentIds,
      "physical-before-commercial",
    );
    const native = {
      consignmentId: shipment.consignmentId,
      reason: "قرر العميل إرجاع البيع بعد استلام العهدة",
      clientRequestId: "physical-explicit-commercial",
    };
    await returnShipment(native, actor);
    const completed = await economics();
    expect(completed.stock[0]?.quantity).toBe(10);
    expect(
      completed.movements.filter((r) => r.movementType === "OUT"),
    ).toHaveLength(2);
    const returnedMovements = completed.movements.filter(
      (r) => r.movementType === "RETURN",
    );
    expect(returnedMovements).toHaveLength(2);
    expect(
      returnedMovements
        .map((r) => ({
          variantId: r.variantId,
          branchId: r.branchId,
          quantity: Number(r.quantity),
          referenceType: r.referenceType,
          referenceId: r.referenceId,
        }))
        .sort((a, b) => Number(a.referenceId) - Number(b.referenceId)),
    ).toEqual(
      shipment.consignmentIds.map((consignmentId) => ({
        variantId: 1,
        branchId: 1,
        quantity: 1,
        referenceType: "DELIVERY_RETURN",
        referenceId: consignmentId,
      })),
    );
    expect(completed.movements).toHaveLength(4);
    expect(completed.invoices.every((r) => r.status === "RETURNED")).toBe(true);
    expect(
      completed.ledger.filter((r) => r.entryType === "COD_RELEASED"),
    ).toHaveLength(2);
    expect((await returnShipment(native, actor)).idempotentReplay).toBe(true);
    await expect(
      returnShipment(
        { ...native, clientRequestId: "physical-new-key-already-returned" },
        actor,
      ),
    ).rejects.toThrow(/لا توجد فواتير/);
    expect(await economics()).toEqual(completed);
  });
  it("reissues clean declared held parcels using the original sources without a second sale or stock OUT", async () => {
    const shipment = await dispatch();
    await declare(shipment.consignmentId);
    await receive(
      shipment.consignmentId,
      shipment.consignmentIds,
      "physical-before-reissue",
    );
    const before = await economics();
    const input = {
      source: await source(shipment.consignmentId),
      branchId: 1,
      action: "reassign" as const,
      partyId: 1,
      reason: "إعادة إرسال عهدة العميل المستلمة",
      clientRequestId: "physical-clean-reissue",
    };
    await mutateWorkflowAssignment(input, actor);
    const after = await economics();
    for (const field of [
      "invoices",
      "items",
      "customers",
      "stock",
      "movements",
      "receipts",
      "accounting",
      "journals",
      "lines",
    ] as const)
      expect(after[field]).toEqual(before[field]);
    const rows = await db().select().from(s.deliveryConsignments);
    expect(rows.map((r) => r.id)).toEqual(shipment.consignmentIds);
    expect(
      rows.every(
        (r) =>
          r.parcelStatus === "OUT_FOR_DELIVERY" &&
          r.returnedAt == null &&
          r.returnDeclaredAt == null,
      ),
    ).toBe(true);
    const exposure = after.ledger.reduce(
      (sum, r) =>
        sum +
        (r.entryType === "COD_ASSIGNED"
          ? Number(r.amount)
          : r.entryType === "COD_RELEASED"
            ? -Number(r.amount)
            : 0),
      0,
    );
    expect(exposure).toBe(200);
    expect(
      (await mutateWorkflowAssignment(input, actor)).idempotentReplay,
    ).toBe(true);
    expect(await economics()).toEqual(after);
  });
  it("physically receives cash-bearing parcels without discarding actual carrier cash or creating customer receipts", async () => {
    const shipment = await dispatch();
    await confirmWorkflowDelivery(
      {
        source: await source(shipment.consignmentId),
        branchId: 1,
        evidence: "المندوب يؤكد قبض كامل الشحنة قبل إرجاعها",
        clientRequestId: "physical-prior-real-collection",
      },
      actor,
    );
    const before = await economics();
    const prior = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: shipment.consignmentId },
        station: "return",
        branchId: 1,
      },
      actor,
    );
    expect(prior.money.cashInCourierCustody).toBe("200.00");
    expect(prior.money.codAmount).toBe("0.00");
    expect(prior.returnState?.members.every((r) => r.canReceive)).toBe(true);
    await declare(shipment.consignmentId);
    expect((await economics()).ledger).toEqual(before.ledger);
    await receive(
      shipment.consignmentId,
      shipment.consignmentIds,
      "physical-cash-receive",
    );
    expect(await economics()).toEqual(before);
    const p = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: shipment.consignmentId },
        station: "return",
        branchId: 1,
      },
      actor,
    );
    expect(p.money.cashInCourierCustody).toBe("200.00");
    expect(p.returnState?.reissueAllowed).toBe(false);
    expect(p.returnState?.reissueBlockedReason).toMatch(/MISSING_HELD/);
    await expect(
      mutateWorkflowAssignment(
        {
          source: await source(shipment.consignmentId),
          branchId: 1,
          action: "reassign",
          partyId: 1,
          reason: "لا يجوز نقل عهدة الناقل القديمة",
          clientRequestId: "physical-cash-reissue-denied",
        },
        actor,
      ),
    ).rejects.toThrow(/حقوق الناقل/);
    expect(await economics()).toEqual(before);
    const open = await listOpenConsignments(1, 1);
    expect(
      open.rows
        .filter((row) => row.physicalReturnReceived)
        .map((row) => row.id),
    ).toEqual(shipment.consignmentIds);
    expect(
      (await listPartyObligations(1))[0]?.deliveredAwaitingRemitCount,
    ).toBe(2);
    const remit = {
      branchId: 1,
      partyId: 1,
      lines: shipment.consignmentIds.map((consignmentId) => ({
        consignmentId,
        collectedAmount: "100.00",
      })),
      countedCash: "200.00",
      targetShiftId: 1,
      shiftType: "RETAIL" as const,
      clientRequestId: "physical-real-cash-remit",
    };
    await recordDeliveryRemittance(remit, actor);
    const settled = await economics();
    expect(settled.invoices).toEqual(before.invoices);
    expect(settled.customers).toEqual(before.customers);
    expect(settled.stock).toEqual(before.stock);
    expect(settled.movements).toEqual(before.movements);
    expect(settled.parties[0]?.currentBalance).toBe("0.00");
    expect(
      settled.ledger.filter((row) => row.entryType === "COD_COLLECTED"),
    ).toEqual(before.ledger.filter((row) => row.entryType === "COD_COLLECTED"));
    expect(
      settled.receipts.filter((row) => row.direction === "IN"),
    ).toHaveLength(1);
    await recordDeliveryRemittance(remit, actor);
    expect(await economics()).toEqual(settled);
  });
  it("keeps paid historical carrier fees immutable and points to linked held aftercare instead of undoing the fee", async () => {
    const shipment = await dispatch();
    await declare(shipment.consignmentId);
    for (const entryType of ["FEE_EARNED", "FEE_PAID"] as const)
      await db()
        .insert(s.deliveryLedgerEntries)
        .values({
          eventKey: `physical-historical-${entryType}`,
          consignmentId: shipment.consignmentId,
          partyId: 1,
          branchId: 1,
          entryType,
          amount: "10.00",
          createdBy: 1,
        });
    await receive(
      shipment.consignmentId,
      shipment.consignmentIds,
      "physical-paid-fee-receive",
    );
    const before = await economics();
    const p = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: shipment.consignmentId },
        station: "return",
        branchId: 1,
      },
      actor,
    );
    expect(p.returnState?.reissueAllowed).toBe(false);
    expect(p.returnState?.nextStep).toMatch(/MISSING_HELD/);
    await expect(
      mutateWorkflowAssignment(
        {
          source: await source(shipment.consignmentId),
          branchId: 1,
          action: "reassign",
          partyId: 1,
          reason: "تبقى الأجرة المدفوعة لأصلها",
          clientRequestId: "physical-fee-reissue-denied",
        },
        actor,
      ),
    ).rejects.toThrow(/حقوق الناقل/);
    expect(await economics()).toEqual(before);
  });
});
