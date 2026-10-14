import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  REALTIME_EVENT_TYPES,
  type BatchSalesSyncedPayload,
  type RealtimeEvent,
} from "@shared/realtimeEvents";
import {
  publishRealtimeEvent,
  initRealtimeBridge,
  stopRealtimeBridge,
  sseManager,
} from "../index";
import { RealtimeManager } from "../../../client/src/lib/realtime/realtimeManager";

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

describe("Wave 5 Real-Time Events — تكامل تطبيقات الهاتف والمرونة وحصانة العمل دون اتصال", () => {
  beforeEach(async () => {
    await initRealtimeBridge({ inMemoryOnly: true });
    sseManager.closeAll();
  });

  afterEach(async () => {
    await stopRealtimeBridge();
    sseManager.closeAll();
  });

  describe("عقد حدث BATCH_SALES_SYNCED وبث SSE المعزول", () => {
    it("يولد حدث BATCH_SALES_SYNCED مع تفاصيل الدفعة والمبلغ الإجمالي ومعرف الجهاز", () => {
      const payload: BatchSalesSyncedPayload = {
        branchId: 1,
        deviceId: "POS-TAB-03",
        syncedCount: 12,
        totalAmount: "145000.00",
        timestamp: Date.now(),
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED);
      expect(event.payload.branchId).toBe(1);
      expect(event.payload.deviceId).toBe("POS-TAB-03");
      expect(event.payload.syncedCount).toBe(12);
      expect(event.payload.totalAmount).toBe("145000.00");
      expect(event.scope?.branchId).toBe(1);
    });

    it("يبث حدث مزامنة المبيعات حصراً لمشتركي الفرع المستهدف", async () => {
      const b1Client = createMockReqRes();
      const b2Client = createMockReqRes();

      sseManager.registerClient({
        id: "conn_sync_b1",
        userId: 10,
        role: "manager",
        scopedBranchId: 1,
        req: b1Client.req,
        res: b1Client.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      sseManager.registerClient({
        id: "conn_sync_b2",
        userId: 20,
        role: "manager",
        scopedBranchId: 2,
        req: b2Client.req,
        res: b2Client.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
        {
          branchId: 1,
          deviceId: "TAB-01",
          syncedCount: 5,
          totalAmount: "50000.00",
          timestamp: Date.now(),
        },
        { branchId: 1 },
      );

      await sseManager.broadcast(event);

      const b1Data = b1Client.res.writtenData.join("");
      const b2Data = b2Client.res.writtenData.join("");

      expect(b1Data).toContain("BATCH_SALES_SYNCED");
      expect(b1Data).toContain('"syncedCount":5');
      expect(b2Data).not.toContain("BATCH_SALES_SYNCED");
    });
  });

  describe("مراقبة مقاييس الذاكرة والمشتركين النشطين (Stream Router Metrics)", () => {
    it("يوفر sseManager إحصائيات دقيقة لعدد الاتصالات النشطة والمعرفات", () => {
      expect(sseManager.activeCount).toBe(0);

      const c1 = createMockReqRes();
      const c2 = createMockReqRes();

      sseManager.registerClient({
        id: "m_conn_1",
        userId: 1,
        role: "admin",
        scopedBranchId: null,
        req: c1.req,
        res: c1.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      sseManager.registerClient({
        id: "m_conn_2",
        userId: 2,
        role: "cashier",
        scopedBranchId: 1,
        req: c2.req,
        res: c2.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      const stats = sseManager.getStats();
      expect(stats.activeConnections).toBe(2);
      expect(stats.connectionIds).toContain("m_conn_1");
      expect(stats.connectionIds).toContain("m_conn_2");

      sseManager.removeClient("m_conn_1");
      expect(sseManager.activeCount).toBe(1);
    });
  });

  describe("تكامل تطبيقات الهاتف وخمول الخلفية (Mobile AppState Lifecycle)", () => {
    it("يقطع مقبس SSE ويتحول إلى idle_disconnected عند الانتقال إلى background", () => {
      const manager = new RealtimeManager("test_mobile_tab");
      const statusChanges: string[] = [];
      manager.subscribeStatus((st) => statusChanges.push(st));

      expect(manager.getAppState()).toBe("active");

      // محاكاة انتقال تطبيق الهاتف إلى الخلفية
      manager.setAppState("background");
      expect(manager.getAppState()).toBe("background");
      expect(manager.getStatus()).toBe("idle_disconnected");

      // محاكاة عودة التطبيق للواجهة الأمامية
      manager.setAppState("active");
      expect(manager.getAppState()).toBe("active");
      expect(manager.getStatus()).toBe("disconnected");

      manager.stop();
    });
  });

  describe("تجميع وتخفيف تدفق المزامنة المجمعة (Batch Coalescing)", () => {
    it("يجمع أحداث المبيعات المتقاربة زمنياً في حدث واحد لتفادي عواصف التحديثات", async () => {
      vi.useFakeTimers();
      const manager = new RealtimeManager("test_coalesce_tab");

      const receivedEvents: RealtimeEvent<BatchSalesSyncedPayload>[] = [];
      manager.subscribe<BatchSalesSyncedPayload>(
        REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
        (evt) => {
          receivedEvents.push(evt);
        },
      );

      // وصول 3 دفعات مبيعات متتالية بفارق أجزاء من الثانية
      (manager as any).dispatchLocalEvent({
        id: "b1",
        type: REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
        payload: {
          branchId: 1,
          deviceId: "TAB-01",
          syncedCount: 3,
          totalAmount: "30000.00",
          timestamp: 1000,
        },
        timestamp: 1000,
      });

      (manager as any).dispatchLocalEvent({
        id: "b2",
        type: REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
        payload: {
          branchId: 1,
          deviceId: "TAB-01",
          syncedCount: 5,
          totalAmount: "50000.00",
          timestamp: 1050,
        },
        timestamp: 1050,
      });

      (manager as any).dispatchLocalEvent({
        id: "b3",
        type: REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
        payload: {
          branchId: 1,
          deviceId: "TAB-01",
          syncedCount: 2,
          totalAmount: "20000.00",
          timestamp: 1100,
        },
        timestamp: 1100,
      });

      // قبل انقضاء مؤقت التجميع: لم يُبث الحدث بعد
      expect(receivedEvents).toHaveLength(0);

      // تقدم الوقت بمقدار 300ms لانتهاء نافذة التجميع
      vi.advanceTimersByTime(300);

      // يجب أن يكون قد وصل حدث مُجمَّع واحد يحمل المجموع الكلي
      expect(receivedEvents).toHaveLength(1);
      const coalesced = receivedEvents[0];
      expect(coalesced.payload.syncedCount).toBe(10); // 3 + 5 + 2
      expect(coalesced.payload.totalAmount).toBe("100000.00"); // 30000 + 50000 + 20000
      expect(coalesced.payload.timestamp).toBe(1100);

      manager.stop();
      vi.useRealTimers();
    });
  });
});
