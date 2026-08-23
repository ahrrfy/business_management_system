import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { AnimatedEntrance } from "@/components/animated-entrance";
import { useCart } from "@/lib/cart-context";
import { formatIqd, formatLatinNumber, productDiscountPercent, storefrontDisplayPrice } from "@/lib/storefront-api";
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

export function ProductCard({ product, variant = "grid", fullWidth = false, quickAddLabel = false, onQuickView, onAddedToCart, animationDelay = 0 }: ProductCardProps) {
  const { addProduct, quantityFor } = useCart();
  const { isSaved, toggle } = useWishlist();
  const [justAdded, setJustAdded] = useState(false);
  const quantity = quantityFor(product.id);
  const discount = productDiscountPercent(product);

  useEffect(() => {
    if (!justAdded) return;
    const timer = setTimeout(() => setJustAdded(false), 760);
    return () => clearTimeout(timer);
  }, [justAdded]);

  const add = () => {
    addProduct(product);
    setJustAdded(true);
    onAddedToCart?.();
  };

  return (
    <AnimatedEntrance delay={animationDelay} style={[styles.card, variant === "rail" && styles.railCard, fullWidth && styles.fullWidth]}>
      <View style={styles.cardInner}>
        <TouchableOpacity accessibilityLabel={`عرض ${product.title}`} activeOpacity={0.86} onPress={() => router.push(`/product/${product.id}` as never)} style={styles.productTap}>
          <View style={styles.cover}>
            {product.imageUrl ? <Image cachePolicy="memory-disk" contentFit="contain" contentPosition="center" priority="high" recyclingKey={product.imageUrl} source={product.imageUrl} style={styles.productImage} transition={140} /> : <MaterialIcons color="#0F5A4A" name={product.icon} size={46} />}
            <View style={styles.availability}><MaterialIcons color="#0E806A" name="check-circle" size={13} /><Text style={styles.availabilityText}>{product.availability}</Text></View>
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
          <TouchableOpacity accessibilityLabel={`إضافة ${product.title} إلى السلة. الكمية الحالية ${formatLatinNumber(quantity)}`} activeOpacity={0.82} onPress={add} style={[styles.addButton, quantity > 0 && styles.addButtonAdded, quickAddLabel && styles.addButtonLabeled]}>
            {justAdded ? <><MaterialIcons color="#FFFFFF" name="check" size={19} /><Text style={styles.addLabel}>تمت الإضافة</Text></> : quantity > 0 ? <><Text style={styles.quantity}>{formatLatinNumber(quantity)}</Text><MaterialIcons color="#FFFFFF" name="add" size={19} /></> : quickAddLabel ? <><MaterialIcons color="#FFFFFF" name="add-shopping-cart" size={18} /><Text style={styles.addLabel}>إضافة</Text></> : <MaterialIcons color="#FFFFFF" name="add" size={22} />}
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
