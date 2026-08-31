import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { loadVerifiedCustomerSession } from "@/lib/customer-session";
import { loadRecentOrders, type RecentStorefrontOrder } from "@/lib/recent-orders";
import {
  formatIqd,
  formatLatinNumber,
  classifyNetworkError,
  trackStorefrontOrder,
  type OnlineOrderTracking,
} from "@/lib/storefront-api";

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "بانتظار تأكيد المكتبة",
  CONFIRMED: "تم تأكيد الطلب",
  PROCESSING: "جارٍ التجهيز",
  SHIPPED: "مع المندوب",
  DELIVERED: "تم التسليم",
  CANCELLED: "ملغى",
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function OrdersScreen() {
  const params = useLocalSearchParams<{ orderNumber?: string | string[] }>();
  const requestedOrderNumber = firstParam(params.orderNumber).toUpperCase();
  const [orderNumber, setOrderNumber] = useState(requestedOrderNumber);
  const [recentOrders, setRecentOrders] = useState<RecentStorefrontOrder[]>([]);
  const [tracking, setTracking] = useState<OnlineOrderTracking | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);

  useEffect(() => {
    void loadRecentOrders()
      .then((orders) => {
        setRecentOrders(orders);
        if (!requestedOrderNumber) return;
        setOrderNumber(requestedOrderNumber);
        setTracking(null);
        setTrackingError(null);
      })
      .catch(() => undefined);
  }, [requestedOrderNumber]);

  const track = async () => {
    if (trackingLoading) return;
    if (!orderNumber.trim()) {
      setTrackingError("أدخل رقم الطلب أو اختر طلباً محفوظاً على هذا الجهاز.");
      return;
    }
    setTrackingLoading(true);
    setTracking(null);
    setTrackingError(null);
    try {
      const normalizedOrderNumber = orderNumber.trim().toUpperCase();
      const recent = recentOrders.find((candidate) => candidate.orderNumber === normalizedOrderNumber);
      const session = await loadVerifiedCustomerSession();
      const guestTrackingToken = recent?.guestTrackingToken &&
        (!recent.guestTrackingExpiresAt || Date.parse(recent.guestTrackingExpiresAt) > Date.now())
        ? recent.guestTrackingToken
        : null;
      const result = await trackStorefrontOrder({
        orderNumber: normalizedOrderNumber,
        customerSessionToken: session?.token,
        guestTrackingToken,
      });
      if (!result) setTrackingError("لم نعثر على طلب متاح لهذه الجلسة.");
      else setTracking(result);
    } catch (reason) {
      setTrackingError(classifyNetworkError(reason).message);
    } finally {
      setTrackingLoading(false);
    }
  };

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>طلباتي</Text>
        <Text style={styles.subtitle}>
          التتبع محمي بجلسة هاتف موثقة أو رمز محفوظ بأمان على هذا الجهاز
        </Text>
        {recentOrders.length > 0 && (
          <View style={styles.recentSection}>
            <Text style={styles.recentTitle}>طلبات محفوظة على هذا الجهاز</Text>
            {recentOrders.map((recent) => (
              <TouchableOpacity
                accessibilityLabel={`اختيار الطلب ${recent.orderNumber} للتتبع`}
                accessibilityRole="button"
                activeOpacity={0.82}
                key={recent.orderNumber}
                onPress={() => {
                  setOrderNumber(recent.orderNumber);
                  setTracking(null);
                  setTrackingError(null);
                }}
                style={styles.recentOrder}
              >
                <View>
                  <Text style={styles.recentOrderNumber}>{recent.orderNumber}</Text>
                  <Text style={styles.recentOrderDate}>
                    {new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
                      dateStyle: "medium",
                    }).format(new Date(recent.placedAt))}
                  </Text>
                </View>
                <View style={styles.recentOrderMeta}>
                  <Text style={styles.recentOrderTotal}>{formatIqd(recent.total)}</Text>
                  <MaterialIcons color="#0C5A4B" name="arrow-back" size={17} />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <View style={styles.trackCard}>
          <View style={styles.trackHeading}>
            <View style={styles.trackIcon}>
              <MaterialIcons color="#0C5A4B" name="local-shipping" size={24} />
            </View>
            <View>
              <Text style={styles.trackTitle}>تتبع طلب موجود</Text>
              <Text style={styles.trackHint}>
                اختر طلباً محفوظاً أو أدخل رقمه بعد التحقق من هاتفك
              </Text>
            </View>
          </View>
          <TextInput
            autoCapitalize="characters"
            placeholder="رقم الطلب"
            placeholderTextColor="#71817B"
            style={styles.input}
            textAlign="right"
            value={orderNumber}
            onChangeText={setOrderNumber}
          />
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={trackingLoading}
            onPress={track}
            style={[
              styles.trackButton,
              trackingLoading && styles.trackButtonDisabled,
            ]}
          >
            <Text style={styles.trackButtonText}>تتبع الطلب</Text>
            {trackingLoading ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <MaterialIcons color="#FFFFFF" name="arrow-back" size={18} />
            )}
          </TouchableOpacity>
          {trackingError && (
            <Text style={styles.trackError}>{trackingError}</Text>
          )}
        </View>
        {tracking && (
          <View style={styles.liveOrder}>
            <View style={styles.liveTop}>
              <View>
                <Text style={styles.liveOrderNumber}>
                  طلب {tracking.orderNumber}
                </Text>
                <Text style={styles.liveDate}>
                  {new Intl.DateTimeFormat("ar-IQ", {
                    dateStyle: "medium",
                  }).format(new Date(tracking.createdAt))}
                </Text>
              </View>
              <View style={styles.status}>
                <Text style={styles.statusText}>{ORDER_STATUS_LABELS[tracking.status] ?? "قيد المتابعة"}</Text>
              </View>
            </View>
            <View style={styles.liveDivider} />
            <Text style={styles.liveMeta}>
              المحافظة: {tracking.governorate ?? "غير محددة"}
            </Text>
            <Text style={styles.liveMeta}>
              المجموع: {formatIqd(tracking.total)}
            </Text>
            {tracking.deliveryFree && <Text style={styles.liveMeta}>التوصيل: مجاني ضمن العرض</Text>}
            <Text style={styles.liveMeta}>
              عدد المنتجات: {formatLatinNumber(tracking.items.length)}
            </Text>
            <View style={styles.itemsList}>
              {tracking.items.map((item, index) => (
                <View key={`${item.productName}-${index}`} style={styles.itemRow}>
                  <View style={styles.itemCopy}>
                    <Text numberOfLines={2} style={styles.itemName}>{item.productName}</Text>
                    <Text style={styles.itemUnit}>{item.unitName} × {formatLatinNumber(Number(item.quantity))}</Text>
                  </View>
                  <Text style={styles.itemPrice}>{formatIqd(item.total)}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
        <View style={styles.note}>
          <MaterialIcons color="#0C5A4B" name="privacy-tip" size={20} />
          <Text style={styles.noteText}>
            لا يُرسل رمز التتبع في الرابط ولا يُحفظ في التخزين العادي؛ يبقى داخل
            SecureStore على الجهاز أو ضمن جلسة الهاتف الموثقة.
          </Text>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 34 },
  title: {
    color: "#20372F",
    fontSize: 25,
    fontWeight: "900",
    textAlign: "right",
  },
  subtitle: {
    color: "#6A7E75",
    fontSize: 13,
    marginTop: 5,
    textAlign: "right",
  },
  recentSection: { marginTop: 20 },
  recentTitle: { color: "#20372F", fontSize: 14, fontWeight: "900", marginBottom: 8, textAlign: "right" },
  recentOrder: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E3E8E3",
    borderRadius: 15,
    borderWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 8,
    minHeight: 66,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  recentOrderNumber: { color: "#20372F", fontSize: 13, fontWeight: "900", textAlign: "right" },
  recentOrderDate: { color: "#71817B", fontSize: 10, marginTop: 3, textAlign: "right" },
  recentOrderMeta: { alignItems: "center", flexDirection: "row-reverse", gap: 6 },
  recentOrderTotal: { color: "#0C5A4B", fontSize: 12, fontWeight: "900" },
  trackCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E3E8E3",
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 20,
    padding: 14,
  },
  trackHeading: {
    alignItems: "center",
    flexDirection: "row-reverse",
    marginBottom: 8,
  },
  trackIcon: {
    alignItems: "center",
    backgroundColor: "#E7F1EC",
    borderRadius: 13,
    height: 45,
    justifyContent: "center",
    marginLeft: 10,
    width: 45,
  },
  trackTitle: {
    color: "#20372F",
    fontSize: 15,
    fontWeight: "900",
    textAlign: "right",
  },
  trackHint: {
    color: "#71817B",
    fontSize: 10,
    marginTop: 3,
    textAlign: "right",
  },
  input: {
    backgroundColor: "#F7F8F6",
    borderColor: "#E3E8E3",
    borderRadius: 12,
    borderWidth: 1,
    color: "#20372F",
    height: 45,
    marginTop: 8,
    paddingHorizontal: 12,
  },
  trackButton: {
    alignItems: "center",
    backgroundColor: "#0C5A4B",
    borderRadius: 12,
    flexDirection: "row",
    gap: 7,
    height: 47,
    justifyContent: "center",
    marginTop: 12,
  },
  trackButtonDisabled: { opacity: 0.65 },
  trackButtonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  trackError: {
    color: "#A34840",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 18,
    marginTop: 9,
    textAlign: "right",
  },
  liveOrder: {
    backgroundColor: "#E7F1EC",
    borderRadius: 18,
    marginTop: 16,
    padding: 14,
  },
  liveTop: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  liveOrderNumber: {
    color: "#20372F",
    fontSize: 15,
    fontWeight: "900",
    textAlign: "right",
  },
  liveDate: {
    color: "#587067",
    fontSize: 11,
    marginTop: 4,
    textAlign: "right",
  },
  liveDivider: { backgroundColor: "#CDE0D5", height: 1, marginVertical: 12 },
  liveMeta: {
    color: "#395B50",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 5,
    textAlign: "right",
  },
  itemsList: { borderTopColor: "#CDE0D5", borderTopWidth: 1, marginTop: 12, paddingTop: 5 },
  itemRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", paddingVertical: 8 },
  itemCopy: { flex: 1, marginLeft: 10 },
  itemName: { color: "#29483E", fontSize: 11, fontWeight: "800", textAlign: "right" },
  itemUnit: { color: "#627A70", fontSize: 9, marginTop: 2, textAlign: "right" },
  itemPrice: { color: "#0C5A4B", fontSize: 11, fontWeight: "900" },
  status: {
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  statusText: { color: "#0C5A4B", fontSize: 10, fontWeight: "800" },
  note: {
    alignItems: "flex-start",
    backgroundColor: "#F1F4F1",
    borderRadius: 14,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 16,
    padding: 12,
  },
  noteText: {
    color: "#536B61",
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 18,
    textAlign: "right",
  },
});
