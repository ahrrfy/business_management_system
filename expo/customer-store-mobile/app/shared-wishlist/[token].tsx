import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { ProductCard } from "@/components/product-card";
import { ScreenContainer } from "@/components/screen-container";
import { getStorefrontWishlistShare } from "@/lib/storefront-api";
import type { Product } from "@/shared/storefront";

// المُولِّد الخادميّ = randomBytes(18).toString("base64url") ⇒ ٢٤ محرفاً بالضبط.
// نرفض قبل الطلب الخادميّ ما لا يطابق الشكل ⇒ لا تُدفَع محاولات تخمينٍ نحو الشبكة.
const WISHLIST_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export default function SharedWishlistScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = rawToken && WISHLIST_SHARE_TOKEN_PATTERN.test(rawToken) ? rawToken : null;
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!token) {
      setError("رابط قائمة الرغبات غير صالح.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getStorefrontWishlistShare(token)
      .then((share) => { if (active) setProducts(share.products); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "تعذر تحميل القائمة المشتركة."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  return <ScreenContainer className="flex-1" containerClassName="bg-background"><View style={styles.header}><TouchableOpacity accessibilityLabel="رجوع" onPress={() => router.back()} style={styles.back}><MaterialIcons color="#0E806A" name="arrow-forward" size={22}/></TouchableOpacity><View style={styles.headerCopy}><Text style={styles.title}>قائمة رغبات مشتركة</Text><Text style={styles.subtitle}>الأسعار والتوفر المعروضان الآن من الكتالوج الحي</Text></View></View>{loading ? <View style={styles.center}><ActivityIndicator color="#0E806A" size="large"/><Text style={styles.loadingText}>نجهّز المنتجات المشتركة…</Text></View> : error ? <View style={styles.center}><View style={styles.errorIcon}><MaterialIcons color="#F05D53" name="link-off" size={30}/></View><Text style={styles.emptyTitle}>تعذر فتح القائمة</Text><Text style={styles.emptyCopy}>{error}</Text><TouchableOpacity onPress={() => router.replace("/" as never)} style={styles.cta}><Text style={styles.ctaText}>اكتشف المنتجات</Text></TouchableOpacity></View> : products.length ? <FlatList contentContainerStyle={styles.grid} data={products} keyExtractor={(product) => String(product.id)} numColumns={2} renderItem={({ item }) => <ProductCard product={item} quickAddLabel />}/> : <View style={styles.center}><View style={styles.errorIcon}><MaterialIcons color="#F3B85A" name="inventory-2" size={30}/></View><Text style={styles.emptyTitle}>لم تعد هذه المنتجات متاحة</Text><Text style={styles.emptyCopy}>ربما تغيّر الكتالوج بعد مشاركة الرابط. استكشف أحدث المنتجات من المتجر.</Text><TouchableOpacity onPress={() => router.replace("/" as never)} style={styles.cta}><Text style={styles.ctaText}>اكتشف المنتجات</Text></TouchableOpacity></View>}</ScreenContainer>;
}

const styles = StyleSheet.create({
  header: { alignItems: "center", flexDirection: "row-reverse", gap: 12, padding: 16 },
  back: { alignItems: "center", backgroundColor: "#E8F5EF", borderRadius: 16, height: 44, justifyContent: "center", width: 44 },
  headerCopy: { flex: 1 },
  title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 21, textAlign: "right" },
  subtitle: { color: "#708078", fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 18, marginTop: 2, textAlign: "right" },
  grid: { paddingHorizontal: 16, paddingBottom: 30, justifyContent: "space-between" },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: 32 },
  loadingText: { color: "#708078", fontFamily: "Cairo_600SemiBold", fontSize: 12, marginTop: 12 },
  errorIcon: { alignItems: "center", backgroundColor: "#FFF3E8", borderRadius: 28, height: 58, justifyContent: "center", width: 58 },
  emptyTitle: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 17, marginTop: 16, textAlign: "center" },
  emptyCopy: { color: "#708078", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, marginTop: 6, textAlign: "center" },
  cta: { backgroundColor: "#0E806A", borderRadius: 18, marginTop: 20, paddingHorizontal: 22, paddingVertical: 11 },
  ctaText: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 13 },
});
