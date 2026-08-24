import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, FlatList, Share, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";

import { ProductCard } from "@/components/product-card";
import { ScreenContainer } from "@/components/screen-container";
import { createStorefrontWishlistShare, storefrontWishlistShareUrl, useStorefrontCatalog } from "@/lib/storefront-api";
import { useWishlist } from "@/lib/wishlist-context";

export default function WishlistScreen() {
  const { ids, hydrated } = useWishlist();
  const { width } = useWindowDimensions();
  const columns = width >= 720 ? 2 : 1;
  const { products, loading } = useStorefrontCatalog(undefined, undefined, { limit: 100 });
  const [toastKey, setToastKey] = useState(0);
  const [creatingShare, setCreatingShare] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTranslate = useRef(new Animated.Value(-12)).current;
  const saved = products.filter((product) => ids.includes(String(product.id)));
  useEffect(() => {
    if (!toastKey) return;
    Animated.parallel([
      Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(toastTranslate, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(toastOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(toastTranslate, { toValue: -12, duration: 180, useNativeDriver: true }),
      ]).start(() => setToastKey(0));
    }, 2100);
    return () => clearTimeout(timer);
  }, [toastKey, toastOpacity, toastTranslate]);
  const shareWishlist = async () => {
    if (creatingShare) return;
    setCreatingShare(true);
    try {
      const productIds = saved.map((product) => Number(product.productId ?? product.id)).filter((productId) => Number.isInteger(productId) && productId > 0);
      const share = await createStorefrontWishlistShare(productIds);
      const deepLink = storefrontWishlistShareUrl(share.token);
      await Share.share({
        title: "قائمة رغبات من مكتبة العربية",
        message: `هذه قائمة رغبات مشتركة من مكتبة العربية. افتحها في تطبيق مكتبة العربية خلال 7 أيام:\n${deepLink}`,
      });
    } catch (error) {
      Alert.alert("تعذر إنشاء الرابط", error instanceof Error ? error.message : "تحقق من الاتصال ثم حاول مرة أخرى.");
    } finally {
      setCreatingShare(false);
    }
  };
  return <ScreenContainer className="flex-1" containerClassName="bg-background"><View style={styles.header}><TouchableOpacity accessibilityLabel="رجوع" onPress={() => router.back()} style={styles.back}><MaterialIcons color="#0E806A" name="arrow-forward" size={22}/></TouchableOpacity><View style={styles.headerCopy}><Text style={styles.title}>قائمة رغباتي</Text><Text style={styles.subtitle}>منتجات محفوظة للعودة إليها لاحقاً</Text></View>{saved.length > 0 && <TouchableOpacity accessibilityLabel="مشاركة قائمة الرغبات" disabled={creatingShare} onPress={() => void shareWishlist()} style={[styles.share, creatingShare && styles.shareDisabled]}>{creatingShare ? <ActivityIndicator color="#0E806A" size="small"/> : <MaterialIcons color="#0E806A" name="share" size={20}/>}</TouchableOpacity>}</View>{(!hydrated || loading) ? <View style={styles.loading}><ActivityIndicator color="#0E806A"/></View> : saved.length ? <FlatList contentContainerStyle={styles.grid} data={saved} key={`wishlist-grid-${columns}`} keyExtractor={(product) => String(product.id)} numColumns={columns} columnWrapperStyle={columns > 1 ? styles.gridRow : undefined} renderItem={({ item }) => <View style={[styles.gridItem, columns === 1 && styles.gridItemSingle]}><ProductCard fullWidth onAddedToCart={() => setToastKey(Date.now())} product={item} quickAddLabel /></View>}/> : <View style={styles.empty}><View style={styles.emptyIcon}><MaterialIcons color="#F05D53" name="favorite-border" size={32}/></View><Text style={styles.emptyTitle}>لا توجد منتجات محفوظة بعد</Text><Text style={styles.emptyCopy}>اضغط أيقونة القلب على أي منتج لحفظه هنا.</Text><TouchableOpacity onPress={() => router.replace("/" as never)} style={styles.cta}><Text style={styles.ctaText}>اكتشف المنتجات</Text></TouchableOpacity></View>}{Boolean(toastKey) && <Animated.View pointerEvents="none" style={[styles.toast, { opacity: toastOpacity, transform: [{ translateY: toastTranslate }] }]}><MaterialIcons color="#FFFFFF" name="check-circle" size={19}/><Text style={styles.toastText}>تمت إضافة المنتج إلى السلة</Text></Animated.View>}</ScreenContainer>;
}

const styles = StyleSheet.create({
  header: { alignItems: "center", flexDirection: "row-reverse", gap: 12, padding: 16 }, back: { alignItems: "center", backgroundColor: "#E8F5EF", borderRadius: 16, height: 44, justifyContent: "center", width: 44 }, headerCopy: { flex: 1 }, share: { alignItems: "center", backgroundColor: "#FFF3E8", borderRadius: 16, height: 44, justifyContent: "center", width: 44 }, shareDisabled: { opacity: 0.6 }, title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 21, textAlign: "right" }, subtitle: { color: "#708078", fontFamily: "Cairo_400Regular", fontSize: 11, marginTop: 2, textAlign: "right" }, grid: { paddingHorizontal: 16, paddingBottom: 30 }, gridRow: { justifyContent: "space-between" }, gridItem: { width: "48.5%" }, gridItemSingle: { width: "100%" }, loading: { alignItems: "center", flex: 1, justifyContent: "center" }, empty: { alignItems: "center", flex: 1, justifyContent: "center", padding: 32 }, emptyIcon: { alignItems: "center", backgroundColor: "#FFF0F0", borderRadius: 28, height: 58, justifyContent: "center", width: 58 }, emptyTitle: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 17, marginTop: 16 }, emptyCopy: { color: "#708078", fontFamily: "Cairo_400Regular", fontSize: 12, marginTop: 6, textAlign: "center" }, cta: { backgroundColor: "#0E806A", borderRadius: 18, marginTop: 20, paddingHorizontal: 22, paddingVertical: 11 }, ctaText: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 13 }, toast: { alignItems: "center", alignSelf: "center", backgroundColor: "#0E806A", borderRadius: 18, bottom: 24, elevation: 6, flexDirection: "row-reverse", gap: 7, paddingHorizontal: 15, paddingVertical: 10, position: "absolute", shadowColor: "#173A33", shadowOpacity: 0.2, shadowRadius: 10 }, toastText: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 12 },
});
