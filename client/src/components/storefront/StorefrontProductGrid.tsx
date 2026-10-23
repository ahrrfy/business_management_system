import { InlineStrip } from "@/components/storefront/StorefrontInlineStrip";
import { BundleMedia } from "@/components/storefront/StorefrontMedia";
import { StorefrontProductCard } from "@/components/storefront/StorefrontProductCard";
import {
  recommendationActionLabel,
  storefrontProductCanBeOrdered,
} from "@/components/storefront/StorefrontRecommendations";
import { type ReactNode } from "react";
import type { StorefrontCatalogSurfaceProps } from "./StorefrontCatalogSurface";
type Props = Pick<
  StorefrontCatalogSurfaceProps,
  | "filteredItems"
  | "wishlistIds"
  | "recentlyAddedProductId"
  | "heartPulseTarget"
  | "heartPulseNonce"
  | "sharePulseTarget"
  | "sharePulseNonce"
  | "openProduct"
  | "addCatalogProduct"
  | "toggleWishlist"
  | "shareProduct"
  | "getProductCartQty"
  | "handleProductQuantityDelta"
  | "search"
  | "feedStrips"
  | "inlineBanners"
>;
export function StorefrontProductGrid({
  filteredItems,
  wishlistIds,
  recentlyAddedProductId,
  heartPulseTarget,
  heartPulseNonce,
  sharePulseTarget,
  sharePulseNonce,
  openProduct,
  addCatalogProduct,
  toggleWishlist,
  shareProduct,
  getProductCartQty,
  handleProductQuantityDelta,
  search,
  feedStrips,
  inlineBanners,
}: Props) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {filteredItems.flatMap((p, idx) => {
        const card = (
          <StorefrontProductCard
            key={p.productId}
            product={p}
            isWishlisted={wishlistIds.has(p.productId)}
            isRecentlyAdded={recentlyAddedProductId === p.productId}
            heartPulseTarget={heartPulseTarget}
            heartPulseNonce={heartPulseNonce}
            sharePulseTarget={sharePulseTarget}
            sharePulseNonce={sharePulseNonce}
            onOpen={openProduct}
            onAdd={addCatalogProduct}
            onToggleWishlist={toggleWishlist}
            onShare={shareProduct}
            canBeOrdered={storefrontProductCanBeOrdered}
            actionLabel={recommendationActionLabel(p)}
            cartQuantity={getProductCartQty(p.productId)}
            onUpdateQuantity={handleProductQuantityDelta}
            mediaComponent={
              <BundleMedia
                urls={p.bundleImageUrls ?? p.imageUrls}
                fallbackUrl={p.imageUrl}
                alt={p.productName}
                showFallbackLabel
                className="aspect-[4/3] w-full"
              />
            }
          />
        );
        const nodes: ReactNode[] = [card];
        if (
          !search &&
          feedStrips.length > 0 &&
          (idx + 1) % 10 === 0 &&
          idx + 1 < filteredItems.length
        ) {
          const k = ((idx + 1) / 10 - 1) % feedStrips.length;
          nodes.push(
            <InlineStrip
              key={`strip-${idx}`}
              banner={feedStrips[k]}
              tone={inlineBanners.length ? "emerald" : "amber"}
            />,
          );
        }
        return nodes;
      })}
    </div>
  );
}
