/* ============================================================================
 * جسر أجهزة الحضور (server/services/hrDevices/bridge.ts)
 * مستمع واحد على HR_DEVICE_PORT يخدم البروتوكولين معاً:
 *   - ترقية WebSocket ⇒ عائلة AiFace/AI518 (JSON) — جهاز الشركة الحالي.
 *   - طلبات HTTP على /iclock/* ⇒ عائلة ZKTeco PUSH النصية — الأجهزة المستقبلية.
 * التفعيل بمتغير البيئة فقط؛ غيابه = صفر أثر على النظام (نمط CONTROL_DATABASE_URL).
 * الأجهزة القديمة تتكلم HTTP عارياً ⇒ المنفذ يُفتح مباشرة (لا خلف nginx TLS).
 * ========================================================================== */
import { createServer, type Server } from "http";
import { WebSocketServer } from "ws";
import { logger } from "../../logger";
import { createAifaceSession } from "./aifaceDriver";
import { handleIclock } from "./iclockDriver";
import { sweepOffline } from "./registry";
import {
  type BridgeSecurityConfig,
  isRequestAuthorized,
  normalizeRemoteAddress,
  PerIpRateLimiter,
  productionSecurityFailure,
  requestDeviceCredential,
  resolveBridgeSecurityConfig,
} from "./bridgeSecurity";
import {
  cachedLearnedOrigins,
  recordBlockedOrigin,
  refreshLearnedOrigins,
  resolveOriginTrustConfig,
} from "./originTrust";

export interface HrDeviceBridge {
  server: Server;
  stop: () => Promise<void>;
}

export interface HrDeviceBridgeStartOptions {
  listenTimeoutMs?: number;
  /** منفذ حقن لاختبار تصريف طلبات iClock؛ الإنتاج يستخدم المعالج الحقيقي. */
  iclockHandler?: typeof handleIclock;
  /** منفذ حقن للاختبار الحتمي؛ الإنتاج يستخدم المصنع الحقيقي دائماً. */
  sessionFactory?: typeof createAifaceSession;
  /** منفذا حقن لاختبار تصريف مهمة الصيانة من دون انتظار مؤقت الإنتاج. */
  sweep?: typeof sweepOffline;
  sweepIntervalMs?: number;
}

const DEFAULT_LISTEN_TIMEOUT_MS = 10_000;

