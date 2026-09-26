import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import "./animated-add-to-cart.css";

export interface AnimatedAddToCartButtonProps {
  onAdd: (element: HTMLElement) => void;
  disabled?: boolean;
  label?: string;
  addedLabel?: string;
  icon?: ReactNode;
  className?: string;
  cartCount?: number;
  showCartCount?: boolean;
  "aria-label"?: string;
}

export function AnimatedAddToCartButton({
  onAdd,
  disabled = false,
  label = "أضف إلى السلة",
  addedLabel = "تمت الإضافة",
  icon,
  className = "",
  cartCount,
  showCartCount = false,
  "aria-label": ariaLabel,
}: AnimatedAddToCartButtonProps) {
  const [state, setState] = useState<"idle" | "adding" | "added">("idle");
  const [bump, setBump] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const timeoutsRef = useRef<number[]>([]);

  const clearAllTimeouts = () => {
    timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    timeoutsRef.current = [];
  };

  useEffect(() => {
    return () => {
      clearAllTimeouts();
    };
  }, []);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (disabled || state !== "idle") return;

    const sourceElement = e.currentTarget;

    // التحقق من تفضيل تقليل الحركة (prefers-reduced-motion)
    const isReduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (isReduced) {
      onAdd(sourceElement);
      setState("added");
      setBump(true);
      const t1 = window.setTimeout(() => setBump(false), 400);
      const t2 = window.setTimeout(() => setState("idle"), 1200);
      timeoutsRef.current.push(t1, t2);
      return;
    }

    setState("adding");

    // إطلاق الإضافة عند خروج العربة من الكبسولة (الإطار 50 من 60 = 2000ms من دورة 2400ms)
    const addTimer = window.setTimeout(() => {
      onAdd(sourceElement);
      setBump(true);
      const bumpTimer = window.setTimeout(() => setBump(false), 400);
      timeoutsRef.current.push(bumpTimer);
    }, 2000);

    timeoutsRef.current.push(addTimer);
  };

  const handleCartAnimationEnd = (e: React.AnimationEvent<HTMLSpanElement>) => {
    if (e.animationName === "cart-run") {
      setState("added");
      const resetTimer = window.setTimeout(() => {
        setState("idle");
      }, 1000);
      timeoutsRef.current.push(resetTimer);
    }
  };

  return (
    <div className={`animated-cart-btn-wrapper ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        data-state={state}
        disabled={disabled}
        onClick={handleClick}
        aria-label={ariaLabel ?? label}
        className="animated-cart-btn"
      >
        {/* الكيس الخارجي الحبري بلون غامق فوق الكبسولة */}
        <svg className="bag bag--out" viewBox="0 0 24 24" width="22" height="24" aria-hidden="true">
          <path className="bag_handle" d="M 7 9 C 7 4.5 17 4.5 17 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <rect className="bag_body" x="4" y="9" width="16" height="13" rx="2.5" fill="currentColor" />
        </svg>

        {/* الكبسولة الداكنة المقتطعة */}
        <span className="pill">
          {/* الكيس الداخلي الأبيض داخل الكبسولة */}
          <svg className="bag bag--in" viewBox="0 0 24 24" width="22" height="24" aria-hidden="true">
            <path className="bag_handle" d="M 7 9 C 7 4.5 17 4.5 17 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <rect className="bag_body" x="4" y="9" width="16" height="13" rx="2.5" fill="currentColor" />
          </svg>

          {/* عربة التسوق المتحركة */}
          <span className="cart" onAnimationEnd={handleCartAnimationEnd} aria-hidden="true">
            <svg viewBox="0 0 52 44" width="36" height="30">
              <path className="cart__fill" d="M 16 11 h 29 l -3.5 13 h -20.5 z" fill="currentColor" opacity="0.25" />
              <g className="cart__line" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M 4 7 h 7 l 6.5 20 h 24 l 4.5 -16 H 13" />
                <circle cx="20" cy="36" r="3.5" fill="currentColor" stroke="none" />
                <circle cx="39" cy="36" r="3.5" fill="currentColor" stroke="none" />
              </g>
            </svg>
          </span>

          {/* نص الزر */}
          <span className="pill__label">
            {state === "added" ? (
              <>
                <Check aria-hidden className="size-4.5 stroke-[2.5]" />
                <span>{addedLabel}</span>
              </>
            ) : (
              <>
                {icon ?? <Plus aria-hidden className="size-4.5 stroke-[2.5]" />}
                <span>{label}</span>
              </>
            )}
          </span>
        </span>
      </button>

      {/* مؤشر عدد القطع في السلة أسفل الكبسولة كما في النموذج */}
      {showCartCount && cartCount != null && (
        <div className={`animated-cart-counter ${bump ? "bump" : ""}`}>
          <span className="tabular-nums font-mono text-sm">{cartCount}</span>
          <span>في سلتك</span>
        </div>
      )}
    </div>
  );
}
