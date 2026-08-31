import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { AnimatedEntrance } from "@/components/animated-entrance";
import { formatIqd, productDiscountPercent, storefrontDisplayPrice } from "@/lib/storefront-api";
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

export function ProductCard({ product, variant = "grid", fullWidth = false, quickAddLabel = false, onQuickView, animationDelay = 0 }: ProductCardProps) {
  const { isSaved, toggle } = useWishlist();
  const discount = productDiscountPercent(product);
  const chooseOptions = () => router.push(`/product/${product.id}` as never);

  return (
    <AnimatedEntrance delay={animationDelay} style={[styles.card, variant === "rail" && styles.railCard, fullWidth && styles.fullWidth]}>
      <View style={styles.cardInner}>
        <TouchableOpacity accessibilityLabel={`عرض ${product.title}`} activeOpacity={0.86} onPress={() => router.push(`/product/${product.id}` as never)} style={styles.productTap}>
          <View style={styles.cover}>
            {product.imageUrl ? <Image cachePolicy="memory-disk" contentFit="contain" contentPosition="center" priority="high" recyclingKey={product.imageUrl} source={product.imageUrl} style={styles.productImage} transition={140} /> : <MaterialIcons color="#0F5A4A" name={product.icon} size={46} />}
            <View style={[styles.availability, product.isCustomizable && styles.specialOrder]}><MaterialIcons color={product.isCustomizable ? "#8A5A15" : "#0E806A"} name={product.isCustomizable ? "info-outline" : "check-circle"} size={13} /><Text style={[styles.availabilityText, product.isCustomizable && styles.specialOrderText]}>{product.isCustomizable ? "طلب خاص" : product.availability}</Text></View>
            {discount != null && <View style={styles.discountBadge}><Text style={styles.discountText}>-{discount}%</Text></View>}
          </View>
          <View style={styles.copy}>
            <Text numberOfLines={2} style={styles.title}>{product.title}</Text>
            <Text numberOfLines={1} style={styles.subtitle}>{product.brand ?? product.subtitle}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity accessibilityLabel={`${isSaved(product.id) ? "إزالة" : "حفظ"} ${product.title} من المفضلة`} activeOpacity={0.86} onPress={() => toggle(product.id)} style={styles.favorite}>
          <MaterialIcons color={isSaved(product.id) ? "#F05D53" : "#0E806A"} name={isSaved(product.id) ? "favorite" : "favorite-border"} size={20} />
        </TouchableOpacity>
        {onQuickView && <TouchableOpacity accessibilityLabel={`عرض سريع ${product.title}`} activeOpacity={0.86} onPress={() => onQuickView(product)} style={styles.quick}><MaterialIcons color="#0E806A" name="visibility" size={19} /></TouchableOpacity>}
        <View style={styles.cardFooter}>
          <View style={styles.priceBlock}>
            <Text style={styles.price}>{formatIqd(storefrontDisplayPrice(product))}</Text>
            {discount != null && <Text style={styles.oldPrice}>{formatIqd(product.price)}</Text>}
          </View>
          <TouchableOpacity accessibilityHint={product.isCustomizable ? "يفتح تفاصيل المنتج وحالة توفر الطلب" : "يفتح صفحة اختيار البديل ووحدة البيع قبل الإضافة"} accessibilityLabel={product.isCustomizable ? `عرض تفاصيل ${product.title}، غير متاح للطلب الإلكتروني مؤقتاً` : `اختر خيارات ${product.title}`} accessibilityRole="button" activeOpacity={0.82} onPress={chooseOptions} style={[styles.addButton, styles.addButtonLabeled]}>
            <MaterialIcons color="#FFFFFF" name={product.isCustomizable ? "info-outline" : "tune"} size={18} />{quickAddLabel && <Text style={styles.addLabel}>{product.isCustomizable ? "التفاصيل" : "اختيار"}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </AnimatedEntrance>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 24, borderWidth: 1, elevation: 2, marginBottom: 16, overflow: "hidden", shadowColor: "#173A33", shadowOpacity: 0.06, shadowRadius: 9, width: "100%" },
  railCard: { marginLeft: 12, marginBottom: 4, width: 206 },
  fullWidth: { width: "100%" },
  cardInner: { minHeight: 312, padding: 11, position: "relative" },
  productTap: { flex: 1 },
  cover: { alignItems: "center", backgroundColor: "#FFFDFC", borderColor: "#F0E8DF", borderRadius: 17, borderWidth: 1, height: 190, justifyContent: "center", overflow: "hidden" },
  productImage: { height: "100%", width: "100%" },
  availability: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#E2EEE7", borderRadius: 12, borderWidth: 1, bottom: 9, flexDirection: "row-reverse", gap: 4, paddingHorizontal: 8, paddingVertical: 4, position: "absolute", right: 9 },
  availabilityText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 10 },
  specialOrder: { backgroundColor: "#FFF7E8", borderColor: "#EBD4A8" },
  specialOrderText: { color: "#8A5A15" },
  discountBadge: { backgroundColor: "#F05D53", borderRadius: 10, left: 9, paddingHorizontal: 8, paddingVertical: 4, position: "absolute", top: 9 },
  discountText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 11 },
  favorite: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#E6E9E6", borderRadius: 16, borderWidth: 1, elevation: 2, height: 34, justifyContent: "center", position: "absolute", right: 19, top: 19, width: 34 },
  quick: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#E6E9E6", borderRadius: 16, borderWidth: 1, elevation: 2, height: 34, justifyContent: "center", left: 19, position: "absolute", top: 19, width: 34 },
  copy: { minHeight: 68, paddingHorizontal: 2, paddingTop: 12 },
  title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 16, lineHeight: 24, textAlign: "right" },
  subtitle: { color: "#6D817A", fontFamily: "Cairo_400Regular", fontSize: 11, marginTop: 3, textAlign: "right" },
  cardFooter: { alignItems: "center", borderTopColor: "#F3ECE5", borderTopWidth: 1, flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 5, paddingTop: 10 },
  priceBlock: { flex: 1 },
  price: { color: "#0E806A", fontFamily: "Cairo_800ExtraBold", fontSize: 16, textAlign: "right" },
  oldPrice: { color: "#95A29D", fontFamily: "Cairo_400Regular", fontSize: 10, marginTop: 1, textAlign: "right", textDecorationLine: "line-through" },
  addButton: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 17, height: 38, justifyContent: "center", minWidth: 42, paddingHorizontal: 10 },
  addButtonAdded: { flexDirection: "row-reverse", gap: 4, minWidth: 61 },
  addButtonLabeled: { flexDirection: "row-reverse", gap: 5, width: "auto" },
  addLabel: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 10 },
  quantity: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 14 },
});
