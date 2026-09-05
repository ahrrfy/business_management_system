import { useCallback, useEffect, useRef, useState } from "react";

import { mergeCatalogPage } from "@/lib/catalog-pagination";
import type {
  Product,
  StorefrontCustomizationTemplate,
  StorefrontUnitOption,
  StorefrontVariantOption,
} from "@/shared/storefront";

const API_BASE = "https://alarabiya.online/api/trpc";
const ASSET_BASE = "https://alarabiya.online";
const REQUEST_TIMEOUT_MS = 10_000;
const PUBLIC_QUERY_RETRIES = 1;
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();

type QueryOptions = {
  signal?: AbortSignal;
  retries?: number;
  cacheTtlMs?: number;
  bypassCache?: boolean;
};

export type StorefrontCategory = {
  id: number;
  name: string;
  productCount: number;
  availableCount: number;
};
export type StorefrontOffer = {
  id: number;
  name: string;
  type: "PERCENT" | "AMOUNT";
  discountPercent: string;
  discountAmount: string;
  scope: "ALL" | "CATEGORIES" | "PRODUCTS";
};
export type StorefrontBanner = {
  id: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  renderMode: "SMART_CROP" | "PRESERVE_FULL" | "LAYERED";
  focusX: number;
  focusY: number;
  ctaLabel: string | null;
  ctaUrl: string | null;
  placement: "HERO" | "SIDE" | "INLINE";
};
export type StorefrontSettings = {
  isOpen: boolean;
  fulfillmentBranchName: string | null;
  configurationReady: boolean;
  announcement: string | null;
  whatsappNumber: string | null;
  freeShippingThreshold: string | null;
  orderingEnabled: boolean;
};
export type OnlineOrderTracking = {
  orderNumber: string;
  status: string;
  subtotal: string;
  deliveryFee: string;
  deliveryFree?: boolean;
  deliveryWaivedAmount?: string;
  total: string;
  governorate: string | null;
  createdAt: string;
  items: Array<{
    productName: string;
    unitName: string;
    quantity: string;
    unitPrice: string;
    total: string;
  }>;
};
export type StorefrontOrderLine = {
  productUnitId: number;
  quantity: number;
  expectedUnitPrice?: string;
};
export type StorefrontOrderQuote = {
  couponCode: string | null;
  couponProgramName: string | null;
  couponDiscount: string;
  lines: Array<{
    productUnitId: number;
    quantity: number;
    retailUnitPrice: string;
    discountPerUnit: string;
    couponDiscountPerUnit: string;
    unitPrice: string;
    lineTotal: string;
  }>;
  subtotal: string;
  deliveryFee: string;
  total: string;
  deliveryFree?: boolean;
  deliveryWaivedAmount?: string;
};
export type StorefrontOrderResult = {
  orderId: number;
  orderNumber: string;
  reservationExpiresAt: string;
  branchId: number;
  subtotal: string;
  deliveryFee: string;
  total: string;
  itemCount: number;
  deliveryFree?: boolean;
  deliveryWaivedAmount?: string;
  guestTrackingToken: string | null;
  guestTrackingExpiresAt: string | null;
  idempotentReplay?: boolean;
};
export type StorefrontPushDeviceInput = {
  expoPushToken: string;
  marketingOptIn: boolean;
  transactionalOptIn: boolean;
  platform: "IOS" | "ANDROID";
  appVersion: string;
  customerSessionToken?: string;
};
export type StorefrontCustomerSession = {
  token: string;
  expiresInSeconds: number;
  customer: { id: number; name: string; phone: string };
};
export type StorefrontCustomerBenefits = {
  customer: { id: number; name: string; phone: string };
  loyalty: null | {
    programName: string;
    pointsBalance: string;
    pointsPerIqd: string;
    iqdDiscountPerPoint: string;
    minRedeemPoints: number;
    maxRedeemPercent: number;
    ledger: Array<{
      entryType: string;
      pointsDelta: string;
      balanceAfter: string;
      note: string | null;
      createdAt: string;
    }>;
  };
  coupons: Array<{
    id: number;
    code: string;
    name: string;
    validTo: string | null;
  }>;
};
export type StorefrontProductReviews = {
  summary: { count: number; average: number };
  items: Array<{
    id: number;
    rating: number;
    comment: string;
    createdAt: string;
  }>;
};
export type StorefrontWishlistShare = {
  token: string;
  expiresAt: string;
  productCount: number;
};
export type StorefrontSharedWishlist = {
  expiresAt: string;
  items: ApiProduct[];
};
export type CreateStorefrontOrderInput = {
  couponCode?: string;
  customerName: string;
  customerPhone: string;
  governorate: string;
  addressText: string;
  notes?: string;
  lines: StorefrontOrderLine[];
  expectedGrandTotal: string;
  clientRequestId: string;
  turnstileToken: string;
  customerSessionToken?: string;
};

