import { ShoppingBag, ArrowLeft } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { fmtInt } from "@/lib/money";
import { APPLE_REDUCED_TRANSITION, APPLE_SPRING_SNAPPY } from "./storefrontMotion";

interface StorefrontFloatingCartProps {
  cartCount: number;
  cartSubtotal: number;
  onOpenCart: () => void;
  visible?: boolean;
  className?: string;
}

/**
 * شريط السلة الذكي العائم — طبقة زجاجية في متناول الإبهام بفيزياء نوابض قابلة للمقاطعة.
 */
export function StorefrontFloatingCart({
  cartCount,
  cartSubtotal,
  onOpenCart,
  visible = true,
  className = "",
}: StorefrontFloatingCartProps) {
  const prefersReducedMotion = useReducedMotion();
  const shouldShow = visible && cartCount > 0;
  const transition = prefersReducedMotion
    ? APPLE_REDUCED_TRANSITION
    : APPLE_SPRING_SNAPPY;

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.aside
          key="store-floating-cart"
          aria-label="شريط السلة السريع"
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.96 }}
          transition={transition}
          className={`store-floating-cart fixed inset-x-3 sm:inset-x-6 z-50 mx-auto max-w-lg ${className}`}
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-[#1d1d1f]/90 p-2 sm:p-2.5 text-white shadow-xl shadow-slate-950/25 ring-1 ring-white/15 backdrop-blur-[18px] saturate-180">
            {/* معلومات السلة وإجمالي المبلغ */}
            <div className="flex items-center gap-2.5 pr-2">
              <div className="relative flex size-9 sm:size-10 shrink-0 items-center justify-center rounded-xl bg-white/12 text-white">
                <ShoppingBag aria-hidden className="size-4 sm:size-5" />
                <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 sm:h-5 sm:min-w-5 items-center justify-center rounded-full bg-white px-1 text-[10px] sm:text-[11px] font-bold text-slate-950 shadow-xs tabular-nums">
                  {cartCount}
                </span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-[10px] sm:text-[11px] font-medium text-slate-300">
                  {cartCount === 1
                    ? "منتج واحد"
                    : cartCount === 2
                      ? "منتجان"
                      : cartCount <= 10
                        ? `${cartCount} منتجات`
                        : `${cartCount} منتج`}
                </p>
                <p className="text-xs sm:text-sm font-bold tracking-tight text-white whitespace-nowrap tabular-nums">
                  {fmtInt(cartSubtotal)} د.ع
                </p>
              </div>
            </div>

            {/* زر إتمام الطلب الفوري باستجابة فورية عند الضغط */}
            <button
              type="button"
              onClick={onOpenCart}
              className="store-action-button flex h-9 sm:h-10 shrink-0 touch-manipulation items-center gap-1.5 rounded-xl bg-white px-3.5 sm:px-4 text-xs font-bold text-slate-950 shadow-xs transition-[transform,background-color] duration-100 ease-out hover:bg-slate-100 active:scale-[0.97] whitespace-nowrap"
            >
              <span>إتمام الطلب</span>
              <ArrowLeft aria-hidden className="size-3.5 sm:size-4" />
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
