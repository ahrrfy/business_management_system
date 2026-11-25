import { useEffect, useRef } from "react";
import { useRoute } from "wouter";
import { STOREFRONT_BANNER_NAVIGATE_EVENT } from "@/components/store/BannerFrame";

interface StorefrontUrlSyncOptions {
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
  selectedProductTitle?: string | null;
  categoryId: number | null;
  setCategoryId: (id: number | null) => void;
  onSelectPromoId?: (promoId: number | null) => void;
  onActivateDeals?: () => void;
  onSelectProductGroup?: (productIds: number[] | null) => void;
  onApplySearch?: (query: string) => void;
  onOpenCartPanel?: () => void;
  onScrollToResults?: () => void;
}

const DEFAULT_STORE_TITLE = "متجر المكتبة العربية | قرطاسية وطباعة وتوصيل في العراق";

export function parseStorefrontDestination(rawUrl: string): {
  productId?: number;
  categoryId?: number;
  promoId?: number;
  deals?: boolean;
  productIds?: number[];
  search?: string;
  quote?: boolean;
  canonicalHref: string;
} | null {
  try {
    const parsed = new URL(rawUrl, "https://alarabiya.online");
    if (parsed.origin !== "https://alarabiya.online") return null;
    const path = parsed.pathname;

    const prodMatch = path.match(/^\/store\/product\/(\d+)/);
    if (prodMatch) {
      const pid = Number(prodMatch[1]);
      if (Number.isInteger(pid) && pid > 0) {
        return { productId: pid, canonicalHref: `/store/product/${pid}` };
      }
    }

    const catMatch = path.match(/^\/store\/category\/(\d+)/);
    if (catMatch) {
      const cid = Number(catMatch[1]);
      if (Number.isInteger(cid) && cid > 0) {
        return { categoryId: cid, canonicalHref: `/store/category/${cid}` };
      }
    }

    const qPid = Number(parsed.searchParams.get("product"));
    if (Number.isInteger(qPid) && qPid > 0) {
      return { productId: qPid, canonicalHref: `/store/product/${qPid}` };
    }

    const qCid = Number(parsed.searchParams.get("category"));
    if (Number.isInteger(qCid) && qCid > 0) {
      return { categoryId: qCid, canonicalHref: `/store/category/${qCid}` };
    }

    const qPromo = Number(parsed.searchParams.get("promo"));
    if (Number.isInteger(qPromo) && qPromo > 0) {
      return { promoId: qPromo, canonicalHref: `/store?promo=${qPromo}` };
    }

    const productsRaw = parsed.searchParams.get("products");
    if (productsRaw) {
      const ids = productsRaw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 24);
      if (ids.length > 0) {
        return { productIds: ids, canonicalHref: `/store?products=${ids.join(",")}` };
      }
    }

    if (parsed.searchParams.get("quote") === "1") {
      return { quote: true, canonicalHref: "/store?quote=1" };
    }

    if (parsed.searchParams.get("deals") === "1") {
      return { deals: true, canonicalHref: "/store?deals=1" };
    }

    const qText = parsed.searchParams.get("q")?.trim();
    if (qText) {
      return { search: qText, canonicalHref: `/store?q=${encodeURIComponent(qText)}` };
    }

    if (path === "/store" || path === "/store/") {
      return { canonicalHref: "/store" };
    }
    return null;
  } catch {
    return null;
  }
}

