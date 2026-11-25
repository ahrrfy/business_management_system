import { AnimatedAddToCartButton } from "@/components/storefront/AnimatedAddToCartButton";
import { type StorefrontCustomizationField } from "@/components/storefront/storefrontCustomizationModel";
import {
  isCustomizationUploadBlockingAddToCart,
  type CustomizationStudioUploadState,
} from "@/components/storefront/storefrontCustomizationUpload";
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
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "framer-motion";
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
import {
  APPLE_REDUCED_TRANSITION,
  APPLE_SPRING_SETTLE,
  APPLE_SPRING_SHEET,
  projectMomentum,
} from "./storefrontMotion";
const StorefrontProductInformation = React.lazy(() =>
  import("./StorefrontProductInformation").then((module) => ({
    default: module.StorefrontProductInformation,
  })),
);
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
  customizationUploadState?: CustomizationStudioUploadState;
  setCustomizationUploadState?: (state: CustomizationStudioUploadState) => void;
  setCustomizationAssets?: (assets: {
    logoAssetKey?: string;
    previewAssetKey?: string;
  }) => void;
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
  customizationUploadState,
  setCustomizationUploadState,
  setCustomizationAssets,
  addSelectedVariants,
  addSelectedUnit,
  getProductCartQty,
  settings,
  relatedQ,
  addCatalogProduct,
  trackRecommendationClick,
  productReviewOpenRequest,
}: StorefrontProductDialogProps) {
  const prefersReducedMotion = useReducedMotion();
  const dragControls = useDragControls();
  const settleTransition = prefersReducedMotion
    ? APPLE_REDUCED_TRANSITION
    : APPLE_SPRING_SETTLE;
  const sheetTransition = prefersReducedMotion
    ? APPLE_REDUCED_TRANSITION
    : APPLE_SPRING_SHEET;

  return (
    <DialogPrimitive.Root
      open={selectedId != null}
      onOpenChange={(open) => {
        if (!open) setSelectedId(null);
      }}
    >
      <DialogPrimitive.Portal forceMount>
        <AnimatePresence>
          {selectedId != null && (
            <>
              <DialogPrimitive.Overlay forceMount asChild>
                <motion.div
                  key="product-dialog-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={settleTransition}
                  className="fixed inset-0 z-40 bg-slate-900/45 backdrop-blur-[8px]"
                />
              </DialogPrimitive.Overlay>
              <DialogPrimitive.Content
                forceMount
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
                asChild
              >
                <motion.div
                  key="product-dialog-sheet"
                  initial={
                    prefersReducedMotion
                      ? { opacity: 0 }
                      : { opacity: 0, y: 36, scale: 0.985 }
                  }
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={
                    prefersReducedMotion
                      ? { opacity: 0 }
                      : { opacity: 0, y: 36, scale: 0.985 }
                  }
                  transition={sheetTransition}
                  drag={prefersReducedMotion ? false : "y"}
                  dragControls={dragControls}
                  dragListener={false}
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0.14, bottom: 0.55 }}
                  dragTransition={{ bounceStiffness: 420, bounceDamping: 36 }}
                  onDragEnd={(_, info) => {
                    const projectedY =
                      info.offset.y + projectMomentum(info.velocity.y, 0.99);
                    if (projectedY > 150 || info.velocity.y > 520) {
                      setSelectedId(null);
                    }
                  }}
                  className="storefront fixed bottom-0 left-1/2 z-50 flex max-h-[min(780px,calc(100dvh-1rem-env(safe-area-inset-top)))] w-[calc(100%-0.5rem)] max-w-4xl -translate-x-1/2 flex-col overflow-hidden overscroll-contain rounded-t-3xl border border-slate-200/70 bg-white/95 p-3 shadow-2xl outline-none backdrop-blur-[18px] saturate-150 dark:border-slate-800 dark:bg-slate-900/95 sm:bottom-auto sm:top-1/2 sm:w-[calc(100%-2rem)] sm:-translate-y-1/2 sm:rounded-2xl"
                  style={{
                    paddingBottom: "calc(.75rem + env(safe-area-inset-bottom))",
                  }}
                >
                  {/* مقبض سحب تفاعلي للهواتف + شريط العنوان */}
                  <div
                    onPointerDown={(event) => {
                      if ((event.target as HTMLElement)?.closest("button")) return;
                      if (!prefersReducedMotion) dragControls.start(event);
                    }}
                    className="mb-3 touch-none select-none"
                  >
                    <div
                      aria-hidden="true"
                      className="mx-auto mb-2.5 h-1.5 w-11 rounded-full bg-slate-300/90 dark:bg-slate-700 sm:hidden"
                    />
                    <div className="flex items-center justify-between">
                      <DialogPrimitive.Title className="store-display-title text-sm font-extrabold text-slate-600 dark:text-slate-300">
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
                            className={`store-action-button flex size-9 touch-manipulation items-center justify-center rounded-full transition-[transform,background-color,color] duration-150 ease-out hover:bg-rose-50 active:scale-[0.94] ${wishlistIds.has(product.productId) ? "text-rose-600" : "text-slate-500"} ${heartPulseTarget === `product-${product.productId}` ? "store-action-button--active" : ""}`}
                          >
                            <Heart
                              key={`wishlist-detail-${product.productId}-${heartPulseNonce}`}
                              aria-hidden
                              className={`size-4 ${wishlistIds.has(product.productId) ? "fill-current" : ""}`}
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
                            className={`store-action-button flex size-9 touch-manipulation items-center justify-center rounded-full text-slate-500 transition-[transform,background-color,color] duration-150 ease-out hover:bg-slate-100 hover:text-[var(--store-brand)] active:scale-[0.94] ${sharePulseTarget === `product-${product.productId}` ? "store-action-button--active" : ""}`}
                          >
                            <Share2
                              key={`share-detail-${product.productId}-${sharePulseNonce}`}
                              aria-hidden
                              className="size-4"
                            />
                          </button>
                        )}
                        <DialogPrimitive.Close asChild>
                          <button
                            ref={productDialogCloseRef}
                            type="button"
                            aria-label="إغلاق تفاصيل المنتج"
                            className="flex size-11 touch-manipulation items-center justify-center rounded-full bg-slate-100/90 text-slate-600 transition-[transform,background-color] duration-100 ease-out hover:bg-slate-200 active:scale-[0.94] dark:bg-slate-800 dark:text-slate-300"
                          >
                            <X aria-hidden className="size-4" />
                          </button>
                        </DialogPrimitive.Close>
                      </div>
                    </div>
                  </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-1">
              {productLoading ? (
                <div className="flex justify-center py-12 text-[var(--store-brand)]">
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
                    <React.Suspense fallback={<p role="status" className="p-3 text-sm text-muted-foreground">جارٍ تحميل تفاصيل المنتج…</p>}>
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
                      setCustomizationAssets={setCustomizationAssets}
                      setCustomizationUploadState={setCustomizationUploadState}
                    />
                    </React.Suspense>
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
                        isCustomizationUploadBlockingAddToCart(
                          customizationUploadState,
                        ) ||
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
                          : customizationUploadState === "uploading"
                            ? "جارٍ رفع مرفق التخصيص..."
                            : customizationUploadState === "error"
                              ? "أكمل رفع المرفق أو أزله أولاً"
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
                        className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-800 transition hover:border-emerald-600/60 hover:bg-emerald-50/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      >
                        <MessageCircle aria-hidden className="size-3.5 text-emerald-500" />
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
                      <div className="mt-4 rounded-xl border border-slate-200/80 bg-[#f5f5f7] p-3 dark:border-slate-800 dark:bg-slate-900/70">
                        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                          <Package aria-hidden className="size-3.5 text-[var(--store-brand)]" /> يحتوي
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
          </motion.div>
        </DialogPrimitive.Content>
            </>
          )}
        </AnimatePresence>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
