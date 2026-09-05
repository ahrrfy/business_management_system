import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { formatIqd } from "@/lib/storefront-api";
import {
  findTrustedRecentOrder,
  loadRecentOrders,
  type RecentStorefrontOrder,
} from "@/lib/recent-orders";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default function OrderConfirmationScreen() {
  const params = useLocalSearchParams<{
    orderNumber?: string | string[];
  }>();
  const requestedOrderNumber = firstParam(params.orderNumber).toUpperCase();
  const [order, setOrder] = useState<RecentStorefrontOrder | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void loadRecentOrders()
      .then((orders) => {
        setOrder(findTrustedRecentOrder(orders, requestedOrderNumber));
      })
      .finally(() => setLoading(false));
  }, [requestedOrderNumber]);

  const track = () => {
    if (!order) return;
    router.replace({
      pathname: "/orders",
      params: { orderNumber: order.orderNumber },
    } as never);
  };
  const share = async () => {
    if (!order) return;
    await Share.share({
      message: `تم استلام طلبي من مكتبة العربية\nرقم الطلب: ${order.orderNumber}\nالإجمالي: ${formatIqd(order.total)}\nالدفع نقداً عند الاستلام`,
    });
  };

  if (loading) {
    return (
      <ScreenContainer
        className="items-center justify-center"
        containerClassName="bg-background"
      >
        <ActivityIndicator color="#0C5A4B" size="large" />
      </ScreenContainer>
    );
  }
  if (!order) {
    return (
      <ScreenContainer
        className="items-center justify-center px-6"
        containerClassName="bg-background"
      >
        <Text style={styles.emptyTitle}>لا يوجد طلب حديث محفوظ</Text>
        <TouchableOpacity
          onPress={() => router.replace("/" as never)}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>العودة إلى المتجر</Text>
        </TouchableOpacity>
      </ScreenContainer>
    );
  }

  const expires = new Date(order.reservationExpiresAt);
  const expiryLabel = Number.isFinite(expires.getTime())
    ? new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(expires)
    : "خلال 24 ساعة";

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.successIcon}>
          <MaterialIcons color="#FFFFFF" name="check" size={39} />
        </View>
        <Text style={styles.eyebrow}>تم استلام الطلب بنجاح</Text>
        <Text style={styles.title}>شكراً لاختيارك مكتبة العربية</Text>
        <Text style={styles.subtitle}>
          حفظنا رقم طلبك على هذا الجهاز، ويمكنك فتح التتبع مباشرة من هنا أو من
          «طلباتي».
        </Text>

        <View style={styles.orderCard}>
          <Text style={styles.cardLabel}>رقم الطلب</Text>
          <Text selectable style={styles.orderNumber}>
            {order.orderNumber}
          </Text>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.value}>{formatIqd(order.total)}</Text>
            <Text style={styles.label}>الإجمالي النهائي</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.value}>نقداً عند الاستلام</Text>
            <Text style={styles.label}>طريقة الدفع</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.value}>{expiryLabel}</Text>
            <Text style={styles.label}>حجز المخزون حتى</Text>
          </View>
        </View>

        <View style={styles.infoCard}>
          <MaterialIcons color="#0C5A4B" name="support-agent" size={22} />
          <Text style={styles.infoText}>
            سيتواصل فريق المكتبة لتأكيد العنوان قبل التسليم. لا تدفع أي مبلغ قبل
            استلام الطلب والتحقق منه.
          </Text>
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.88}
          onPress={track}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>تتبع الطلب الآن</Text>
          <MaterialIcons color="#FFFFFF" name="local-shipping" size={20} />
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.84}
          onPress={share}
          style={styles.secondary}
        >
          <Text style={styles.secondaryText}>مشاركة تفاصيل الطلب</Text>
          <MaterialIcons color="#0C5A4B" name="share" size={19} />
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.8}
          onPress={() => router.replace("/" as never)}
          style={styles.linkButton}
        >
          <Text style={styles.linkText}>متابعة التسوق</Text>
        </TouchableOpacity>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: "center",
    padding: 20,
    paddingBottom: 42,
    paddingTop: 34,
  },
  successIcon: {
    alignItems: "center",
    backgroundColor: "#0C725D",
    borderRadius: 32,
    height: 64,
    justifyContent: "center",
    width: 64,
  },
  eyebrow: {
    color: "#0C725D",
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    marginTop: 17,
  },
  title: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 24,
    lineHeight: 34,
    marginTop: 5,
    textAlign: "center",
  },
  subtitle: {
    color: "#5D756B",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 21,
    marginTop: 8,
    maxWidth: 340,
    textAlign: "center",
  },
  orderCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#DFE8E2",
    borderRadius: 22,
    borderWidth: 1,
    marginTop: 22,
    padding: 17,
    width: "100%",
  },
  cardLabel: {
    color: "#6A7E75",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    textAlign: "center",
  },
  orderNumber: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 25,
    letterSpacing: 1,
    marginTop: 5,
    textAlign: "center",
  },
  divider: { backgroundColor: "#E7ECE8", height: 1, marginVertical: 15 },
  row: {
    alignItems: "flex-start",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 10,
  },
  label: {
    color: "#64786F",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    textAlign: "right",
  },
  value: {
    color: "#25493E",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
    maxWidth: "62%",
    textAlign: "left",
  },
  infoCard: {
    alignItems: "flex-start",
    backgroundColor: "#E7F1EC",
    borderRadius: 16,
    flexDirection: "row-reverse",
    gap: 9,
    marginTop: 14,
    padding: 13,
    width: "100%",
  },
  infoText: {
    color: "#385A4F",
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    lineHeight: 19,
    textAlign: "right",
  },
  primary: {
    alignItems: "center",
    backgroundColor: "#0C5A4B",
    borderRadius: 16,
    flexDirection: "row-reverse",
    gap: 8,
    height: 56,
    justifyContent: "center",
    marginTop: 18,
    width: "100%",
  },
  primaryText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
  },
  secondary: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#0C5A4B",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 8,
    height: 54,
    justifyContent: "center",
    marginTop: 10,
    width: "100%",
  },
  secondaryText: {
    color: "#0C5A4B",
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  linkButton: { paddingHorizontal: 20, paddingVertical: 15 },
  linkText: { color: "#4C6B60", fontFamily: "Cairo_700Bold", fontSize: 12 },
  emptyTitle: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
    textAlign: "center",
  },
});
