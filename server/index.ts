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
import { isTrpcSurface, sendTrpcError, trpcAwareRateLimitHandler } from "./middleware/trpcError";
import { printRouter } from "./printRoute";
import { backupRouter } from "./backupRoutes";
import { channelWebhooksRouter, companyChannelWebhooksRouter } from "./routes/channelWebhooks";
import { tenancyMiddleware } from "./tenancy/expressMiddleware";

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
  //
  // ⚠️ عدد القفزات = 1 (لا القيمة المنطقية true): مع `true` يأخذ Express **أقصى يسار**
  // X-Forwarded-For (يتحكم بها العميل) كـreq.ip، فيتجاوز مهاجمٌ حدودَ المعدّل المبنية على IP
  // (count.auth PIN، auth.login، platformAdmin.login) بتدوير الترويسة في كل طلب — و
  // express-rate-limit يفهرس بـreq.ip. مع `1` يُطابق nginx واحداً ⇒ req.ip = IP العميل الحقيقي
  // كما يسجّله البروكسي ويُتجاهَل أي XFF محقون. (كانت 1 ثم صارت true بالخطأ في b757623.)
  const trustProxy = process.env.TRUST_PROXY === "1" || process.env.HOST === "127.0.0.1" ? 1 : false;
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

  // ردّ 429 موحَّد لكل محدِّدات المعدّل: على /api/trpc بغلاف tRPC الذي يفهمه العميل
  // (وإلا رمى «Unable to transform response from server» فحجب السبب الحقيقي عن
  // المستخدم — علّة دخول اللوحي ٤/٧)، وعلى بقية الأسطح `{error}` كما كانت.
  const rateLimitHandler = trpcAwareRateLimitHandler;

  // حدّ عام للطلبات (حماية من الإغراق).
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.RATE_LIMIT_MAX ?? 1000),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: rateLimitHandler("محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة."),
      // لا تَعُدّ الأصول الساكنة المُجزّأة (immutable، تُخبَّأ في المتصفّح) ضمن الحدّ:
      // فتح أي صفحة يجلب عشرات حُزَم الأصول دفعةً ⇒ كان يستنزف حدّ المعدّل ويُعلّق التحميل.
      skip: (req) => req.path.startsWith("/assets/"),
    })
  );

  // HTTP compression (gzip/brotli) — مهم على الشبكات البطيئة (العراق).
  app.use(compression());

  // حجم الجسم: ١mb افتراضياً لكل المسارات (سطح هجوم DoS أصغر على /auth.login وغيرها).
  // الاستثناء الوحيد: /api/print/raw يرفع لـ١٠mb لأن العميل يرسل raster ESC/POS كبير
  // (نقطية الإيصال العربي مُولَّدة على Canvas) — لا حدّ ١mb لأنه يقطع الطباعة الفعلية.
  app.use("/api/print/raw", express.json({ limit: "10mb" }));
  // attachment-upload (٥/٧): سند بمرفق صورة (data URL مضغوطة حتى ٧٠٠ك ⇒ ~٩٣٣ك نصاً) قد يُقارب/يتجاوز
  // ١mb مع بقية حمولة السند. استثناء مماثل لـ/api/print/raw أعلاه — لكن بفحص substring لا مسار ثابت
  // (batch tRPC قد يُجمِّع عدّة إجراءات في مسار واحد ك"vouchers.create,other").
  app.use("/api/trpc", (req, res, next) => {
    if (req.path.includes("vouchers.create")) {
      return express.json({ limit: "3mb" })(req, res, next);
    }
    // #9 (تدقيق التثبيت): system.restoreUpload يستقبل ملف نسخة احتياطية base64. الخدمة تقبل حتى
    // ٢٠٠MB مفكوكاً (maintenanceService.MAX_UPLOAD_BYTES) لكن هذا الوسيط كان يحبس عند ١MB ⇒ النسخ
    // الحقيقية لا تُستعاد أبداً. adminProcedure + كلمة مرور + رمز تأكيد ⇒ سطح DoS محدود بحساب مدير
    // متحقَّق. الحدّ = 300mb (يسع ٢٠٠MB مفكوكاً بحاشية base64 ~٣٣٪) وقابل للتجاوز عبر ENV للنموّ.
    if (req.path.includes("system.restoreUpload")) {
      return express.json({ limit: process.env.RESTORE_UPLOAD_LIMIT ?? "300mb" })(req, res, next);
    }
    next();
  });
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
  // ٦/٧/٢٦: كان ١٠ طلبات/١٥د لكل IP **يَعُدّ الناجح والفاشل معاً** — وكل أجهزة المتجر خلف
  // راوتر واحد = IP عام واحد يتشارك الميزانية، فصباح عمل عادي (عدة أجهزة + جلسات ١٢ ساعة
  // تنتهي معاً) كان يُطلق 429 يُقرأ «قفل حساب». الآن: الفشل وحده يُحسب (skipSuccessfulRequests)
  // والافتراضي ٣٠ فشلاً/١٥د لكل IP — عدّاد التطبيق (شركة×IP، ٢٠/١٥د في authRouter) يبقى
  // خطّ الدفاع الأدقّ ويُطلق قبله برسالة أوضح + أثر تدقيق.
  app.use(
    "/api/trpc",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 30),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => !req.path.includes("auth.login"),
      skipSuccessfulRequests: true,
      handler: rateLimitHandler("محاولات دخول كثيرة، انتظر ١٥ دقيقة ثم أعد المحاولة."),
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
      handler: rateLimitHandler("محاولات دخول كثيرة لبوابة العدّ، انتظر ١٥ دقيقة."),
    })
  );

  // حدّ صارم على دخول مدير المنصّة (تعدد الشركات) — إجراء مُميَّز (تفعيل/تعطيل أي شركة)
  // كان بلا أي حدّ خاص (مراجعة عدائية حسمت هذا — الحدّ العام ١٠٠٠/١٥د فقط لا يكفي لصدّ
  // credential stuffing على نقطة دخول مُميَّزة).
  app.use(
    "/api/trpc",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.PLATFORM_ADMIN_RATE_LIMIT_MAX ?? 10),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => !req.path.includes("platformAdmin.login"),
      handler: rateLimitHandler("محاولات دخول كثيرة، انتظر ١٥ دقيقة."),
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
      handler: rateLimitHandler("محاولات كثيرة لتفعيل جهاز الكشك، انتظر قليلاً."),
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
      handler: rateLimitHandler("طلبات تقديم كثيرة، انتظر قليلاً ثم أعد المحاولة."),
    })
  );

  // حدّ على سطح المتجر العلني (storefront.*) — قراءة آمنة بلا مصادقة على الإنترنت ⇒ حماية من
  // الكشط/الإغراق. سخيّ لأنه تصفّح (بطاقات + بحث + صفحة منتج) لكن مسقوف لكل IP.
  app.use(
    "/api/trpc",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.STOREFRONT_RATE_LIMIT_MAX ?? 600),
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (req) => !req.path.includes("storefront."),
      handler: rateLimitHandler("طلبات كثيرة على المتجر، انتظر قليلاً ثم أعد المحاولة."),
    })
  );

  // حماية CSRF (طبقة دفاع ثانية فوق sameSite:"strict").
  app.use("/api/trpc", csrfGuard);

  // حدّ صلب فوقي على الدفعات (tRPC batch link): يرفض الطلب إن حوى أكثر من حدّ تصاعدي على
  // إجراء عام واحد قبل وصوله للراوتر، فيقفل نمط تضخيم تجاوز حدّ المعدّل (نمط جذري ٥):
  // كان rateLimit يَعدّ HTTP requests لا الإجراءات؛ batch link يحشو عشرات النداءات في طلب واحد
  // فيسمح بـ٥٠ محاولة auth.login/count.auth/kiosk.deviceLogin/recruitment.submit/platformAdmin.login
  // ضمن طلب واحد قبل اصطدامه بحدّ المعدّل. الحدّ التالي للنقاط العامة الحرجة لا يسمح بأكثر من
  // نداء واحد لكلّ طلب HTTP، فحدّ المعدّل القائم يعمل بدقّته الحقيقية بلا تمييع.
  app.use("/api/trpc", (req, res, next) => {
    const PUBLIC_SENSITIVE = ["auth.login", "count.auth", "kiosk.deviceLogin", "recruitment.submit", "platformAdmin.login"];
    // مسار البَتش يبدأ بـ"/api/trpc/x," مع فاصلة بين أسماء الإجراءات الموحَّدة.
    const path = req.path || "";
    if (path.includes(",")) {
      const procs = path.split("/").pop()?.split(",") ?? [];
      let count = 0;
      for (const p of procs) {
        if (PUBLIC_SENSITIVE.some((s) => p.includes(s))) count++;
      }
      if (count > 1) {
        sendTrpcError(res, {
          httpStatus: 429,
          code: "TOO_MANY_REQUESTS",
          message: "لا يُسمح بحشو نقاط عامّة حسّاسة في دفعة واحدة.",
        });
        return;
      }
    }
    next();
  });
  // تحديد الشركة الحالية (تعدّد الشركات) — قبل إنشاء سياق tRPC/معالجة الطباعة/النسخ
  // الاحتياطية. يفكّ الجلسة (JWT فقط، بلا فحص بصمة — يحدث لاحقاً بالكامل داخل
  // getUserFromRequest) لاستخراج companyId مبكراً، يُحضّر اتصال قاعدة تلك الشركة ثم يُغلّف
  // بقية معالجة الطلب بسياقها — فيُوجَّه كل getDb() لاحق تلقائياً لقاعدتها الصحيحة بلا أي
  // تعديل في تلك الطبقات. مُشترَك (server/tenancy/expressMiddleware.ts) بين الأسطح الثلاثة
  // المصادَق عليها بنفس كوكي جلسة الشركة. بلا CONTROL_DATABASE_URL: تمريرة شفّافة تماماً.
  const tenancy = tenancyMiddleware();

  app.use("/api/trpc", tenancy);
  // maxBatchSize: يحدّ حجم دفعة tRPC الواحدة ⇒ سطح هجوم batch محدّد. خفّضناه من 50 إلى 20
  // لأن الواجهة الفعلية لا تتجاوز ~10 نداءات متوازية، والـ20 احتياطٌ مريح.
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext, maxBatchSize: 20 }));

  // جسر الطباعة الصامتة (خارج tRPC): يستقبل بايتات ESC/POS من العميل ويرسلها للطابعة محلياً.
  // محمي بالمصادقة (كوكي الجلسة) + csrfGuard (فحص Origin) — دفاع عميق فوق sameSite:"strict"
  // لأن /raw و /test يغيّران الحالة (طباعة فعلية + قد يُشغّلان copy للمشاركة).
  app.use("/api/print", tenancy, csrfGuard, printRouter());

  // تنزيل النسخ الاحتياطية لجهاز المدير (GET stream، محمي بالمدير + مسار آمن). في وضع تعدد
  // الشركات: backupRoutes.ts/systemRouter.ts يُقيَّدان لملفات الشركة الحالية فقط (بادئة اسم
  // قاعدتها) — راجع server/services/maintenanceService.ts.
  app.use("/api/backups", tenancy, csrfGuard, backupRouter());

  // Webhooks خارِجية لِلقَنوات (شَريحة #5): WhatsApp/Instagram/Store.
  // ⚠️ لا csrfGuard هُنا — webhooks تَأتي مِن مُزوّدين خارِجيين بَلا كوكي/Origin، ولا
  // tenancyMiddleware (لا كوكي جلسة إطلاقاً) — الأَمان يُطبَّق عبر HMAC verify داخل كل route.
  // نشر أحادي الشركة: كما كان تماماً على /api/webhooks. تعدد الشركات: مسار إضافي بادئته
  // رمز الشركة صراحةً في الرابط نفسه (لا كوكي ليُستخرَج منه) — راجع channelWebhooks.ts.
  app.use("/api/webhooks", channelWebhooksRouter());
  app.use("/api/webhooks/company/:companyCode", companyChannelWebhooksRouter());

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

  // جدولة إشعار «برنامج اليوم» الصباحي (Web Push) — تُفعَّل فقط حين VAPID keys مُهيّأة في .env.
  // غيابها ⇒ الخدمة تُسجّل «disabled» وتصمت، لا انهيار (تعمل جميع بقية المسارات).
  const { startMorningPushCron } = await import("./services/morningPushScheduler");
  startMorningPushCron();

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
  // على /api/trpc يرسل غلاف tRPC (وإلا رمى العميل «Unable to transform response from
  // server» — نفس فئة علّة دخول اللوحي): أخطاء body-parser تمرّ من هنا، وأقربها للواقع
  // جسم يتجاوز حدّ ١mb (صورة منتج base64) ⇒ 413 برسالة عربية بدل 500 غامض.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled express error");
    if (res.headersSent) return;
    const rawStatus = (err as { status?: unknown; statusCode?: unknown } | null);
    const status =
      typeof rawStatus?.status === "number" ? rawStatus.status
      : typeof rawStatus?.statusCode === "number" ? rawStatus.statusCode
      : 500;
    const mapped =
      status === 413
        ? { httpStatus: 413, code: "PAYLOAD_TOO_LARGE" as const, message: "حجم الطلب كبير جداً — صغّر المرفق/الصورة ثم أعد المحاولة." }
        : status >= 400 && status < 500
          ? { httpStatus: status, code: "BAD_REQUEST" as const, message: "طلب غير صالح." }
          : { httpStatus: 500, code: "INTERNAL_SERVER_ERROR" as const, message: "خطأ داخلي في الخادم" };
    if (isTrpcSurface(req)) {
      sendTrpcError(res, mapped);
    } else {
      res.status(mapped.httpStatus).json({ error: mapped.message });
    }
  });
}

startServer().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
