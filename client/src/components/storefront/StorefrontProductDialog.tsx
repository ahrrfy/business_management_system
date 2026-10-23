import { AnimatedAddToCartButton } from "@/components/storefront/AnimatedAddToCartButton";
import { type StorefrontCustomizationField } from "@/components/storefront/storefrontCustomizationModel";
import { ProductGallery } from "@/components/storefront/StorefrontMedia";
import { StorefrontPersonalAdvisorCard } from "@/components/storefront/StorefrontPersonalAdvisorCard";
import { StorefrontProductReviews } from "@/components/storefront/StorefrontProductReviews";
import {
  RelatedProductStrip,
  type StorefrontProductForCartAction,
} from "@/components/storefront/StorefrontRecommendations";
import { StorefrontSocialProofTicker } from "@/components/storefront/StorefrontSocialProofTicker";
import { formatQuantity } from "@/lib/money";
import { type RouterOutputs } from "@/lib/trpc";
import { openWhatsApp } from "@/lib/whatsapp";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Heart,
  Loader2,
  MessageCircle,
  Package,
  Share2,
  X,
} from "lucide-react";
import React from "react";
import type { StorefrontCustomizationConfig } from "./storefrontCustomizationModel";
import { StorefrontProductInformation } from "./StorefrontProductInformation";
type StorefrontVariantOption = NonNullable<
  NonNullable<RouterOutputs["storefront"]["product"]>["variants"]
