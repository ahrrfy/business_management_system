import { StorefrontB2BQuoteButton } from "@/components/storefront/StorefrontB2BQuoteButton";
import {
  type CartLine,
  money,
} from "@/components/storefront/storefrontCartMath";
import { type Panel } from "@/components/storefront/storefrontCatalogModel";
import {
  CuratedRow,
  type RowProduct,
} from "@/components/storefront/StorefrontCuratedRows";
import { summarizeStorefrontCustomization } from "@/components/storefront/storefrontCustomizationModel";
import { ProductImage } from "@/components/storefront/StorefrontMedia";
import { StorefrontPanelShell } from "@/components/storefront/StorefrontPanelShell";
import { storefrontProductCanBeOrdered } from "@/components/storefront/StorefrontRecommendations";
import { StorefrontShippingBar } from "@/components/storefront/StorefrontShippingBar";
import { formatQuantity } from "@/lib/money";
import { type RouterOutputs, trpc } from "@/lib/trpc";
import { buildStorefrontCartMessage, openWhatsApp } from "@/lib/whatsapp";
import {
  ArrowRight,
  MessageCircle,
  Minus,
  Plus,
  Share2,
  ShoppingCart,
  Tag,
  Trash2,
} from "lucide-react";
import React from "react";
export interface StorefrontCartPanelProps {
  setPanel: React.Dispatch<React.SetStateAction<Panel>>;
  cartLines: CartLine[];
  setQty: (cartKey: string, qty: number) => void;
  cartRecommendations:
    | RouterOutputs["storefront"]["cartRecommendations"]
    | undefined;
  setSelectedId: React.Dispatch<React.SetStateAction<number | null>>;
  addFeaturedToCart: (
    p: RowProduct,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => boolean;
  recentlyAddedProductId: number | null;
  cartSubtotal: number;
  freeThreshold: number;
  setShowWishlist: React.Dispatch<React.SetStateAction<boolean>>;
  scrollToResults: () => void;
  shareCart: () => Promise<void>;
  cartHasCustomization: boolean;
  sharePulseTarget: string | null;
  sharePulseNonce: number;
  openCheckout: () => void;
  storeOpen: boolean;
  orderingEnabled: boolean;
  settingsQ: Pick<
    ReturnType<typeof trpc.storefront.settings.useQuery>,
    "isFetching" | "isError" | "isLoading"
  >;
  settings: RouterOutputs["storefront"]["settings"] | undefined;
}
export function StorefrontCartPanel({
  setPanel,
  cartLines,
  setQty,
  cartRecommendations,
  setSelectedId,
  addFeaturedToCart,
  recentlyAddedProductId,
  cartSubtotal,
  freeThreshold,
  setShowWishlist,
  scrollToResults,
  shareCart,
  cartHasCustomization,
  sharePulseTarget,
  sharePulseNonce,
  openCheckout,
  storeOpen,
  orderingEnabled,
  settingsQ,
  settings,
}: StorefrontCartPanelProps) {
  return (
    <StorefrontPanelShell title="سلة المشتريات" onClose={() => setPanel(null)}>
      {cartLines.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <ShoppingCart aria-hidden className="size-10 opacity-50" />
          <p className="mt-3 text-sm">سلتك فارغة</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {cartLines.map((l) => (
              <div
                key={l.cartKey}
                className="flex flex-col gap-2.5 rounded-xl bg-white p-2.5 ring-1 ring-slate-100 sm:flex-row sm:items-center sm:gap-3 dark:bg-slate-900 dark:ring-slate-800"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <ProductImage
                    url={l.imageUrl}
                    alt={l.name}
                    className="size-14 sm:size-16 shrink-0 rounded-xl"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-xs font-bold leading-tight text-slate-800 dark:text-slate-100">
                      {l.name}
                    </p>
                    {summarizeStorefrontCustomization(l.customization) && (
                      <p className="mt-1 line-clamp-2 text-[10px] font-bold leading-relaxed text-[#a16b2a]">
                        تخصيص:{" "}
                        {summarizeStorefrontCustomization(l.customization)}
                      </p>
                    )}
                    <div className="mt-1 flex items-center justify-between sm:justify-start sm:gap-3">
                      <p className="text-sm font-extrabold text-emerald-600 whitespace-nowrap dark:text-emerald-400">
                        {money(l.price)} د.ع
                      </p>
                      <p className="text-[11px] sm:text-xs font-bold text-[#59636a] whitespace-nowrap">
                        {l.stockLimit != null
                          ? `المتوفر: ${formatQuantity(l.stockLimit)}`
                          : "متوفر للطلب"}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2 sm:border-0 sm:pt-0 sm:flex-col sm:items-center sm:gap-1.5 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setQty(l.cartKey, l.qty - 1)}
                      aria-label={`إنقاص كمية ${l.name}`}
                      className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                    >
                      <Minus aria-hidden className="size-3.5" />
                    </button>
                    <span className="w-6 text-center text-sm font-extrabold tabular-nums">
                      {formatQuantity(l.qty)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQty(l.cartKey, l.qty + 1)}
                      disabled={l.stockLimit != null && l.qty >= l.stockLimit}
                      aria-label={`زيادة كمية ${l.name}`}
                      className="flex size-11 items-center justify-center rounded-full bg-emerald-700 text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                    >
                      <Plus aria-hidden className="size-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQty(l.cartKey, 0)}
                    aria-label={`حذف ${l.name} من السلة`}
                    className="flex min-h-11 items-center gap-1 text-xs font-medium text-[var(--sem-neg)] hover:underline"
                  >
                    <Trash2 aria-hidden className="size-3" />
                    حذف
                  </button>
                </div>
              </div>
            ))}
          </div>
          {cartRecommendations && cartRecommendations.length > 0 && (
            <div className="mt-5 rounded-2xl border border-amber-200/70 bg-amber-50/60 p-3.5 dark:border-slate-800 dark:bg-slate-900/60">
              <CuratedRow
                title="أكمل تجهيزك"
                icon={<Tag aria-hidden className="size-4 text-orange-600" />}
                products={cartRecommendations}
                onSelect={setSelectedId}
                onAdd={addFeaturedToCart}
                recentlyAddedId={recentlyAddedProductId}
                canBeOrdered={storefrontProductCanBeOrdered}
              />
            </div>
          )}
          <div className="mt-4 rounded-xl bg-white p-3.5 text-sm ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
            <div className="flex justify-between text-slate-500">
              <span>المجموع الفرعي</span>
              <span className="font-extrabold text-slate-800 tabular-nums dark:text-slate-100">
                {money(cartSubtotal)} د.ع
              </span>
            </div>
          </div>
          <StorefrontShippingBar
            cartSubtotal={cartSubtotal}
            freeShippingThreshold={freeThreshold}
            className="mt-3"
          />
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setPanel(null);
                setShowWishlist(false);
                scrollToResults();
              }}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-[#1e4a63]/30 bg-[#f5f8fa] py-3 text-xs font-black text-[#1e4a63] transition hover:bg-[#eaf1f4]"
            >
              <Plus aria-hidden className="size-4" /> أضف المزيد
            </button>
            <button
              type="button"
              onClick={shareCart}
              disabled={cartHasCustomization}
              title={
                cartHasCustomization
                  ? "رابط السلة لا ينقل تفاصيل التخصيص"
                  : undefined
              }
              className={`store-action-button flex items-center justify-center gap-1.5 rounded-xl border border-[#e65f4a]/30 bg-[#fff6f2] py-3 text-xs font-black text-[#a4513f] transition hover:bg-[#ffede7] disabled:cursor-not-allowed disabled:opacity-50 ${sharePulseTarget === "cart" ? "store-action-button--active" : ""}`}
            >
              <Share2
                key={`share-cart-${sharePulseNonce}`}
                aria-hidden
                className={`size-4 ${sharePulseTarget === "cart" ? "animate__animated animate__pulse animate__faster" : ""}`}
              />{" "}
              مشاركة السلة
            </button>
          </div>
          <button
            onClick={openCheckout}
            disabled={!storeOpen || !orderingEnabled}
            className="store-primary-action store-mobile-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-sm shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
          >
            {storeOpen && orderingEnabled ? (
              <>
                متابعة إلى الدفع عند الاستلام
                <ArrowRight aria-hidden className="size-4 rotate-180" />
              </>
            ) : settingsQ.isLoading || settingsQ.isFetching ? (
              "جارٍ التحقق من حالة المتجر"
            ) : settingsQ.isError ? (
              "تعذّر التحقق من استقبال الطلبات — أعد المحاولة"
            ) : storeOpen && !orderingEnabled ? (
              "استقبال الطلبات متوقف مؤقتاً — التصفح متاح"
            ) : (
              "المتجر مغلق مؤقتاً — تعذّر إتمام الطلب"
            )}
          </button>
          {settings?.whatsappNumber && (
            <button
              onClick={() =>
                openWhatsApp(
                  settings!.whatsappNumber,
                  buildStorefrontCartMessage(
                    cartLines.map((l) => ({
                      name: summarizeStorefrontCustomization(l.customization)
                        ? `${l.name} — تخصيص: ${summarizeStorefrontCustomization(l.customization)}`
                        : l.name,
                      quantity: l.qty,
                      total: Number(l.price) * l.qty,
                    })),
                    cartSubtotal,
                  ),
                )
              }
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-50 py-3 text-sm font-bold text-emerald-700 transition motion-safe:active:scale-[0.98] hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400"
            >
              <MessageCircle aria-hidden className="size-4" /> أو أرسل سلّتك عبر
              واتساب
            </button>
          )}
          <StorefrontB2BQuoteButton
            cartLines={cartLines}
            cartSubtotal={cartSubtotal}
            orderingEnabled={orderingEnabled}
            turnstileSiteKey={settings?.turnstileSiteKey ?? null}
            className="mt-2 w-full"
          />
        </>
      )}
    </StorefrontPanelShell>
  );
}
