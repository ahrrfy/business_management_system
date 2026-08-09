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

require("dotenv").config();

const configuredHrDevicePort = Number(process.env.HR_DEVICE_PORT || "0");
const hrBridgeEnabled =
  (process.env.HR_DEVICE_BRIDGE === "1" ||
    (Number.isInteger(configuredHrDevicePort) && configuredHrDevicePort > 0)) &&
  !process.env.CONTROL_DATABASE_URL;

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
      // كل عامل يفتح حتى DB_POOL_LIMIT اتصالاً **لكل شركة**؛ في الوضع الأحادي = (عدد العمّال ×
      // DB_POOL_LIMIT)، وفي وضع تعدّد الشركات (CONTROL_DATABASE_URL) = (عدد العمّال × عدد الشركات
      // × DB_POOL_LIMIT). احرص أن يبقى دون max_connections في MySQL (الافتراضي 151): ٢×٢٠=٤٠ آمن
      // أحاديّاً، لكن ٢ عامل × ٤ شركات × ٢٠ = ١٦٠ يتجاوزه ⇒ اخفض DB_POOL_LIMIT أو ارفع max_connections.
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
    {
      name: "erp-hr-bridge",
      script: "scripts/hr-bridge-worker.mjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: hrBridgeEnabled,
      exp_backoff_restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 11000,
      env: {
        NODE_ENV: "production",
        TZ: "UTC",
        DATABASE_URL: process.env.DATABASE_URL,
        CONTROL_DATABASE_URL: process.env.CONTROL_DATABASE_URL,
        HR_DEVICE_BRIDGE: process.env.HR_DEVICE_BRIDGE,
        HR_DEVICE_PORT: process.env.HR_DEVICE_PORT,
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/hr-bridge-error.log",
      out_file: "logs/hr-bridge-out.log",
      merge_logs: true,
    },
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
        DB_CONTAINER: process.env.DB_CONTAINER || "erp-mysql",
        DB_ROOT_PW: process.env.DB_ROOT_PW,
        DATABASE_URL: process.env.DATABASE_URL, // يُستعمَل فقط لاستنتاج host/port الافتراضيَّين لقواعد الشركات الجديدة.
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/provision-worker-error.log",
      out_file: "logs/provision-worker-out.log",
      merge_logs: true,
    },
  ],
};
