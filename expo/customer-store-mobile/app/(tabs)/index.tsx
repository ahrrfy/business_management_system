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

import { MarketingCarousel } from "@/components/marketing-carousel";
import { ProductCard } from "@/components/product-card";
import { QuickProductView } from "@/components/quick-product-view";
import { ScreenContainer } from "@/components/screen-container";
import { SideCart } from "@/components/side-cart";
import { useCart } from "@/lib/cart-context";
import {
  catalogDisplayState,
  formatIqd,
  formatLatinNumber,
  productDiscountPercent,
  useStorefrontCatalog,
  useStorefrontCategories,
  useStorefrontMarketing,
  type StorefrontBanner,
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
    tone: "mint",
  },
  {
    audience: "فرد",
    direction: "قرطاسية وهدايا",
    icon: "edit",
    route: "/categories",
    tone: "sand",
  },
  {
    audience: "مكتب",
    direction: "تجهيزات العمل",
    icon: "business-center",
    route: "/categories",
    tone: "blue",
  },
  {
    audience: "شركة",
    direction: "طلب عرض للكميات",
    icon: "corporate-fare",
    route: "/request-quote",
    tone: "rose",
  },
] as const;

const FALLBACK_DISCOVERY_CATEGORIES = [
  { id: 0, name: "قرطاسية", icon: "edit" },
  { id: 0, name: "مستلزمات الدراسة", icon: "menu-book" },
  { id: 0, name: "الطباعة", icon: "print" },
  { id: 0, name: "المكتب", icon: "business-center" },
] as const;

function routeFromBanner(banner: StorefrontBanner | null) {
  const url = banner?.ctaUrl ?? "";
  const categoryMatch = url.match(/[?&]category(?:Id)?=(\d+)/i);
  if (categoryMatch) return `/categories?category=${categoryMatch[1]}` as never;
  const queryMatch = url.match(/[?&](?:search|q)=([^&]+)/i);
  if (queryMatch)
    return `/search?query=${encodeURIComponent(decodeURIComponent(queryMatch[1]))}` as never;
  return "/categories" as never;
}

