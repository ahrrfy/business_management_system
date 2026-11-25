import net from "node:net";
import { EventEmitter } from "node:events";
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import {
  REALTIME_BRIDGE_HOST,
  REALTIME_BRIDGE_PORT,
  REALTIME_EVENT_TYPES,
  createRealtimeEvent,
  type RealtimeEvent,
} from "@shared/realtimeEvents";
import {
  isBackgroundJobRunner,
  isClustered,
  isMultiWorker,
  webRuntimeRole,
  runtimeWorkerCounts,
} from "../lib/clusterRole";
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
  /** سر مصادقة HMAC للإطارات الداخلية (يُشتق تلقائياً من JWT_SECRET خارج بيئة الاختبار الخام). */
  secret?: string;
}

type ReleaseFrame = {
  kind:
    | "work-drain-request"
    | "work-drain-ack"
    | "pwa-release-hello"
    | "pwa-release-request"
    | "pwa-release-apply"
    | "pwa-release-ack"
    | "pwa-release-result";
  id: string;
  workerId?: string;
  event?: RealtimeEvent;
  ok?: boolean;
  expectedWorkerCount?: number;
  expiresAt?: number;
  capabilities?: string[];
};
type ReleaseHandler = (event: RealtimeEvent) => boolean | Promise<boolean>;

export interface BridgeStatus {
  mode: BridgeMode;
  connectedClients: number;
  isConnectedToHub: boolean;
  port: number;
  host: string;
  pendingOutbound?: number;
  workerId: string;
  expectedWorkerCount: number | null;
  memberIds: string[];
}

