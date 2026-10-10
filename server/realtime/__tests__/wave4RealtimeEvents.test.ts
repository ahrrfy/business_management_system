import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  REALTIME_EVENT_TYPES,
  type StocktakeProgressPayload,
  type HeldOrderUpdatedPayload,
  type CustomerFacingDisplayUpdatedPayload,
  type InventoryDepletedPayload,
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

describe("Wave 4 Real-Time Events — العمليات الميدانية والجرد والسلال وشاشة العميل", () => {
  beforeEach(async () => {
    await initRealtimeBridge({ inMemoryOnly: true });
    sseManager.closeAll();
  });

  afterEach(async () => {
    await stopRealtimeBridge();
    sseManager.closeAll();
  });

  describe("عقود وتوليد أحداث الموجة الرابعة (Payload Contracts & Event Creation)", () => {
    it("يولد حدث STOCKTAKE_PROGRESS مع تفاصيل الجلسة والباركود والمستخدم", () => {
      const payload: StocktakeProgressPayload = {
        sessionId: 88,
        branchId: 1,
        totalScanned: 15,
        lastItemSku: "SKU-9921",
        counterUserId: 12,
        timestamp: Date.now(),
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.STOCKTAKE_PROGRESS,
        payload,
        { branchId: 1 },
      );

      expect(event.id).toMatch(/^rt_\d+_/);
      expect(event.type).toBe(REALTIME_EVENT_TYPES.STOCKTAKE_PROGRESS);
      expect(event.payload.sessionId).toBe(88);
      expect(event.payload.branchId).toBe(1);
      expect(event.payload.totalScanned).toBe(15);
      expect(event.payload.lastItemSku).toBe("SKU-9921");
      expect(event.payload.counterUserId).toBe(12);
      expect(event.scope?.branchId).toBe(1);
    });

    it("يولد حدث HELD_ORDER_UPDATED بالحالات المختلفة (HELD / RELEASED / RESUMED)", () => {
      const heldPayload: HeldOrderUpdatedPayload = {
        heldOrderId: 405,
        branchId: 1,
        action: "HELD",
        lockedByUserId: null,
      };

      const heldEvent = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.HELD_ORDER_UPDATED,
        heldPayload,
        { branchId: 1 },
      );

      expect(heldEvent.type).toBe(REALTIME_EVENT_TYPES.HELD_ORDER_UPDATED);
      expect(heldEvent.payload.heldOrderId).toBe(405);
      expect(heldEvent.payload.action).toBe("HELD");

      const releasedPayload: HeldOrderUpdatedPayload = {
        heldOrderId: 405,
        branchId: 1,
        action: "RELEASED",
        lockedByUserId: null,
      };

      const releasedEvent = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.HELD_ORDER_UPDATED,
        releasedPayload,
        { branchId: 1 },
      );

      expect(releasedEvent.payload.action).toBe("RELEASED");
    });

    it("يولد حدث CUSTOMER_FACING_DISPLAY_UPDATED مع بنود الفاتورة والإجمالي", () => {
      const payload: CustomerFacingDisplayUpdatedPayload = {
        terminalId: "POS-TERM-01",
        branchId: 1,
        lines: [
          { name: "طباعة كتاب مدرسي", quantity: 2, price: "15000.00" },
          { name: "تغليف حراري فاخر", quantity: 1, price: "5000.00" },
        ],
        total: "35000.00",
        discount: "0.00",
        changeDue: "15000.00",
        customerName: "حسين علي",
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED);
      expect(event.payload.terminalId).toBe("POS-TERM-01");
      expect(event.payload.lines).toHaveLength(2);
      expect(event.payload.total).toBe("35000.00");
      expect(event.payload.customerName).toBe("حسين علي");
    });

    it("يولد حدث INVENTORY_DEPLETED عند نفاد كمية صنف", () => {
      const payload: InventoryDepletedPayload = {
        productId: 772,
        branchId: 1,
        sku: "PAPER-A4-80G",
        productName: "ورق طباعة A4 فاخر",
        remainingStock: 0,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.INVENTORY_DEPLETED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.INVENTORY_DEPLETED);
      expect(event.payload.productId).toBe(772);
      expect(event.payload.remainingStock).toBe(0);
      expect(event.payload.sku).toBe("PAPER-A4-80G");
    });
  });

  describe("عزل وتوجيه بث SSE للجرد والسلال (Branch Scoping & Delivery)", () => {
    it("يصل حدث تقدم الجرد فقط للمتصلين بفرع الجلسة ولا يصل لفروع أخرى", async () => {
      const branch1 = createMockReqRes();
      const branch2 = createMockReqRes();

      sseManager.registerClient({
        id: "conn_stocktake_b1",
        userId: 10,
        role: "manager",
        scopedBranchId: 1,
        req: branch1.req,
        res: branch1.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      sseManager.registerClient({
        id: "conn_stocktake_b2",
        userId: 20,
        role: "manager",
        scopedBranchId: 2,
        req: branch2.req,
        res: branch2.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.STOCKTAKE_PROGRESS,
        {
          sessionId: 101,
          branchId: 1,
          totalScanned: 50,
          timestamp: Date.now(),
        },
        { branchId: 1 },
      );

      await sseManager.broadcast(event);

      const b1Messages = branch1.res.writtenData.join("");
      const b2Messages = branch2.res.writtenData.join("");

      expect(b1Messages).toContain("STOCKTAKE_PROGRESS");
      expect(b1Messages).toContain('"sessionId":101');
      expect(b2Messages).not.toContain("STOCKTAKE_PROGRESS");
    });

    it("يصل تحديث السلة المعلقة HELD_ORDER_UPDATED لدرج الكاشير بالفرع نفسه", async () => {
      const cashier1 = createMockReqRes();
      const cashier2 = createMockReqRes();

      sseManager.registerClient({
        id: "conn_cashier_b1",
        userId: 15,
        role: "cashier",
        scopedBranchId: 1,
        req: cashier1.req,
        res: cashier1.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      sseManager.registerClient({
        id: "conn_cashier_b2",
        userId: 25,
        role: "cashier",
        scopedBranchId: 2,
        req: cashier2.req,
        res: cashier2.res,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
      });

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.HELD_ORDER_UPDATED,
        {
          heldOrderId: 789,
          branchId: 1,
          action: "RELEASED",
          lockedByUserId: null,
        },
        { branchId: 1 },
      );

      await sseManager.broadcast(event);

      const c1Data = cashier1.res.writtenData.join("");
      const c2Data = cashier2.res.writtenData.join("");

      expect(c1Data).toContain("HELD_ORDER_UPDATED");
      expect(c1Data).toContain('"action":"RELEASED"');
      expect(c2Data).not.toContain("HELD_ORDER_UPDATED");
    });

    it("ناقل الحلقات المحلي (Bridge Bus) ينقل أحداث شاشة العميل ونفاد المخزون", async () => {
      const receivedEvents: RealtimeEvent[] = [];
      const cleanup = onBridgeEvent((evt) => {
        receivedEvents.push(evt);
      });

      try {
        publishRealtimeEvent(
          REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED,
          {
            terminalId: "TERM-01",
            branchId: 1,
            lines: [],
            total: "0.00",
          },
          { branchId: 1 },
        );

        publishRealtimeEvent(
          REALTIME_EVENT_TYPES.INVENTORY_DEPLETED,
          {
            productId: 99,
            branchId: 1,
            remainingStock: 0,
          },
          { branchId: 1 },
        );

        expect(receivedEvents).toHaveLength(2);
        expect(receivedEvents[0].type).toBe(REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED);
        expect(receivedEvents[1].type).toBe(REALTIME_EVENT_TYPES.INVENTORY_DEPLETED);
      } finally {
        cleanup();
      }
    });
  });
});
