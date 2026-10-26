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
  STOREFRONT_SHELL_CSS_GLOB,
  storefrontApiNetworkMatcher,
  storefrontPrivateImageNetworkMatcher,
  storefrontPublicImageCacheMatcher,
} from "./scripts/storefront-pwa-contract.mjs";

const projectRoot = path.resolve(import.meta.dirname);

function scanTopLevelCssStatements(
  css: string,
  startIndex = 0,
  endIndex = css.length,
): Array<{ start: number; end: number; text: string }> {
  const statements: Array<{ start: number; end: number; text: string }> = [];
  let i = startIndex;

  while (i < endIndex) {
    while (i < endIndex && /\s/.test(css[i]!)) i++;
    if (i >= endIndex) break;

    if (css[i] === "/" && css[i + 1] === "*") {
      const commentStart = i;
      i += 2;
      while (i < endIndex && !(css[i] === "*" && css[i + 1] === "/")) i++;
      i = Math.min(endIndex, i + 2);
      statements.push({
        start: commentStart,
        end: i,
        text: css.slice(commentStart, i),
      });
      continue;
    }

    const stmtStart = i;
    let depth = 0;
    while (i < endIndex) {
      const ch = css[i]!;
      if (ch === "/" && css[i + 1] === "*") {
        i += 2;
        while (i < endIndex && !(css[i] === "*" && css[i + 1] === "/")) i++;
        i = Math.min(endIndex, i + 2);
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < endIndex) {
          if (css[i] === "\\") {
            i += 2;
            continue;
          }
          if (css[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "{") {
        depth++;
        i++;
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        i++;
        if (depth === 0) break;
        continue;
      }
      if (ch === ";" && depth === 0) {
        i++;
        break;
      }
      i++;
    }

    statements.push({
      start: stmtStart,
      end: i,
      text: css.slice(stmtStart, i),
    });
  }

  return statements;
}

/**
 * Splits compiled ERP CSS (`@layer utilities { ... }`) cleanly at a top-level
 * rule boundary into two balanced chunks while preserving 100% of Tailwind's
 * canonical rule order (preventing cross-chunk `@media` / shorthand regressions).
 */
export function splitCompiledErpUtilitiesCss(compiledCss: string): {
  part1: string;
  part2: string;
} {
  const topStatements = scanTopLevelCssStatements(compiledCss);
  const innerUtilityRules: string[] = [];
  const prefixStatements: string[] = [];
  const suffixStatements: string[] = [];
  let seenUtilitiesBlock = false;

  for (const stmt of topStatements) {
    const trimmed = stmt.text.trim();
    if (/^@layer\s+utilities\b[\s{]/.test(trimmed) && trimmed.endsWith("}")) {
      seenUtilitiesBlock = true;
      const openBrace = stmt.text.indexOf("{");
      const closeBrace = stmt.text.lastIndexOf("}");
      const inner = scanTopLevelCssStatements(
        stmt.text,
        openBrace + 1,
        closeBrace,
      );
      for (const rule of inner) {
        if (rule.text.trim().length > 0) {
          innerUtilityRules.push(rule.text);
        }
      }
    } else if (!seenUtilitiesBlock) {
      prefixStatements.push(stmt.text);
    } else {
      suffixStatements.push(stmt.text);
    }
  }

  if (innerUtilityRules.length < 2) {
    return {
      part1: compiledCss,
      part2: "@layer properties;",
    };
  }

  const prefix = prefixStatements.join("");
  const suffix = suffixStatements.join("");
  const ruleByteLengths = innerUtilityRules.map((rule) =>
    Buffer.byteLength(rule),
  );
  const totalInnerBytes = ruleByteLengths.reduce((acc, b) => acc + b, 0);
  const suffixBytes = Buffer.byteLength(suffix);
  const targetPart1InnerBytes = Math.min(
    totalInnerBytes - 1,
    Math.floor((totalInnerBytes + suffixBytes) / 2),
  );

  let runningBytes = 0;
  let splitIndex = 1;
  for (let idx = 0; idx < ruleByteLengths.length - 1; idx++) {
    runningBytes += ruleByteLengths[idx]!;
    splitIndex = idx + 1;
    if (runningBytes >= targetPart1InnerBytes) break;
  }

  const sharedLayerHeader = prefix.includes("@layer properties")
    ? prefix
    : `@layer properties;${prefix}`;

  return {
    part1: `${sharedLayerHeader}@layer utilities{${innerUtilityRules.slice(0, splitIndex).join("")}}`,
    part2: `@layer properties;@layer utilities{${innerUtilityRules.slice(splitIndex).join("")}}${suffix}`,
  };
}

function normalizeCssModuleId(id: string): string {
  return id
    .split("?", 1)[0]!
    .replace(/\\/g, "/")
    .replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
}

function splitErpStylesForBuild(): Plugin {
  const erpCssPath = path
    .resolve(projectRoot, "client", "src", "erp.css")
    .replace(/\\/g, "/");
  const erpCssNorm = normalizeCssModuleId(erpCssPath);
  const erpVariantsNorm = normalizeCssModuleId(
    path.resolve(projectRoot, "client", "src", "styles", "erp-variants.css"),
  );
  let splitResult: { part1: string; part2: string } | null = null;

  return {
    name: "split-erp-styles-for-build",
    apply: "build",
    buildStart() {
      splitResult = null;
    },
    async transform(code, id) {
      const normId = normalizeCssModuleId(id);
      if (normId === erpCssNorm) {
        splitResult = splitCompiledErpUtilitiesCss(code);
        return { code: splitResult.part1, map: null };
      }
      if (normId === erpVariantsNorm) {
        if (!splitResult) {
          const resolved = await this.resolve(erpCssPath);
          await this.load({ id: resolved?.id ?? erpCssPath });
        }
        if (!splitResult) {
          this.error("ERP_CSS_SPLIT_SOURCE_NOT_LOADED");
        }
        return { code: splitResult.part2, map: null };
      }
      return null;
    },
  };
}

export const CSS_ASSET_BUDGET_BYTES = 300_000;

export function cssAssetBudgetViolation(output: {
  type?: string;
  fileName?: string;
  source?: string | Uint8Array;
}): string | null {
  if (output?.type !== "asset" || !output.fileName?.endsWith(".css")) {
    return null;
  }
  const source = output.source ?? "";
  const bytes =
    typeof source === "string"
      ? Buffer.byteLength(source)
      : source.byteLength;
  return bytes > CSS_ASSET_BUDGET_BYTES
    ? `CSS_BUDGET_EXCEEDED ${output.fileName}: ${bytes} > ${CSS_ASSET_BUDGET_BYTES}`
    : null;
}

function enforceBuildContracts(): Plugin {
  return {
    name: "enforce-build-contracts",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        const violation =
          chunkBudgetViolation(output) ?? cssAssetBudgetViolation(output);
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
    splitErpStylesForBuild(),
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
          STOREFRONT_SHELL_CSS_GLOB,
          STOREFRONT_SHELL_CHUNK_GLOB,
          "fonts/*.woff2",
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
        // عطّل directoryIndex الافتراضي ("index.html") في PrecacheRoute: كان يلتقط طلب الجذر "/"
        // (لوحة التحكم/الدخول في ERP) ويُعيد index.html القديم من precache متجاوزاً navigateFallbackAllowlist.
        directoryIndex: null,
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
            urlPattern: storefrontApiNetworkMatcher,
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
        name: "الرؤية العربية",
        short_name: "الرؤية العربية",
        description: "نظام إدارة أعمال الرؤية العربية والمكتبة للطباعة والقرطاسية والتجارة",
        lang: "ar",
        dir: "rtl",
        theme_color: "#1e4a63",
        background_color: "#fff8ef",
        display: "standalone",
        start_url: "/",
        // النطاق على الجذر لتمكين تثبيت PWA بهوية النظام كاملة (المتجر العام والنظام الإداري)،
        // مع بقاء navigation fallback محصوراً بـ /store فلا يُقدَّم ERP أوفلاين من كاش غير متصل.
        scope: "/",
        categories: ["business", "shopping"],
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
        chunkFileNames(chunkInfo) {
          if (chunkInfo.name === "App") return "assets/erp-routes-[hash].js";
          return "assets/[name]-[hash].js";
        },
        manualChunks(id) {
          // Legacy permission dictionaries remain needed for untouched roles, but do not
          // belong in the account-sharing or application entry chunks.
          if (id.includes("/shared/atomicPermissionExtensions.ts")) return "permission-extensions";
          if (id.includes("/shared/atomicPermissions.ts")) return "legacy-permissions";
          // The ERP shell is reused by every operational page; isolate its common
          // dependencies instead of accumulating them in the SPA entry.
          // AppLayout is dynamically reached via lazy("./App") from BootstrapApp.
          if (id.includes("/client/src/lib/navVisibility.ts") || id.includes("/client/src/lib/moduleRegistry.ts")) return "erp-navigation";
          if (id.includes("/shared/operationPermissionCatalog.part1.generated")) return "operation-catalog-1";
          if (id.includes("/shared/operationPermissionCatalog.part2.generated")) return "operation-catalog-2";
          if (id.includes("/node_modules/@casl/") || id.includes("/node_modules/sift/")) return "authorization-vendor";
          if (id.includes("/node_modules/zod/")) return "validation-vendor";
          // كل أيقونات lucide في حُزمة واحدة بدل ~٨٠ ملفاً صغيراً. كان كل أيقونة حُزمةً
          // منفصلة ⇒ كل صفحة تطلب عشرات ملفات الأصول دفعةً واحدة، فتُشبع خادم الأصول
          // (Express + compression على threadpool ٤ خيوط) وتتعلّق الطلبات على «جار التحميل».
          if (id.includes("node_modules/lucide-react")) return "icons";
          // الرسوم البيانية (~400KB) تُستعمل عند فتح لوحات التحليل فقط. عزل Recharts
          // يمنع ابتلاعها داخل حزمة صفحة الخزينة وتجاوز سقف 500KB لبقية الشاشات.
          if (id.includes("node_modules/recharts")) return "charts";
          // حزمة Excel ضخمة (~936KB) ومطلوبة فقط عند التصدير ⇒ افصلها كي لا تُثقل أي صفحة أخرى.
          if (id.includes("node_modules/exceljs")) return EXCEL_CHUNK_NAME;
          // حزم الحركة والتأثيرات البصرية المستقلة (framer-motion)
          if (
            id.includes("/node_modules/framer-motion/") ||
            id.includes("/node_modules/motion-dom/") ||
            id.includes("/node_modules/motion-utils/")
          ) return "motion";
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
            id.includes("/node_modules/superjson/") ||
            id.includes("/node_modules/decimal.js/")
          ) return "data-client";
          if (
            id.includes("/node_modules/@radix-ui/") ||
            id.includes("/node_modules/@floating-ui/") ||
            id.includes("/node_modules/cmdk/") ||
            id.includes("/node_modules/vaul/") ||
            id.includes("/node_modules/tailwind-merge/") ||
            id.includes("/node_modules/clsx/") ||
            id.includes("/node_modules/sonner/") ||
            id.includes("/node_modules/input-otp/") ||
            id.includes("/node_modules/qrcode/")
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
