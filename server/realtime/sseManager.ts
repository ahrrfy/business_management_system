import type { Request, Response } from "express";
import {
  REALTIME_HEARTBEAT_INTERVAL_MS,
  type RealtimeEvent,
} from "@shared/realtimeEvents";
import { logger } from "../logger";

export interface SseClient {
  id: string;
  userId: number;
  role: string;
  scopedBranchId: number | null;
  companyId?: number | null;
  res: Response;
  pingTimer: NodeJS.Timeout;
  connectedAt: number;
  lastActivityAt: number;
}

export interface RegisterClientOptions {
  id: string;
  userId: number;
  role: string;
  scopedBranchId: number | null;
  companyId?: number | null;
  req: Request;
  res: Response;
}

export class SseManager {
  private clients = new Map<string, SseClient>();

  /**
   * تسجيل اتصال SSE جديد مع ضبط الترويسات ومؤقت النبضات.
   * خالي تماماً من أي اتصال بقاعدة البيانات (Zero-DB Idle Footprint).
   */
  registerClient(opts: RegisterClientOptions): SseClient {
    const { id, userId, role, scopedBranchId, companyId, req, res } = opts;

    // تنظيف أي اتصال قديم بنفس المعرّف إن وُجد
    if (this.clients.has(id)) {
      this.removeClient(id);
    }

    // إعداد نبضات الحفاظ على الاتصال كل 15 ثانية لمقاومة CGNAT و Nginx proxy_read_timeout (120s)
    const pingTimer = setInterval(() => {
      try {
        if (res.writableEnded || res.destroyed) {
          this.removeClient(id);
          return;
        }
        res.write(": ping\n\n");
      } catch (err) {
        logger.warn({ id, err }, "realtime_sse.ping_failed");
        this.removeClient(id);
      }
    }, REALTIME_HEARTBEAT_INTERVAL_MS);

    // حماية عدم تسريب الذاكرة: منع استمرار المؤقت من حجب إغلاق Node
    if (typeof pingTimer.unref === "function") {
      pingTimer.unref();
    }

    const client: SseClient = {
      id,
      userId,
      role,
      scopedBranchId,
      companyId,
      res,
      pingTimer,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.clients.set(id, client);

    // تنظيف فوري عند إغلاق العميل للمتصفح أو انقطاع المقبس
    const cleanup = () => {
      this.removeClient(id);
    };

    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("finish", cleanup);
    res.on("error", cleanup);

    logger.info(
      { id, userId, role, scopedBranchId, activeTotal: this.clients.size },
      "realtime_sse.client_connected",
    );

    return client;
  }

  /**
   * إزالة اتصال العميل وتنظيف الذاكرة ومؤقت النبض.
   */
  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;

    clearInterval(client.pingTimer);
    this.clients.delete(id);

    try {
      if (!client.res.writableEnded && !client.res.destroyed) {
        client.res.end();
      }
    } catch {
      // تجاهل أخطاء الإغلاق إن كان المقبس مقطوعاً
    }

    logger.info({ id, remaining: this.clients.size }, "realtime_sse.client_disconnected");
  }

  /**
   * مطابقة العميل مع نطاق الحدث للتحقق من الأهلية والعزل الأمني للفروع.
   */
  shouldDeliver(client: SseClient, event: RealtimeEvent): boolean {
    if (event.scope?.excludeConnectionId && client.id === event.scope.excludeConnectionId) {
      return false;
    }

    if (event.scope?.userId != null && client.userId !== event.scope.userId) {
      return false;
    }

    if (event.scope?.role != null && client.role !== event.scope.role) {
      return false;
    }

    // عزل الشركة الصارم (Multi-tenancy Company Isolation):
    if (
      event.scope?.companyId != null &&
      client.companyId != null &&
      client.companyId !== event.scope.companyId
    ) {
      return false;
    }

    // عزل الفرع الصارم (Branch Isolation):
    // إذا كان الحدث موجهاً لفرع محدد، وكان العميل مقيداً بفرع محدد، فيجب تطابقهما حتماً.
    if (event.scope?.branchId != null) {
      if (client.scopedBranchId != null && client.scopedBranchId !== event.scope.branchId) {
        return false;
      }
    }

    return true;
  }

  /**
   * بث حدث لحظي لكافة المتصلين المؤهلين وفق شروط العزل الأمني.
   * يعيد عدد العملاء الذين استلموا الحدث بنجاح.
   */
  broadcast(event: RealtimeEvent): number {
    let deliveredCount = 0;
    const formatted = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;

    this.clients.forEach((client, id) => {
      if (!this.shouldDeliver(client, event)) {
        return;
      }

      try {
        if (client.res.writableEnded || client.res.destroyed) {
          this.removeClient(id);
          return;
        }

        client.res.write(formatted);
        client.lastActivityAt = Date.now();
        deliveredCount++;
      } catch (err) {
        logger.warn({ id, err }, "realtime_sse.broadcast_write_failed");
        this.removeClient(id);
      }
    });

    return deliveredCount;
  }

  /**
   * إرسال حدث فردي لعميل محدد بمعرّف اتصاله.
   */
  sendToClient(clientId: string, event: RealtimeEvent): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    try {
      if (client.res.writableEnded || client.res.destroyed) {
        this.removeClient(clientId);
        return false;
      }

      const formatted = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
      client.res.write(formatted);
      client.lastActivityAt = Date.now();
      return true;
    } catch (err) {
      logger.warn({ clientId, err }, "realtime_sse.send_direct_failed");
      this.removeClient(clientId);
      return false;
    }
  }

  /**
   * عدد الاتصالات النشطة على هذا العامل.
   */
  get activeCount(): number {
    return this.clients.size;
  }

  /**
   * إحصائيات الاتصال لمراقبة الذاكرة ونقاط الفحص.
   */
  getStats(): { activeConnections: number; connectionIds: string[] } {
    return {
      activeConnections: this.clients.size,
      connectionIds: Array.from(this.clients.keys()),
    };
  }

  /**
   * إغلاق كافة الاتصالات النشطة عند إيقاف الخادم.
   */
  closeAll(): void {
    Array.from(this.clients.keys()).forEach((id) => {
      this.removeClient(id);
    });
    this.clients.clear();
  }
}

export const sseManager = new SseManager();
