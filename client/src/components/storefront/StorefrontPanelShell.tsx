import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight } from "lucide-react";
import { useRef, type ReactNode } from "react";

/** غلاف لوح بملء الشاشة (سلة/دفع/تأكيد) — ترويسة ثابتة + محتوى قابل للتمرير. */
export function StorefrontPanelShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[55] bg-slate-950/45" />
        <DialogPrimitive.Content dir="rtl" aria-describedby={undefined} onOpenAutoFocus={(event) => { event.preventDefault(); closeRef.current?.focus(); }} onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = restoreFocusRef.current;
          restoreFocusRef.current = null;
          window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
        }} className="storefront fixed inset-0 z-[56] flex flex-col overflow-hidden bg-[#fff8ef] outline-none dark:bg-slate-950">
          <header className="flex shrink-0 items-center gap-3 border-b border-[#f0e2d5] bg-white/95 px-4 py-3 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900" style={{ paddingTop: "calc(.75rem + env(safe-area-inset-top))" }}>
            <DialogPrimitive.Close asChild>
              <button ref={closeRef} type="button" aria-label="رجوع" className="flex size-11 items-center justify-center rounded-full transition hover:bg-slate-100 dark:hover:bg-slate-800">
                <ArrowRight aria-hidden className="size-5 text-slate-600 dark:text-slate-300" />
              </button>
            </DialogPrimitive.Close>
            <DialogPrimitive.Title className="text-base font-extrabold text-slate-900 dark:text-white">{title}</DialogPrimitive.Title>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-2xl px-4 py-4 sm:px-6" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>{children}</div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