export type ApiProduct = {
  productId: number;
  productUnitId: number;
  variantId: number;
  productName: string;
  description?: string | null;
  category: string | null;
  categoryId: number | null;
  unitName: string;
  price: string | null;
  salePrice: string | null;
  inStock: boolean;
  imageUrl: string | null;
  imageUrls?: string[];
  brand?: string | null;
  promotionName?: string | null;
  soldCount?: number;
  stockLeft?: number | null;
  isBundle?: boolean;
  bundleImageUrls?: string[];
  bundleItems?: { name: string; quantity: number }[];
  isCustomizable: boolean;
  customizationKind: "PRINT" | "GIFT" | null;
  customizationTemplate: StorefrontCustomizationTemplate | null;
  colors?: { name: string; hex: string; inStock: boolean }[];
  storeUnits?: StorefrontUnitOption[];
  variants?: StorefrontVariantOption[];
  hasAlternatives: boolean;
};

export type CatalogResponse = {
  items: ApiProduct[];
  hasMore: boolean;
  nextCursor: number | null;
};

function iconForCategory(category: string | null): Product["icon"] {
  const text = (category ?? "").toLowerCase();
  if (text.includes("قرطاسية")) return "edit-note";
  if (text.includes("ملازم") || text.includes("كتب")) return "auto-stories";
  if (text.includes("هدايا")) return "card-giftcard";
  return "menu-book";
}

function accentForCategory(category: string | null): string {
  const text = (category ?? "").toLowerCase();
  if (text.includes("قرطاسية")) return "#E5EEF1";
  if (text.includes("هدايا")) return "#EEE3F2";
  if (text.includes("ملازم") || text.includes("كتب")) return "#E8F0D8";
  return "#F6E8CE";
}

function imageUrl(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith("/") ? `${ASSET_BASE}${value}` : value;
}

function mapUnit(unit: StorefrontUnitOption): StorefrontUnitOption {
  return { ...unit };
}

function mapVariant(variant: StorefrontVariantOption): StorefrontVariantOption {
  return {
    ...variant,
    imageUrl: imageUrl(variant.imageUrl),
    imageUrls: variant.imageUrls.map((value) => imageUrl(value)!).filter(Boolean),
    units: variant.units.map(mapUnit),
  };
}

export function mapApiProduct(item: ApiProduct): Product {
  return {
    id: String(item.productId),
    productId: item.productId,
    productUnitId: item.productUnitId,
    variantId: item.variantId,
    title: item.productName,
    subtitle: `${item.category ?? "منتجات المكتبة"} • ${item.unitName}`,
    categoryId: String(item.categoryId ?? "other"),
    description:
      item.description?.trim() ||
      "تفاصيل المنتج والسعر الحاليان واردان مباشرةً من كتالوج مكتبة العربية.",
    icon: iconForCategory(item.category),
    accent: accentForCategory(item.category),
    availability: item.inStock ? "متوفر" : "متوفر قريباً",
    price: item.price,
    salePrice: item.salePrice,
    imageUrl: imageUrl(item.imageUrl),
    imageUrls: (item.imageUrls ?? (item.imageUrl ? [item.imageUrl] : []))
      .map((value) => imageUrl(value)!)
      .filter(Boolean),
    brand: item.brand ?? null,
    promotionName: item.promotionName ?? null,
    soldCount: Number(item.soldCount ?? 0),
    stockLeft: item.stockLeft ?? null,
    isBundle: item.isBundle ?? false,
    bundleImageUrls: (item.bundleImageUrls ?? [])
      .map((value) => imageUrl(value)!)
      .filter(Boolean),
    bundleItems: item.bundleItems ?? [],
    inStock: item.inStock,
    isCustomizable: item.isCustomizable,
    customizationKind: item.customizationKind,
    customizationTemplate: item.customizationTemplate,
    colors: item.colors ?? [],
    storeUnits: (item.storeUnits ?? []).map(mapUnit),
    variants: (item.variants ?? []).map(mapVariant),
    hasAlternatives: item.hasAlternatives,
  };
}

export type CatalogDisplayState = "LOADING" | "ERROR" | "READY" | "EMPTY";