export class RealtimeBridgeManager {
  private mode: BridgeMode = "in_memory";
  private localEmitter = new EventEmitter();
  private server: net.Server | null = null;
  private clientSocket: net.Socket | null = null;
  private connectedSockets = new Set<net.Socket>();
  private socketWorkerIds = new Map<net.Socket, string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hubRetryTimer: NodeJS.Timeout | null = null;
  private isStopping = false;
  private host = REALTIME_BRIDGE_HOST;
  private port = REALTIME_BRIDGE_PORT;
  private isConnectedToHub = false;
  private needsResync = false;
  private workerId = `w_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
  private pendingOutbound: Array<Record<string, unknown>> = [];
  private static readonly MAX_PENDING_OUTBOUND = 500;
  private expectedWorkerCount: number | null = null;
  private requireSharedBridge = false;
  private authKey: Buffer | null = null;
  private seenNonces = new Map<string, number>();
  private static readonly MAX_SEEN_NONCES = 4096;
  private static readonly MAX_FRAME_DRIFT_MS = 60_000;
  private static readonly UNAUTH_SOCKET_TIMEOUT_MS = 3_000;
  private drainAcks = new Map<string, { socket: net.Socket; resolve: () => void }>();
  private drainCapableSockets = new WeakSet<net.Socket>();
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
    if (this.hubRetryTimer) {
      clearTimeout(this.hubRetryTimer);
      this.hubRetryTimer = null;
    }
    this.host = options?.host ?? REALTIME_BRIDGE_HOST;
    this.port = options?.port ?? REALTIME_BRIDGE_PORT;
    const rawSecret =
      options?.secret !== undefined
        ? options.secret.trim()
        : process.env.NODE_ENV === "test"
          ? ""
          : process.env.REALTIME_BRIDGE_SECRET?.trim() ||
            process.env.INTERNAL_PROXY_SECRET?.trim() ||
            process.env.JWT_SECRET?.trim() ||
            "";
    this.authKey = rawSecret
      ? Buffer.from(hkdfSync("sha256", rawSecret, "", "alroya:realtime-bridge:v1", 32))
      : null;
    this.seenNonces.clear();
    if (options?.workerId) {
      this.workerId = options.workerId;
    } else {
      this.workerId = `${webRuntimeRole()}:${process.env.NODE_APP_INSTANCE ?? "fork"}:${randomUUID()}`;
    }

    this.requireSharedBridge = webRuntimeRole() !== "legacy";
    if (this.requireSharedBridge) runtimeWorkerCounts();

    const forceInMemory = options?.inMemoryOnly ?? false;
    const multi = options?.isMultiWorker ?? isMultiWorker();
    const isHub = options?.isHub ?? isBackgroundJobRunner();
    if (this.requireSharedBridge && (forceInMemory || !multi || isHub !== isBackgroundJobRunner()))
      throw new Error("Split runtime requires the shared admin hub and process-role bridge membership");
    const expected =
      options?.expectedWorkerCount ??
      (process.env.WEB_INSTANCES
        ? Number(process.env.WEB_INSTANCES)
        : !forceInMemory && !multi && !isClustered()
          ? 1
          : NaN);
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

  private serializeBridgeFrame(payload: Record<string, unknown>): string {
    const { _ts: _ignoreTs, _nonce: _ignoreNonce, _sig: _ignoreSig, ...clean } = payload;
    if (!this.authKey) {
      return JSON.stringify(clean) + "\n";
    }
    const coreJson = JSON.stringify(clean);
    const _ts = Date.now();
    const _nonce = randomUUID();
    const _sig = createHmac("sha256", this.authKey)
      .update(`${_ts}:${_nonce}:${coreJson}`)
      .digest("hex");
    return JSON.stringify({ ...clean, _ts, _nonce, _sig }) + "\n";
  }

  private verifyAndUnwrapBridgeFrame(
    parsed: unknown,
  ): (Partial<ReleaseFrame> & { originWorkerId?: string }) | null {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const { _ts, _nonce, _sig, ...clean } = raw;
    if (!this.authKey) {
      return clean as Partial<ReleaseFrame> & { originWorkerId?: string };
    }
    if (
      typeof _ts !== "number" ||
      !Number.isFinite(_ts) ||
      Math.abs(Date.now() - _ts) > RealtimeBridgeManager.MAX_FRAME_DRIFT_MS ||
      typeof _nonce !== "string" ||
      _nonce.length < 8 ||
      _nonce.length > 128 ||
      typeof _sig !== "string" ||
      _sig.length !== 64
    ) {
      return null;
    }
    const now = Date.now();
    const prevSeen = this.seenNonces.get(_nonce);
    if (prevSeen !== undefined && now - prevSeen <= RealtimeBridgeManager.MAX_FRAME_DRIFT_MS) {
      return null;
    }
    const coreJson = JSON.stringify(clean);
    const expectedSig = createHmac("sha256", this.authKey)
      .update(`${_ts}:${_nonce}:${coreJson}`)
      .digest("hex");
    const sigBuf = Buffer.from(_sig, "utf8");
    const expBuf = Buffer.from(expectedSig, "utf8");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    if (this.seenNonces.size >= RealtimeBridgeManager.MAX_SEEN_NONCES) {
      const oldestKey = this.seenNonces.keys().next().value;
      if (oldestKey !== undefined) this.seenNonces.delete(oldestKey);
    }
    this.seenNonces.set(_nonce, now);
    return clean as Partial<ReleaseFrame> & { originWorkerId?: string };
  }

  private startHub(): Promise<BridgeMode> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => {
        let authenticated = this.authKey === null;
        let authTimer: NodeJS.Timeout | null = null;

        const admitAuthenticatedSocket = () => {
          if (authenticated) return;
          authenticated = true;
          if (authTimer) {
            clearTimeout(authTimer);
            authTimer = null;
          }
          // تغير العضوية أثناء الحاجز يلغي الإثبات بدلاً من إسقاط العامل الجديد بصمت.
          for (const id of Array.from(this.releaseBarriers.keys()))
            this.finishReleaseBarrier(id, false);
          this.connectedSockets.add(socket);
        };

        if (authenticated) {
          for (const id of Array.from(this.releaseBarriers.keys()))
            this.finishReleaseBarrier(id, false);
          this.connectedSockets.add(socket);
        } else {
          authTimer = setTimeout(() => {
            if (!authenticated && !socket.destroyed) {
              logger.warn("realtime_bridge.hub.unauthenticated_socket_timeout");
              socket.destroy();
            }
          }, RealtimeBridgeManager.UNAUTH_SOCKET_TIMEOUT_MS);
          if (typeof authTimer.unref === "function") authTimer.unref();
        }

        let buffer = "";

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (!authenticated && buffer.length > 65_536) {
            logger.warn("realtime_bridge.hub.unauthenticated_buffer_overflow");
            socket.destroy();
            return;
          }
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const rawParsed = JSON.parse(trimmed);
              const msg = this.verifyAndUnwrapBridgeFrame(rawParsed);
              if (!msg) {
                logger.warn("realtime_bridge.hub.unauthorized_frame_rejected");
                socket.destroy();
                return;
              }
              admitAuthenticatedSocket();
              if (this.handleDrainFrame(msg, socket)) continue;
              if (this.handleReleaseFrame(msg, socket, false)) continue;
              if (msg && msg.event) {
                // بث محلي لمشتركي هذا العامل
                this.localEmitter.emit("event", msg.event);

                // إعادة توجيه لكافة العمال المتصلين الآخرين (باستثناء المصدر)
                const payloadStr = this.serializeBridgeFrame(msg as Record<string, unknown>);
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
              if (!authenticated) {
                socket.destroy();
                return;
              }
            }
          }
        });

        socket.on("error", (err) => {
          if (authTimer) {
            clearTimeout(authTimer);
            authTimer = null;
          }
          logger.warn({ err: err.message }, "realtime_bridge.hub.socket_error");
          if (authenticated) {
            this.connectedSockets.delete(socket);
            this.socketWorkerIds.delete(socket);
            this.invalidateReleaseMember(socket);
          }
        });

        socket.on("close", () => {
          if (authTimer) {
            clearTimeout(authTimer);
            authTimer = null;
          }
          if (authenticated) {
            this.connectedSockets.delete(socket);
            this.socketWorkerIds.delete(socket);
            this.invalidateReleaseMember(socket);
          }
        });
      });

      srv.on("error", (err: NodeJS.ErrnoException) => {
        if (this.requireSharedBridge) {
          this.server = null;
          reject(new Error(`Split realtime hub unavailable: ${err.code}`));
          return;
        }
        logger.warn(
          { code: err.code, message: err.message },
          "realtime_bridge.hub.listen_error_fallback_to_in_memory",
        );
        this.mode = "in_memory";
        this.server = null;
        if (err.code === "EADDRINUSE" && !this.isStopping) {
          this.scheduleHubRetry();
        }
        resolve("in_memory");
      });

      srv.listen(this.port, this.host, () => {
        if (this.hubRetryTimer) {
          clearTimeout(this.hubRetryTimer);
          this.hubRetryTimer = null;
        }
        if (this.isStopping) {
          srv.close();
          resolve("in_memory");
          return;
        }
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

  private scheduleHubRetry(): void {
    if (this.hubRetryTimer || this.isStopping) return;
    this.hubRetryTimer = setTimeout(() => {
      this.hubRetryTimer = null;
      if (!this.isStopping && this.mode === "in_memory" && !this.server) {
        void this.startHub();
      }
    }, 1500);
    if (typeof this.hubRetryTimer.unref === "function") {
      this.hubRetryTimer.unref();
    }
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
        this.sendReleaseFrame(socket, {
          kind: "pwa-release-hello",
          id: this.workerId,
          workerId: this.workerId,
          capabilities: ["work-drain-ack-v1"],
        });
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
          const rawParsed = JSON.parse(trimmed);
          const msg = this.verifyAndUnwrapBridgeFrame(rawParsed);
          if (!msg) {
            logger.warn("realtime_bridge.client.unauthorized_frame_rejected");
            socket.destroy();
            return;
          }
          if (this.handleDrainFrame(msg, socket)) continue;
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

    socket.on("error", () => {
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
    for (let index = 0; index < toFlush.length; index++) {
      const payload = toFlush[index];
      try {
        this.clientSocket.write(this.serializeBridgeFrame(payload));
      } catch (err) {
        logger.warn({ err }, "realtime_bridge.client.flush_write_error");
        for (const unsent of toFlush.slice(index)) this.queuePendingMessage(unsent);
        break;
      }
    }
  }

  private queuePendingMessage(payload: Record<string, unknown>): void {
    if (
      this.pendingOutbound.length >= RealtimeBridgeManager.MAX_PENDING_OUTBOUND
    ) {
      this.pendingOutbound.shift();
    }
    this.pendingOutbound.push(payload);
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

    const payload: Record<string, unknown> = {
      originWorkerId: this.workerId,
      event,
    };

    if (this.mode === "hub" && this.server) {
      const message = this.serializeBridgeFrame(payload);
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
          this.clientSocket.write(this.serializeBridgeFrame(payload));
        } catch (err) {
          logger.warn({ err }, "realtime_bridge.client.publish_write_error");
          this.queuePendingMessage(payload);
        }
      } else {
        this.queuePendingMessage(payload);
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
          workerId: this.workerId,
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
      socket.write(this.serializeBridgeFrame(frame as unknown as Record<string, unknown>));
      return true;
    } catch {
      return false;
    }
  }

  private registerSocketWorkerId(
    socket: net.Socket,
    rawWorkerId: unknown,
  ): boolean {
    if (typeof rawWorkerId !== "string") return false;
    const workerId = rawWorkerId.trim();
    if (!workerId || workerId.length > 128) return false;
    const existing = this.socketWorkerIds.get(socket);
    if (existing && existing !== workerId) return false;
    this.socketWorkerIds.set(socket, workerId);
    return true;
  }

  private hasDistinctMemberIdentities(members: Set<net.Socket>): boolean {
    const seen = new Set<string>([this.workerId]);
    for (const socket of Array.from(members)) {
      const workerId = this.socketWorkerIds.get(socket);
      if (!workerId || seen.has(workerId)) {
        return false;
      }
      seen.add(workerId);
    }
    return true;
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
    if (frame.kind === "pwa-release-hello") {
      if (Array.isArray(frame.capabilities) && frame.capabilities.includes("work-drain-ack-v1"))
        this.drainCapableSockets.add(socket);
      if (!fromHub && this.registerSocketWorkerId(socket, frame.workerId ?? frame.id))
        this.sendReleaseFrame(socket, {
          kind: "pwa-release-hello",
          id: this.workerId,
          workerId: this.workerId,
          capabilities: ["work-drain-ack-v1"],
        });
      return true;
    }
    if (frame.kind === "pwa-release-request" && !fromHub && frame.event) {
      if (
        frame.workerId !== undefined &&
        !this.registerSocketWorkerId(socket, frame.workerId)
      ) {
        this.sendReleaseFrame(socket, {
          kind: "pwa-release-result",
          id,
          ok: false,
        });
        return true;
      }
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
        this.sendReleaseFrame(socket, {
          kind: "pwa-release-ack",
          id,
          workerId: this.workerId,
          ok,
        });
      });
    } else if (frame.kind === "pwa-release-ack" && !fromHub) {
      const barrier = this.releaseBarriers.get(id);
      if (barrier?.waiting.has(socket)) {
        const expectedWorkerId = this.socketWorkerIds.get(socket);
        const workerIdMatches =
          !frame.workerId ||
          (!!expectedWorkerId && frame.workerId.trim() === expectedWorkerId);
        if (frame.ok !== true || !workerIdMatches)
          this.finishReleaseBarrier(id, false);
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
      !this.hasDistinctMemberIdentities(members) ||
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
      workerId: this.workerId,
      expectedWorkerCount: this.expectedWorkerCount,
      memberIds: [this.workerId, ...Array.from(this.socketWorkerIds.values())],
    };
  }

  /**
   * إيقاف وتشغيل الإغلاق النظيف لكافة المقابس والخوادم.
   */
  private handleDrainFrame(frame: Partial<ReleaseFrame>, socket: net.Socket): boolean {
    if (frame.kind === "work-drain-request" && typeof frame.id === "string") {
      // TCP order means preceding events already reached this peer's listeners.
      socket.write(this.serializeBridgeFrame({ kind: "work-drain-ack", id: frame.id }));
      return true;
    }
    if (frame.kind === "work-drain-ack" && typeof frame.id === "string") {
      const pending = this.drainAcks.get(frame.id);
      if (pending?.socket === socket) pending.resolve();
      return true;
    }
    return false;
  }

  /**
   * Split always requires the connected peer's ACK. Legacy pre-ACK peers keep
   * best-effort semantics: flush TCP and complete its close handshake, without
   * claiming delivery confirmation. Neither policy is durable outage delivery.
   */
  async drain(timeoutMs = 5_000): Promise<void> {
    if (this.mode === "in_memory") return;
    if (this.mode === "client" && (!this.clientSocket || !this.isConnectedToHub)) {
      if (this.isStopping && !this.requireSharedBridge && this.pendingOutbound.length === 0) {
        return;
      }
      throw new Error("Realtime bridge drain unavailable: client disconnected");
    }
    this.flushPendingOutbound();
    if (this.pendingOutbound.length) throw new Error("Realtime bridge drain has unsent events");
    const sockets = this.mode === "client" ? [this.clientSocket!] : Array.from(this.connectedSockets);
    await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => {
      const requireAck = this.requireSharedBridge || this.drainCapableSockets.has(socket);
      const id = randomUUID();
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.off("close", closed); socket.off("error", failed);
        this.drainAcks.delete(id);
        if (error) reject(error); else resolve();
      };
      const closed = (hadError: boolean) => {
        if (!requireAck && !hadError && socket.writableFinished) finish();
        else finish(new Error("Realtime bridge drain disconnected"));
      };
      const failed = () => finish(new Error("Realtime bridge drain socket error"));
      const timer = setTimeout(() => finish(new Error("Realtime bridge drain deadline exceeded")), timeoutMs);
      if (requireAck) this.drainAcks.set(id, { socket, resolve: () => finish() });
      socket.once("close", closed); socket.once("error", failed);
      if (socket.destroyed) { finish(new Error("Realtime bridge drain disconnected")); return; }
      if (requireAck)
        socket.write(this.serializeBridgeFrame({ kind: "work-drain-request", id }), error => { if (error) failed(); });
      else
        socket.end();
    })));
  }

  async stop(options?: { drain?: boolean; timeoutMs?: number }): Promise<void> {
    this.isStopping = true;
    if (options?.drain) await this.drain(options.timeoutMs);
    for (const id of Array.from(this.releaseBarriers.keys()))
      this.finishReleaseBarrier(id, false);
    for (const id of Array.from(this.releaseRequests.keys()))
      this.finishReleaseRequest(id, false);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.hubRetryTimer) {
      clearTimeout(this.hubRetryTimer);
      this.hubRetryTimer = null;
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
    this.socketWorkerIds.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }

    this.mode = "in_memory";
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
export const stopRealtimeBridge = (options?: { drain?: boolean; timeoutMs?: number }) => realtimeBridge.stop(options);
export const getBridgeStatus = () => realtimeBridge.getStatus();
