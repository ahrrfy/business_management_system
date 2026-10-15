import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  REALTIME_EVENT_TYPES,
  type StorefrontOrderPlacedPayload,
  type DeliveryDispatchedPayload,
  type DeliveryCompletedPayload,
  type ShortfallAssignedPayload,
  type RealtimeEvent,
} from "@shared/realtimeEvents";
import {
  publishRealtimeEvent,
  initRealtimeBridge,
  stopRealtimeBridge,
  sseManager,
} from "../index";
import { onBridgeEvent } from "../bridge";

function createMockReqRes() {
  const req = new EventEmitter() as any;
  req.headers = {};
  const res = new EventEmitter() as any;
  res.writtenData = [] as string[];
  res.writableEnded = false;
  res.destroyed = false;
  res.write = vi.fn((data: string) => {
    res.writtenData.push(data);
    return true;
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
  });
  return { req, res };
}

describe("Wave 3 Real-Time Events — أسطول التوصيل وتنفيذ طلبات المتجر", () => {
  beforeEach(async () => {
    await initRealtimeBridge({ inMemoryOnly: true });
    sseManager.closeAll();
  });

  afterEach(async () => {
    await stopRealtimeBridge();
    sseManager.closeAll();
  });

  describe("عقود وتوليد أحداث التوصيل والمتجر (Payload Contracts & Event Creation)", () => {
    it("يولد حدث STOREFRONT_ORDER_PLACED مع رقم الطلب والمبلغ واسم العميل والفرع", () => {
      const payload: StorefrontOrderPlacedPayload = {
        orderId: 1001,
        orderNumber: "ORD-2026-1001",
        branchId: 1,
        totalAmount: "45000.00",
        customerName: "سارة أحمد",
        itemsCount: 3,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED,
        payload,
        { branchId: 1 },
      );

      expect(event.id).toMatch(/^rt_\d+_/);
      expect(event.type).toBe(REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED);
      expect(event.payload.orderId).toBe(1001);
      expect(event.payload.orderNumber).toBe("ORD-2026-1001");
      expect(event.payload.totalAmount).toBe("45000.00");
      expect(event.payload.customerName).toBe("سارة أحمد");
      expect(event.payload.itemsCount).toBe(3);
      expect(event.scope?.branchId).toBe(1);
    });

    it("يولد حدث DELIVERY_DISPATCHED عند إسناد الطرد وخروجه للتوصيل", () => {
      const payload: DeliveryDispatchedPayload = {
        deliveryId: 501,
        invoiceId: 888,
        orderId: 1001,
        trackingNumber: "CN-2026-0501",
        driverId: 77,
        branchId: 1,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED);
      expect(event.payload.deliveryId).toBe(501);
      expect(event.payload.trackingNumber).toBe("CN-2026-0501");
      expect(event.payload.driverId).toBe(77);
      expect(event.scope?.branchId).toBe(1);
    });

    it("يولد حدث DELIVERY_COMPLETED عند ختم التسليم وتحصيل COD", () => {
      const payload: DeliveryCompletedPayload = {
        deliveryId: 501,
        invoiceId: 888,
        driverId: 77,
        branchId: 1,
        collectedAmount: "45000.00",
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.DELIVERY_COMPLETED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.DELIVERY_COMPLETED);
      expect(event.payload.deliveryId).toBe(501);
      expect(event.payload.collectedAmount).toBe("45000.00");
      expect(event.payload.driverId).toBe(77);
      expect(event.scope?.branchId).toBe(1);
    });

    it("يولد حدث SHORTFALL_ASSIGNED عند تسجيل عجز عهدة على المندوب", () => {
      const payload: ShortfallAssignedPayload = {
        deliveryId: 501,
        driverId: 77,
        amount: "5000.00",
        reason: "CUSTOMER_DISPUTE",
        branchId: 1,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.SHORTFALL_ASSIGNED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.SHORTFALL_ASSIGNED);
      expect(event.payload.amount).toBe("5000.00");
      expect(event.payload.reason).toBe("CUSTOMER_DISPUTE");
      expect(event.payload.driverId).toBe(77);
      expect(event.scope?.branchId).toBe(1);
    });
  });

  describe("عزل الفروع والتوجيه الميداني (Strict Scoping for Fleet & Storefront)", () => {
    it("يبث حدث STOREFRONT_ORDER_PLACED لمسؤولي الفرع المعني فقط ويمنعه عن فروع أخرى", () => {
      const branch1Staff = createMockReqRes();
      const branch2Staff = createMockReqRes();

      sseManager.registerClient({
        id: "conn_fulfillment_b1",
        userId: 10,
        role: "manager",
        scopedBranchId: 1,
        companyId: 1,
        req: branch1Staff.req,
        res: branch1Staff.res,
      });

      sseManager.registerClient({
        id: "conn_fulfillment_b2",
        userId: 20,
        role: "manager",
        scopedBranchId: 2,
        companyId: 1,
        req: branch2Staff.req,
        res: branch2Staff.res,
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED,
        {
          orderId: 1002,
          orderNumber: "ORD-1002",
          branchId: 1,
          totalAmount: "30000.00",
        },
        { branchId: 1 },
      );

      const b1 = branch1Staff.res.writtenData.join("");
      expect(b1).toContain(REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED);
      expect(b1).toContain("ORD-1002");

      const b2 = branch2Staff.res.writtenData.join("");
      expect(b2).not.toContain(REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED);
      expect(b2).not.toContain("ORD-1002");
    });

    it("يبث حدث DELIVERY_DISPATCHED و DELIVERY_COMPLETED لتحديث شاشات المندوب والتحكم", () => {
      const driverClient = createMockReqRes();

      sseManager.registerClient({
        id: "conn_courier_77",
        userId: 77,
        role: "courier",
        scopedBranchId: 1,
        companyId: 1,
        req: driverClient.req,
        res: driverClient.res,
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
        {
          deliveryId: 502,
          invoiceId: 889,
          driverId: 77,
          branchId: 1,
          trackingNumber: "CN-0502",
        },
        { branchId: 1 },
      );

      const writtenDispatch = driverClient.res.writtenData.join("");
      expect(writtenDispatch).toContain(REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED);
      expect(writtenDispatch).toContain("CN-0502");

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.DELIVERY_COMPLETED,
        {
          deliveryId: 502,
          invoiceId: 889,
          driverId: 77,
          branchId: 1,
          collectedAmount: "25000.00",
        },
        { branchId: 1 },
      );

      const writtenComplete = driverClient.res.writtenData.join("");
      expect(writtenComplete).toContain(REALTIME_EVENT_TYPES.DELIVERY_COMPLETED);
      expect(writtenComplete).toContain("25000.00");
    });
  });

  describe("مراقبة عهدة السائقين والعجز اللحظي (Shortfall & Custody Live Reflection)", () => {
    it("يبث حدث SHORTFALL_ASSIGNED عبر الناقل مع السبب والمبلغ", async () => {
      const receivedEvents: RealtimeEvent[] = [];
      const unsub = onBridgeEvent((event) => {
        if (event.type === REALTIME_EVENT_TYPES.SHORTFALL_ASSIGNED) {
          receivedEvents.push(event);
        }
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.SHORTFALL_ASSIGNED,
        {
          deliveryId: 503,
          driverId: 80,
          amount: "12500.00",
          reason: "LOST_IN_TRANSIT",
          branchId: 1,
        },
        { branchId: 1 },
      );

      expect(receivedEvents.length).toBe(1);
      const ev = receivedEvents[0];
      expect(ev.type).toBe(REALTIME_EVENT_TYPES.SHORTFALL_ASSIGNED);
      expect((ev.payload as ShortfallAssignedPayload).reason).toBe("LOST_IN_TRANSIT");
      expect((ev.payload as ShortfallAssignedPayload).amount).toBe("12500.00");

      unsub();
    });
  });
});
