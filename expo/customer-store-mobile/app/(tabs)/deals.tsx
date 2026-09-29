import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";

import { ProductCard } from "@/components/product-card";
import { ScreenContainer } from "@/components/screen-container";
import { useCart } from "@/lib/cart-context";
import {
  formatIqd,
  formatLatinNumber,
  productDiscountPercent,
  storefrontDisplayPrice,
  useStorefrontCatalog,
  useStorefrontMarketing,
} from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";
import type { Product } from "@/shared/storefront";

type DealFilter = "ALL" | "FLASH" | "UNDER_10K" | "DISCOUNTED";

export default function DealsScreen() {
  const { width } = useWindowDimensions();
  const columns = width >= 720 ? 2 : 1;
  const { itemCount } = useCart();
  const { offers } = useStorefrontMarketing(true);
  const { products, loading, error, refresh } = useStorefrontCatalog(
    undefined,
    undefined,
    { limit: 32 },
  );

  const [filter, setFilter] = useState<DealFilter>("ALL");
  const [refreshing, setRefreshing] = useState(false);

  // Live countdown timer for Flash Deals (counts down to next 6-hour cycle)
  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    const now = Math.floor(Date.now() / 1000);
    const sixHours = 6 * 3600;
    return sixHours - (now % sixHours);
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          const now = Math.floor(Date.now() / 1000);
          const sixHours = 6 * 3600;
          return sixHours - (now % sixHours);
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const hours = String(Math.floor(secondsLeft / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((secondsLeft % 3600) / 60)).padStart(2, "0");
  const seconds = String(secondsLeft % 60).padStart(2, "0");

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  // Sub-10,000 IQD products
  const sub10kProducts = useMemo(() => {
    return products.filter((p) => {
      const price = Number(p.salePrice ?? p.price ?? 0);
      return price > 0 && price <= 10000;
    });
  }, [products]);

  // Flash deals / discounted products
  const flashProducts = useMemo(() => {
    return products.filter((p) => {
      const discount = productDiscountPercent(p);
      return (
        (discount !== null && discount > 0) ||
        (p.salePrice != null && Number(p.salePrice) < Number(p.price))
      );
    });
  }, [products]);

  // Filtered products list
  const filteredProducts = useMemo(() => {
    switch (filter) {
      case "FLASH":
        return flashProducts.length > 0 ? flashProducts : products.slice(0, 8);
      case "UNDER_10K":
        return sub10kProducts.length > 0 ? sub10kProducts : products;
      case "DISCOUNTED":
        return flashProducts;
      default:
        return products;
    }
  }, [filter, products, flashProducts, sub10kProducts]);

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <FlatList
        data={filteredProducts}
        keyExtractor={(item) => String(item.id)}
        numColumns={columns}
        key={columns}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={["#059669"]}
            tintColor="#059669"
          />
        }
        ListHeaderComponent={
          <View style={styles.headerContainer}>
            {/* Top Bar */}
            <View style={styles.topBar}>
              <View style={styles.topBarText}>
                <Text style={styles.screenTitle}>عروض تفليش الأسبوع</Text>
                <Text style={styles.screenSub}>
                  عروض وكسر أسعار حقيقي — وفر فلوسك ويا الرؤية العربية
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel="عربة التسوق"
                activeOpacity={0.8}
                onPress={() => router.push("/(tabs)/cart" as never)}
                style={styles.cartBadgeBtn}
              >
                <MaterialIcons color="#065F46" name="shopping-cart" size={22} />
                {itemCount > 0 && (
                  <View style={styles.cartCounter}>
                    <Text style={styles.cartCounterText}>
                      {formatLatinNumber(itemCount)}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            {/* Hero Flash Deals Card with Live Timer */}
            <View style={styles.flashHeroCard}>
              <View style={styles.flashHeroBadgeRow}>
                <View style={styles.flashPill}>
                  <MaterialIcons color="#F59E0B" name="local-fire-department" size={16} />
                  <Text style={styles.flashPillText}>عروض تفليش ساخنة اليوم</Text>
                </View>
                <View style={styles.savingsPill}>
                  <Text style={styles.savingsPillText}>خصم حتى 50%</Text>
                </View>
              </View>

              <Text style={styles.flashHeroTitle}>
                عروض تفليش ساخنة اليوم — لحّك قبل لا تخلص العروض
              </Text>
              <Text style={styles.flashHeroSubtitle}>
                تنتهي العروض الحالية عند نفاد الكمية المخصصة أو انتهاء المؤقت.
              </Text>

              {/* Dynamic Countdown Display */}
              <View style={styles.timerRow}>
                <Text style={styles.timerPrefix}>ينتهي العرض بعد:</Text>
                <View style={styles.clockContainer}>
                  <View style={styles.clockUnit}>
                    <Text style={styles.clockDigits}>{hours}</Text>
                    <Text style={styles.clockLabel}>ساعة</Text>
                  </View>
                  <Text style={styles.clockSeparator}>:</Text>
                  <View style={styles.clockUnit}>
                    <Text style={styles.clockDigits}>{minutes}</Text>
                    <Text style={styles.clockLabel}>دقيقة</Text>
                  </View>
                  <Text style={styles.clockSeparator}>:</Text>
                  <View style={styles.clockUnit}>
                    <Text style={styles.clockDigits}>{seconds}</Text>
                    <Text style={styles.clockLabel}>ثانية</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Sub-10,000 IQD Section Highlight Banner */}
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => setFilter("UNDER_10K")}
              style={[
                styles.budgetCard,
                filter === "UNDER_10K" && styles.budgetCardActive,
              ]}
            >
              <View style={styles.budgetCardRight}>
                <View style={styles.budgetIconWrap}>
                  <MaterialIcons color="#10B981" name="savings" size={24} />
                </View>
                <View style={styles.budgetTextWrap}>
                  <View style={styles.budgetTitleRow}>
                    <Text style={styles.budgetTitle}>عروض أقل من 10,000 د.ع (عروض تفليش)</Text>
                    <View style={styles.budgetTag}>
                      <Text style={styles.budgetTagText}>وفر فلوسك</Text>
                    </View>
                  </View>
                  <Text style={styles.budgetSub}>
                    مسواك وقرطاسية بجودة عالية وأسعار كسر تناسب جيبك
                  </Text>
                </View>
              </View>
              <MaterialIcons color="#059669" name="chevron-left" size={24} />
            </TouchableOpacity>

            {/* Marketing Offers Pills (if available) */}
            {offers.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.offersRow}
                style={styles.offersScroller}
              >
                {offers.map((offer) => (
                  <View key={offer.id} style={styles.offerBadge}>
                    <MaterialIcons color="#D97706" name="local-offer" size={14} />
                    <Text style={styles.offerBadgeText}>{offer.name}</Text>
                  </View>
                ))}
              </ScrollView>
            )}

            {/* Filter Tabs */}
            <View style={styles.filterBar}>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setFilter("ALL")}
                style={[styles.filterChip, filter === "ALL" && styles.filterChipActive]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    filter === "ALL" && styles.filterChipTextActive,
                  ]}
                >
                  جميع العروض
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setFilter("FLASH")}
                style={[
                  styles.filterChip,
                  filter === "FLASH" && styles.filterChipActive,
                ]}
              >
                <MaterialIcons
                  color={filter === "FLASH" ? "#FFFFFF" : "#F59E0B"}
                  name="local-fire-department"
                  size={14}
                />
                <Text
                  style={[
                    styles.filterChipText,
                    filter === "FLASH" && styles.filterChipTextActive,
                  ]}
                >
                  عروض حارّة
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setFilter("UNDER_10K")}
                style={[
                  styles.filterChip,
                  filter === "UNDER_10K" && styles.filterChipActive,
                ]}
              >
                <MaterialIcons
                  color={filter === "UNDER_10K" ? "#FFFFFF" : "#10B981"}
                  name="sell"
                  size={14}
                />
                <Text
                  style={[
                    styles.filterChipText,
                    filter === "UNDER_10K" && styles.filterChipTextActive,
                  ]}
                >
                  أقل من 10k
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setFilter("DISCOUNTED")}
                style={[
                  styles.filterChip,
                  filter === "DISCOUNTED" && styles.filterChipActive,
                ]}
              >
                <MaterialIcons
                  color={filter === "DISCOUNTED" ? "#FFFFFF" : "#059669"}
                  name="percent"
                  size={14}
                />
                <Text
                  style={[
                    styles.filterChipText,
                    filter === "DISCOUNTED" && styles.filterChipTextActive,
                  ]}
                >
                  أعلى خصم
                </Text>
              </TouchableOpacity>
            </View>

            {loading && (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color="#059669" size="small" />
                <Text style={styles.loadingText}>جارٍ تحميل أحدث العروض...</Text>
              </View>
            )}
          </View>
        }
        renderItem={({ item, index }) => (
          <View style={[styles.cardItem, columns > 1 && styles.cardItemHalf]}>
            <ProductCard product={item} animationDelay={index * 40} fullWidth />
          </View>
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <View style={styles.emptyIconWrap}>
                <MaterialIcons color="#059669" name="local-offer" size={32} />
              </View>
              <Text style={styles.emptyTitle}>لا توجد عروض حالية في هذا القسم</Text>
              <Text style={styles.emptySubtitle}>
                يتم تحديث العروض والتخفيضات باستمرار. تصفح بقية الأقسام للاستفادة من أفضل الأسعار.
              </Text>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setFilter("ALL")}
                style={styles.emptyButton}
              >
                <Text style={styles.emptyButtonText}>عرض كل العروض</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 96,
  },
  headerContainer: {
    marginBottom: 12,
  },
  topBar: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
    marginTop: 4,
  },
  topBarText: {
    flex: 1,
  },
  screenTitle: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 22,
    textAlign: "right",
  },
  screenSub: {
    color: "#64748B",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    marginTop: 2,
    textAlign: "right",
  },
  cartBadgeBtn: {
    alignItems: "center",
    backgroundColor: "rgba(5, 150, 105, 0.08)",
    borderColor: "rgba(5, 150, 105, 0.2)",
    borderRadius: 14,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    position: "relative",
    width: 42,
  },
  cartCounter: {
    alignItems: "center",
    backgroundColor: "#EF4444",
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    minWidth: 18,
    paddingHorizontal: 4,
    position: "absolute",
    right: -4,
    top: -4,
  },
  cartCounterText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10,
    lineHeight: 14,
  },
  flashHeroCard: {
    backgroundColor: "#0F172A",
    borderColor: "rgba(16, 185, 129, 0.3)",
    borderRadius: 22,
    borderWidth: 1.5,
    padding: 18,
    shadowColor: "#059669",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
    marginBottom: 14,
  },
  flashHeroBadgeRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  flashPill: {
    flexDirection: "row-reverse",
    alignItems: "center",
    backgroundColor: "rgba(245, 158, 11, 0.18)",
    borderColor: "rgba(245, 158, 11, 0.35)",
    borderRadius: 20,
    borderWidth: 1,
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  flashPillText: {
    color: "#FBBF24",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  savingsPill: {
    backgroundColor: "#059669",
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  savingsPillText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10,
  },
  flashHeroTitle: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
    marginBottom: 4,
    textAlign: "right",
  },
  flashHeroSubtitle: {
    color: "#94A3B8",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    lineHeight: 18,
    textAlign: "right",
    marginBottom: 14,
  },
  timerRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: "space-between",
  },
  timerPrefix: {
    color: "#CBD5E1",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  clockContainer: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
  },
  clockUnit: {
    alignItems: "center",
    backgroundColor: "#1E293B",
    borderColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 38,
    paddingVertical: 2,
  },
  clockDigits: {
    color: "#34D399",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
  },
  clockLabel: {
    color: "#94A3B8",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 8,
    marginTop: -2,
  },
  clockSeparator: {
    color: "#34D399",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
  },
  budgetCard: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 14,
    padding: 14,
  },
  budgetCardActive: {
    borderColor: "#10B981",
    borderWidth: 2,
  },
  budgetCardRight: {
    flexDirection: "row-reverse",
    alignItems: "center",
    flex: 1,
    gap: 12,
  },
  budgetIconWrap: {
    alignItems: "center",
    backgroundColor: "#DCFCE7",
    borderRadius: 14,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  budgetTextWrap: {
    flex: 1,
  },
  budgetTitleRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 6,
  },
  budgetTitle: {
    color: "#065F46",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    textAlign: "right",
  },
  budgetTag: {
    backgroundColor: "#059669",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  budgetTagText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 8.5,
  },
  budgetSub: {
    color: "#047857",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
    marginTop: 2,
    textAlign: "right",
  },
  offersScroller: {
    marginBottom: 12,
  },
  offersRow: {
    flexDirection: "row-reverse",
    gap: 8,
    paddingHorizontal: 2,
  },
  offerBadge: {
    flexDirection: "row-reverse",
    alignItems: "center",
    backgroundColor: "#FEF3C7",
    borderColor: "#FDE68A",
    borderRadius: 12,
    borderWidth: 1,
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  offerBadgeText: {
    color: "#92400E",
    fontFamily: "Cairo_700Bold",
    fontSize: 10.5,
  },
  filterBar: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  filterChip: {
    flexDirection: "row-reverse",
    alignItems: "center",
    backgroundColor: "#F1F5F9",
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterChipActive: {
    backgroundColor: "#059669",
    borderColor: "#059669",
  },
  filterChipText: {
    color: "#475569",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  filterChipTextActive: {
    color: "#FFFFFF",
  },
  loadingWrap: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
  },
  loadingText: {
    color: "#64748B",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  cardItem: {
    marginBottom: 12,
    width: "100%",
  },
  cardItemHalf: {
    paddingHorizontal: 4,
    width: "50%",
  },
  emptyContainer: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 20,
    padding: 24,
  },
  emptyIconWrap: {
    alignItems: "center",
    backgroundColor: "#E2E8F0",
    borderRadius: 28,
    height: 56,
    justifyContent: "center",
    marginBottom: 12,
    width: 56,
  },
  emptyTitle: {
    color: "#1E293B",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 15,
    marginBottom: 6,
    textAlign: "center",
  },
  emptySubtitle: {
    color: "#64748B",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    lineHeight: 18,
    textAlign: "center",
  },
  emptyButton: {
    backgroundColor: "#059669",
    borderRadius: 14,
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  emptyButtonText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
});
