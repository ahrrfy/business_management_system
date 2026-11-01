import { Button } from "@/components/ui/button";
import { flushAutosaves } from "@/lib/autosave";
import {
  hasUnsavedInteraction,
  saveInteractionDraft,
} from "@/lib/interactionDraft";
import {
  activateRegistrationUpdate,
  automaticStorefrontPersistenceIsSafe,
  storefrontActivationIsSafe,
  clearPwaAutoAttempt,
  decidePwaUpdateAction,
  PWA_FAILED_AUTO_RETRY_COOLDOWN_MS,
  type PwaAutoAttempt,
  readPwaAutoAttempt,
  requestStorefrontPersistence,
  resolveWaitingWorkerVersion,
  shouldAutoApplyWaitingVersion,
  shouldClearPwaAutoAttempt,
  shouldReloadAfterActivationTimeout,
  writePwaAutoAttempt,
} from "@/lib/pwaUpdateLifecycle";
import {
  setPwaUpdatePending,
  subscribePwaUpdateOpen,
} from "@/lib/pwaUpdateStatus";
import { realtimeManager } from "@/lib/realtime/realtimeManager";
import { isPublicHost } from "@/lib/siteHosts";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { notify } from "@/lib/notify";
import { useLocation } from "wouter";

export {
  automaticStorefrontPersistenceIsSafe,
  clearPwaAutoAttempt,
  PWA_FAILED_AUTO_RETRY_COOLDOWN_MS,
  type PwaAutoAttempt,
  readPwaAutoAttempt,
  requestStorefrontPersistence,
  resolveWaitingWorkerVersion,
  shouldAutoApplyWaitingVersion,
  shouldClearPwaAutoAttempt,
  shouldReloadAfterActivationTimeout,
  writePwaAutoAttempt,
};

const UPDATE_CHECK_TIMEOUT_MS = 8_000;
const UPDATE_ACTIVATION_TIMEOUT_MS = 12_000;
const RELOAD_MARKER_KEY = "alroya.pwa-update.reload-requested";
const RELOAD_MARKER_MAX_AGE_MS = 2 * 60 * 1_000;

type UpdatePhase = "saving" | "activating" | "reopening";
export type PwaUpdateDelivery = "AUTO_APPLY" | "PROMPT" | "NONE";

function isKioskRoute(pathname: string): boolean {
  return (
    pathname === "/kiosk" ||
    pathname.startsWith("/kiosk/") ||
    pathname === "/price-checker" ||
    pathname.startsWith("/price-checker/")
  );
}

export function pwaOfflineReadyMessage(input: {
  hostname: string;
  pathname: string;
}): string {
  const storefrontPath =
    input.pathname === "/store" || input.pathname.startsWith("/store/");
  if (isPublicHost(input.hostname) && storefrontPath) {
    return "تم حفظ واجهة مكتبة العربية؛ عرض المنتجات والأسعار وإرسال الطلب يحتاج اتصالاً بالإنترنت.";
  }
  return "تم حفظ ملفات التطبيق الأساسية؛ البيانات والعمليات تحتاج اتصالاً بالإنترنت.";
}

/**
 * زائر المتجر وشاشات الكشك وقارئ الأسعار لا تملك مسودة ERP حرجة ويجب ألا تبقى على shell قديم.
 * شاشات الكشك غير مأهولة وتتطلب تطبيقاً صامتاً دون انتظار لمسة بشرية.
 * أما الموظفون والمناديب فيحتفظون بالموافقة اليدوية لأن لديهم عمليات قد تكون غير محفوظة.
 */
export function decidePwaUpdateDelivery(input: {
  hostname: string;
  pathname: string;
  hasWaitingWorker: boolean;
}): PwaUpdateDelivery {
  if (!input.hasWaitingWorker) return "NONE";
  if (isKioskRoute(input.pathname)) return "AUTO_APPLY";
  const storefrontPath =
    input.pathname === "/store" || input.pathname.startsWith("/store/");
  if (isPublicHost(input.hostname) && storefrontPath) return "AUTO_APPLY";
  return "PROMPT";
}

export function requiresStorefrontPersistence(input: {
  hostname: string;
  pathname: string;
}): boolean {
  return (
    isPublicHost(input.hostname) &&
    (input.pathname === "/store" || input.pathname.startsWith("/store/"))
  );
}

