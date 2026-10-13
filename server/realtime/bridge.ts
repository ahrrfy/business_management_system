import net from "node:net";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  REALTIME_BRIDGE_HOST,
  REALTIME_BRIDGE_PORT,
  REALTIME_EVENT_TYPES,
  createRealtimeEvent,
  type RealtimeEvent,
} from "@shared/realtimeEvents";
import { isBackgroundJobRunner, isMultiWorker } from "../lib/clusterRole";
import { logger } from "../logger";

export type BridgeMode = "hub" | "client" | "in_memory";

export interface BridgeOptions {
  host?: string;
  port?: number;
  inMemoryOnly?: boolean;
  isHub?: boolean;
  isMultiWorker?: boolean;
  workerId?: string;
  expectedWorkerCount?: number;
}

type ReleaseFrame = {
  kind:
    | "pwa-release-request"
    | "pwa-release-apply"
    | "pwa-release-ack"
    | "pwa-release-result";
  id: string;
  event?: RealtimeEvent;
  ok?: boolean;
  expectedWorkerCount?: number;
  expiresAt?: number;
};
type ReleaseHandler = (event: RealtimeEvent) => boolean | Promise<boolean>;

export interface BridgeStatus {
  mode: BridgeMode;
  connectedClients: number;
  isConnectedToHub: boolean;
  port: number;
  host: string;
  pendingOutbound?: number;
}

