import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
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
  useStorefrontSettings,
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

const STORE_OCCASIONS = [
  { id: "grad", label: "تخرج", icon: "school", color: "#FFF1F2", textColor: "#E11D48", borderColor: "#FECDD3" },
  { id: "bday", label: "أعياد ميلاد", icon: "cake", color: "#FEF3C7", textColor: "#D97706", borderColor: "#FDE68A" },
  { id: "school", label: "المدارس", icon: "backpack", color: "#DCFCE7", textColor: "#059669", borderColor: "#BBF7D0" },
  { id: "office", label: "المكاتب", icon: "business-center", color: "#E0E7FF", textColor: "#4F46E5", borderColor: "#C7D2FE" },
  { id: "kids", label: "الأطفال", icon: "child-care", color: "#FCE7F3", textColor: "#DB2777", borderColor: "#FBCFE8" },
  { id: "art", label: "المواهب", icon: "palette", color: "#FEF9C3", textColor: "#CA8A04", borderColor: "#FEF08A" },
  { id: "wedding", label: "زفاف وإهداء", icon: "favorite", color: "#FFFBEB", textColor: "#B45309", borderColor: "#FDE68A" },
  { id: "journal", label: "يوميات وتأمل", icon: "self-improvement", color: "#F3E8FF", textColor: "#9333EA", borderColor: "#E9D5FF" },
] as const;

