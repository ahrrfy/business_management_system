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

export interface HrDeviceBridge {
  server: Server;
  stop: () => Promise<void>;
}

export function startHrDeviceBridge(port: number): HrDeviceBridge | null {
  if (process.env.CONTROL_DATABASE_URL) {
    // وضع تعدد الشركات يحتاج توجيه SN⇒شركة (خارج النطاق حالياً) — نرفض بوضوح بدل سلوك ملتبس.
    logger.warn("hrDevices: الجسر معطل في وضع تعدد الشركات (CONTROL_DATABASE_URL مضبوط)");
    return null;
  }

  const server = createServer((req, res) => {
    void handleIclock(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    });
  });

  // maxPayload صريح: افتراضي ws ~١٠٠م.ب على مقبس غير مصادَق (قبل reg) = ثغرة إنهاك ذاكرة.
  // ٨م.ب تطابق سقف جسم iclock وتكفي أكبر دفعة سجلات واقعية.
  const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });
  wss.on("connection", (socket, req) => {
    const remote = req.socket.remoteAddress ?? "?";
    const session = createAifaceSession({
      sendText: (text) => socket.send(text),
      close: () => socket.close(),
      remote,
    });
    logger.info({ remote }, "hrDevices: اتصال WebSocket جديد");
    socket.on("message", (data) => {
      void session.handleMessage(data.toString());
    });
    socket.on("close", () => {
      void session.handleClose();
    });
    socket.on("error", (err) => {
      logger.warn({ err, remote }, "hrDevices: خطأ مقبس");
    });
  });

  // كنس الأجهزة الصامتة كل دقيقتين: online تعني «أرسل شيئاً خلال آخر ١٠ دقائق» فعلاً.
  const sweeper = setInterval(() => {
    void sweepOffline(600).catch((e) => logger.warn({ err: e }, "hrDevices: فشل كنس offline"));
  }, 120_000);
  sweeper.unref();

  server.on("error", (err) => {
    // منفذ مشغول ونحوه: الجسر يفشل وحده ولا يُسقط خادم النظام الرئيسي أبداً.
    logger.error({ err, port }, "hrDevices: تعذر تشغيل جسر الأجهزة");
  });
  server.listen(port, () => {
    logger.info(`hrDevices: جسر أجهزة الحضور يستمع على المنفذ ${port} (aiface WS + zk iclock)`);
  });

  return {
    server,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        for (const client of Array.from(wss.clients)) client.terminate();
        wss.close(() => {
          server.close(() => resolve());
        });
      }),
  };
}