>[number];
type StorefrontUnitOption = StorefrontVariantOption["units"][number];
export interface StorefrontProductDialogProps {
  selectedId: number | null;
  setSelectedId: React.Dispatch<React.SetStateAction<number | null>>;
  productDialogCloseRef: React.RefObject<HTMLButtonElement | null>;
  productDialogTriggerRef: React.RefObject<HTMLElement | null>;
  product: RouterOutputs["storefront"]["product"] | undefined;
  toggleWishlist: (productId: number, target?: string) => void;
  wishlistIds: Set<number>;
  heartPulseTarget: string | null;
  heartPulseNonce: number;
  shareProduct: (productId: number, productName: string) => void;
  sharePulseTarget: string | null;
  sharePulseNonce: number;
  productLoading: boolean;
  detailMedia: { urls: string[] | undefined; fallbackUrl: string | null };
  setProductReviewOpenRequest: React.Dispatch<
    React.SetStateAction<{ open: boolean; orderNumber?: string | null }>
  >;
  selectCategory: (id: number | null) => void;
  detailUnit: StorefrontUnitOption | null;
  variantQuantities: Map<number, number>;
  setSelectedVariantId: React.Dispatch<React.SetStateAction<number | null>>;
  setSelectedStoreUnitId: React.Dispatch<React.SetStateAction<number | null>>;
  setVariantQuantity: (productUnitId: number, quantity: number) => void;
  detailVariant: StorefrontVariantOption | null;
  customizationConfig: StorefrontCustomizationConfig | null;
  visibleCustomizationFields: StorefrontCustomizationField[];
  customizationValues: Record<string, string>;
  customizationValidation: string | null;
  updateCustomizationField: (
    field: StorefrontCustomizationField,
    value: string,
  ) => void;
  addSelectedVariants: (sourceElement?: HTMLElement | null) => boolean;
  addSelectedUnit: (sourceElement?: HTMLElement | null) => boolean;
  getProductCartQty: (id: number) => number;
  settings: RouterOutputs["storefront"]["settings"] | undefined;
  relatedQ: { data: RouterOutputs["storefront"]["related"] | undefined };
  addCatalogProduct: (
    p: StorefrontProductForCartAction,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => boolean;
  trackRecommendationClick: (recommendedProductId: number) => void;
  productReviewOpenRequest: { open: boolean; orderNumber?: string | null };
}
export function StorefrontProductDialog({
  selectedId,
  setSelectedId,
  productDialogCloseRef,
  productDialogTriggerRef,
  product,
  toggleWishlist,
  wishlistIds,
  heartPulseTarget,
  heartPulseNonce,
  shareProduct,
  sharePulseTarget,
  sharePulseNonce,
  productLoading,
  detailMedia,
  setProductReviewOpenRequest,
  selectCategory,
  detailUnit,
  variantQuantities,
  setSelectedVariantId,
  setSelectedStoreUnitId,
  setVariantQuantity,
  detailVariant,
  customizationConfig,
  visibleCustomizationFields,
  customizationValues,
  customizationValidation,
  updateCustomizationField,
  addSelectedVariants,
  addSelectedUnit,
  getProductCartQty,
  settings,
  relatedQ,
  addCatalogProduct,
  trackRecommendationClick,
  productReviewOpenRequest,
}: StorefrontProductDialogProps) {
  return (
    <DialogPrimitive.Root
      open={selectedId != null}
      onOpenChange={(open) => {
        if (!open) setSelectedId(null);
      }}
    >
      {selectedId != null && (
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              productDialogCloseRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const trigger = productDialogTriggerRef.current;
              productDialogTriggerRef.current = null;
              window.requestAnimationFrame(() => {
                if (trigger?.isConnected) trigger.focus();
              });
            }}
            className="storefront animate__animated animate__fadeInUp animate__faster fixed bottom-0 left-1/2 z-50 flex max-h-[min(780px,calc(100dvh-1rem-env(safe-area-inset-top)))] w-[calc(100%-1rem)] max-w-4xl -translate-x-1/2 flex-col overflow-hidden overscroll-contain rounded-t-2xl bg-white p-3 shadow-2xl outline-none dark:bg-slate-900 sm:bottom-auto sm:top-1/2 sm:w-[calc(100%-2rem)] sm:-translate-y-1/2 sm:rounded-2xl"
            style={{
              paddingBottom: "calc(.75rem + env(safe-area-inset-bottom))",
            }}
          >
            <div className="mb-3 flex items-center justify-between">
              <DialogPrimitive.Title className="text-sm font-extrabold text-slate-500 dark:text-slate-400">
                تفاصيل المنتج
              </DialogPrimitive.Title>
              <div className="flex items-center gap-1.5">
                {product && (
                  <button
                    type="button"
                    onClick={() => toggleWishlist(product!.productId)}
                    aria-label={
                      wishlistIds.has(product.productId)
                        ? "إزالة المنتج من أعجبتني"
                        : "إضافة المنتج إلى أعجبتني"
                    }
                    aria-pressed={wishlistIds.has(product.productId)}
                    className={`store-action-button flex size-8 items-center justify-center rounded-full transition hover:bg-rose-50 ${wishlistIds.has(product.productId) ? "text-[#e65f4a]" : "text-slate-500"} ${heartPulseTarget === `product-${product.productId}` ? "store-action-button--active" : ""}`}
                  >
                    <Heart
                      key={`wishlist-detail-${product.productId}-${heartPulseNonce}`}
                      aria-hidden
                      className={`size-4 ${wishlistIds.has(product.productId) ? "fill-current" : ""} ${heartPulseTarget === `product-${product.productId}` ? "animate__animated animate__heartBeat animate__faster" : ""}`}
                    />
                  </button>
                )}
                {product && (
                  <button
                    type="button"
                    onClick={() =>
                      shareProduct(product!.productId, product!.productName)
                    }
                    aria-label="مشاركة المنتج"
                    className={`store-action-button flex size-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-[#1e4a63] ${sharePulseTarget === `product-${product.productId}` ? "store-action-button--active" : ""}`}
                  >
                    <Share2
                      key={`share-detail-${product.productId}-${sharePulseNonce}`}
                      aria-hidden
                      className={`size-4 ${sharePulseTarget === `product-${product.productId}` ? "animate__animated animate__pulse animate__faster" : ""}`}
                    />
                  </button>
                )}
                <DialogPrimitive.Close asChild>
                  <button
                    ref={productDialogCloseRef}
                    type="button"
                    aria-label="إغلاق تفاصيل المنتج"
                    className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400"
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                </DialogPrimitive.Close>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-1">
              {productLoading ? (
                <div className="flex justify-center py-12 text-emerald-500">
                  <Loader2 aria-hidden className="size-6 animate-spin" />
                </div>
              ) : product ? (
                <div>
                  <div className="space-y-4 sm:grid sm:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] sm:items-start sm:gap-5 sm:space-y-0">
                    <ProductGallery
                      urls={detailMedia.urls}
                      fallbackUrl={detailMedia.fallbackUrl}
                      alt={product.productName}
                    />
                    <StorefrontProductInformation
                      product={product}
                      setProductReviewOpenRequest={setProductReviewOpenRequest}
                      setSelectedId={setSelectedId}
                      selectCategory={selectCategory}
                      detailUnit={detailUnit}
                      variantQuantities={variantQuantities}
                      setSelectedVariantId={setSelectedVariantId}
                      setSelectedStoreUnitId={setSelectedStoreUnitId}
                      setVariantQuantity={setVariantQuantity}
                      detailVariant={detailVariant}
                      customizationConfig={customizationConfig}
                      visibleCustomizationFields={visibleCustomizationFields}
                      customizationValues={customizationValues}
                      customizationValidation={customizationValidation}
                      updateCustomizationField={updateCustomizationField}
                      detailMedia={detailMedia}
                    />
                  </div>
                  <div className="sticky bottom-0 mt-2 border-t border-slate-100 bg-white/95 pt-2 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/95">
                    <AnimatedAddToCartButton
                      onAdd={(btnEl) => {
                        return (product?.variants?.length ?? 0) > 1
                          ? addSelectedVariants(btnEl)
                          : addSelectedUnit(btnEl);
                      }}
                      disabled={
                        (product.isCustomizable && !customizationConfig) ||
                        !!customizationValidation ||
                        ((product?.variants?.length ?? 0) > 1
                          ? !Array.from(variantQuantities.values()).some(
                              (quantity) => quantity > 0,
                            )
                          : !detailUnit?.inStock || detailUnit.price == null)
                      }
                      label={
                        product.isCustomizable && !customizationConfig
                          ? "إعداد التخصيص غير مكتمل"
                          : product.isCustomizable
                            ? "أضف المنتج المخصص إلى السلة"
                            : (product?.variants?.length ?? 0) > 1
                              ? "أضف الاختيارات إلى السلة"
                              : detailUnit?.inStock
                                ? "أضف إلى السلة"
                                : "غير متوفّر"
                      }
                      icon={
                        product.isCustomizable && !customizationConfig ? (
                          <AlertTriangle aria-hidden className="size-4" />
                        ) : undefined
                      }
                      cartCount={getProductCartQty(product.productId)}
                      showCartCount={true}
                    />
                    {settings?.whatsappNumber && (
                      <button
                        type="button"
                        onClick={() => {
                          const variantDesc =
                            detailVariant?.label ||
                            detailVariant?.variantName ||
                            [detailVariant?.color, detailVariant?.size]
                              .filter(Boolean)
                              .join(" - ") ||
                            "";
                          const variantText = variantDesc
                            ? ` (الخيار: ${variantDesc})`
                            : "";
                          const unitText = detailUnit?.unitName
                            ? ` (الوحدة: ${detailUnit.unitName})`
                            : "";
                          openWhatsApp(
                            settings!.whatsappNumber!,
                            `السلام عليكم، أود الاستفسار حول منتج «${product?.productName ?? ""}»${variantText}${unitText} عبر متجر الرؤية العربية.`,
                          );
                        }}
                        className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-50/80 py-2.5 text-xs font-black text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-600/40 dark:bg-emerald-950/30 dark:text-emerald-300"
                      >
                        <MessageCircle aria-hidden className="size-3.5" />
                        <span>استفسار حول المنتج عبر واتساب</span>
                      </button>
                    )}
                  </div>

                  {/* شريط الإقبال والدليل الاجتماعي اللحظي */}
                  <StorefrontSocialProofTicker
                    soldCount={product.soldCount}
                    productName={product.productName}
                    className="mt-3"
                  />

                  {/* محتويات البكج */}
                  {product.isBundle &&
                    product.bundleItems &&
                    product.bundleItems.length > 0 && (
                      <div className="mt-4 rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10">
                        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                          <Package aria-hidden className="size-3.5" /> يحتوي
                          البكج على:
                        </p>
                        <ul className="space-y-0.5 text-xs text-slate-700 dark:text-slate-300">
                          {product.bundleItems.map((bi, i) => (
                            <li key={i} className="flex justify-between">
                              <span>{bi.name}</span>
                              <span className="tabular-nums text-slate-500">
                                ×{formatQuantity(bi.quantity)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                  {/* قد يعجبك أيضاً (cross-sell) */}
                  {(relatedQ.data?.length ?? 0) > 0 && (
                    <RelatedProductStrip
                      products={relatedQ.data!}
                      onSelect={setSelectedId}
                      onAdd={(product, event) =>
                        addCatalogProduct(product, event)
                      }
                      onRecommendationClick={trackRecommendationClick}
                    />
                  )}

                  {/* بطاقة المستشار الشخصي المباشر للزبائن والشركات */}
                  <StorefrontPersonalAdvisorCard
                    productTitle={product.productName}
                    whatsappNumber={settings?.whatsappNumber}
                    className="mt-4"
                  />

                  {/* تقييمات وآراء العملاء المعتمدة (Social Proof) */}
                  {product && (
                    <StorefrontProductReviews
                      key={`${product.productId}-${productReviewOpenRequest.open ? "open" : "closed"}-${productReviewOpenRequest.orderNumber ?? ""}`}
                      productId={product.productId}
                      initialOpenForm={productReviewOpenRequest.open}
                      defaultOrderNumber={productReviewOpenRequest.orderNumber}
                    />
                  )}
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-slate-400">
                  تعذّر تحميل تفاصيل المنتج
                </p>
              )}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}
