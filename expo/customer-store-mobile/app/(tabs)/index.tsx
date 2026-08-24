import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { MarketingCarousel } from "@/components/marketing-carousel";
import { ProductCard } from "@/components/product-card";
import { QuickProductView } from "@/components/quick-product-view";
import { ScreenContainer } from "@/components/screen-container";
import { SideCart } from "@/components/side-cart";
import { useCart } from "@/lib/cart-context";
import { catalogDisplayState, formatIqd, formatLatinNumber, productDiscountPercent, useStorefrontCatalog, useStorefrontCategories, useStorefrontMarketing, type StorefrontBanner } from "@/lib/storefront-api";
import type { Product } from "@/shared/storefront";

const RECENT_SEARCHES_KEY = "@al_arabiya/recent-searches-v1";

function routeFromBanner(banner: StorefrontBanner | null) {
  const url = banner?.ctaUrl ?? "";
  const categoryMatch = url.match(/[?&]category(?:Id)?=(\d+)/i);
  if (categoryMatch) return `/categories?category=${categoryMatch[1]}` as never;
  const queryMatch = url.match(/[?&](?:search|q)=([^&]+)/i);
  if (queryMatch) return `/search?query=${encodeURIComponent(decodeURIComponent(queryMatch[1]))}` as never;
  return "/categories" as never;
}

