import "dotenv/config";
import { initSentry, Sentry } from "./sentry";
// تهيئة Sentry قبل أي شيء (لا أثر إن لم يُضبط DSN).
const sentryEnabled = initSentry();

import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { sql } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { nanoid } from "nanoid";
import { createServer } from "http";
import net from "net";
import { createContext } from "./context";
import { getDb, closeDb } from "./db";
import { logger } from "./logger";
import { appRouter } from "./routers";
import { serveStatic, setupVite } from "./vite";
import { csrfGuard } from "./middleware/csrf";
import { printRouter } from "./printRoute";
import { backupRouter } from "./backupRoutes";

function isPortAvailable(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const onListening = () => probe.close(() => resolve(true));
    probe.on("error", () => resolve(false));
    // المجسّ يفحص نفس واجهة الاستماع الفعلية — فحص wildcard بينما الربط على 127.0.0.1 يكذب في الاتجاهين.
    if (host) probe.listen(port, host, onListening);
    else probe.listen(port, onListening);
  });
}

async function findAvailablePort(startPort = 3000, host?: string): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // فشل سريع: سرّ الجلسات مفقود/ضعيف ⇒ توكنات قابلة للتزوير. أوقف الإقلاع بدل العمل بثغرة.
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    logger.error(
      "JWT_SECRET مفقود أو أقصر من ٣٢ حرفاً — أوقفنا الإقلاع. اضبط قيمة عشوائية طويلة في .env (مثال: openssl rand -hex 32)."
    );
    process.exit(1);
  }

  const app = express();
  const server = createServer(app);
  // trust proxy مشروط: لا نثق برؤوس X-Forwarded-* إلا عند صحّة الإطار:
  //   - HOST=127.0.0.1 ⇒ خلف nginx/reverse-proxy موثوق (وضع الإنتاج على VPS).
  //   - TRUST_PROXY=1 ⇒ فلاج صريح للحالات غير القياسية (مثل تشغيل خلف بروكسي بمنفذ علني).
  // غير ذلك (واجهات عامة أو localhost للتطوير) ⇒ نُلغيها كي لا يُزوّر مهاجمٌ IP عبر X-Forwarded-For
  // فيُلتفّ على حدود المعدّل المبنية على IP في authRouter (recordIpFailure).
  const trustProxy = process.env.TRUST_PROXY === "1" || process.env.HOST === "127.0.0.1";
  app.set("trust proxy", trustProxy);

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

  // حماية رؤوس HTTP. CSP مُفعَّل مع استثناء style-src unsafe-inline لـTailwind/SPA.
  // في وضع التطوير: 'unsafe-inline' + 'unsafe-eval' مطلوبان لـVite HMR و source maps.
  // في الإنتاج: نبقى على 'self' فقط (البنية المجمَّعة بلا inline scripts).
  const isDev = process.env.NODE_ENV === "development";
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: isDev
            ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
            : ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: isDev
            ? ["'self'", "ws://localhost:*", "wss://localhost:*"]
            : ["'self'"],
          fontSrc: ["'self'", "data:"], // خط Cairo مستضاف محلياً (@fontsource) ⇒ لا حاجة لـgstatic.
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );

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

  // HTTP compression (gzip/brotli) — مهم على الشبكات البطيئة (العراق).
  app.use(compression());

  // حجم الجسم: ١mb افتراضياً لكل المسارات (سطح هجوم DoS أصغر على /auth.login وغيرها).
  // الاستثناء الوحيد: /api/print/raw يرفع لـ١٠mb لأن العميل يرسل raster ESC/POS كبير
  // (نقطية الإيصال العربي مُولَّدة على Canvas) — لا حدّ ١mb لأنه يقطع الطباعة الفعلية.
  app.use("/api/print/raw", express.json({ limit: "10mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

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

  // حدّ صارم على دخول بوابة العدّ الخارجية (تخمين PIN) — فوق قفل المحاولات في القاعدة.
  app.use(
    "/api/trpc",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.COUNT_RATE_LIMIT_MAX ?? 10),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => !req.path.includes("count.auth"),
      message: { error: "محاولات دخول كثيرة لبوابة العدّ، انتظر ١٥ دقيقة." },
    })
  );

  // حدّ صارم على تفعيل جهاز الكشك الخارجي (تخمين رمز الجهاز) — رغم أنّ الرمز عشوائي 24 بايت.
  app.use(
    "/api/trpc",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.KIOSK_RATE_LIMIT_MAX ?? 30),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => !req.path.includes("kiosk.deviceLogin"),
      message: { error: "محاولات كثيرة لتفعيل جهاز الكشك، انتظر قليلاً." },
    })
  );

  // حدّ صارم على استمارة التقديم العامة (recruitment.submit) — إجراء بلا مصادقة على سطح عام
  // ⇒ حماية من الإغراق/السبام على جدول المتقدّمين.
  app.use(
    "/api/trpc",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.RECRUIT_RATE_LIMIT_MAX ?? 8),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => !req.path.includes("recruitment.submit"),
      message: { error: "طلبات تقديم كثيرة، انتظر قليلاً ثم أعد المحاولة." },
    })
  );

  // حماية CSRF (طبقة دفاع ثانية فوق sameSite:"strict").
  app.use("/api/trpc", csrfGuard);

  // حدّ صلب فوقي على الدفعات (tRPC batch link): يرفض الطلب إن حوى أكثر من حدّ تصاعدي على
  // إجراء عام واحد قبل وصوله للراوتر، فيقفل نمط تضخيم تجاوز حدّ المعدّل (نمط جذري ٥):
  // كان rateLimit يَعدّ HTTP requests لا الإجراءات؛ batch link يحشو عشرات النداءات في طلب واحد
  // فيسمح بـ٥٠ محاولة auth.login/count.auth/kiosk.deviceLogin/recruitment.submit ضمن طلب واحد
  // قبل اصطدامه بحدّ المعدّل. الحدّ التالي للنقاط العامة الحرجة لا يسمح بأكثر من نداء واحد لكلّ طلب
  // HTTP، فحدّ المعدّل القائم يعمل بدقّته الحقيقية بلا تمييع.
  app.use("/api/trpc", (req, res, next) => {
    const PUBLIC_SENSITIVE = ["auth.login", "count.auth", "kiosk.deviceLogin", "recruitment.submit"];
    // مسار البَتش يبدأ بـ"/api/trpc/x," مع فاصلة بين أسماء الإجراءات الموحَّدة.
    const path = req.path || "";
    if (path.includes(",")) {
      const procs = path.split("/").pop()?.split(",") ?? [];
      let count = 0;
      for (const p of procs) {
        if (PUBLIC_SENSITIVE.some((s) => p.includes(s))) count++;
      }
      if (count > 1) {
        res.status(429).json({ error: "لا يُسمح بحشو نقاط عامّة حسّاسة في دفعة واحدة." });
        return;
      }
    }
    next();
  });
  // maxBatchSize: يحدّ حجم دفعة tRPC الواحدة ⇒ سطح هجوم batch محدّد. خفّضناه من 50 إلى 20
  // لأن الواجهة الفعلية لا تتجاوز ~10 نداءات متوازية، والـ20 احتياطٌ مريح.
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext, maxBatchSize: 20 }));

  // جسر الطباعة الصامتة (خارج tRPC): يستقبل بايتات ESC/POS من العميل ويرسلها للطابعة محلياً.
  // محمي بالمصادقة (كوكي الجلسة) + csrfGuard (فحص Origin) — دفاع عميق فوق sameSite:"strict"
  // لأن /raw و /test يغيّران الحالة (طباعة فعلية + قد يُشغّلان copy للمشاركة).
  app.use("/api/print", csrfGuard, printRouter());

  // تنزيل النسخ الاحتياطية لجهاز المدير (GET stream، محمي بالمدير + مسار آمن).
  app.use("/api/backups", csrfGuard, backupRouter());

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  // HOST يضيّق واجهة الاستماع: على VPS خلف nginx اضبط HOST=127.0.0.1 فلا يُكشف المنفذ للإنترنت
  // ولا يُلتفّ على ترويسات nginx الأمنية (G6). غير مضبوط ⇒ كل الواجهات (سلوك المتجر/التطوير كما كان).
  const host = process.env.HOST || undefined;
  const port = await findAvailablePort(preferredPort, host);
  if (port !== preferredPort) {
    if (!isDev) {
      // nginx/العملاء مثبّتون على PORT — الانزياح الصامت يعني 502 صامتاً والتطبيق «online»؛ فشل صريح أوضح.
      logger.error(`المنفذ ${preferredPort} مشغول — أوقفنا الإقلاع بدل الانزياح الصامت (nginx مثبّت عليه).`);
      process.exit(1);
    }
    logger.warn(`Port ${preferredPort} busy, using ${port} instead`);
  }
  if (!isDev && !host) {
    logger.warn("إنتاج بلا HOST — الاستماع على كل الواجهات؛ خلف nginx اضبط HOST=127.0.0.1.");
  }

  // Listen BEFORE attaching Vite: the API binds immediately and a slow Vite
  // startup never blocks the server from accepting requests.
  await new Promise<void>((resolve) =>
    host ? server.listen(port, host, () => resolve()) : server.listen(port, () => resolve())
  );
  logger.info(`Server running on http://${host ?? "localhost"}:${port}/ ${sentryEnabled ? "(Sentry on)" : ""}`);

  // إيقاف رشيق: SIGTERM (من PM2/خدمة Windows عند إعادة التشغيل) وSIGINT (Ctrl+C) ⇒ أغلق
  // الخادم والقاعدة برفق فلا تُبتر طلبات ولا تبقى اتصالات معلّقة عند انقطاع الكهرباء/الإقلاع.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal} — بدء الإغلاق الرشيق…`);
    const force = setTimeout(() => {
      logger.warn("تجاوز مهلة الإغلاق (10ث) — خروج قسري.");
      process.exit(1);
    }, 10_000);
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDb();
      clearTimeout(force);
      logger.info("أُغلق الخادم والقاعدة بسلام.");
      process.exit(0);
    } catch (e) {
      logger.error({ err: e }, "خطأ أثناء الإغلاق الرشيق");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

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

  // معالج أخطاء عام — يلتقط أي استثناء وصل للـExpress بدل إغراق السجلّ أو تعطّل الخادم.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled express error");
    if (!res.headersSent) {
      res.status(500).json({ error: "خطأ داخلي في الخادم" });
    }
  });
}

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
