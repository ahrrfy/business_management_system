import React from "react";
import { money, priceLabel } from "@/components/storefront/storefrontCartMath";
import { CustomizationFieldControl } from "@/components/storefront/storefrontCustomizationModel";
import { StorefrontCustomizerStudio } from "@/components/storefront/StorefrontCustomizerStudio";
import { type CustomizationStudioUploadState } from "@/components/storefront/storefrontCustomizationUpload";
import { StorefrontHeuristicsBadges } from "@/components/storefront/StorefrontHeuristicsBadges";
import { formatQuantity } from "@/lib/money";
import { ArrowRight, Flame, Star, Store, Tag } from "lucide-react";
import type { StorefrontProductDialogProps } from "./StorefrontProductDialog";
import { StorefrontVariantChoices } from "./StorefrontVariantChoices";
type Props = Pick<
  StorefrontProductDialogProps,
  | "setProductReviewOpenRequest"
  | "setSelectedId"
  | "selectCategory"
  | "detailUnit"
  | "variantQuantities"
  | "setSelectedVariantId"
  | "setSelectedStoreUnitId"
  | "setVariantQuantity"
  | "detailVariant"
  | "customizationConfig"
  | "visibleCustomizationFields"
  | "customizationValues"
  | "customizationValidation"
  | "updateCustomizationField"
  | "detailMedia"
