import "dotenv/config";
import { initSentry, Sentry } from "./sentry";
// تهيئة Sentry قبل أي شيء (لا أثر إن لم يُضبط DSN).
const sentryEnabled = initSentry();

import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { sql } from "drizzle-orm";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { nanoid } from "nanoid";
import { createServer } from "http";
import net from "net";
import { createContext } from "./context";
import { getDb } from "./db";
import { logger } from "./logger";
import { appRouter } from "./routers";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.set("trust proxy", 1); // خلف بروكسي/خدمة Windows ⇒ IP الحقيقي لـrate-limit.

  // تسجيل بنيوي + معرّف لكل طلب (req.id) يُستعمل للربط في الأخطاء.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = nanoid(10);
        res.setHeader("x-request-id", id);
        return id;
      },
      // لا نضجّ السجلّ بطلبات الأصول الثابتة الناجحة.
      autoLogging: { ignore: (req) => req.url?.startsWith("/assets") ?? false },
    })
  );

  // حماية رؤوس HTTP. CSP معطّل لأنّ SPA يحقن أنماطاً/سكربتات inline (Vite/Tailwind).
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // CORS يُفعَّل فقط عند ضبط أصول مسموحة (التشغيل أحادي الأصل لا يحتاجه).
  const origins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length > 0) {
    app.use(cors({ origin: origins, credentials: true }));
  }

  // حدّ عام للطلبات (حماية من الإغراق).
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.RATE_LIMIT_MAX ?? 1000),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة." },
    })
  );

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // فحص صحّة للمراقبة/الحارس: يتأكّد أنّ القاعدة تستجيب.
  app.get("/healthz", async (_req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ ok: false, db: "unconfigured" });
      await db.execute(sql`SELECT 1`);
      res.json({ ok: true, time: new Date().toISOString() });
    } catch (e) {
      logger.error({ err: e }, "healthz failed");
      res.status(503).json({ ok: false, db: "down" });
    }
  });

  // حدّ صارم على تسجيل الدخول (حماية من تخمين كلمات المرور).
  app.use(
    "/api/trpc",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 10),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => !req.path.includes("auth.login"),
      message: { error: "محاولات دخول كثيرة، انتظر ١٥ دقيقة." },
    })
  );

  // API routes must be registered before the SPA catch-all (added by Vite/static).
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    logger.warn(`Port ${preferredPort} busy, using ${port} instead`);
  }

  // Listen BEFORE attaching Vite: the API binds immediately and a slow Vite
  // startup never blocks the server from accepting requests.
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  logger.info(`Server running on http://localhost:${port}/ ${sentryEnabled ? "(Sentry on)" : ""}`);

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
    logger.info("Vite middleware attached (dev)");
  } else {
    serveStatic(app);
  }

  // معالج أخطاء Sentry (بعد المسارات، فقط إن فُعِّل).
  if (sentryEnabled) {
    Sentry.setupExpressErrorHandler(app);
  }
}

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
