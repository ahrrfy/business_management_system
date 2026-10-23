/** Prefer a matching line that still has unselected returnable quantity. */
export function eligibleReturnLine<T>(
  items: readonly T[],
  matches: (item: T) => boolean,
  remaining: (item: T) => number,
  selected: (item: T) => number,
): T | undefined {
  const candidates = items.filter(matches);
  // Keep an exhausted match so callers can distinguish it from an unknown item.
  return (
    candidates.find((item) => remaining(item) > selected(item)) ?? candidates[0]
  );
}
