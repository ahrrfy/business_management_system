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

require("dotenv").config();

module.exports = {
  apps: [
    {
      name: "erp-server",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "512M",
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
        DATABASE_URL: process.env.DATABASE_URL,
        JWT_SECRET: process.env.JWT_SECRET,
      },
      // التقاط السجلّات إلى ملفات دوّارة (يحتاج pm2-logrotate).
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/erp-error.log",
      out_file: "logs/erp-out.log",
      merge_logs: true,
    },
  ],
};
