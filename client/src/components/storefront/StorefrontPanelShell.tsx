import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion, useDragControls, useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useRef, type ReactNode } from "react";
import {
  APPLE_REDUCED_TRANSITION,
  APPLE_SPRING_SETTLE,
  projectMomentum,
} from "./storefrontMotion";

/**
 * غلاف لوح بملء الشاشة (سلة/دفع/تأكيد/تتبّع) — ترويسة زجاجية شفافة،
 * دخول بنابض محكم، وسحب للخارج في نفس اتجاه الرجوع (Spatial consistency).
 */
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
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const prefersReducedMotion = useReducedMotion();
  const dragControls = useDragControls();
  const settleTransition = prefersReducedMotion
    ? APPLE_REDUCED_TRANSITION
    : APPLE_SPRING_SETTLE;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay asChild>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={settleTransition}
            className="fixed inset-0 z-[55] bg-slate-950/40 backdrop-blur-[8px]"
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          dir="rtl"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = restoreFocusRef.current;
            restoreFocusRef.current = null;
            window.requestAnimationFrame(() => {
              if (trigger?.isConnected) trigger.focus();
            });
          }}
          asChild
        >
          <motion.div
            initial={
              prefersReducedMotion
                ? { opacity: 0 }
                : { opacity: 0, y: 18, scale: 0.99 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={settleTransition}
            drag={prefersReducedMotion ? false : "y"}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.08, bottom: 0.4 }}
            dragTransition={{ bounceStiffness: 420, bounceDamping: 36 }}
            onDragEnd={(_, info) => {
              const projected = info.offset.y + projectMomentum(info.velocity.y, 0.99);
              if (projected > 180 || info.velocity.y > 650) {
                onClose();
              }
            }}
            className="storefront fixed inset-0 z-[56] flex flex-col overflow-hidden bg-[#f5f5f7] outline-none dark:bg-slate-950"
          >
            <header
              onPointerDown={(event) => {
                if ((event.target as HTMLElement)?.closest("button, a, input")) return;
                if (!prefersReducedMotion) dragControls.start(event);
              }}
              className="store-translucent-chrome flex shrink-0 touch-none select-none items-center gap-3 border-b px-4 py-3 shadow-xs"
              style={{ paddingTop: "calc(.75rem + env(safe-area-inset-top))" }}
            >
              <DialogPrimitive.Close asChild>
                <button
                  ref={closeRef}
                  type="button"
                  aria-label="رجوع"
                  className="flex size-11 touch-manipulation items-center justify-center rounded-full transition-[transform,background-color] duration-100 ease-out hover:bg-slate-200/70 active:scale-[0.94] dark:hover:bg-slate-800"
                >
                  <ArrowRight aria-hidden className="size-5 text-slate-700 dark:text-slate-200" />
                </button>
              </DialogPrimitive.Close>
              <DialogPrimitive.Title className="store-display-title text-base font-black text-slate-900 dark:text-white">
                {title}
              </DialogPrimitive.Title>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div
                className="mx-auto w-full max-w-2xl px-3 py-4 sm:px-6"
                style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
              >
                {children}
              </div>
            </div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
