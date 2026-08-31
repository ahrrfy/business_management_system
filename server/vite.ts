import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer, type UserConfig, type UserConfigFn } from "vite";
import viteConfig from "../vite.config";

/**
 * **`vite.config.ts` يُصدّر دالّةً لا كائناً** (`defineConfig(({ mode }) => …)` — صار كذلك في
 * 9bc2c33d حين احتاج قراءة البيئة عبر `loadEnv`). ونشرُ دالّةٍ بـ`...` يُنتج **كائناً فارغاً**: الدوالّ بلا
 * خصائصَ قابلةٍ للتعداد. فكان خادمُ التطوير يفقد الإعداد كلَّه — وأهمُّه `root: client/`
 * ومُعرِّفا `@`/`@shared` — فيسقط `root` إلى مجلّد التشغيل ويصير `/src/main.tsx` مسارَ ملفٍّ
 * لا وجود له:
 *
 *     [vite] Pre-transform error: Failed to load url /src/main.tsx. Does the file exist?
 *
 * فتُخدَم `index.html` مكانَ الوحدة (MIME: text/html) ويبقى `#root` فارغاً — أي **`pnpm dev`
 * لا يعرض الواجهة إطلاقاً**. لا يكشفه `pnpm check` ولا `pnpm build` (البناء يقرأ الملفّ
 * بنفسه فيستدعي الدالّة صحيحةً)، ولا أيّ اختبار — العطبُ حصريٌّ في مسار الخادم التطويريّ.
 *
 * ⇒ نستدعيها حين تكون دالّةً بدل نشرها. و`command: "serve"` هي الحالة الصادقة هنا.
 */
async function resolveViteConfig(): Promise<UserConfig> {
  return typeof viteConfig === "function"
    ? await (viteConfig as UserConfigFn)({ command: "serve", mode: process.env.NODE_ENV ?? "development" })
    : (viteConfig as UserConfig);
}

export async function setupVite(app: Express, server: Server) {
  // دمجُ #922: أُصلح العطبُ نفسه على `main` مضمَّناً هنا، وأُبقي الشكلُ المُستخرَج
  // (`resolveViteConfig`) لأنّه نقطةُ القراءة التي يعتمدها حارسُ خادم التطوير — والمنطقُ واحد.
  const vite = await createViteServer({
    ...(await resolveViteConfig()),
    configFile: false,
    server: { middlewareMode: true, hmr: { server }, allowedHosts: true as const },
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path.resolve(import.meta.dirname, "..", "client", "index.html");
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${nanoid()}"`);
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  // In production the server is bundled to dist/index.js, so the client build
  // sits alongside it at dist/public.
  const distPath = path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(`Build directory not found: ${distPath} — run "pnpm build" first.`);
  }

  // الأصول المُجزّأة بالمحتوى (hash في اسم الملف) ثابتة أبداً ⇒ خبّئها سنة كاملة immutable.
  // كان express.static الافتراضي يضع Cache-Control: max-age=0 ⇒ المتصفّح يُعيد جلب كل حُزمة
  // عند كل تنقّل، فتنطلق عشرات الطلبات المتزامنة على كل صفحة وتُشبع خادم الأصول وتتعلّق
  // (السبب الجذري لتعليق «جار التحميل»). مع التخبئة: تُجلب مرّة واحدة ثم تُخدَم من المتصفّح.
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      immutable: true,
      maxAge: "1y",
      index: false,
      fallthrough: false, // أصلٌ غير موجود ⇒ 404 صريح (لا يسقط إلى SPA fallback فيعيد HTML بمكان JS)
    })
  );

  // بقية الملفات (index.html, sw.js, manifest, الأيقونات الجذرية) — لا تُخبَّأ طويلاً:
  // index.html و sw.js يجب إعادة التحقّق منهما كي يصل التحديث فور كل نشر.
  app.use(
    express.static(distPath, {
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-cache");
      },
    })
  );

  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
