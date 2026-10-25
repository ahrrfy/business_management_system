import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  deliveryCustodyEvents,
  deliveryCustodyItems,
} from "../../../drizzle/fulfillmentSchema";
import { docBarcode } from "../../../shared/documentNumber";
import { getDb } from "../../db";
import {
  confirmConsignmentDelivery,
  transitionConsignmentParcel,
} from "../delivery/courier";
import { initializeConsignmentCustodyTx } from "../delivery/custody";
import { declareConsignmentReturn } from "../delivery/declaredReturn";
import { dispatchInvoiceInTx } from "../delivery/dispatchInvoice";
import { returnConsignment } from "../delivery/returns";
import { previewWorkflowScan } from "../delivery/workflow/preview";
import { receiveWorkflowReturn } from "../delivery/workflow/returns";
import { returnSale } from "../returnService";
import { withTx } from "../tx";

const ADMIN = {
  userId: 1,
  role: "admin",
  branchId: 1,
  isOwner: true,
} as const;
const db = () => {
  const value = getDb();
  if (!value) throw new Error("Isolated DB required");
  return value;
};

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "custody-lifecycle-admin",
        role: "admin",
        branchId: 1,
        isOwner: true,
      },
      {
        id: 2,
        openId: "custody-lifecycle-courier",
        role: "cashier",
        branchId: 1,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل دورة العهدة",
    phone: "+9647701234567",
    currentBalance: "0.00",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "مندوب دورة العهدة",
    partyType: "INDIVIDUAL",
    userId: 2,
    branchId: 1,
    currentBalance: "0.00",
    isActive: true,
  });
  await db()
    .insert(s.products)
    .values({ id: 1, name: "صنف دورة العهدة", isService: false });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "CUSTODY-LIFECYCLE",
    costPrice: "40.00",
  });
  await db().insert(s.branchStock).values({
    branchId: 1,
    variantId: 1,
    quantity: 0,
  });
});

async function seedInvoiceConsignment(
  id: number,
  parcelStatus: "ASSIGNED" | "OUT_FOR_DELIVERY",
) {
  const invoiceNumber = String(91000 + id);
  const consignmentNumber = String(92000 + id);
  await db().insert(s.invoices).values({
    id,
    invoiceNumber,
    branchId: 1,
    customerId: 1,
    subtotal: "100.00",
    total: "100.00",
    costTotal: "40.00",
    paidAmount: "100.00",
    status: "PAID",
    createdBy: 1,
  });
  await db()
    .insert(s.invoiceItems)
    .values({
      id: 100 + id,
      invoiceId: id,
      variantId: 1,
      quantity: "1.000",
      baseQuantity: 1,
      unitPrice: "100.00",
      unitCost: "40.00",
      lineCost: "40.00",
      total: "100.00",
    });
  await db()
    .insert(s.inventoryMovements)
    .values({
      variantId: 1,
      branchId: 1,
      movementType: "OUT",
      quantity: 1,
      referenceType: "INVOICE",
      referenceId: id,
      createdBy: 1,
    });
  const now = new Date();
  await db()
    .insert(s.deliveryConsignments)
    .values({
      id,
      consignmentNumber,
      branchId: 1,
      partyId: 1,
      invoiceId: id,
      sourceType: "INVOICE",
      sourceId: id,
      assignedUserId: 2,
      endCustomerId: 1,
      codAmount: "0.00",
      collectedAmount: "0.00",
      deliveryFee: "0.00",
      feeCollection: "COURIER",
      recipientName: "عميل دورة العهدة",
      recipientPhone: "+9647701234567",
      deliveryAddress: "بغداد المنصور",
      status: "DISPATCHED",
      parcelStatus,
      moneyStatus: "NOT_APPLICABLE",
      dispatchedBy: 1,
      dispatchedAt: now,
      outForDeliveryAt: parcelStatus === "OUT_FOR_DELIVERY" ? now : null,
    });
  return { invoiceNumber, consignmentNumber };
}