/** يفحص إعدادات البدء من دون فتح منفذ؛ يستعمله preflight ومسار التشغيل نفسه. */
export function assertHrDeviceBridgeStartupConfig(
  port: number,
): BridgeSecurityConfig {
  if (process.env.CONTROL_DATABASE_URL) {
    throw new Error("HR_DEVICE_BRIDGE_UNSUPPORTED_WITH_CONTROL_DATABASE_URL");
  }

  const security = resolveBridgeSecurityConfig();
  const securityFailure = productionSecurityFailure(security);
  if (securityFailure) {
    throw new Error(`HR_DEVICE_BRIDGE_SECURITY_NOT_READY:${securityFailure}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("HR_DEVICE_BRIDGE_PORT_INVALID");
  }
  return security;
}

function listenForBridge(
  server: Server,
  port: number,
  host: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abortController = new AbortController();
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.off("listening", onListening);
      server.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onListening = () => finish();
    const onError = (error: Error) => finish(error);
    const timeout = setTimeout(() => {
      finish(new Error(`HR_DEVICE_BRIDGE_LISTEN_TIMEOUT:${timeoutMs}`));
      abortController.abort();
    }, timeoutMs);

    server.once("listening", onListening);
    server.once("error", onError);
    try {
      server.listen({ port, host, signal: abortController.signal });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function startHrDeviceBridge(
  port: number,
  options: HrDeviceBridgeStartOptions = {},
): Promise<HrDeviceBridge> {
  const security = assertHrDeviceBridgeStartupConfig(port);
  // عدّادان منفصلان عمداً: الأوّل للاتصال (طلبات HTTP + ترقيات WebSocket) والثاني لرسائل
  // الجلسة بعد نجاح `reg`. خلطهما كان يجعل تفريغ المتراكم يستنزف ميزانية إعادة الاتصال
  // فيمنع الجهاز من العودة بعد إغلاقه — أي أنّ عملاً مشروعاً يحجب نفسه.
  const rateLimiter = new PerIpRateLimiter(security.maxRequestsPerMinute);
  const sessionMessageLimiter = new PerIpRateLimiter(
    security.maxSessionMessagesPerMinute,
  );
  const wsPerIp = new Map<string, number>();
  const sessionDrainers = new Set<() => Promise<void>>();
  const httpTasks = new Set<Promise<void>>();
  let httpRequestsAccepting = true;

  const server = createServer((req, res) => {
    if (!httpRequestsAccepting) {
      res.writeHead(503, {
        "Content-Type": "text/plain",
        "Retry-After": "5",
        Connection: "close",
      });
      res.end("retry");
      return;
    }
    const remote = req.socket.remoteAddress;
    if (!isRequestAuthorized(req, security, cachedLearnedOrigins())) {
      logger.warn(
        { remote: normalizeRemoteAddress(remote) },
        "hrDevices: رفض طلب غير مصرح",
      );
      res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
      res.end("forbidden");
      return;
    }
    if (!rateLimiter.allow(remote)) {
      logger.warn(
        { remote: normalizeRemoteAddress(remote) },
        "hrDevices: تجاوز حد الطلبات",
      );
      res.writeHead(429, {
        "Content-Type": "text/plain",
        "Retry-After": "60",
        Connection: "close",
      });
      res.end("too many requests");
      return;
    }
    const abortController = new AbortController();
    const abortRequest = () => abortController.abort();
    const abortOnPrematureClose = () => {
      if (!res.writableFinished) abortRequest();
    };
    req.once("aborted", abortRequest);
    res.once("close", abortOnPrematureClose);
    if (req.aborted || res.destroyed) abortRequest();

    let tracked!: Promise<void>;
    tracked = (options.iclockHandler ?? handleIclock)(
      req,
      res,
      security,
      abortController.signal,
    )
      .then((handled) => {
        if (!handled && !res.headersSent && !res.destroyed) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
        }
      })
      .catch((error) => {
        logger.warn(
          { err: error, remote: normalizeRemoteAddress(remote) },
          "hrDevices: فشل طلب iClock",
        );
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          res.writeHead(503, {
            "Content-Type": "text/plain",
            "Retry-After": "30",
            Connection: "close",
          });
          res.end("retry");
        }
      })
      .finally(() => {
        req.off("aborted", abortRequest);
        res.off("close", abortOnPrematureClose);
        httpTasks.delete(tracked);
      });
    httpTasks.add(tracked);
  });

  // maxPayload صريح: افتراضي ws ~١٠٠م.ب على مقبس غير مصادَق (قبل reg) = ثغرة إنهاك ذاكرة.
  // ٨م.ب تطابق سقف جسم iclock وتكفي أكبر دفعة سجلات واقعية.
  const wss = new WebSocketServer({
    server,
    maxPayload: security.maxPayloadBytes,
    verifyClient: ({ req }, done) => {
      const remote =
        normalizeRemoteAddress(req.socket.remoteAddress) || "unknown";
      const connected = wsPerIp.get(remote) ?? 0;
      const authorized = isRequestAuthorized(req, security, cachedLearnedOrigins());
      const withinRate = rateLimiter.allow(req.socket.remoteAddress);
      const accepted =
        authorized && withinRate && connected < security.maxWsConnectionsPerIp;
      if (!accepted) {
        logger.warn(
          { remote, authorized, withinRate, connected },
          "hrDevices: رفض ترقية WebSocket",
        );
        // مصدرٌ صُدّ **قبل** أن يُعرّف نفسه ⇒ لا رقم تسلسليّ. نرصده (مخنوقاً في الذاكرة) كي
        // يظهر في الشاشة، وإلّا بقيت الحالةُ التي بُني لها المسار اليدويّ بلا أيّ أثرٍ مرئيّ.
        if (!authorized) {
          const tracked = recordBlockedOrigin(req.socket.remoteAddress)
            .catch((err) =>
              logger.warn({ err, remote }, "hrDevices: تعذّر رصد مصدر محجوب"),
            )
            .finally(() => maintenanceTasks.delete(tracked));
          maintenanceTasks.add(tracked);
        }
      }
      done(accepted, accepted ? undefined : authorized ? 429 : 403);
    },
  });
  // ws يعيد بث خطأ HTTP listen على WebSocketServer؛ يجب امتلاك مستمع هنا كي لا يقطع
  // EventEmitter قبل أن يلتقط وعد الجاهزية EADDRINUSE ويرفض بصورة محكومة.
  wss.on("error", (err) => {
    logger.error({ err, port }, "hrDevices: خطأ خادم WebSocket لجسر الحضور");
  });
  wss.on("connection", (socket, req) => {
    const remote = normalizeRemoteAddress(req.socket.remoteAddress) || "?";
    wsPerIp.set(remote, (wsPerIp.get(remote) ?? 0) + 1);
    let messageChain = Promise.resolve();
    const session = (options.sessionFactory ?? createAifaceSession)({
      sendText: (text) => socket.send(text),
      close: () => socket.close(),
      remote,
      deviceCredential: requestDeviceCredential(req),
      securityConfig: security,
    });
    let drainPromise: Promise<void> | null = null;
    const drainSession = (): Promise<void> => {
      if (drainPromise) return drainPromise;

      // close listeners لا تنتظر Promise؛ نسلسل الإغلاق بعد آخر رسالة صراحةً كي لا
      // تُسجّل رسالة reg رابطاً لمقبس مات، وكي تعود أوامر inflight إلى queued قبل closeDb.
      drainPromise = messageChain
        .then(() => session.handleClose())
        .catch((err) =>
          logger.warn(
            { err, remote },
            "hrDevices: فشل تصريف جلسة WebSocket عند الإغلاق",
          ),
        )
        .finally(() => sessionDrainers.delete(drainSession));
      return drainPromise;
    };
    sessionDrainers.add(drainSession);
    logger.info({ remote }, "hrDevices: اتصال WebSocket جديد");
    socket.on("message", (data) => {
      // الجلسة التي اجتازت `reg` جهازٌ مُثبَتُ الهوية ⇒ ميزانيةٌ سخيّة تكفي تفريغ المتراكم.
      // وما قبل `reg` يبقى على الميزانية الصارمة المشتركة (لا تخفيف لمجهول).
      const registered = session.device() != null;
      const limiter = registered ? sessionMessageLimiter : rateLimiter;
      if (!limiter.allow(req.socket.remoteAddress)) {
        logger.warn(
          { remote, registered },
          "hrDevices: تجاوز حد رسائل WebSocket",
        );
        // الإغلاق يبقى صمّام الأمان؛ البصمات لا تضيع (الجهاز يعيد الدفع، والإدراج idempotent
        // بقيد uq_punch_sn_enroll_time)، وإعادة الاتصال لم تعد محجوبة بعد فصل العدّادين.
        socket.close(1008, "rate limit");
        return;
      }
      // تسلسل الرسائل يمنع سباق reg/sendlog والأوامر داخل الجلسة الواحدة.
      messageChain = messageChain
        .then(() => session.handleMessage(data.toString()))
        .catch((err) =>
          logger.warn({ err, remote }, "hrDevices: فشل معالجة رسالة WebSocket"),
        );
    });
    socket.on("close", () => {
      const remaining = Math.max(0, (wsPerIp.get(remote) ?? 1) - 1);
      if (remaining === 0) wsPerIp.delete(remote);
      else wsPerIp.set(remote, remaining);
      void drainSession();
    });
    socket.on("error", (err) => {
      logger.warn({ err, remote }, "hrDevices: خطأ مقبس");
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of Array.from(wss.clients)) {
      const tracked = client as typeof client & { __hrAlive?: boolean };
      if (tracked.__hrAlive === false) {
        client.terminate();
        continue;
      }
      tracked.__hrAlive = false;
      client.once("pong", () => {
        tracked.__hrAlive = true;
      });
      client.ping();
    }
  }, security.idleTimeoutMs);
  heartbeat.unref();

  // كنس الأجهزة الصامتة كل دقيقتين: online تعني «أرسل شيئاً خلال آخر ١٠ دقائق» فعلاً.
  // نمنع التداخل ونتعقب المهمة كي لا تُغلق DB وهي ما زالت تكتب حالة الأجهزة.
  const maintenanceTasks = new Set<Promise<void>>();
  const launchSweep = (): void => {
    if (maintenanceTasks.size > 0) return;
    let tracked!: Promise<void>;
    tracked = (options.sweep ?? sweepOffline)(600)
      .catch((e) =>
        logger.warn({ err: e }, "hrDevices: فشل كنس offline"),
      )
      .finally(() => maintenanceTasks.delete(tracked));
    maintenanceTasks.add(tracked);
  };
  const sweeper = setInterval(
    launchSweep,
    options.sweepIntervalMs ?? 120_000,
  );
  sweeper.unref();

  // «العنوان يُتعلَّم لا يُكتَب»: تحديث دوريّ لمجموعة العناوين الموثوقة من القاعدة، كي يفتح
  // عنوانُ المتجر الجديد (بعد تغيير المزوّد) البوّابةَ الأولى بلا SSH ولا إعادة تشغيل.
  // مفصولٌ عن الكنّاس عمداً: دورته أقصر (٣٠ث) لأنّه مسار تعافٍ من انقطاع، لا صيانة.
  const originTrust = resolveOriginTrustConfig();
  // حارس تداخل: تدهورُ القاعدة قد يُبطئ الاستعلام فوق دورة الـ٣٠ث؛ بلا هذا الحارس تتراكم
  // نداءات بلا سقف فتستنزف مجمّع الاتصالات ويعلق الإيقاف بانتظارها (مراجعة عادية).
  let originRefreshInFlight: Promise<void> | null = null;
  const refreshOrigins = () => {
    if (originRefreshInFlight) return;
    const tracked = refreshLearnedOrigins(originTrust.windowHours, originTrust.minWitnesses)
      .finally(() => {
        originRefreshInFlight = null;
        maintenanceTasks.delete(tracked);
      });
    originRefreshInFlight = tracked;
    maintenanceTasks.add(tracked);
  };
  const originRefresher = setInterval(refreshOrigins, 30_000);
  originRefresher.unref();

  server.on("error", (err) => {
    // منفذ مشغول ونحوه: الجسر يفشل وحده ولا يُسقط خادم النظام الرئيسي أبداً.
    logger.error({ err, port }, "hrDevices: تعذر تشغيل جسر الأجهزة");
  });
  server.requestTimeout = security.requestTimeoutMs;
  server.headersTimeout = Math.min(security.requestTimeoutMs, 30_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;

    stopPromise = (async () => {
      httpRequestsAccepting = false;
      clearInterval(sweeper);
      clearInterval(heartbeat);
      clearInterval(originRefresher);
      // لا توجد await قبل إيقاف القبول وأخذ snapshot؛ لذلك لا تستطيع جلسة جديدة
      // أن تتسلل خارج مجموعة التصريف.
      const drains = Array.from(sessionDrainers);
      const maintenance = Array.from(maintenanceTasks);
      const requests = Array.from(httpTasks);
      const webSocketClosed = new Promise<void>((resolve) => {
        try {
          wss.close(() => resolve());
        } catch (error) {
          logger.warn({ err: error }, "hrDevices: تعذر إغلاق WebSocketServer");
          resolve();
        }
      });
      const httpClosed = new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        try {
          server.close(() => resolve());
        } catch (error) {
          logger.warn({ err: error }, "hrDevices: تعذر إغلاق HTTP server");
          resolve();
        }
      });

      for (const client of Array.from(wss.clients)) client.terminate();
      await Promise.all([
        webSocketClosed,
        httpClosed,
        ...drains.map((drain) => drain()),
        ...maintenance,
        ...requests,
      ]);
    })();

    return stopPromise;
  };

  // تحميلٌ أوّليّ قبل فتح المنفذ: الجهاز المصدود يقرع كلّ ~٢٠٠م.ث، فلو انتظرنا الدورة
  // الأولى (٣٠ث) لضاعت مئات المحاولات بلا سبب. فاشلٌ مفتوحاً (يبتلع خطأه داخلياً).
  await refreshLearnedOrigins(originTrust.windowHours, originTrust.minWitnesses);

  try {
    await listenForBridge(
      server,
      port,
      security.host,
      options.listenTimeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS,
    );
  } catch (error) {
    await stop();
    throw error;
  }

  const address = server.address();
  const listeningPort =
    address && typeof address !== "string" ? address.port : port;
  logger.info(
    {
      host: security.host,
      port: listeningPort,
      allowlistConfigured: security.allowlist.length > 0,
      gatewaySecretConfigured: Boolean(security.sharedSecret),
    },
    "hrDevices: جسر أجهزة الحضور يستمع (aiface WS + zk iclock)",
  );

  return { server, stop };
}
