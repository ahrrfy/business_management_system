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

const UPDATE_CHECK_TIMEOUT_MS = 8_000;
const UPDATE_ACTIVATION_TIMEOUT_MS = 12_000;
const RELOAD_MARKER_KEY = "alroya.pwa-update.reload-requested";
const RELOAD_MARKER_MAX_AGE_MS = 2 * 60 * 1_000;

type UpdatePhase = "saving" | "activating" | "reopening";
export type PwaUpdateDelivery = "AUTO_APPLY" | "PROMPT" | "NONE";

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
  const [ready, setReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("saving");
  const [autoApplyTicket, setAutoApplyTicket] = useState(0);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const updateWasSignaledRef = useRef(false);
  const autoAttemptedWorkerRef = useRef<ServiceWorker | null>(null);

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
      waitingWorker &&
      autoAttemptedWorkerRef.current !== waitingWorker
    ) {
      // تذكرة واحدة لكل عامل منتظر تمنع حلقة إعادة محاولات صامتة إذا فشل التفعيل فعلاً.
      autoAttemptedWorkerRef.current = waitingWorker;
      setAutoApplyTicket((ticket) => ticket + 1);
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
    setPhase("reopening");
    setPwaUpdatePending(false);
    setReady(false);
    rememberVerifiedActivation();
    window.location.reload();
  }

  async function applyUpdate(): Promise<void> {
    if (applying) return;
    if (!("serviceWorker" in navigator)) {
      toast.error("خدمة تحديث النظام غير متاحة في هذا المتصفح.");
      return;
    }

    try {
      setApplying(true);
      setPhase("saving");

      // لقطة استرداد فورية قبل أي انتقال، حتى للنماذج القديمة غير المرتبطة بمسودة نوعية.
      const interactionSaved = saveInteractionDraft();
      const autosaves = flushAutosaves();
      if ((hasUnsavedInteraction() && !interactionSaved) || !autosaves.ok) {
        toast.error(
          "تعذّر حفظ الإدخالات محلياً؛ احفظ العملية يدوياً قبل التحديث.",
        );
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
        toast.error("خدمة تحديث النظام غير متاحة في هذا المتصفح حالياً.");
        return;
      }

      if (action === "RELOAD_ACTIVE") {
        reopenWithVerifiedUpdate();
        return;
      }

      if (action !== "ACTIVATE_WAITING") {
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

      // skipWaiting أُرسل فعلاً للعامل المنتظر. بدل حبس الموظّف خلف خطأ «استغرق أطول من المتوقع»
      // (كثيراً ما يكتمل التفعيل بُعيد نافذة الاستطلاع على WebViews التي تُجمّد العامل)، نُعيد فتح
      // الصفحة: التنقّل الجديد يتبنّى العامل المُفعَّل، وفحص ما بعد إعادة الفتح (RELOAD_MARKER) يُبلّغ
      // بصدق إن لم تُطبَّق النسخة فعلاً. العمل حُفظ محلياً أعلاه، فإعادة الفتح آمنة بلا فقد.
      if (activation.status === "timeout" || current?.waiting) {
        reopenWithVerifiedUpdate();
        return;
      }

      // لا عامل منتظر ولم يُفعَّل (نادر: اختفى أو فشل التثبيت) — رسالة صادقة بلا حبس الموظّف.
      toast.error("لم يكتمل التفعيل ولم يُفقد عملك؛ أعد المحاولة.");
    } catch (error) {
      console.warn("[pwa] update application failed", error);
      toast.error("تعذّر تطبيق التحديث الآن؛ يمكنك متابعة عملك بأمان.");
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
            <p className="mt-0.5 text-sm text-muted-foreground">
              سيُحفظ العمل محلياً ثم يُعاد فتح النظام بعد التحقق من النسخة
              الجديدة.
            </p>
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