async function custody(id: number) {
  const [row] = await db()
    .select()
    .from(deliveryCustodyItems)
    .where(eq(deliveryCustodyItems.consignmentId, id));
  if (!row) throw new Error("Custody row required");
  return row;
}

async function nonCustodyEffects() {
  return {
    movements: await db().select().from(s.inventoryMovements),
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
  };
}

describe("delivery custody follows the operational lifecycle", () => {
  it("follows real pickup and delivery writers and treats customer delivery as final", async () => {
    const source = await seedInvoiceConsignment(1, "ASSIGNED");
    await withTx((tx) =>
      initializeConsignmentCustodyTx(tx, {
        consignmentId: 1,
        actorUserId: 1,
        operationId: "custody-lifecycle-seed",
      }),
    );
    expect(await custody(1)).toMatchObject({
      preparedHeldBaseQuantity: 1,
      carrierCustodyBaseQuantity: 0,
    });
    const effects = await nonCustodyEffects();

    await transitionConsignmentParcel(
      {
        consignmentId: 1,
        toStatus: "ACCEPTED",
        clientRequestId: "custody-accepted",
      },
      { userId: 2 },
    );
    expect(await custody(1)).toMatchObject({
      preparedHeldBaseQuantity: 1,
      carrierCustodyBaseQuantity: 0,
    });
    await transitionConsignmentParcel(
      {
        consignmentId: 1,
        toStatus: "PICKED_UP",
        clientRequestId: "custody-pickup",
      },
      { userId: 2 },
    );
    expect(await custody(1)).toMatchObject({
      preparedHeldBaseQuantity: 0,
      carrierCustodyBaseQuantity: 1,
    });

    const delivered = await confirmConsignmentDelivery(
      { consignmentId: 1, clientRequestId: "custody-delivered" },
      { userId: 2 },
    );
    expect(delivered.consignmentId).toBe(1);
    expect(await custody(1)).toMatchObject({
      carrierCustodyBaseQuantity: 0,
      customerDeliveredBaseQuantity: 1,
    });
    expect(
      (
        await previewWorkflowScan(
          {
            raw: docBarcode("CN", source.consignmentNumber),
            station: "collect",
            branchId: 1,
          },
          ADMIN,
        )
      ).summaries.inventory.openBaseQuantity,
    ).toBe(0);
    // Simulate an open legacy row whose physical event committed before custody
    // tracking existed. Replaying the same command repairs from event history.
    await db().delete(deliveryCustodyEvents);
    await db().delete(deliveryCustodyItems);
    expect(
      (
        await confirmConsignmentDelivery(
          { consignmentId: 1, clientRequestId: "custody-delivered" },
          { userId: 2 },
        )
      ).alreadyDelivered,
    ).toBe(true);
    expect(await custody(1)).toMatchObject({
      preparedHeldBaseQuantity: 0,
      carrierCustodyBaseQuantity: 0,
      customerDeliveredBaseQuantity: 1,
    });
    expect(await db().select().from(deliveryCustodyEvents)).toHaveLength(1);
    expect(await nonCustodyEffects()).toEqual(effects);
  });

  it("does not move custody on declaration, then follows physical receipt and held reissue", async () => {
    const source = await seedInvoiceConsignment(2, "OUT_FOR_DELIVERY");
    await withTx((tx) =>
      initializeConsignmentCustodyTx(tx, {
        consignmentId: 2,
        actorUserId: 1,
        operationId: "custody-return-seed",
      }),
    );
    const effects = await nonCustodyEffects();
    await transitionConsignmentParcel(
      {
        consignmentId: 2,
        toStatus: "FAILED",
        reason: "تعذر الوصول",
        clientRequestId: "custody-failed",
      },
      { userId: 2 },
    );
    await declareConsignmentReturn(
      {
        consignmentId: 2,
        reason: "إرجاع الطرد للمكتبة",
        clientRequestId: "custody-return-declared",
      },
      ADMIN,
    );
    expect(await custody(2)).toMatchObject({
      carrierCustodyBaseQuantity: 1,
      customerOwnedHeldBaseQuantity: 0,
    });

    const preview = await previewWorkflowScan(
      {
        raw: docBarcode("CN", source.consignmentNumber),
        station: "return",
        branchId: 1,
      },
      ADMIN,
    );
    await receiveWorkflowReturn(
      {
        source: {
          kind: preview.source.kind,
          id: preview.source.id,
          expectedVersion: preview.source.version,
        },
        branchId: 1,
        evidence: "استلام وفحص الطرد كاملاً في المخزن",
        inspected: true,
        clientRequestId: "custody-physical-return",
      },
      ADMIN,
    );
    expect(await custody(2)).toMatchObject({
      carrierCustodyBaseQuantity: 0,
      customerOwnedHeldBaseQuantity: 1,
    });

    await withTx((tx) =>
      dispatchInvoiceInTx(
        tx,
        {
          invoiceId: 2,
          partyId: 1,
          assignedUserId: 2,
          deliveryFee: "0.00",
          feeCollection: "COURIER",
          recipientName: "عميل دورة العهدة",
          recipientPhone: "+9647701234567",
          deliveryAddress: "بغداد المنصور",
          clientRequestId: "custody-held-reissue",
        },
        ADMIN,
        { heldReturnReissue: true },
      ),
    );
    expect(await custody(2)).toMatchObject({
      carrierCustodyBaseQuantity: 1,
      customerOwnedHeldBaseQuantity: 0,
    });
    expect(await nonCustodyEffects()).toEqual(effects);
  });

  it("initializes an old open consignment when its real pickup event first appears", async () => {
    await seedInvoiceConsignment(3, "ASSIGNED");
    expect(await db().select().from(deliveryCustodyItems)).toHaveLength(0);
    await transitionConsignmentParcel(
      {
        consignmentId: 3,
        toStatus: "ACCEPTED",
        clientRequestId: "custody-old-accepted",
      },
      { userId: 2 },
    );
    expect(await db().select().from(deliveryCustodyItems)).toHaveLength(0);
    await transitionConsignmentParcel(
      {
        consignmentId: 3,
        toStatus: "PICKED_UP",
        clientRequestId: "custody-old-pickup",
      },
      { userId: 2 },
    );
    expect(await custody(3)).toMatchObject({
      preparedHeldBaseQuantity: 0,
      carrierCustodyBaseQuantity: 1,
      customerDeliveredBaseQuantity: 0,
    });
    const eventCount = (await db().select().from(deliveryCustodyEvents)).length;
    expect(
      (
        await transitionConsignmentParcel(
          {
            consignmentId: 3,
            toStatus: "PICKED_UP",
            clientRequestId: "custody-old-pickup",
          },
          { userId: 2 },
        )
      ).replay,
    ).toBe(true);
    expect(await db().select().from(deliveryCustodyEvents)).toHaveLength(
      eventCount,
    );
  });

  it("closes stocked custody from the actual cumulative partial/full commercial-return counters", async () => {
    await seedInvoiceConsignment(4, "OUT_FOR_DELIVERY");
    await db()
      .update(s.invoices)
      .set({ paidAmount: "0.00", status: "CONFIRMED" })
      .where(eq(s.invoices.id, 4));
    await db()
      .update(s.invoiceItems)
      .set({
        quantity: "2.000",
        baseQuantity: 2,
        unitPrice: "50.00",
        unitCost: "20.00",
      })
      .where(eq(s.invoiceItems.invoiceId, 4));
    await db()
      .update(s.inventoryMovements)
      .set({ quantity: 2 })
      .where(eq(s.inventoryMovements.referenceId, 4));
    await db()
      .update(s.customers)
      .set({ currentBalance: "100.00" })
      .where(eq(s.customers.id, 1));
    await db()
      .update(s.deliveryConsignments)
      .set({
        parcelStatus: "DELIVERED",
        status: "DELIVERED",
        courierDeliveredAt: new Date(),
      })
      .where(eq(s.deliveryConsignments.id, 4));
    await withTx((tx) =>
      initializeConsignmentCustodyTx(tx, {
        consignmentId: 4,
        actorUserId: 1,
        operationId: "custody-commercial-return-seed",
      }),
    );
    const [item] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, 4));

    await returnSale(
      {
        invoiceId: 4,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        restock: true,
        operatorReason: "إرجاع قطعة سليمة",
        clientRequestId: "custody-partial-restock",
      },
      ADMIN,
    );
    expect(await custody(4)).toMatchObject({
      customerDeliveredBaseQuantity: 1,
      restockedClosedBaseQuantity: 1,
      damagedClosedBaseQuantity: 0,
    });

    const fullReturn = {
      invoiceId: 4,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: false,
      operatorReason: "إرجاع قطعة تالفة",
      clientRequestId: "custody-full-damaged",
    } as const;
    await returnSale(fullReturn, ADMIN);
    expect(await custody(4)).toMatchObject({
      customerDeliveredBaseQuantity: 0,
      restockedClosedBaseQuantity: 1,
      damagedClosedBaseQuantity: 1,
      closedAt: expect.any(Date),
    });
    await db().delete(deliveryCustodyEvents);
    await db().delete(deliveryCustodyItems);
    expect(await returnSale(fullReturn, ADMIN)).toMatchObject({
      idempotentReplay: true,
    });
    expect(await custody(4)).toMatchObject({
      customerDeliveredBaseQuantity: 0,
      restockedClosedBaseQuantity: 1,
      damagedClosedBaseQuantity: 1,
    });
  });

  it("closes a real consignment return and blocks direct work-order returns before effects", async () => {
    await seedInvoiceConsignment(5, "ASSIGNED");
    await db()
      .update(s.invoices)
      .set({ paidAmount: "0.00", status: "CONFIRMED" })
      .where(eq(s.invoices.id, 5));
    await db()
      .update(s.customers)
      .set({ currentBalance: "100.00" })
      .where(eq(s.customers.id, 1));
    await withTx((tx) =>
      initializeConsignmentCustodyTx(tx, {
        consignmentId: 5,
        actorUserId: 1,
        operationId: "custody-full-return-seed",
      }),
    );
    await returnConsignment(5, {
      ...ADMIN,
      clientRequestId: "custody-full-return",
      returnReason: "رجع الطرد فعلياً",
    });
    expect(await custody(5)).toMatchObject({
      preparedHeldBaseQuantity: 0,
      restockedClosedBaseQuantity: 1,
      closedAt: expect.any(Date),
    });

    await seedInvoiceConsignment(6, "ASSIGNED");
    await db()
      .update(s.deliveryConsignments)
      .set({ sourceType: "WORK_ORDER" })
      .where(eq(s.deliveryConsignments.id, 6));
    await db()
      .update(s.invoices)
      .set({ sourceType: "WORKORDER" })
      .where(eq(s.invoices.id, 6));
    const effects = await nonCustodyEffects();
    await expect(
      returnConsignment(6, {
        ...ADMIN,
        clientRequestId: "custody-work-order-return-rejected",
        returnReason: "رفض العميل",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [workOrderItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, 6));
    await expect(
      returnSale(
        {
          invoiceId: 6,
          lines: [
            { invoiceItemId: Number(workOrderItem.id), baseQuantity: 1 },
          ],
          restock: false,
          operatorReason: "رفض العميل",
          clientRequestId: "custody-work-order-sale-return-rejected",
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await nonCustodyEffects()).toEqual(effects);
    expect(
      (
        await db()
          .select()
          .from(s.invoiceItems)
          .where(eq(s.invoiceItems.id, workOrderItem.id))
      )[0].returnedBaseQuantity,
    ).toBe(0);
  });
});
