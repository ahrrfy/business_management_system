// PM2 - إدارة عملية الخادم في الإنتاج
// التثبيت: npm install -g pm2
// التشغيل: pm2 start ecosystem.config.cjs
// الإيقاف: pm2 stop erp-server
// السجلّات: pm2 logs erp-server
// لوحة: pm2 monit
// إعداد الإقلاع التلقائي (يُنفَّذ مرة واحدة بصلاحيات مدير):
//   pm2 startup windows
//   pm2 save
//
// تلميح: إن عطل Docker Desktop، تأكّد أن erp-mysql يعمل أولاً.
//   docker start erp-mysql  (يدوياً عند الحاجة)
//   أو شغّل scripts\docker-watchdog.mjs كمهمة ساعية في Task Scheduler.
//
// ⚠️ erp-provision-worker (تعدّد الشركات فقط — لا يُفعَّل بلا CONTROL_DATABASE_URL):
// عملية **منفصلة تماماً** عن erp-server، بصلاحيات مرتفعة (docker exec + كلمة سرّ MySQL
// الجذر) لا يملكها خادم الويب أبداً — راجع تعليق companyProvisionRequests في
// server/tenancy/controlSchema.ts. **لا تنسخ متغيّرات env هذا التطبيق إلى erp-server أبداً**
// (يُلغي كامل الفصل الأمني الذي بُني من أجله). يتطلّب DB_CONTAINER/DB_ROOT_PW/
// INTEGRATIONS_ENCRYPTION_KEY في `.env` (أو env هذا القسم مباشرة) — غير مضبوطة افتراضياً.

const path = require("node:path");
const dotenv = require("dotenv");
const artifactSmoke =
  process.env.HR_BRIDGE_ECOSYSTEM_ARTIFACT_SMOKE === "1";
dotenv.config({ quiet: true });

// PM2 merges the ecosystem loader's process.env into every app. Merely omitting
// privileged keys from erp-server.env is therefore insufficient: dotenv has
// already populated them before PM2 reads this file. Snapshot the two values
// needed by the isolated provision worker, then remove all bootstrap/root-only
// values from the loader environment before exporting the web definition.
const provisionPrivilegedEnvironment = Object.freeze({
  DB_CONTAINER: process.env.DB_CONTAINER,
  DB_ROOT_PW: process.env.DB_ROOT_PW,
});
const webForbiddenEnvironmentKeys = Object.freeze([
  "DB_ROOT_PW",
  "DB_CONTAINER",
  "DB_APP_PW",
  "DB_CONTROL_PW",
  "ADMIN_PASSWORD",
]);
for (const key of webForbiddenEnvironmentKeys) delete process.env[key];
// The mutable root ecosystem never launches the production bridge. A source
// definition exists only while the build gate inspects its PM2 contract.
let artifactSmokeBridgeApp = null;
if (artifactSmoke) {
  const policy = require("./scripts/hr-bridge-runtime-policy.cjs");
  const createHrBridgePm2App = require("./scripts/hr-bridge-pm2-app.cjs");
  const bridgeFileEnvironment = {};
  const bridgeEnvironmentResult = dotenv.config({
    path: path.join(__dirname, ".env.example"),
    processEnv: bridgeFileEnvironment,
    quiet: true,
  });
  if (bridgeEnvironmentResult.error) {
    throw new Error("HR_BRIDGE_ENV_FILE_NOT_READABLE");
  }
  const artifactEnvironment = Object.fromEntries(
    policy.allowedEnvironmentKeys
      .filter((key) => typeof bridgeFileEnvironment[key] === "string")
      .map((key) => [key, bridgeFileEnvironment[key]]),
  );
  artifactEnvironment.NODE_ENV = "production";
  artifactEnvironment.TZ = "UTC";
  artifactEnvironment.HR_BRIDGE_LOAD_DOTENV = "0";
  artifactSmokeBridgeApp = createHrBridgePm2App({
    projectRoot: __dirname,
    script: "scripts/hr-bridge-release-worker.mjs",
    policy,
    deploymentEnvironment: artifactEnvironment,
  });
}

