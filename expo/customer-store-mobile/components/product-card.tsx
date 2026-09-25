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
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
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
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
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
    backgroundColor: "#FFFFFF",
    borderColor: "#F1E5DA",
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 14,
    overflow: "hidden",
    shadowColor: "#183D36",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.04,
    shadowRadius: 14,
    elevation: 2,
  },
  gridCard: { width: "48.3%" },
  railCard: { marginLeft: 12, width: 236 },
  fullWidth: { width: "100%" },
  productTap: { flex: 1 },
  cover: {
    alignItems: "center",
    backgroundColor: "#FAF5EE",
    height: 160,
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
    padding: 8,
  },
  railCover: { height: 180 },
  productImage: { height: "100%", width: "100%" },
  discountBadge: {
    backgroundColor: "#F05D53",
    borderRadius: 999,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    position: "absolute",
    top: 8,
    shadowColor: "#F05D53",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 2,
  },
  discountText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9,
  },
  status: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.96)",
    borderColor: "#F1E5DA",
    borderRadius: 999,
    borderWidth: 1,
    bottom: 8,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    position: "absolute",
    right: 8,
  },
  statusDot: {
    backgroundColor: "#0E806A",
    borderRadius: 20,
    height: 5,
    width: 5,
  },
  statusText: {
    color: "#0E806A",
    fontFamily: "Cairo_700Bold",
    fontSize: 9,
  },
  specialOrder: { backgroundColor: "#FEF3C7", borderColor: "#FDE68A" },
  specialOrderDot: { backgroundColor: "#D97706" },
  specialOrderText: { color: "#92400E" },
  favorite: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.92)",
    borderColor: "#F1E5DA",
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    position: "absolute",
    right: 8,
    top: 8,
    width: 32,
    shadowColor: "#183D36",
    shadowOpacity: 0.04,
    shadowRadius: 4,
  },
  quick: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.92)",
    borderColor: "#F1E5DA",
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    position: "absolute",
    right: 44,
    top: 8,
    width: 32,
    shadowColor: "#183D36",
    shadowOpacity: 0.04,
    shadowRadius: 4,
  },
  copy: { minHeight: 80, paddingHorizontal: 12, paddingTop: 10 },
  title: {
    color: "#183D36",
    fontFamily: "Cairo_700Bold",
    fontSize: 12.5,
    lineHeight: 19,
    textAlign: "right",
  },
  subtitle: {
    color: "#5A6E68",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    marginTop: 2,
    textAlign: "right",
  },
  socialProof: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 3,
    marginTop: 4,
  },
  socialProofText: {
    color: "#D97706",
    fontFamily: "Cairo_700Bold",
    fontSize: 9,
  },
  footer: {
    alignItems: "center",
    borderTopColor: "#F4EDE4",
    borderTopWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  priceBlock: { flex: 1 },
  price: {
    color: "#0E806A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13.5,
    textAlign: "right",
  },
  oldPrice: {
    color: "#8C9E96",
    fontFamily: "Cairo_400Regular",
    fontSize: 9.5,
    marginTop: 1,
    textAlign: "right",
    textDecorationLine: "line-through",
  },
  buyButton: {
    alignItems: "center",
    backgroundColor: "#0E806A",
    borderRadius: 12,
    flexDirection: "row-reverse",
    gap: 4,
    height: 34,
    justifyContent: "center",
    shadowColor: "#0E806A",
    shadowOpacity: 0.20,
    shadowRadius: 4,
    elevation: 2,
  },
  buyButtonCompact: { marginRight: 6, width: 36 },
  buyButtonWide: { marginRight: 6, paddingHorizontal: 12 },
  buyText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
});
