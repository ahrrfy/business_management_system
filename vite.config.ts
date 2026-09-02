import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import {
  CHUNK_SIZE_WARNING_LIMIT_KB,
  chunkBudgetViolation,
  EXCEL_CHUNK_NAME,
  resolveViteEnvDir,
} from "./scripts/vite-build-contract.mjs";
import {
  STOREFRONT_SHELL_CHUNK_GLOB,
  storefrontPrivateImageNetworkMatcher,
  storefrontPublicImageCacheMatcher,
} from "./scripts/storefront-pwa-contract.mjs";

const projectRoot = path.resolve(import.meta.dirname);

function enforceBuildContracts(): Plugin {
  return {
    name: "enforce-build-contracts",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        const violation = chunkBudgetViolation(output);
        if (violation) this.error(violation);
      }
    },
  };
}

function enforceSentryBuildContract(
  clientDsn: string,
  missing: string[],
): Plugin {
  return {
    name: "enforce-sentry-build-contract",
    apply: "build",
    buildStart() {
      if (clientDsn && missing.length > 0) {
        this.error(`SENTRY_CLIENT_BUILD_NOT_READY:${missing.join(",")}`);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const envDir = resolveViteEnvDir(process.env, projectRoot);
  const fileEnvironment = envDir === false ? {} : loadEnv(mode, envDir, "");
  const environment = { ...fileEnvironment, ...process.env };
  const clientSentryDsn = environment.VITE_SENTRY_DSN_CLIENT?.trim() ?? "";
  const sentryAuthToken = environment.SENTRY_AUTH_TOKEN?.trim() ?? "";
  const sentryOrg = environment.SENTRY_ORG?.trim() ?? "";
  const sentryProject = environment.SENTRY_PROJECT?.trim() ?? "";
  const sentryRelease = environment.SENTRY_RELEASE?.trim() ?? "";
  const missingSentryBuildValues = clientSentryDsn
    ? [
        ["SENTRY_AUTH_TOKEN", sentryAuthToken],
        ["SENTRY_ORG", sentryOrg],
        ["SENTRY_PROJECT", sentryProject],
        ["SENTRY_RELEASE", sentryRelease],
      ].filter(([, value]) => !value).map(([key]) => key)
    : [];
  const sentryUploadEnabled =
    clientSentryDsn.length > 0 && missingSentryBuildValues.length === 0;

  return {
  plugins: [
    react(),
    tailwindcss(),
    enforceBuildContracts(),
    VitePWA({
      // الإصدار الجديد يثبت في الخلفية ويبقى waiting. هذا السلوك يمنع خلط حزم
      // إصدارين ويصون الإدخال الجاري؛ PwaUpdateManager يطلب قرار الموظف ثم
      // يرسل SKIP_WAITING بعد حفظ لقطة استرداد محلية.
      registerType: "prompt",
      includeAssets: ["favicon.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"],
      // PWA المتجر تحفظ قشرة /store فقط. بيانات المنتجات والأسعار والطلب تبقى شبكة فقط؛
      // لا ندّعي تشغيل التجارة كاملةً دون اتصال ولا نعيد صفحات ERP من fallback مخبّأ.
      workbox: {
        // حزمة القشرة المشتركة أكبر من 2MiB؛ الرفع يمنع إسقاط ملف واجهة لازم لفتح /store.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // precache مقصور على دخول التطبيق + Storefront واعتماداته المشتركة. أسماء الصفحات
        // الإدارية الأخرى لا تطابق هذه القائمة، فلا يتحول SW إلى نسخة أوفلاين كاملة للـERP.
        globPatterns: [
          "index.html",
          "assets/app-*.js",
          "assets/index-*.css",
          STOREFRONT_SHELL_CHUNK_GLOB,
          "assets/*.woff2",
        ],
        // استبعاد أصول ML الضخمة من precache الـSW: wasm الخاصّ بـonnxruntime (يُجمَّع عبر @imgly،
        // ~24م.ب) + أصول @imgly المستضافة ذاتياً في /imgly-assets — تتجاوز سقف 5م.ب وتُحمَّل عند
        // الطلب (مسار CUT) لا من الـSW. بدونه يفشل بناء الإنتاج (vite-plugin-pwa). راجع
        // client/src/lib/imageStudio/README.md.
        globIgnores: ["**/ort-*.wasm", "**/imgly-assets/**"],
        // حقن معالج Web Push المخصَّص في SW المولَّد (دون التخلّي عن generateSW — يُبقي
        // آليّة autoUpdate وworkbox precache/runtimeCaching كما هي). الملف في public/ ⇒ يُنسَخ
        // إلى /push-handler.js حرفياً، فيصير مُتاحاً لـimportScripts داخل SW.
        importScripts: ["/pwa-update-worker.js", "/push-handler.js"],
        // تفعيل الإصدار الجديد لا يتم إلا برسالة SKIP_WAITING من الموظف. الإعداد
        // الافتراضي false يضيف مستقبل الرسالة الآمن في Workbox.
        skipWaiting: false,
        clientsClaim: false,
        cleanupOutdatedCaches: true,
        navigateFallback: "/index.html",
        // قشرة Storefront وحدها قابلة للفتح من precache. كل مسار آخر يحتاج الخادم.
        navigateFallbackAllowlist: [/^\/store(?:\/|$)/],
        runtimeCaching: [
          {
            // صور inventory/count/kiosk تعتمد على جلسة أو تكليف أو جهاز. يجب أن تصل إلى
            // بوابة الخادم كل مرة؛ CacheStorage لا يجوز أن يعيد رداً صادراً لمستخدم سابق.
            urlPattern: storefrontPrivateImageNetworkMatcher,
            handler: "NetworkOnly",
            options: { cacheName: "private-images-no-cache" },
          },
          {
            // الاستثناء المخبّأ محصور في نقاط الصور العامة المعلنة في imageRoute:
            // banner وproduct وcompany/:companyCode/product فقط. يحمل الرابط بصمة المحتوى.
            urlPattern: storefrontPublicImageCacheMatcher,
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
            // كل API آخر، بما فيه أي مسار صورة خاص جديد، شبكة فقط افتراضياً.
            urlPattern: ({ url }) => url.pathname.startsWith("/api"),
            handler: "NetworkOnly",
            options: { cacheName: "api-no-cache" },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/assets"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "static-assets" },
          },
        ],
      },
      manifest: {
        id: "/store",
        name: "مكتبة العربية",
        short_name: "مكتبة العربية",
        description: "قرطاسية وطباعة وهدايا مع توصيل داخل العراق والدفع عند الاستلام.",
        lang: "ar",
        dir: "rtl",
        theme_color: "#1e4a63",
        background_color: "#fff8ef",
        display: "standalone",
        start_url: "/store",
        // هوية التطبيق المثبّت ومساراته للمتجر فقط. يبقى SW على الجذر لأن Web Push
        // الحالي مشترك، لكن navigation fallback وprecache أعلاه لا يقدّمان ERP أوفلاين.
        scope: "/store",
        categories: ["shopping", "business"],
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
    enforceSentryBuildContract(clientSentryDsn, missingSentryBuildValues),
    ...(sentryUploadEnabled
      ? [
          sentryVitePlugin({
            org: sentryOrg,
            project: sentryProject,
            authToken: sentryAuthToken,
            telemetry: false,
            release: {
              name: sentryRelease,
              inject: true,
              setCommits: false,
            },
            sourcemaps: {
              assets: "./dist/public/assets/**",
              filesToDeleteAfterUpload: "./dist/public/**/*.map",
            },
          }),
        ]
      : []),
  ],
  define: {
    "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(
      sentryUploadEnabled ? sentryRelease : "",
    ),
  },
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "client", "src"),
      "@shared": path.resolve(projectRoot, "shared"),
    },
  },
  // مرشح النشر يرث VITE_* العامة صراحةً من المتحكّم، ولا يطلب من Vite قراءة
  // ملف إنتاج يحوي NODE_ENV وأسرار الخادم. التطوير المحلي يبقى على السلوك المعتاد.
  envDir,
  root: path.resolve(projectRoot, "client"),
  publicDir: path.resolve(projectRoot, "client", "public"),
  build: {
    // الخرائط لا تُولَّد إلا عندما يكون رفع Sentry كاملاً؛ hidden تمنع نشر رابطها في JS،
    // وfilesToDeleteAfterUpload يحذفها من artifact العام بعد نجاح الرفع.
    sourcemap: sentryUploadEnabled ? "hidden" : false,
    // بوابة artifact تستخدم مخطط Vite الرسمي لإغلاق imports الثابتة لقشرة Storefront.
    manifest: true,
    outDir: path.resolve(projectRoot, "dist/public"),
    emptyOutDir: true,
    // ExcelJS حزمة تصدير اختيارية معزولة (~937KB). نرفع تحذير Vite العام لها فقط عملياً،
    // بينما enforceBuildContracts يبقي كل حزمة أخرى تحت 500KB وExcel تحت 950KB.
    chunkSizeWarningLimit: CHUNK_SIZE_WARNING_LIMIT_KB,
    rollupOptions: {
      output: {
        // اسمٌ مميز لدخول SPA يمنع glob قشرة PWA من التقاط أي chunk آخر اسمه index
        // (مثل مكتبة ماسح الباركود) لمجرد تشابه الاسم.
        entryFileNames: "assets/app-[hash].js",
        manualChunks(id) {
          // كل أيقونات lucide في حُزمة واحدة بدل ~٨٠ ملفاً صغيراً. كان كل أيقونة حُزمةً
          // منفصلة ⇒ كل صفحة تطلب عشرات ملفات الأصول دفعةً واحدة، فتُشبع خادم الأصول
          // (Express + compression على threadpool ٤ خيوط) وتتعلّق الطلبات على «جار التحميل».
          if (id.includes("node_modules/lucide-react")) return "icons";
          // الرسوم البيانية (~400KB) تُستعمل عند فتح لوحات التحليل فقط. عزل Recharts
          // يمنع ابتلاعها داخل حزمة صفحة الخزينة وتجاوز سقف 500KB لبقية الشاشات.
          if (id.includes("node_modules/recharts")) return "charts";
          // حزمة Excel ضخمة (~936KB) ومطلوبة فقط عند التصدير ⇒ افصلها كي لا تُثقل أي صفحة أخرى.
          if (id.includes("node_modules/exceljs")) return EXCEL_CHUNK_NAME;
          // مكتبات البنية المشتركة تتغير بوتيرة أبطأ من شيفرة النظام. فصلها يقلل
          // حجم الحزمة الأساسية ويحافظ على كاش المتصفح عند نشر تعديلات الشاشات.
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/") ||
            id.includes("/node_modules/wouter/")
          ) return "framework";
          if (
            id.includes("/node_modules/@tanstack/") ||
            id.includes("/node_modules/@trpc/") ||
            id.includes("/node_modules/superjson/")
          ) return "data-client";
          if (
            id.includes("/node_modules/@radix-ui/") ||
            id.includes("/node_modules/@floating-ui/") ||
            id.includes("/node_modules/cmdk/") ||
            id.includes("/node_modules/vaul/")
          ) return "ui-vendor";
          if (id.includes("/node_modules/@sentry/")) return "observability";
          if (id.includes("/node_modules/dexie/")) return "offline-store";
        },
      },
    },
  },
  server: {
    host: true,
    // Allow the temporary Manus preview proxy without accepting arbitrary Host headers.
    allowedHosts: [".manus.computer", "localhost"],
    // The preview consumes the current public storefront API; no database copy or mock catalog.
    proxy: {
      "/api": {
        target: "https://alarabiya.online",
        changeOrigin: true,
        secure: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  };
});
