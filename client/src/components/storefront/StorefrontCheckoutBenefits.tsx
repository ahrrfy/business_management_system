import { money } from "@/components/storefront/storefrontCartMath";
import { formatQuantity } from "@/lib/money";
import { Package } from "lucide-react";
import type { StorefrontCheckoutPanelProps } from "./StorefrontCheckoutPanel";
type Props = Pick<
  StorefrontCheckoutPanelProps,
  | "couponDraft"
  | "setCouponDraft"
  | "applyCoupon"
  | "appliedCouponCode"
  | "removeCoupon"
  | "quoteFetching"
  | "quoteError"
  | "quoteErrorMessage"
  | "couponSuperseded"
  | "quoteData"
  | "quotedCouponDiscount"
  | "couponFeedback"
  | "setPanel"
>;
export function StorefrontCheckoutBenefits({
  couponDraft,
  setCouponDraft,
  applyCoupon,
  appliedCouponCode,
  removeCoupon,
  quoteFetching,
  quoteError,
  quoteErrorMessage,
  couponSuperseded,
  quoteData,
  quotedCouponDiscount,
  couponFeedback,
  setPanel,
}: Props) {
  return (
    <>
      {" "}
      <div className="rounded-2xl border border-slate-200/90 bg-[#f5f5f7] p-3 ring-1 ring-slate-900/[0.04] dark:border-slate-800 dark:bg-slate-900 dark:ring-slate-800">
        <label
          htmlFor="storefront-checkout-coupon"
          className="mb-1 block text-xs font-bold text-slate-600 dark:text-slate-300"
        >
          لديك كوبون؟
        </label>
        <div className="flex gap-2" dir="ltr">
          <input
            id="storefront-checkout-coupon"
            value={couponDraft}
            onChange={(e) => setCouponDraft(e.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyCoupon();
              }
            }}
            placeholder="مثال: WELCOME10"
            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold tracking-wide outline-none placeholder:font-normal placeholder:tracking-normal focus:border-[var(--store-brand)] dark:border-slate-700 dark:bg-slate-800"
            aria-describedby="storefront-coupon-feedback"
          />
          <button
            type="button"
            onClick={appliedCouponCode ? removeCoupon : applyCoupon}
            disabled={!appliedCouponCode && !couponDraft.trim()}
            className="shrink-0 rounded-xl bg-[#1d1d1f] px-3.5 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-[#1d1d1f]"
          >
            {appliedCouponCode ? "إزالة" : "تطبيق"}
          </button>
        </div>
        <p
          id="storefront-coupon-feedback"
          className={
            (quoteFetching && appliedCouponCode) ||
            (quoteError && appliedCouponCode) ||
            couponSuperseded ||
            (appliedCouponCode && quoteData) ||
            couponFeedback
              ? "mt-2 text-xs font-bold text-slate-600"
              : "sr-only"
          }
          role="status"
          aria-live="polite"
        >
          {quoteFetching && appliedCouponCode
            ? "جار التحقق من الكوبون..."
            : quoteError && appliedCouponCode
              ? (quoteErrorMessage ?? "تعذر التحقق من الكوبون")
              : couponSuperseded
                ? `لم يستخدم الكوبون؛ طبقت منفعة ${quoteData?.pricingBenefitLabel ?? "أفضل سعر متاح"} بدلا منه.`
                : appliedCouponCode && quoteData
                  ? `تم تطبيق ${quoteData.couponProgramName ?? "الكوبون"} — التوفير ${money(Number(quotedCouponDiscount) + Number(quoteData.couponDeliveryWaivedAmount ?? 0))} د.ع`
                  : (couponFeedback ?? "")}
        </p>
      </div>
      {quoteData?.wholesaleProgress.length ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-2xl border border-[var(--sem-info)]/25 bg-[var(--sem-info-bg)] p-3.5"
        >
          <div className="space-y-2">
            {quoteData.wholesaleProgress.map((progress) => (
              <div
                key={progress.productId}
                className="flex items-start gap-2.5"
              >
                <Package
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-[var(--sem-info)]"
                />
                <div className="min-w-0">
                  <p className="text-xs font-black leading-5 text-[var(--sem-info)]">
                    أضف {formatQuantity(progress.remainingBaseQuantity)} قطعة
                    إضافية للوصول إلى سعر الجملة
                  </p>
                  <p className="mt-0.5 text-[11px] font-bold leading-5 text-[var(--sem-info)]/75">
                    {progress.productName} —{" "}
                    {"تُحسب الألوان والوحدات لهذا المنتج معاً"}.
                  </p>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPanel("cart")}
            className="mt-3 text-xs font-black text-[var(--sem-info)] underline decoration-[var(--sem-info)]/30 underline-offset-4 hover:opacity-80"
          >
            تعديل السلة للوصول إلى سعر الجملة
          </button>
        </div>
      ) : null}
    </>
  );
}