export function useStorefrontUrlSync({
  selectedId,
  setSelectedId,
  selectedProductTitle,
  categoryId,
  setCategoryId,
  onSelectPromoId,
  onActivateDeals,
  onSelectProductGroup,
  onApplySearch,
  onOpenCartPanel,
  onScrollToResults,
}: StorefrontUrlSyncOptions) {
  const [matchProduct, productParams] = useRoute("/store/product/:productId");
  const [matchCategory, categoryParams] = useRoute("/store/category/:categoryId");
  const initialSyncDone = useRef(false);
  const callbacksRef = useRef({
    setSelectedId,
    setCategoryId,
    onSelectPromoId,
    onActivateDeals,
    onSelectProductGroup,
    onApplySearch,
    onOpenCartPanel,
    onScrollToResults,
  });
  callbacksRef.current = {
    setSelectedId,
    setCategoryId,
    onSelectPromoId,
    onActivateDeals,
    onSelectProductGroup,
    onApplySearch,
    onOpenCartPanel,
    onScrollToResults,
  };

  function applyDestination(dest: NonNullable<ReturnType<typeof parseStorefrontDestination>>, scroll: boolean) {
    const cb = callbacksRef.current;
    if (dest.productId) {
      cb.setSelectedId(dest.productId);
      return;
    }
    cb.setSelectedId(null);
    if (dest.categoryId) {
      cb.onSelectPromoId?.(null);
      cb.onSelectProductGroup?.(null);
      cb.setCategoryId(dest.categoryId);
      if (scroll) cb.onScrollToResults?.();
      return;
    }
    if (dest.promoId) {
      cb.setCategoryId(null);
      cb.onSelectProductGroup?.(null);
      cb.onSelectPromoId?.(dest.promoId);
      if (scroll) cb.onScrollToResults?.();
      return;
    }
    if (dest.productIds?.length) {
      cb.setCategoryId(null);
      cb.onSelectPromoId?.(null);
      cb.onSelectProductGroup?.(dest.productIds);
      if (scroll) cb.onScrollToResults?.();
      return;
    }
    if (dest.deals) {
      cb.setCategoryId(null);
      cb.onSelectPromoId?.(null);
      cb.onSelectProductGroup?.(null);
      cb.onActivateDeals?.();
      if (scroll) cb.onScrollToResults?.();
      return;
    }
    if (dest.search) {
      cb.onSelectPromoId?.(null);
      cb.onSelectProductGroup?.(null);
      cb.onApplySearch?.(dest.search);
      if (scroll) cb.onScrollToResults?.();
      return;
    }
    if (dest.quote) {
      cb.onOpenCartPanel?.();
      return;
    }
    cb.setCategoryId(null);
    cb.onSelectPromoId?.(null);
    cb.onSelectProductGroup?.(null);
  }

  // 1. مزامنة أولية عند تحميل الصفحة (المسارات الصريحة + جميع معاملات البنرات الترويجية)
  useEffect(() => {
    if (typeof window === "undefined" || initialSyncDone.current) return;
    initialSyncDone.current = true;

    if (matchProduct && productParams?.productId) {
      const pid = Number(productParams.productId);
      if (Number.isInteger(pid) && pid > 0) {
        setSelectedId(pid);
        return;
      }
    }
    if (matchCategory && categoryParams?.categoryId) {
      const cid = Number(categoryParams.categoryId);
      if (Number.isInteger(cid) && cid > 0) {
        setCategoryId(cid);
        return;
      }
    }

    const dest = parseStorefrontDestination(`${window.location.pathname}${window.location.search}`);
    if (dest && (dest.productId || dest.categoryId || dest.promoId || dest.deals || dest.productIds || dest.search || dest.quote)) {
      applyDestination(dest, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchProduct, productParams, matchCategory, categoryParams, setSelectedId, setCategoryId]);

  // 2. التنقل الفوري SPA عند النقر على أي بنر ترويجي دون إعادة تحميل الصفحة كاملة
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBannerNavigate = (ev: Event) => {
      const custom = ev as CustomEvent<{ url: string; handled: boolean }>;
      const dest = parseStorefrontDestination(custom.detail?.url ?? "");
      if (!dest) return;
      custom.detail.handled = true;
      if (`${window.location.pathname}${window.location.search}` !== dest.canonicalHref) {
        window.history.pushState(null, "", dest.canonicalHref);
      }
      applyDestination(dest, true);
    };
    window.addEventListener(STOREFRONT_BANNER_NAVIGATE_EVENT, onBannerNavigate);
    return () => window.removeEventListener(STOREFRONT_BANNER_NAVIGATE_EVENT, onBannerNavigate);
  }, []);

  // 3. مزامنة الـ URL وعنوان الصفحة عند تغيير المنتج المختار
  useEffect(() => {
    if (typeof window === "undefined" || !initialSyncDone.current) return;

    if (selectedId != null) {
      const targetPath = `/store/product/${selectedId}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({ productId: selectedId }, "", targetPath);
      }
      if (selectedProductTitle) {
        document.title = `${selectedProductTitle} | متجر المكتبة العربية`;
      }
    } else {
      if (window.location.pathname.startsWith("/store/product/")) {
        const fallbackPath = categoryId ? `/store/category/${categoryId}` : "/store";
        window.history.pushState(null, "", fallbackPath);
      }
      document.title = DEFAULT_STORE_TITLE;
    }
  }, [selectedId, selectedProductTitle, categoryId]);

  // 4. الاستجابة لأزرار الرجوع/التقدم في المتصفح (popstate)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePopState = () => {
      const dest = parseStorefrontDestination(`${window.location.pathname}${window.location.search}`);
      if (dest) {
        applyDestination(dest, false);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
}

/** نسخ ومشاركة رابط المنتج */
export function shareProductLink(productId: number, productName: string, price?: string | null): Promise<boolean> {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://alarabiya.online";
  const url = `${origin}/store/product/${productId}`;
  const shareText = `${productName}${price ? ` — ${price} د.ع` : ""} | المكتبة العربية\n${url}`;

  if (typeof navigator !== "undefined" && navigator.share) {
    return navigator
      .share({
        title: productName,
        text: shareText,
        url,
      })
      .then(() => true)
      .catch(() => false);
  }

  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard
      .writeText(url)
      .then(() => true)
      .catch(() => false);
  }

  return Promise.resolve(false);
}
