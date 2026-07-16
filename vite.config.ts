import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // حوكمة التحديث: 'autoUpdate' (كان 'prompt'). السبب (٢٩/٦): استراتيجية 'prompt' كانت
      // تُبقي المتصفّح على SW قديم بعد كل نشر حتى يضغط المستخدم «تحديث» يدوياً — لكنّ الـSW
      // القديم يقدّم index.html قديماً يشير إلى حُزَم (chunks) بمعرّفات لم تعد على الخادم ⇒
      // حُزَم الصفحات تفشل ⇒ «جار التحميل» للأبد (تعطّل إنتاجي بعد كل نشر، والمستخدم عالقٌ
      // قبل أن يرى زرّ التحديث أصلاً). 'autoUpdate' (مع skipWaiting/clientsClaim/تنظيف الكاش
      // القديم) يجعل الـSW الجديد يَنشط فوراً ويُنظّف الحُزَم الميّتة ⇒ لا تعليق بعد النشر.
      // (المقايضة: قد تُعاد تحميل صفحة مفتوحة مرّة عند اكتشاف نشر جديد ⇒ انشُر خارج ساعات الذروة.)
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"],
      // لا تُعطّل API: التنقّل يرجع لـindex.html، و/api لا يُخبّأ إطلاقاً (شبكة فقط).
      workbox: {
        // حزمة التطبيق أكبر من 2MiB ⇒ ارفع حدّ precache كي يُخبّأ التطبيق كاملاً (عمل دون اتصال).
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // ‏woff2 مُضافة للنمط الافتراضي (js/wasm/css/html): خطوط Cairo المستضافة ذاتياً في /fonts
        // تستعملها المطبوعات (brand.ts) وصفحة الوظائف — بدونها تُجلَب من الشبكة كل زيارة وتفشل دون اتصال.
        globPatterns: ["**/*.{js,wasm,css,html,woff2}"],
        // حقن معالج Web Push المخصَّص في SW المولَّد (دون التخلّي عن generateSW — يُبقي
        // آليّة autoUpdate وworkbox precache/runtimeCaching كما هي). الملف في public/ ⇒ يُنسَخ
        // إلى /push-handler.js حرفياً، فيصير مُتاحاً لـimportScripts داخل SW.
        importScripts: ["/push-handler.js"],
        // فعّل الـSW الجديد فوراً وتولَّ التحكّم بكل الألسنة المفتوحة، وامسح precache القديم
        // ⇒ لا تبقى حُزَم/index قديمة تشير لملفّات حُذِفت بالنشر الجديد (جذر علّة «جار التحميل»).
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: "/index.html",
        // الشاشات الحسّاسة لا تَرجع لـindex.html المُخبّأ + /api شبكة فقط.
        navigateFallbackDenylist: [
          /^\/api/,
          /^\/reports(\/|$)/,
          /^\/users(\/|$)/,
          /^\/settings(\/|$)/,
          /^\/expenses(\/|$)/,
          /^\/audit(\/|$)/,
        ],
        runtimeCaching: [
          {
            // ٠) /api/img/* — **استثناء وحيد مقصود** من قاعدة «لا تخبئة لـ/api» أدناه.
            // ليست بيانات: بايتات صورةٍ علنية للمتجر، ورابطها يحمل بصمة محتواها (v=<hash>)
            // ⇒ تغيّر الصورة = تغيّر الرابط = مفتاح كاش جديد، فلا تقادم ممكن أصلاً.
            // لولا هذا الاستثناء لظلّت الصور تُجلَب في كل تحميل رغم ترويسة immutable (السطر
            // التالي NetworkOnly كان يبتلع كل ما تحت /api). راجع server/imageRoute.ts.
            urlPattern: ({ url }) => url.pathname.startsWith("/api/img/"),
            handler: "CacheFirst",
            options: {
              cacheName: "store-images",
              // ٣٠٠ مُدخَلاً (كان ١٢٠ حين كانت البنرات وحدها): صور المنتجات انضمّت ⇒ صفحةُ
              // كتالوجٍ واحدة تجلب حتى ٦٠ صورة، فسقفُ ١٢٠ يطرد صور البنرات بعد تصفّح صفحتين
              // (LRU) فتُجلَب من جديد ⇒ يُبطل نصف المكسب بصمت. والطرد يبقى مضبوطاً بالسقف والعمر.
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 60 }, // ٦٠ يوماً
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // ١) /api/* — شبكة فقط مطلقاً (لا تَخبئة طلبات الـAPI تحت أي ظرف).
            urlPattern: ({ url }) => url.pathname.startsWith("/api"),
            handler: "NetworkOnly",
            options: { cacheName: "api-no-cache" },
          },
          {
            // ٢) الشاشات الحسّاسة (تَنقّل HTML): StaleWhileRevalidate بدل precache
            // ⇒ نَعرض النسخة المخبّأة فوراً ثم نُحدّثها بالخلفية، ولا نُجمّد إصداراً قديماً في precache.
            urlPattern: ({ request, url }) =>
              request.mode === "navigate" &&
              /^\/(reports|users|settings|expenses|audit)(\/|$)/.test(url.pathname),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "sensitive-pages",
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 }, // يوم واحد
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/assets"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "static-assets" },
          },
        ],
      },
      manifest: {
        name: "نظام إدارة الأعمال — الرؤية العربية",
        short_name: "الرؤية",
        description: "نظام إدارة أعمال المطبعة والقرطاسية — الرؤية العربية",
        lang: "ar",
        dir: "rtl",
        theme_color: "#2563eb",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // كل أيقونات lucide في حُزمة واحدة بدل ~٨٠ ملفاً صغيراً. كان كل أيقونة حُزمةً
          // منفصلة ⇒ كل صفحة تطلب عشرات ملفات الأصول دفعةً واحدة، فتُشبع خادم الأصول
          // (Express + compression على threadpool ٤ خيوط) وتتعلّق الطلبات على «جار التحميل».
          if (id.includes("node_modules/lucide-react")) return "icons";
          // حزمة Excel ضخمة (~936KB) ومطلوبة فقط عند التصدير ⇒ افصلها كي لا تُثقل أي صفحة أخرى.
          if (id.includes("node_modules/exceljs")) return "exceljs";
        },
      },
    },
  },
  server: {
    host: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
