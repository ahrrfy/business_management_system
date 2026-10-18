import React, {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Check, Plus } from "lucide-react";
import "./animated-add-to-cart.css";

export interface AnimatedAddToCartButtonProps {
  /** true only when the cart actually changed; selection/validation returns false. */
  onAdd: (element: HTMLElement) => boolean;
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
  const [added, setAdded] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (disabled) return;
    if (resetRef.current) clearTimeout(resetRef.current);
    // Mutation runs synchronously, before the purely textual acknowledgement.
    const succeeded = onAdd(event.currentTarget) === true;
    setAdded(succeeded);
    if (succeeded) resetRef.current = setTimeout(() => setAdded(false), 1000);
  };
  const sizeClass = size === "xs" ? "btn--xs" : size === "sm" ? "btn--sm" : "";
  const iconSize =
    size === "xs"
      ? "size-3 shrink-0"
      : size === "sm"
        ? "size-3.5 shrink-0"
        : "size-4 shrink-0";
  return (
    <div className={`animated-cart-btn-wrapper ${className}`}>
      <button
        type="button"
        data-state={added ? "added" : "idle"}
        disabled={disabled}
        onClick={handleClick}
        aria-label={ariaLabel ?? label}
        className={`animated-cart-btn ${sizeClass}`}
      >
        {added ? (
          <Check aria-hidden className={iconSize} />
        ) : (
          (icon ?? <Plus aria-hidden className={iconSize} />)
        )}
        <span className="truncate" aria-live="polite">
          {added ? addedLabel : label}
        </span>
      </button>
      {showCartCount && cartCount != null && (
        <div className="animated-cart-counter" aria-live="polite">
          <span className="tabular-nums">{cartCount}</span>
          <span>في سلتك</span>
        </div>
      )}
    </div>
  );
}
