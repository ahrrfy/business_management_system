import type { Transition } from "framer-motion";

/** Critically damped settle spring (Apple damping 1.0, response 0.36s): zero accidental bounce. */
export const APPLE_SPRING_SETTLE: Transition = {
  type: "spring",
  bounce: 0,
  duration: 0.36,
};

/** Snappy toolbar/floating chrome spring for sticky bars and compact capsules. */
export const APPLE_SPRING_SNAPPY: Transition = {
  type: "spring",
  bounce: 0,
  duration: 0.28,
};

/** Gesture-driven sheet spring allowing subtle momentum overshoot on flick/release. */
export const APPLE_SPRING_SHEET: Transition = {
  type: "spring",
  bounce: 0.1,
  duration: 0.34,
};

/** Non-vestibular cross-fade transition used when `prefers-reduced-motion` is active. */
export const APPLE_REDUCED_TRANSITION: Transition = {
  duration: 0.16,
  ease: "easeOut",
};

/**
 * WWDC *Designing Fluid Interfaces* exponential-decay projection.
 * Projects where a dragged sheet/drawer is heading from its release velocity (px/s).
 */
export function projectMomentum(
  velocityPxPerSec: number,
  decelerationRate = 0.998,
): number {
  return (
    ((velocityPxPerSec / 1000) * decelerationRate) / (1 - decelerationRate)
  );
}

/**
 * Progressive rubber-band boundary resistance so dragging past an edge feels elastic, never frozen.
 */
export function rubberbandOffset(
  overshoot: number,
  dimension: number,
  constant = 0.55,
): number {
  const safeDimension = Math.max(1, dimension);
  return (
    (overshoot * safeDimension * constant) /
    (safeDimension + constant * Math.abs(overshoot))
  );
}
