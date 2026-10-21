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
import { flushAutosaves } from "./autosave";
import { saveInteractionDraft } from "./interactionDraft";
import {
  activateRegistrationUpdate,
  requestStorefrontPersistence,
} from "./pwaUpdateLifecycle";

const RELOAD_GUARD_KEY = "alroya:chunk-reload-attempted";
const RELOAD_GUARD_TTL_MS = 30_000;
const SW_UPDATE_TIMEOUT_MS = 4_000;
const SW_INSTALL_TIMEOUT_MS = 8_000;
const SW_ACTIVATE_TIMEOUT_MS = 6_000;
let reloadEpoch = 0;

function preserveDraftsBeforeReload(): void {
  try {
    if (typeof document !== "undefined") {
      saveInteractionDraft();
    }
  } catch {
    /* تَجاهل */
  }
  try {
    flushAutosaves();
  } catch {
    /* تَجاهل */
  }
  try {
    if (
      typeof window !== "undefined" &&
      typeof window.dispatchEvent === "function"
    ) {
      requestStorefrontPersistence();
    }
  } catch {
    /* تَجاهل */
  }
}

function waitForInstallingWorkerToSettle(
  worker: ServiceWorker,
  timeoutMs = SW_INSTALL_TIMEOUT_MS,
): Promise<void> {
  if (worker.state !== "installing") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (worker.state !== "installing") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

async function prepareServiceWorkerBeforeReload(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  const sw = navigator.serviceWorker;
  if (!sw?.controller || typeof sw.getRegistration !== "function") {
    return;
  }
  try {
    const registration = await sw.getRegistration();
    if (!registration) return;

    if (
      !registration.waiting &&
      !registration.installing &&
      typeof registration.update === "function"
    ) {
      await Promise.race([
        registration.update().catch(() => undefined),
        new Promise<void>((resolve) =>
          setTimeout(resolve, SW_UPDATE_TIMEOUT_MS),
        ),
      ]);
    }

    const refreshed = (await sw.getRegistration()) ?? registration;
    if (refreshed.installing) {
      await waitForInstallingWorkerToSettle(refreshed.installing);
    }

    const latest = (await sw.getRegistration()) ?? refreshed;
    if (latest.waiting || latest.active?.state === "activating") {
      await activateRegistrationUpdate({
        getRegistration: () => sw.getRegistration(),
        timeoutMs: SW_ACTIVATE_TIMEOUT_MS,
        pollIntervalMs: 25,
      });
    }
  } catch {
    /* فشل تحديث/تفعيل Service Worker لا يمنع محاولة reload الاحتياطية */
  }
}

function getFactoryGuardValue(factory: () => unknown): string {
  try {
    const raw = factory.toString();
    const importMatch = raw.match(/import\(\s*["']([^"']+)["']\s*\)/);
    if (importMatch?.[1]) {
      return importMatch[1]
        .replace(/\?.*$/, "")
        .replace(/-[A-Za-z0-9_-]{8}(?=\.m?js$)/, "");
    }
    const normalized = raw
      .replace(/-[A-Za-z0-9_-]{8}(?=\.m?js["'])/g, "")
      .replace(/__vite__mapDeps\(\[[^\]]*\]\)/g, "__vite__mapDeps([])")
      .trim()
      .slice(0, 200);
    return normalized || "1";
  } catch {
    return "1";
  }
}

function parseReloadGuard(raw: string | null, now = Date.now()): {
  active: boolean;
  target: string | null;
} {
  if (!raw) return { active: false, target: null };
  if (raw === "1") return { active: true, target: "1" };
  const sepIndex = raw.lastIndexOf("\n");
  if (sepIndex === -1) {
    return { active: true, target: raw };
  }
  const target = raw.slice(0, sepIndex) || "1";
  const ts = Number(raw.slice(sepIndex + 1));
  if (!Number.isFinite(ts)) {
    return { active: true, target };
  }
  const ageMs = now - ts;
  return {
    active: ageMs >= 0 && ageMs < RELOAD_GUARD_TTL_MS,
    target,
  };
}

function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  if (e.name === "ChunkLoadError") return true;
  const msg = e.message ?? "";
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("Unable to preload CSS for") ||
    /Loading (?:CSS )?chunk \S+ failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  );
}

/**
 * القَيد `ComponentType<any>` هو **قَيد React.lazy نَفسه** — وكان هنا
 * `ComponentType<unknown>` فَلا يَقبل مُكوّناً ذا خَصائص إطلاقاً (١٩/٨: أوّل صَفحة
 * مُحمَّلة كَسولاً تَأخذ prop كَشَفَته). الخَصائص تَبقى مَفحوصةً عِند الاستعمال لأن
 * `lazy` يُعيد `LazyExoticComponent<T>` بِـT الأصليّ لا المُوسَّع.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): ReturnType<typeof lazy<T>> {
  const guardValue = getFactoryGuardValue(factory);
  const createdEpoch = reloadEpoch;
  return lazy(async () => {
    try {
      const mod = await factory();
      // نَجَح ⇒ امسح الحَارس فقط إن كان يَخصّ هَذا الـchunk نَفسه أو انتهت صَلاحيته
      // (حَتى لا يَمسح chunk شَقيق مُخبّأ مثل QuranStationDrawer حَارسَ صَفحةٍ فاشلة مثل Dashboard فَيُسبّب حَلَقة reload لا نِهائية).
      try {
        const rawGuard = sessionStorage.getItem(RELOAD_GUARD_KEY);
        if (rawGuard !== null) {
          const parsed = parseReloadGuard(rawGuard);
          if (
            !parsed.active ||
            parsed.target === "1" ||
            parsed.target === guardValue
          ) {
            sessionStorage.removeItem(RELOAD_GUARD_KEY);
          }
        }
      } catch {
        /* sessionStorage مَحجوب في وَضع خاصّ — تَجاهل */
      }
      return mod;
    } catch (err) {
      if (!isChunkLoadError(err)) throw err;

      // إن كان chunk شَقيق في نَفس التَّحميل الجَاري قَد طَلَب reload بالفعل،
      // ابقَ في وَضع Suspense حَتى يَكتمل خروج الصَّفحة دون مَسح الحَارس أو وَميض ErrorBoundary.
      if (createdEpoch !== reloadEpoch) {
        return new Promise<{ default: T }>(() => {});
      }

      // فَشل chunk — جَرّب reload مَرّة واحدة، ثم اِنشر الخَطأ لِحَدّ الخَطأ.
      let alreadyReloaded = false;
      try {
        const parsed = parseReloadGuard(sessionStorage.getItem(RELOAD_GUARD_KEY));
        alreadyReloaded = parsed.active;
      } catch {
        /* تَجاهل */
      }

      if (alreadyReloaded) {
        // لا نَمسح الحَارس عِند الفَشل الثَّاني: قد يَفشل chunk شَقيق آخر (مِثل QuranStationDrawer مع Login)
        // بَعد بِضعِ ملّي ثانية في نَفس التَّحميل الثَّاني، فَمَسحُ الحَارس هُنا يَجعله يَظنّ أنّه لم يُعِد التَّحميل
        // ويُسبّب حَلَقة reload لا نِهائية. يَنتهي الحَارس تلقائياً بـTTL (30 ثانية) أو عِند نَجاح الـchunk.
        throw err;
      }

      let guardStored = false;
      try {
        sessionStorage.setItem(
          RELOAD_GUARD_KEY,
          `${guardValue}\n${Date.now()}`,
        );
        guardStored = true;
      } catch {
        /* تَجاهل */
      }
      if (!guardStored) {
        throw err;
      }

      reloadEpoch += 1;
      preserveDraftsBeforeReload();
      if (
        typeof navigator !== "undefined" &&
        navigator.serviceWorker?.controller &&
        typeof navigator.serviceWorker.getRegistration === "function"
      ) {
        void prepareServiceWorkerBeforeReload().finally(() => {
          window.location.reload();
        });
      } else {
        window.location.reload();
      }
      // promise لا يَحلّ أبَداً ⇒ Suspense fallback يَبقى ظَاهراً حَتى يَنتهي reload
      // بدلَ وَميض حَدّ الخَطأ قَبل خُروج الصَّفحة.
      return new Promise<{ default: T }>(() => {});
    }
  });
}
