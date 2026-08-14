import { Button } from "@/components/ui/button";
import { flushAutosaves } from "@/lib/autosave";
import {
  hasUnsavedInteraction,
  saveInteractionDraft,
} from "@/lib/interactionDraft";
import {
  activateRegistrationUpdate,
  decidePwaUpdateAction,
} from "@/lib/pwaUpdateLifecycle";
import {
  setPwaUpdatePending,
  subscribePwaUpdateOpen,
} from "@/lib/pwaUpdateStatus";
import { isPublicHost } from "@/lib/siteHosts";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const UPDATE_CHECK_TIMEOUT_MS = 8_000;
const UPDATE_ACTIVATION_TIMEOUT_MS = 12_000;
const RELOAD_MARKER_KEY = "alroya.pwa-update.reload-requested";
const RELOAD_MARKER_MAX_AGE_MS = 2 * 60 * 1_000;
const AUTO_ATTEMPT_KEY = "alroya.pwa-update.auto-attempt.v1";
const STOREFRONT_PERSIST_REQUEST_EVENT = "alroya:storefront-persist-request";

type UpdatePhase = "saving" | "activating" | "reopening";
export type PwaUpdateDelivery = "AUTO_APPLY" | "PROMPT" | "NONE";
export type PwaAutoAttempt = {
  version: string;
  status: "ATTEMPTING" | "FAILED" | "RELOADING";
  attemptedAt: number;
};
type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * زائر المتجر لا يملك مسودة ERP حرجة ويجب ألا يبقى على shell قديم يحوّل أخطاء API إلى فراغ.
 * أما الموظفون والمناديب فيحتفظون بالموافقة اليدوية لأن لديهم عمليات قد تكون غير محفوظة.
 */
export function decidePwaUpdateDelivery(input: {
  hostname: string;
  pathname: string;
  hasWaitingWorker: boolean;
}): PwaUpdateDelivery {
  if (!input.hasWaitingWorker) return "NONE";
  const storefrontPath =
    input.pathname === "/store" || input.pathname.startsWith("/store/");
  if (isPublicHost(input.hostname) && storefrontPath) return "AUTO_APPLY";
  return "PROMPT";
}

export function readPwaAutoAttempt(
  storage: AttemptStorage = localStorage,
): { ok: true; value: PwaAutoAttempt | null } | { ok: false; value: null } {
  try {
    const raw = storage.getItem(AUTO_ATTEMPT_KEY);
    if (!raw) return { ok: true, value: null };
    const parsed = JSON.parse(raw) as Partial<PwaAutoAttempt>;
    if (
      typeof parsed.version !== "string" ||
      !["ATTEMPTING", "FAILED", "RELOADING"].includes(parsed.status ?? "") ||
      typeof parsed.attemptedAt !== "number"
    ) {
      storage.removeItem(AUTO_ATTEMPT_KEY);
      return { ok: true, value: null };
    }
    return { ok: true, value: parsed as PwaAutoAttempt };
  } catch {
    return { ok: false, value: null };
  }
}

export function writePwaAutoAttempt(
  attempt: PwaAutoAttempt,
  storage: AttemptStorage = localStorage,
): boolean {
  try {
    storage.setItem(AUTO_ATTEMPT_KEY, JSON.stringify(attempt));
    return true;
  } catch {
    return false;
  }
}

export function clearPwaAutoAttempt(
  storage: AttemptStorage = localStorage,
): boolean {
  try {
    storage.removeItem(AUTO_ATTEMPT_KEY);
    return true;
  } catch {
    return false;
  }
}

export function shouldAutoApplyWaitingVersion(
  version: string,
  attempt: PwaAutoAttempt | null,
): boolean {
  return attempt?.version !== version;
}

export function shouldClearPwaAutoAttempt(input: {
  hasWaitingWorker: boolean;
  activeWorkerState?: ServiceWorkerState;
  activationVerified: boolean;
}): boolean {
  return (
    input.activationVerified &&
    !input.hasWaitingWorker &&
    input.activeWorkerState === "activated"
  );
}

