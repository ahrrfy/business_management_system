import { describe, it, expect, afterEach, vi } from "vitest";
import {
  initRealtimeBridge,
  publishToBridge,
  onBridgeEvent,
  stopRealtimeBridge,
  getBridgeStatus,
  RealtimeBridgeManager,
} from "../bridge";
import { createRealtimeEvent, REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import net from "node:net";

describe("realtimeBridge — ناقل الحلقات الداخلي بين عمال PM2 والذاكرة", () => {
  afterEach(async () => {
    await stopRealtimeBridge();
  });

  it("يعمل بنمط in_memory الافتراضي في بيئة التطوير والعملية الواحدة", async () => {
    const mode = await initRealtimeBridge({ inMemoryOnly: true });
    expect(mode).toBe("in_memory");

    const status = getBridgeStatus();
    expect(status.mode).toBe("in_memory");
    expect(status.connectedClients).toBe(0);

    const received: any[] = [];
    const unsubscribe = onBridgeEvent((evt) => {
      received.push(evt);
    });

    const testEvent = createRealtimeEvent(
      REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
      { workOrderId: 101 },
      { branchId: 1 },
    );

    publishToBridge(testEvent);

    expect(received.length).toBe(1);
    expect(received[0].id).toBe(testEvent.id);
    expect(received[0].payload).toEqual({ workOrderId: 101 });

    unsubscribe();
  });

  it("يشغّل خادم Hub محلي فائق الخفة على 127.0.0.1 عندما يكون العامل 0 متعدد العمال", async () => {
    // منفذ اختبار عشوائي معزول
    const testPort = 3109 + Math.floor(Math.random() * 200);

    const mode = await initRealtimeBridge({
      port: testPort,
      host: "127.0.0.1",
      isHub: true,
      isMultiWorker: true,
      workerId: "test_hub_0",
    });

    expect(mode).toBe("hub");
    const status = getBridgeStatus();
    expect(status.mode).toBe("hub");

    // محاكاة عامل PM2 آخر (عامل 1) يتصل بالـ Hub عبر مقبس TCP
    const clientSocket = net.createConnection({ host: "127.0.0.1", port: testPort });

    await new Promise<void>((resolve) => {
      clientSocket.on("connect", () => resolve());
    });

    const receivedByClient: any[] = [];
    let buffer = "";

    clientSocket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        receivedByClient.push(JSON.parse(line));
      }
    });

    // نشر حدث من الـ Hub
    const hubEvent = createRealtimeEvent(
      REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED,
      { orderId: 789 },
      { branchId: 2 },
    );

    publishToBridge(hubEvent);

    // انتظار وصول الرسالة عبر المقبس
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedByClient.length).toBe(1);
    expect(receivedByClient[0].event.id).toBe(hubEvent.id);
    expect(receivedByClient[0].event.payload).toEqual({ orderId: 789 });

    // الآن نرسل حدثاً من العامل 1 إلى الـ Hub
    const receivedByHubListeners: any[] = [];
    const unsubscribe = onBridgeEvent((evt) => {
      receivedByHubListeners.push(evt);
    });

    const workerEvent = createRealtimeEvent(
      REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
      { parcelId: 55 },
      { branchId: 1 },
    );

    clientSocket.write(
      JSON.stringify({ originWorkerId: "worker_1", event: workerEvent }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedByHubListeners.length).toBe(1);
    expect(receivedByHubListeners[0].id).toBe(workerEvent.id);
    expect(receivedByHubListeners[0].payload).toEqual({ parcelId: 55 });

    unsubscribe();
    clientSocket.destroy();
  });

  it("يسقط تلقائياً إلى in_memory بسلاسة عند تعذر فتح المنفذ دون إسقاط الخادم", async () => {
    // حجز المنفذ مسبقاً بمقبس خارجي
    const testPort = 3450 + Math.floor(Math.random() * 100);
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(testPort, "127.0.0.1", () => resolve()));

    try {
      const mode = await initRealtimeBridge({
        port: testPort,
        host: "127.0.0.1",
        isHub: true,
        isMultiWorker: true,
      });

      // يجب أن يرجع لـ in_memory بدلاً من رمي خطأ أو إيقاف العملية
      expect(mode).toBe("in_memory");
      expect(getBridgeStatus().mode).toBe("in_memory");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("ينقل الأحداث بين عاملي PM2 (Hub وعامل Client) بالاتجاهين مع عزل معرّف العامل", async () => {
    const testPort = 3600 + Math.floor(Math.random() * 200);
    const hub = new RealtimeBridgeManager();
    const worker1 = new RealtimeBridgeManager();

    try {
      await hub.init({
        port: testPort,
        host: "127.0.0.1",
        isHub: true,
        isMultiWorker: true,
        workerId: "hub_worker_0",
      });

      await worker1.init({
        port: testPort,
        host: "127.0.0.1",
        isHub: false,
        isMultiWorker: true,
        workerId: "client_worker_1",
      });

      // انتظار استقرار اتصال المقبس
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(worker1.getStatus().isConnectedToHub).toBe(true);

      const worker1Received: any[] = [];
      worker1.subscribe((evt) => {
        worker1Received.push(evt);
      });

      const hubReceived: any[] = [];
      hub.subscribe((evt) => {
        hubReceived.push(evt);
      });

      // 1. نشر حدث من Hub -> يجب أن يصل لعامل 1
      const eventFromHub = createRealtimeEvent(
        REALTIME_EVENT_TYPES.ANNOUNCEMENT_PUBLISHED,
        { title: "إعلان من Hub" },
      );
      hub.publish(eventFromHub);

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(worker1Received.length).toBe(1);
      expect(worker1Received[0].id).toBe(eventFromHub.id);

      // 2. نشر حدث من عامل 1 -> يجب أن يصل للـ Hub
      const eventFromWorker1 = createRealtimeEvent(
        REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED,
        { note: "إشعار من العامل 1" },
      );
      worker1.publish(eventFromWorker1);

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(hubReceived.length).toBe(2); // الحدث المحلي للـ hub + الحدث القادم من عامل 1
      expect(hubReceived.some((e) => e.id === eventFromWorker1.id)).toBe(true);
    } finally {
      await worker1.stop();
      await hub.stop();
    }
  });

  it("requests one snapshot repair after hub recovery while the browser SSE can remain open", async () => {
    const port = 4200 + Math.floor(Math.random() * 200);
    const hub = new RealtimeBridgeManager();
    const worker = new RealtimeBridgeManager();
    const received: any[] = [];
    const hubReceived: any[] = [];
    worker.subscribe((event) => received.push(event));
    hub.subscribe((event) => hubReceived.push(event));
    try {
      await hub.init({ port, isHub: true, isMultiWorker: true });
      await worker.init({ port, isHub: false, isMultiWorker: true });
      await vi.waitFor(() => expect(worker.getStatus().isConnectedToHub).toBe(true));
      expect(received).toHaveLength(0);
      await hub.stop();
      await vi.waitFor(() => expect(worker.getStatus().isConnectedToHub).toBe(false));
      await hub.init({ port, isHub: true, isMultiWorker: true });
      await vi.waitFor(() => expect(received.some((event) => event.type === REALTIME_EVENT_TYPES.RESYNC_REQUIRED)).toBe(true), { timeout: 4000 });
      expect(received.filter((event) => event.type === REALTIME_EVENT_TYPES.RESYNC_REQUIRED)).toHaveLength(1);
      expect(received[0].payload).toEqual({});
      await vi.waitFor(() => expect(hubReceived.some((event) => event.type === REALTIME_EVENT_TYPES.RESYNC_REQUIRED)).toBe(true));
    } finally {
      await worker.stop();
      await hub.stop();
    }
  });

  it("يخزن الأحداث مؤقتاً في طابور عند نشرها وعامل الـ Client غير متصل بالـ Hub، ثم يفرغها فور الاتصال", async () => {
    const testPort = 3800 + Math.floor(Math.random() * 200);
    const workerClient = new RealtimeBridgeManager();

    // تشغيل العامل في وضع client قبل إطلاق الـ Hub
    await workerClient.init({
      port: testPort,
      host: "127.0.0.1",
      isHub: false,
      isMultiWorker: true,
      workerId: "client_early_worker",
    });

    expect(workerClient.getStatus().isConnectedToHub).toBe(false);

    // نشر حدث أثناء انقطاع الـ Hub
    const earlyEvent = createRealtimeEvent(
      REALTIME_EVENT_TYPES.WORK_ORDER_STATUS_CHANGED,
      { status: "in_progress" },
    );
    workerClient.publish(earlyEvent);

    // التحقق من تخزين الحدث في طابور pendingOutbound
    expect(workerClient.getStatus().pendingOutbound).toBe(1);

    // الآن نطلق الـ Hub ليستقبل الرسائل المؤجلة
    const hub = new RealtimeBridgeManager();
    const hubReceived: any[] = [];

    try {
      await hub.init({
        port: testPort,
        host: "127.0.0.1",
        isHub: true,
        isMultiWorker: true,
        workerId: "hub_late_worker",
      });

      hub.subscribe((evt) => {
        hubReceived.push(evt);
      });

      // انتظار محاولة إعادة اتصال العامل بالـ Hub وتفريغ الطابور
      await new Promise((resolve) => setTimeout(resolve, 1800));

      expect(workerClient.getStatus().isConnectedToHub).toBe(true);
      expect(workerClient.getStatus().pendingOutbound).toBe(0);
      expect(hubReceived.some((e) => e.id === earlyEvent.id)).toBe(true);
    } finally {
      await workerClient.stop();
      await hub.stop();
    }
  });
});
