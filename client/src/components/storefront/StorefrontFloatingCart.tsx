import { ShoppingBag, ArrowLeft } from "lucide-react";
import { fmtInt } from "@/lib/money";

interface StorefrontFloatingCartProps {
  cartCount: number;
  cartSubtotal: number;
  onOpenCart: () => void;
  className?: string;
}

/**
 * شريط السلة الذكي العائم — نمط عالمي فاخر في متناول الإبهام (Mobile Thumb Zone).
 * يظهر بنعومة عند إضافة عناصر للسلة دون حجب محتوى التصفح.
 */
export function StorefrontFloatingCart({
  cartCount,
  cartSubtotal,
  onOpenCart,
  className = "",
}: StorefrontFloatingCartProps) {
  if (cartCount <= 0) return null;

  return (
    <aside
      aria-label="شريط السلة السريع"
      className={`store-floating-cart fixed inset-x-3 sm:inset-x-6 z-50 mx-auto max-w-lg transition-all duration-300 ${className}`}
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
    >
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-[#0E806A] p-2 sm:p-2.5 text-white shadow-xl shadow-emerald-950/25 ring-1 ring-white/20 backdrop-blur-md">
        {/* معلومات السلة وإجمالي المبلغ */}
        <div className="flex items-center gap-2.5 pr-2">
          <div className="relative flex size-9 sm:size-10 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white">
            <ShoppingBag aria-hidden className="size-4 sm:size-5" />
            <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 sm:h-5 sm:min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] sm:text-[11px] font-black text-slate-950 shadow-xs">
              {cartCount}
            </span>
          </div>
          <div>
            <p className="text-[10px] sm:text-[11px] font-medium text-emerald-100">
              {cartCount === 1 ? "منتج واحد" : cartCount === 2 ? "منتجان" : `${cartCount} منتجات`}
            </p>
            <p className="text-xs sm:text-sm font-black tracking-tight text-white">
              {fmtInt(cartSubtotal)} د.ع
            </p>
          </div>
        </div>

        {/* زر إتمام الطلب الفوري في متناول الإبهام */}
        <button
          type="button"
          onClick={onOpenCart}
          className="store-action-button flex h-9 sm:h-10 items-center gap-1.5 rounded-xl bg-white px-3.5 sm:px-4 text-xs font-black text-[#0E806A] shadow-xs transition-all hover:bg-emerald-50 active:scale-95"
        >
          <span>إتمام الطلب</span>
          <ArrowLeft aria-hidden className="size-3.5 sm:size-4" />
        </button>
      </div>
    </aside>
  );
}
