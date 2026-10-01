import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useCart } from "@/lib/cart-context";
import { formatIqd, formatLatinNumber } from "@/lib/storefront-api";

type FloatingCartBarProps = {
  onOpenSideCart?: () => void;
  bottomOffset?: number;
};

/**
 * شريط السلة العائم الذكي (Smart Floating Cart Bar)
 * يظهر بانسيابية في منطقة الإبهام (Thumb Zone) بمجرد إضافة أي منتج،
 * ليعطي تجربة تسوق عالمية فاخرة وسريعة بدون أي تشتيت.
 */
export function FloatingCartBar({
  onOpenSideCart,
  bottomOffset,
}: FloatingCartBarProps) {
  const { itemCount, lines } = useCart();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(100)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  const subtotal = lines.reduce(
    (sum, line) =>
      sum +
      (Number(
        line.selectionDetails.unitSalePrice ??
          line.selectionDetails.unitPrice ??
          0,
      ) || 0) *
        line.quantity,
    0,
  );

  const isVisible = itemCount > 0;

  useEffect(() => {
    if (isVisible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 9,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 100,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isVisible, opacityAnim, slideAnim]);

  if (!isVisible) return null;

  const calculatedBottom =
    bottomOffset ??
    (Platform.OS === "web" ? 82 : Math.max(insets.bottom + 68, 82));

  const handlePress = () => {
    if (onOpenSideCart) {
      onOpenSideCart();
    } else {
      router.push("/cart" as never);
    }
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        {
          bottom: calculatedBottom,
          opacity: opacityAnim,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <TouchableOpacity
        accessibilityLabel={`سلة المشتريات: ${itemCount} منتج بقيمة ${formatIqd(subtotal)}. اضغط لإتمام الطلب`}
        accessibilityRole="button"
        activeOpacity={0.92}
        onPress={handlePress}
        style={styles.container}
      >
        <View style={styles.leftAction}>
          <Text style={styles.actionText}>عرض السلة</Text>
          <MaterialIcons color="#FFFFFF" name="arrow-back" size={18} />
        </View>

        <View style={styles.centerInfo}>
          <Text style={styles.priceText}>{formatIqd(subtotal)}</Text>
          <Text style={styles.itemCountText}>
            {formatLatinNumber(itemCount)} {itemCount === 1 ? "منتج" : "منتجات"}
          </Text>
        </View>

        <View style={styles.cartIconWrapper}>
          <MaterialIcons color="#0E806A" name="shopping-bag" size={20} />
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>
              {formatLatinNumber(itemCount)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    left: 16,
    position: "absolute",
    right: 16,
    zIndex: 999,
  },
  container: {
    alignItems: "center",
    backgroundColor: "#183D36",
    borderColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 22,
    borderWidth: 1,
    elevation: 8,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: "#183D36",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
  },
  cartIconWrapper: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    height: 38,
    justifyContent: "center",
    position: "relative",
    width: 38,
  },
  countBadge: {
    alignItems: "center",
    backgroundColor: "#E0533C",
    borderRadius: 10,
    height: 16,
    justifyContent: "center",
    minWidth: 16,
    paddingHorizontal: 3,
    position: "absolute",
    right: -4,
    top: -4,
  },
  countBadgeText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 9,
    lineHeight: 11,
  },
  centerInfo: {
    alignItems: "center",
    flex: 1,
    paddingHorizontal: 8,
  },
  priceText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 15,
  },
  itemCountText: {
    color: "rgba(255, 255, 255, 0.72)",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
    marginTop: -2,
  },
  leftAction: {
    alignItems: "center",
    backgroundColor: "#0E806A",
    borderRadius: 14,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
});