export function pwaActivationTimeoutMessage(input: {
  hostname: string;
  pathname: string;
}): string {
  if (requiresStorefrontPersistence(input)) {
    return "لم يكتمل التفعيل ولم يُفقد طلبك. لن نعيد فتح الصفحة تلقائياً؛ أعد المحاولة يدوياً.";
  }
  return "لم يكتمل التفعيل وبقي عملك محفوظاً. لن نعيد فتح الصفحة تلقائياً؛ أعد المحاولة يدوياً.";
}

function phaseMessage(phase: UpdatePhase): string {
  if (phase === "saving") return "جارٍ حفظ العمل محلياً";
  if (phase === "reopening") return "اكتمل التفعيل، جارٍ إعادة فتح النظام";
  return "جارٍ تفعيل النسخة الجديدة";
}

function rememberVerifiedActivation(): void {
  try {
    sessionStorage.setItem(RELOAD_MARKER_KEY, String(Date.now()));
  } catch {
    // نجاح التحديث لا يعتمد على توفر sessionStorage.
  }
}

function readReloadMarker(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_MARKER_KEY)) || 0;
  } catch {
    return 0;
  }
}

function clearReloadMarker(): void {
  try {
    sessionStorage.removeItem(RELOAD_MARKER_KEY);
  } catch {
    // التخزين اختياري.
  }
}

async function checkRegistrationForUpdate(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  await Promise.race([
    registration.update(),
    new Promise<void>((resolve) =>
      window.setTimeout(resolve, UPDATE_CHECK_TIMEOUT_MS),
    ),
  ]);
}

/**
 * التحديث يُنزّل كاملاً في الخلفية ويبقى waiting إلى أن يوافق الموظف. بعد
 * حفظ مسودات العمل نطلب التفعيل، نتحقق أن العامل الجديد صار active فعلياً،
 * ثم — وفقط عندها — نعيد فتح الصفحة. clientsClaim يبقى معطلاً كي لا يفرض
 * التحديث على تبويبات أخرى فيها إدخالات غير محفوظة.
 */
/** سطح زائر المتجر على الدومين العام (فحص الحمل ٣٠/٨ — الجذر يُحوَّل إلى /store، و/apply عامة كذلك). */
function isStorefrontSurfacePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/store" ||
    pathname.startsWith("/store/") ||
    pathname === "/apply" ||
    pathname.startsWith("/apply/")
  );
}

