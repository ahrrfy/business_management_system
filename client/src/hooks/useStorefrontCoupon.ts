import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "storefront_applied_coupon";

interface UseStorefrontCouponOptions {
  onQuoteInvalidate?: () => void;
}

function cleanUrlCouponParams() {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("coupon") || url.searchParams.has("c")) {
      url.searchParams.delete("coupon");
      url.searchParams.delete("c");
      window.history.replaceState(window.history.state, "", url.toString());
    }
  } catch {}
}

const VALID_COUPON_CODE_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function useStorefrontCoupon(options?: UseStorefrontCouponOptions) {
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(null);
  const [couponFeedback, setCouponFeedback] = useState<string | null>(null);

  // استخراج الكوبون من الرابط واستعادته من الجلسة client-side عبر التنقلات
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const couponParam = params.get("coupon")?.trim() || params.get("c")?.trim();
    if (couponParam && VALID_COUPON_CODE_REGEX.test(couponParam)) {
      const norm = couponParam.toUpperCase();
      try {
        sessionStorage.setItem(STORAGE_KEY, norm);
      } catch {}
      setCouponDraft(norm);
      setAppliedCouponCode(norm);
      setCouponFeedback(`تم تفعيل كوبون الخصم (${norm}) تلقائياً من الرابط الترويجي`);
      cleanUrlCouponParams();
    } else {
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY)?.trim();
        if (saved && VALID_COUPON_CODE_REGEX.test(saved)) {
          const norm = saved.toUpperCase();
          setCouponDraft(norm);
          setAppliedCouponCode(norm);
        }
      } catch {}
    }
  }, []);

  const applyCoupon = useCallback(() => {
    const normalized = couponDraft.trim().toUpperCase().replace(/\s+/g, "");
    if (!normalized) {
      setCouponFeedback("اكتب رمز الكوبون أولاً");
      return;
    }
    try {
      sessionStorage.setItem(STORAGE_KEY, normalized);
    } catch {}
    setAppliedCouponCode(normalized);
    setCouponFeedback("جارٍ التحقق من الكوبون…");
    options?.onQuoteInvalidate?.();
  }, [couponDraft, options]);

  const removeCoupon = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
    cleanUrlCouponParams();
    setAppliedCouponCode(null);
    setCouponDraft("");
    setCouponFeedback(null);
    options?.onQuoteInvalidate?.();
  }, [options]);

  const clearCouponOnSuccess = useCallback(() => {
    setCouponDraft("");
    setAppliedCouponCode(null);
    setCouponFeedback(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
    cleanUrlCouponParams();
  }, []);

  return {
    couponDraft,
    setCouponDraft,
    appliedCouponCode,
    setAppliedCouponCode,
    couponFeedback,
    setCouponFeedback,
    applyCoupon,
    removeCoupon,
    clearCouponOnSuccess,
  };
}
