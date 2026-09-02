import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useCart } from "@/lib/cart-context";
import { selectionDescription } from "@/lib/product-selection";
import { formatIqd } from "@/lib/storefront-api";

export function SideCart({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { lines, itemCount, increment, decrement, remove } = useCart();
  const [mounted, setMounted] = useState(visible);
  const insets = useSafeAreaInsets();
  const translateX = useRef(new Animated.Value(380)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const subtotal = lines.reduce((sum, line) => sum + (Number(line.selectionDetails.unitSalePrice ?? line.selectionDetails.unitPrice ?? 0) || 0) * line.quantity, 0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      requestAnimationFrame(() => Animated.parallel([
        Animated.timing(translateX, { toValue: 0, duration: 270, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start());
      return;
    }
    if (!mounted) return;
    Animated.parallel([
      Animated.timing(translateX, { toValue: 380, duration: 190, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 170, useNativeDriver: true }),
    ]).start(() => setMounted(false));
  }, [mounted, opacity, translateX, visible]);

  if (!mounted) return null;
  const checkout = () => { onClose(); router.push("/checkout" as never); };

  return <Modal animationType="none" onRequestClose={onClose} statusBarTranslucent transparent visible>
    <View style={styles.layer}>
      <Animated.View style={[styles.backdrop, { opacity }]}><Pressable accessibilityLabel="إغلاق السلة" onPress={onClose} style={StyleSheet.absoluteFill} /></Animated.View>
      <Animated.View style={[styles.drawer, { paddingBottom: Math.max(insets.bottom, 12), paddingTop: Math.max(insets.top, 14), transform: [{ translateX }] }]}>
        <View style={styles.handle} />
        <View style={styles.top}><TouchableOpacity accessibilityLabel="إغلاق السلة" activeOpacity={0.8} onPress={onClose} style={styles.icon}><MaterialIcons color="#315A50" name="close" size={21} /></TouchableOpacity><View><Text style={styles.title}>سلتك الآن</Text><Text style={styles.count}>{itemCount} منتج بانتظارك</Text></View><View style={styles.icon}><MaterialIcons color="#0E806A" name="shopping-bag" size={21} /></View></View>
        {lines.length ? <ScrollView contentContainerStyle={styles.lines} showsVerticalScrollIndicator={false}>{lines.map((line) => <View key={line.lineId} style={styles.line}><View style={styles.lineCopy}><Text numberOfLines={1} style={styles.lineTitle}>{line.product.title}</Text><Text numberOfLines={2} style={styles.lineSelection}>{selectionDescription(line.selectionDetails)}</Text><Text style={styles.linePrice}>{formatIqd(line.selectionDetails.unitSalePrice ?? line.selectionDetails.unitPrice)}</Text></View><View style={styles.quantity}><TouchableOpacity accessibilityLabel={`إنقاص ${line.product.title}`} accessibilityRole="button" activeOpacity={0.8} onPress={() => decrement(line.lineId)} style={styles.quantityButton}><MaterialIcons color="#0E806A" name="remove" size={16} /></TouchableOpacity><Text style={styles.quantityText}>{line.quantity}</Text><TouchableOpacity accessibilityLabel={`زيادة ${line.product.title}`} accessibilityRole="button" accessibilityState={{ disabled: line.quantity >= line.maxQuantity }} activeOpacity={0.8} disabled={line.quantity >= line.maxQuantity} onPress={() => increment(line.lineId)} style={[styles.quantityButton, line.quantity >= line.maxQuantity && styles.disabledQuantity]}><MaterialIcons color="#0E806A" name="add" size={16} /></TouchableOpacity></View><TouchableOpacity accessibilityLabel={`حذف ${line.product.title}`} accessibilityRole="button" activeOpacity={0.8} onPress={() => remove(line.lineId)} style={styles.remove}><MaterialIcons color="#A25A50" name="close" size={15} /></TouchableOpacity></View>)}</ScrollView> : <View style={styles.empty}><MaterialIcons color="#9AB7AC" name="shopping-basket" size={40} /><Text style={styles.emptyTitle}>السلة فارغة حالياً</Text><Text style={styles.emptyHint}>أضف ما يعجبك وستظهر هنا فوراً.</Text></View>}
        <View style={styles.bottom}><View style={styles.totalRow}><Text style={styles.total}>الإجمالي المبدئي</Text><Text style={styles.totalPrice}>{formatIqd(subtotal)}</Text></View><TouchableOpacity activeOpacity={0.9} disabled={!lines.length} onPress={checkout} style={[styles.checkout, !lines.length && styles.disabled]}><Text style={styles.checkoutText}>مراجعة الطلب والدفع</Text><MaterialIcons color="#FFFFFF" name="arrow-back" size={19} /></TouchableOpacity><TouchableOpacity activeOpacity={0.8} onPress={onClose} style={styles.continue}><Text style={styles.continueText}>متابعة التسوق</Text></TouchableOpacity></View>
      </Animated.View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  layer: { flex: 1 }, backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(24,61,54,0.28)" }, drawer: { alignSelf: "flex-end", backgroundColor: "#FFF8F2", borderBottomLeftRadius: 28, borderTopLeftRadius: 28, flex: 1, maxWidth: 430, paddingHorizontal: 18, width: "92%" }, handle: { alignSelf: "center", backgroundColor: "#DDCEC1", borderRadius: 3, height: 5, width: 42 }, top: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 18 }, icon: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 14, borderWidth: 1, height: 42, justifyContent: "center", width: 42 }, title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 18, textAlign: "center" }, count: { color: "#708078", fontFamily: "Cairo_600SemiBold", fontSize: 10, marginTop: 2, textAlign: "center" }, lines: { flexGrow: 1, paddingBottom: 12, paddingTop: 22 }, line: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 17, borderWidth: 1, flexDirection: "row-reverse", gap: 8, marginBottom: 10, padding: 10 }, lineCopy: { flex: 1 }, lineTitle: { color: "#183D36", fontFamily: "Cairo_700Bold", fontSize: 12, textAlign: "right" }, lineSelection: { color: "#6D817A", fontFamily: "Cairo_400Regular", fontSize: 9, marginTop: 2, textAlign: "right" }, linePrice: { color: "#0E806A", fontFamily: "Cairo_800ExtraBold", fontSize: 11, marginTop: 4, textAlign: "right" }, quantity: { alignItems: "center", backgroundColor: "#E8F5EF", borderRadius: 12, flexDirection: "row-reverse", gap: 5, padding: 4 }, quantityButton: { alignItems: "center", height: 22, justifyContent: "center", width: 22 }, disabledQuantity: { opacity: 0.35 }, quantityText: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 12, minWidth: 14, textAlign: "center" }, remove: { alignItems: "center", backgroundColor: "#FFF0EC", borderRadius: 10, height: 25, justifyContent: "center", width: 25 }, empty: { alignItems: "center", flex: 1, justifyContent: "center", paddingBottom: 100 }, emptyTitle: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 16, marginTop: 12 }, emptyHint: { color: "#708078", fontFamily: "Cairo_400Regular", fontSize: 12, marginTop: 5 }, bottom: { borderTopColor: "#EEE3D7", borderTopWidth: 1, paddingTop: 16 }, totalRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", marginBottom: 13 }, total: { color: "#526A61", fontFamily: "Cairo_600SemiBold", fontSize: 12 }, totalPrice: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 17 }, checkout: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 16, flexDirection: "row", gap: 8, height: 54, justifyContent: "center" }, disabled: { backgroundColor: "#AAB8B2" }, checkoutText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 14 }, continue: { alignItems: "center", marginTop: 8, paddingVertical: 7 }, continueText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 12 },
});
