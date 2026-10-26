import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { recordCompanyStatement } from "../delivery/companyStatement";
import { returnByBarcode } from "../delivery/barcodeReturnService";
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
import {
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
    keys: await db().select().from(s.idempotencyKeys),
  };
}

describe("one physical shipment with independent invoice accounting", () => {
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

  it("allocates actual cash proportionally and records the full shortfall on the party", async () => {
    await confirmShipmentDelivery(
      { ...confirm, collectedAmount: "299.99", shortfallReason: "OTHER" },
      actor,
    );
    const state = await snapshot();
    const cash = state.ledger
      .filter((row) => row.entryType === "COD_COLLECTED")
      .map((row) => row.amount);
    expect(cash).toEqual(["100.00", "199.99"]);
    expect(
      state.ledger
        .filter((row) => row.entryType === "SHORTFALL_ASSIGNED")
        .map((row) => row.amount),
    ).toEqual(["0.01"]);
    expect(state.party[0].currentBalance).toBe("300.00");
    expect(state.invoices.map((row) => row.paidAmount)).toEqual([
      "100.00",
      "200.00",
    ]);
  });

  it("zero actual collection still records the full staff-confirmed shortfall", async () => {
    await confirmShipmentDelivery(
      { ...confirm, collectedAmount: "0.00", shortfallReason: "OTHER" },
      actor,
    );
    const state = await snapshot();
    expect(
      state.ledger.filter((row) => row.entryType === "COD_COLLECTED"),
    ).toHaveLength(0);
    expect(
      state.ledger
        .filter((row) => row.entryType === "SHORTFALL_ASSIGNED")
        .map((row) => row.amount),
    ).toEqual(["100.00", "200.00"]);
    expect(state.invoices.map((row) => row.paidAmount)).toEqual([
      "100.00",
      "200.00",
    ]);
    expect(state.party[0].currentBalance).toBe("300.00");
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
    ).rejects.toThrow(/يتجاوز/);
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
});