const CATEGORY_TINTS = [
  { bg: "#ECFDF5", border: "#A7F3D0", iconColor: "#059669" },
  { bg: "#FFF7ED", border: "#FED7AA", iconColor: "#EA580C" },
  { bg: "#FAF5FF", border: "#E9D5FF", iconColor: "#9333EA" },
  { bg: "#FFF1F2", border: "#FECDD3", iconColor: "#E11D48" },
  { bg: "#EFF6FF", border: "#BFDBFE", iconColor: "#2563EB" },
  { bg: "#FDF2F8", border: "#FBCFE8", iconColor: "#DB2777" },
];

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

  const settings = useStorefrontSettings();
  const openWhatsAppPrinting = async () => {
    const rawNumber = settings?.whatsappNumber?.replace(/\D/g, "");
    if (!rawNumber) {
      Alert.alert(
        "تواصل معنا",
        "يمكنك التواصل مع خدمة الزبائن للاستفسار عن خدمات وتصاميم الطباعة الخاصة.",
      );
      return;
    }
    const message = "مرحباً مكتبة العربية، أود الاستفسار عن خدمات الطباعة والتصاميم الخاصة.";
    const url = `https://wa.me/${rawNumber}?text=${encodeURIComponent(message)}`;
    try {
      const can = await Linking.canOpenURL(url);
      if (can) await Linking.openURL(url);
      else Alert.alert("واتساب", "تأكد من وجود تطبيق واتساب على جهازك للتواصل المباشر.");
    } catch {
      Alert.alert("واتساب", "تعذر فتح تطبيق واتساب حالياً.");
    }
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
                color="#059669"
                name="local-shipping"
                size={18}
              />
            </View>
            <Text style={styles.assuranceText}>توصيل سريع للمحافظات</Text>
          </View>
          <View style={styles.assuranceDivider} />
          <View style={styles.assuranceItem}>
            <View style={styles.assuranceIcon}>
              <MaterialIcons
                color="#059669"
                name="payments"
                size={18}
              />
            </View>
            <Text style={styles.assuranceText}>الدفع عند الاستلام</Text>
          </View>
          <View style={styles.assuranceDivider} />
          <View style={styles.assuranceItem}>
            <View style={styles.assuranceIcon}>
              <MaterialIcons
                color="#059669"
                name="verified-user"
                size={18}
              />
            </View>
            <Text style={styles.assuranceText}>ضمان وجودة معتمدة</Text>
          </View>
        </View>

        {/* خدمة الطباعة المتخصصة والتجهيز المكتبي — Scribble-Style Vibrant Gift Box & Printing Banner */}
        <TouchableOpacity
          accessibilityLabel="باقات الإهداء والطباعة المخصصة عبر واتساب"
          accessibilityRole="button"
          activeOpacity={0.9}
          onPress={openWhatsAppPrinting}
          style={styles.whatsappBanner}
        >
          <View style={styles.whatsappBannerRight}>
            <View style={styles.whatsappBannerIcon}>
              <MaterialIcons color="#FFFFFF" name="card-giftcard" size={26} />
            </View>
            <View style={styles.whatsappBannerText}>
              <View style={styles.whatsappBadgeRow}>
                <Text style={styles.whatsappTag}>🎁 باقات الإهداء والطباعة المخصصة</Text>
              </View>
              <Text style={styles.whatsappBannerTitle}>
                اصنع هديتك وملازمك لكل مناسبة!
              </Text>
              <Text style={styles.whatsappBannerSub}>
                طباعة بحوث، ملازم دراسية، وتجهيزات الشركات والمدارس مع تسعير فوري
              </Text>
            </View>
          </View>
          <View style={styles.whatsappActionRow}>
            <View style={styles.whatsappBadge}>
              <MaterialIcons color="#7C5CFC" name="chat" size={16} />
              <Text style={styles.whatsappBadgeText}>تواصل مع فريق الطباعة والإهداء عبر واتساب</Text>
            </View>
          </View>
        </TouchableOpacity>

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
              كبسولات قرطاسية مبهجة ومختارات معتمدة
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
          {discoveryCategories.map((category, index) => {
            const tint = CATEGORY_TINTS[index % CATEGORY_TINTS.length];
            return (
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
                    { backgroundColor: tint.bg, borderColor: tint.border },
                  ]}
                >
                  <MaterialIcons
                    color={tint.iconColor}
                    name={
                      "icon" in category
                        ? category.icon
                        : (["menu-book", "edit", "school", "card-giftcard"][
                            index % 4
                          ] as never)
                    }
                    size={26}
                  />
                </View>
                <Text numberOfLines={1} style={styles.categoryText}>
                  {category.name}
                </Text>
                {"availableCount" in category && (
                  <View style={styles.categoryCountBadge}>
                    <Text style={styles.categoryCountText}>
                      {formatLatinNumber(category.availableCount)} منتج
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Occasions Section (المناسبات الخاصة — من تطبيق Scribble المرجعي) */}
        <View style={styles.occasionsSection}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionOverline}>باقات الإهداء والتجهيز</Text>
              <Text style={styles.sectionTitle}>تسوّق حسب المناسبة</Text>
              <Text style={styles.sectionHint}>
                هدايا وقرطاسية مخصصة لكل مناسبة
              </Text>
            </View>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => router.push("/categories" as never)}
            >
              <Text style={styles.link}>عرض الكل</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            contentContainerStyle={styles.occasionsList}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {STORE_OCCASIONS.map((occ) => (
              <TouchableOpacity
                activeOpacity={0.85}
                key={occ.id}
                onPress={() => router.push("/categories" as never)}
                style={styles.occasionItem}
              >
                <View
                  style={[
                    styles.occasionCircle,
                    { backgroundColor: occ.color, borderColor: occ.borderColor },
                  ]}
                >
                  <MaterialIcons
                    color={occ.textColor}
                    name={occ.icon as never}
                    size={22}
                  />
                </View>
                <Text numberOfLines={1} style={styles.occasionLabel}>
                  {occ.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

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
              style={styles.pathCard}
            >
              <View style={styles.pathIcon}>
                <MaterialIcons color="#0F172A" name={item.icon} size={22} />
              </View>
              <Text style={styles.pathAudience}>{item.audience}</Text>
              <Text numberOfLines={2} style={styles.pathDirection}>
                {item.direction}
              </Text>
              <View style={styles.pathArrow}>
                <MaterialIcons color="#059669" name="arrow-back" size={15} />
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
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1.5,
    flexDirection: "row-reverse",
    height: 52,
    paddingLeft: 6,
    paddingRight: 14,
    shadowColor: "#0F172A",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
  searchInput: {
    color: "#0F172A",
    flex: 1,
    fontFamily: "Cairo_500Medium",
    fontSize: 13,
    marginHorizontal: 8,
  },
  searchAction: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderRadius: 14,
    height: 40,
    justifyContent: "center",
    width: 40,
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
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 18,
    paddingHorizontal: 12,
    paddingVertical: 12,
    shadowColor: "#0F172A",
    shadowOpacity: 0.02,
    shadowRadius: 8,
    elevation: 1,
  },
  assuranceDivider: {
    backgroundColor: "#E2E8F0",
    height: 28,
    width: 1,
  },
  assuranceItem: {
    alignItems: "center",
    flex: 1,
    flexDirection: "column",
    gap: 4,
  },
  assuranceIcon: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 12,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  assuranceText: {
    color: "#0F172A",
    fontFamily: "Cairo_700Bold",
    fontSize: 10,
    textAlign: "center",
    marginTop: 3,
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
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1,
    minHeight: 140,
    padding: 14,
    width: 138,
    shadowColor: "#0F172A",
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1,
  },
  pathIcon: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 14,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  pathAudience: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
    marginTop: 10,
    textAlign: "right",
  },
  pathDirection: {
    color: "#64748B",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
    lineHeight: 16,
    marginTop: 3,
    textAlign: "right",
  },
  pathArrow: {
    alignItems: "center",
    backgroundColor: "#ECFDF5",
    borderRadius: 10,
    height: 26,
    justifyContent: "center",
    marginTop: "auto",
    width: 26,
  },
  categoryList: { gap: 12, paddingLeft: 4, paddingRight: 2 },
  categoryItem: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1,
    minHeight: 114,
    paddingHorizontal: 8,
    paddingVertical: 10,
    width: 92,
    shadowColor: "#0F172A",
    shadowOpacity: 0.02,
    shadowRadius: 6,
    elevation: 1,
  },
  categoryIcon: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 16,
    borderWidth: 1,
    height: 52,
    justifyContent: "center",
    width: 52,
  },
  categoryText: {
    color: "#0F172A",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 8,
    textAlign: "center",
  },
  categoryCountBadge: {
    backgroundColor: "#F1F5F9",
    borderRadius: 6,
    marginTop: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  categoryCountText: {
    color: "#475569",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 9,
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
  whatsappBanner: {
    backgroundColor: "#7C5CFC",
    borderColor: "rgba(255, 255, 255, 0.25)",
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 20,
    padding: 18,
    gap: 14,
    shadowColor: "#7C5CFC",
    shadowOpacity: 0.25,
    shadowRadius: 14,
    elevation: 4,
  },
  whatsappBannerRight: {
    flexDirection: "row-reverse",
    alignItems: "flex-start",
    gap: 14,
  },
  whatsappBannerIcon: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    borderRadius: 16,
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  whatsappBannerText: {
    flex: 1,
  },
  whatsappBadgeRow: {
    flexDirection: "row-reverse",
    marginBottom: 4,
  },
  whatsappTag: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    borderRadius: 8,
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  whatsappBannerTitle: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "right",
  },
  whatsappBannerSub: {
    color: "#E0E7FF",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 3,
    textAlign: "right",
  },
  whatsappActionRow: {
    marginTop: 2,
  },
  whatsappBadge: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 11,
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  whatsappBadgeText: {
    color: "#7C5CFC",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 12,
  },
  occasionsSection: {
    marginTop: 10,
  },
  occasionsList: {
    gap: 12,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  occasionItem: {
    alignItems: "center",
    width: 68,
  },
  occasionCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
    marginBottom: 6,
  },
  occasionLabel: {
    color: "#334155",
    fontFamily: "Cairo_700Bold",
    fontSize: 10,
    textAlign: "center",
  },
});
