import {
  REALTIME_BROADCAST_CHANNEL,
  REALTIME_IDLE_TIMEOUT_MS,
  REALTIME_EVENT_TYPES,
  type RealtimeEvent,
  type RealtimeEventType,
  type BatchSalesSyncedPayload,
} from "@shared/realtimeEvents";
import { connectivity, type ConnState } from "../offline/connectivity";

export type RealtimeConnectionStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "offline"
  | "idle_disconnected";

export interface RealtimeMessageBusPayload {
  type: "REALTIME_EVENT" | "LEADER_HEARTBEAT" | "LEADER_CLAIM" | "LEADER_RESIGN";
  tabId: string;
  timestamp: number;
  event?: RealtimeEvent;
}

export class RealtimeManager {
  private tabId: string;
  private channel: BroadcastChannel | null = null;
  private eventSource: EventSource | null = null;
  private isLeader = false;
  private status: RealtimeConnectionStatus = "disconnected";
  private listeners = new Map<string, Set<(event: RealtimeEvent) => void>>();
  private statusListeners = new Set<(status: RealtimeConnectionStatus) => void>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaderWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastLeaderHeartbeat = 0;
  private lockAbortController: AbortController | null = null;
  private isLockAcquiring = false;
  private isStarted = false;
  private connectivityUnsubscribe: (() => void) | null = null;
  private appState: "active" | "background" | "inactive" = "active";
  private batchSalesTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBatchSales: BatchSalesSyncedPayload | null = null;
  private pendingBatchScope?: RealtimeEvent["scope"];

