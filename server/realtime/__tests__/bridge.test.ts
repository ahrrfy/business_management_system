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

async function availableTestPort(): Promise<number> {
  const probe = net.createServer();
  return new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Expected an allocated loopback TCP port"));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const waitForConnection = (socket: net.Socket) =>
  new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

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
    const testPort = await availableTestPort();

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
    const testPort = await availableTestPort();
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
    const testPort = await availableTestPort();
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
    const port = await availableTestPort();
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
    const testPort = await availableTestPort();
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

describe("PWA release confirmation barrier", () => {
  const releaseEvent = (userId = 10) =>
    createRealtimeEvent("PWA_SSE_QUIESCE", {}, { userId, companyId: 1 });
  const makeManager = () => {
    const manager = new RealtimeBridgeManager();
    expect(typeof manager.publishConfirmed).toBe("function");
    manager.setReleaseHandler(() => true);
    return manager;
  };
  const close = async (managers: RealtimeBridgeManager[]) => {
    await Promise.all(managers.map((manager) => manager.stop()));
  };
  const cluster = async () => {
    const managers = [makeManager(), makeManager(), makeManager()];
    const port = await availableTestPort();
    await managers[0].init({
      port,
      isHub: true,
      isMultiWorker: true,
      expectedWorkerCount: 3,
      workerId: "release-hub",
    });
    await managers[1].init({
      port,
      isHub: false,
      isMultiWorker: true,
      expectedWorkerCount: 3,
      workerId: "release-source",
    });
    await managers[2].init({
      port,
      isHub: false,
      isMultiWorker: true,
      expectedWorkerCount: 3,
      workerId: "release-peer",
    });
    await vi.waitFor(() =>
      expect(
        managers
          .slice(1)
          .every((manager) => manager.getStatus().isConnectedToHub),
      ).toBe(true),
    );
    return managers;
  };

  it("rejects mismatched worker counts between the source and hub before releasing streams", async () => {
    const hub = makeManager();
    const source = makeManager();
    const handler = vi.fn(() => true);
    hub.setReleaseHandler(handler);
    source.setReleaseHandler(handler);
    const port = await availableTestPort();
    try {
      await hub.init({
        port,
        isHub: true,
        isMultiWorker: true,
        expectedWorkerCount: 2,
      });
      await source.init({
        port,
        isHub: false,
        isMultiWorker: true,
        expectedWorkerCount: 3,
      });
      await vi.waitFor(() =>
        expect(source.getStatus().isConnectedToHub).toBe(true),
      );
      expect(await source.publishConfirmed(releaseEvent(), 200)).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await close([source, hub]);
    }
  });

  it("never replays an expired release request delivered late over TCP", async () => {
    const hub = makeManager();
    const handler = vi.fn(() => true);
    hub.setReleaseHandler(handler);
    const port = await availableTestPort();
    let socket: net.Socket | undefined;
    try {
      await hub.init({
        port,
        isHub: true,
        isMultiWorker: true,
        expectedWorkerCount: 2,
      });
      socket = net.createConnection({ host: "127.0.0.1", port });
      await waitForConnection(socket);
      const result = new Promise<boolean>((resolve) => {
        let buffer = "";
        socket!.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines.filter(Boolean)) {
            const frame = JSON.parse(line);
            if (frame.kind === "pwa-release-apply")
              socket!.write(
                JSON.stringify({
                  kind: "pwa-release-ack",
                  id: frame.id,
                  ok: true,
                }) + "\n",
              );
            if (frame.kind === "pwa-release-result") resolve(frame.ok);
          }
        });
      });
      socket.write(
        JSON.stringify({
          kind: "pwa-release-request",
          id: "expired-request",
          event: releaseEvent(),
          expectedWorkerCount: 2,
          expiresAt: Date.now() - 1_000,
        }) + "\n",
      );
      expect(await result).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      socket?.destroy();
      await hub.stop();
    }
  });

  it("confirms explicit single-worker local release and fails closed with unknown or multi-worker in-memory membership", async () => {
    const manager = makeManager();
    const handler = vi.fn(() => true);
    manager.setReleaseHandler(handler);
    try {
      await manager.init({ inMemoryOnly: true, expectedWorkerCount: 1 });
      expect(await manager.publishConfirmed(releaseEvent(), 100)).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      await manager.init({
        inMemoryOnly: true,
        isMultiWorker: true,
        expectedWorkerCount: 3,
      });
      expect(await manager.publishConfirmed(releaseEvent(), 100)).toBe(false);
      vi.stubEnv("WEB_INSTANCES", "");
      await manager.init({ inMemoryOnly: true });
      expect(await manager.publishConfirmed(releaseEvent(), 100)).toBe(false);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      await manager.stop();
    }
  });

  it("recovers hub mode automatically after EADDRINUSE when the old PM2 worker releases the port", async () => {
    const port = await availableTestPort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(port, "127.0.0.1", () => resolve()),
    );
    const hub = makeManager();
    const peer = makeManager();
    try {
      const initialMode = await hub.init({
        port,
        host: "127.0.0.1",
        isHub: true,
        isMultiWorker: true,
        expectedWorkerCount: 2,
      });
      expect(initialMode).toBe("in_memory");
      expect(await hub.publishConfirmed(releaseEvent(), 100)).toBe(false);

      // إغلاق العامل القديم وتحرير المنفذ أثناء pm2 reload
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await peer.init({
        port,
        host: "127.0.0.1",
        isHub: false,
        isMultiWorker: true,
        expectedWorkerCount: 2,
      });

      await vi.waitFor(
        () => {
          expect(hub.getStatus().mode).toBe("hub");
          expect(peer.getStatus().isConnectedToHub).toBe(true);
        },
        { timeout: 4000 },
      );
      expect(await peer.publishConfirmed(releaseEvent(), 300)).toBe(true);
    } finally {
      await close([peer, hub]);
    }
  });

  it("waits for local plus both remote release handlers, including a delayed ACK", async () => {
    const managers = await cluster();
    const seen = managers.map(() => [] as number[]);
    let acknowledgeLate: (() => void) | undefined;
    managers.forEach((manager, index) =>
      manager.setReleaseHandler((event) => {
        seen[index].push(event.scope!.userId!);
        if (index === 2)
          return new Promise<boolean>((resolve) => {
            acknowledgeLate = () => resolve(true);
          });
        return true;
      }),
    );
    try {
      let settled = false;
      const confirmed = managers[1]
        .publishConfirmed(releaseEvent(10), 500)
        .then((ok) => {
          settled = true;
          return ok;
        });
      await vi.waitFor(() => expect(acknowledgeLate).toBeDefined());
      expect(settled).toBe(false);
      expect(seen).toEqual([[10], [10], [10]]);
      acknowledgeLate!();
      expect(await confirmed).toBe(true);
    } finally {
      await close(managers);
    }
  });

  it("rejects absent members and a disconnected source without queuing or replaying releases", async () => {
    const hub = makeManager();
    const source = makeManager();
    const port = await availableTestPort();
    const handler = vi.fn(() => true);
    source.setReleaseHandler(handler);
    try {
      await source.init({
        port,
        isHub: false,
        isMultiWorker: true,
        expectedWorkerCount: 3,
      });
      expect(await source.publishConfirmed(releaseEvent(), 100)).toBe(false);
      expect(source.getStatus().pendingOutbound).toBe(0);
      await hub.init({
        port,
        isHub: true,
        isMultiWorker: true,
        expectedWorkerCount: 3,
      });
      await vi.waitFor(
        () => expect(source.getStatus().isConnectedToHub).toBe(true),
        { timeout: 2500 },
      );
      expect(await source.publishConfirmed(releaseEvent(), 100)).toBe(false);
      expect(handler).not.toHaveBeenCalled();
      expect(source.getStatus().pendingOutbound).toBe(0);
    } finally {
      await close([source, hub]);
    }
  });

  it("fails when a pinned worker disconnects before release completion", async () => {
    const managers = await cluster();
    let entered = false;
    managers[2].setReleaseHandler(() => {
      entered = true;
      return new Promise<boolean>(() => {});
    });
    try {
      const confirmed = managers[1].publishConfirmed(releaseEvent(), 500);
      await vi.waitFor(() => expect(entered).toBe(true));
      await managers[2].stop();
      expect(await confirmed).toBe(false);
    } finally {
      await close(managers);
    }
  });

  it("rejects release confirmation when connected sockets share a duplicate workerId", async () => {
    const hub = makeManager();
    const peerA = makeManager();
    const peerB = makeManager();
    const handler = vi.fn(() => true);
    hub.setReleaseHandler(handler);
    peerA.setReleaseHandler(handler);
    peerB.setReleaseHandler(handler);
    const port = await availableTestPort();
    try {
      await hub.init({
        port,
        isHub: true,
        isMultiWorker: true,
        expectedWorkerCount: 3,
        workerId: "hub-worker",
      });
      await peerA.init({
        port,
        isHub: false,
        isMultiWorker: true,
        expectedWorkerCount: 3,
        workerId: "duplicate-worker",
      });
      await peerB.init({
        port,
        isHub: false,
        isMultiWorker: true,
        expectedWorkerCount: 3,
        workerId: "duplicate-worker",
      });
      await vi.waitFor(() =>
        expect(
          peerA.getStatus().isConnectedToHub &&
            peerB.getStatus().isConnectedToHub,
        ).toBe(true),
      );
      expect(await peerA.publishConfirmed(releaseEvent(), 200)).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await close([peerA, peerB, hub]);
    }
  });
});

