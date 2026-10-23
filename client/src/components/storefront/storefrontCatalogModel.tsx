export type Panel =
  | null
  | "cart"
  | "checkout"
  | "confirmation"
  | "track"
  | "label";

export type AvailabilityFilter = "IN_STOCK" | "ALL";

export type PriceFilter =
  | "ALL"
  | "UNDER_5000"
  | "FROM_5000_TO_15000"
  | "OVER_15000";

export type CatalogSort =
  | "RECOMMENDED"
  | "PRICE_ASC"
  | "PRICE_DESC"
  | "BEST_SELLERS";

export type StorefrontSource = "settings" | "categories" | "offers" | "catalog";

export const STOREFRONT_SOURCE_LABELS: Record<StorefrontSource, string> = {
  settings: "إعدادات المتجر",
  categories: "الفئات والأقسام",
  offers: "العروض",
  catalog: "المنتجات",
};

export function collectStorefrontFailures(
  failed: Record<StorefrontSource, boolean>,
): StorefrontSource[] {
  return (Object.keys(STOREFRONT_SOURCE_LABELS) as StorefrontSource[]).filter(
    (source) => failed[source],
  );
}

export function storefrontCategoryCount(
  category: { productCount: number; availableCount?: number },
  availability: AvailabilityFilter,
): number {
  return availability === "IN_STOCK"
    ? (category.availableCount ?? category.productCount)
    : category.productCount;
}

export function shouldAutoLoadStorefrontNextPage(input: {
  isIntersecting: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
}): boolean {
  return (
    input.isIntersecting &&
    input.hasNextPage &&
    !input.isFetchingNextPage &&
    !input.isError
  );
}

export function matchesPriceFilter(
  price: number,
  filter: PriceFilter,
): boolean {
  switch (filter) {
    case "UNDER_5000":
      return price < 5_000;
    case "FROM_5000_TO_15000":
      return price >= 5_000 && price <= 15_000;
    case "OVER_15000":
      return price > 15_000;
    default:
      return true;
  }
}

export function hasStorefrontAnalyticsConsent(): boolean {
  try {
    const raw = window.localStorage.getItem("arabia_store_consent_v1");
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { analytics?: unknown };
    return parsed.analytics === true;
  } catch {
    return false;
  }
}

export type ShareFeedbackTone = "ok" | "info" | "warn" | "err";

export const SHARE_FEEDBACK_TONE_CLASS: Record<ShareFeedbackTone, string> = {
  ok: "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  info: "border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  warn: "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  err: "border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
};

export function formatStorefrontReservationDeadline(
  value: Date | string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "وقت غير متاح";
  return new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Baghdad",
  }).format(date);
}

export const STORE_NAME = "المكتبة العربية";
export const STORE_TAGLINE =
  "قرطاسية • طباعة • هدايا — يصلك أينما كنت في العراق";

/** An explicit empty collection stays empty; undefined delegates to the category/search scope. */
export function storefrontCatalogProductScope(
  showWishlist: boolean,
  wishlistIds: ReadonlySet<number>,
  thematicIds?: readonly number[],
): number[] | undefined {
  if (showWishlist) {
    const scope = thematicIds == null ? null : new Set(thematicIds);
    return Array.from(wishlistIds)
      .filter((id) => scope == null || scope.has(id))
      .slice(0, 500);
  }
  return thematicIds?.slice(0, 500);
}
