import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { StorefrontCheckoutField as Field } from "@/components/storefront/StorefrontCheckoutField";
import { StorefrontLocationPicker } from "@/components/storefront/StorefrontLocationPicker";
import { StorefrontPanelShell } from "@/components/storefront/StorefrontPanelShell";
import { TurnstileWidget } from "@/components/storefront/TurnstileWidget";
import { money } from "@/components/storefront/storefrontCartMath";
import { type Panel } from "@/components/storefront/storefrontCatalogModel";
import { type CheckoutForm } from "@/components/storefront/storefrontPersistence";
import { type RouterOutputs } from "@/lib/trpc";
import { GOVERNORATES } from "@shared/governorates";
import {
  Banknote,
  Check,
  Loader2,
  MessageCircle,
  Package,
  Phone,
  Store,
  Truck,
  User,
} from "lucide-react";
import React from "react";
import { StorefrontCheckoutBenefits } from "./StorefrontCheckoutBenefits";
export interface StorefrontCheckoutPanelProps {
  setTurnstileToken: React.Dispatch<React.SetStateAction<string | null>>;
  setCheckoutErrors: React.Dispatch<
    React.SetStateAction<
      Partial<Record<"address" | "name" | "phone" | "governorate", string>>
    >
  >;
  setPanel: React.Dispatch<React.SetStateAction<Panel>>;
  submitOrder: () => void;
  cartCount: number;
  checkoutErrors: Partial<
    Record<"address" | "name" | "phone" | "governorate", string>
  >;
  form: CheckoutForm;
  updateCheckoutField: <K extends keyof CheckoutForm>(
    field: K,
    value: CheckoutForm[K],
  ) => void;
  orderInFlightRef: React.RefObject<boolean>;
  couponDraft: string;
  setCouponDraft: React.Dispatch<React.SetStateAction<string>>;
  applyCoupon: () => void;
  appliedCouponCode: string | null;
  removeCoupon: () => void;
  quoteFetching: boolean;
  quoteError: boolean;
  quoteErrorMessage: string | undefined;
  couponSuperseded: boolean;
  quoteData: RouterOutputs["storefront"]["quoteOrder"] | undefined;
  quotedCouponDiscount: string;
  couponFeedback: string | null;
  quotedSubtotal: string;
  quotedDeliveryFree: boolean;
  quotedDeliveryFee: string;
  quotedTotal: string;
  orderingEnabled: boolean;
  settings: RouterOutputs["storefront"]["settings"] | undefined;
  turnstileResetKey: number;
  orderFailed: boolean;
  checkoutSafetyError: string | null;
  orderErrorMessage: string | undefined;
  orderPending: boolean;
}
export function StorefrontCheckoutPanel({
  setTurnstileToken,
  setCheckoutErrors,
  setPanel,
  submitOrder,
  cartCount,
  checkoutErrors,
  form,
  updateCheckoutField,
  orderInFlightRef,
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
  quotedSubtotal,
  quotedDeliveryFree,
  quotedDeliveryFee,
  quotedTotal,
  orderingEnabled,
  settings,
  turnstileResetKey,
  orderFailed,
  checkoutSafetyError,
  orderErrorMessage,
  orderPending,
}: StorefrontCheckoutPanelProps) {
  return (
    <StorefrontPanelShell
      title="إتمام الطلب"
      onClose={() => {
        setTurnstileToken(null);
        setCheckoutErrors({});
        setPanel("cart");
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submitOrder();
        }}
        className="flex flex-col gap-3"
      >
        <div className="rounded-2xl border border-[#f0d991] bg-[#fff8df] p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#9a7427]">
                الخطوة الأخيرة
              </p>
              <p className="mt-1 text-sm font-black text-[#25406f]">
                أكمل بياناتك وسنؤكد الطلب قبل التوصيل
              </p>
            </div>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#f4c84d] text-sm font-black text-[#25406f]">
              {cartCount}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[10px] font-black">
            <span className="rounded-lg bg-[#25406f] px-2 py-1.5 text-white">
              بياناتك
            </span>
            <span className="rounded-lg bg-white/80 px-2 py-1.5 text-[#6d5524]">
              التوصيل
            </span>
            <span className="rounded-lg bg-white/80 px-2 py-1.5 text-[#6d5524]">
              التأكيد
            </span>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            icon={<User aria-hidden className="size-4" />}
            label="الاسم الكامل"
            htmlFor="storefront-checkout-name"
            required
            error={checkoutErrors.name}
          >
            <input
              id="storefront-checkout-name"
              value={form.name}
              onChange={(e) => updateCheckoutField("name", e.target.value)}
              required
              aria-invalid={Boolean(checkoutErrors.name)}
              aria-describedby={
                checkoutErrors.name
                  ? "storefront-checkout-name-error"
                  : undefined
              }
              placeholder="اسمك"
              autoComplete="name"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[#6c747b]"
            />
          </Field>
          <Field
            icon={<Phone aria-hidden className="size-4" />}
            label="رقم الهاتف"
            htmlFor="storefront-checkout-phone"
            required
            error={checkoutErrors.phone}
          >
            <IntlPhoneInput
              id="storefront-checkout-phone"
              value={form.phone}
              onChange={(phone) => updateCheckoutField("phone", phone)}
              ariaLabel="رقم الهاتف"
              placeholder="770 123 4567"
              className="border-0 shadow-none"
            />
          </Field>
        </div>
        <Field
          icon={<Store aria-hidden className="size-4" />}
          label="المحافظة"
          htmlFor="storefront-checkout-governorate"
          required
          error={checkoutErrors.governorate}
        >
          <select
            id="storefront-checkout-governorate"
            value={form.governorate}
            onChange={(e) => updateCheckoutField("governorate", e.target.value)}
            required
            aria-invalid={Boolean(checkoutErrors.governorate)}
            aria-describedby={
              checkoutErrors.governorate
                ? "storefront-checkout-governorate-error"
                : undefined
            }
            className="w-full bg-transparent text-sm outline-none"
          >
            <option value="">اختر المحافظة</option>
            {GOVERNORATES.map((g) => (
              <option
                key={g.id}
                value={g.id}
                className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              >
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          icon={<Package aria-hidden className="size-4" />}
          label="العنوان بالتفصيل"
          htmlFor="storefront-checkout-address"
          required
          error={checkoutErrors.address}
          tone="mint"
        >
          <textarea
            id="storefront-checkout-address"
            value={form.address}
            onChange={(e) => updateCheckoutField("address", e.target.value)}
            required
            aria-invalid={Boolean(checkoutErrors.address)}
            aria-describedby={
              checkoutErrors.address
                ? "storefront-checkout-address-error"
                : undefined
            }
            rows={2}
            placeholder="المنطقة، الشارع، أقرب نقطة دالة…"
            className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-[#6c747b]"
          />
        </Field>

        {/* بطاقة تثبيت الموقع على الخريطة */}
        <StorefrontLocationPicker
          latitude={form.latitude ?? null}
          longitude={form.longitude ?? null}
          onChange={(coords) => {
            updateCheckoutField("latitude", coords.latitude);
            updateCheckoutField("longitude", coords.longitude);
          }}
          disabled={orderInFlightRef.current}
        />
        <Field
          icon={<MessageCircle aria-hidden className="size-4" />}
          label="ملاحظة (اختياري)"
          htmlFor="storefront-checkout-notes"
          tone="lilac"
        >
          <input
            id="storefront-checkout-notes"
            value={form.notes}
            onChange={(e) => updateCheckoutField("notes", e.target.value)}
            placeholder="مثال: الاتصال قبل التوصيل"
            className="w-full bg-transparent text-sm outline-none placeholder:text-[#6c747b]"
          />
        </Field>

        <StorefrontCheckoutBenefits
          couponDraft={couponDraft}
          setCouponDraft={setCouponDraft}
          applyCoupon={applyCoupon}
          appliedCouponCode={appliedCouponCode}
          removeCoupon={removeCoupon}
          quoteFetching={quoteFetching}
          quoteError={quoteError}
          quoteErrorMessage={quoteErrorMessage}
          couponSuperseded={couponSuperseded}
          quoteData={quoteData}
          quotedCouponDiscount={quotedCouponDiscount}
          couponFeedback={couponFeedback}
          setPanel={setPanel}
        />
        <div className="rounded-2xl border border-[#ead8c8] bg-[#fffdf9] p-3.5 text-sm ring-1 ring-[#f3e5da] dark:bg-slate-900 dark:ring-slate-800">
          <div className="flex justify-between text-slate-500">
            <span>المجموع الفرعي</span>
            <span className="tabular-nums text-slate-800 dark:text-slate-100">
              {money(quotedSubtotal)} د.ع
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-slate-500">
            <span className="flex items-center gap-1">
              <Truck aria-hidden className="size-3.5" /> أجرة التوصيل (تقديري)
            </span>
            {quotedDeliveryFree ? (
              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                مجاني
              </span>
            ) : (
              <span className="tabular-nums text-slate-800 dark:text-slate-100">
                {money(quotedDeliveryFee)} د.ع
              </span>
            )}
          </div>
          {Number(quotedCouponDiscount) > 0 && (
            <div className="mt-1.5 flex justify-between text-emerald-700 dark:text-emerald-400">
              <span>خصم الكوبون</span>
              <span className="tabular-nums">
                − {money(quotedCouponDiscount)} د.ع
              </span>
            </div>
          )}
          <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-base font-extrabold dark:border-slate-800">
            <span>الإجمالي</span>
            <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
              {money(quotedTotal)} د.ع
            </span>
          </div>
        </div>

        {orderingEnabled && settings?.turnstileSiteKey ? (
          <TurnstileWidget
            siteKey={settings.turnstileSiteKey}
            resetKey={turnstileResetKey}
            onTokenChange={setTurnstileToken}
          />
        ) : (
          <p
            role="alert"
            className="rounded-xl bg-[var(--sem-neg)]/5 px-3 py-2 text-xs font-medium text-[var(--sem-neg)]"
          >
            استقبال الطلبات متوقف مؤقتاً؛ يمكنك متابعة التصفح والتواصل عبر
            واتساب.
          </p>
        )}

        {/* نفس دور تنبيه «استقبال الطلبات متوقف» أعلاه — صارا على `--sem-neg` نفسه
                (كان الأوّل على مرادفه `--sem-danger` والثاني صبغةً خامّة). */}
        {(orderFailed || checkoutSafetyError) && (
          <p
            role="alert"
            className="rounded-xl bg-[var(--sem-neg)]/5 px-3 py-2 text-xs font-medium text-[var(--sem-neg)]"
          >
            {checkoutSafetyError ??
              orderErrorMessage ??
              "تعذّر إرسال الطلب — أعد المحاولة"}
          </p>
        )}

        <button
          type="submit"
          disabled={orderPending}
          className="store-primary-action store-mobile-action flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-sm shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
        >
          {orderPending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Check aria-hidden className="size-4" />
          )}
          تأكيد الطلب — الدفع عند الاستلام
        </button>
        <p className="flex items-center justify-center gap-1 text-center text-xs text-slate-600">
          <Banknote aria-hidden className="size-3.5" /> تدفع نقداً عند استلام
          الطلب من المندوب.
        </p>
      </form>
    </StorefrontPanelShell>
  );
}
