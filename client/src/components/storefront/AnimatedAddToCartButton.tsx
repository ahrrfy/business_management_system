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
  size?: "default" | "sm" | "xs";
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
  size = "default",
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

  // حساب أبعاد الحركة ديناميكياً لضمان خروج ودخول العربة بدقة في جميع مقاسات الشاشات والأزرار
  useEffect(() => {
    const updateDimensions = () => {
      if (buttonRef.current) {
        const width = buttonRef.current.offsetWidth || (size === "xs" ? 110 : size === "sm" ? 140 : 280);
        const half = Math.ceil(width / 2) + (size === "xs" ? 25 : size === "sm" ? 35 : 50);
        buttonRef.current.style.setProperty("--from-left", `-${half}px`);
        buttonRef.current.style.setProperty("--to-exit", `${half}px`);
        buttonRef.current.style.setProperty("--to-centre", "0px");
      }
    };
    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, [size]);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
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
      const bumpTimer = window.setTimeout(() => setBump(false), 450);
      timeoutsRef.current.push(bumpTimer);
    }, 2000);

    // ضمان الانتقال لحالة تمت الإضافة بنهاية دورة الـ 2400ms
    const fallbackTimer = window.setTimeout(() => {
      setState("added");
      const resetTimer = window.setTimeout(() => {
        setState("idle");
      }, 1400);
      timeoutsRef.current.push(resetTimer);
    }, 2420);

    timeoutsRef.current.push(addTimer, fallbackTimer);
  };

  const handleCartAnimationEnd = (e: React.AnimationEvent<HTMLSpanElement>) => {
    if (e.animationName === "cart-run") {
      setState("added");
      const resetTimer = window.setTimeout(() => {
        setState("idle");
      }, 1400);
      timeoutsRef.current.push(resetTimer);
    }
  };

  const sizeClass = size === "xs" ? "btn--xs" : size === "sm" ? "btn--sm" : "";
  const bagWidth = size === "xs" ? "14" : size === "sm" ? "17" : "20";
  const bagHeight = size === "xs" ? "16" : size === "sm" ? "19" : "22";
  const cartWidth = size === "xs" ? "22" : size === "sm" ? "28" : "36";
  const cartHeight = size === "xs" ? "18" : size === "sm" ? "24" : "30";
  const iconSizeClass = size === "xs" ? "size-3 stroke-[2.5]" : size === "sm" ? "size-3.5 stroke-[2.5]" : "size-4.5 stroke-[2.5]";

  return (
    <div className={`animated-cart-btn-wrapper ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        data-state={state}
        disabled={disabled}
        onClick={handleClick}
        aria-label={ariaLabel ?? label}
        className={`animated-cart-btn ${sizeClass}`}
      >
        {/* الكيس الخارجي الحبري بلون غامق فوق الكبسولة */}
        <svg className="bag bag--out" viewBox="0 0 24 24" width={bagWidth} height={bagHeight} aria-hidden="true">
          <path className="bag_handle" d="M 7 9 C 7 4.5 17 4.5 17 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <rect className="bag_body" x="4" y="9" width="16" height="13" rx="2.5" fill="currentColor" />
        </svg>

        {/* الكبسولة الداكنة المقتطعة */}
        <span className="pill">
          {/* الكيس الداخلي الأبيض داخل الكبسولة */}
          <svg className="bag bag--in" viewBox="0 0 24 24" width={bagWidth} height={bagHeight} aria-hidden="true">
            <path className="bag_handle" d="M 7 9 C 7 4.5 17 4.5 17 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <rect className="bag_body" x="4" y="9" width="16" height="13" rx="2.5" fill="currentColor" />
          </svg>

          {/* عربة التسوق المتحركة */}
          <span className="cart" onAnimationEnd={handleCartAnimationEnd} aria-hidden="true">
            <svg viewBox="0 0 52 44" width={cartWidth} height={cartHeight}>
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
                <Check aria-hidden className={iconSizeClass} />
                <span>{addedLabel}</span>
              </>
            ) : (
              <>
                {icon ?? <Plus aria-hidden className={iconSizeClass} />}
                <span>{label}</span>
              </>
            )}
          </span>
        </span>
      </button>

      {/* مؤشر عدد القطع في السلة أسفل الكبسولة كما في النموذج */}
      {showCartCount && cartCount != null && (
        <div className={`animated-cart-counter ${bump ? "bump" : ""}`} aria-live="polite">
          <span className="tabular-nums font-mono text-sm">{cartCount}</span>
          <span>في سلتك</span>
        </div>
      )}
    </div>
  );
}
