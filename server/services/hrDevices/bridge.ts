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

export interface HrDeviceBridge {
  server: Server;
  stop: () => Promise<void>;
}

export interface HrDeviceBridgeStartOptions {
  listenTimeoutMs?: number;
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
  const rateLimiter = new PerIpRateLimiter(security.maxRequestsPerMinute);
  const wsPerIp = new Map<string, number>();

  const server = createServer((req, res) => {
    const remote = req.socket.remoteAddress;
    if (!isRequestAuthorized(req, security)) {
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
    void handleIclock(req, res, security).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    });
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
      const authorized = isRequestAuthorized(req, security);
      const withinRate = rateLimiter.allow(req.socket.remoteAddress);
      const accepted =
        authorized && withinRate && connected < security.maxWsConnectionsPerIp;
      if (!accepted)
        logger.warn(
          { remote, authorized, withinRate, connected },
          "hrDevices: رفض ترقية WebSocket",
        );
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
    const session = createAifaceSession({
      sendText: (text) => socket.send(text),
      close: () => socket.close(),
      remote,
      deviceCredential: requestDeviceCredential(req),
      securityConfig: security,
    });
    logger.info({ remote }, "hrDevices: اتصال WebSocket جديد");
    socket.on("message", (data) => {
      if (!rateLimiter.allow(req.socket.remoteAddress)) {
        logger.warn({ remote }, "hrDevices: تجاوز حد رسائل WebSocket");
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
      void session.handleClose();
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
  const sweeper = setInterval(() => {
    void sweepOffline(600).catch((e) =>
      logger.warn({ err: e }, "hrDevices: فشل كنس offline"),
    );
  }, 120_000);
  sweeper.unref();

  server.on("error", (err) => {
    // منفذ مشغول ونحوه: الجسر يفشل وحده ولا يُسقط خادم النظام الرئيسي أبداً.
    logger.error({ err, port }, "hrDevices: تعذر تشغيل جسر الأجهزة");
  });
  server.requestTimeout = security.requestTimeoutMs;
  server.headersTimeout = Math.min(security.requestTimeoutMs, 30_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  let stopped = false;
  const stop = () =>
    new Promise<void>((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      stopped = true;
      clearInterval(sweeper);
      clearInterval(heartbeat);
      for (const client of Array.from(wss.clients)) client.terminate();

      const closeHttpServer = () => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      };
      try {
        wss.close(() => closeHttpServer());
      } catch {
        closeHttpServer();
      }
    });

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
