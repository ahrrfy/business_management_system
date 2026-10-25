import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { deliveryDocumentSnapshots } from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { dispatchToDelivery } from "../deliveryService";
import { createWorkOrder } from "../workOrderService";

function db() {
  const value = getDb();
  if (!value) throw new Error("isolated test database required");
  return value;
}

const ADMIN = { userId: 1, branchId: 1, role: "admin" } as const;
const CASHIER = { userId: 2, branchId: 1, role: "cashier" } as const;

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  await db().insert(s.branches).values({
    id: 1,
    code: "MAIN",
    name: "الرئيسي",
    type: "MAIN",
  });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "snapshot-admin",
        name: "مدير المطبوعات",
        role: "admin",
        branchId: 1,
        loginMethod: "local",
      },
      {
        id: 2,
        openId: "snapshot-cashier",
        name: "كاشير المطبوعات",
        role: "cashier",
        branchId: 1,
        loginMethod: "local",
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل المطبوعات",
    phone: "+9647700000000",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "شركة الإسناد",
    partyType: "COMPANY",
    branchId: 1,
    defaultFee: "5000.00",
    isActive: true,
  });
});

describe("alternate delivery dispatch document snapshots", () => {
  it.each([100, 900])(
    "captures direct invoice dispatch at %i ms once and preserves its identity on replay",
    async (milliseconds) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(
        new Date(Date.UTC(2026, 9, 25, 12, 34, 56, milliseconds)),
      );
      await db().insert(s.invoices).values({
        id: 101,
        invoiceNumber: "INV-SNAPSHOT-101",
        sourceType: "POS",
        sourceId: "snapshot-invoice-101",
        branchId: 1,
        customerId: 1,
        contactName: "مستلم الفاتورة",
        contactPhone: "07700000000",
        subtotal: "50000.00",
        total: "50000.00",
        paidAmount: "10000.00",
        status: "PARTIALLY_PAID",
        createdBy: 2,
      });
      const input = {
        invoiceId: 101,
        partyId: 1,
        deliveryFee: "5000.00",
        feeCollection: "COURIER" as const,
        recipientName: "مستلم الفاتورة",
        recipientPhone: "07700000000",
        deliveryAddress: "بغداد - الكرادة",
        externalTrackingRef: "TRACK-SNAPSHOT-101",
        clientRequestId: "snapshot-direct-invoice-101",
      };
      const result = await dispatchInvoiceToDelivery(input, ADMIN);
      const [consignment] = await db()
        .select()
        .from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.id, result.consignmentId));
      expect(consignment.dispatchedAt.toISOString()).toBe(
        "2026-10-25T12:34:56.000Z",
      );
      const beforeReplay = await db()
        .select()
        .from(deliveryDocumentSnapshots)
        .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId));
      expect(beforeReplay).toHaveLength(2);
      expect(new Set(beforeReplay.map((row) => row.documentType))).toEqual(
        new Set(["DISPATCH_SLIP", "SHIPPING_LABEL"]),
      );
      for (const snapshot of beforeReplay) {
        const payload = snapshot.payload as {
          evidence: { mode: string };
          money: { currentTotal: string; paidAmount: string };
        };
        expect(snapshot.eventOccurredAt.toISOString()).toBe(
          consignment.dispatchedAt.toISOString(),
        );
        expect(payload.evidence.mode).toBe("COMMITTED_DISPATCH_EVENT");
        expect(payload.money).toMatchObject({
          currentTotal: "50000.00",
          paidAmount: "10000.00",
        });
      }

      await db()
        .update(s.invoices)
        .set({ paidAmount: "50000.00", status: "PAID" })
        .where(eq(s.invoices.id, 101));
      const replay = await dispatchInvoiceToDelivery(input, ADMIN);
      expect(replay.consignmentId).toBe(result.consignmentId);
      const afterReplay = await db()
        .select()
        .from(deliveryDocumentSnapshots)
        .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId));
      expect(afterReplay).toEqual(beforeReplay);
    },
  );

  it("captures the work-order dispatch event without a second sale or stock effect", async () => {
    await db().insert(s.products).values({ id: 1, name: "ملازم مطبوعة" });
    await db().insert(s.productVariants).values({
      id: 1,
      productId: 1,
      sku: "PRINT-SNAPSHOT-1",
      costPrice: "0.00",
    });
    await db().insert(s.productUnits).values({
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await db().insert(s.branchStock).values({
      variantId: 1,
      branchId: 1,
      quantity: 20,
    });
    const created = await createWorkOrder(
      {
        branchId: 1,
        customerId: 1,
        baseVariantId: 1,
        title: "طباعة ملازم",
        salePrice: "25000.00",
        quantity: 1,
        deposit: "0.00",
        paymentMethod: "CASH",
        hasDelivery: true,
        deliveryAddress: "بغداد - المنصور",
        deliveryFeeCollection: "COURIER",
      },
      { userId: 2, branchId: 1 },
    );
    const workOrderId = (created as { workOrderId: number }).workOrderId;
    await db()
      .update(s.workOrders)
      .set({ status: "READY" })
      .where(eq(s.workOrders.id, workOrderId));

    const beforeMovements = await db().select().from(s.inventoryMovements);
    const input = {
      workOrderId,
      partyId: 1,
      deliveryFee: "5000.00",
      recipientName: "مستلم أمر الشغل",
      recipientPhone: "07700000001",
      deliveryAddress: "بغداد - المنصور",
      externalTrackingRef: "TRACK-WO-SNAPSHOT-1",
      clientRequestId: "snapshot-work-order-1",
    };
    const result = await dispatchToDelivery(input, CASHIER);
    const [consignment] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, result.consignmentId));
    const snapshots = await db()
      .select()
      .from(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId));
    expect(snapshots).toHaveLength(2);
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.eventOccurredAt.toISOString() ===
          consignment.dispatchedAt.toISOString(),
      ),
    ).toBe(true);
    expect(await db().select().from(s.inventoryMovements)).toEqual(
      beforeMovements,
    );
    const sales = (await db().select().from(s.accountingEntries)).filter(
      (entry) => entry.entryType === "SALE",
    );
    expect(sales).toHaveLength(1);

    const replay = await dispatchToDelivery(input, CASHIER);
    expect(replay.consignmentId).toBe(result.consignmentId);
    expect(
      await db()
        .select()
        .from(deliveryDocumentSnapshots)
        .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId)),
    ).toEqual(snapshots);
    expect(await db().select().from(s.inventoryMovements)).toEqual(
      beforeMovements,
    );
    expect(
      (await db().select().from(s.accountingEntries)).filter(
        (entry) => entry.entryType === "SALE",
      ),
    ).toHaveLength(1);
  });
});
