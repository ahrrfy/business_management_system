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
  },
  server: {
    host: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
