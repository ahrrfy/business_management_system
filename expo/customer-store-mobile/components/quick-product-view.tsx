import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { useCart } from "@/lib/cart-context";
import { formatIqd, productDiscountPercent, storefrontDisplayPrice } from "@/lib/storefront-api";
import type { Product } from "@/shared/storefront";

export function QuickProductView({ product, onClose, onAddedToCart }: { product: Product | null; onClose: () => void; onAddedToCart?: () => void }) {
  const { addProduct } = useCart();
  const discount = product ? productDiscountPercent(product) : null;
  if (!product) return null;

  const addToCart = () => {
    addProduct(product);
    onClose();
    onAddedToCart?.();
  };

  return <Modal animationType="slide" transparent visible onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <Pressable accessibilityLabel="إغلاق العرض السريع" onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.topRow}>
          <TouchableOpacity accessibilityLabel="إغلاق" activeOpacity={0.8} onPress={onClose} style={styles.close}><MaterialIcons color="#315A50" name="close" size={21} /></TouchableOpacity>
          <Text style={styles.heading}>نظرة سريعة</Text>
          <View style={styles.close} />
        </View>
        <View style={styles.productRow}>
          <View style={[styles.visual, { backgroundColor: product.accent }]}>
            {product.imageUrl ? <Image cachePolicy="memory-disk" contentFit="contain" contentPosition="center" recyclingKey={product.imageUrl} source={product.imageUrl} style={styles.image} transition={140} /> : <MaterialIcons color="#0E806A" name={product.icon} size={58} />}
            {discount != null && <View style={styles.discount}><Text style={styles.discountText}>-{discount}%</Text></View>}
          </View>
          <View style={styles.copy}>
            <Text numberOfLines={2} style={styles.title}>{product.title}</Text>
            <Text numberOfLines={1} style={styles.subtitle}>{product.brand ?? product.subtitle}</Text>
            <Text style={styles.price}>{formatIqd(storefrontDisplayPrice(product))}</Text>
            {discount != null && <Text style={styles.oldPrice}>{formatIqd(product.price)}</Text>}
          </View>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity activeOpacity={0.88} onPress={addToCart} style={styles.add}><MaterialIcons color="#FFFFFF" name="add-shopping-cart" size={19} /><Text style={styles.addText}>أضف للسلة</Text></TouchableOpacity>
          <TouchableOpacity activeOpacity={0.82} onPress={() => { onClose(); router.push(`/product/${product.id}` as never); }} style={styles.details}><Text style={styles.detailsText}>التفاصيل</Text><MaterialIcons color="#0E806A" name="arrow-back" size={18} /></TouchableOpacity>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(24,61,54,0.34)", flex: 1, justifyContent: "flex-end" },
  sheet: { backgroundColor: "#FFF8F2", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingBottom: 30, paddingHorizontal: 18, paddingTop: 10 },
  handle: { alignSelf: "center", backgroundColor: "#DCCFC1", borderRadius: 3, height: 5, width: 42 },
  topRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 10 },
  close: { alignItems: "center", height: 38, justifyContent: "center", width: 38 }, heading: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 16 },
  productRow: { alignItems: "center", flexDirection: "row-reverse", gap: 14, marginTop: 12 },
  visual: { alignItems: "center", borderRadius: 18, height: 120, justifyContent: "center", overflow: "hidden", width: 120 }, image: { height: "100%", width: "100%" },
  discount: { backgroundColor: "#F05D53", borderRadius: 10, left: 8, paddingHorizontal: 7, paddingVertical: 4, position: "absolute", top: 8 }, discountText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 11 },
  copy: { flex: 1 }, title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 17, textAlign: "right" }, subtitle: { color: "#6D817A", fontFamily: "Cairo_400Regular", fontSize: 12, marginTop: 5, textAlign: "right" }, price: { color: "#0E806A", fontFamily: "Cairo_800ExtraBold", fontSize: 16, marginTop: 11, textAlign: "right" }, oldPrice: { color: "#9BA6A1", fontFamily: "Cairo_400Regular", fontSize: 11, marginTop: 2, textAlign: "right", textDecorationLine: "line-through" },
  actions: { flexDirection: "row-reverse", gap: 10, marginTop: 20 }, add: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 15, flex: 1, flexDirection: "row-reverse", gap: 7, height: 52, justifyContent: "center" }, addText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 14 }, details: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#0E806A", borderRadius: 15, borderWidth: 1, flexDirection: "row", gap: 5, height: 52, justifyContent: "center", paddingHorizontal: 15 }, detailsText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 13 },
});
