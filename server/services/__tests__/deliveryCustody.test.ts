import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  deliveryCustodyEvents,
  deliveryCustodyItems,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import {
  initializeConsignmentCustodyTx,
  transitionDeliveryCustodyTx,
} from "../delivery/custody";

const db = () => {
  const value = getDb();
  if (!value) throw new Error("Isolated DB required");
  return value;
};

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "custody-admin",
    role: "admin",
    branchId: 1,
  });
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل العهدة",
    currentBalance: "0.00",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "مندوب العهدة",
    partyType: "INDIVIDUAL",
    branchId: 1,
    currentBalance: "0.00",
  });
});

async function seedCatalog() {
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "صنف", isService: false },
      { id: 2, name: "بكج", isBundle: true },
      { id: 3, name: "مكوّن", isService: false },
      { id: 4, name: "خدمة", isService: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "CUST-STOCK", costPrice: "100.00" },
      { id: 2, productId: 2, sku: "CUST-BUNDLE", costPrice: "0.00" },
      { id: 3, productId: 3, sku: "CUST-COMP", costPrice: "50.00" },
      { id: 4, productId: 4, sku: "CUST-SERVICE", costPrice: "0.00" },
    ]);
}

describe("delivery physical custody", () => {
  it("tracks stocked goods and frozen bundle components once, excluding services", async () => {
    await seedCatalog();
    await db().insert(s.invoices).values({
      id: 1,
      invoiceNumber: "CUST-INV-1",
      branchId: 1,
      customerId: 1,
      subtotal: "1500.00",
      total: "1500.00",
      costTotal: "500.00",
      paidAmount: "1500.00",
      status: "PAID",
      createdBy: 1,
    });
    await db()
      .insert(s.invoiceItems)
      .values([
        {
          id: 11,
          invoiceId: 1,
          variantId: 1,
          quantity: "2.000",
          baseQuantity: 2,
          unitPrice: "200.00",
          unitCost: "100.00",
          lineCost: "200.00",
          total: "400.00",
        },
        {
          id: 12,
          invoiceId: 1,
          variantId: 2,
          quantity: "3.000",
          baseQuantity: 3,
          unitPrice: "300.00",
          unitCost: "100.00",
          lineCost: "300.00",
          total: "900.00",
        },
        {
          id: 13,
          invoiceId: 1,
          variantId: 4,
          quantity: "1.000",
          baseQuantity: 1,
          unitPrice: "200.00",
          unitCost: "0.00",
          lineCost: "0.00",
          serviceMaterialsSnapshotted: true,
          total: "200.00",
        },
      ]);
    await db().insert(s.invoiceItemBundleComponents).values({
      id: 21,
      invoiceItemId: 12,
      componentVariantId: 3,
      componentBaseQuantity: 2,
      issueUnitCost: "50.00",
      issueLineCost: "300.00",
    });
    await db()
      .insert(s.invoiceItemServiceMaterials)
      .values([
        {
          invoiceItemId: 13,
          materialVariantId: 1,
          baseQuantity: 3,
          unitCost: "100.00",
          lineCost: "300.00",
        },
        {
          invoiceItemId: 13,
          materialVariantId: 3,
          baseQuantity: 4,
          unitCost: "50.00",
          lineCost: "200.00",
        },
      ]);
    await db()
      .insert(s.inventoryMovements)
      .values([
        {
          id: 31,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 2,
          referenceType: "PRINT_SALE",
          referenceId: 1,
          createdBy: 1,
        },
        {
          id: 32,
          variantId: 3,
          branchId: 1,
          movementType: "OUT",
          quantity: 6,
          referenceType: "PRINT_SALE",
          referenceId: 1,
          createdBy: 1,
        },
        {
          id: 33,
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 3,
          referenceType: "PRINT_SALE",
          referenceId: 1,
          createdBy: 1,
        },
        {
          id: 34,
          variantId: 3,
          branchId: 1,
          movementType: "OUT",
          quantity: 4,
          referenceType: "PRINT_SALE",
          referenceId: 1,
          createdBy: 1,
        },
      ]);
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "CUST-CN-1",
      branchId: 1,
      partyId: 1,
      invoiceId: 1,
      sourceType: "INVOICE",
      sourceId: 1,
      codAmount: "0.00",
      deliveryFee: "0.00",
      parcelStatus: "OUT_FOR_DELIVERY",
      status: "DISPATCHED",
      moneyStatus: "NOT_APPLICABLE",
      dispatchedBy: 1,
      outForDeliveryAt: new Date(),
    });
    const first = await withTx((tx) =>
      initializeConsignmentCustodyTx(tx, {
        consignmentId: 1,
        actorUserId: 1,
        operationId: "custody-test-init",
      }),
    );
    const replay = await withTx((tx) =>
      initializeConsignmentCustodyTx(tx, {
        consignmentId: 1,
        actorUserId: 1,
        operationId: "custody-test-replay",
      }),
    );
    expect(first).toHaveLength(2);
    expect(replay).toHaveLength(2);
    expect(
      first.map((row) => ({
        kind: row.itemKind,
        qty: row.baseQuantity,
        carrier: row.carrierCustodyBaseQuantity,
        value: row.originalIssueValue,
        movementId: row.originalMovementId,
        review: row.reviewStatus,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          kind: "STOCKED_ITEM",
          qty: 2,
          carrier: 2,
          value: "200.00",
          movementId: 31,
          review: "VERIFIED",
        },
        {
          kind: "BUNDLE_COMPONENT",
          qty: 6,
          carrier: 6,
          value: "300.00",
          movementId: 32,
          review: "VERIFIED",
        },
      ]),
    );
    expect(await db().select().from(deliveryCustodyEvents)).toHaveLength(2);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(4);
  });

  it("keeps customized work-order output out of branch stock", async () => {
    await db().insert(s.invoices).values({
      id: 2,
      invoiceNumber: "CUST-WO-INV",
      branchId: 1,
      customerId: 1,
      subtotal: "3000.00",
      total: "3000.00",
      costTotal: "1200.00",
      paidAmount: "0.00",
      status: "PENDING",
      createdBy: 1,
    });
    await db().insert(s.workOrders).values({
      id: 2,
      orderNumber: "CUST-WO-2",
      branchId: 1,
      customerId: 1,
      invoiceId: 2,
      title: "درع مخصص",
      quantity: 2,
      salePrice: "3000.00",
      status: "READY",
      createdBy: 1,
    });
    await db().insert(s.deliveryConsignments).values({
      id: 2,
      consignmentNumber: "CUST-CN-WO",
      branchId: 1,
      partyId: 1,
      invoiceId: 2,
      workOrderId: 2,
      sourceType: "WORK_ORDER",
      sourceId: 2,
      codAmount: "3000.00",
      deliveryFee: "0.00",
      parcelStatus: "ASSIGNED",
      status: "DISPATCHED",
      dispatchedBy: 1,
    });
    const beforeStock = await db().select().from(s.branchStock);
    const rows = await withTx((tx) =>
      initializeConsignmentCustodyTx(tx, {
        consignmentId: 2,
        actorUserId: 1,
        operationId: "custody-workorder-init",
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemKind: "WORK_ORDER_OUTPUT",
      variantId: null,
      baseQuantity: 2,
      preparedHeldBaseQuantity: 2,
      originalIssueUnitCost: "600.00",
      originalIssueValue: "1200.00",
    });
    expect(await db().select().from(s.branchStock)).toEqual(beforeStock);
  });

  it("conserves partial quantities and fails closed before a review-required restock", async () => {
    await db().insert(s.products).values({ id: 9, name: "سطر قديم" });
    await db().insert(s.productVariants).values({
      id: 9,
      productId: 9,
      sku: "CUST-LEGACY",
      costPrice: "100.00",
    });
    await db().insert(s.invoices).values({
      id: 9,
      invoiceNumber: "CUST-INV-LEGACY",
      branchId: 1,
      customerId: 1,
      subtotal: "300.00",
      total: "300.00",
      costTotal: "0.00",
      paidAmount: "300.00",
      status: "PAID",
      createdBy: 1,
    });
    await db().insert(s.invoiceItems).values({
      id: 999,
      invoiceId: 9,
      variantId: 9,
      quantity: "3.000",
      baseQuantity: 3,
      unitPrice: "100.00",
      unitCost: "0.00",
      lineCost: "0.00",
      total: "300.00",
    });
    await db().insert(s.deliveryConsignments).values({
      id: 9,
      consignmentNumber: "CUST-CN-LEGACY",
      branchId: 1,
      partyId: 1,
      invoiceId: 9,
      sourceType: "INVOICE",
      sourceId: 9,
      codAmount: "0.00",
      deliveryFee: "0.00",
      parcelStatus: "OUT_FOR_DELIVERY",
      status: "DISPATCHED",
      dispatchedBy: 1,
    });
    await db().insert(deliveryCustodyItems).values({
      id: 9,
      consignmentId: 9,
      leaderConsignmentId: 9,
      branchId: 1,
      sourceType: "INVOICE",
      sourceId: 9,
      sourceLineKey: "legacy:9",
      itemKind: "STOCKED_ITEM",
      invoiceItemId: 999,
      variantId: 9,
      baseQuantity: 3,
      carrierCustodyBaseQuantity: 3,
      reviewStatus: "REVIEW_REQUIRED",
      reviewReason: "لقطة التكلفة التاريخية مفقودة",
      createdBy: 1,
      updatedBy: 1,
    });
    await expect(
      withTx((tx) =>
        transitionDeliveryCustodyTx(tx, {
          custodyItemId: 9,
          expectedVersion: 1,
          fromState: "CARRIER_CUSTODY",
          toState: "RESTOCKED_CLOSED",
          baseQuantity: 1,
          operationId: "custody-restock-block",
          eventKey: "custody-restock-block:9",
          eventType: "INSPECTION_RESTOCK",
          evidence: { inspected: true },
          actorUserId: 1,
        }),
      ),
    ).rejects.toThrow(/التكلفة التاريخية/);
    const moved = await withTx((tx) =>
      transitionDeliveryCustodyTx(tx, {
        custodyItemId: 9,
        expectedVersion: 1,
        fromState: "CARRIER_CUSTODY",
        toState: "RETURNED_PENDING_INSPECTION",
        baseQuantity: 1,
        operationId: "custody-return-received",
        eventKey: "custody-return-received:9",
        eventType: "PHYSICAL_RETURN_RECEIVED",
        evidence: { inspected: false },
        actorUserId: 1,
      }),
    );
    const replay = await withTx((tx) =>
      transitionDeliveryCustodyTx(tx, {
        custodyItemId: 9,
        expectedVersion: 1,
        fromState: "CARRIER_CUSTODY",
        toState: "RETURNED_PENDING_INSPECTION",
        baseQuantity: 1,
        operationId: "custody-return-received",
        eventKey: "custody-return-received:9",
        eventType: "PHYSICAL_RETURN_RECEIVED",
        evidence: { inspected: false },
        actorUserId: 1,
      }),
    );
    expect(moved.replay).toBe(false);
    expect(replay.replay).toBe(true);
    expect(replay.item).toMatchObject({
      baseQuantity: 3,
      carrierCustodyBaseQuantity: 2,
      returnedPendingInspectionBaseQuantity: 1,
      version: 2,
    });
    expect(
      await db()
        .select()
        .from(deliveryCustodyEvents)
        .where(eq(deliveryCustodyEvents.custodyItemId, 9)),
    ).toHaveLength(1);
  });
});
