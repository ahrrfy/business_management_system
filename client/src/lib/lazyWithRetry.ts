// تَغليف React.lazy لـ chunks ديناميكية بِشَبَكة هَشَّة:
//
// المُشكلة: `React.lazy` يُخبّئ نَتيجة factory أوّل مَرّة — بما في ذلك الرَفض. لو فَشل
// تَحميل chunk (شَبَكة مَقطوعة لَحظياً، أو نَشر جَديد جَعَل اسم hash القَديم 404)،
// كل re-render تالٍ يُعيد تَوصيل الرَفض المُخبَّأ ⇒ زِرّ «إعادة المُحاولة» في
// `RouteErrorBoundary` لا يُجدي، تَبقى الصَّفحة عَالقة حَتى reload يَدوي كامل.
//
// الحلّ: إن كان السَبب فَشل chunk، نُجبر window.location.reload() ⇒ المُتصفّح يَجلب
// index.html جَديداً بأسماء hash حالية، والـcaches السَيّئة تَختفي. حَارس
// sessionStorage يَمنع حَلَقة لا نِهائية لو ظَلّ الخَطأ قائماً بَعد إعادة التَّحميل
// (نَنشر الخَطأ عِندها لِـRouteErrorBoundary كي يَعرض REF + خيار «الرئيسية»).
//
// مُحفّزات chunk-load معروفة:
//  • Vite/ESM: «Failed to fetch dynamically imported module»
//  • Vite/Safari: «Importing a module script failed»
//  • Webpack-style: «Loading chunk N failed» / ChunkLoadError
//  • نُغطّيها جَميعاً للسَلامة عَبر المَتصفّحات.

import { lazy, type ComponentType } from "react";

const RELOAD_GUARD_KEY = "alroya:chunk-reload-attempted";

function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  if (e.name === "ChunkLoadError") return true;
  const msg = e.message ?? "";
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    /Loading chunk \S+ failed/.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  );
}

export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
): ReturnType<typeof lazy<T>> {
  return lazy(async () => {
    try {
      const mod = await factory();
      // نَجَح ⇒ امسح الحَارس (مَحاولات سَابقة كانت عَابرة).
      try {
        sessionStorage.removeItem(RELOAD_GUARD_KEY);
      } catch {
        /* sessionStorage مَحجوب في وَضع خاصّ — تَجاهل */
      }
      return mod;
    } catch (err) {
      if (!isChunkLoadError(err)) throw err;

      // فَشل chunk — جَرّب reload مَرّة واحدة، ثم اِنشر الخَطأ لِحَدّ الخَطأ.
      let alreadyReloaded = false;
      try {
        alreadyReloaded = sessionStorage.getItem(RELOAD_GUARD_KEY) === "1";
      } catch {
        /* تَجاهل */
      }

      if (alreadyReloaded) {
        try {
          sessionStorage.removeItem(RELOAD_GUARD_KEY);
        } catch {
          /* تَجاهل */
        }
        throw err;
      }

      try {
        sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
      } catch {
        /* تَجاهل */
      }
      window.location.reload();
      // promise لا يَحلّ أبَداً ⇒ Suspense fallback يَبقى ظَاهراً حَتى يَنتهي reload
      // بدلَ وَميض حَدّ الخَطأ قَبل خُروج الصَّفحة.
      return new Promise<{ default: T }>(() => {});
    }
  });
}