export default function HomeScreen() {
  const { itemCount } = useCart();
  const { products, loading, error, refresh } = useStorefrontCatalog(
    undefined,
    undefined,
    { limit: 8 },
  );
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
  const [homeSort, setHomeSort] = useState<
    "POPULAR" | "PRICE_ASC" | "PRICE_DESC"
  >("POPULAR");

  const saleProducts = useMemo(
    () => products.filter((product) => productDiscountPercent(product) != null),
    [products],
  );
  const discoveryCategories = categories.length
    ? categories
    : FALLBACK_DISCOVERY_CATEGORIES;
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
        <View style={styles.topBar}>
          <View style={styles.brandLockup}>
            <View style={styles.brandMark}>
              <MaterialIcons color="#FFFFFF" name="storefront" size={17} />
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

        <View style={styles.searchArea}>
          <View style={styles.searchRow}>
            <MaterialIcons color="#5D746C" name="search" size={22} />
            <TextInput
              onChangeText={setQuery}
              onFocus={() => setSearchActive(true)}
              onSubmitEditing={submitSearch}
              placeholder="ابحث في المنتجات: كتاب، قرطاسية أو تجهيز"
              placeholderTextColor="#71827C"
              returnKeyType="search"
              style={styles.searchInput}
              textAlign="right"
              value={query}
            />
            <TouchableOpacity
              activeOpacity={0.8}
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

        <View style={styles.marketingCarousel}>
          <MarketingCarousel
            banners={banners}
            offers={offers}
            onPress={(banner) => router.push(routeFromBanner(banner))}
          />
        </View>

        <View style={styles.assuranceBar}>
          <View style={styles.assuranceItem}>
            <View style={styles.assuranceIcon}>
              <MaterialIcons
                color={storefrontDesign.semantic.brandStrong}
                name="local-shipping"
                size={17}
              />
            </View>
            <Text style={styles.assuranceText}>توصيل داخل العراق</Text>
          </View>
          <View style={styles.assuranceItem}>
            <View style={styles.assuranceIcon}>
              <MaterialIcons
                color={storefrontDesign.semantic.brandStrong}
                name="payments"
                size={17}
              />
            </View>
            <Text style={styles.assuranceText}>الدفع عند الاستلام</Text>
          </View>
          <View style={styles.assuranceItem}>
            <View style={styles.assuranceIcon}>
              <MaterialIcons
                color={storefrontDesign.semantic.brandStrong}
                name="verified-user"
                size={17}
              />
            </View>
            <Text style={styles.assuranceText}>سعر ومخزون مؤكدان</Text>
          </View>
        </View>

        {offers.length > 0 && (
          <ScrollView
            contentContainerStyle={styles.offerStripContent}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.offerStrip}
          >
            {offers.slice(0, 8).map((offer) => (
              <TouchableOpacity
                activeOpacity={0.85}
                key={offer.id}
                onPress={() => router.push("/categories" as never)}
                style={styles.offerChip}
              >
                <MaterialIcons color="#A34A22" name="local-offer" size={16} />
                <Text numberOfLines={1} style={styles.offerChipText}>
                  {offer.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {saleProducts.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionOverline}>خصومات منتقاة</Text>
                <Text style={styles.sectionTitle}>عروض اليوم</Text>
              </View>
              <View style={styles.salePill}>
                <MaterialIcons color="#FFFFFF" name="bolt" size={14} />
                <Text style={styles.salePillText}>وفر الآن</Text>
              </View>
            </View>
            <ScrollView
              contentContainerStyle={styles.productRail}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {saleProducts.map((product, index) => (
                <ProductCard
                  animationDelay={index * 55}
                  key={product.id}
                  onAddedToCart={() => setSideCartVisible(true)}
                  onQuickView={setQuickProduct}
                  product={product}
                  variant="rail"
                />
              ))}
            </ScrollView>
          </>
        )}

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionOverline}>ابدأ بسرعة</Text>
            <Text style={styles.sectionTitle}>تسوّق حسب القسم</Text>
            <Text style={styles.sectionHint}>
              اختصارات مرئية إلى المنتجات التي تحتاجها
            </Text>
          </View>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push("/categories" as never)}
          >
            <Text style={styles.link}>كل الأقسام</Text>
          </TouchableOpacity>
        </View>
        <ScrollView
          contentContainerStyle={styles.categoryList}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {discoveryCategories.map((category, index) => (
            <TouchableOpacity
              activeOpacity={0.85}
              key={`${category.id}-${category.name}`}
              onPress={() =>
                router.push(
                  category.id
                    ? (`/categories?category=${category.id}` as never)
                    : ("/categories" as never),
                )
              }
              style={styles.categoryItem}
            >
              <View
                style={[
                  styles.categoryIcon,
                  {
                    backgroundColor: [
                      "#E7F4EE",
                      "#FFF1D5",
                      "#EAF1FF",
                      "#FFECEF",
                    ][index % 4],
                  },
                ]}
              >
                <MaterialIcons
                  color={storefrontDesign.semantic.brandStrong}
                  name={
                    "icon" in category
                      ? category.icon
                      : (["menu-book", "edit", "school", "card-giftcard"][
                          index % 4
                        ] as never)
                  }
                  size={25}
                />
              </View>
              <Text numberOfLines={2} style={styles.categoryText}>
                {category.name}
              </Text>
              {"availableCount" in category && (
                <Text style={styles.categoryCount}>
                  {formatLatinNumber(category.availableCount)} منتج
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>

        {productsState === "READY" && homeProducts.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionOverline}>الأكثر طلباً</Text>
                <Text style={styles.sectionTitle}>منتجات يختارها العملاء</Text>
              </View>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => router.push("/categories" as never)}
              >
                <Text style={styles.link}>عرض الكل</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              contentContainerStyle={styles.productRail}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {homeProducts.slice(0, 8).map((product, index) => (
                <ProductCard
                  animationDelay={index * 45}
                  key={`popular-${product.id}`}
                  onQuickView={setQuickProduct}
                  product={product}
                  variant="rail"
                />
              ))}
            </ScrollView>
          </>
        )}

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionOverline}>مسار مخصص</Text>
            <Text style={styles.sectionTitle}>تسوّق حسب احتياجك</Text>
          </View>
        </View>
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
              style={[
                styles.pathCard,
                item.tone === "mint"
                  ? styles.pathMint
                  : item.tone === "sand"
                    ? styles.pathSand
                    : item.tone === "blue"
                      ? styles.pathBlue
                      : styles.pathRose,
              ]}
            >
              <View style={styles.pathIcon}>
                <MaterialIcons color="#183D36" name={item.icon} size={25} />
              </View>
              <Text style={styles.pathAudience}>{item.audience}</Text>
              <Text numberOfLines={2} style={styles.pathDirection}>
                {item.direction}
              </Text>
              <View style={styles.pathArrow}>
                <MaterialIcons color="#183D36" name="arrow-back" size={16} />
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.productsPanel}>
          <View style={styles.productsPanelHeader}>
            <View>
              <Text style={styles.sectionOverline}>اكتشاف ذكي</Text>
              <Text style={styles.sectionTitle}>المنتجات المختارة لك</Text>
              <Text style={styles.sectionHint}>
                اختر القسم ثم رتّب النتيجة كما تريد
              </Text>
            </View>
            <MaterialIcons
              color={storefrontDesign.semantic.brandStrong}
              name="tune"
              size={22}
            />
          </View>
          <ScrollView
            contentContainerStyle={styles.filterChips}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setHomeCategoryId(null)}
              style={[
                styles.filterChip,
                !homeCategoryId && styles.filterChipActive,
              ]}
            >
              <Text
                style={[
                  styles.filterChipText,
                  !homeCategoryId && styles.filterChipTextActive,
                ]}
              >
                الكل
              </Text>
            </TouchableOpacity>
            {categories.map((category) => (
              <TouchableOpacity
                activeOpacity={0.8}
                key={category.id}
                onPress={() => setHomeCategoryId(String(category.id))}
                style={[
                  styles.filterChip,
                  homeCategoryId === String(category.id) &&
                    styles.filterChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    homeCategoryId === String(category.id) &&
                      styles.filterChipTextActive,
                  ]}
                >
                  {category.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.sortRow}>
            {(
              [
                ["POPULAR", "الأكثر طلباً", "trending-up"],
                ["PRICE_ASC", "الأقل سعراً", "arrow-downward"],
                ["PRICE_DESC", "الأعلى سعراً", "arrow-upward"],
              ] as const
            ).map(([value, label, icon]) => (
              <TouchableOpacity
                activeOpacity={0.8}
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

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionTitle}>كل المنتجات</Text>
            <Text style={styles.sectionHint}>
              {loading
                ? "جار تجهيز المنتجات…"
                : `${formatLatinNumber(homeProducts.length)} منتج مطابق لاختيارك`}
            </Text>
          </View>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push("/categories" as never)}
          >
            <Text style={styles.link}>عرض أوسع</Text>
          </TouchableOpacity>
        </View>
        {productsState === "LOADING" ? (
          <View style={styles.loadingProducts}>
            <ActivityIndicator color="#0E806A" size="small" />
            <Text style={styles.loadingProductsText}>
              جار تحميل المنتجات المتوفرة…
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
                تحقق من اتصالك ثم أعد المحاولة. ستبقى بقية صفحات التطبيق متاحة
                لك.
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
        ) : productsState === "READY" ? (
          <View style={styles.grid}>
            {homeProducts.map((product, index) => (
              <ProductCard
                animationDelay={index * 65}
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

        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => router.push("/categories" as never)}
          style={styles.allProductsCta}
        >
          <View>
            <Text style={styles.allProductsCtaTitle}>
              استكشف مزيداً من المنتجات
            </Text>
            <Text style={styles.allProductsCtaHint}>
              تصفّح جميع الأقسام والعروض المتاحة
            </Text>
          </View>
          <View style={styles.allProductsCtaIcon}>
            <MaterialIcons color="#FFFFFF" name="arrow-back" size={19} />
          </View>
        </TouchableOpacity>
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
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: {
    alignSelf: "center",
    maxWidth: 640,
    paddingBottom: 34,
    paddingHorizontal: 16,
    width: "100%",
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 18,
    paddingTop: 5,
  },
  brandLockup: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row-reverse",
    gap: 9,
  },
  brandMark: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderRadius: 14,
    height: 39,
    justifyContent: "center",
    width: 39,
  },
  topActions: { flexDirection: "row-reverse", gap: 8 },
  eyebrow: {
    color: "#71817B",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 9,
    marginTop: -2,
    textAlign: "right",
  },
  brand: {
    color: storefrontDesign.semantic.foreground,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
    lineHeight: 27,
    textAlign: "right",
  },
  accountButton: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E4E9E4",
    borderRadius: 15,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  cartButton: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderRadius: 15,
    elevation: 3,
    height: 42,
    justifyContent: "center",
    shadowColor: "#3C78A8",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    width: 42,
  },
  badge: {
    alignItems: "center",
    backgroundColor: "#F05D53",
    borderColor: "#FFFFFF",
    borderRadius: 11,
    borderWidth: 2,
    height: 21,
    justifyContent: "center",
    position: "absolute",
    right: -7,
    top: -7,
    width: 21,
  },
  badgeText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10,
  },
  searchArea: { marginBottom: 19, zIndex: 10 },
  searchRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: storefrontDesign.semantic.border,
    borderRadius: 19,
    borderWidth: 1,
    flexDirection: "row-reverse",
    height: 58,
    paddingLeft: 8,
    paddingRight: 14,
  },
  searchInput: {
    color: "#183D36",
    flex: 1,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
    marginHorizontal: 8,
  },
  searchAction: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderRadius: 13,
    height: 41,
    justifyContent: "center",
    width: 39,
  },
  suggestions: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E9DDD1",
    borderRadius: 17,
    borderWidth: 1,
    elevation: 3,
    marginTop: 7,
    overflow: "hidden",
    shadowColor: "#173A33",
    shadowOpacity: 0.1,
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
    paddingHorizontal: 12,
    paddingTop: 11,
  },
  recentTitle: { color: "#55716A", fontFamily: "Cairo_700Bold", fontSize: 11 },
  clearRecent: { color: "#D85645", fontFamily: "Cairo_700Bold", fontSize: 11 },
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
    height: 40,
    justifyContent: "center",
    overflow: "hidden",
    width: 40,
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
    fontSize: 10,
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
  marketingCarousel: { marginHorizontal: -16 },
  assuranceBar: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E6ECE7",
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 19,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  assuranceItem: {
    alignItems: "center",
    flex: 1,
    flexDirection: "column",
    gap: 4,
  },
  assuranceIcon: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.safeSurface,
    borderRadius: 11,
    height: 31,
    justifyContent: "center",
    width: 31,
  },
  assuranceText: {
    color: "#38534C",
    fontFamily: "Cairo_700Bold",
    fontSize: 8,
    textAlign: "center",
  },
  offerStrip: { marginHorizontal: -16, marginTop: 13 },
  offerStripContent: { gap: 8, paddingHorizontal: 16 },
  offerChip: {
    alignItems: "center",
    backgroundColor: "#FFF1E4",
    borderColor: "#F2D4BC",
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 5,
    maxWidth: 220,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  offerChipText: {
    color: "#A34A22",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 13,
    marginTop: 31,
  },
  sectionOverline: {
    color: storefrontDesign.semantic.brandStrong,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9,
    letterSpacing: 0.3,
    textAlign: "right",
  },
  sectionTitle: {
    color: storefrontDesign.semantic.foreground,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 20,
    lineHeight: 31,
    textAlign: "right",
  },
  sectionHint: {
    color: "#6D7F79",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    marginTop: 2,
    textAlign: "right",
  },
  link: {
    color: storefrontDesign.semantic.brandStrong,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 11,
  },
  pathList: { gap: 10, paddingHorizontal: 1 },
  pathCard: {
    alignItems: "flex-end",
    borderRadius: 17,
    borderWidth: 1,
    minHeight: 137,
    padding: 12,
    width: 134,
  },
  pathMint: { backgroundColor: "#E7F4FE", borderColor: "#D5EAF9" },
  pathSand: { backgroundColor: "#FFF3DC", borderColor: "#F2E4C2" },
  pathBlue: { backgroundColor: "#EAF1FF", borderColor: "#D8E4F8" },
  pathRose: { backgroundColor: "#FFECEF", borderColor: "#F7DDE1" },
  pathIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.76)",
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  pathAudience: {
    color: storefrontDesign.semantic.foreground,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
    marginTop: 8,
    textAlign: "right",
  },
  pathDirection: {
    color: "#38534C",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 9,
    lineHeight: 15,
    marginTop: 2,
    textAlign: "right",
  },
  pathArrow: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderRadius: 10,
    height: 26,
    justifyContent: "center",
    marginTop: "auto",
    width: 26,
  },
  categoryList: { gap: 11, paddingLeft: 4, paddingRight: 2 },
  categoryItem: {
    alignItems: "center",
    minHeight: 107,
    paddingHorizontal: 4,
    paddingVertical: 2,
    width: 88,
  },
  categoryIcon: {
    alignItems: "center",
    borderColor: "#FFFFFF",
    borderRadius: 999,
    borderWidth: 3,
    elevation: 2,
    height: 64,
    justifyContent: "center",
    shadowColor: "#75839A",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    width: 64,
  },
  categoryText: {
    color: storefrontDesign.semantic.foreground,
    fontFamily: "Cairo_700Bold",
    fontSize: 10,
    lineHeight: 15,
    marginTop: 6,
    textAlign: "center",
  },
  categoryCount: {
    color: "#6D817A",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 8,
    marginTop: 1,
  },
  productsPanel: {
    backgroundColor: "#EEF3F9",
    borderColor: "#E0E8F1",
    borderRadius: 27,
    borderWidth: 1,
    marginTop: 28,
    padding: 16,
  },
  productsPanelHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  filterChips: {
    gap: 8,
    marginHorizontal: -2,
    marginTop: 13,
    paddingHorizontal: 2,
  },
  filterChip: {
    backgroundColor: "#FFFFFF",
    borderColor: "#DDDED8",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  filterChipActive: {
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderColor: storefrontDesign.semantic.brandStrong,
  },
  filterChipText: {
    color: "#55716A",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  filterChipTextActive: { color: "#FFFFFF" },
  sortRow: { flexDirection: "row-reverse", gap: 7, marginTop: 12 },
  sortChip: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#DDDED8",
    borderRadius: 11,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row-reverse",
    gap: 4,
    justifyContent: "center",
    minHeight: 38,
    paddingHorizontal: 3,
  },
  sortChipActive: {
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderColor: storefrontDesign.semantic.brandStrong,
  },
  sortText: { color: "#55716A", fontFamily: "Cairo_700Bold", fontSize: 9 },
  sortTextActive: { color: "#FFFFFF" },
  salePill: {
    alignItems: "center",
    backgroundColor: "#D85645",
    borderRadius: 12,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  salePillText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10,
  },
  productRail: { paddingLeft: 3 },
  grid: {
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  loadingProducts: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E6E1D9",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 9,
    justifyContent: "center",
    minHeight: 148,
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
    lineHeight: 19,
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
    borderColor: "#E6E1D9",
    borderRadius: 18,
    borderWidth: 1,
    gap: 6,
    padding: 23,
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.safeSurface,
    borderRadius: 17,
    height: 54,
    justifyContent: "center",
    marginBottom: 2,
    width: 54,
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
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  emptyActionText: {
    color: storefrontDesign.semantic.brandStrong,
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  allProductsCta: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.foreground,
    borderRadius: 18,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 17,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  allProductsCtaTitle: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
    textAlign: "right",
  },
  allProductsCtaHint: {
    color: "#D6E6DF",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
    marginTop: 2,
    textAlign: "right",
  },
  allProductsCtaIcon: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderRadius: 13,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
});
