import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";

import { ProductCard } from "@/components/product-card";
import { ScreenContainer } from "@/components/screen-container";
import {
  formatLatinNumber,
  useStorefrontCatalog,
  useStorefrontCategories,
  useStorefrontSettings,
} from "@/lib/storefront-api";

export default function CategoriesScreen() {
  const { category } = useLocalSearchParams<{ category?: string }>();
  const settings = useStorefrontSettings();
  const { width } = useWindowDimensions();
  const columns = width >= 720 ? 2 : 1;
  const selectedId = Number(category);
  const selected =
    Number.isFinite(selectedId) && selectedId > 0 ? selectedId : null;
  const { categories, loading: categoriesLoading } = useStorefrontCategories();
  const { products, loading, error, hasMore, loadMore, loadingMore, refresh } =
    useStorefrontCatalog(selected ?? undefined, undefined, { limit: 16 });
  const selectedName = useMemo(
    () => categories.find((item) => item.id === selected)?.name,
    [categories, selected],
  );

  const openWhatsAppPrinting = async () => {
    const rawNumber = settings?.whatsappNumber?.replace(/\D/g, "") || "";
    if (!rawNumber) {
      Alert.alert(
        "تواصل معنا",
        "يمكنك التواصل مع خدمة الزبائن للاستفسار عن خدمات الطباعة والكميات.",
      );
      return;
    }
    const message = `مرحباً مكتبة العربية، أود الاستفسار عن خدمات الطباعة أو طلب خاص لقسم: ${selectedName ?? "العام"}.`;
    const url = `https://wa.me/${rawNumber}?text=${encodeURIComponent(message)}`;
    try {
      const can = await Linking.canOpenURL(url);
      if (can) await Linking.openURL(url);
      else Alert.alert("واتساب", "تأكد من وجود تطبيق واتساب على جهازك للتواصل المباشر.");
    } catch {
      Alert.alert("واتساب", "تعذر فتح تطبيق واتساب حالياً.");
    }
  };
  const setCategory = (id: number | null) =>
    router.replace(
      id == null
        ? ("/categories" as never)
        : (`/categories?category=${id}` as never),
    );
  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <FlatList
        data={products}
        numColumns={columns}
        key={`catalog-grid-${columns}`}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        columnWrapperStyle={
          columns > 1 && products.length ? styles.gridRow : undefined
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.45}
        renderItem={({ item }) => (
          <View
            style={[styles.gridItem, columns === 1 && styles.gridItemSingle]}
          >
            <ProductCard fullWidth product={item} />
          </View>
        )}
        ListHeaderComponent={
          <>
            <View style={styles.header}>
              <View>
                <Text style={styles.overline}>تصفّح واكتشف</Text>
                <Text style={styles.title}>
                  {selectedName ?? "كل المنتجات"}
                </Text>
                <Text style={styles.subtitle}>
                  انتقل بين الأقسام أو ابحث عن احتياج محدد
                </Text>
              </View>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => router.push("/search" as never)}
                style={styles.searchButton}
              >
                <MaterialIcons color="#075345" name="search" size={22} />
              </TouchableOpacity>
            </View>
            <ScrollView
              contentContainerStyle={styles.filters}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setCategory(null)}
                style={[styles.filter, selected == null && styles.active]}
              >
                <Text
                  style={[
                    styles.filterText,
                    selected == null && styles.activeText,
                  ]}
                >
                  الكل
                </Text>
              </TouchableOpacity>
              {categories.map((item) => (
                <TouchableOpacity
                  activeOpacity={0.85}
                  key={item.id}
                  onPress={() => setCategory(item.id)}
                  style={[styles.filter, selected === item.id && styles.active]}
                >
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.filterText,
                      selected === item.id && styles.activeText,
                    ]}
                  >
                    {item.name}
                  </Text>
                  <Text
                    style={[
                      styles.filterCount,
                      selected === item.id && styles.activeText,
                    ]}
                  >
                    {formatLatinNumber(item.availableCount)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {categoriesLoading && (
              <Text style={styles.loadingCategories}>جار تحديث الأقسام…</Text>
            )}
            {/* بطاقة خدمات الطباعة والتجهيز عبر واتساب */}
            <TouchableOpacity
              accessibilityLabel="طلب طباعة خاصة أو تجهيز كميات عبر واتساب"
              accessibilityRole="button"
              activeOpacity={0.88}
              onPress={openWhatsAppPrinting}
              style={styles.whatsappCategoryBanner}
            >
              <View style={styles.whatsappCategoryRight}>
                <View style={styles.whatsappCategoryIcon}>
                  <MaterialIcons color="#FFFFFF" name="print" size={20} />
                </View>
                <View style={styles.whatsappCategoryText}>
                  <Text style={styles.whatsappCategoryTitle}>
                    هل تحتاج طباعة خاصة أو تجهيز كميات؟
                  </Text>
                  <Text style={styles.whatsappCategorySub}>
                    تواصل مع مطبعة ومكتبة العربية مباشرة عبر واتساب
                  </Text>
                </View>
              </View>
              <View style={styles.whatsappCategoryBadge}>
                <MaterialIcons color="#157347" name="chat" size={15} />
                <Text style={styles.whatsappCategoryBadgeText}>واتساب</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.catalogHeader}>
              <Text style={styles.catalogTitle}>
                {selectedName ? `منتجات ${selectedName}` : "المنتجات المتاحة"}
              </Text>
              <Text style={styles.catalogCount}>
                {loading ? "…" : `${formatLatinNumber(products.length)} منتج`}
              </Text>
            </View>
          </>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.state}>
              <ActivityIndicator color="#0E806A" />
              <Text style={styles.stateText}>جار تحميل المنتجات…</Text>
            </View>
          ) : error ? (
            <View accessibilityRole="alert" style={styles.state}>
              <MaterialIcons color="#F05D53" name="cloud-off" size={28} />
              <Text style={styles.stateTitle}>تعذر تحميل المنتجات</Text>
              <Text style={styles.stateText}>{error}</Text>
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.85}
                onPress={refresh}
                style={styles.retry}
              >
                <Text style={styles.retryText}>إعادة المحاولة</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.state}>
              <MaterialIcons color="#6D817A" name="inventory-2" size={28} />
              <Text style={styles.stateTitle}>لا توجد منتجات الآن</Text>
              <Text style={styles.stateText}>
                جرّب قسماً آخر أو استخدم البحث للوصول إلى ما تريده.
              </Text>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => router.push("/search" as never)}
                style={styles.retry}
              >
                <Text style={styles.retryText}>فتح البحث</Text>
              </TouchableOpacity>
            </View>
          )
        }
        ListFooterComponent={
          products.length > 0 ? (
            <View style={styles.footer}>
              {loadingMore ? (
                <ActivityIndicator
                  accessibilityLabel="جار تحميل منتجات إضافية"
                  color="#0E806A"
                />
              ) : hasMore ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={loadMore}
                  style={styles.retry}
                >
                  <Text style={styles.retryText}>تحميل المزيد</Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.endText}>
                  وصلت إلى نهاية المنتجات المتاحة.
                </Text>
              )}
              {error && !loading && (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={loadMore}
                  style={styles.retry}
                >
                  <Text style={styles.retryText}>
                    إعادة تحميل الصفحة التالية
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 34 },
  header: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  overline: {
    color: "#08755F",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9,
    textAlign: "right",
  },
  title: {
    color: "#112A25",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 25,
    lineHeight: 37,
    textAlign: "right",
  },
  subtitle: {
    color: "#6D7F79",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    marginTop: 1,
    textAlign: "right",
  },
  searchButton: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E4E9E4",
    borderRadius: 16,
    borderWidth: 1,
    elevation: 2,
    height: 46,
    justifyContent: "center",
    shadowColor: "#173A33",
    shadowOpacity: 0.06,
    shadowRadius: 9,
    width: 46,
  },
  filters: {
    gap: 8,
    marginHorizontal: -16,
    marginTop: 20,
    paddingHorizontal: 16,
  },
  filter: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E4E9E4",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 5,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  active: { backgroundColor: "#075345", borderColor: "#075345" },
  filterText: { color: "#38534C", fontFamily: "Cairo_700Bold", fontSize: 11 },
  activeText: { color: "#FFFFFF" },
  filterCount: {
    color: "#779088",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 9,
  },
  loadingCategories: {
    color: "#6D817A",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
    marginTop: 8,
    textAlign: "right",
  },
  catalogHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 15,
    marginTop: 25,
  },
  catalogTitle: {
    color: "#112A25",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
  },
  catalogCount: {
    backgroundColor: "#E6F4EE",
    borderRadius: 999,
    color: "#075345",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10,
    overflow: "hidden",
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  gridRow: { justifyContent: "space-between" },
  gridItem: { width: "48.5%" },
  gridItemSingle: { width: "100%" },
  state: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E4E9E4",
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 18,
    padding: 28,
  },
  stateTitle: {
    color: "#112A25",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 15,
    marginTop: 10,
  },
  stateText: {
    color: "#6D7F79",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 19,
    marginTop: 7,
    textAlign: "center",
  },
  retry: {
    backgroundColor: "#E6F4EE",
    borderRadius: 13,
    marginTop: 14,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  retryText: {
    color: "#075345",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 11,
  },
  footer: { alignItems: "center", minHeight: 72, paddingVertical: 14 },
  endText: { color: "#71817B", fontFamily: "Cairo_600SemiBold", fontSize: 10 },
  whatsappCategoryBanner: {
    backgroundColor: "#F2FBF6",
    borderColor: "#C5EBD6",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    marginBottom: 14,
    gap: 10,
  },
  whatsappCategoryRight: {
    flexDirection: "row-reverse",
    alignItems: "center",
    flex: 1,
    gap: 10,
  },
  whatsappCategoryIcon: {
    backgroundColor: "#0E806A",
    borderRadius: 12,
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  whatsappCategoryText: {
    flex: 1,
  },
  whatsappCategoryTitle: {
    color: "#161A22",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
    textAlign: "right",
  },
  whatsappCategorySub: {
    color: "#4F685D",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    marginTop: 1,
    textAlign: "right",
  },
  whatsappCategoryBadge: {
    backgroundColor: "#E4F7EC",
    borderRadius: 10,
    flexDirection: "row-reverse",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 4,
  },
  whatsappCategoryBadgeText: {
    color: "#157347",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
});
