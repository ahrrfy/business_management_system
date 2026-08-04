import { Button } from "@/components/ui/button";
import { flushAutosaves } from "@/lib/autosave";
import { hasUnsavedInteraction, saveInteractionDraft } from "@/lib/interactionDraft";
import { setPwaUpdatePending, subscribePwaUpdateOpen } from "@/lib/pwaUpdateStatus";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * التحديث يُنزّل في الخلفية ثم يبقى منتظراً. لا يستدعي SKIP_WAITING ولا reload
 * إلا بعد قرار الموظف؛ هذا يمنع مزج حزم إصدارين وفقدان ما يكتبه المستخدم.
 */
export function PwaUpdateManager() {
  const [ready, setReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const updateRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;
    void import("virtual:pwa-register").then(({ registerSW }) => {
      const update = registerSW({
        immediate: true,
        onNeedRefresh() {
          if (!disposed) {
            setPwaUpdatePending(true);
            setReady(true);
          }
        },
        onOfflineReady() {
          toast.success("النظام جاهز للعمل دون اتصال");
        },
        onRegisterError(error) {
          // لا نوقف العمل إن فشل فحص التحديث؛ النسخة الفعالة تبقى صالحة.
          console.warn("[pwa] registration/update check failed", error);
        },
      });
      updateRef.current = update;
    }).catch(() => {
      // بيئة التطوير لا توفر virtual:pwa-register دائماً.
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => subscribePwaUpdateOpen(() => setReady(true)), []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const check = () => {
      void navigator.serviceWorker.getRegistration().then((registration) => {
        // «لاحقاً» يخفي الرسالة لهذه اللحظة فقط؛ عند العودة للتطبيق نعرض التحديث
        // المنتظر مجدداً من دون أن نفرضه.
        if (registration?.waiting) {
          setPwaUpdatePending(true);
          setReady(true);
        }
        return registration?.update();
      }).catch(() => undefined);
    };
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

      // لا نعتمد على دالة vite-plugin-pwa وحدها: قد يظهر العامل المنتظر قبل أن
      // ينتهي تحميل وحدة التسجيل الديناميكية، وكان ذلك يحوّل نقرة الزر إلى no-op.
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
      const waitingWorker = registration?.waiting;

      if (waitingWorker) {
        // Workbox في وضع prompt يستقبل هذه الرسالة ويستدعي skipWaiting().
        // clientsClaim معطّل عمداً، لذلك نعيد التحميل بعد التفعيل ليبدأ التبويب
        // نفسه تحت سيطرة الإصدار الجديد.
        const activated = new Promise<void>((resolve) => {
          const onStateChange = () => {
            if (waitingWorker.state === "activated" || waitingWorker.state === "redundant") {
              waitingWorker.removeEventListener("statechange", onStateChange);
              resolve();
            }
          };
          waitingWorker.addEventListener("statechange", onStateChange);
        });
        waitingWorker.postMessage({ type: "SKIP_WAITING" });
        await Promise.race([
          activated,
          new Promise<void>((resolve) => window.setTimeout(resolve, 3_000)),
        ]);
        window.location.reload();
        return;
      }

      // مسار احتياطي لحالة اكتشاف التحديث من vite-plugin-pwa نفسه.
      if (updateRef.current) {
        await updateRef.current(true);
        return;
      }

      toast.message("جارٍ تجهيز التحديث؛ أعد المحاولة بعد لحظات.");
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
