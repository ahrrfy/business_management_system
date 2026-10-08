import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealtimeManager } from "../realtimeManager";
import {
  createRealtimeEvent,
  REALTIME_EVENT_TYPES,
  REALTIME_IDLE_TIMEOUT_MS,
} from "@shared/realtimeEvents";
import { connectivity } from "../../offline/connectivity";

describe("RealtimeManager & TabCoordinator — تنسيق التبويبات المتعددة والخمول وانقطاع الشبكة", () => {
  let tab1: RealtimeManager;
  let tab2: RealtimeManager;

  beforeEach(() => {
    // محاكاة بيئة المتصفح الأساسية لـ EventSource و document
    if (typeof globalThis.EventSource === "undefined") {
      (globalThis as any).EventSource = vi.fn().mockImplementation(() => {
        const es = {
          onopen: null as any,
          onmessage: null as any,
          onerror: null as any,
          close: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
        setTimeout(() => es.onopen?.(), 10);
        return es;
      });
    }

    if (typeof globalThis.document === "undefined") {
      (globalThis as any).document = {
        visibilityState: "visible",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }
  });

  afterEach(() => {
    tab1?.stop();
    tab2?.stop();
  });

  it("ينتخب تبويباً قائداً واحداً فقط لفتح اتصال SSE وتوزيع الأحداث لبقية التبويبات", async () => {
    tab1 = new RealtimeManager("tab_alpha");
    tab2 = new RealtimeManager("tab_beta");

    tab1.start();

    // انتظار استقرار القيادة للتبويب 1
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tab1.getIsLeader()).toBe(true);

    tab2.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // التبويب 2 يجب أن يبقى تابعاً (Follower) ولا يفتح اتصال SSE متكرر
    expect(tab2.getIsLeader()).toBe(false);

    // التحقق من وصول حدث لحظي من التبويب القائد إلى التبويب التابع عبر BroadcastChannel
    const receivedByTab2: any[] = [];
    tab2.subscribe(REALTIME_EVENT_TYPES.WORK_ORDER_CREATED, (event) => {
      receivedByTab2.push(event);
    });

    const testEvent = createRealtimeEvent(
      REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
      { workOrderId: 909 },
      { branchId: 1 },
    );

    // محاكاة استلام القائد لحدث خادمي وتوزيعه
    (tab1 as any).onReceiveServerEvent(testEvent);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedByTab2.length).toBe(1);
    expect(receivedByTab2[0].id).toBe(testEvent.id);
    expect(receivedByTab2[0].payload).toEqual({ workOrderId: 909 });
  });

  it("ينقل القيادة للتبويب الآخر تلقائياً عند إغلاق أو استقالة التبويب القائد", async () => {
    tab1 = new RealtimeManager("tab_leader_1");
    tab2 = new RealtimeManager("tab_follower_2");

    tab1.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tab1.getIsLeader()).toBe(true);

    tab2.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tab2.getIsLeader()).toBe(false);

    // إغلاق التبويب القائد
    tab1.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // يجب أن يرث التبويب 2 القيادة فوراً
    expect(tab2.getIsLeader()).toBe(true);
  });

  it("يفصل الاتصال تلقائياً عند خمول التبويب القائد لأكثر من 15 دقيقة ويستأنف فور العودة للواجهة", async () => {
    tab1 = new RealtimeManager("tab_leader_idle");
    tab1.start();

    // ننتظر حتى يصبح التبويب قائداً فعلياً
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tab1.getIsLeader()).toBe(true);

    vi.useFakeTimers();
    try {
      expect(tab1.getStatus()).not.toBe("idle_disconnected");

      // تحول التبويب القائد إلى الخلفية
      (document as any).visibilityState = "hidden";
      (tab1 as any).handleVisibilityChange();

      // تقديم الوقت 14 دقيقة (تحت السقف)
      vi.advanceTimersByTime(14 * 60 * 1000);
      expect(tab1.getStatus()).not.toBe("idle_disconnected");

      // تجاوز 15 دقيقة خمول
      vi.advanceTimersByTime(60 * 1000);
      // التحقق الحاسم: يجب ألا يُطمس idle_disconnected بـ disconnected
      expect(tab1.getStatus()).toBe("idle_disconnected");
      expect(tab1.getIsLeader()).toBe(false);

      // عند عودة التبويب للواجهة (visible)، يجب أن يتعافى من idle_disconnected
      (document as any).visibilityState = "visible";
      (tab1 as any).handleVisibilityChange();

      expect(tab1.getStatus()).not.toBe("idle_disconnected");
    } finally {
      vi.useRealTimers();
      (document as any).visibilityState = "visible";
    }
  });

  it("يسجل مستمعي الأحداث الديناميكية تلقائياً على EventSource النشط", async () => {
    tab1 = new RealtimeManager("tab_dynamic_event_test");
    tab1.start();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tab1.getIsLeader()).toBe(true);

    const received: any[] = [];
    // نوع حدث مخصص لم يكن موجوداً مسبقاً
    tab1.subscribe("CUSTOM_DYNAMIC_EVENT", (event) => {
      received.push(event);
    });

    const customEvent = createRealtimeEvent("CUSTOM_DYNAMIC_EVENT", { foo: "bar" });
    (tab1 as any).onReceiveServerEvent(customEvent);

    expect(received.length).toBe(1);
    expect(received[0].payload).toEqual({ foo: "bar" });
  });

  it("يتكامل مع ConnectivityMachine للانتقال إلى offline ثم الاستئناف عند عودة الشبكة", () => {
    tab1 = new RealtimeManager("tab_offline_test");
    tab1.start();

    // محاكاة انقطاع الإنترنت
    connectivity.noteFailure();
    expect(tab1.getStatus()).toBe("offline");

    // محاكاة عودة الإنترنت
    connectivity.noteSuccess();
    expect(tab1.getStatus()).not.toBe("offline");
  });

  it("يبث أحداث شاشة العميل CFD وقفل السلال عبر BroadcastChannel لكافة التبويبات بنجاح", async () => {
    tab1 = new RealtimeManager("tab_cashier_pos");
    tab2 = new RealtimeManager("tab_cfd_screen");

    tab1.start();
    tab2.start();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const cfdReceivedByTab2: any[] = [];
    tab2.subscribe(REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED, (event) => {
      cfdReceivedByTab2.push(event);
    });

    const cfdPayload = {
      terminalId: "POS-MAIN-01",
      branchId: 1,
      lines: [{ name: "دفتر تجارب مدرسي", quantity: 3, price: "1500.00" }],
      total: "4500.00",
      changeDue: "500.00",
    };

    // بث الحدث محلياً من شاشة الكاشير
    tab1.broadcastLocalEvent(
      REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED,
      cfdPayload,
      { branchId: 1 },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(cfdReceivedByTab2.length).toBe(1);
    expect(cfdReceivedByTab2[0].type).toBe(REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED);
    expect(cfdReceivedByTab2[0].payload.total).toBe("4500.00");
    expect(cfdReceivedByTab2[0].payload.lines[0].name).toBe("دفتر تجارب مدرسي");
  });
});