  constructor(tabId?: string) {
    this.tabId =
      tabId ?? `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * بدء تشغيل مدير اللحظية، وتأسيس قناة BroadcastChannel وتنسيق التبويب القائد.
   */
  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;

    // 1. إنشاء ناقل التبويبات المتعددة عبر BroadcastChannel
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.channel = new BroadcastChannel(REALTIME_BROADCAST_CHANNEL);
        this.channel.onmessage = (ev: MessageEvent<RealtimeMessageBusPayload>) => {
          this.handleBusMessage(ev.data);
        };
      } catch {
        this.channel = null;
      }
    }

    // 2. مراقبة حالة الاتصال بالشبكة عبر ConnectivityMachine
    this.connectivityUnsubscribe = connectivity.subscribe((connState: ConnState) => {
      this.handleConnectivityChange(connState);
    });

    // 3. مراقبة خمول التبويب (15 دقيقة في الخلفية)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      if (document.visibilityState === "hidden") {
        this.armIdleTimer();
      }
    }

    // 4. إطلاق انتخاب التبويب القائد (Leader Election)
    this.initiateLeaderElection();
  }

  /**
   * معالجة الرسائل الواردة عبر ناقل التبويبات BroadcastChannel
   */
  private handleBusMessage(data: RealtimeMessageBusPayload): void {
    if (!data || data.tabId === this.tabId) return;

    switch (data.type) {
      case "REALTIME_EVENT":
        if (data.event) {
          this.dispatchLocalEvent(data.event);
        }
        break;

      case "LEADER_HEARTBEAT":
        this.lastLeaderHeartbeat = Date.now();
        if (this.isLeader && data.tabId < this.tabId) {
          // تنازع قيادة: التبويب ذو المعرف الأصغر يتولى القيادة تجنباً للازدواج
          this.stepDownFromLeader("conflict_resolution");
        }
        break;

      case "LEADER_RESIGN":
        this.lastLeaderHeartbeat = 0;
        if (!this.isLeader && this.status !== "idle_disconnected" && this.status !== "offline") {
          this.claimLeadership();
        }
        break;

      case "LEADER_CLAIM":
        this.lastLeaderHeartbeat = Date.now();
        if (this.isLeader && data.tabId < this.tabId) {
          this.stepDownFromLeader("usurped");
        }
        break;
    }
  }

  /**
   * خوارزمية انتخاب التبويب القائد:
   * تعتمد navigator.locks إن وُجدت كمعيار حديث أصيل يمنع السباق 100%،
   * وتسقط بسلاسة لخوارزمية النبضات التنافسية (Heartbeat Election) عند غياب الـ API.
   */
  private initiateLeaderElection(): void {
    if (this.isLeader || this.status === "idle_disconnected" || this.status === "offline") {
      return;
    }

    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      if (this.isLockAcquiring) return;
      this.isLockAcquiring = true;
      this.lockAbortController = new AbortController();
      navigator.locks
        .request(
          "alroya_realtime_bus_leader",
          { signal: this.lockAbortController.signal },
          async () => {
            this.isLockAcquiring = false;
            await this.becomeLeader();
            return new Promise<void>((resolve) => {
              // يبقى القفل محجوزاً حتى يستقيل التبويب أو يُغلق
              this.stepDownResolver = resolve;
            });
          },
        )
        .catch(() => {
          this.isLockAcquiring = false;
        });
    } else {
      // بديل النبضات الدورية للتنسيق بين التبويبات
      this.startHeartbeatWatchdog();
    }
  }

  private stepDownResolver: (() => void) | null = null;

  private async becomeLeader(): Promise<void> {
    if (!this.isStarted || this.status === "idle_disconnected" || this.status === "offline") {
      return;
    }

    this.isLeader = true;
    this.postBusMessage({
      type: "LEADER_CLAIM",
      tabId: this.tabId,
      timestamp: Date.now(),
    });

    // إرسال نبضات دورية لإعلام التبويبات الأخرى
    this.leaderHeartbeatTimer = setInterval(() => {
      this.postBusMessage({
        type: "LEADER_HEARTBEAT",
        tabId: this.tabId,
        timestamp: Date.now(),
      });
    }, 2000);

    // فتح مقبس الـ SSE الفردي للجهاز كاملاً
    this.connectEventSource();
  }

  private stepDownFromLeader(reason?: string): void {
    if (!this.isLeader) return;
    this.isLeader = false;
    this.isLockAcquiring = false;

    if (this.leaderHeartbeatTimer) {
      clearInterval(this.leaderHeartbeatTimer);
      this.leaderHeartbeatTimer = null;
    }

    this.closeEventSource();

    if (reason !== "conflict_resolution" && reason !== "usurped") {
      this.postBusMessage({
        type: "LEADER_RESIGN",
        tabId: this.tabId,
        timestamp: Date.now(),
      });
    }

    if (this.stepDownResolver) {
      this.stepDownResolver();
      this.stepDownResolver = null;
    }

    if (reason !== "idle_timeout") {
      this.setStatus("disconnected");
    }
  }

  private claimLeadership(): void {
    if (this.isLeader || this.status === "idle_disconnected" || this.status === "offline") {
      return;
    }
    this.becomeLeader();
  }

  private startHeartbeatWatchdog(): void {
    // التحقق الدوري كل ثانيتين: إذا غاب نبض القائد لأكثر من 4 ثوانٍ، يترشح هذا التبويب
    this.leaderWatchdogTimer = setInterval(() => {
      if (this.isLeader) return;
      const now = Date.now();
      if (now - this.lastLeaderHeartbeat > 4000) {
        this.claimLeadership();
      }
    }, 2000);
  }

  private shouldConnect(): boolean {
    if (typeof window === "undefined") return false;
    const path = window.location.pathname;
    if (path === "/login" || path === "/apply" || path === "/legal") {
      return false;
    }
    return true;
  }

  /**
   * إنشاء اتصال Server-Sent Events على التبويب القائد فقط.
   */
  private connectEventSource(): void {
    if (
      !this.isLeader ||
      this.status === "offline" ||
      this.status === "idle_disconnected" ||
      !this.shouldConnect()
    ) {
      return;
    }

    this.closeEventSource();
    this.setStatus("connecting");

    try {
      const url = "/api/realtime/stream";
      const es = new EventSource(url, { withCredentials: true });
      this.eventSource = es;

      es.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus("connected");
      };

      es.onmessage = (event) => {
        try {
          const raw = JSON.parse(event.data) as unknown;
          // إذا كان الحدث بتنسيق RealtimeEvent
          const rtEvent: RealtimeEvent = {
            id: event.lastEventId || `sse_${Date.now()}`,
            type: (event as any).type || "message",
            payload: raw,
            timestamp: Date.now(),
          };
          this.onReceiveServerEvent(rtEvent);
        } catch {
          // استلام رسالة خام
        }
      };

      // الاستماع لكافة أنواع الأحداث المخصصة المسجلة
      this.registerEventSourceListeners(es);

      es.onerror = () => {
        this.closeEventSource();
        this.setStatus("disconnected");
        this.scheduleReconnect();
      };
    } catch {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  private registerEventSourceListeners(es: EventSource): void {
    const allKnownTypes = new Set<string>(Object.values(REALTIME_EVENT_TYPES));
    this.listeners.forEach((_, key) => {
      if (key !== "*") {
        allKnownTypes.add(key);
      }
    });

    allKnownTypes.forEach((type) => {
      this.attachEventSourceListener(es, type);
    });
  }

  private attachEventSourceListener(es: EventSource, type: string): void {
    es.addEventListener(type, (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const rtEvent: RealtimeEvent = {
          id: event.lastEventId || `sse_${Date.now()}`,
          type,
          payload,
          timestamp: Date.now(),
        };
        this.onReceiveServerEvent(rtEvent);
      } catch {
        // تجاهل الأخطاء العابرة
      }
    });
  }

  private closeEventSource(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * استلام حدث خادمي على التبويب القائد:
   * 1. توزيعه محلياً لمستمعي هذا التبويب.
   * 2. بثه عبر BroadcastChannel لكافة التبويبات الأخرى المفتوحة على نفس الجهاز.
   */
  private onReceiveServerEvent(event: RealtimeEvent): void {
    this.dispatchLocalEvent(event);

    this.postBusMessage({
      type: "REALTIME_EVENT",
      tabId: this.tabId,
      timestamp: Date.now(),
      event,
    });
  }

  private postBusMessage(payload: RealtimeMessageBusPayload): void {
    try {
      this.channel?.postMessage(payload);
    } catch {
      // تجاهل
    }
  }

  /**
   * توزيع الحدث لمستمعي هذا التبويب مع تجميع وتخفيف أحداث المزامنة المجمعة (Batch Coalescing).
   */
  private dispatchLocalEvent(event: RealtimeEvent): void {
    if (event.type === REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED) {
      this.coalesceBatchSales(event as RealtimeEvent<BatchSalesSyncedPayload>);
      return;
    }
    this.dispatchLocalEventDirect(event);
  }

  private dispatchLocalEventDirect(event: RealtimeEvent): void {
    const specific = this.listeners.get(event.type);
    if (specific) {
      specific.forEach((listener) => {
        try {
          listener(event);
        } catch {
          // عدم تعطيل بقية المستمعين
        }
      });
    }

    const catchAll = this.listeners.get("*");
    if (catchAll) {
      catchAll.forEach((listener) => {
        try {
          listener(event);
        } catch {
          // عدم تعطيل بقية المستمعين
        }
      });
    }
  }

  private coalesceBatchSales(event: RealtimeEvent<BatchSalesSyncedPayload>): void {
    const p = event.payload;
    if (!this.pendingBatchSales) {
      this.pendingBatchSales = { ...p };
      this.pendingBatchScope = event.scope;
    } else {
      this.pendingBatchSales.syncedCount += p.syncedCount;
      const curTotal = parseFloat(this.pendingBatchSales.totalAmount || "0");
      const addTotal = parseFloat(p.totalAmount || "0");
      this.pendingBatchSales.totalAmount = (curTotal + addTotal).toFixed(2);
      this.pendingBatchSales.timestamp = Math.max(this.pendingBatchSales.timestamp, p.timestamp);
    }

    if (!this.batchSalesTimer) {
      this.batchSalesTimer = setTimeout(() => {
        this.batchSalesTimer = null;
        if (this.pendingBatchSales) {
          const payload = this.pendingBatchSales;
          const scope = this.pendingBatchScope;
          this.pendingBatchSales = null;
          this.pendingBatchScope = undefined;
          this.dispatchLocalEventDirect({
            id: `coalesced_${Date.now()}`,
            type: REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
            payload,
            timestamp: Date.now(),
            scope,
          });
        }
      }, 250);
    }
  }

  /**
   * جدولة إعادة الاتصال بتراجع أسي مع عشوائية (Exponential Backoff with Jitter)
   * لمنع تدافع الأجهزة (Anti-Thundering Herd) عند إعادة تشغيل الخادم.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.isLeader || !this.isStarted) return;
    if (this.status === "offline" || this.status === "idle_disconnected") return;

    this.reconnectAttempts++;
    const base = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    const jitter = Math.random() * 2000;
    const delay = base + jitter;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isLeader && this.status !== "offline" && this.status !== "idle_disconnected") {
        this.connectEventSource();
      }
    }, delay);
  }

  /**
   * معالجة تغير حالة الاتصال من خلال ConnectivityMachine
   */
  private handleConnectivityChange(connState: ConnState): void {
    if (connState === "offline") {
      this.setStatus("offline");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.closeEventSource();
    } else if (connState === "online") {
      if (this.status === "offline") {
        this.setStatus("disconnected");
        this.reconnectAttempts = 0;
        if (this.isLeader) {
          this.connectEventSource();
        } else {
          this.initiateLeaderElection();
        }
      }
    }
  }

  /**
   * معالجة خمول التبويب (Page Visibility API):
   * بعد 15 دقيقة من البقاء في الخلفية، يُقطع الاتصال لتوفير الموارد وبطاريات الأجهزة المحمولة.
   */
  private handleVisibilityChange = (): void => {
    if (typeof document === "undefined") return;

    if (document.visibilityState === "hidden") {
      this.armIdleTimer();
    } else {
      this.disarmIdleTimer();
      if (this.status === "idle_disconnected") {
        this.setStatus("disconnected");
        this.reconnectAttempts = 0;
        if (this.isLeader) {
          this.connectEventSource();
        } else {
          this.initiateLeaderElection();
        }
      }
    }
  };

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.setStatus("idle_disconnected");
        if (this.isLeader) {
          this.stepDownFromLeader("idle_timeout");
        } else {
          this.closeEventSource();
        }
      }
    }, REALTIME_IDLE_TIMEOUT_MS);
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private setStatus(newStatus: RealtimeConnectionStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    this.statusListeners.forEach((listener) => {
      try {
        listener(newStatus);
      } catch {
        // تجاهل
      }
    });
  }

  /**
   * الاشتراك في أحداث لحظية محددة أو كافة الأحداث عبر '*'.
   * تعيد دالة إلغاء الاشتراك.
   */
  subscribe<T = unknown>(
    eventType: RealtimeEventType | "*",
    listener: (event: RealtimeEvent<T>) => void,
  ): () => void {
    let set = this.listeners.get(eventType);
    const isNewType = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    const genericListener = listener as (event: RealtimeEvent) => void;
    set.add(genericListener);

    // إذا وُجد مقبس EventSource نشط وكان نوع الحدث جديداً، نسجله فوراً
    if (this.eventSource && eventType !== "*" && isNewType) {
      this.attachEventSourceListener(this.eventSource, eventType);
    }

    return () => {
      const current = this.listeners.get(eventType);
      if (current) {
        current.delete(genericListener);
        if (current.size === 0) {
          this.listeners.delete(eventType);
        }
      }
    };
  }

  /**
   * الاشتراك في تغيرات حالة اتصال مدير اللحظية.
   */
  subscribeStatus(listener: (status: RealtimeConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): RealtimeConnectionStatus {
    return this.status;
  }

  getIsLeader(): boolean {
    return this.isLeader;
  }

  getTabId(): string {
    return this.tabId;
  }

  /**
   * تعيين حالة تطبيق الهاتف المحمول (Mobile AppState Integration — Wave 5)
   * عند الانتقال للخلفية ('background')، يتم قطع مقبس SSE فوراً للحفاظ على البطارية والبيانات.
   * وعند العودة ('active')، يُعاد الاتصال واستئناف انتخاب القائد بسلاسة.
   */
  setAppState(nextState: "active" | "background" | "inactive"): void {
    if (this.appState === nextState) return;
    this.appState = nextState;

    if (nextState === "background") {
      this.setStatus("idle_disconnected");
      if (this.isLeader) {
        this.stepDownFromLeader("mobile_background");
      } else {
        this.closeEventSource();
      }
    } else if (nextState === "active") {
      if (this.status === "idle_disconnected") {
        this.setStatus("disconnected");
        this.reconnectAttempts = 0;
        if (this.isLeader) {
          this.connectEventSource();
        } else {
          this.initiateLeaderElection();
        }
      }
    }
  }

  getAppState(): "active" | "background" | "inactive" {
    return this.appState;
  }

  /**
   * إيقاف المدير وإلغاء الاشتراكات وتنظيف الموارد.
   */
  stop(): void {
    this.isStarted = false;
    this.stepDownFromLeader("stopped");
    this.disarmIdleTimer();

    if (this.batchSalesTimer) {
      clearTimeout(this.batchSalesTimer);
      this.batchSalesTimer = null;
    }
    this.pendingBatchSales = null;
    this.pendingBatchScope = undefined;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.leaderWatchdogTimer) {
      clearInterval(this.leaderWatchdogTimer);
      this.leaderWatchdogTimer = null;
    }

    if (this.lockAbortController) {
      this.lockAbortController.abort();
      this.lockAbortController = null;
    }

    if (this.connectivityUnsubscribe) {
      this.connectivityUnsubscribe();
      this.connectivityUnsubscribe = null;
    }

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.listeners.clear();
    this.statusListeners.clear();
    this.setStatus("disconnected");
  }
}

export const realtimeManager = new RealtimeManager();