module.exports = {
  apps: [
    {
      name: "erp-server",
      script: "dist/index.js",
      cwd: __dirname,
      // ── توزيع الأحمال داخل الخادم (cluster) ────────────────────────────────────────────
      // عدّة عمّال يتقاسمون الطلبات على نوى المعالج ⇒ طاقةٌ أعلى تحت الذروة (٧ كاشيرات + كل
      // الموظفين والحسابات) + مقاومةُ انهيار (سقوطُ عاملٍ لا يُسقط الخدمة — الباقون يخدمون) +
      // إعادةُ تحميلٍ متدحرجة بلا انقطاع (pm2 reload). الكنّاسات والكرون تعمل في العامل 0 فقط
      // (server/lib/clusterRole.ts) فلا تتكرّر. جسر أجهزة الحضور مفصول في erp-hr-bridge
      // (عملية fork واحدة) ولا يملك erp-server منفذ الأجهزة أو وصلاتها الحيّة.
      // ⚠️ الخادم مشترك (سراج/أودو خطّ أحمر) — الافتراضي عاملَان (لا "max") كي لا نستنزف نوى
      // الجيران؛ ارفعه بحذر عبر WEB_INSTANCES=3 بعد مراقبة الحِمل. **ميزانية اتصالات القاعدة:**
      // كل عامل يفتح حتى DB_POOL_LIMIT اتصالاً لكل شركة نشطة، لكن db.ts يحدّ عدد التجمعات
      // الساخنة ويُخلي الخامل منها. الافتراض: ٢×١٠×٥=١٠٠ اتصال، مع احتياطي ٢٠ من أصل ١٥١؛
      // ويَرفض الخادم ميزانية إعداد تتجاوز MYSQL_MAX_CONNECTIONS بدلاً من السقوط تحت الحمل.
      instances: process.env.WEB_INSTANCES || 2,
      exec_mode: "cluster",
      watch: false,
      // ⚠️ مؤقّت (٤/٨/٢٦): رُفع من 512M إلى 1024M. السقف القديم كان يُعاد ضربه **كل ٦٠ ثانية**
      // في الإنتاج (‏`[PM2][WORKER] … exceeds --max-memory-restart` عند ~٦٠٠م)، فيُعاد تشغيل
      // الخادم ١٥–٢٣ مرّة/ساعة وتُسقَط الطلبات الجارية — بلا أيّ انهيارٍ حقيقيّ (صفر خروجٍ بكودٍ
      // غير صفر). العملية تبدأ ~٣٠٠م وتبلغ ٦٠٠م خلال دقيقة، وهو نموٌّ أسرع من أن يكون تسرّباً
      // بطيئاً؛ الفرضية أنّ ٥١٢م أدنى من سلوك V8 الطبيعيّ (يؤجّل الكنس الكبير حتى ضغطٍ أعلى)
      // فيقاتل PM2 جامعَ المهملات لا تسرّباً. الخادم ١٦ﺟ ومتاحٌ منه ~١٣ﺟ ⇒ 1024M آمنٌ بفارق واسع.
      // يبقى **محدوداً عمداً** كي يظلّ تسرّبٌ حقيقيّ مكشوفاً (إن عاد الضرب فالنموّ حقيقيّ لا كسل GC).
      max_memory_restart: "1024M",
      // أعِد التشغيل تلقائياً عند الانهيار (مع تأخير متزايد).
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
      // Defense in depth for PM2 daemon environments retained across reloads.
      // The one-time production migration recreates erp-server so stale keys
      // are removed; subsequent reloads cannot re-introduce these prefixes.
      filter_env: webForbiddenEnvironmentKeys,
      // إيقاف رشيق: امنح الخادم 10ث لإغلاق الاتصالات بعد SIGINT قبل القتل القسري (SIGKILL).
      kill_timeout: 11000,
      env: {
        NODE_ENV: "production",
        // منطقة العملية UTC لتطابق جلسة القاعدة (UTC) ⇒ فلترة التواريخ حتمية مستقلّة عن منطقة المضيف.
        TZ: "UTC",
        // ارفع threadpool الافتراضي (٤) كي تتحمّل عملية Node دفعات طلبات الأصول المتزامنة:
        // express.static (fs.readFile) و compression (gzip) يتشاركان نفس الـpool، فدفعة ٨٠+
        // طلب أصل عند فتح صفحة كانت تُشبع الخيوط الأربعة وتُعلّق الطلبات على «جار التحميل».
        UV_THREADPOOL_SIZE: "16",
        PORT: process.env.PORT || 3000,
        HOST: process.env.HOST || "127.0.0.1",
        ALLOW_PUBLIC_BIND: process.env.ALLOW_PUBLIC_BIND || "0",
        REQUIRE_INTERNAL_PROXY_SECRET: process.env.REQUIRE_INTERNAL_PROXY_SECRET || "0",
        INTERNAL_PROXY_SECRET: process.env.INTERNAL_PROXY_SECRET,
        // يطابق عدد عمّال الويب المقصود في `instances` أعلاه.
        WEB_INSTANCES: String(process.env.WEB_INSTANCES || 2),
        DATABASE_URL: process.env.DATABASE_URL,
        JWT_SECRET: process.env.JWT_SECRET,
        // عمداً بلا CONTROL_DATABASE_URL/DB_ROOT_PW/docker — خادم الويب لا يوفّر شركات أبداً.
      },
      // التقاط السجلّات إلى ملفات دوّارة (يحتاج pm2-logrotate).
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/erp-error.log",
      out_file: "logs/erp-out.log",
      merge_logs: true,
    },
    ...(artifactSmokeBridgeApp ? [artifactSmokeBridgeApp] : []),
    {
      name: "erp-provision-worker",
      script: "scripts/company-provision-worker.mjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      // single-shot: يعالج كل الطلبات المعلَّقة ثم يخرج — لا daemon مستمرّ. cron_restart
      // يُعيد تشغيله دورياً بدل حلقة داخلية (أبسط: لا حالة معلّقة بين التشغيلات).
      autorestart: false,
      cron_restart: "*/2 * * * *", // كل دقيقتين — التوفير عملية نادرة، لا حاجة لأسرع.
      env: {
        NODE_ENV: "production",
        TZ: "UTC",
        CONTROL_DATABASE_URL: process.env.CONTROL_DATABASE_URL,
        INTEGRATIONS_ENCRYPTION_KEY: process.env.INTEGRATIONS_ENCRYPTION_KEY,
        DB_CONTAINER: provisionPrivilegedEnvironment.DB_CONTAINER || "erp-mysql",
        DB_ROOT_PW: provisionPrivilegedEnvironment.DB_ROOT_PW,
        DATABASE_URL: process.env.DATABASE_URL, // يُستعمَل فقط لاستنتاج host/port الافتراضيَّين لقواعد الشركات الجديدة.
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/provision-worker-error.log",
      out_file: "logs/provision-worker-out.log",
      merge_logs: true,
    },
  ],
};