function hashWorkerScript(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export async function resolveWaitingWorkerVersion(
  worker: Pick<ServiceWorker, "scriptURL">,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetcher(worker.scriptURL, { cache: "no-store" });
    if (!response.ok) return null;
    const etag = response.headers.get("etag");
    if (etag) return `${worker.scriptURL}|etag:${etag}`;
    return `${worker.scriptURL}|hash:${hashWorkerScript(await response.text())}`;
  } catch {
    // بلا بصمة نسخة موثوقة لا نغامر بمحاولة صامتة قد تتكرر بعد إعادة التحميل.
    return null;
  }
}

export function requestStorefrontPersistence(
  target: Pick<Window, "dispatchEvent"> = window,
): { attempted: number; ok: boolean } {
  let attempted = 0;
  let ok = true;
  const event = new CustomEvent<{ report: (saved: boolean) => void }>(
    STOREFRONT_PERSIST_REQUEST_EVENT,
    {
      detail: {
        report(saved) {
          attempted += 1;
          ok = saved && ok;
        },
      },
    },
  );
  target.dispatchEvent(event);
  return { attempted, ok };
}

export function automaticStorefrontPersistenceIsSafe(result: {
  attempted: number;
  ok: boolean;
}): boolean {
  return result.attempted > 0 && result.ok;
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
    if (!shouldAutoApplyWaitingVersion(version, persisted.value)) {
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
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;

    void import("virtual:pwa-register")
      .then(({ registerSW }) => {
        registerSW({
          immediate: true,
          onNeedRefresh() {
            if (!disposed) {
              updateWasSignaledRef.current = true;
              void navigator.serviceWorker.getRegistration().then((registration) => {
                if (!disposed) revealUpdate(registration ?? null);
              }).catch((error) => {
                console.warn("[pwa] waiting registration lookup failed", error);
                if (!disposed) revealUpdate();
              });
            }
          },
          onOfflineReady() {
            toast.success("النظام جاهز للعمل دون اتصال");
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
  }, []);

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
    void applyUpdate({ automatic: true });
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
        toast.success("تم تحديث النظام بنجاح");
      } else {
        // لا ندّعي نجاحاً إن لم تصبح الصفحة تحت العامل الجديد بعد إعادة فتحها.
        toast.warning("فُتح النظام بأمان، لكن تعذّر تأكيد نسخة التحديث.");
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

  function reopenWithVerifiedUpdate(): void {
    const version = autoAttemptVersionRef.current;
    if (
      version &&
      !writePwaAutoAttempt({
        version,
        status: "RELOADING",
        attemptedAt: Date.now(),
      })
    ) {
      const message =
        "اكتمل تفعيل النسخة، لكن تعذّر تأمين سجل إعادة الفتح؛ أعد تحميل الصفحة يدوياً لحماية طلبك.";
      setUpdateError(message);
      toast.warning(message);
      return;
    }
    setPhase("reopening");
    setPwaUpdatePending(false);
    setReady(false);
    rememberVerifiedActivation();
    window.location.reload();
  }

  function markAttemptFailed(): void {
    const version = autoAttemptVersionRef.current;
    if (!version) return;
    writePwaAutoAttempt({
      version,
      status: "FAILED",
      attemptedAt: Date.now(),
    });
  }

  async function applyUpdate(options: { automatic?: boolean } = {}): Promise<void> {
    if (applying) return;
    if (!("serviceWorker" in navigator)) {
      toast.error("خدمة تحديث النظام غير متاحة في هذا المتصفح.");
      return;
    }

    try {
      setApplying(true);
      setPhase("saving");
      setUpdateError(null);

      // لقطة استرداد فورية قبل أي انتقال، حتى للنماذج القديمة غير المرتبطة بمسودة نوعية.
      const interactionSaved = saveInteractionDraft();
      const autosaves = flushAutosaves();
      const storefrontSave = requestStorefrontPersistence();
      const storefrontRequired =
        options.automatic ||
        (isPublicHost(window.location.hostname) &&
          (pathnameRef.current === "/store" || pathnameRef.current.startsWith("/store/")));
      if (
        (hasUnsavedInteraction() && !interactionSaved) ||
        !autosaves.ok ||
        !storefrontSave.ok ||
        (storefrontRequired &&
          !automaticStorefrontPersistenceIsSafe(storefrontSave))
      ) {
        markAttemptFailed();
        const message =
          "تعذّر حفظ السلة أو بيانات الطلب محلياً؛ لم نحدّث الصفحة. راجع طلبك ثم أعد المحاولة.";
        setUpdateError(message);
        toast.error(message);
        return;
      }

      let registration =
        registrationRef.current ?? (await getCurrentRegistration());
      let action = decidePwaUpdateAction({
        hasRegistration: !!registration,
        hasWaitingWorker: !!registration?.waiting,
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
          hasActiveWorker: !!registration?.active,
          updateWasSignaled: updateWasSignaledRef.current,
        });
      }

      if (action === "UNAVAILABLE") {
        markAttemptFailed();
        toast.error("خدمة تحديث النظام غير متاحة في هذا المتصفح حالياً.");
        return;
      }

      if (action === "RELOAD_ACTIVE") {
        const candidate = autoAttemptedWorkerRef.current;
        const previousActive = activeWorkerBeforeAttemptRef.current;
        const activationVerified =
          candidate?.state === "activated" ||
          registration?.active === candidate ||
          (!!registration?.active && registration.active !== previousActive);
        if (
          autoAttemptVersionRef.current &&
          candidate &&
          !activationVerified
        ) {
          markAttemptFailed();
          const message =
            "اختفى عامل التحديث قبل إثبات تفعيله؛ لن نعيد فتح الصفحة تلقائياً. أعد المحاولة يدوياً.";
          setUpdateError(message);
          toast.error(message);
          return;
        }
        reopenWithVerifiedUpdate();
        return;
      }

      if (action !== "ACTIVATE_WAITING") {
        const candidate = autoAttemptedWorkerRef.current;
        if (
          autoAttemptVersionRef.current &&
          candidate &&
          (candidate.state === "activated" || registration?.active === candidate)
        ) {
          reopenWithVerifiedUpdate();
          return;
        }
        if (autoAttemptVersionRef.current) {
          markAttemptFailed();
          const message =
            "لم يعد عامل التحديث متاحاً ولم نثبت تفعيله؛ بقيت الصفحة كما هي ويمكنك إعادة المحاولة.";
          setUpdateError(message);
          toast.error(message);
          return;
        }
        setPwaUpdatePending(false);
        setReady(false);
        toast.message("لا يوجد تحديث منتظر الآن؛ النظام على أحدث نسخة.");
        return;
      }

      setPhase("activating");
      const candidateBefore = registration?.waiting ?? null;
      const activation = await activateRegistrationUpdate({
        getRegistration: getCurrentRegistration,
        timeoutMs: UPDATE_ACTIVATION_TIMEOUT_MS,
      });

      if (activation.status === "activated") {
        reopenWithVerifiedUpdate();
        return;
      }

      // ربما أكمل تبويب آخر التفعيل بين آخر polling وهذه القراءة.
      const current = await getCurrentRegistration();
      if (
        candidateBefore?.state === "activated" ||
        current?.active === candidateBefore
      ) {
        reopenWithVerifiedUpdate();
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

      // لا نعيد فتح الصفحة عند timeout أو بقاء waiting: ذلك كان يعيد تشغيل AUTO_APPLY بعد كل
      // تحميل فيصنع حلقة. العلامة الدائمة تمنع المحاولة الصامتة التالية، والزر يبقى لإعادة يدوية.
      markAttemptFailed();
      const message =
        "لم يكتمل التفعيل ولم يُفقد طلبك. لن نعيد فتح الصفحة تلقائياً؛ أعد المحاولة يدوياً.";
      setUpdateError(message);
      toast.error(message);
    } catch (error) {
      console.warn("[pwa] update application failed", error);
      markAttemptFailed();
      const message = "تعذّر تطبيق التحديث الآن؛ بقي عملك محفوظاً ويمكنك إعادة المحاولة.";
      setUpdateError(message);
      toast.error(message);
    } finally {
      setApplying(false);
    }
  }

  if (!ready) return null;
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
              .pwa-update-bar { animation: pwaUpdateSlide 1.15s ease-in-out infinite; }
              @media (prefers-reduced-motion: reduce) { .pwa-update-bar { animation: none; width: 100%; } }
            `}</style>
          </div>
        </div>
      )}

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
              <p className="mt-1 text-sm font-medium text-destructive" role="alert">
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
            onClick={() => void applyUpdate()}
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
    </>
  );
}
