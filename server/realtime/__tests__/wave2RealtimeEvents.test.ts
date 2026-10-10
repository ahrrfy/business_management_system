import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  REALTIME_EVENT_TYPES,
  type WorkOrderCreatedPayload,
  type WorkOrderStatusChangedPayload,
  type WorkOrderClaimedPayload,
  type ReceptionQueueUpdatedPayload,
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

describe("Wave 2 Real-Time Events — خط إنتاج المطبعة والاستقبال", () => {
  beforeEach(async () => {
    await initRealtimeBridge({ inMemoryOnly: true });
    sseManager.closeAll();
  });

  afterEach(async () => {
    await stopRealtimeBridge();
    sseManager.closeAll();
  });

  describe("عقود وتوليد أحداث المطبعة والاستقبال (Payload Contracts & Event Creation)", () => {
    it("يولد حدث WORK_ORDER_CREATED مع رقم الأمر والفرع والحالة", () => {
      const payload: WorkOrderCreatedPayload = {
        workOrderId: 701,
        orderNumber: "WO-2026-0701",
        branchId: 1,
        title: "طباعة بوسترات معرض بغداد الدولي",
        status: "RECEIVED",
        customerName: "شركة الرؤية الحديثة",
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
        payload,
        { branchId: 1 },
      );

      expect(event.id).toMatch(/^rt_\d+_/);
      expect(event.type).toBe(REALTIME_EVENT_TYPES.WORK_ORDER_CREATED);
      expect(event.payload.workOrderId).toBe(701);
      expect(event.payload.orderNumber).toBe("WO-2026-0701");
      expect(event.payload.branchId).toBe(1);
      expect(event.scope?.branchId).toBe(1);
    });

    it("يولد حدث WORK_ORDER_CLAIMED لمنع السحب المزدوج في صالة الإنتاج", () => {
      const payload: WorkOrderClaimedPayload = {
        workOrderId: 701,
        branchId: 1,
        claimedByUserId: 15,
        claimedByUserName: "علي كريم",
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED);
      expect(event.payload.workOrderId).toBe(701);
      expect(event.payload.claimedByUserId).toBe(15);
      expect(event.scope?.branchId).toBe(1);
    });

    it("يولد حدث WORK_ORDER_STATUS_CHANGED عند الانتقال إلى IN_PROGRESS و READY", () => {
      const payload: WorkOrderStatusChangedPayload = {
        workOrderId: 701,
        orderNumber: "WO-2026-0701",
        branchId: 1,
        previousStatus: "IN_PROGRESS",
        newStatus: "READY",
        updatedBy: 15,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.WORK_ORDER_STATUS_CHANGED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.WORK_ORDER_STATUS_CHANGED);
      expect(event.payload.newStatus).toBe("READY");
      expect(event.payload.previousStatus).toBe("IN_PROGRESS");
    });

    it("يولد حدث RECEPTION_QUEUE_UPDATED مع علامة readyForPickup للإشعار الفوري", () => {
      const payload: ReceptionQueueUpdatedPayload = {
        orderId: 701,
        orderNumber: "WO-2026-0701",
        branchId: 1,
        status: "READY",
        customerName: "شركة الرؤية الحديثة",
        readyForPickup: true,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.RECEPTION_QUEUE_UPDATED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.RECEPTION_QUEUE_UPDATED);
      expect(event.payload.readyForPickup).toBe(true);
      expect(event.payload.status).toBe("READY");
    });
  });

  describe("عزل الفروع الصارم عبر ناقل SSE (Strict Branch Scoping)", () => {
    it("يبث حدث WORK_ORDER_CREATED فقط للفنيين في نفس الفرع ويحجبه عن فروع أخرى", () => {
      const branch1Client = createMockReqRes();
      const branch2Client = createMockReqRes();

      sseManager.registerClient({
        id: "conn_wo_b1",
        userId: 10,
        role: "technician",
        scopedBranchId: 1,
        companyId: 1,
        req: branch1Client.req,
        res: branch1Client.res,
      });

      sseManager.registerClient({
        id: "conn_wo_b2",
        userId: 20,
        role: "technician",
        scopedBranchId: 2,
        companyId: 1,
        req: branch2Client.req,
        res: branch2Client.res,
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
        {
          workOrderId: 800,
          orderNumber: "WO-800",
          branchId: 1,
          status: "RECEIVED",
        },
        { branchId: 1 },
      );

      // الفرع 1 يستلم الحدث
      const b1Writes = branch1Client.res.writtenData.join("");
      expect(b1Writes).toContain(REALTIME_EVENT_TYPES.WORK_ORDER_CREATED);
      expect(b1Writes).toContain("WO-800");

      // الفرع 2 لا يستلم الحدث (عزل فروع صارم)
      const b2Writes = branch2Client.res.writtenData.join("");
      expect(b2Writes).not.toContain(REALTIME_EVENT_TYPES.WORK_ORDER_CREATED);
      expect(b2Writes).not.toContain("WO-800");
    });

    it("يبث حدث RECEPTION_QUEUE_UPDATED مع readyForPickup لموظفي كاونتر الاستقبال بالفرع", () => {
      const receptionClient = createMockReqRes();
      sseManager.registerClient({
        id: "conn_reception_1",
        userId: 55,
        role: "cashier",
        scopedBranchId: 1,
        companyId: 1,
        req: receptionClient.req,
        res: receptionClient.res,
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.RECEPTION_QUEUE_UPDATED,
        {
          orderId: 900,
          orderNumber: "WO-900",
          branchId: 1,
          status: "READY",
          readyForPickup: true,
          customerName: "حسين علي",
        },
        { branchId: 1 },
      );

      const written = receptionClient.res.writtenData.join("");
      expect(written).toContain(REALTIME_EVENT_TYPES.RECEPTION_QUEUE_UPDATED);
      expect(written).toContain("WO-900");
      expect(written).toContain("حسين علي");
    });
  });

  describe("منع القفل المزدوج والتنسيق اللحظي (Instant Claiming Lock)", () => {
    it("يبث حدث WORK_ORDER_CLAIMED لكافة أجهزة الصالة لتحديث الواجهة فوراً", async () => {
      const receivedEvents: RealtimeEvent[] = [];
      const unsub = onBridgeEvent((event) => {
        if (event.type === REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED) {
          receivedEvents.push(event);
        }
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED,
        {
          workOrderId: 555,
          branchId: 1,
          claimedByUserId: 12,
        },
        { branchId: 1 },
      );

      expect(receivedEvents.length).toBe(1);
      const ev = receivedEvents[0];
      expect(ev.type).toBe(REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED);
      expect((ev.payload as WorkOrderClaimedPayload).claimedByUserId).toBe(12);

      unsub();
    });

    it("يبث حدث WORK_ORDER_CLAIMED مع claimedByUserId: null عند تحرير الأمر لفك القفل عن باقي الأجهزة", async () => {
      const receivedEvents: RealtimeEvent[] = [];
      const unsub = onBridgeEvent((event) => {
        if (event.type === REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED) {
          receivedEvents.push(event);
        }
      });

      publishRealtimeEvent<WorkOrderClaimedPayload>(
        REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED,
        {
          workOrderId: 555,
          branchId: 1,
          claimedByUserId: null,
        },
        { branchId: 1 },
      );

      expect(receivedEvents.length).toBe(1);
      const ev = receivedEvents[0];
      expect(ev.type).toBe(REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED);
      expect((ev.payload as WorkOrderClaimedPayload).claimedByUserId).toBeNull();

      unsub();
    });
  });
});

