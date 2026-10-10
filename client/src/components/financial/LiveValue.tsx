import React, { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./LiveValue.css";

type Props = {
  value: string | number | null | undefined;
  children?: ReactNode;
  className?: string;
  /** Suppress a false update animation when a table position changes to a different record. */
  identity?: unknown;
};

/** Displays the exact new value immediately; never interpolates or invents monetary values. */
export function LiveValue({ value, children, className, identity }: Props) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef({ value, identity });
  useLayoutEffect(() => {
    const changed = previous.current.value !== value && previous.current.identity === identity;
    previous.current = { value, identity };
    if (!changed || value == null || value === "" || element.current?.parentElement?.closest(".live-financial-value") || document.visibilityState === "hidden" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.current?.animate?.([
      { transform: "perspective(500px) rotateX(-18deg)", opacity: 0.65 },
      { transform: "perspective(500px) rotateX(0deg)", opacity: 1 },
    ], { duration: 180, easing: "ease-out" });
    return () => animation?.cancel();
  }, [value, identity]);
  return <span ref={element} className={cn("live-financial-value tabular-nums", className)}>{children ?? value}</span>;
}
