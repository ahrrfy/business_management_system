import { Router, type Request, type Response } from "express";
import { parse as parseCookie } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import {
  REALTIME_EVENT_TYPES,
  createRealtimeEvent,
} from "@shared/realtimeEvents";
import { authenticateExpressRequest } from "../auth/expressAuth";
import { canCrossBranches } from "../lib/branchAuthority";
import { PWA_SSE_QUIESCE_EVENT, sseManager } from "./sseManager";
import { getBridgeStatus, publishToBridgeConfirmed } from "./bridge";
import { logger } from "../logger";
import { csrfGuard } from "../middleware/csrf";

export const realtimeRouter = Router();

/** يحرر تدفقات الجلسة المصادقة فقط؛ إعادة الاتصال العادية تستأنفها دون تغيير أي بيانات. */
realtimeRouter.post(
  "/pwa-quiesce",
  csrfGuard,
  async (req: Request, res: Response) => {
    try {
      const cookies = parseCookie(req.headers.cookie ?? "");
      if (!cookies[COOKIE_NAME]) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      const auth = await authenticateExpressRequest(req, {
        allowPendingOnboarding: true,
      });
      if (!auth.ok) {
        res.status(auth.status).json({ error: "UNAUTHORIZED" });
        return;
      }
      const user = auth.user;
      const released = await publishToBridgeConfirmed(
        createRealtimeEvent(
          PWA_SSE_QUIESCE_EVENT,
          {},
          {
            userId: user.id,
            companyId: null,
          },
        ),
      );
      if (!released) {
        res
          .status(503)
          .json({ error: "PWA_RELEASE_UNCONFIRMED", retryable: true });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "realtime_sse.pwa_quiesce_error");
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  },
);

/**
 * نقطة تدفق الـ SSE الرئيسية: GET /api/realtime/stream
 *
 * الخصائص المعمارية (DoD Wave 0):
 * 1. مصادقة JWT عبر الكوكي أو الترويسة أو الـ query token.
 * 2. عزل الفرع الصارم (scopedBranchId) لمنع تسريب الأحداث التشغيلية بين الفروع.
 * 3. عدم حجز أي اتصال بقاعدة البيانات طوال فترة اتصال المقبس (Zero-DB Idle Footprint).
 * 4. نبضات الحفاظ على الاتصال كل 15 ثانية لمقاومة CGNAT و Nginx proxy timeout (120s).
 */
realtimeRouter.get("/stream", async (req: Request, res: Response) => {
  try {
    // 1. استخراج التوكن من الكوكي أو ترويسة Authorization فقط (حُذف query token لمنع تسريبه في السجلات)
    const cookies = parseCookie(req.headers.cookie ?? "");
    const cookieToken = cookies[COOKIE_NAME];
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : undefined;

    if (typeof req.query.token === "string" && req.query.token.trim() !== "") {
      res.status(400).json({
        error: "QUERY_TOKEN_FORBIDDEN",
        message: "لا يُسمح بتمرير رمز الجلسة في رابط الاستعلام؛ استخدم الكوكي أو ترويسة Authorization.",
      });
      return;
    }

    const token = cookieToken ?? bearerToken;
    if (!token) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "يجب تسجيل الدخول للاشتراك في قناة الأحداث اللحظية.",
      });
      return;
    }

    // إذا وُجد التوكن في ترويسة Authorization ولم يكن في الكوكي، نغذيه للطلب مع الحفاظ على بقية الكوكيز
    if (!cookieToken && token) {
      req.headers.cookie = req.headers.cookie
        ? `${req.headers.cookie}; ${COOKIE_NAME}=${token}`
        : `${COOKIE_NAME}=${token}`;
    }

    // 2. التحقق الخاطف لمرة واحدة من الجلسة + 2FA + الدور المخصص — يُغلق استعلام DB فوراً
    const auth = await authenticateExpressRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json({
        error: auth.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
        message: auth.error,
      });
      return;
    }
    const user = auth.user;

    // 3. تحديد الفرع المعزول وفق سلطة الفاعل (Branch Authority)
    let scopedBranchId: number | null = null;
    const userCanCross = canCrossBranches(user);

    if (userCanCross) {
      // الأدمن والمدير العام: إمكانية اختيار فرع محدد للمراقبة أو استلام أحداث كافة الفروع
      const rawBranchQuery = req.query.branchId;
      if (rawBranchQuery) {
        const parsed = Number(rawBranchQuery);
        scopedBranchId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      } else {
        scopedBranchId = null; // كافة الفروع
      }
    } else {
      // الموظف أو الكاشير المقيد: إجبار الفرع المسند له ولا يسمح بالتجاوز (منع IDOR)
      scopedBranchId = user.branchId ?? null;
    }

    // 4. ضبط ترويسات تدفق الـ Server-Sent Events وفق معايير Nginx و HTTP
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // 5. توليد معرّف اتصال فريد وتسجيل العميل في sseManager
    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sseManager.registerClient({
      id: connectionId,
      userId: user.id,
      role: user.role,
      scopedBranchId,
      canCrossBranches: userCanCross,
      companyId: null,
      req,
      res,
    });

    // 6. إرسال حدث الترحيب والتأكيد اللحظي
    const welcomeEvent = createRealtimeEvent(REALTIME_EVENT_TYPES.CONNECTED, {
      connectionId,
      userId: user.id,
      role: user.role,
      scopedBranchId,
      serverTime: Date.now(),
    });

    res.write(
      `id: ${welcomeEvent.id}\nevent: ${welcomeEvent.type}\ndata: ${JSON.stringify(welcomeEvent.payload)}\n\n`,
    );
  } catch (err) {
    logger.error({ err }, "realtime_sse.stream_endpoint_error");
    if (!res.headersSent) {
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    } else {
      try {
        res.end();
      } catch {
        // تجاهل
      }
    }
  }
});

/**
 * نقطة فحص حالة خادم اللحظية والمقاييس: GET /api/realtime/health & /healthz
 */
const healthHandler = async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await authenticateExpressRequest(req).catch(() => ({ ok: false as const }));
  if (!auth.ok || (auth.user.role !== "admin" && !auth.user.isOwner)) {
    res.json({
      status: "healthy",
      timestamp: Date.now(),
    });
    return;
  }

  const sseStats = sseManager.getStats();
  const bridgeStatus = getBridgeStatus();
  const mem = process.memoryUsage();

  res.json({
    status: "healthy",
    sse: sseStats,
    bridge: bridgeStatus,
    metrics: {
      activeSubscribers: sseStats.activeConnections,
      memoryRssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    timestamp: Date.now(),
  });
};

realtimeRouter.get("/health", healthHandler);
realtimeRouter.get("/healthz", healthHandler);