export default function HomeScreen() {
  const { itemCount } = useCart();
  const { products, loading, error, refresh } = useStorefrontCatalog(undefined, undefined, { limit: 8 });
  const { categories } = useStorefrontCategories();
  const [loadMarketing, setLoadMarketing] = useState(false);
  const { banners, offers } = useStorefrontMarketing(loadMarketing);
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [quickProduct, setQuickProduct] = useState<Product | null>(null);
  const [sideCartVisible, setSideCartVisible] = useState(false);
  const [homeCategoryId, setHomeCategoryId] = useState<string | null>(null);
  const [homeSort, setHomeSort] = useState<"POPULAR" | "PRICE_ASC" | "PRICE_DESC">("POPULAR");
  const saleProducts = useMemo(() => products.filter((product) => productDiscountPercent(product) != null), [products]);
  const homeProducts = useMemo(() => {
    const filtered = homeCategoryId ? products.filter((product) => product.categoryId === homeCategoryId) : products;
    return [...filtered].sort((left, right) => {
      if (homeSort === "PRICE_ASC") return Number(left.salePrice ?? left.price ?? 0) - Number(right.salePrice ?? right.price ?? 0);
      if (homeSort === "PRICE_DESC") return Number(right.salePrice ?? right.price ?? 0) - Number(left.salePrice ?? left.price ?? 0);
      return (right.soldCount ?? 0) - (left.soldCount ?? 0);
    });
  }, [homeCategoryId, homeSort, products]);
  const catalogState = catalogDisplayState(homeProducts, loading, error);
  const newProducts = products.slice(0, 6);
  const quickMatches = useMemo(() => {
    const clean = debouncedQuery.trim().toLocaleLowerCase("ar");
    if (clean.length < 2) return [];
    return products.filter((product) => `${product.title} ${product.subtitle} ${product.brand ?? ""}`.toLocaleLowerCase("ar").includes(clean)).slice(0, 4);
  }, [debouncedQuery, products]);
  useEffect(() => {
    const timer = setTimeout(() => setLoadMarketing(true), 900);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const clean = query.trim();
    if (clean.length < 2) {
      setSearchLoading(false);
      setDebouncedQuery(clean);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      setDebouncedQuery(clean);
      setSearchLoading(false);
    }, 240);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    void AsyncStorage.getItem(RECENT_SEARCHES_KEY).then((raw) => {
      const values = raw ? JSON.parse(raw) : [];
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) setRecentSearches(values.slice(0, 6));
    }).catch(() => undefined);
  }, []);
  const rememberSearch = (value: string) => {
    const clean = value.trim().replace(/\s+/g, " ");
    if (!clean) return;
    const next = [clean, ...recentSearches.filter((item) => item.toLocaleLowerCase("ar") !== clean.toLocaleLowerCase("ar"))].slice(0, 6);
    setRecentSearches(next);
    void AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)).catch(() => undefined);
  };
  const clearRecentSearches = () => {
    setRecentSearches([]);
    void AsyncStorage.removeItem(RECENT_SEARCHES_KEY).catch(() => undefined);
  };
  const submitSearch = () => {
    const clean = query.trim();
    rememberSearch(clean);
    setSearchActive(false);
    router.push(clean ? `/search?query=${encodeURIComponent(clean)}` as never : "/search" as never);
  };

  return <ScreenContainer className="flex-1" containerClassName="bg-background">
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <View><Text style={styles.greeting}>مرحباً بك في</Text><Text style={styles.brand}>مكتبة العربية</Text></View>
        <TouchableOpacity accessibilityLabel="فتح سلة المشتريات" activeOpacity={0.8} onPress={() => router.push("/cart" as never)} style={styles.cartButton}><MaterialIcons color="#0C5A4B" name="shopping-bag" size={23} />{itemCount > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{formatLatinNumber(itemCount)}</Text></View>}</TouchableOpacity>
      </View>

      <View style={styles.searchArea}><View style={styles.searchRow}><MaterialIcons color="#55716A" name="search" size={22} /><TextInput value={query} onChangeText={setQuery} onFocus={() => setSearchActive(true)} onSubmitEditing={submitSearch} placeholder="ابحث عن كتاب، مادة أو قرطاسية" placeholderTextColor="#71827C" returnKeyType="search" style={styles.searchInput} textAlign="right" /><TouchableOpacity activeOpacity={0.8} onPress={submitSearch} style={styles.searchAction}><MaterialIcons color="#FFFFFF" name="arrow-back" size={17} /></TouchableOpacity></View>{searchActive && <View style={styles.suggestions}>{query.trim().length >= 2 ? (searchLoading ? <View style={styles.searchLoading}><ActivityIndicator color="#0E806A" size="small"/><Text style={styles.searchLoadingText}>نجهز اقتراحات تناسب بحثك…</Text></View> : quickMatches.length ? <>{quickMatches.map((product) => <TouchableOpacity activeOpacity={0.8} key={product.id} onPress={() => { rememberSearch(query); setSearchActive(false); router.push(`/product/${product.id}` as never); }} style={styles.suggestion}><View style={styles.suggestionIcon}>{product.imageUrl ? <Image cachePolicy="memory-disk" contentFit="cover" source={product.imageUrl} style={styles.suggestionImage} transition={0}/> : <MaterialIcons color="#0E806A" name={product.icon} size={18} />}</View><View style={styles.suggestionCopy}><Text numberOfLines={1} style={styles.suggestionTitle}>{product.title}</Text><View style={styles.suggestionMeta}><Text numberOfLines={1} style={styles.suggestionSubtitle}>{product.brand ?? product.subtitle}</Text><Text style={styles.suggestionPrice}>{formatIqd(product.salePrice ?? product.price)}</Text></View></View><MaterialIcons color="#9AB7AC" name="arrow-back" size={17} /></TouchableOpacity>)}<TouchableOpacity activeOpacity={0.8} onPress={submitSearch} style={styles.allResults}><Text style={styles.allResultsText}>عرض كل نتائج البحث</Text><MaterialIcons color="#0E806A" name="search" size={16} /></TouchableOpacity></> : <View style={styles.noSuggestions}><MaterialIcons color="#9AB7AC" name="search-off" size={18} /><Text style={styles.noSuggestionsText}>لا توجد نتيجة سريعة؛ ابحث في كامل الكتالوج.</Text></View>) : recentSearches.length ? <><View style={styles.recentHeader}><Text style={styles.recentTitle}>عمليات بحث سابقة</Text><TouchableOpacity onPress={clearRecentSearches}><Text style={styles.clearRecent}>مسح</Text></TouchableOpacity></View>{recentSearches.map((item) => <TouchableOpacity activeOpacity={0.8} key={item} onPress={() => { setQuery(item); setSearchActive(false); rememberSearch(item); router.push(`/search?query=${encodeURIComponent(item)}` as never); }} style={styles.suggestion}><View style={styles.suggestionIcon}><MaterialIcons color="#7C918A" name="history" size={18} /></View><Text numberOfLines={1} style={[styles.suggestionTitle, styles.recentItem]}>{item}</Text><MaterialIcons color="#9AB7AC" name="arrow-back" size={17} /></TouchableOpacity>)}</> : <View style={styles.noSuggestions}><MaterialIcons color="#9AB7AC" name="tips-and-updates" size={18} /><Text style={styles.noSuggestionsText}>اكتب حرفين لتظهر اقتراحات من المنتجات.</Text></View>}</View>}</View>

      <MarketingCarousel banners={banners} offers={offers} onPress={(banner) => router.push(routeFromBanner(banner))} />

      {offers.length > 0 && <ScrollView contentContainerStyle={styles.offerStripContent} horizontal showsHorizontalScrollIndicator={false} style={styles.offerStrip}>{offers.slice(0, 8).map((offer) => <TouchableOpacity activeOpacity={0.85} key={offer.id} onPress={() => router.push("/categories" as never)} style={styles.offerChip}><MaterialIcons color="#B64B24" name="local-offer" size={16} /><Text numberOfLines={1} style={styles.offerChipText}>{offer.name}</Text></TouchableOpacity>)}</ScrollView>}

      <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>تسوّق حسب ما تحتاجه</Text><Text style={styles.sectionHint}>اختيار مباشر حسب القسم</Text></View><TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/categories" as never)}><Text style={styles.link}>عرض الكل</Text></TouchableOpacity></View>
      <ScrollView contentContainerStyle={styles.categoryList} horizontal showsHorizontalScrollIndicator={false}>{categories.map((category, index) => <TouchableOpacity activeOpacity={0.85} key={category.id} onPress={() => router.push(`/categories?category=${category.id}` as never)} style={styles.categoryItem}><View style={[styles.categoryIcon, { backgroundColor: ["#E4F0E8", "#F5EBD1", "#E6EEF8", "#F1E7F3"][index % 4] }]}><MaterialIcons color="#0C5A4B" name={["menu-book", "edit", "school", "card-giftcard"][index % 4] as never} size={24} /></View><Text numberOfLines={2} style={styles.categoryText}>{category.name}</Text><Text style={styles.categoryCount}>{formatLatinNumber(category.availableCount)} متاح</Text></TouchableOpacity>)}</ScrollView>

      <View style={styles.filterBlock}><View style={styles.filterHeading}><View><Text style={styles.sectionTitle}>كل المنتجات</Text><Text style={styles.sectionHint}>رتّب واختَر ما يناسبك بسرعة</Text></View><MaterialIcons color="#0E806A" name="tune" size={22} /></View><ScrollView contentContainerStyle={styles.filterChips} horizontal showsHorizontalScrollIndicator={false}><TouchableOpacity activeOpacity={0.8} onPress={() => setHomeCategoryId(null)} style={[styles.filterChip, !homeCategoryId && styles.filterChipActive]}><Text style={[styles.filterChipText, !homeCategoryId && styles.filterChipTextActive]}>الكل</Text></TouchableOpacity>{categories.map((category) => <TouchableOpacity activeOpacity={0.8} key={category.id} onPress={() => setHomeCategoryId(String(category.id))} style={[styles.filterChip, homeCategoryId === String(category.id) && styles.filterChipActive]}><Text style={[styles.filterChipText, homeCategoryId === String(category.id) && styles.filterChipTextActive]}>{category.name}</Text></TouchableOpacity>)}</ScrollView><View style={styles.sortRow}>{([ ["POPULAR", "الأكثر طلباً", "trending-up"], ["PRICE_ASC", "الأقل سعراً", "arrow-downward"], ["PRICE_DESC", "الأعلى سعراً", "arrow-upward"] ] as const).map(([value, label, icon]) => <TouchableOpacity activeOpacity={0.8} key={value} onPress={() => setHomeSort(value)} style={[styles.sortChip, homeSort === value && styles.sortChipActive]}><MaterialIcons color={homeSort === value ? "#FFFFFF" : "#55716A"} name={icon} size={14} /><Text style={[styles.sortText, homeSort === value && styles.sortTextActive]}>{label}</Text></TouchableOpacity>)}</View></View>

      {saleProducts.length > 0 && <><View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>عروض تستحق المشاهدة</Text><Text style={styles.sectionHint}>الأسعار تظهر من الكتالوج مباشرة</Text></View><View style={styles.salePill}><MaterialIcons color="#FFFFFF" name="bolt" size={14} /><Text style={styles.salePillText}>توفير حقيقي</Text></View></View><ScrollView contentContainerStyle={styles.productRail} horizontal showsHorizontalScrollIndicator={false}>{saleProducts.map((product, index) => <ProductCard animationDelay={index * 55} key={product.id} onAddedToCart={() => setSideCartVisible(true)} onQuickView={setQuickProduct} product={product} variant="rail" />)}</ScrollView></>}

      <View style={styles.trustRow}><View style={styles.trustItem}><MaterialIcons color="#0C5A4B" name="verified-user" size={21} /><Text style={styles.trustText}>أسعار واضحة</Text></View><View style={styles.trustItem}><MaterialIcons color="#0C5A4B" name="local-shipping" size={21} /><Text style={styles.trustText}>توصيل حسب العنوان</Text></View><View style={styles.trustItem}><MaterialIcons color="#0C5A4B" name="support-agent" size={21} /><Text style={styles.trustText}>دعم من المكتبة</Text></View></View>

      <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>اختياراتك الآن</Text><Text style={styles.sectionHint}>{loading ? "جار تجهيز المنتجات…" : `${formatLatinNumber(homeProducts.length)} منتج مطابق لاختيارك`}</Text></View><TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/categories" as never)}><Text style={styles.link}>عرض أوسع</Text></TouchableOpacity></View>
      {catalogState === "LOADING" ? <View style={styles.loadingProducts}><ActivityIndicator color="#0E806A" size="small" /><Text style={styles.loadingProductsText}>جار تحميل المنتجات المتوفرة…</Text></View> : catalogState === "ERROR" ? <View style={styles.error}><MaterialIcons color="#B64B24" name="cloud-off" size={20} /><View style={styles.errorCopy}><Text style={styles.errorText}>تعذر تحميل المنتجات الآن، لكن يمكنك متابعة التصفح أو إعادة المحاولة.</Text><TouchableOpacity activeOpacity={0.8} onPress={refresh} style={styles.retryButton}><MaterialIcons color="#8E3D1E" name="refresh" size={16} /><Text style={styles.retryText}>إعادة التحميل</Text></TouchableOpacity></View></View> : catalogState === "READY" ? <View style={styles.grid}>{homeProducts.map((product, index) => <ProductCard animationDelay={index * 65} key={product.id} onAddedToCart={() => setSideCartVisible(true)} onQuickView={setQuickProduct} product={product} />)}</View> : <View style={styles.noProducts}><MaterialIcons color="#9AB7AC" name="search-off" size={30} /><Text style={styles.noProductsTitle}>لا توجد منتجات مطابقة حالياً</Text><TouchableOpacity activeOpacity={0.8} onPress={() => setHomeCategoryId(null)}><Text style={styles.link}>إظهار جميع المنتجات</Text></TouchableOpacity></View>}
      <TouchableOpacity activeOpacity={0.9} onPress={() => router.push("/categories" as never)} style={styles.catalogCta}><Text style={styles.catalogCtaText}>استكشف جميع منتجات المكتبة</Text><MaterialIcons color="#0C5A4B" name="arrow-back" size={19} /></TouchableOpacity>
      <QuickProductView onAddedToCart={() => setSideCartVisible(true)} onClose={() => setQuickProduct(null)} product={quickProduct} />
      <SideCart onClose={() => setSideCartVisible(false)} visible={sideCartVisible} />
    </ScrollView>
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  content: { paddingBottom: 34, paddingHorizontal: 16 },
  header: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", marginBottom: 16, paddingTop: 7 }, greeting: { color: "#6D817A", fontFamily: "Cairo_600SemiBold", fontSize: 13, textAlign: "right" }, brand: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 25, marginTop: 2, textAlign: "right" },
  cartButton: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#E9DDD1", borderRadius: 17, borderWidth: 1, elevation: 2, height: 48, justifyContent: "center", shadowColor: "#173A33", shadowOpacity: 0.07, shadowRadius: 8, width: 48 }, badge: { alignItems: "center", backgroundColor: "#F05D53", borderColor: "#FFFFFF", borderRadius: 11, borderWidth: 2, height: 21, justifyContent: "center", position: "absolute", right: -6, top: -6, width: 21 }, badgeText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 10 },
  searchArea: { marginBottom: 18, zIndex: 10 }, searchRow: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#E9DDD1", borderRadius: 19, borderWidth: 1, flexDirection: "row-reverse", height: 56, paddingLeft: 8, paddingRight: 14 }, searchInput: { color: "#183D36", flex: 1, fontFamily: "Cairo_400Regular", fontSize: 14, marginHorizontal: 8 }, searchAction: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 13, height: 40, justifyContent: "center", width: 40 }, suggestions: { backgroundColor: "#FFFFFF", borderColor: "#E9DDD1", borderRadius: 17, borderWidth: 1, elevation: 3, marginTop: 7, overflow: "hidden", shadowColor: "#173A33", shadowOpacity: 0.1, shadowRadius: 12 }, searchLoading: { alignItems: "center", flexDirection: "row-reverse", gap: 8, justifyContent: "center", padding: 16 }, searchLoadingText: { color: "#55716A", fontFamily: "Cairo_600SemiBold", fontSize: 11 }, recentHeader: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 11 }, recentTitle: { color: "#55716A", fontFamily: "Cairo_700Bold", fontSize: 11 }, clearRecent: { color: "#F05D53", fontFamily: "Cairo_700Bold", fontSize: 11 }, suggestion: { alignItems: "center", borderBottomColor: "#F1E7DE", borderBottomWidth: 1, flexDirection: "row-reverse", gap: 10, paddingHorizontal: 12, paddingVertical: 10 }, suggestionIcon: { alignItems: "center", backgroundColor: "#E8F5EF", borderRadius: 11, height: 40, justifyContent: "center", overflow: "hidden", width: 40 }, suggestionImage: { height: "100%", width: "100%" }, suggestionCopy: { flex: 1 }, suggestionTitle: { color: "#183D36", fontFamily: "Cairo_700Bold", fontSize: 12, textAlign: "right" }, recentItem: { flex: 1 }, suggestionMeta: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 2 }, suggestionSubtitle: { color: "#6D817A", flex: 1, fontFamily: "Cairo_400Regular", fontSize: 10, textAlign: "right" }, suggestionPrice: { color: "#0E806A", fontFamily: "Cairo_800ExtraBold", fontSize: 10, marginRight: 8 }, allResults: { alignItems: "center", flexDirection: "row-reverse", gap: 6, justifyContent: "center", paddingVertical: 11 }, allResultsText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 12 }, noSuggestions: { alignItems: "center", flexDirection: "row-reverse", gap: 6, justifyContent: "center", padding: 13 }, noSuggestionsText: { color: "#6D817A", fontFamily: "Cairo_600SemiBold", fontSize: 11 },
  offerStrip: { marginHorizontal: -16, marginTop: 12 }, offerStripContent: { gap: 8, paddingHorizontal: 16 }, offerChip: { alignItems: "center", backgroundColor: "#FFF0E2", borderColor: "#F5D5BD", borderRadius: 14, borderWidth: 1, flexDirection: "row-reverse", gap: 5, maxWidth: 210, paddingHorizontal: 11, paddingVertical: 8 }, offerChipText: { color: "#B84A39", fontFamily: "Cairo_700Bold", fontSize: 11 },
  sectionHeader: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 28, marginBottom: 13 }, sectionTitle: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 18, textAlign: "right" }, sectionHint: { color: "#6D817A", fontFamily: "Cairo_600SemiBold", fontSize: 11, marginTop: 3, textAlign: "right" }, link: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 12 },
  categoryList: { gap: 11, paddingLeft: 4, paddingRight: 2 }, categoryItem: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 19, borderWidth: 1, minHeight: 118, paddingHorizontal: 10, paddingVertical: 12, width: 96 }, categoryIcon: { alignItems: "center", borderRadius: 16, height: 49, justifyContent: "center", width: 49 }, categoryText: { color: "#183D36", fontFamily: "Cairo_700Bold", fontSize: 11, marginTop: 7, textAlign: "center" }, categoryCount: { color: "#6D817A", fontFamily: "Cairo_600SemiBold", fontSize: 9, marginTop: 3 },
  filterBlock: { backgroundColor: "#FFF3E8", borderColor: "#F6DFC8", borderRadius: 22, borderWidth: 1, marginTop: 21, padding: 14 }, filterHeading: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" }, filterChips: { gap: 8, marginHorizontal: -2, marginTop: 12, paddingHorizontal: 2 }, filterChip: { backgroundColor: "#FFFFFF", borderColor: "#EADFD3", borderRadius: 13, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 7 }, filterChipActive: { backgroundColor: "#0E806A", borderColor: "#0E806A" }, filterChipText: { color: "#55716A", fontFamily: "Cairo_700Bold", fontSize: 11 }, filterChipTextActive: { color: "#FFFFFF" }, sortRow: { flexDirection: "row-reverse", gap: 7, marginTop: 12 }, sortChip: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EADFD3", borderRadius: 12, borderWidth: 1, flex: 1, flexDirection: "row-reverse", gap: 4, justifyContent: "center", minHeight: 37, paddingHorizontal: 4 }, sortChipActive: { backgroundColor: "#0E806A", borderColor: "#0E806A" }, sortText: { color: "#55716A", fontFamily: "Cairo_700Bold", fontSize: 10 }, sortTextActive: { color: "#FFFFFF" },
  salePill: { alignItems: "center", backgroundColor: "#F05D53", borderRadius: 13, flexDirection: "row-reverse", gap: 4, paddingHorizontal: 10, paddingVertical: 6 }, salePillText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 10 }, productRail: { paddingLeft: 3 },
  trustRow: { backgroundColor: "#E8F5EF", borderRadius: 18, flexDirection: "row-reverse", justifyContent: "space-around", marginTop: 14, paddingVertical: 14 }, trustItem: { alignItems: "center", flex: 1, gap: 5 }, trustText: { color: "#315A50", fontFamily: "Cairo_700Bold", fontSize: 10, textAlign: "center" },
  grid: { flexDirection: "row-reverse", flexWrap: "wrap", justifyContent: "space-between" }, loadingProducts: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 18, borderWidth: 1, flexDirection: "row-reverse", gap: 9, justifyContent: "center", minHeight: 148, padding: 22 }, loadingProductsText: { color: "#55716A", fontFamily: "Cairo_700Bold", fontSize: 12 }, error: { alignItems: "flex-start", backgroundColor: "#FFF0ED", borderRadius: 16, flexDirection: "row-reverse", gap: 8, padding: 14 }, errorCopy: { flex: 1 }, errorText: { color: "#B84A39", fontFamily: "Cairo_600SemiBold", fontSize: 12, lineHeight: 19, textAlign: "right" }, retryButton: { alignItems: "center", alignSelf: "flex-end", flexDirection: "row-reverse", gap: 4, marginTop: 8, paddingVertical: 3 }, retryText: { color: "#B84A39", fontFamily: "Cairo_700Bold", fontSize: 12 },
  noProducts: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 18, borderWidth: 1, gap: 7, padding: 22 }, noProductsTitle: { color: "#536B62", fontFamily: "Cairo_700Bold", fontSize: 13 },
  catalogCta: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#0E806A", borderRadius: 17, borderWidth: 1, flexDirection: "row", gap: 8, height: 53, justifyContent: "center", marginTop: 6 }, catalogCtaText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 14 },
});