export class RealtimeBridgeManager {
  private mode: BridgeMode = "in_memory";
  private localEmitter = new EventEmitter();
  private server: net.Server | null = null;
  private clientSocket: net.Socket | null = null;
  private connectedSockets = new Set<net.Socket>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isStopping = false;
  private host = REALTIME_BRIDGE_HOST;
  private port = REALTIME_BRIDGE_PORT;
  private isConnectedToHub = false;
  private needsResync = false;
  private workerId = `w_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
  private pendingOutbound: string[] = [];
  private static readonly MAX_PENDING_OUTBOUND = 500;
  private expectedWorkerCount: number | null = null;
  private releaseHandler: ReleaseHandler | null = null;
  private releaseRequests = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: NodeJS.Timeout; expiresAt: number }
  >();
  private releaseBarriers = new Map<
    string,
    {
      requester: net.Socket | null;
      members: Set<net.Socket>;
      waiting: Set<net.Socket>;
      localComplete: boolean;
      timer: NodeJS.Timeout;
      expiresAt: number;
    }
  >();

  constructor() {
    this.localEmitter.setMaxListeners(200);
  }

  /**
   * تهيئة ناقل الحلقات الداخلي بين عمال PM2.
   * - إذا كان العامل هو المشغّل للوظائف الخلفية (عامل 0): ينشئ خادم TCP حلقي على 127.0.0.1:3009
   * - إذا كان عاملاً آخر ضمن العنقود (عامل 1..N): يتصل بالخادم الحلقي مع إعادة الاتصال التلقائي
   * - في بيئة التطوير الفردية (pnpm dev) أو عند تعذر الربط: يرجع تلقائياً لـ EventEmitter نقي بالذاكرة.
   */
  async init(options?: BridgeOptions): Promise<BridgeMode> {
    this.isStopping = false;
    this.host = options?.host ?? REALTIME_BRIDGE_HOST;
    this.port = options?.port ?? REALTIME_BRIDGE_PORT;
    if (options?.workerId) {
      this.workerId = options.workerId;
    }

    const forceInMemory = options?.inMemoryOnly ?? false;
    const multi = options?.isMultiWorker ?? isMultiWorker();
    const isHub = options?.isHub ?? isBackgroundJobRunner();
    const expected =
      options?.expectedWorkerCount ?? Number(process.env.WEB_INSTANCES);
    this.expectedWorkerCount =
      Number.isSafeInteger(expected) && expected > 0 ? expected : null;

    if (forceInMemory || !multi) {
      this.mode = "in_memory";
      logger.info(
        { mode: "in_memory" },
        "realtime_bridge.initialized_in_memory",
      );
      return this.mode;
    }

    if (isHub) {
      return this.startHub();
    } else {
      return this.startClient();
    }
  }

  private startHub(): Promise<BridgeMode> {
    return new Promise((resolve) => {
      const srv = net.createServer((socket) => {
        // تغير العضوية أثناء الحاجز يلغي الإثبات بدلاً من إسقاط العامل الجديد بصمت.
        for (const id of Array.from(this.releaseBarriers.keys()))
          this.finishReleaseBarrier(id, false);
        this.connectedSockets.add(socket);
        let buffer = "";

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed) as Partial<ReleaseFrame> & {
                originWorkerId?: string;
              };
              if (this.handleReleaseFrame(msg, socket, false)) continue;
              if (msg && msg.event) {
                // بث محلي لمشتركي هذا العامل
                this.localEmitter.emit("event", msg.event);

                // إعادة توجيه لكافة العمال المتصلين الآخرين (باستثناء المصدر)
                const payloadStr = JSON.stringify(msg) + "\n";
                this.connectedSockets.forEach((client) => {
                  if (client !== socket && !client.destroyed) {
                    try {
                      client.write(payloadStr);
                    } catch (err) {
                      logger.warn(
                        { err },
                        "realtime_bridge.hub.forward_write_error",
                      );
                    }
                  }
                });
              }
            } catch (err) {
              logger.warn({ err }, "realtime_bridge.hub.malformed_payload");
            }
          }
        });

        socket.on("error", (err) => {
          logger.warn({ err: err.message }, "realtime_bridge.hub.socket_error");
          this.connectedSockets.delete(socket);
          this.invalidateReleaseMember(socket);
        });

        socket.on("close", () => {
          this.connectedSockets.delete(socket);
          this.invalidateReleaseMember(socket);
        });
      });

      srv.on("error", (err: NodeJS.ErrnoException) => {
        logger.warn(
          { code: err.code, message: err.message },
          "realtime_bridge.hub.listen_error_fallback_to_in_memory",
        );
        this.mode = "in_memory";
        this.server = null;
        resolve("in_memory");
      });

      srv.listen(this.port, this.host, () => {
        this.mode = "hub";
        this.server = srv;
        logger.info(
          { host: this.host, port: this.port, mode: "hub" },
          "realtime_bridge.hub_started",
        );
        resolve("hub");
      });
    });
  }

  private startClient(): Promise<BridgeMode> {
    this.mode = "client";
    this.connectClientSocket();
    return Promise.resolve("client");
  }

  private connectClientSocket(): void {
    if (this.isStopping) return;

    const socket = net.createConnection(
      { host: this.host, port: this.port },
      () => {
        if (this.isStopping) {
          socket.destroy();
          return;
        }
        this.isConnectedToHub = true;
        logger.info(
          { host: this.host, port: this.port },
          "realtime_bridge.client_connected_to_hub",
        );
        this.flushPendingOutbound();
        // An SSE connection can survive a hub outage. Repair missed inbound events without polling.
        if (this.needsResync) {
          this.needsResync = false;
          this.publish(
            createRealtimeEvent(REALTIME_EVENT_TYPES.RESYNC_REQUIRED, {}),
          );
        }
      },
    );

    this.clientSocket = socket;

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as Partial<ReleaseFrame> & {
            originWorkerId?: string;
          };
          if (this.handleReleaseFrame(msg, socket, true)) continue;
          if (msg && msg.event) {
            // لا نعيد معالجة الحدث إذا كان هو نفس العامل الذي أطلقه
            if (msg.originWorkerId !== this.workerId) {
              this.localEmitter.emit("event", msg.event);
            }
          }
        } catch (err) {
          logger.warn({ err }, "realtime_bridge.client.malformed_payload");
        }
      }
    });

    socket.on("error", (err) => {
      this.needsResync = true;
      this.isConnectedToHub = false;
      this.clientSocket = null;
      for (const id of Array.from(this.releaseRequests.keys()))
        this.finishReleaseRequest(id, false);
      if (!this.isStopping) {
        this.scheduleClientReconnect();
      }
    });

    socket.on("close", () => {
      this.needsResync = true;
      this.isConnectedToHub = false;
      this.clientSocket = null;
      for (const id of Array.from(this.releaseRequests.keys()))
        this.finishReleaseRequest(id, false);
      if (!this.isStopping) {
        this.scheduleClientReconnect();
      }
    });
  }

  private flushPendingOutbound(): void {
    if (
      !this.clientSocket ||
      !this.isConnectedToHub ||
      this.pendingOutbound.length === 0
    )
      return;
    const toFlush = [...this.pendingOutbound];
    this.pendingOutbound = [];
    for (const msg of toFlush) {
      try {
        this.clientSocket.write(msg);
      } catch (err) {
        logger.warn({ err }, "realtime_bridge.client.flush_write_error");
        this.queuePendingMessage(msg);
        break;
      }
    }
  }

  private queuePendingMessage(msg: string): void {
    if (
      this.pendingOutbound.length >= RealtimeBridgeManager.MAX_PENDING_OUTBOUND
    ) {
      this.pendingOutbound.shift();
    }
    this.pendingOutbound.push(msg);
  }

  private scheduleClientReconnect(): void {
    if (this.reconnectTimer || this.isStopping) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectClientSocket();
    }, 1500);
  }

  /**
   * نشر حدث عبر الناقل الحلقي:
   * - في In-Memory: يرسل فوراً للمستمعين المحليين.
   * - في Hub: يرسل للمستمعين المحليين ويبثه لكل المقابس المتصلة بأمان.
   * - في Client: يرسل للمستمعين المحليين ويرسله عبر المقبس للـ Hub أو يخزنه مؤقتاً في طابور عند انقطاع الاتصال.
   */
  publish(event: RealtimeEvent): void {
    // إرسال محلي فوري
    this.localEmitter.emit("event", event);

    const message =
      JSON.stringify({ originWorkerId: this.workerId, event }) + "\n";

    if (this.mode === "hub" && this.server) {
      this.connectedSockets.forEach((socket) => {
        if (!socket.destroyed) {
          try {
            socket.write(message);
          } catch (err) {
            logger.warn({ err }, "realtime_bridge.hub.broadcast_write_error");
          }
        }
      });
    } else if (this.mode === "client") {
      if (this.clientSocket && this.isConnectedToHub) {
        try {
          this.clientSocket.write(message);
        } catch (err) {
          logger.warn({ err }, "realtime_bridge.client.publish_write_error");
          this.queuePendingMessage(message);
        }
      } else {
        this.queuePendingMessage(message);
      }
    }
  }

  /** مسار تحكم مستقل: الإقرار يصدر بعد تنفيذ الإغلاق، لا بعد socket.write. */
  setReleaseHandler(handler: ReleaseHandler): void {
    this.releaseHandler = handler;
  }

  publishConfirmed(event: RealtimeEvent, timeoutMs = 1_000): Promise<boolean> {
    if (!this.expectedWorkerCount || !this.releaseHandler || this.isStopping)
      return Promise.resolve(false);
    if (this.mode === "in_memory" && this.expectedWorkerCount !== 1)
      return Promise.resolve(false);
    if (
      this.mode === "client" &&
      (!this.isConnectedToHub ||
        !this.clientSocket ||
        this.clientSocket.destroyed)
    )
      return Promise.resolve(false);
    const id = randomUUID();
    const deadline = Math.max(1, Math.min(timeoutMs, 1_500));
    const expiresAt = Date.now() + deadline;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.finishReleaseRequest(id, false),
        deadline,
      );
      this.releaseRequests.set(id, { resolve, timer, expiresAt });
      if (this.mode === "in_memory") {
        void this.applyRelease(event).then((ok) =>
          this.finishReleaseRequest(id, ok),
        );
      } else if (this.mode === "hub") {
        this.startReleaseBarrier(
          id,
          event,
          null,
          expiresAt,
          this.expectedWorkerCount!,
        );
      } else if (
        !this.sendReleaseFrame(this.clientSocket!, {
          kind: "pwa-release-request",
          id,
          event,
          expiresAt,
          expectedWorkerCount: this.expectedWorkerCount!,
        })
      ) {
        this.finishReleaseRequest(id, false);
      }
    });
  }

  private async applyRelease(event: RealtimeEvent): Promise<boolean> {
    try {
      return (
        !!this.releaseHandler && (await this.releaseHandler(event)) === true
      );
    } catch (err) {
      logger.warn({ err }, "realtime_bridge.release_handler_failed");
      return false;
    }
  }

  private sendReleaseFrame(socket: net.Socket, frame: ReleaseFrame): boolean {
    if (socket.destroyed || !socket.writable) return false;
    try {
      socket.write(JSON.stringify(frame) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  private handleReleaseFrame(
    frame: Partial<ReleaseFrame>,
    socket: net.Socket,
    fromHub: boolean,
  ): boolean {
    if (
      typeof frame.kind !== "string" ||
      !frame.kind.startsWith("pwa-release-")
    )
      return false;
    if (typeof frame.id !== "string" || frame.id.length > 128) return true;
    const id = frame.id;
    if (fromHub && socket !== this.clientSocket) return true;
    if (frame.kind === "pwa-release-request" && !fromHub && frame.event) {
      this.startReleaseBarrier(
        id,
        frame.event,
        socket,
        frame.expiresAt ?? 0,
        frame.expectedWorkerCount ?? 0,
      );
    } else if (frame.kind === "pwa-release-apply" && fromHub && frame.event) {
      const valid =
        typeof frame.expiresAt === "number" &&
        frame.expiresAt > Date.now() &&
        frame.expectedWorkerCount === this.expectedWorkerCount;
      void (
        valid ? this.applyRelease(frame.event) : Promise.resolve(false)
      ).then((ok) => {
        this.sendReleaseFrame(socket, { kind: "pwa-release-ack", id, ok });
      });
    } else if (frame.kind === "pwa-release-ack" && !fromHub) {
      const barrier = this.releaseBarriers.get(id);
      if (barrier?.waiting.has(socket)) {
        if (frame.ok !== true) this.finishReleaseBarrier(id, false);
        else {
          barrier.waiting.delete(socket);
          this.completeReleaseBarrier(id);
        }
      }
    } else if (frame.kind === "pwa-release-result" && fromHub) {
      this.finishReleaseRequest(id, frame.ok === true);
    }
    return true;
  }

  private startReleaseBarrier(
    id: string,
    event: RealtimeEvent,
    requester: net.Socket | null,
    expiresAt: number,
    expectedWorkerCount: number,
  ): void {
    const members = new Set(
      Array.from(this.connectedSockets).filter(
        (socket) => !socket.destroyed && socket.writable,
      ),
    );
    const replyFailure = () => {
      if (requester)
        this.sendReleaseFrame(requester, {
          kind: "pwa-release-result",
          id,
          ok: false,
        });
      else this.finishReleaseRequest(id, false);
    };
    if (
      !this.releaseHandler ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expectedWorkerCount !== this.expectedWorkerCount ||
      this.expectedWorkerCount !== members.size + 1 ||
      (requester && !members.has(requester)) ||
      this.releaseBarriers.has(id)
    ) {
      replyFailure();
      return;
    }
    const timer = setTimeout(
      () => this.finishReleaseBarrier(id, false),
      Math.min(1_500, expiresAt - Date.now()),
    );
    this.releaseBarriers.set(id, {
      requester,
      members,
      waiting: new Set(members),
      localComplete: false,
      timer,
      expiresAt,
    });
    for (const socket of Array.from(members)) {
      if (
        !this.sendReleaseFrame(socket, {
          kind: "pwa-release-apply",
          id,
          event,
          expiresAt,
          expectedWorkerCount,
        })
      ) {
        this.finishReleaseBarrier(id, false);
        return;
      }
    }
    void this.applyRelease(event).then((ok) => {
      const barrier = this.releaseBarriers.get(id);
      if (!barrier) return;
      if (!ok) this.finishReleaseBarrier(id, false);
      else {
        barrier.localComplete = true;
        this.completeReleaseBarrier(id);
      }
    });
  }

  private completeReleaseBarrier(id: string): void {
    const barrier = this.releaseBarriers.get(id);
    if (barrier?.localComplete && barrier.waiting.size === 0)
      this.finishReleaseBarrier(id, true);
  }

  private finishReleaseBarrier(id: string, ok: boolean): void {
    const barrier = this.releaseBarriers.get(id);
    if (!barrier) return;
    clearTimeout(barrier.timer);
    this.releaseBarriers.delete(id);
    ok = ok && Date.now() < barrier.expiresAt;
    if (barrier.requester)
      this.sendReleaseFrame(barrier.requester, {
        kind: "pwa-release-result",
        id,
        ok,
      });
    else this.finishReleaseRequest(id, ok);
  }

  private finishReleaseRequest(id: string, ok: boolean): void {
    const pending = this.releaseRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.releaseRequests.delete(id);
    pending.resolve(ok && Date.now() < pending.expiresAt);
  }

  private invalidateReleaseMember(socket: net.Socket): void {
    for (const [id, barrier] of Array.from(this.releaseBarriers)) {
      if (barrier.members.has(socket)) this.finishReleaseBarrier(id, false);
    }
  }

  /**
   * تسجيل دالة استماع لأحداث الناقل.
   * تعيد دالة إلغاء الاشتراك.
   */
  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.localEmitter.on("event", listener);
    return () => {
      this.localEmitter.off("event", listener);
    };
  }

  /**
   * استعلام حالة الناقل الحلقي ومؤشرات الاتصال.
   */
  getStatus(): BridgeStatus {
    return {
      mode: this.mode,
      connectedClients: this.connectedSockets.size,
      isConnectedToHub: this.isConnectedToHub,
      port: this.port,
      host: this.host,
      pendingOutbound: this.pendingOutbound.length,
    };
  }

  /**
   * إيقاف وتشغيل الإغلاق النظيف لكافة المقابس والخوادم.
   */
  async stop(): Promise<void> {
    this.isStopping = true;
    for (const id of Array.from(this.releaseBarriers.keys()))
      this.finishReleaseBarrier(id, false);
    for (const id of Array.from(this.releaseRequests.keys()))
      this.finishReleaseRequest(id, false);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.pendingOutbound = [];

    if (this.clientSocket) {
      this.clientSocket.destroy();
      this.clientSocket = null;
      this.isConnectedToHub = false;
    }

    this.connectedSockets.forEach((socket) => {
      socket.destroy();
    });
    this.connectedSockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }

    this.mode = "in_memory";
    this.isStopping = false;
  }
}

export const realtimeBridge = new RealtimeBridgeManager();

export const initRealtimeBridge = (options?: BridgeOptions) =>
  realtimeBridge.init(options);
export const publishToBridge = (event: RealtimeEvent) =>
  realtimeBridge.publish(event);
export const publishToBridgeConfirmed = (event: RealtimeEvent) =>
  realtimeBridge.publishConfirmed(event);
export const setBridgeReleaseHandler = (handler: ReleaseHandler) =>
  realtimeBridge.setReleaseHandler(handler);
export const onBridgeEvent = (listener: (event: RealtimeEvent) => void) =>
  realtimeBridge.subscribe(listener);
export const stopRealtimeBridge = () => realtimeBridge.stop();
export const getBridgeStatus = () => realtimeBridge.getStatus();
