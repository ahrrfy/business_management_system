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
    // لقطة احتياطية فورية قبل التحويل، حتى للنماذج القديمة غير المرتبطة بمسودة نوعية.
    const interactionSaved = saveInteractionDraft();
    const autosaves = flushAutosaves();
    if ((hasUnsavedInteraction() && !interactionSaved) || !autosaves.ok) {
      toast.error("تعذّر حفظ الإدخالات محلياً؛ احفظ العملية يدوياً قبل التحديث.");
      return;
    }
    try {
      await updateRef.current?.(true);
    } catch {
      toast.error("تعذّر تطبيق التحديث الآن؛ يمكنك متابعة عملك بأمان.");
    }
  }

  if (!ready) return null;
  return (
    <aside className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-xl rounded-lg border bg-background p-3 shadow-xl" dir="rtl" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">يتوفر تحديث جديد للنظام</p>
          <p className="mt-0.5 text-sm text-muted-foreground">لن يتغير شيء أثناء عملك. يمكنك المتابعة وتطبيقه عندما تكون جاهزاً.</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setReady(false)}>لاحقاً</Button>
        <Button type="button" size="sm" onClick={() => void applyUpdate()}>
          <RefreshCw className="size-4" aria-hidden />
          {hasUnsavedInteraction() ? "احفظ الإدخالات وحدّث" : "تحديث الآن"}
          <Download className="size-4" aria-hidden />
        </Button>
      </div>
    </aside>
  );
}
