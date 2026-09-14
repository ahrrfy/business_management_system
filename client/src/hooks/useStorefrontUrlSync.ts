import { useEffect, useRef } from "react";
import { useRoute } from "wouter";

interface StorefrontUrlSyncOptions {
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
  selectedProductTitle?: string | null;
  categoryId: number | null;
  setCategoryId: (id: number | null) => void;
}

const DEFAULT_STORE_TITLE = "المكتبة العربية | قرطاسية وطباعة وتوصيل في العراق";

export function useStorefrontUrlSync({
  selectedId,
  setSelectedId,
  selectedProductTitle,
  categoryId,
  setCategoryId,
}: StorefrontUrlSyncOptions) {
  const [matchProduct, productParams] = useRoute("/store/product/:productId");
  const [matchCategory, categoryParams] = useRoute("/store/category/:categoryId");
  const initialSyncDone = useRef(false);

  // 1. مزامنة أولية عند تحميل الصفحة
  useEffect(() => {
    if (typeof window === "undefined" || initialSyncDone.current) return;
    initialSyncDone.current = true;

    // مسار منتج صريح: /store/product/:productId
    if (matchProduct && productParams?.productId) {
      const pid = Number(productParams.productId);
      if (Number.isInteger(pid) && pid > 0) {
        setSelectedId(pid);
        return;
      }
    }

    // مسار تصنيف صريح: /store/category/:categoryId
    if (matchCategory && categoryParams?.categoryId) {
      const cid = Number(categoryParams.categoryId);
      if (Number.isInteger(cid) && cid > 0) {
        setCategoryId(cid);
        return;
      }
    }

    // معلمة استعلام: ?product=123
    const searchParams = new URLSearchParams(window.location.search);
    const queryPid = Number(searchParams.get("product"));
    if (Number.isInteger(queryPid) && queryPid > 0) {
      setSelectedId(queryPid);
    }
  }, [matchProduct, productParams, matchCategory, categoryParams, setSelectedId, setCategoryId]);

  // 2. مزامنة الـ URL وعنوان الصفحة عند تغيير المنتج المختار
  useEffect(() => {
    if (typeof window === "undefined" || !initialSyncDone.current) return;

    if (selectedId != null) {
      const targetPath = `/store/product/${selectedId}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({ productId: selectedId }, "", targetPath);
      }
      if (selectedProductTitle) {
        document.title = `${selectedProductTitle} | المكتبة العربية`;
      }
    } else {
      if (window.location.pathname.startsWith("/store/product/")) {
        const fallbackPath = categoryId ? `/store/category/${categoryId}` : "/store";
        window.history.pushState(null, "", fallbackPath);
      }
      document.title = DEFAULT_STORE_TITLE;
    }
  }, [selectedId, selectedProductTitle, categoryId]);

  // 3. الاستجابة لأزرار الرجوع/التقدم في المتصفح (popstate)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePopState = () => {
      const path = window.location.pathname;
      const productMatch = path.match(/^\/store\/product\/(\d+)/);
      if (productMatch) {
        const pid = Number(productMatch[1]);
        if (Number.isInteger(pid) && pid > 0) {
          setSelectedId(pid);
          return;
        }
      }

      const catMatch = path.match(/^\/store\/category\/(\d+)/);
      if (catMatch) {
        const cid = Number(catMatch[1]);
        if (Number.isInteger(cid) && cid > 0) {
          setCategoryId(cid);
        }
      }

      // إذا رجع الزائر إلى /store يغلق حوار المنتج
      if (path === "/store" || path === "/store/") {
        setSelectedId(null);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setSelectedId, setCategoryId]);
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