> & {
  product: NonNullable<StorefrontProductDialogProps["product"]>;
  setCustomizationAssets?: (assets: {
    logoAssetKey?: string;
    previewAssetKey?: string;
  }) => void;
  setCustomizationUploadState?: (state: CustomizationStudioUploadState) => void;
};
export function StorefrontProductInformation({
  product,
  setProductReviewOpenRequest,
  setSelectedId,
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
  detailMedia,
  setCustomizationAssets,
  setCustomizationUploadState,
}: Props) {
  const autoFilledFileValueRef = React.useRef<string | null>(null);
  return (
    <div className="min-w-0">
      {product.brand && (
        <p className="text-xs font-medium text-slate-400">{product.brand}</p>
      )}
      <h3 className="text-base font-extrabold leading-snug text-slate-900 dark:text-white">
        {product.productName}
      </h3>

      {/* شريط التقييمات والنجوم السريع مع زر كتابة التقييم */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50/80 p-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/60 dark:ring-slate-700/80">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 text-amber-500">
            {[1, 2, 3, 4, 5].map((s) => (
              <Star
                key={s}
                aria-hidden
                className={`size-3.5 ${
                  s <= Math.round(Number(product?.ratingAverage ?? 5))
                    ? "fill-current text-amber-400"
                    : "text-slate-300 dark:text-slate-600"
                }`}
              />
            ))}
          </div>
          <span className="font-mono text-xs font-black text-slate-800 dark:text-slate-100">
            {product?.ratingAverage
              ? Number(product.ratingAverage).toFixed(1)
              : "5.0"}
          </span>
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
            {product?.reviewsCount
              ? `(${formatQuantity(product.reviewsCount)} تقييم معتمد)`
              : "(كن أول من يقيّم المنتج)"}
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            setProductReviewOpenRequest({
              open: true,
              orderNumber: null,
            });
            document
              .getElementById("storefront-product-reviews")
              ?.scrollIntoView({ behavior: "smooth" });
          }}
          className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-black text-white shadow-xs transition hover:bg-amber-600 active:scale-95"
        >
          <Star aria-hidden className="size-3 fill-current" />
          <span>اكتب تقييمك</span>
        </button>
      </div>

      {/* وسوم السمات الإرشادية السريعة (Category Heuristics Badges) */}
      <StorefrontHeuristicsBadges
        productName={product.productName}
        category={product.category}
        description={product.description}
        isCustomizable={product.isCustomizable}
        isBundle={product.isBundle}
        limit={3}
        className="mt-2.5"
      />
      {product.description && (
        <p className="mt-2 whitespace-pre-line text-xs leading-6 text-slate-600 dark:text-slate-300">
          {product.description}
        </p>
      )}
      {product.category && (
        <p className="mt-1 text-xs text-slate-500">الفئة: {product.category}</p>
      )}
      {product.categoryId != null && product.category && (
        <button
          type="button"
          onClick={() => {
            setSelectedId(null);
            selectCategory(product!.categoryId!);
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[#c5e8dc] bg-[#e9f7f2] px-3 py-1.5 text-[11px] font-black text-[#276c5d] transition hover:border-[#1e4a63] hover:bg-[#d9f1e8]"
          aria-label={`تصفح منتجات فئة ${product.category}`}
        >
          <Store aria-hidden className="size-3.5" /> تصفح منتجات «
          {product.category}»{" "}
          <ArrowRight aria-hidden className="size-3.5 rotate-180" />
        </button>
      )}
      <p className="mt-0.5 text-xs text-slate-500">
        الوحدة: {detailUnit?.unitName ?? product.unitName}
      </p>
      <StorefrontVariantChoices
        product={product}
        detailUnit={detailUnit}
        variantQuantities={variantQuantities}
        setSelectedVariantId={setSelectedVariantId}
        setSelectedStoreUnitId={setSelectedStoreUnitId}
        setVariantQuantity={setVariantQuantity}
        detailVariant={detailVariant}
      />
      {product.isCustomizable && !customizationConfig ? (
        <div
          role="status"
          className="mt-3 rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm font-bold text-[var(--sem-warn)]"
        >
          إعداد حقول التخصيص غير مكتمل لهذا المنتج. تواصل معنا أو حاول لاحقاً.
        </div>
      ) : customizationConfig ? (
        <section
          className="mt-3 rounded-2xl border border-[#f0d991] bg-[#fff8df] p-3"
          aria-label="خيارات تخصيص المنتج"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black text-[#25406f]">
                {customizationConfig.title}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-[#806b3a]">
                {customizationConfig.description ??
                  "أكمل الحقول المطلوبة قبل إضافة المنتج للسلة."}
              </p>
            </div>
            <Tag aria-hidden className="size-4 shrink-0 text-[#d39c27]" />
          </div>
          <div className="mt-3 space-y-2.5">
            {visibleCustomizationFields.map((field) => {
              const controlId = `storefront-customization-${field.id}`;
              const labelId = `${controlId}-label`;
              const hintId =
                field.fieldType === "FILE" ? `${controlId}-hint` : undefined;
              const invalid =
                field.isRequired &&
                !(customizationValues[field.fieldKey] ?? "").trim() &&
                Boolean(customizationValidation);
              const describedBy =
                [hintId, invalid ? "storefront-customization-error" : undefined]
                  .filter(Boolean)
                  .join(" ") || undefined;
              return (
                <div
                  key={field.id}
                  className="block text-xs font-black text-[#25406f]"
                >
                  <label
                    id={labelId}
                    htmlFor={
                      field.fieldType === "SWATCH" ? undefined : controlId
                    }
                  >
                    {field.label}
                    {field.isRequired && (
                      <span
                        aria-hidden="true"
                        className="text-[var(--store-accent)]"
                      >
                        {" "}
                        *
                      </span>
                    )}
                    {field.isRequired && (
                      <span className="sr-only"> — مطلوب</span>
                    )}
                  </label>
                  <CustomizationFieldControl
                    field={field}
                    value={customizationValues[field.fieldKey] ?? ""}
                    onChange={(value) => updateCustomizationField(field, value)}
                    controlId={controlId}
                    labelId={labelId}
                    describedBy={describedBy}
                    invalid={invalid}
                  />
                  {field.fieldType === "FILE" && (
                    <span
                      id={hintId}
                      className="mt-1 block text-xs font-medium text-[#6c5a3f]"
                    >
                      ارفع الشعار من استوديو المعاينة الحية أدناه ليُحفظ مع الطلب أو اكتب مرجع التصميم.
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {customizationValidation && (
            <p
              id="storefront-customization-error"
              role="alert"
              className="mt-2 rounded-xl bg-[var(--store-accent)]/10 px-2.5 py-2 text-xs font-bold text-[var(--store-accent-strong)]"
            >
              {customizationValidation}
            </p>
          )}
        </section>
      ) : null}

      {product.isCustomizable && Boolean(customizationConfig) && (
        <StorefrontCustomizerStudio
          key={product.productId}
          productName={product.productName}
          baseImageUrl={detailMedia.fallbackUrl ?? product.imageUrl}
          onAssetsChange={(assets) => {
            setCustomizationAssets?.(assets);
            const fileField = visibleCustomizationFields.find(
              (f) => f.fieldType === "FILE",
            );
            if (!fileField) return;
            const currentFileVal = (customizationValues[fileField.fieldKey] ?? "").trim();
            if (assets.logoAssetKey && !currentFileVal) {
              autoFilledFileValueRef.current = "شعار مرفوع مع الطلب";
              updateCustomizationField(fileField, "شعار مرفوع مع الطلب");
            } else if (
              !assets.logoAssetKey &&
              currentFileVal &&
              (currentFileVal === "شعار مرفوع مع الطلب" ||
                currentFileVal === "شعار مرفق من استوديو المعاينة الحية" ||
                currentFileVal === autoFilledFileValueRef.current)
            ) {
              autoFilledFileValueRef.current = null;
              updateCustomizationField(fileField, "");
            }
          }}
          onUploadStateChange={setCustomizationUploadState}
          onApplyCustomization={(customData) => {
            setCustomizationAssets?.({
              logoAssetKey: customData.logoAssetKey,
              previewAssetKey: customData.previewAssetKey,
            });
            const primaryField = visibleCustomizationFields.find(
              (f) => f.fieldType === "TEXT" || f.fieldType === "TEXTAREA",
            );
            if (primaryField && customData.customText) {
              updateCustomizationField(primaryField, customData.customText);
            }
            const fileField = visibleCustomizationFields.find(
              (f) => f.fieldType === "FILE",
            );
            if (fileField && customData.hasLogo) {
              const nextFileLabel =
                customData.logoFileName || "شعار مرفق من استوديو المعاينة الحية";
              autoFilledFileValueRef.current = nextFileLabel;
              updateCustomizationField(fileField, nextFileLabel);
            }
          }}
          className="mt-4"
        />
      )}
      <div className="mt-3 flex items-baseline gap-2">
        <p className="text-xl font-extrabold text-money-positive">
          {priceLabel(detailUnit?.salePrice ?? detailUnit?.price ?? null)}
        </p>
        {detailUnit?.salePrice != null &&
          detailUnit.price != null &&
          Number(detailUnit.salePrice) < Number(detailUnit.price) && (
            <span className="text-sm text-slate-400 line-through">
              {money(detailUnit.price)}
            </span>
          )}
      </div>
      {!product.isCustomizable && detailUnit?.promotionName && (
        <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
          <Tag aria-hidden className="size-3" /> {detailUnit.promotionName}
        </span>
      )}
      {!product.isCustomizable && (
        <p
          className={`mt-2 text-xs font-bold ${detailUnit?.inStock ? "text-[var(--stock-ok)]" : "text-stock-out"}`}
        >
          {detailUnit?.inStock
            ? detailUnit.stockLeft != null
              ? `متوفّر — بقي ${formatQuantity(detailUnit.stockLeft)} فقط، سارع بالطلب`
              : "متوفّر"
            : "غير متوفّر حالياً"}
        </p>
      )}
      {!product.isCustomizable && product.soldCount >= 3 && (
        <p className="mt-1 flex items-center gap-1 text-xs font-bold text-orange-500">
          <Flame aria-hidden className="size-3.5" />{" "}
          {product.soldCount >= 10
            ? "من الأكثر مبيعاً"
            : `بيع ${formatQuantity(product.soldCount)} مرة`}
        </p>
      )}
    </div>
  );
}
