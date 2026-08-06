import { Button } from "@/components/ui/button";
import { flushAutosaves } from "@/lib/autosave";
import { hasUnsavedInteraction, saveInteractionDraft } from "@/lib/interactionDraft";
import { decidePwaUpdateAction } from "@/lib/pwaUpdateLifecycle";
import { setPwaUpdatePending, subscribePwaUpdateOpen } from "@/lib/pwaUpdateStatus";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_ACTIVATION_TIMEOUT_MS = 10_000;
const UPDATE_SNOOZE_MS = 30 * 60 * 1_000;
const UPDATE_SNOOZE_KEY = "alroya.pwa-update.snoozed-until";

function readSnoozedUntil(): number {
  try {
    const value = Number(sessionStorage.getItem(UPDATE_SNOOZE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function waitForActivation(worker: ServiceWorker, requestSkipWaiting?: () => Promise<void>): Promise<boolean> {
  if (worker.state === "activated") return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (activated: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", onStateChange);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve(activated);
    };
    const onStateChange = () => {
      if (worker.state === "activated") finish(true);
      else if (worker.state === "redundant") finish(false);
    };
    const onControllerChange = () => finish(true);
    const timeout = window.setTimeout(() => finish(false), UPDATE_ACTIVATION_TIMEOUT_MS);
    worker.addEventListener("statechange", onStateChange);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    worker.postMessage({ type: "SKIP_WAITING" });
    // Workbox يرسل الرسالة نفسها عبر MessageChannel إلى العامل الذي سجّله هو؛
    // الإبقاء على القناتين يعالج اختلافات المتصفحات/الأغلفة في إيقاظ عامل waiting.
    void requestSkipWaiting?.().catch(() => undefined);
  });
}

/**
 * التحديث يُنزّل في الخلفية ثم يبقى منتظراً. لا يستدعي SKIP_WAITING ولا reload
 * إلا بعد قرار الموظف؛ هذا يمنع مزج حزم إصدارين وفقدان ما يكتبه المستخدم.
 */
export function PwaUpdateManager() {
  const [ready, setReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const updateRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const updateWasSignaledRef = useRef(false);
  const snoozedUntilRef = useRef(readSnoozedUntil());

  const revealUpdate = (force = false) => {
    setPwaUpdatePending(true);
    if (force || Date.now() >= snoozedUntilRef.current) setReady(true);
  };

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;
    void import("virtual:pwa-register").then(({ registerSW }) => {
      const update = registerSW({
        immediate: true,
        onNeedRefresh() {
          if (!disposed) {
            updateWasSignaledRef.current = true;
            revealUpdate();
          }
        },
        onOfflineReady() {
          toast.success("النظام جاهز للعمل دون اتصال");
        },
        onRegisterError(error) {
          // لا نوقف العمل إن فشل فحص التحديث؛ النسخة الفعالة تبقى صالحة.
          console.warn("[pwa] registration/update check failed", error);
        },
        onRegisteredSW(_swUrl, registration) {
          registrationRef.current = registration ?? null;
        },
      });
      updateRef.current = update;
    }).catch((error) => {
      // بيئة التطوير لا توفر virtual:pwa-register دائماً.
      if (import.meta.env.PROD) console.warn("[pwa] update module failed to load", error);
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => subscribePwaUpdateOpen(() => {
    snoozedUntilRef.current = 0;
    revealUpdate(true);
  }), []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const check = () => {
      void navigator.serviceWorker.getRegistration().then(async (registration) => {
        registrationRef.current = registration ?? null;
        // «لاحقاً» يخفي الرسالة لهذه اللحظة فقط؛ عند العودة للتطبيق نعرض التحديث
        // المنتظر مجدداً بعد انتهاء مهلة التأجيل، من دون أن نفرضه.
        if (registration?.waiting) {
          updateWasSignaledRef.current = true;
          revealUpdate();
        }
        await registration?.update();
        if (registration?.waiting) {
          updateWasSignaledRef.current = true;
          revealUpdate();
        }
      }).catch(() => undefined);
    };
    check();
    const interval = window.setInterval(check, 60 * 60 * 1000);
    const visible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, []);

  async function applyUpdate(): Promise<void> {
    if (applying) return;

    // لقطة احتياطية فورية قبل التحويل، حتى للنماذج القديمة غير المرتبطة بمسودة نوعية.
    const interactionSaved = saveInteractionDraft();
    const autosaves = flushAutosaves();
    if ((hasUnsavedInteraction() && !interactionSaved) || !autosaves.ok) {
      toast.error("تعذّر حفظ الإدخالات محلياً؛ احفظ العملية يدوياً قبل التحديث.");
      return;
    }
    try {
      setApplying(true);
      const registration = registrationRef.current ?? await navigator.serviceWorker.getRegistration();
      registrationRef.current = registration ?? null;
      let action = decidePwaUpdateAction({
        hasRegistration: !!registration,
        hasWaitingWorker: !!registration?.waiting,
        hasActiveWorker: !!registration?.active,
        updateWasSignaled: updateWasSignaledRef.current,
      });

      // لا نطلب فحصاً جديداً قبل استهلاك العامل المنتظر الموجود فعلاً؛ ذلك كان
      // يفتح سباقاً يمكن أن يغيّر الحالة بين الضغط وقراءة registration.waiting.
      if (action === "CHECK_AGAIN" && registration) {
        await Promise.race([
          registration.update(),
          new Promise<void>((resolve) => window.setTimeout(resolve, UPDATE_CHECK_TIMEOUT_MS)),
        ]).catch(() => undefined);
        action = decidePwaUpdateAction({
          hasRegistration: true,
          hasWaitingWorker: !!registration.waiting,
          hasActiveWorker: !!registration.active,
          updateWasSignaled: updateWasSignaledRef.current,
        });
      }

      if (action === "ACTIVATE_WAITING" && registration?.waiting) {
        const activated = await waitForActivation(
          registration.waiting,
          updateRef.current ? () => updateRef.current!(false) : undefined,
        );
        if (!activated) {
          toast.error("لم يكتمل تفعيل التحديث؛ لم تُعد الصفحة ويمكنك المحاولة مجدداً.");
          return;
        }
      } else if (action === "RELOAD_ACTIVE") {
        // Workbox قد يعلن التحديث بعد أن أصبح العامل الجديد active مباشرةً في
        // تبويب غير مسيطر عليه؛ لا يوجد waiting لإرسال الرسالة إليه، وإعادة
        // التحميل هي الإجراء الوحيد الذي ينقل الصفحة إلى النسخة الجديدة.
      } else if (action === "UNAVAILABLE") {
        toast.error("خدمة تحديث النظام غير متاحة في هذا المتصفح حالياً.");
        return;
      } else {
        setPwaUpdatePending(false);
        setReady(false);
        toast.message("لا يوجد تحديث منتظر الآن؛ النظام على أحدث نسخة.");
        return;
      }

      setPwaUpdatePending(false);
      setReady(false);
      window.location.reload();
      return;
    } catch {
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
          aria-label="جارٍ تثبيت تحديث النظام"
        >
          <div className="w-full max-w-sm rounded-2xl border bg-card/95 p-7 text-center shadow-2xl backdrop-blur motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2">
            <div className="relative mx-auto grid size-20 place-items-center rounded-full bg-primary/10 text-primary">
              <span className="absolute inset-1 rounded-full border-2 border-primary/30 motion-safe:animate-ping" aria-hidden />
              <RefreshCw className="size-9 motion-safe:animate-spin" aria-hidden />
            </div>
            <p className="mt-5 text-lg font-bold text-foreground">جارٍ تثبيت التحديث</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">سيُعاد فتح النظام تلقائياً خلال لحظات.</p>
            <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full w-2/3 rounded-full bg-primary motion-safe:animate-pulse" />
            </div>
          </div>
        </div>
      )}
      <aside className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-xl rounded-lg border bg-background p-3 shadow-xl" dir="rtl" role="status" aria-live="polite" aria-busy={applying}>
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">يتوفر تحديث جديد للنظام</p>
            <p className="mt-0.5 text-sm text-muted-foreground">لن يتغير شيء أثناء عملك. يمكنك المتابعة وتطبيقه عندما تكون جاهزاً.</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={applying}
            onClick={() => {
              const until = Date.now() + UPDATE_SNOOZE_MS;
              snoozedUntilRef.current = until;
              try { sessionStorage.setItem(UPDATE_SNOOZE_KEY, String(until)); } catch { /* التخزين اختياري */ }
              setPwaUpdatePending(false);
              setReady(false);
            }}
          >
            لاحقاً
          </Button>
          <Button type="button" size="sm" disabled={applying} onClick={() => void applyUpdate()}>
            <RefreshCw className={`size-4 ${applying ? "motion-safe:animate-spin" : ""}`} aria-hidden />
            {applying ? "جارٍ التحديث…" : hasUnsavedInteraction() ? "احفظ الإدخالات وحدّث" : "تحديث الآن"}
            <Download className="size-4" aria-hidden />
          </Button>
        </div>
      </aside>
    </>
  );
}
