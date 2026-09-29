import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { useCart } from "@/lib/cart-context";
import {
  formatIqd,
  productDiscountPercent,
  storefrontDisplayPrice,
} from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";
import type { Product } from "@/shared/storefront";

export type CountdownResult = {
  formatted: string;
  hours: number;
  minutes: number;
  seconds: number;
  isExpired: boolean;
};

export function formatDealsCountdown(msRemaining: number): CountdownResult {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) {
    return {
      formatted: "00:00:00",
      hours: 0,
      minutes: 0,
      seconds: 0,
      isExpired: true,
    };
  }
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (num: number) => String(num).padStart(2, "0");
  return {
    formatted: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
    hours,
    minutes,
    seconds,
    isExpired: false,
  };
}

export function isSub10kDeal(product: Product): boolean {
  const priceToEvaluate = product.salePrice ?? product.price;
  if (!priceToEvaluate) return false;
  const numPrice = Number(priceToEvaluate);
  return Number.isFinite(numPrice) && numPrice > 0 && numPrice < 10000;
}

type FlashDealsRailProps = {
  products: Product[];
  durationMs?: number;
  onQuickAddProduct?: (product: Product) => void;
  onViewAll?: () => void;
  title?: string;
  liveLabel?: string;
};

export function FlashDealsRail({
  products,
  durationMs = 5 * 3600 * 1000 + 34 * 60 * 1000 + 20 * 1000, // 05:34:20
  onQuickAddProduct,
  onViewAll,
  title = "عروض تفليش ساخنة اليوم — لحّك قبل لا تخلص العروض", // Contract: عروض تفليش ساخنة اليوم — لحّك قبل لا تخلص الصفقات
  liveLabel = "عروض تفليش ساخنة اليوم",
}: FlashDealsRailProps) {
  const { addProduct } = useCart();
  const [msRemaining, setMsRemaining] = useState(durationMs);

  useEffect(() => {
    const timer = setInterval(() => {
      setMsRemaining((prev) => (prev > 1000 ? prev - 1000 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const countdown = formatDealsCountdown(msRemaining);

  const handleQuickAdd = (product: Product) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => undefined,
    );
    addProduct(product, 1);
    if (onQuickAddProduct) {
      onQuickAddProduct(product);
    }
  };

  const openProduct = (product: Product) => {
    router.push(`/product/${product.id}` as never);
  };

  if (!products || products.length === 0) return null;

  return (
    <View style={styles.container}>
      {/* Deals Header with Live Countdown Timer */}
      <View style={styles.header}>
        <View style={styles.headerRight}>
          <View style={styles.liveBadgeRow}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>{liveLabel}</Text>
          </View>
          <Text style={styles.title}>{title}</Text>
        </View>

        {/* Live Countdown Timer Digits */}
        <View style={styles.countdownContainer}>
          <View style={styles.timeUnit}>
            <Text style={styles.timeDigit}>
              {String(countdown.seconds).padStart(2, "0")}
            </Text>
            <Text style={styles.timeUnitLabel}>ثانية</Text>
          </View>
          <Text style={styles.timeSeparator}>:</Text>
          <View style={styles.timeUnit}>
            <Text style={styles.timeDigit}>
              {String(countdown.minutes).padStart(2, "0")}
            </Text>
            <Text style={styles.timeUnitLabel}>دقيقة</Text>
          </View>
          <Text style={styles.timeSeparator}>:</Text>
          <View style={styles.timeUnit}>
            <Text style={styles.timeDigit}>
              {String(countdown.hours).padStart(2, "0")}
            </Text>
            <Text style={styles.timeUnitLabel}>ساعة</Text>
          </View>
        </View>
      </View>

      {/* Horizontal Carousel of Deal Cards */}
      <ScrollView
        contentContainerStyle={styles.railContent}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {products.map((product) => {
          const discount = productDiscountPercent(product);
          return (
            <View key={`flash-${product.id}`} style={styles.card}>
              <TouchableOpacity
                accessibilityLabel={`عرض ${product.title}`}
                activeOpacity={0.88}
                onPress={() => openProduct(product)}
                style={styles.cardPress}
              >
                {/* Product Image & Badges */}
                <View style={styles.imageContainer}>
                  {product.imageUrl ? (
                    <Image
                      cachePolicy="memory-disk"
                      contentFit="contain"
                      source={product.imageUrl}
                      style={styles.image}
                      transition={100}
                    />
                  ) : (
                    <MaterialIcons
                      color={storefrontDesign.semantic.brand}
                      name={product.icon}
                      size={48}
                    />
                  )}

                  {discount != null && (
                    <View style={styles.discountBadge}>
                      <Text style={styles.discountText}>وفر {discount}%</Text>
                    </View>
                  )}

                  <View style={styles.flashChip}>
                    <MaterialIcons color="#EF4444" name="bolt" size={12} />
                    <Text style={styles.flashChipText}>عرض تفليش</Text>
                  </View>
                </View>

                {/* Product Copy */}
                <View style={styles.copy}>
                  <Text numberOfLines={2} style={styles.productTitle}>
                    {product.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.productSubtitle}>
                    {product.brand ?? product.subtitle}
                  </Text>
                </View>
              </TouchableOpacity>

              {/* Price and Circular Quick-Add Button */}
              <View style={styles.footer}>
                <View style={styles.priceColumn}>
                  <Text style={styles.price}>
                    {formatIqd(storefrontDisplayPrice(product))}
                  </Text>
                  {discount != null && (
                    <Text style={styles.oldPrice}>
                      {formatIqd(product.price)}
                    </Text>
                  )}
                </View>

                {/* Circular Quick-Add (+) Button */}
                <TouchableOpacity
                  accessibilityHint="خلّيها بالسلة — يضيف المنتج مباشرة لمسواكك دون مقاطعة التصفح"
                  accessibilityLabel={`خلّيها بالسلة: ${product.title}`}
                  accessibilityRole="button"
                  activeOpacity={0.8}
                  onPress={() => handleQuickAdd(product)}
                  style={styles.quickAddCircle}
                >
                  <MaterialIcons
                    color={storefrontDesign.primitive.white}
                    name="add"
                    size={22}
                  />
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 14,
    width: "100%",
  },
  header: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerRight: {
    alignItems: "flex-end",
  },
  liveBadgeRow: {
    alignItems: "center",
    backgroundColor: "#FEE2E2",
    borderRadius: 8,
    flexDirection: "row-reverse",
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  liveDot: {
    backgroundColor: "#EF4444",
    borderRadius: 4,
    height: 6,
    width: 6,
  },
  liveBadgeText: {
    color: "#B91C1C",
    fontFamily: "Cairo_700Bold",
    fontSize: 9.5,
  },
  title: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
    marginTop: 2,
    textAlign: "right",
  },
  countdownContainer: {
    alignItems: "center",
    backgroundColor: "#0F172A",
    borderRadius: 14,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  timeUnit: {
    alignItems: "center",
    minWidth: 26,
  },
  timeDigit: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    lineHeight: 16,
  },
  timeUnitLabel: {
    color: "#94A3B8",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 7.5,
    marginTop: -2,
  },
  timeSeparator: {
    color: "#F59E0B",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 12,
    marginHorizontal: -1,
  },
  railContent: {
    flexDirection: "row-reverse",
    gap: 12,
    paddingHorizontal: 2,
    paddingVertical: 4,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1,
    elevation: 3,
    overflow: "hidden",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    width: 190,
  },
  cardPress: {
    flex: 1,
  },
  imageContainer: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    height: 140,
    justifyContent: "center",
    padding: 8,
    position: "relative",
  },
  image: {
    height: "100%",
    width: "100%",
  },
  discountBadge: {
    backgroundColor: "#EF4444",
    borderRadius: 999,
    left: 8,
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    position: "absolute",
    top: 8,
  },
  discountText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9,
  },
  flashChip: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.92)",
    borderColor: "#FEE2E2",
    borderRadius: 8,
    borderWidth: 1,
    bottom: 6,
    flexDirection: "row-reverse",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    position: "absolute",
    right: 6,
  },
  flashChipText: {
    color: "#991B1B",
    fontFamily: "Cairo_700Bold",
    fontSize: 8.5,
  },
  copy: {
    minHeight: 58,
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  productTitle: {
    color: "#0F172A",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "right",
  },
  productSubtitle: {
    color: "#64748B",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    marginTop: 2,
    textAlign: "right",
  },
  footer: {
    alignItems: "center",
    borderTopColor: "#F1F5F9",
    borderTopWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  priceColumn: {
    flex: 1,
  },
  price: {
    color: "#059669",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    textAlign: "right",
  },
  oldPrice: {
    color: "#94A3B8",
    fontFamily: "Cairo_400Regular",
    fontSize: 9,
    marginTop: 1,
    textAlign: "right",
    textDecorationLine: "line-through",
  },
  quickAddCircle: {
    alignItems: "center",
    backgroundColor: "#059669",
    borderRadius: 20,
    elevation: 3,
    height: 38,
    justifyContent: "center",
    shadowColor: "#059669",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    width: 38,
  },
});
