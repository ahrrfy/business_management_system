import React from "react";
import { formatQuantity } from "@/lib/money";
import { variantDescriptor } from "@shared/variantDisplay";
import { Minus, Plus } from "lucide-react";
import { priceLabel } from "./storefrontCartMath";
import { StorefrontColorSwatches } from "./StorefrontColorSwatches";
import type { StorefrontProductDialogProps } from "./StorefrontProductDialog";
type Props = Pick<
  StorefrontProductDialogProps,
  | "detailUnit"
  | "variantQuantities"
  | "setSelectedVariantId"
  | "setSelectedStoreUnitId"
  | "setVariantQuantity"
  | "detailVariant"
> & { product: NonNullable<StorefrontProductDialogProps["product"]> };
export function StorefrontVariantChoices({
  product,
  detailUnit,
  variantQuantities,
  setSelectedVariantId,
  setSelectedStoreUnitId,
  setVariantQuantity,
  detailVariant,
}: Props) {
  return (
    <>
      {(product.variants?.length ?? 0) > 1 && (
        <div
          className="mt-3"
          role="group"
          aria-labelledby="storefront-variant-options-title"
        >
          <p
            id="storefront-variant-options-title"
            className="mb-1 text-xs font-extrabold text-slate-700 dark:text-slate-200"
          >
            {product.hasAlternatives
              ? "اختر الماركة أو النوع والكمية"
              : "اختر اللون أو القياس والكمية"}
          </p>
          <p className="mb-2 text-[11px] text-slate-500">
            {product.hasAlternatives
              ? "تُباع تحت اسمٍ واحد ماركاتٌ/أنواعٌ مختلفة، لكلٍّ مخزونه وسعره — اختر ما يناسبك."
              : "يمكنك اختيار أكثر من لون أو قياس، ولكل اختيار كمية مستقلة."}
          </p>
          <div className="space-y-2">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {product.variants!.map((variant) => (
                <div
                  key={variant.variantId}
                  className={`rounded-lg border p-1.5 ${variant.inStock ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800" : "border-slate-100 bg-slate-50 opacity-60 dark:border-slate-800 dark:bg-slate-900"}`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {variant.colorHex && (
                        <span
                          className="size-4 shrink-0 rounded-full ring-1 ring-black/20"
                          style={{ backgroundColor: variant.colorHex }}
                          aria-hidden
                        />
                      )}
                      <span className="truncate">
                        {variant.color || variant.label}
                      </span>
                      {variant.variantKind === "ALTERNATIVE" && (
                        <span className="shrink-0 rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-600 dark:text-slate-100">
                          ماركة مختلفة
                        </span>
                      )}
                      {variant.size && (
                        <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                          المقاس {variant.size}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {variant.inStock
                        ? `${variant.units.filter((unit) => unit.inStock).length} خيارات`
                        : "نفد"}
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {variant.units.map((unit) => {
                      const quantity =
                        variantQuantities.get(unit.productUnitId) ?? 0;
                      const stockLimit =
                        unit.stockLeft == null
                          ? 999
                          : Math.min(Math.floor(unit.stockLeft), 999);
                      return (
                        <div
                          key={unit.productUnitId}
                          className={`flex items-center justify-between gap-1 rounded-md border px-1.5 py-0.5 ${unit.inStock ? "border-slate-100 bg-slate-50 dark:border-slate-700 dark:bg-slate-900" : "border-slate-100 bg-white opacity-50 dark:border-slate-800 dark:bg-slate-800"}`}
                        >
                          <button
                            type="button"
                            disabled={!unit.inStock}
                            onClick={() => {
                              setSelectedVariantId(variant.variantId);
                              setSelectedStoreUnitId(unit.productUnitId);
                              if (quantity === 0)
                                setVariantQuantity(unit.productUnitId, 1);
                            }}
                            className="min-w-0 flex-1 text-right text-[11px] font-bold text-slate-700 disabled:cursor-not-allowed dark:text-slate-200"
                          >
                            <span className="block truncate">
                              {unit.unitName}
                              {variant.size ? ` · ${variant.size}` : ""}
                            </span>
                            <span className="mt-0.5 block truncate text-xs font-extrabold text-[var(--sem-pos)]">
                              {priceLabel(unit.salePrice ?? unit.price)}
                              {!unit.inStock
                                ? " · نفد"
                                : unit.stockLeft != null
                                  ? ` · المتوفر ${formatQuantity(unit.stockLeft)}`
                                  : " · متوفر"}
                            </span>
                          </button>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              aria-label={`إنقاص ${variant.label} ${unit.unitName}`}
                              disabled={!unit.inStock || quantity === 0}
                              onClick={() => {
                                setSelectedVariantId(variant.variantId);
                                setSelectedStoreUnitId(unit.productUnitId);
                                setVariantQuantity(
                                  unit.productUnitId,
                                  quantity - 1,
                                );
                              }}
                              className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200"
                            >
                              <Minus aria-hidden className="size-3" />
                            </button>
                            <span className="w-5 text-center text-sm font-extrabold tabular-nums">
                              {formatQuantity(quantity)}
                            </span>
                            <button
                              type="button"
                              aria-label={`زيادة ${variant.label} ${unit.unitName}`}
                              disabled={!unit.inStock || quantity >= stockLimit}
                              onClick={() => {
                                setSelectedVariantId(variant.variantId);
                                setSelectedStoreUnitId(unit.productUnitId);
                                setVariantQuantity(
                                  unit.productUnitId,
                                  quantity + 1,
                                );
                              }}
                              className="flex size-6 items-center justify-center rounded-full bg-[var(--sem-pos)] text-background disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Plus aria-hidden className="size-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {(product.variants?.length ?? 0) <= 1 &&
        (detailVariant?.units.length ?? product.storeUnits?.length ?? 0) >
          0 && (
          <div
            className="mt-3"
            role="group"
            aria-label="اختر القياس أو وحدة البيع والكمية"
          >
            {(detailVariant?.variantName ||
              detailVariant?.color ||
              detailVariant?.size) && (
              <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs font-extrabold text-slate-700 dark:text-slate-200">
                <span>
                  الاختيار:{" "}
                  {variantDescriptor({ productName: "", ...detailVariant })}
                </span>
                {detailVariant.variantKind === "ALTERNATIVE" && (
                  <span className="rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-600 dark:text-slate-100">
                    ماركة مختلفة
                  </span>
                )}
              </p>
            )}
            <div className="space-y-1.5">
              {(detailVariant?.units ?? product.storeUnits ?? []).map(
                (unit) => {
                  const selected =
                    (detailUnit?.productUnitId ?? product!.productUnitId) ===
                    unit.productUnitId;
                  const quantity =
                    variantQuantities.get(unit.productUnitId) ??
                    (selected ? 1 : 0);
                  const stockLimit =
                    unit.stockLeft == null
                      ? 999
                      : Math.min(Math.floor(unit.stockLeft), 999);
                  return (
                    <div
                      key={unit.productUnitId}
                      className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 ${selected ? "border-[var(--sem-pos)] bg-emerald-50/60 dark:bg-emerald-500/10" : "border-slate-200 dark:border-slate-700"}`}
                    >
                      <button
                        type="button"
                        disabled={!unit.inStock}
                        onClick={() => {
                          setSelectedStoreUnitId(unit.productUnitId);
                          if (!variantQuantities.has(unit.productUnitId))
                            setVariantQuantity(unit.productUnitId, 1);
                        }}
                        className="min-w-0 flex-1 text-right text-xs font-bold text-slate-700 disabled:opacity-50 dark:text-slate-200"
                      >
                        <span className="block truncate">{unit.unitName}</span>
                        <span className="mt-0.5 block truncate text-xs font-extrabold text-[var(--sem-pos)]">
                          {priceLabel(unit.salePrice ?? unit.price)}
                          {!unit.inStock
                            ? " · نفد"
                            : unit.stockLeft != null
                              ? ` · المتوفر ${formatQuantity(unit.stockLeft)}`
                              : " · متوفر"}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          aria-label={`إنقاص ${unit.unitName}`}
                          disabled={!unit.inStock || quantity === 0}
                          onClick={() =>
                            setVariantQuantity(unit.productUnitId, quantity - 1)
                          }
                          className="flex size-7 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200"
                        >
                          <Minus aria-hidden className="size-3.5" />
                        </button>
                        <span className="w-5 text-center text-sm font-extrabold tabular-nums">
                          {formatQuantity(quantity)}
                        </span>
                        <button
                          type="button"
                          aria-label={`زيادة ${unit.unitName}`}
                          disabled={!unit.inStock || quantity >= stockLimit}
                          onClick={() => {
                            setSelectedStoreUnitId(unit.productUnitId);
                            setVariantQuantity(
                              unit.productUnitId,
                              quantity + 1,
                            );
                          }}
                          className="flex size-7 items-center justify-center rounded-full bg-[var(--sem-pos)] text-background disabled:opacity-40"
                        >
                          <Plus aria-hidden className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        )}
      {product.colors && product.colors.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
          <span>ألوان المنتج:</span>
          <StorefrontColorSwatches colors={product.colors} max={12} size={16} />
        </div>
      )}
    </>
  );
}
