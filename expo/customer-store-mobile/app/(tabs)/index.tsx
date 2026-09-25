import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { FloatingCartBar } from "@/components/floating-cart-bar";
import { ProductCard } from "@/components/product-card";
import { QuickProductView } from "@/components/quick-product-view";
import { ScreenContainer } from "@/components/screen-container";
import { SideCart } from "@/components/side-cart";
import { useCart } from "@/lib/cart-context";
import {
  catalogDisplayState,
  formatIqd,
  formatLatinNumber,
  useStorefrontCatalog,
  useStorefrontCategories,
} from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";
import type { Product } from "@/shared/storefront";

const RECENT_SEARCHES_KEY = "@al_arabiya/recent-searches-v1";

const SHOPPER_PATHS = [
  {
    audience: "طالب",
    direction: "كتب ولوازم دراسية",
    icon: "menu-book",
    route: "/search",
  },
  {
    audience: "فرد",
    direction: "قرطاسية وهدايا",
    icon: "edit",
    route: "/categories",
  },
  {
    audience: "مكتب",
    direction: "تجهيزات العمل",
    icon: "business-center",
    route: "/categories",
  },
  {
    audience: "شركة",
    direction: "طلب عرض للكميات",
    icon: "corporate-fare",
    route: "/request-quote",
  },
] as const;

