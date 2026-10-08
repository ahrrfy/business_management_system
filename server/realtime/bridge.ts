import net from "node:net";
import { EventEmitter } from "node:events";
import {
  REALTIME_BRIDGE_HOST,
  REALTIME_BRIDGE_PORT,
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
}

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
  private workerId = `w_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
  private pendingOutbound: string[] = [];
  private static readonly MAX_PENDING_OUTBOUND = 500;

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

    if (forceInMemory || !multi) {
      this.mode = "in_memory";
      logger.info({ mode: "in_memory" }, "realtime_bridge.initialized_in_memory");
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
              const msg = JSON.parse(trimmed) as { originWorkerId?: string; event: RealtimeEvent };
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
                      logger.warn({ err }, "realtime_bridge.hub.forward_write_error");
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
        });

        socket.on("close", () => {
          this.connectedSockets.delete(socket);
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

    const socket = net.createConnection({ host: this.host, port: this.port }, () => {
      if (this.isStopping) {
        socket.destroy();
        return;
      }
      this.isConnectedToHub = true;
      logger.info({ host: this.host, port: this.port }, "realtime_bridge.client_connected_to_hub");
      this.flushPendingOutbound();
    });

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
          const msg = JSON.parse(trimmed) as { originWorkerId?: string; event: RealtimeEvent };
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
      this.isConnectedToHub = false;
      this.clientSocket = null;
      if (!this.isStopping) {
        this.scheduleClientReconnect();
      }
    });

    socket.on("close", () => {
      this.isConnectedToHub = false;
      this.clientSocket = null;
      if (!this.isStopping) {
        this.scheduleClientReconnect();
      }
    });
  }

  private flushPendingOutbound(): void {
    if (!this.clientSocket || !this.isConnectedToHub || this.pendingOutbound.length === 0) return;
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
    if (this.pendingOutbound.length >= RealtimeBridgeManager.MAX_PENDING_OUTBOUND) {
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

    const message = JSON.stringify({ originWorkerId: this.workerId, event }) + "\n";

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

export const initRealtimeBridge = (options?: BridgeOptions) => realtimeBridge.init(options);
export const publishToBridge = (event: RealtimeEvent) => realtimeBridge.publish(event);
export const onBridgeEvent = (listener: (event: RealtimeEvent) => void) =>
  realtimeBridge.subscribe(listener);
export const stopRealtimeBridge = () => realtimeBridge.stop();
export const getBridgeStatus = () => realtimeBridge.getStatus();
