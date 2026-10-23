import { money } from "@/components/storefront/storefrontCartMath";
import { type Panel } from "@/components/storefront/storefrontCatalogModel";
import { StorefrontPanelShell } from "@/components/storefront/StorefrontPanelShell";
import { formatQuantity } from "@/lib/money";
import { type GuestTrackingOrder } from "@/lib/storefrontGuestTracking";
import { type RouterOutputs } from "@/lib/trpc";
import {
  orderStatusChipClass,
  orderStatusLabelForCustomer,
} from "@shared/onlineOrderStatus";
import { Loader2, MessageCircle, Search, Star } from "lucide-react";
import React from "react";
import { formatStorefrontReservationDeadline } from "./storefrontCatalogModel";
export interface StorefrontTrackingPanelProps {
  setPanel: React.Dispatch<React.SetStateAction<Panel>>;
  trustedTrackingOrders: GuestTrackingOrder[];
  doTrack: (savedToken?: string) => Promise<void>;
  trackState: "error" | "idle" | "loading" | "notfound";
  trackToken: string;
  setTrackToken: React.Dispatch<React.SetStateAction<string>>;
  setTrackError: React.Dispatch<React.SetStateAction<string | null>>;
  setTrackState: React.Dispatch<
    React.SetStateAction<"error" | "idle" | "loading" | "notfound">
  >;
  trackError: string | null;
  settings: RouterOutputs["storefront"]["settings"] | undefined;
  trackResult: RouterOutputs["storefront"]["trackOrderByToken"] | null;
  openProduct: (
    productId: number,
    options?: { openReview?: boolean; orderNumber?: string | null },
  ) => void;
}
export function StorefrontTrackingPanel({
  setPanel,
  trustedTrackingOrders,
  doTrack,
  trackState,
  trackToken,
  setTrackToken,
  setTrackError,
  setTrackState,
  trackError,
  settings,
  trackResult,
  openProduct,
}: StorefrontTrackingPanelProps) {
  return (
    <StorefrontPanelShell title="تتبّع طلبك" onClose={() => setPanel(null)}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          استخدم طلباً محفوظاً بأمان على هذا الجهاز، أو ألصق رمز التتبّع من
          تأكيد الطلب.
        </p>
        {trustedTrackingOrders.length > 0 && (
          <section
            aria-labelledby="storefront-trusted-orders-title"
            className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800"
          >
            <h3
              id="storefront-trusted-orders-title"
              className="text-sm font-extrabold text-slate-900 dark:text-white"
            >
              طلبات موثوقة على هذا الجهاز
            </h3>
            <div className="space-y-2">
              {trustedTrackingOrders.map((order) => (
                <button
                  key={order.trackingToken}
                  type="button"
                  onClick={() => {
                    void doTrack(order.trackingToken);
                  }}
                  disabled={trackState === "loading"}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 text-start transition hover:border-emerald-500 hover:bg-emerald-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-emerald-950/20"
                >
                  <span
                    dir="ltr"
                    className="font-extrabold text-slate-900 dark:text-white"
                  >
                    {order.orderNumber}
                  </span>
                  <span className="text-xs text-slate-600 dark:text-slate-300">
                    صالح حتى{" "}
                    {formatStorefrontReservationDeadline(order.expiresAt)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void doTrack();
          }}
          className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800"
        >
          <div className="space-y-1">
            <label
              htmlFor="storefront-track-token"
              className="text-xs font-bold text-slate-600 dark:text-slate-300"
            >
              رمز التتبّع{" "}
              <span aria-hidden="true" className="text-rose-700">
                *
              </span>
              <span className="sr-only"> — مطلوب</span>
            </label>
            <input
              id="storefront-track-token"
              dir="ltr"
              value={trackToken}
              onChange={(event) => {
                setTrackToken(event.target.value);
                setTrackError(null);
                setTrackState("idle");
              }}
              required
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(trackError)}
              aria-describedby={
                trackError
                  ? "storefront-track-token-error"
                  : "storefront-track-token-help"
              }
              placeholder="ألصق الرمز الكامل هنا"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
            {trackError ? (
              <p
                id="storefront-track-token-error"
                role="alert"
                className="text-xs font-bold text-[var(--sem-neg)]"
              >
                {trackError}
              </p>
            ) : (
              <p
                id="storefront-track-token-help"
                className="text-xs text-slate-600 dark:text-slate-300"
              >
                لا نطلب رقم الهاتف ولا نخزّن بياناتك الشخصية للتتبّع.
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={trackState === "loading"}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 py-3 text-sm font-extrabold text-white transition hover:bg-emerald-800 disabled:opacity-50"
          >
            {trackState === "loading" ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Search aria-hidden className="size-4" />
            )}
            تتبّع الطلب
          </button>
          {settings?.whatsappNumber && (
            <a
              href={`https://wa.me/${settings.whatsappNumber.replace(/[^\d]/g, "")}`}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 hover:border-emerald-500 hover:text-emerald-800 dark:border-slate-700 dark:text-slate-200"
            >
              <MessageCircle aria-hidden className="size-4" /> تواصل مع الدعم
              إذا فقدت الرمز
            </a>
          )}
        </form>

        {trackState === "notfound" && (
          <div
            role="alert"
            className="rounded-xl bg-[var(--sem-warn-bg)] p-4 text-center text-sm font-bold text-[var(--sem-warn)] ring-1 ring-[var(--sem-warn)]/40"
          >
            رمز التتبّع غير صالح أو انتهت صلاحيته. استخدم الرمز من تأكيد الطلب
            أو تواصل مع الدعم.
          </div>
        )}
        {trackState === "error" && (
          <div
            role="alert"
            className="rounded-xl bg-[var(--sem-neg-bg)] p-4 text-center text-sm font-bold text-[var(--sem-neg)] ring-1 ring-[var(--sem-neg)]/40"
          >
            تعذّر جلب الحالة الآن — حاول مرّةً أخرى.
          </div>
        )}

        {trackResult && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800"
          >
            <div className="flex items-center justify-between">
              <span
                className="font-extrabold tracking-wider text-slate-900 dark:text-white"
                dir="ltr"
              >
                {trackResult.orderNumber}
              </span>
              <span
                className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${orderStatusChipClass(trackResult.status)}`}
              >
                {trackResult.deliveryProgress?.label ??
                  orderStatusLabelForCustomer(trackResult.status)}
              </span>
            </div>
            {trackResult.deliveryHandshakeOtp && (
              <div className="flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-50/70 p-3 dark:border-amber-500/20 dark:bg-amber-950/30">
                <div>
                  <p className="text-xs font-black text-amber-900 dark:text-amber-200">
                    رمز تسليم الشحنة للمندوب (Handshake PIN)
                  </p>
                  <p className="text-[10px] font-bold text-amber-700/80 dark:text-amber-400">
                    سلّم هذا الرمز للمندوب يداً بيد عند استلام شحنتك
                  </p>
                </div>
                <span
                  className="font-mono text-base font-black tracking-widest text-amber-900 bg-white dark:bg-slate-900 dark:text-amber-200 border border-amber-300 dark:border-amber-700 px-3 py-1 rounded-lg shadow-xs"
                  dir="ltr"
                >
                  {trackResult.deliveryHandshakeOtp}
                </span>
              </div>
            )}
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {trackResult.items.map((it, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-2.5 text-sm gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-slate-700 dark:text-slate-200 block font-semibold">
                      {it.productName}{" "}
                      <span className="text-slate-400 font-normal">
                        ×{formatQuantity(it.quantity)}
                      </span>
                    </span>
                    {it.productId && (
                      <button
                        type="button"
                        onClick={() => {
                          openProduct(it.productId!, {
                            openReview: true,
                            orderNumber: trackResult.orderNumber,
                          });
                        }}
                        className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-amber-600 hover:text-amber-700 dark:text-amber-400 hover:underline"
                      >
                        <Star aria-hidden className="size-3 fill-current" />
                        <span>أضف تقييمك وتجربتك لهذا المنتج</span>
                      </button>
                    )}
                  </div>
                  <span
                    className="tabular-nums text-slate-500 shrink-0"
                    dir="ltr"
                  >
                    {money(it.total)} د.ع
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-2 text-sm dark:border-slate-800">
              <span className="text-slate-500">أجرة التوصيل</span>
              <span
                className={
                  trackResult.deliveryFree
                    ? "font-bold text-[var(--sem-pos)]"
                    : "tabular-nums text-slate-700 dark:text-slate-200"
                }
                dir="ltr"
              >
                {trackResult.deliveryFree
                  ? `مجاني${Number(trackResult.deliveryWaivedAmount ?? 0) > 0 ? ` (وفرت ${money(trackResult.deliveryWaivedAmount)} د.ع)` : ""}`
                  : `${money(trackResult.deliveryFee)} د.ع`}
              </span>
            </div>
            <div className="flex justify-between text-base font-extrabold">
              <span className="text-slate-900 dark:text-white">الإجمالي</span>
              <span
                className="tabular-nums text-emerald-600 dark:text-emerald-400"
                dir="ltr"
              >
                {money(trackResult.total)} د.ع
              </span>
            </div>
          </div>
        )}
      </div>
    </StorefrontPanelShell>
  );
}
