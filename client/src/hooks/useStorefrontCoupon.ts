import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "storefront_applied_coupon";

interface UseStorefrontCouponOptions {
  onQuoteInvalidate?: () => void;
}

export function useStorefrontCoupon(options?: UseStorefrontCouponOptions) {
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(null);
  const [couponFeedback, setCouponFeedback] = useState<string | null>(null);

  // استخراج الكوبون من الرابط واستعادته من الجلسة client-side عبر التنقلات
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const couponParam = params.get("coupon")?.trim() || params.get("c")?.trim();
    if (couponParam && /^[A-Za-z0-9_-]{3,32}$/.test(couponParam)) {
      const norm = couponParam.toUpperCase();
      try {
        sessionStorage.setItem(STORAGE_KEY, norm);
      } catch {}
      setCouponDraft(norm);
      setAppliedCouponCode(norm);
      setCouponFeedback(`تم تفعيل كوبون الخصم (${norm}) تلقائياً من الرابط الترويجي`);
    } else {
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY)?.trim();
        if (saved && /^[A-Za-z0-9_-]{3,32}$/.test(saved)) {
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
