import {
  STUDIO_IMAGE_HEALTH_LABELS as STATE_LABEL,
  STUDIO_DISCOVERY_SORT_LABELS as SORT_LABEL,
  type StudioImageHealth as Health,
  type StudioDiscoverySort as SortOption,
} from "@shared/terms";
export type {
  StudioImageHealth as Health,
  StudioDiscoverySort as SortOption,
} from "@shared/terms";
export const STATE_VARIANT: Record<
  Health,
  "danger" | "warning" | "info" | "success" | "neutral"
> = {
  HIGH_VALUE_NO_IMAGE: "danger",
  CONSIGNMENT_NO_IMAGE: "danger",
  HAS_IMAGE_NO_BARCODE: "danger",
  CORRUPTED_OR_UNPROCESSED_IMAGE: "warning",
  REDUNDANT_VARIANT_IMAGE: "warning",
  NO_IMAGES: "danger",
  BUNDLE_NO_IMAGE: "danger",
  SINGLE_IMAGE: "warning",
  PARENT_ONLY_HAS_VARIANTS: "info",
  VARIANTS_INCOMPLETE: "info",
  HEALTHY: "success",
};

export const STATE_TOOLTIP: Record<Health, string> = {
  HIGH_VALUE_NO_IMAGE:
    "منتجات مطلوبة ومهمة لكنها بلا أي صور معتمدة. التدخل الفوري هنا ينقذ مبيعات مؤكدة!",
  CONSIGNMENT_NO_IMAGE:
    "بضاعة أمانة مهملة بلا صور، مما يعطل مبيعاتها ويضر بالعلاقة مع الموردين.",
  HAS_IMAGE_NO_BARCODE:
    "المنتج له صورة معتمدة ولكن وحداته تفتقر لباركود، مما يعطل البيع والمخزن.",
  CORRUPTED_OR_UNPROCESSED_IMAGE:
    "الصورة معطوبة أو فقدت بياناتها الوصفية وتسبب بطئاً أو تظهر مكسورة للزبون.",
  REDUNDANT_VARIANT_IMAGE:
    "تم استخدام نفس الصورة الجماعية لكل بدائل المنتج. يجب تصوير كل بديل على حدة.",
  NO_IMAGES:
    "منتجات نشطة بلا أي صورة معتمدة — أنشئ حملة تصوير أو أطلق حملة فورية.",
  BUNDLE_NO_IMAGE:
    "حزم وبكجات مجمعة بلا صور موحدة — تتطلب تصوير المجموعة معاً.",
  SINGLE_IMAGE:
    "منتج له صورة واحدة للأصل — تحقق من البدائل إن كانت تحتاج زوايا وصوراً مستقلة.",
  PARENT_ONLY_HAS_VARIANTS:
    "المنتج الأصل له صورة ولكن بدائله تفتقر لصور خاصة بها.",
  VARIANTS_INCOMPLETE: "أحد بدائل هذا المنتج ينقصه صور خاصة — أنشئ حملة تشمله.",
  HEALTHY: "المنتج مكتمل صوراً بحسب التوجيه الحالي ولا يحتاج تدخلاً.",
};

const STORAGE_KEY = "studio.discovery.filters.v1";
export type PersistedFilters = {
  states: Health[];
  search: string;
  bundleOnly: boolean;
  sort: SortOption;
};
export const DEFAULT_FILTERS: PersistedFilters = {
  states: [
    "HIGH_VALUE_NO_IMAGE",
    "CONSIGNMENT_NO_IMAGE",
    "HAS_IMAGE_NO_BARCODE",
    "NO_IMAGES",
    "BUNDLE_NO_IMAGE",
  ],
  search: "",
  bundleOnly: false,
  sort: "MISSING_MOST",
};

export function loadPersistedFilters(): PersistedFilters {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<PersistedFilters>;
    const states = Array.isArray(parsed.states)
      ? parsed.states.filter(
          (s): s is Health =>
            typeof s === "string" && Object.hasOwn(STATE_LABEL, s),
        )
      : DEFAULT_FILTERS.states;
    const search =
      typeof parsed.search === "string" ? parsed.search.slice(0, 80) : "";
    const bundleOnly = parsed.bundleOnly === true;
    const sort =
      typeof parsed.sort === "string" && Object.hasOwn(SORT_LABEL, parsed.sort)
        ? (parsed.sort as SortOption)
        : DEFAULT_FILTERS.sort;
    return { states, search, bundleOnly, sort };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function persistFilters(filters: PersistedFilters): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {}
}
