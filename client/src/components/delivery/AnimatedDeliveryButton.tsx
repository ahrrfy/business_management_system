import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Truck, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AnimatedDeliveryButtonProps
  extends React.ComponentProps<typeof Button> {
  isDispatching?: boolean;
  isDispatched?: boolean;
  label?: string;
  dispatchingLabel?: string;
  dispatchedLabel?: string;
}

/**
 * زر تفاعلي مخصص لحركات وإسناد التوصيل مع شاحنة متحركة وتأثيرات انطلاق.
 */
export function AnimatedDeliveryButton({
  isDispatching = false,
  isDispatched = false,
  label = "تأكيد التسليم للمندوب",
  dispatchingLabel = "جاري إسناد وانطلاق الشحنة…",
  dispatchedLabel = "تم تسليم الشحنة وانطلاق المندوب!",
  className,
  disabled,
  children,
  onClick,
  ...props
}: AnimatedDeliveryButtonProps) {
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <Button
      disabled={disabled || isDispatching || isDispatched}
      onClick={onClick}
      className={cn(
        "relative overflow-hidden transition-all duration-300 active:scale-[0.98]",
        isDispatched
          ? "bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)] font-bold shadow-md"
          : "",
        className
      )}
      {...props}
    >
      <AnimatePresence mode="wait" initial={false}>
        {isDispatched ? (
          <motion.div
            key="dispatched"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ type: "spring", stiffness: 350, damping: 20 }}
            className="flex items-center gap-2"
          >
            <motion.div
              initial={prefersReducedMotion ? {} : { rotate: -45, scale: 0 }}
              animate={prefersReducedMotion ? {} : { rotate: 0, scale: 1 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 400 }}
              className="rounded-full bg-white/20 p-0.5"
            >
              <Check className="size-4 stroke-[3]" />
            </motion.div>
            <span>{dispatchedLabel}</span>
          </motion.div>
        ) : isDispatching ? (
          <motion.div
            key="dispatching"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex items-center gap-2"
          >
            {/* أيقونة شاحنة تسير بسرعة */}
            {!prefersReducedMotion ? (
              <motion.div
                animate={{
                  x: [15, -15, 15],
                  y: [0, -1, 0, -1, 0],
                }}
                transition={{
                  repeat: Infinity,
                  duration: 0.8,
                  ease: "easeInOut",
                }}
                className="relative"
              >
                <Truck className="size-4" />
                <motion.div
                  animate={{ opacity: [0.8, 0], x: [0, 8] }}
                  transition={{ repeat: Infinity, duration: 0.3 }}
                  className="absolute -right-1 top-1 h-0.5 w-2 bg-white/60 rounded-full"
                />
              </motion.div>
            ) : (
              <Loader2 className="size-4 animate-spin" />
            )}
            <span>{dispatchingLabel}</span>
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-2"
          >
            <motion.div
              whileHover={
                prefersReducedMotion
                  ? {}
                  : {
                      x: -2,
                      transition: { repeat: Infinity, repeatType: "reverse", duration: 0.15 },
                    }
              }
            >
              <Truck className="size-4 shrink-0" />
            </motion.div>
            <span>{children || label}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </Button>
  );
}
