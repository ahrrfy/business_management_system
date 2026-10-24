import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
import { PHYSICAL_RETURN_RECEIVED } from "../delivery/workflow/returnReceipt";
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
async function dispatch() {
  const sources: WorkflowDispatchSource[] = [];
  for (const id of [1, 2]) {
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