/** لا تعلن الواجهة فراغ الكتالوج قبل اكتمال طلبه بنجاح. */
export function catalogDisplayState(
  products: readonly Product[],
  loading: boolean,
  error: string | null,
): CatalogDisplayState {
  if (loading) return "LOADING";
  if (error) return "ERROR";
  return products.length > 0 ? "READY" : "EMPTY";
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// نميّز مصدر الفشل حتى تعرض الواجهة رسالةً قابلة للفهم بدل نصٍّ تقنيٍّ مبهم.
// TypeError("Network request failed") = انقطاع اتصال · AbortError = مهلة/إلغاء يدويّ · HTTP status = رفض خادميّ.
export function classifyNetworkError(error: unknown): {
  kind: "OFFLINE" | "TIMEOUT" | "SERVER" | "CLIENT" | "UNKNOWN";
  message: string;
} {
  if (error instanceof Error) {
    if (error.name === "AbortError")
      return {
        kind: "TIMEOUT",
        message:
          "استغرقت العملية وقتاً أطول من المتوقّع. تحقّق من الاتصال ثم حاول مرة أخرى.",
      };
    // React Native fetch يرمي TypeError("Network request failed") عند غياب الاتصال بالكامل.
    if (
      error.name === "TypeError" &&
      /network request failed|failed to fetch/i.test(error.message)
    ) {
      return {
        kind: "OFFLINE",
        message: "لا يوجد اتصال بالإنترنت. تأكّد من الشبكة ثم حاول مرة أخرى.",
      };
    }
    // الرسائل التي أنشأها storefrontQuery نفسها تحمل رمز الحالة بين قوسَين.
    const httpMatch = /\((\d{3})\)/.exec(error.message);
    if (httpMatch) {
      const status = Number(httpMatch[1]);
      if (status >= 500)
        return {
          kind: "SERVER",
          message: "المتجر يواجه ضغطاً حالياً. حاول بعد دقيقة.",
        };
      if (status === 429)
        return {
          kind: "SERVER",
          message: "طلباتٌ كثيرة في وقتٍ قصير. انتظر قليلاً ثم أعِد المحاولة.",
        };
      if (status === 401 || status === 403)
        return {
          kind: "CLIENT",
          message: "الجلسة انتهت. أعِد التحقّق من هاتفك ثم حاول مرة أخرى.",
        };
      if (status === 400 || status === 422)
        return { kind: "CLIENT", message: error.message };
    }
    return { kind: "UNKNOWN", message: error.message };
  }
  return { kind: "UNKNOWN", message: "حدث خطأٌ غير متوقّع." };
}

function shouldRetry(error: unknown) {
  return error instanceof Error && error.name !== "AbortError";
}

async function storefrontQuery<T>(
  procedure: string,
  input: unknown,
  options: QueryOptions = {},
): Promise<T> {
  const cacheKey = `${procedure}:${JSON.stringify(input)}`;
  const cached = responseCache.get(cacheKey);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) return cached.value as T;

  const retries = options.retries ?? PUBLIC_QUERY_RETRIES;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const abortExternal = () => controller.abort();
    options.signal?.addEventListener("abort", abortExternal, { once: true });
    try {
      const encoded = encodeURIComponent(JSON.stringify({ json: input }));
      const response = await fetch(
        `${API_BASE}/${procedure}?input=${encoded}`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      if (!response.ok) {
        const error = new Error(`فشل الاتصال بالمتجر (${response.status})`);
        if (
          response.status !== 408 &&
          response.status !== 429 &&
          response.status < 500
        )
          throw error;
        lastError = error;
      } else {
        const payload = (await response.json()) as {
          result?: { data?: { json?: T } };
        };
        const value = payload.result?.data?.json;
        if (value === undefined) throw new Error("استجابة كتالوج غير صالحة");
        if (options.cacheTtlMs && options.cacheTtlMs > 0)
          responseCache.set(cacheKey, {
            value,
            expiresAt: Date.now() + options.cacheTtlMs,
          });
        return value;
      }
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortExternal);
    }
    if (attempt < retries) await delay(280 * (attempt + 1));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("تعذر الاتصال بالمتجر");
}