export default function HomeScreen() {
  const { itemCount } = useCart();
  const { products, loading, error, refresh } = useStorefrontCatalog(
    undefined,
    undefined,
    { limit: 30 },
  );
  const { categories } = useStorefrontCategories();
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [quickProduct, setQuickProduct] = useState<Product | null>(null);
  const [sideCartVisible, setSideCartVisible] = useState(false);
  const [homeCategoryId, setHomeCategoryId] = useState<string | null>(null);
  const [homeSort, setHomeSort] = useState<
    "POPULAR" | "PRICE_ASC" | "PRICE_DESC"
  >("POPULAR");

  const homeProducts = useMemo(() => {
    const filtered = homeCategoryId
      ? products.filter((product) => product.categoryId === homeCategoryId)
      : products;
    return [...filtered].sort((left, right) => {
      if (homeSort === "PRICE_ASC")
        return (
          Number(left.salePrice ?? left.price ?? 0) -
          Number(right.salePrice ?? right.price ?? 0)
        );
      if (homeSort === "PRICE_DESC")
        return (
          Number(right.salePrice ?? right.price ?? 0) -
          Number(left.salePrice ?? left.price ?? 0)
        );
      return (right.soldCount ?? 0) - (left.soldCount ?? 0);
    });
  }, [homeCategoryId, homeSort, products]);

  const productsState = catalogDisplayState(homeProducts, loading, error);

  const quickMatches = useMemo(() => {
    const clean = debouncedQuery.trim().toLocaleLowerCase("ar");
    if (clean.length < 2) return [];
    return products
      .filter((product) =>
        `${product.title} ${product.subtitle} ${product.brand ?? ""}`
          .toLocaleLowerCase("ar")
          .includes(clean),
      )
      .slice(0, 4);
  }, [debouncedQuery, products]);

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
    void AsyncStorage.getItem(RECENT_SEARCHES_KEY)
      .then((raw) => {
        const values = raw ? JSON.parse(raw) : [];
        if (
          Array.isArray(values) &&
          values.every((value) => typeof value === "string")
        )
          setRecentSearches(values.slice(0, 6));
      })
      .catch(() => undefined);
  }, []);

  const rememberSearch = (value: string) => {
    const clean = value.trim().replace(/\s+/g, " ");
    if (!clean) return;
    const next = [
      clean,
      ...recentSearches.filter(
        (item) =>
          item.toLocaleLowerCase("ar") !== clean.toLocaleLowerCase("ar"),
      ),
    ].slice(0, 6);
    setRecentSearches(next);
    void AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)).catch(
      () => undefined,
    );
  };

  const clearRecentSearches = () => {
    setRecentSearches([]);
    void AsyncStorage.removeItem(RECENT_SEARCHES_KEY).catch(() => undefined);
  };

  const submitSearch = () => {
    const clean = query.trim();
    rememberSearch(clean);
    setSearchActive(false);
    router.push(
      clean
        ? (`/search?query=${encodeURIComponent(clean)}` as never)
        : ("/search" as never),
    );
  };

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* شريط العلامة التجارية الفاخرة — Luxury Brand Header */}
        <View style={styles.topBar}>
          <View style={styles.brandLockup}>
            <View style={styles.brandMark}>
              <MaterialIcons color="#FFFFFF" name="storefront" size={20} />
            </View>
            <View>
              <Text style={styles.brand}>المكتبة العربية</Text>
              <Text style={styles.eyebrow}>لكل احتياج، من طلب واحد</Text>
            </View>
          </View>
          <View style={styles.topActions}>
            <TouchableOpacity
              accessibilityLabel="فتح حسابي"
              activeOpacity={0.82}
              onPress={() => router.push("/account" as never)}
              style={styles.accountButton}
            >
              <MaterialIcons color="#183D36" name="person-outline" size={22} />
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel="فتح سلة المشتريات"
              activeOpacity={0.82}
              onPress={() => router.push("/cart" as never)}
              style={styles.cartButton}
            >
              <MaterialIcons color="#FFFFFF" name="shopping-bag" size={20} />
              {itemCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {formatLatinNumber(itemCount)}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* حقل البحث الأنيق والتفاعلي — Refined Search Bar */}
        <View style={styles.searchArea}>
          <View style={styles.searchRow}>
            <MaterialIcons color="#5D746C" name="search" size={22} />
            <TextInput
              onChangeText={setQuery}
              onFocus={() => setSearchActive(true)}
              onSubmitEditing={submitSearch}
              placeholder="ابحث عن منتج، كتاب، قرطاسية أو تجهيز…"
              placeholderTextColor="#71827C"
              returnKeyType="search"
              style={styles.searchInput}
              textAlign="right"
              value={query}
            />
            {query.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setQuery("");
                  setSearchActive(false);
                }}
                style={styles.searchClear}
              >
                <MaterialIcons color="#71827C" name="close" size={18} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={submitSearch}
              style={styles.searchAction}
            >
              <MaterialIcons color="#FFFFFF" name="arrow-back" size={17} />
            </TouchableOpacity>
          </View>

          {searchActive && (
            <View style={styles.suggestions}>
              {query.trim().length >= 2 ? (
                searchLoading ? (
                  <View style={styles.searchLoading}>
                    <ActivityIndicator
                      color={storefrontDesign.semantic.brandStrong}
                      size="small"
                    />
                    <Text style={styles.searchLoadingText}>
                      نجهز اقتراحات تناسب بحثك…
                    </Text>
                  </View>
                ) : quickMatches.length ? (
                  <>
                    {quickMatches.map((product) => (
                      <TouchableOpacity
                        activeOpacity={0.8}
                        key={product.id}
                        onPress={() => {
                          rememberSearch(query);
                          setSearchActive(false);
                          router.push(`/product/${product.id}` as never);
                        }}
                        style={styles.suggestion}
                      >
                        <View style={styles.suggestionIcon}>
                          {product.imageUrl ? (
                            <Image
                              cachePolicy="memory-disk"
                              contentFit="cover"
                              source={product.imageUrl}
                              style={styles.suggestionImage}
                              transition={0}
                            />
                          ) : (
                            <MaterialIcons
                              color="#0E806A"
                              name={product.icon}
                              size={18}
                            />
                          )}
                        </View>
                        <View style={styles.suggestionCopy}>
                          <Text
                            numberOfLines={1}
                            style={styles.suggestionTitle}
                          >
                            {product.title}
                          </Text>
                          <View style={styles.suggestionMeta}>
                            <Text
                              numberOfLines={1}
                              style={styles.suggestionSubtitle}
                            >
                              {product.brand ?? product.subtitle}
                            </Text>
                            <Text style={styles.suggestionPrice}>
                              {formatIqd(product.salePrice ?? product.price)}
                            </Text>
                          </View>
                        </View>
                        <MaterialIcons
                          color="#9AB7AC"
                          name="arrow-back"
                          size={17}
                        />
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={submitSearch}
                      style={styles.allResults}
                    >
                      <Text style={styles.allResultsText}>
                        عرض جميع المنتجات المطابقة
                      </Text>
                      <MaterialIcons color="#0E806A" name="search" size={16} />
                    </TouchableOpacity>
                  </>
                ) : (
                  <View style={styles.noSuggestions}>
                    <MaterialIcons
                      color="#9AB7AC"
                      name="search-off"
                      size={18}
                    />
                    <Text style={styles.noSuggestionsText}>
                      لا توجد نتيجة سريعة؛ ابحث في جميع المنتجات.
                    </Text>
                  </View>
                )
              ) : recentSearches.length ? (
                <>
                  <View style={styles.recentHeader}>
                    <Text style={styles.recentTitle}>عمليات بحث سابقة</Text>
                    <TouchableOpacity onPress={clearRecentSearches}>
                      <Text style={styles.clearRecent}>مسح</Text>
                    </TouchableOpacity>
                  </View>
                  {recentSearches.map((item) => (
                    <TouchableOpacity
                      activeOpacity={0.8}
                      key={item}
                      onPress={() => {
                        setQuery(item);
                        setSearchActive(false);
                        rememberSearch(item);
                        router.push(
                          `/search?query=${encodeURIComponent(item)}` as never,
                        );
                      }}
                      style={styles.suggestion}
                    >
                      <View style={styles.suggestionIcon}>
                        <MaterialIcons
                          color="#7C918A"
                          name="history"
                          size={18}
                        />
                      </View>
                      <Text
                        numberOfLines={1}
                        style={[styles.suggestionTitle, styles.recentItem]}
                      >
                        {item}
                      </Text>
                      <MaterialIcons
                        color="#9AB7AC"
                        name="arrow-back"
                        size={17}
                      />
                    </TouchableOpacity>
                  ))}
                </>
              ) : (
                <View style={styles.noSuggestions}>
                  <MaterialIcons
                    color="#9AB7AC"
                    name="tips-and-updates"
                    size={18}
                  />
                  <Text style={styles.noSuggestionsText}>
                    اكتب حرفين لتظهر اقتراحات من المنتجات.
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* فئات وتصنيفات الشراء المباشر — Instant Category Filter Pills */}
        <View style={styles.filterSection}>
          <ScrollView
            contentContainerStyle={styles.filterChips}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => setHomeCategoryId(null)}
              style={[
                styles.categoryPill,
                !homeCategoryId && styles.categoryPillActive,
              ]}
            >
              <Text
                style={[
                  styles.categoryPillText,
                  !homeCategoryId && styles.categoryPillTextActive,
                ]}
              >
                الكل
              </Text>
            </TouchableOpacity>
            {categories.map((category) => (
              <TouchableOpacity
                activeOpacity={0.85}
                key={category.id}
                onPress={() => setHomeCategoryId(String(category.id))}
                style={[
                  styles.categoryPill,
                  homeCategoryId === String(category.id) &&
                    styles.categoryPillActive,
                ]}
              >
                <Text
                  style={[
                    styles.categoryPillText,
                    homeCategoryId === String(category.id) &&
                      styles.categoryPillTextActive,
                  ]}
                >
                  {category.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* شريط الفرز الأنيق — Minimal Sort Row */}
          <View style={styles.sortRow}>
            {(
              [
                ["POPULAR", "الأكثر طلباً", "trending-up"],
                ["PRICE_ASC", "الأقل سعراً", "arrow-downward"],
                ["PRICE_DESC", "الأعلى سعراً", "arrow-upward"],
              ] as const
            ).map(([value, label, icon]) => (
              <TouchableOpacity
                activeOpacity={0.85}
                key={value}
                onPress={() => setHomeSort(value)}
                style={[
                  styles.sortChip,
                  homeSort === value && styles.sortChipActive,
                ]}
              >
                <MaterialIcons
                  color={homeSort === value ? "#FFFFFF" : "#55716A"}
                  name={icon}
                  size={14}
                />
                <Text
                  style={[
                    styles.sortText,
                    homeSort === value && styles.sortTextActive,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* عنوان الكتالوج الفاخر — Direct Luxury Catalog Header */}
        <View style={styles.catalogHeader}>
          <View>
            <Text style={styles.catalogTitle}>
              {homeCategoryId
                ? categories.find((c) => String(c.id) === homeCategoryId)?.name ??
                  "منتجات القسم"
                : "كتالوج المنتجات"}
            </Text>
            <Text style={styles.catalogCount}>
              {loading
                ? "جارِ تجهيز المنتجات…"
                : `${formatLatinNumber(homeProducts.length)} منتج متوفر للشراء المباشر`}
            </Text>
          </View>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push("/categories" as never)}
            style={styles.allCategoriesLink}
          >
            <Text style={styles.linkText}>تصفح الأقسام</Text>
            <MaterialIcons color="#0E806A" name="arrow-back" size={14} />
          </TouchableOpacity>
        </View>

        {/* شبكة المنتجات المباشرة (عمودان فاخران) — 2-Column Product Grid */}
        {productsState === "LOADING" ? (
          <View style={styles.loadingProducts}>
            <ActivityIndicator color="#0E806A" size="small" />
            <Text style={styles.loadingProductsText}>
              جارٍ تحميل المنتجات المتوفرة…
            </Text>
          </View>
        ) : productsState === "ERROR" ? (
          <View style={styles.error}>
            <View style={styles.errorIcon}>
              <MaterialIcons color="#B64B24" name="cloud-off" size={20} />
            </View>
            <View style={styles.errorCopy}>
              <Text style={styles.errorTitle}>
                لم نتمكن من تحديث المنتجات الآن
              </Text>
              <Text style={styles.errorText}>
                تحقق من اتصالك ثم أعد المحاولة.
              </Text>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={refresh}
                style={styles.retryButton}
              >
                <MaterialIcons color="#8E3D1E" name="refresh" size={16} />
                <Text style={styles.retryText}>إعادة تحميل المنتجات</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : productsState === "READY" && homeProducts.length > 0 ? (
          <View style={styles.grid}>
            {homeProducts.map((product, index) => (
              <ProductCard
                animationDelay={index * 40}
                key={product.id}
                onAddedToCart={() => setSideCartVisible(true)}
                onQuickView={setQuickProduct}
                product={product}
              />
            ))}
          </View>
        ) : (
          <View style={styles.noProducts}>
            <View style={styles.emptyIcon}>
              <MaterialIcons color="#0E806A" name="inventory-2" size={29} />
            </View>
            <Text style={styles.noProductsTitle}>
              لا توجد منتجات مطابقة حالياً
            </Text>
            <Text style={styles.noProductsCopy}>
              غيّر القسم أو اعرض جميع المنتجات للبدء من جديد.
            </Text>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setHomeCategoryId(null)}
              style={styles.emptyAction}
            >
              <Text style={styles.emptyActionText}>إظهار جميع المنتجات</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* دليل اكتشاف المنتجات السريع (في أسفل الكتالوج كخدمة تكميلية) — Shopper Paths Guide */}
        <View style={styles.pathsSection}>
          <Text style={styles.pathsSectionTitle}>تسوّق حسب احتياجك</Text>
          <ScrollView
            contentContainerStyle={styles.pathList}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {SHOPPER_PATHS.map((item) => (
              <TouchableOpacity
                accessibilityLabel={`مسار ${item.audience}: ${item.direction}`}
                accessibilityRole="button"
                activeOpacity={0.88}
                key={item.audience}
                onPress={() => router.push(item.route as never)}
                style={styles.pathCard}
              >
                <View style={styles.pathIcon}>
                  <MaterialIcons color="#183D36" name={item.icon} size={20} />
                </View>
                <Text style={styles.pathAudience}>{item.audience}</Text>
                <Text numberOfLines={1} style={styles.pathDirection}>
                  {item.direction}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        <QuickProductView
          onAddedToCart={() => setSideCartVisible(true)}
          onClose={() => setQuickProduct(null)}
          product={quickProduct}
        />
        <SideCart
          onClose={() => setSideCartVisible(false)}
          visible={sideCartVisible}
        />
      </ScrollView>

      {/* شريط السلة العائم الذكي — Smart Floating Cart Bar */}
      <FloatingCartBar onOpenSideCart={() => setSideCartVisible(true)} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: {
    alignSelf: "center",
    maxWidth: 640,
    paddingBottom: 130, // مسافة أمان لشريط السلة العائم والتاب بار
    paddingHorizontal: 16,
    width: "100%",
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 14,
    paddingTop: 8,
  },
  brandLockup: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row-reverse",
    gap: 10,
  },
  brandMark: {
    alignItems: "center",
    backgroundColor: "#0E806A",
    borderRadius: 14,
    height: 40,
    justifyContent: "center",
    shadowColor: "#0E806A",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    width: 40,
    elevation: 3,
  },
  brand: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
    lineHeight: 26,
    textAlign: "right",
  },
  eyebrow: {
    color: "#71817B",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
    marginTop: -2,
    textAlign: "right",
  },
  topActions: {
    flexDirection: "row-reverse",
    gap: 8,
  },
  accountButton: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 15,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  cartButton: {
    alignItems: "center",
    backgroundColor: "#0E806A",
    borderRadius: 15,
    elevation: 3,
    height: 42,
    justifyContent: "center",
    shadowColor: "#0E806A",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    width: 42,
  },
  badge: {
    alignItems: "center",
    backgroundColor: "#E0533C",
    borderColor: "#FFFFFF",
    borderRadius: 11,
    borderWidth: 2,
    height: 20,
    justifyContent: "center",
    minWidth: 20,
    paddingHorizontal: 3,
    position: "absolute",
    right: -6,
    top: -6,
  },
  badgeText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9.5,
  },
  searchArea: {
    marginBottom: 16,
    zIndex: 10,
  },
  searchRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 20,
    borderWidth: 1.5,
    flexDirection: "row-reverse",
    height: 50,
    paddingLeft: 6,
    paddingRight: 14,
    shadowColor: "#183D36",
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1,
  },
  searchInput: {
    color: "#183D36",
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    marginHorizontal: 8,
  },
  searchClear: {
    padding: 6,
  },
  searchAction: {
    alignItems: "center",
    backgroundColor: "#0E806A",
    borderRadius: 14,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  suggestions: {
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 18,
    borderWidth: 1,
    elevation: 4,
    marginTop: 6,
    overflow: "hidden",
    shadowColor: "#183D36",
    shadowOpacity: 0.08,
    shadowRadius: 12,
  },
  searchLoading: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 8,
    justifyContent: "center",
    padding: 16,
  },
  searchLoadingText: {
    color: "#55716A",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  recentHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  recentTitle: { color: "#55716A", fontFamily: "Cairo_700Bold", fontSize: 11 },
  clearRecent: { color: "#E0533C", fontFamily: "Cairo_700Bold", fontSize: 11 },
  suggestion: {
    alignItems: "center",
    borderBottomColor: "#F1E7DE",
    borderBottomWidth: 1,
    flexDirection: "row-reverse",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  suggestionIcon: {
    alignItems: "center",
    backgroundColor: "#E8F5EF",
    borderRadius: 11,
    height: 38,
    justifyContent: "center",
    overflow: "hidden",
    width: 38,
  },
  suggestionImage: { height: "100%", width: "100%" },
  suggestionCopy: { flex: 1 },
  suggestionTitle: {
    color: "#183D36",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
    textAlign: "right",
  },
  recentItem: { flex: 1 },
  suggestionMeta: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 2,
  },
  suggestionSubtitle: {
    color: "#6D817A",
    flex: 1,
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    textAlign: "right",
  },
  suggestionPrice: {
    color: "#0E806A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10.5,
    marginRight: 8,
  },
  allResults: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
    paddingVertical: 11,
  },
  allResultsText: {
    color: "#0E806A",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  noSuggestions: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
    padding: 13,
  },
  noSuggestionsText: {
    color: "#6D817A",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  filterSection: {
    marginBottom: 16,
  },
  filterChips: {
    gap: 8,
    paddingBottom: 8,
  },
  categoryPill: {
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: "#183D36",
    shadowOpacity: 0.02,
    shadowRadius: 4,
  },
  categoryPillActive: {
    backgroundColor: "#0E806A",
    borderColor: "#0E806A",
  },
  categoryPillText: {
    color: "#183D36",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  categoryPillTextActive: {
    color: "#FFFFFF",
  },
  sortRow: {
    flexDirection: "row-reverse",
    gap: 7,
    marginTop: 6,
  },
  sortChip: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row-reverse",
    gap: 4,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: 4,
  },
  sortChipActive: {
    backgroundColor: "#183D36",
    borderColor: "#183D36",
  },
  sortText: {
    color: "#55716A",
    fontFamily: "Cairo_700Bold",
    fontSize: 10,
  },
  sortTextActive: {
    color: "#FFFFFF",
  },
  catalogHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 12,
    marginTop: 4,
  },
  catalogTitle: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 17,
    textAlign: "right",
  },
  catalogCount: {
    color: "#71827C",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    marginTop: 1,
    textAlign: "right",
  },
  allCategoriesLink: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 3,
  },
  linkText: {
    color: "#0E806A",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  grid: {
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  loadingProducts: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 9,
    justifyContent: "center",
    minHeight: 140,
    padding: 22,
  },
  loadingProductsText: {
    color: "#55716A",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  error: {
    alignItems: "flex-start",
    backgroundColor: "#FFF4EF",
    borderColor: "#F4D8C8",
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 10,
    padding: 14,
  },
  errorIcon: {
    alignItems: "center",
    backgroundColor: "#FCE4D7",
    borderRadius: 13,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  errorCopy: { flex: 1 },
  errorTitle: {
    color: "#8E3D1E",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    textAlign: "right",
  },
  errorText: {
    color: "#9E5B40",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 3,
    textAlign: "right",
  },
  retryButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    flexDirection: "row-reverse",
    gap: 4,
    marginTop: 8,
    paddingVertical: 3,
  },
  retryText: { color: "#8E3D1E", fontFamily: "Cairo_700Bold", fontSize: 12 },
  noProducts: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 18,
    borderWidth: 1,
    gap: 6,
    padding: 24,
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: "#E8F5EF",
    borderRadius: 17,
    height: 52,
    justifyContent: "center",
    marginBottom: 2,
    width: 52,
  },
  noProductsTitle: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
  },
  noProductsCopy: {
    color: "#6D817A",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    textAlign: "center",
  },
  emptyAction: {
    backgroundColor: "#E8F5EF",
    borderRadius: 11,
    marginTop: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  emptyActionText: {
    color: "#0E806A",
    fontFamily: "Cairo_700Bold",
    fontSize: 11.5,
  },
  pathsSection: {
    marginTop: 28,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#EAE2D8",
  },
  pathsSectionTitle: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
    marginBottom: 10,
    textAlign: "right",
  },
  pathList: {
    gap: 8,
    paddingBottom: 8,
  },
  pathCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#EAE2D8",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pathIcon: {
    alignItems: "center",
    backgroundColor: "#FAF5EE",
    borderRadius: 10,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  pathAudience: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 12,
  },
  pathDirection: {
    color: "#71827C",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
  },
});