export function PwaUpdateManager() {
  const [pathname] = useLocation();
  const [ready, setReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("saving");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [autoApplyTicket, setAutoApplyTicket] = useState(0);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const updateWasSignaledRef = useRef(false);
  const autoAttemptedWorkerRef = useRef<ServiceWorker | null>(null);
  const activeWorkerBeforeAttemptRef = useRef<ServiceWorker | null>(null);
  const autoAttemptVersionRef = useRef<string | null>(null);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  /**
   * قرار تسجيل عامل الخدمة — كسولٌ ويُقفَل مرّةً واحدة (فحص الحمل + مراجعة عدائية ٣٠/٨):
   * - زائر المتجر/التوظيف على الدومين العام لا يُسجَّل له (التسجيل كان يسحب precache حزمة
   *   ERP كاملة ~417 ملفاً/9MB لكل زائرٍ مجهول ويعيد سحبها كل نشرة).
   * - تطبيق المناديب TWA المنشور يُقلع من "/" على الدومين نفسه ⇒ لا نقرّر بلقطة مسار
   *   الإقلاع: أول وصولٍ لمسارٍ غير متجريّ (/my-deliveries…) يرفع المزلاج فيُسجَّل حينها.
   * - متصفّحٌ يحمل تسجيلاً قائماً (مندوبٌ عائد، أو زائرٌ من قبل هذا التغيير) يُبقى ويُحدَّث
   *   كالمعتاد — **لا unregister إطلاقاً**: إلغاء التسجيل يقتل اشتراكات الإشعارات ويترك
   *   قشرةً مثبَّتة لا تتحدّث أبداً.
   */
  const [swEnabled, setSwEnabled] = useState(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const check = (event: MessageEvent) => {
      if (event.data?.type !== "PWA_CHECK_ACTIVATION" || !event.ports[0])
        return;
      const saved = requestStorefrontPersistence();
      const storefront = requiresStorefrontPersistence({
        hostname: window.location.hostname,
        pathname: pathnameRef.current,
      });
      event.ports[0].postMessage({
        safe:
          storefrontActivationIsSafe() &&
          saved.ok &&
          !saved.inFlight &&
          (!storefront || automaticStorefrontPersistenceIsSafe(saved)),
      });
    };
    navigator.serviceWorker.addEventListener("message", check);
    return () => navigator.serviceWorker.removeEventListener("message", check);
  }, []);
  useEffect(() => {
    if (swEnabled) return;
    if (!import.meta.env.PROD) {
      setSwEnabled(true);
      return;
    }
    if (!("serviceWorker" in navigator)) return;
    if (
      !(
        isPublicHost(window.location.hostname) &&
        isStorefrontSurfacePath(pathname)
      )
    ) {
      setSwEnabled(true);
      return;
    }
    let cancelled = false;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => {
        if (!cancelled && registration) setSwEnabled(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [swEnabled, pathname]);

  const queueAutomaticUpdate = async (
    registration: ServiceWorkerRegistration,
    waitingWorker: ServiceWorker,
  ) => {
    const version = await resolveWaitingWorkerVersion(waitingWorker);
    if (registrationRef.current?.waiting !== waitingWorker) return;
    if (
      decidePwaUpdateDelivery({
        hostname: window.location.hostname,
        pathname: pathnameRef.current,
        hasWaitingWorker: true,
      }) !== "AUTO_APPLY"
    ) {
      return;
    }

    if (!version) {
      setUpdateError(
        "تعذّر التحقق من نسخة التحديث؛ بقيت الصفحة مفتوحة ويمكنك إعادة المحاولة يدوياً.",
      );
      return;
    }

    autoAttemptVersionRef.current = version;
    activeWorkerBeforeAttemptRef.current = registration.active;
    const persisted = readPwaAutoAttempt();
    if (!persisted.ok) {
      setUpdateError(
        "تعذّر تأمين سجل محاولة التحديث في هذا المتصفح؛ حدّث يدوياً بعد حفظ طلبك.",
      );
      return;
    }
    if (
      !shouldAutoApplyWaitingVersion(version, persisted.value, {
        unattended: isKioskRoute(pathnameRef.current),
      })
    ) {
      setUpdateError(
        "لم يكتمل التحديث التلقائي السابق. لن نعيد فتح الصفحة تلقائياً؛ اضغط إعادة المحاولة بعد مراجعة طلبك.",
      );
      return;
    }
    if (
      !writePwaAutoAttempt({
        version,
        status: "ATTEMPTING",
        attemptedAt: Date.now(),
      })
    ) {
      setUpdateError(
        "تعذّر تأمين التحديث التلقائي؛ بقيت الصفحة مفتوحة ويمكنك التحديث يدوياً.",
      );
      return;
    }
    setAutoApplyTicket((ticket) => ticket + 1);
  };

  const revealUpdate = (registration = registrationRef.current) => {
    if (registration) registrationRef.current = registration;
    setPwaUpdatePending(true);
    setReady(true);
    if (typeof window === "undefined") return;
    const waitingWorker = registration?.waiting ?? null;
    const delivery = decidePwaUpdateDelivery({
      hostname: window.location.hostname,
      pathname: window.location.pathname,
      hasWaitingWorker: !!waitingWorker,
    });
    if (
      delivery === "AUTO_APPLY" &&
      registration &&
      waitingWorker &&
      autoAttemptedWorkerRef.current !== waitingWorker
    ) {
      // تذكرة واحدة لكل عامل منتظر تمنع حلقة إعادة محاولات صامتة إذا فشل التفعيل فعلاً.
      autoAttemptedWorkerRef.current = waitingWorker;
      void queueAutomaticUpdate(registration, waitingWorker);
    }
  };

  useEffect(() => {
    if (!swEnabled) return;
    if (!import.meta.env.PROD) {
      return;
    }
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;

    void import("virtual:pwa-register")
      .then(({ registerSW }) => {
        registerSW({
          immediate: true,
          onNeedReload() {
            // Workbox قد يستعيد التحكم بعد timeout أو تحديث تبويب آخر؛ القرار
            // يبقى لمسار الحفظ والتحقق أدناه، فلا يعيد فتح إدخالات جديدة تلقائياً.
          },
          onNeedRefresh() {
            if (!disposed) {
              updateWasSignaledRef.current = true;
              void navigator.serviceWorker
                .getRegistration()
                .then((registration) => {
                  if (!disposed) revealUpdate(registration ?? null);
                })
                .catch((error) => {
                  console.warn(
                    "[pwa] waiting registration lookup failed",
                    error,
                  );
                  if (!disposed) revealUpdate();
                });
            }
          },
          onOfflineReady() {
            notify.ok(
              pwaOfflineReadyMessage({
                hostname: window.location.hostname,
                pathname: window.location.pathname,
              }),
            );
          },
          onRegisteredSW(_swUrl, registration) {
            registrationRef.current = registration ?? null;
            if (registration?.waiting) revealUpdate(registration);
          },
          onRegisterError(error) {
            // النسخة الفعالة تبقى صالحة؛ نسجل السبب ولا نعطّل عمل الموظف.
            console.warn("[pwa] registration/update check failed", error);
          },
        });
      })
      .catch((error) => {
        if (import.meta.env.PROD) {
          console.warn("[pwa] update module failed to load", error);
        }
      });

    return () => {
      disposed = true;
    };
  }, [swEnabled]);

  // onNeedRefresh قد يصل بينما الزائر على الجذر العام ثم يحوّله الراوتر إلى /store؛ أعد تقييم
  // السياسة عند انتقال SPA بدل إبقاء العامل القديم منتظراً حتى إعادة تحميل يدوية.
  useEffect(() => {
    const registration = registrationRef.current;
    if (registration?.waiting) revealUpdate(registration);
    // revealUpdate تقرأ pathnameRef الحالي، والتغيير المقصود هو المسار وحده.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(
    () =>
      subscribePwaUpdateOpen(() => {
        setReady(true);
      }),
    [],
  );

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const check = () => {
      void navigator.serviceWorker
        .getRegistration()
        .then(async (registration) => {
          registrationRef.current = registration ?? null;
          if (registration?.waiting) {
            updateWasSignaledRef.current = true;
            revealUpdate(registration);
            return;
          }

          await registration?.update();
          if (registration?.waiting) {
            updateWasSignaledRef.current = true;
            revealUpdate(registration);
          }
        })
        .catch((error) => {
          console.warn("[pwa] background update check failed", error);
        });
    };

    // يلتقط عاملاً كان waiting قبل تحميل React أو جهّزه تبويب آخر.
    check();
    const interval = window.setInterval(check, 60 * 60 * 1_000);
    const visible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  useEffect(() => {
    if (autoApplyTicket === 0) return;
    // applyUpdate يحفظ لقطة الإدخالات ويفرغ autosaves قبل التفعيل؛ سلة المتجر ونموذج التوصيل
    // محفوظان أيضاً في localStorage داخل Storefront، لذلك returning profile ينتقل بأمان.
    void applyUpdate();
    // التذكرة هي الحدث المقصود؛ إدراج applyUpdate يعيد الأثر كل render لأنه دالة محلية.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApplyTicket]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const requestedAt = readReloadMarker();
    if (!requestedAt) return;

    clearReloadMarker();
    if (Date.now() - requestedAt > RELOAD_MARKER_MAX_AGE_MS) return;

    void navigator.serviceWorker.getRegistration().then((registration) => {
      const controller = navigator.serviceWorker.controller;
      if (
        controller?.state === "activated" &&
        registration?.active?.state === "activated" &&
        // شرطٌ حاسم ضدّ «نجاحٍ كاذب»: بقاءُ عاملٍ منتظرٍ بعد إعادة الفتح يعني أنّ التفعيل لم يكتمل
        // (سيناريو WebView المُجمَّد الذي أُعيد فيه الفتح قبل أن يُنهي skipWaiting) — الصفحة
        // لا تزال تحت العامل القديم الذي يستوفي شرط «مُفعَّل» وحده. فلا نَدّعي نجاحاً، بل نُبقي
        // البنر يعود للظهور لإعادة المحاولة (العامل المنتظر يعيد كشفه في التأثير الآخر).
        !registration.waiting
      ) {
        if (
          shouldClearPwaAutoAttempt({
            hasWaitingWorker: false,
            activeWorkerState: registration.active.state,
            activationVerified: true,
          })
        ) {
          clearPwaAutoAttempt();
        }
        setPwaUpdatePending(false);
        notify.ok("تم تحديث النظام بنجاح");
      } else {
        // لا ندّعي نجاحاً إن لم تصبح الصفحة تحت العامل الجديد بعد إعادة فتحها.
        notify.warn("فُتح النظام بأمان، لكن تعذّر تأكيد نسخة التحديث.");
      }
    });
  }, []);

  async function getCurrentRegistration(): Promise<
    ServiceWorkerRegistration | undefined
  > {
    const registration = await navigator.serviceWorker.getRegistration();
    registrationRef.current = registration ?? null;
    return registration;
  }

  function reportUpdateError(
    message: string,
    level: "err" | "warn" = "err",
  ): void {
    setUpdateError(message);
    // البطاقة السفلية تعرض الخطأ بوضوح (role="alert") على الشاشات التفاعلية؛
    // نكتفي بـ toast على شاشات الكشك المخفي فيها الشريط السفلي منعاً لتكرار الرسالة مرتين.
    if (isKioskRoute(pathnameRef.current)) {
      notify[level](message);
    }
  }

  function preserveUpdateDrafts(): boolean {
    if (isPublicHost(window.location.hostname) && !storefrontActivationIsSafe())
      return false;
    const interactionSaved = saveInteractionDraft();
    const autosaves = flushAutosaves();
    const storefrontSave = requestStorefrontPersistence();
    const storefrontRequired = requiresStorefrontPersistence({
      hostname: window.location.hostname,
      pathname: pathnameRef.current,
    });
    return (
      !(hasUnsavedInteraction() && !interactionSaved) &&
      autosaves.ok &&
      storefrontSave.ok &&
      (!storefrontRequired ||
        automaticStorefrontPersistenceIsSafe(storefrontSave))
    );
  }

  function reopenWithVerifiedUpdate(): boolean {
    // قد يعدّل المستخدم حقلاً أثناء انتظار العامل؛ نحفظ آخر حالة في نفس مهمة إعادة الفتح.
    if (!preserveUpdateDrafts()) {
      markAttemptFailed();
      reportUpdateError(
        "تعذّر حفظ آخر تعديلاتك محلياً؛ بقيت الصفحة مفتوحة. أعد المحاولة بعد مراجعة عملك.",
      );
      return false;
    }
    const version = autoAttemptVersionRef.current;
    if (
      version &&
      !writePwaAutoAttempt({
        version,
        status: "RELOADING",
        attemptedAt: Date.now(),
      })
    ) {
      reportUpdateError(
        "اكتمل تفعيل النسخة، لكن تعذّر تأمين سجل إعادة الفتح؛ أعد تحميل الصفحة يدوياً لحماية طلبك.",
        "warn",
      );
      return false;
    }
    setPhase("reopening");
    setPwaUpdatePending(false);
    setReady(false);
    rememberVerifiedActivation();
    window.location.reload();
    return true;
  }

  function markAttemptFailed(): void {
    const version = autoAttemptVersionRef.current;
    if (!version) return;
    writePwaAutoAttempt({
      version,
      status: "FAILED",
      attemptedAt: Date.now(),
    });
    if (isKioskRoute(pathnameRef.current) && typeof window !== "undefined") {
      window.setTimeout(() => {
        autoAttemptedWorkerRef.current = null;
        revealUpdate();
      }, PWA_FAILED_AUTO_RETRY_COOLDOWN_MS);
    }
  }

  async function applyUpdate(options?: { manual?: boolean }): Promise<void> {
    if (applying) return;
    if (!("serviceWorker" in navigator)) {
      notify.err("خدمة تحديث النظام غير متاحة في هذا المتصفح.");
      return;
    }

    let resumeRealtime: (() => void) | null = null;
    let reloading = false;
    try {
      setApplying(true);
      setPhase("saving");
      setUpdateError(null);

      // لقطة استرداد فورية قبل أي انتقال، حتى للنماذج القديمة غير المرتبطة بمسودة نوعية.
      if (!preserveUpdateDrafts()) {
        markAttemptFailed();
        reportUpdateError(
          "تعذّر حفظ السلة أو بيانات الطلب محلياً؛ لم نحدّث الصفحة. راجع طلبك ثم أعد المحاولة.",
        );
        return;
      }

      let registration =
        registrationRef.current ?? (await getCurrentRegistration());
      let action = decidePwaUpdateAction({
        hasRegistration: !!registration,
        hasWaitingWorker: !!registration?.waiting,
        hasActivatingWorker: registration?.active?.state === "activating",
        hasActiveWorker: !!registration?.active,
        updateWasSignaled: updateWasSignaledRef.current,
      });

      // لا نفحص الشبكة قبل استهلاك waiting الموجود؛ ذلك يفتح سباقاً مع تحديث آخر.
      if (action === "CHECK_AGAIN" && registration) {
        await checkRegistrationForUpdate(registration).catch((error) => {
          console.warn("[pwa] explicit update check failed", error);
        });
        registration = await getCurrentRegistration();
        if (registration?.waiting) updateWasSignaledRef.current = true;
        action = decidePwaUpdateAction({
          hasRegistration: !!registration,
          hasWaitingWorker: !!registration?.waiting,
          hasActivatingWorker: registration?.active?.state === "activating",
          hasActiveWorker: !!registration?.active,
          updateWasSignaled: updateWasSignaledRef.current,
        });
      }

      if (action === "UNAVAILABLE") {
        markAttemptFailed();
        notify.err("خدمة تحديث النظام غير متاحة في هذا المتصفح حالياً.");
        return;
      }

      if (action === "RELOAD_ACTIVE") {
        const candidate = autoAttemptedWorkerRef.current;
        const previousActive = activeWorkerBeforeAttemptRef.current;
        const activationVerified =
          candidate?.state === "activated" ||
          (registration?.active?.state === "activated" &&
            (!candidate || registration.active !== previousActive));
        if (!activationVerified) {
          markAttemptFailed();
          reportUpdateError(
            "اختفى عامل التحديث قبل إثبات تفعيله؛ لن نعيد فتح الصفحة تلقائياً. أعد المحاولة يدوياً.",
          );
          return;
        }
        reloading = reopenWithVerifiedUpdate();
        return;
      }

      if (action !== "ACTIVATE_WAITING") {
        const candidate = autoAttemptedWorkerRef.current;
        if (
          autoAttemptVersionRef.current &&
          candidate &&
          candidate.state === "activated"
        ) {
          reloading = reopenWithVerifiedUpdate();
          return;
        }
        if (autoAttemptVersionRef.current) {
          markAttemptFailed();
          reportUpdateError(
            "لم يعد عامل التحديث متاحاً ولم نثبت تفعيله؛ بقيت الصفحة كما هي ويمكنك إعادة المحاولة.",
          );
          return;
        }
        setPwaUpdatePending(false);
        setReady(false);
        notify.info("لا يوجد تحديث منتظر الآن؛ النظام على أحدث نسخة.");
        return;
      }

      setPhase("activating");
      // علّق تدفق SSE محلياً وعبر التبويبات وحرّره على الخادم حتى لو كان العامل المنتظر من بناء سابق.
      resumeRealtime = realtimeManager.suspendForPwaUpdate(
        UPDATE_ACTIVATION_TIMEOUT_MS + 3_000,
      );
      void fetch("/api/realtime/pwa-quiesce", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "x-erp-csrf": "1",
        },
        body: "{}",
      }).catch(() => {});

      const candidateBefore =
        registration?.waiting ??
        (registration?.active?.state === "activating"
          ? registration.active
          : null);
      const activation = await activateRegistrationUpdate({
        getRegistration: getCurrentRegistration,
        timeoutMs: UPDATE_ACTIVATION_TIMEOUT_MS,
      });

      if (activation.status === "activated") {
        reloading = reopenWithVerifiedUpdate();
        return;
      }

      // ربما أكمل تبويب آخر التفعيل بين آخر polling وهذه القراءة.
      const current = await getCurrentRegistration();
      if (candidateBefore?.state === "activated") {
        reloading = reopenWithVerifiedUpdate();
        return;
      }

      if (
        shouldReloadAfterActivationTimeout({
          manual: options?.manual === true,
          acknowledged: activation.acknowledged,
          activeWorkerState: current?.active?.state,
        })
      ) {
        reloading = reopenWithVerifiedUpdate();
        return;
      }

      console.warn("[pwa] activation not confirmed in poll window", {
        status: activation.status,
        attempts: activation.attempts,
        acknowledged: activation.acknowledged,
        waitingState: current?.waiting?.state,
        installingState: current?.installing?.state,
        activeState: current?.active?.state,
      });

      // لا نعيد فتح الصفحة عند timeout في التحديث التلقائي: ذلك كان يعيد تشغيل AUTO_APPLY بعد كل
      // تحميل فيصنع حلقة. العلامة الدائمة تمنع المحاولة الصامتة التالية، والزر يبقى لإعادة يدوية.
      markAttemptFailed();
      reportUpdateError(
        pwaActivationTimeoutMessage({
          hostname: window.location.hostname,
          pathname: pathnameRef.current,
        }),
      );
    } catch (error) {
      console.warn("[pwa] update application failed", error);
      markAttemptFailed();
      reportUpdateError(
        "تعذّر تطبيق التحديث الآن؛ بقي عملك محفوظاً ويمكنك إعادة المحاولة.",
      );
    } finally {
      if (!reloading && resumeRealtime) {
        resumeRealtime();
      }
      setApplying(false);
    }
  }

  if (!ready) return null;
  const isKioskSurface =
    pathname === "/kiosk" ||
    pathname.startsWith("/kiosk/") ||
    pathname === "/price-checker" ||
    pathname.startsWith("/price-checker/");

  return (
    <>
      {applying && (
        <div
          className="fixed inset-0 z-[200] grid place-items-center bg-background/65 p-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/55 motion-safe:animate-in motion-safe:fade-in-0"
          dir="rtl"
          role="status"
          aria-live="assertive"
          aria-label={phaseMessage(phase)}
        >
          <div className="w-full max-w-sm rounded-2xl border bg-card/95 p-7 text-center shadow-2xl backdrop-blur motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2">
            <div className="relative mx-auto grid size-20 place-items-center rounded-full bg-primary/10 text-primary">
              <span
                className="absolute inset-1 rounded-full border-2 border-primary/30 motion-safe:animate-ping"
                aria-hidden
              />
              <RefreshCw
                className="size-9 motion-safe:animate-spin"
                aria-hidden
              />
            </div>
            <p className="mt-5 text-lg font-bold text-foreground">
              {phaseMessage(phase)}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              لن تُغلق الصفحة قبل اكتمال التفعيل والتحقق منه.
            </p>
            <div
              className="mt-5 h-1.5 overflow-hidden rounded-full bg-muted"
              aria-hidden
            >
              {/* شريط غير محدَّد صادق: قطعة تنزلق عرضياً = «جارٍ العمل»، لا نسبةً ثابتةً مضلِّلة. */}
              <div className="pwa-update-bar h-full w-1/3 rounded-full bg-primary" />
            </div>
            <style>{`
              @keyframes pwaUpdateSlide { 0% { transform: translateX(-130%); } 100% { transform: translateX(400%); } }
              @keyframes pwaUpdatePulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
              .pwa-update-bar { animation: pwaUpdateSlide 1.15s ease-in-out infinite; }
              @media (prefers-reduced-motion: reduce) { .pwa-update-bar { animation: pwaUpdatePulse 1.8s ease-in-out infinite; width: 100%; } }
            `}</style>
          </div>
        </div>
      )}

      {!isKioskSurface && (
        <aside
          className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-xl rounded-lg border bg-background p-3 shadow-xl"
          dir="rtl"
          role="status"
          aria-live="polite"
          aria-busy={applying}
        >
          <div className="flex items-start gap-3">
            <ShieldCheck
              className="mt-0.5 size-5 shrink-0 text-primary"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">تحديث آمن جاهز للتثبيت</p>
              {updateError ? (
                <p
                  className="mt-1 text-sm font-medium text-destructive"
                  role="alert"
                >
                  {updateError}
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  سيُحفظ العمل محلياً ثم يُعاد فتح النظام بعد التحقق من النسخة
                  الجديدة.
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={applying}
              onClick={() => {
                setPwaUpdatePending(false);
                setReady(false);
              }}
            >
              لاحقاً
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={applying}
              onClick={() => void applyUpdate({ manual: true })}
            >
              <RefreshCw
                className={`size-4 ${applying ? "motion-safe:animate-spin" : ""}`}
                aria-hidden
              />
              {applying
                ? "جارٍ التحديث…"
                : updateError
                  ? "إعادة المحاولة بأمان"
                  : hasUnsavedInteraction()
                    ? "حفظ وتحديث"
                    : "تحديث الآن"}
              <Download className="size-4" aria-hidden />
            </Button>
          </div>
        </aside>
      )}
    </>
  );
}