async function storefrontMutation<T>(
  procedure: string,
  input: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/${procedure}`, {
      method: "POST",
      headers: storefrontMutationHeaders(),
      body: JSON.stringify({ json: input }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`تعذر إرسال الطلب (${response.status})`);
    const payload = (await response.json()) as {
      result?: { data?: { json?: T } };
    };
    const value = payload.result?.data?.json;
    if (value === undefined) throw new Error("استجابة الطلب غير صالحة");
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

/** برهان تعريف ضيق للتطبيق الأصلي؛ يعبر حارس CSRF من دون إضعاف طلبات الويب العامة. */
export function storefrontMutationHeaders(
  platform: string = "android",
): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(platform === "web"
      ? { "x-erp-csrf": "1" }
      : { "x-alrueya-client": "android-native" }),
  };
}

export function useStorefrontCatalog(
  categoryId?: number,
  search?: string,
  options: { enabled?: boolean; limit?: number } = {},
) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const enabled = options.enabled ?? true;
  const limit = options.limit ?? 16;
  const requestKey = `${categoryId ?? "all"}:${search?.trim() ?? ""}:${refreshIndex}`;
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;
  useEffect(() => {
    if (!enabled) {
      setProducts([]);
      setLoading(false);
      setError(null);
      setHasMore(false);
      setNextCursor(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    setError(null);
    setProducts([]);
    setHasMore(false);
    setNextCursor(null);
    storefrontQuery<CatalogResponse>(
      "storefront.catalog",
      {
        limit,
        availability: "IN_STOCK",
        categoryId: categoryId ?? undefined,
        search: search?.trim() || undefined,
      },
      { signal: controller.signal, cacheTtlMs: 30_000, bypassCache: refreshIndex > 0 },
    )
      .then((data) => {
        if (!active) return;
        const page = mergeCatalogPage([], {
          ...data,
          items: data.items.map(mapApiProduct),
        });
        setProducts(page.products);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      })
      .catch((reason) => {
        if (active)
          setError(classifyNetworkError(reason).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [categoryId, enabled, limit, refreshIndex, search]);
  const loadMore = useCallback(() => {
    if (!enabled || loading || loadingMoreRef.current || !hasMore || nextCursor == null) return;
    loadingMoreRef.current = true;
    const pageRequestKey = requestKey;
    setLoadingMore(true);
    setError(null);
    void storefrontQuery<CatalogResponse>(
      "storefront.catalog",
      {
        limit,
        cursor: nextCursor,
        availability: "IN_STOCK",
        categoryId: categoryId ?? undefined,
        search: search?.trim() || undefined,
      },
      { cacheTtlMs: 30_000 },
    )
      .then((data) => {
        if (requestKeyRef.current !== pageRequestKey) return;
        const page = mergeCatalogPage(products, {
          ...data,
          items: data.items.map(mapApiProduct),
        });
        setProducts(page.products);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      })
      .catch((reason) => {
        if (requestKeyRef.current !== pageRequestKey) return;
        setError(classifyNetworkError(reason).message);
      })
      .finally(() => {
        if (requestKeyRef.current !== pageRequestKey) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [categoryId, enabled, hasMore, limit, loading, nextCursor, products, requestKey, search]);
  return {
    products,
    loading,
    error,
    hasMore,
    loadingMore,
    loadMore,
    refresh: () => setRefreshIndex((current) => current + 1),
  };
}

export function useStorefrontProduct(productId?: number) {
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(Boolean(productId));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!productId) {
      setLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    storefrontQuery<ApiProduct | null>(
      "storefront.product",
      { productId },
      { signal: controller.signal, cacheTtlMs: 60_000 },
    )
      .then((data) => {
        if (active) setProduct(data ? mapApiProduct(data) : null);
      })
      .catch((reason) => {
        if (active)
          setError(classifyNetworkError(reason).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [productId]);
  return { product, loading, error };
}

export function useStorefrontCategories() {
  const [categories, setCategories] = useState<StorefrontCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setError(null);
    storefrontQuery<StorefrontCategory[]>("storefront.categories", null, {
      signal: controller.signal,
      cacheTtlMs: 300_000,
    })
      .then((data) => {
        if (active) setCategories(data);
      })
      .catch((reason) => {
        if (active)
          setError(classifyNetworkError(reason).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  return { categories, loading, error };
}

export function useStorefrontMarketing(enabled = true) {
  const [banners, setBanners] = useState<StorefrontBanner[]>([]);
  const [offers, setOffers] = useState<StorefrontOffer[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    Promise.all([
      storefrontQuery<StorefrontBanner[]>("storefront.banners", null, {
        signal: controller.signal,
        cacheTtlMs: 60_000,
      }),
      storefrontQuery<StorefrontOffer[]>("storefront.offers", null, {
        signal: controller.signal,
        cacheTtlMs: 30_000,
      }),
    ])
      .then(([nextBanners, nextOffers]) => {
        if (!active) return;
        setBanners(nextBanners);
        setOffers(nextOffers);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled]);
  return { banners, offers, loading };
}

export function useStorefrontSettings() {
  const [settings, setSettings] = useState<StorefrontSettings | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    storefrontQuery<StorefrontSettings>("storefront.settings", null, {
      signal: controller.signal,
      cacheTtlMs: 30_000,
    })
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  return settings;
}

export type SecureTrackingInput = {
  orderNumber: string;
  customerSessionToken?: string | null;
  guestTrackingToken?: string | null;
};

export function secureTrackingRequest(input: SecureTrackingInput) {
  const orderNumber = input.orderNumber.trim().toUpperCase();
  if (input.guestTrackingToken) {
    return {
      procedure: "storefront.trackOrderByToken" as const,
      input: { trackingToken: input.guestTrackingToken },
    };
  }
  if (input.customerSessionToken) {
    return {
      procedure: "storefront.trackOrderPrivate" as const,
      input: { customerSessionToken: input.customerSessionToken, orderNumber },
    };
  }
  throw new Error("لا توجد صلاحية محفوظة لتتبع هذا الطلب. تحقق من هاتفك أو استخدم الجهاز الذي أُنشئ منه الطلب.");
}

export function trackStorefrontOrder(input: SecureTrackingInput) {
  const request = secureTrackingRequest(input);
  return storefrontMutation<OnlineOrderTracking | null>(request.procedure, request.input);
}

export function quoteStorefrontOrder(
  governorate: string,
  lines: Array<{ productUnitId: number; quantity: number }>,
  couponCode?: string,
  customerSessionToken?: string,
) {
  const normalizedCoupon = couponCode?.trim();
  if (normalizedCoupon) {
    return storefrontMutation<StorefrontOrderQuote>(
      "storefront.quoteOrderPrivate",
      {
        governorate,
        lines,
        couponCode: normalizedCoupon,
        customerSessionToken: customerSessionToken || undefined,
      },
    );
  }
  return storefrontQuery<StorefrontOrderQuote>(
    "storefront.quoteOrder",
    { governorate, lines },
    { retries: 0 },
  );
}

export function createStorefrontOrder(input: CreateStorefrontOrderInput) {
  // الكتابة لا يعاد إرسالها تلقائياً؛ معرف المحاولة يضمن الاسترداد الآمن إن انقطعت الاستجابة.
  return storefrontMutation<StorefrontOrderResult>(
    "storefront.createOrder",
    input,
  );
}

/** يسجّل رمز Expo Push؛ جلسة الهاتف الاختيارية تُحل إلى هوية العميل على الخادم ولا تُرسل customerId خاماً. */
export function registerStorefrontPushDevice(input: StorefrontPushDeviceInput) {
  return storefrontMutation<{ ok: true; deviceId: number }>(
    "storefront.registerPushDevice",
    input,
  );
}

export function trackStorefrontPushInteraction(
  deliveryId: number,
  event: "OPEN" | "CLICK",
) {
  return storefrontMutation<{ ok: true }>("storefront.trackPushInteraction", {
    deliveryId,
    event,
  });
}

export function claimStorefrontFirebaseCustomer(input: {
  firebaseIdToken: string;
  displayName: string;
}) {
  return storefrontMutation<StorefrontCustomerSession>(
    "storefront.claimFirebaseCustomer",
    input,
  );
}

/**
 * رصيد الولاء والقسائم. **mutation لا query** ⇒ التوكن ينتقل في body POST بدل ?input=،
 * فلا يظهر في nginx access.log على VPS المشترك (راجع docs/erp-followups.md § ت-٣).
 * نداءٌ خالٍ من التأثير الجانبيّ رغم كونه mutation دلالياً.
 *
 * ملاحظة توافقٍ خلفيّ: الخادم يُبقي `storefront.customerBenefits` (query) كما كان لصالح
 * البُنى المنشورة سابقاً. البناءُ الجديد يستدعي `customerBenefitsPrivate` مباشرةً ⇒ التوكن
 * لا يمرّ في URL على أيّ عميلٍ حديث. راجع مراجعة Codex P2 (نافذة التوافق).
 */
export function getStorefrontCustomerBenefits(customerSessionToken: string) {
  return storefrontMutation<StorefrontCustomerBenefits>(
    "storefront.customerBenefitsPrivate",
    { customerSessionToken },
  );
}

export function getStorefrontProductReviews(productId: number) {
  return storefrontQuery<StorefrontProductReviews>(
    "storefront.productReviews",
    { productId },
    { retries: 1, cacheTtlMs: 30_000 },
  );
}

export function submitStorefrontProductReview(input: {
  customerSessionToken: string;
  productId: number;
  rating: number;
  comment: string;
}) {
  return storefrontMutation<{ ok: true; status: "PENDING" }>(
    "storefront.submitProductReview",
    input,
  );
}

/**
 * حذف حساب العميل نهائيّاً بعد تأكيد OTP جديد. مطلوبٌ لسياسة Google Play (٢٠٢٤+).
 * يستدعي `storefront.deleteMe` على ERP الذي:
 *   - يفكّ Firebase ID token الجديد (يضمن التحقّق الحيّ لا اعتماد جلسةٍ قديمة)
 *   - يبمّم بيانات العميل (phone → hash، name → «عميلٌ محذوف»، address → NULL)
 *   - يزيد session_version لإبطال كلّ الجلسات القائمة
 *   - يحفظ الطلبات نفسها لأغراض المحاسبة (٥ سنوات) لكن يفكّ ربطها بالهويّة
 *
 * ⚠️ الطرف الخادميّ غير مبنيّ بعدُ — يُنجَز في جلسة `pnpm session:new erp-mobile-followups`
 * (راجع docs/erp-followups.md). حتى يُنجَز، هذا الاستدعاء سيُرجع 404 والواجهة تعرض
 * الرسالة الوسيطة أدناه بلا crash.
 */
export async function deleteMyStorefrontAccount(input: {
  firebaseIdToken: string;
}) {
  try {
    return await storefrontMutation<{ ok: true; deletedAt: string }>(
      "storefront.deleteMe",
      input,
    );
  } catch (error) {
    const classified = classifyNetworkError(error);
    if (
      classified.message.includes("(404)") ||
      classified.message.includes("(501)")
    ) {
      throw new Error(
        "مسار حذف الحساب قيد التجهيز. تواصل مع دعم المكتبة لطلب الحذف بريدياً حتى يُتاح الزرّ خلال أيّامٍ قليلة.",
      );
    }
    throw error;
  }
}

/** ينشئ مرجعاً عاماً عابراً للمنتجات فقط، من دون هوية صاحب القائمة أو أسعاره المتغيرة. */
export function createStorefrontWishlistShare(productIds: number[]) {
  return storefrontMutation<StorefrontWishlistShare>(
    "storefront.createWishlistShare",
    { productIds },
  );
}

/** يجلب عناصر القائمة المشتركة من الكتالوج الحي؛ السعر والتوفر لا يخرجان من نسخة مخزنة في الرابط. */
export async function getStorefrontWishlistShare(token: string) {
  const result = await storefrontQuery<StorefrontSharedWishlist>(
    "storefront.getWishlistShare",
    { token },
    { retries: 1, cacheTtlMs: 10_000 },
  );
  return { ...result, products: result.items.map(mapApiProduct) };
}

/** رابط HTTPS عام: يفتح التطبيق عبر Android App Link أو صفحة الويب الاحتياطية عند غيابه. */
export function storefrontWishlistShareUrl(token: string) {
  return `https://alarabiya.online/s/w/${encodeURIComponent(token)}`;
}

export function formatIqd(value: string | number | null | undefined) {
  if (!value) return "اسأل عن السعر";
  const number = Number(value);
  return Number.isFinite(number)
    ? `${new Intl.NumberFormat("en-US").format(number)} د.ع`
    : "اسأل عن السعر";
}

export function formatLatinNumber(value: number | string) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en-US").format(number)
    : String(value);
}

export function productDiscountPercent(product: Product) {
  const original = Number(product.price);
  const rawSalePrice = product.salePrice;
  if (typeof rawSalePrice !== "string" || !rawSalePrice.trim()) return null;
  const current = Number(rawSalePrice);
  if (
    !Number.isFinite(original) ||
    !Number.isFinite(current) ||
    original <= 0 ||
    current <= 0 ||
    current >= original
  )
    return null;
  const percent = Math.round(((original - current) / original) * 100);
  return percent > 0 && percent < 100 ? percent : null;
}

/** لا يعرض سعر العرض إلا عندما يمرّ حارس الخصم الحقيقي. */
export function storefrontDisplayPrice(product: Product) {
  return productDiscountPercent(product) != null
    ? product.salePrice
    : product.price;
}
