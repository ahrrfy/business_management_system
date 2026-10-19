import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { truncateTables } from "../../__tests__/__testUtils__";
import {
  getOnlineOrder,
  listOnlineOrders,
  onlineOrderStatusCounts,
} from "../orderFulfillmentService";
import { trackOnlineOrderForCustomer } from "../../onlineOrderService";
import {
  confirmConsignmentDelivery,
  listMyDeliveries,
} from "../../delivery/courier";
import { getStoreAnalytics } from "../storeAnalyticsService";
import { dispatchOnlineOrder } from "../dispatchOnlineOrder";
import { cancelDeliveryAssignment } from "../../delivery/cancellation";
import { getPartyStoreInTransit } from "../../delivery/queries";
import { getCourierPerformance } from "../../reports/courierPerformance";
import { getStoreCustomers } from "../storeCustomerService";
import { workOrderRouter } from "../../../routers/workOrderRouter";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { loadOnlineOrderLifecycles } from "../onlineOrderTracking";

const db = () => getDb()!;
beforeEach(async () => {
  await truncateTables([
    "auditLogs",
    "deliveryEvents",
    "deliveryLedgerEntries",
    "deliveryConsignments",
    "deliveryPartyMembers",
    "deliveryParties",
    "onlineOrderItems",
    "onlineOrders",
    "invoiceItems",
    "invoices",
    "customers",
    "branches",
    "users",
  ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "OTHER", code: "OTHER", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "tracking",
    name: "موظف التوصيل",
    role: "admin",
    branchId: 1,
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل", phone: "+9647701234567" });
  await db()
    .insert(s.deliveryParties)
    .values({ id: 1, name: "شركة التوصيل", partyType: "COMPANY" });
  await db().insert(s.invoices).values({
    id: 1,
    invoiceNumber: "INV-TRACK",
    branchId: 1,
    customerId: 1,
    total: "10000",
    subtotal: "10000",
    paidAmount: "10000",
    status: "PAID",
    sourceType: "ONLINE",
  });
  await db()
    .insert(s.onlineOrders)
    .values({
      id: 1,
      orderNumber: "ORD-TRACK",
      branchId: 1,
      customerId: 1,
      subtotal: "10000",
      total: "10000",
      shippingAddress: "بغداد",
      status: "SHIPPED",
      invoiceId: 1,
      deliveryPartyId: 1,
      orderDate: new Date("2026-10-18T12:00:00Z"),
      createdAt: new Date("2026-10-18T12:00:00Z"),
    });
  // Historic invoice bridge: the delivery truth progressed while the order header remained SHIPPED.
  await db().insert(s.deliveryConsignments).values({
    id: 1,
    consignmentNumber: "CN-TRACK",
    branchId: 1,
    partyId: 1,
    invoiceId: 1,
    sourceType: "INVOICE",
    sourceId: 1,
    codAmount: "10000",
    parcelStatus: "DELIVERED",
    moneyStatus: "UNSETTLED",
    status: "DISPATCHED",
    courierDeliveredAt: new Date(),
    custodyRecognizedAt: new Date(),
  });
  await db().insert(s.deliveryLedgerEntries).values({
    eventKey: "tracking-collected",
    partyId: 1,
    consignmentId: 1,
    branchId: 1,
    entryType: "COD_COLLECTED",
    amount: "10000",
  });
  await db().insert(s.deliveryEvents).values({
    eventKey: "tracking-delivered",
    consignmentId: 1,
    eventType: "DELIVERED",
    actorUserId: 1,
  });
});

describe("online order current lifecycle", () => {
  it.each(["utf8mb4_0900_ai_ci", "utf8mb4_unicode_ci"])(
    "loads audit evidence with connection collation %s",
    async (charset) => {
      const pool = mysql.createPool({
        uri: process.env.DATABASE_URL!,
        charset,
        connectionLimit: 1,
      });
      try {
        await db()
          .insert(s.auditLogs)
          .values({
            userId: 1,
            branchId: 1,
            action: "store.order.updateContact",
            entityType: "onlineOrder",
            entityId: "1",
            createdAt: new Date("2030-01-01T00:00:00Z"),
          });
        const lifecycles = await loadOnlineOrderLifecycles(
          drizzle(pool, { schema: s, mode: "default" }),
          [1],
        );
        expect(lifecycles.get(1)?.latestEvent).toMatchObject({
          label: "تحديث التواصل",
          actorName: "موظف التوصيل",
        });
      } finally {
        await pool.end();
      }
    },
  );
  it("stops reception from offering a delivered invoice-linked order for assignment", async () => {
    const [user] = await db().select().from(s.users).where(eq(s.users.id, 1));
    const caller = workOrderRouter.createCaller({
      req: { headers: {} },
      res: {},
      sessionId: null,
      platformAdmin: null,
      user: { ...user, isOwner: true, totpEnabledAt: new Date() },
    } as never);
    expect(
      await caller.getByNumber({ orderNumber: "ORD-TRACK" }),
    ).toMatchObject({
      kind: "onlineOrder",
      status: "DELIVERED",
      activeConsignment: { id: 1, parcelStatus: "DELIVERED" },
    });
  });
  it("keeps delivery exposure, courier reporting and customer totals consistent with invoice-linked parcels", async () => {
    expect.soft(await getPartyStoreInTransit(1, 1)).toMatchObject({ count: 0 });
    const performance = await getCourierPerformance({ branchId: 1 });
    expect
      .soft(performance.rows.find((row) => row.partyId === 1))
      .toMatchObject({
        assigned: 0,
        inTransit: 0,
        cnAssigned: 1,
        cnDelivered: 1,
      });
    expect
      .soft((await getStoreCustomers({ scopedBranchId: 1 })).rows[0])
      .toMatchObject({
        deliveredOrders: 1,
        spend: "10000.00",
      });
    expect((await getStoreCustomers({ scopedBranchId: 2 })).rows).toEqual([]);
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus: "RETURNED" })
      .where(eq(s.deliveryConsignments.id, 1));
    expect(
      (await getStoreCustomers({ scopedBranchId: 1 })).rows[0],
    ).toMatchObject({
      deliveredOrders: 0,
      spend: "0.00",
    });
  });
  it("reactivates an old cancelled assignment even when its header remained SHIPPED", async () => {
    await db().delete(s.deliveryEvents);
    await db().delete(s.deliveryLedgerEntries);
    await db()
      .update(s.deliveryConsignments)
      .set({
        parcelStatus: "CANCELLED",
        moneyStatus: "CANCELLED",
        status: "CANCELLED",
        courierDeliveredAt: null,
        custodyRecognizedAt: null,
      })
      .where(eq(s.deliveryConsignments.id, 1));
    await db()
      .update(s.invoices)
      .set({ status: "PENDING", paidAmount: "0" })
      .where(eq(s.invoices.id, 1));
    expect(await trackOnlineOrderForCustomer("ORD-TRACK", 1)).toMatchObject({
      status: "PROCESSING",
      deliveryProgress: { complete: false, phase: "AWAITING_REASSIGNMENT" },
    });
    const actor = { userId: 1, branchId: 1, role: "admin" };
    const result = await dispatchOnlineOrder(
      { onlineOrderId: 1, partyId: 1, externalTrackingRef: "TRACK-REASSIGN-1" },
      actor,
    );
    expect(result.alreadyDispatched).not.toBe(true);
    expect(
      (await db().select().from(s.deliveryConsignments))[0].parcelStatus,
    ).toBe("OUT_FOR_DELIVERY");
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    for (const sequence of [2, 3]) {
      await cancelDeliveryAssignment(
        {
          consignmentId: 1,
          reason: "إعادة إسناد الطلب لجهة التوصيل",
          clientRequestId: `tracking-cancel-${sequence}`,
        },
        actor,
      );
      expect((await getOnlineOrder(1, 1))?.lifecycle?.latestEvent?.label).toBe(
        "ألغي الإسناد",
      );
      expect(await trackOnlineOrderForCustomer("ORD-TRACK", 1)).toMatchObject({
        status: "PROCESSING",
        deliveryProgress: { complete: false, phase: "AWAITING_REASSIGNMENT" },
      });
      await dispatchOnlineOrder(
        {
          onlineOrderId: 1,
          partyId: 1,
          externalTrackingRef: `TRACK-REASSIGN-${sequence}`,
        },
        actor,
      );
      expect(
        (await db().select().from(s.deliveryConsignments))[0].parcelStatus,
      ).toBe("OUT_FOR_DELIVERY");
    }
  });
  it("synchronizes an invoice-linked order inside delivery confirmation without double collection on replay", async () => {
    await db().delete(s.deliveryEvents);
    await db().delete(s.deliveryLedgerEntries);
    await db()
      .update(s.invoices)
      .set({ paidAmount: "0", status: "PENDING" })
      .where(eq(s.invoices.id, 1));
    await db()
      .update(s.customers)
      .set({ currentBalance: "10000" })
      .where(eq(s.customers.id, 1));
    await db()
      .update(s.deliveryConsignments)
      .set({
        parcelStatus: "OUT_FOR_DELIVERY",
        courierDeliveredAt: null,
        custodyRecognizedAt: null,
      })
      .where(eq(s.deliveryConsignments.id, 1));
    const input = {
      consignmentId: 1,
      clientRequestId: "tracking-proof",
      statementWitness: {
        partyId: 1,
        statementNumber: "TRACK-PROOF",
        collectedAmount: "10000",
      },
    };
    await confirmConsignmentDelivery(input, { userId: 1 });
    expect((await db().select().from(s.onlineOrders))[0].status).toBe(
      "DELIVERED",
    );
    await confirmConsignmentDelivery(input, { userId: 1 });
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("10000.00");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
      "10000.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(
      (await db().select().from(s.deliveryLedgerEntries)).filter(
        (r) => r.entryType === "COD_COLLECTED",
      ),
    ).toHaveLength(1);
  });
  it("uses the linked consignment in lists, filters, counts, detail and authenticated customer tracking", async () => {
    const [deliveryEvent] = await db().select().from(s.deliveryEvents);
    await db().insert(s.auditLogs).values({
      userId: 1,
      action: "store.order.dispatch",
      entityType: "onlineOrder",
      entityId: "1",
      createdAt: deliveryEvent.occurredAt,
    });
    const list = await listOnlineOrders({
      scopedBranchId: 1,
      status: "DELIVERED",
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: "DELIVERED",
      lifecycle: {
        label: "تم التسليم والتحصيل",
        remittanceLabel: "بانتظار التوريد",
        consignmentId: 1,
        latestEvent: { label: "سلم", actorName: "موظف التوصيل" },
      },
    });
    expect(
      await listOnlineOrders({ scopedBranchId: 1, status: "SHIPPED" }),
    ).toEqual([]);
    expect(await onlineOrderStatusCounts(1)).toEqual({ DELIVERED: 1 });
    const today = "2026-10-18";
    expect(
      await getStoreAnalytics({
        scopedBranchId: 1,
        fromYmd: today,
        toYmd: today,
      }),
    ).toMatchObject({
      kpis: { deliveredOrders: 1 },
      statusBreakdown: { DELIVERED: 1 },
    });
    expect(await getOnlineOrder(1, 1)).toMatchObject({
      status: "DELIVERED",
      lifecycle: { consignmentId: 1 },
    });
    expect(await trackOnlineOrderForCustomer("ORD-TRACK", 1)).toMatchObject({
      status: "DELIVERED",
      deliveryProgress: { complete: true },
    });
    // Display correction must not fabricate financial movements or rewrite history.
    expect((await db().select().from(s.onlineOrders))[0].status).toBe(
      "SHIPPED",
    );
  });
  it("preserves branch and customer ownership boundaries", async () => {
    expect(await listOnlineOrders({ scopedBranchId: 2 })).toEqual([]);
    expect(await onlineOrderStatusCounts(2)).toEqual({});
    await expect(getOnlineOrder(1, 2)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      trackOnlineOrderForCustomer("ORD-TRACK", 2),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("keeps a fully returned cancelled order terminal even when physical delivery history remains", async () => {
    await db()
      .update(s.onlineOrders)
      .set({ status: "CANCELLED" })
      .where(eq(s.onlineOrders.id, 1));
    await db()
      .update(s.invoices)
      .set({ status: "RETURNED", returnedTotal: "10000" })
      .where(eq(s.invoices.id, 1));
    expect(
      (await listOnlineOrders({ scopedBranchId: 1, status: "CANCELLED" }))[0],
    ).toMatchObject({
      status: "CANCELLED",
      lifecycle: { label: "ملغى", collectionLabel: null },
    });
    expect(await trackOnlineOrderForCustomer("ORD-TRACK", 1)).toMatchObject({
      status: "CANCELLED",
      deliveryProgress: { label: "ملغى" },
    });
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus: "CANCELLED", status: "CANCELLED" })
      .where(eq(s.deliveryConsignments.id, 1));
    const cancelled = await trackOnlineOrderForCustomer("ORD-TRACK", 1);
    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      deliveryProgress: { label: "ملغى", complete: true },
    });
    expect(cancelled?.deliveryProgress?.phase).toBeUndefined();
  });
  it("does not duplicate invoice-linked parcels in the courier's legacy open-order queue", async () => {
    await db()
      .insert(s.deliveryPartyMembers)
      .values({ partyId: 1, userId: 1, memberRole: "MANAGER", isActive: true });
    const result = await listMyDeliveries(1);
    expect(result.toDeliver).toHaveLength(0);
    expect(result.delivered).toHaveLength(1);
  });
  it("uses the actual last preparation/contact audit and actor before dispatch", async () => {
    // The historic orderDate is intentional. Establish a live reservation before
    // reactivation: the database guard checks OLD values against its own clock.
    await db()
      .update(s.onlineOrders)
      .set({ reservationExpiresAt: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY)` })
      .where(eq(s.onlineOrders.id, 1));
    await db()
      .update(s.onlineOrders)
      .set({ status: "PROCESSING" })
      .where(eq(s.onlineOrders.id, 1));
    await db().insert(s.auditLogs).values({
      userId: 1,
      branchId: 1,
      action: "store.order.markPrepared",
      entityType: "onlineOrder",
      entityId: "1",
    });
    expect((await getOnlineOrder(1, 1))?.lifecycle?.latestEvent).toMatchObject({
      label: "تم التجهيز",
      actorName: "موظف التوصيل",
    });
  });
  it("shows returns and failures without relabelling them as completed deliveries", async () => {
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus: "FAILED" })
      .where(eq(s.deliveryConsignments.id, 1));
    expect((await listOnlineOrders({ scopedBranchId: 1 }))[0]).toMatchObject({
      status: "SHIPPED",
      lifecycle: { label: "تعذر التسليم" },
    });
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus: "RETURNED", status: "RETURNED" })
      .where(eq(s.deliveryConsignments.id, 1));
    expect(
      (await listOnlineOrders({ scopedBranchId: 1, status: "CANCELLED" }))[0],
    ).toMatchObject({
      status: "CANCELLED",
      lifecycle: { label: "أعيد للمكتبة" },
    });
  });
});
