import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { AnimatedEntrance } from "@/components/animated-entrance";
import {
  formatIqd,
  productDiscountPercent,
  storefrontDisplayPrice,
} from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";
import { useWishlist } from "@/lib/wishlist-context";
import type { Product } from "@/shared/storefront";

type ProductCardProps = {
  product: Product;
  variant?: "grid" | "rail";
  fullWidth?: boolean;
  quickAddLabel?: boolean;
  onQuickView?: (product: Product) => void;
  onAddedToCart?: () => void;
  animationDelay?: number;
};

/** A visual product tile with one unmistakable next action: choose its sellable option. */
export function ProductCard({
  product,
  variant = "grid",
  fullWidth = false,
  quickAddLabel = false,
  onQuickView,
  animationDelay = 0,
}: ProductCardProps) {
  const { isSaved, toggle } = useWishlist();
  const discount = productDiscountPercent(product);
  const isRail = variant === "rail";
  const openProduct = () => router.push(`/product/${product.id}` as never);
  const soldLabel =
    product.soldCount && product.soldCount > 0
      ? `طُلب ${product.soldCount}+ مرة`
      : null;

  return (
    <AnimatedEntrance
      delay={animationDelay}
      style={[
        styles.card,
        isRail ? styles.railCard : styles.gridCard,
        fullWidth && styles.fullWidth,
      ]}
    >
      <TouchableOpacity
        accessibilityLabel={`عرض ${product.title}`}
        activeOpacity={0.88}
        onPress={openProduct}
        style={styles.productTap}
      >
        <View style={[styles.cover, isRail && styles.railCover]}>
          {product.imageUrl ? (
            <Image
              cachePolicy="memory-disk"
              contentFit="contain"
              contentPosition="center"
              priority="high"
              recyclingKey={product.imageUrl}
              source={product.imageUrl}
              style={styles.productImage}
              transition={120}
            />
          ) : (
            <MaterialIcons
              color={storefrontDesign.semantic.brand}
              name={product.icon}
              size={isRail ? 52 : 42}
            />
          )}
          {discount != null && (
            <View style={styles.discountBadge}>
              <Text style={styles.discountText}>وفر {discount}%</Text>
            </View>
          )}
          <View
            style={[
              styles.status,
              product.isCustomizable && styles.specialOrder,
            ]}
          >
            <View
              style={[
                styles.statusDot,
                product.isCustomizable && styles.specialOrderDot,
              ]}
            />
            <Text
              style={[
                styles.statusText,
                product.isCustomizable && styles.specialOrderText,
              ]}
            >
              {product.isCustomizable ? "طلب خاص" : product.availability}
            </Text>
          </View>
        </View>
        <View style={styles.copy}>
          <Text numberOfLines={2} style={styles.title}>
            {product.title}
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {product.brand ?? product.subtitle}
          </Text>
          {soldLabel && (
            <View style={styles.socialProof}>
              <MaterialIcons
                color={storefrontDesign.semantic.brandStrong}
                name="local-fire-department"
                size={13}
              />
              <Text style={styles.socialProofText}>{soldLabel}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        accessibilityLabel={`${isSaved(product.id) ? "إزالة" : "حفظ"} ${product.title} من المفضلة`}
        activeOpacity={0.86}
        onPress={() => toggle(product.id)}
        style={styles.favorite}
      >
        <MaterialIcons
          color={
            isSaved(product.id)
              ? storefrontDesign.semantic.promotion
              : storefrontDesign.semantic.foreground
          }
          name={isSaved(product.id) ? "favorite" : "favorite-border"}
          size={19}
        />
      </TouchableOpacity>
      {onQuickView && (
        <TouchableOpacity
          accessibilityLabel={`معاينة سريعة ${product.title}`}
          activeOpacity={0.86}
          onPress={() => onQuickView(product)}
          style={styles.quick}
        >
          <MaterialIcons
            color={storefrontDesign.semantic.foreground}
            name="visibility"
            size={18}
          />
        </TouchableOpacity>
      )}

      <View style={styles.footer}>
        <View style={styles.priceBlock}>
          <Text style={styles.price}>
            {formatIqd(storefrontDisplayPrice(product))}
          </Text>
          {discount != null && (
            <Text style={styles.oldPrice}>{formatIqd(product.price)}</Text>
          )}
        </View>
        <TouchableOpacity
          accessibilityHint={
            product.isCustomizable
              ? "يفتح تفاصيل الطلب الخاص"
              : "يفتح خيارات اللون ووحدة البيع قبل الإضافة"
          }
          accessibilityLabel={
            product.isCustomizable
              ? `عرض تفاصيل ${product.title}`
              : `اختيار خيارات ${product.title}`
          }
          accessibilityRole="button"
          activeOpacity={0.84}
          onPress={openProduct}
          style={[
            styles.buyButton,
            isRail || quickAddLabel
              ? styles.buyButtonWide
              : styles.buyButtonCompact,
          ]}
        >
          {isRail || quickAddLabel || product.isCustomizable ? (
            <Text style={styles.buyText}>
              {product.isCustomizable ? "تفاصيل" : "أضف"}
            </Text>
          ) : (
            <MaterialIcons
              color={storefrontDesign.primitive.white}
              name="shopping-cart"
              size={18}
            />
          )}
          {(isRail || quickAddLabel || product.isCustomizable) && (
            <MaterialIcons
              color={storefrontDesign.primitive.white}
              name={product.isCustomizable ? "arrow-back" : "add"}
              size={16}
            />
          )}
        </TouchableOpacity>
      </View>
    </AnimatedEntrance>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: storefrontDesign.component.card.background,
    borderColor: storefrontDesign.component.card.border,
    borderRadius: storefrontDesign.component.card.radius,
    borderWidth: 1,
    marginBottom: 14,
    overflow: "hidden",
    shadowColor: "#748091",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.09,
    shadowRadius: 15,
  },
  gridCard: { width: "48.3%" },
  railCard: { marginLeft: 12, width: 244 },
  fullWidth: { width: "100%" },
  productTap: { flex: 1 },
  cover: {
    alignItems: "center",
    backgroundColor: "#F7F9FC",
    height: 164,
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
  },
  railCover: { height: 190 },
  productImage: { height: "100%", width: "100%" },
  discountBadge: {
    backgroundColor: storefrontDesign.semantic.promotion,
    borderBottomRightRadius: 13,
    left: 0,
    paddingHorizontal: 9,
    paddingVertical: 5,
    position: "absolute",
    top: 0,
  },
  discountText: {
    color: storefrontDesign.primitive.white,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9,
  },
  status: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.92)",
    borderColor: "rgba(17,42,37,0.08)",
    borderRadius: 999,
    borderWidth: 1,
    bottom: 8,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    position: "absolute",
    right: 8,
  },
  statusDot: {
    backgroundColor: storefrontDesign.semantic.brand,
    borderRadius: 20,
    height: 6,
    width: 6,
  },
  statusText: {
    color: storefrontDesign.semantic.brandStrong,
    fontFamily: "Cairo_700Bold",
    fontSize: 9,
  },
  specialOrder: { backgroundColor: storefrontDesign.primitive.sand },
  specialOrderDot: { backgroundColor: "#B27811" },
  specialOrderText: { color: "#825811" },
  favorite: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    position: "absolute",
    right: 9,
    top: 9,
    width: 34,
  },
  quick: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    left: 9,
    position: "absolute",
    top: 9,
    width: 34,
  },
  copy: { minHeight: 84, paddingHorizontal: 11, paddingTop: 10 },
  title: {
    color: storefrontDesign.semantic.foreground,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "right",
  },
  subtitle: {
    color: storefrontDesign.semantic.secondaryText,
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    marginTop: 2,
    textAlign: "right",
  },
  socialProof: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 3,
    marginTop: 5,
  },
  socialProofText: {
    color: storefrontDesign.semantic.brandStrong,
    fontFamily: "Cairo_700Bold",
    fontSize: 9,
  },
  footer: {
    alignItems: "center",
    borderTopColor: "#EFF1EE",
    borderTopWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 8,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  priceBlock: { flex: 1 },
  price: {
    color: storefrontDesign.semantic.brandStrong,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    textAlign: "right",
  },
  oldPrice: {
    color: storefrontDesign.primitive.mutedSoft,
    fontFamily: "Cairo_400Regular",
    fontSize: 9,
    marginTop: 1,
    textAlign: "right",
    textDecorationLine: "line-through",
  },
  buyButton: {
    alignItems: "center",
    backgroundColor: storefrontDesign.component.primaryButton.background,
    borderRadius: storefrontDesign.component.primaryButton.radius,
    flexDirection: "row-reverse",
    gap: 5,
    height: 36,
    justifyContent: "center",
  },
  buyButtonCompact: { marginRight: 8, width: 38 },
  buyButtonWide: { marginRight: 8, paddingHorizontal: 11 },
  buyText: {
    color: storefrontDesign.component.primaryButton.foreground,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 11,
  },
});
