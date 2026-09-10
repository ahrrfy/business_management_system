import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
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

import { ScreenContainer } from "@/components/screen-container";
import { loadVerifiedCustomerSession } from "@/lib/customer-session";
import { loadRecentOrders, type RecentStorefrontOrder } from "@/lib/recent-orders";
import { loadRecentQuoteRequests, type RecentStorefrontQuoteRequest } from "@/lib/recent-quote-requests";
import {
  formatIqd,
  formatLatinNumber,
  cancelStorefrontOrder,
  classifyNetworkError,
  trackStorefrontQuoteRequest,
  trackStorefrontOrder,
  type OnlineOrderTracking,
  type StorefrontQuoteRequestTracking,
  useStorefrontSettings,
} from "@/lib/storefront-api";

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "بانتظار تأكيد المكتبة",
  CONFIRMED: "تم تأكيد الطلب",
  PROCESSING: "جارٍ التجهيز",
  SHIPPED: "مع المندوب",
  DELIVERED: "تم التسليم",
  CANCELLED: "ملغى",
};

const QUOTE_REQUEST_STATUS_LABELS: Record<string, string> = {
  PENDING: "بانتظار مراجعة فريق المبيعات",
  CONTACTED: "بدأ التواصل معك",
  QUOTED: "صدر عرض رسمي",
  CLOSED: "اكتملت المتابعة",
  CANCELLED: "أُلغي طلب العرض",
};

const QUOTE_REQUEST_TYPE_LABELS: Record<string, string> = {
  BULK: "كمية وجملة",
  CUSTOM_PRINT: "طباعة وتخصيص",
  BUSINESS: "شركة أو مكتب",
  GENERAL: "طلب مبيعات",
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function OrdersScreen() {
  const settings = useStorefrontSettings();
  const params = useLocalSearchParams<{
    orderNumber?: string | string[];
    quoteRequestNumber?: string | string[];
  }>();
  const requestedOrderNumber = firstParam(params.orderNumber).toUpperCase();
  const requestedQuoteRequestNumber = firstParam(params.quoteRequestNumber).toUpperCase();
  const [orderNumber, setOrderNumber] = useState(requestedOrderNumber);
  const [recentOrders, setRecentOrders] = useState<RecentStorefrontOrder[]>([]);
  const [quoteRequestNumber, setQuoteRequestNumber] = useState(requestedQuoteRequestNumber);
  const [recentQuoteRequests, setRecentQuoteRequests] = useState<RecentStorefrontQuoteRequest[]>([]);
  const [tracking, setTracking] = useState<OnlineOrderTracking | null>(null);
  const [quoteTracking, setQuoteTracking] = useState<StorefrontQuoteRequestTracking | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [quoteTrackingError, setQuoteTrackingError] = useState<string | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [quoteTrackingLoading, setQuoteTrackingLoading] = useState(false);
  const [cancelPrompt, setCancelPrompt] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    void loadRecentOrders()
      .then((orders) => {
        setRecentOrders(orders);
        if (!requestedOrderNumber) return;
        setOrderNumber(requestedOrderNumber);
        setTracking(null);
        setTrackingError(null);
        setCancelPrompt(false);
      })
      .catch(() => undefined);
  }, [requestedOrderNumber]);

  useEffect(() => {
    void loadRecentQuoteRequests()
      .then((requests) => {
        setRecentQuoteRequests(requests);
        if (!requestedQuoteRequestNumber) return;
        setQuoteRequestNumber(requestedQuoteRequestNumber);
        setQuoteTracking(null);
        setQuoteTrackingError(null);
      })
      .catch(() => undefined);
  }, [requestedQuoteRequestNumber]);

  const track = async () => {
    if (trackingLoading) return;
    if (!orderNumber.trim()) {
      setTrackingError("أدخل رقم الطلب أو اختر طلباً محفوظاً على هذا الجهاز.");
      return;
    }
    setTrackingLoading(true);
    setTracking(null);
    setTrackingError(null);
    setCancelPrompt(false);
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

  const cancelPendingOrder = async () => {
    if (!tracking || tracking.status !== "PENDING" || cancelling) return;
    setCancelling(true);
    setTrackingError(null);
    try {
      const normalizedOrderNumber = tracking.orderNumber.trim().toUpperCase();
      const recent = recentOrders.find((candidate) => candidate.orderNumber === normalizedOrderNumber);
      const session = await loadVerifiedCustomerSession();
      const guestTrackingToken = recent?.guestTrackingToken &&
        (!recent.guestTrackingExpiresAt || Date.parse(recent.guestTrackingExpiresAt) > Date.now())
        ? recent.guestTrackingToken
        : null;
      const result = await cancelStorefrontOrder({
        orderNumber: normalizedOrderNumber,
        customerSessionToken: session?.token,
        guestTrackingToken,
      });
      setTracking((current) =>
        current?.orderNumber === result.orderNumber
          ? { ...current, status: result.status }
          : current,
      );
      setCancelPrompt(false);
    } catch (reason) {
      setTrackingError(classifyNetworkError(reason).message);
    } finally {
      setCancelling(false);
    }
  };

  const trackQuoteRequest = async (requestedNumber = quoteRequestNumber) => {
    if (quoteTrackingLoading) return;
    if (!requestedNumber.trim()) {
      setQuoteTrackingError("أدخل رقم طلب العرض أو اختر طلباً محفوظاً على هذا الجهاز.");
      return;
    }
    setQuoteTrackingLoading(true);
    setQuoteTracking(null);
    setQuoteTrackingError(null);
    try {
      const normalizedRequestNumber = requestedNumber.trim().toUpperCase();
      const recent = recentQuoteRequests.find(
        (candidate) => candidate.requestNumber === normalizedRequestNumber,
      );
      const session = await loadVerifiedCustomerSession();
      const guestTrackingToken = recent?.guestTrackingToken &&
        (!recent.guestTrackingExpiresAt || Date.parse(recent.guestTrackingExpiresAt) > Date.now())
        ? recent.guestTrackingToken
        : null;
      const result = await trackStorefrontQuoteRequest({
        requestNumber: normalizedRequestNumber,
        customerSessionToken: session?.token,
        guestTrackingToken,
      });
      setQuoteTracking(result);
    } catch (reason) {
      setQuoteTrackingError(classifyNetworkError(reason).message);
    } finally {
      setQuoteTrackingLoading(false);
    }
  };

  const openOrderSupport = async () => {
    if (!tracking) return;
    const number = settings?.whatsappNumber?.replace(/\D/g, "");
    if (!number) {
      Alert.alert(
        "التواصل مع المكتبة",
        "ستظهر وسيلة التواصل هنا عند ضبطها من إدارة المتجر.",
      );
      return;
    }
    // رقم الطلب سياقٌ تشغيلي ظاهر بالفعل لمالكه؛ لا نضع رمز الجلسة أو رمز التتبع في رابط WhatsApp.
    const message = encodeURIComponent(
      `مرحباً، أحتاج مساعدة أو طلب تعديل للطلب ${tracking.orderNumber}.`,
    );
    const url = `https://wa.me/${number}?text=${message}`;
    if (await Linking.canOpenURL(url)) await Linking.openURL(url);
    else Alert.alert("تعذّر فتح WhatsApp", "تأكد من وجود WhatsApp على جهازك ثم حاول مرة أخرى.");
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
        {recentQuoteRequests.length > 0 && (
          <View style={styles.recentSection}>
            <Text style={styles.recentTitle}>طلبات عروض سعر محفوظة على هذا الجهاز</Text>
            {recentQuoteRequests.map((recent) => (
              <TouchableOpacity
                accessibilityLabel={`تتبع طلب عرض السعر ${recent.requestNumber}`}
                accessibilityRole="button"
                activeOpacity={0.82}
                key={recent.requestNumber}
                onPress={() => {
                  setQuoteRequestNumber(recent.requestNumber);
                  void trackQuoteRequest(recent.requestNumber);
                }}
                style={styles.recentOrder}
              >
                <View>
                  <Text style={styles.recentOrderNumber}>{recent.requestNumber}</Text>
                  <Text style={styles.recentOrderDate}>
                    {new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
                      dateStyle: "medium",
                    }).format(new Date(recent.placedAt))}
                  </Text>
                </View>
                <View style={styles.recentOrderMeta}>
                  <Text style={styles.recentOrderTotal}>طلب عرض سعر</Text>
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
            {Number(tracking.pricingBenefitDiscount) > 0 && (
              <Text style={styles.liveMeta}>
                وفّرت {formatIqd(tracking.pricingBenefitDiscount)} عبر {tracking.pricingBenefitLabel ?? "المنفعة الأفضل"}
              </Text>
            )}
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
            {tracking.status === "PENDING" && (
              <View style={styles.cancelPanel}>
                {!cancelPrompt ? (
                  <TouchableOpacity
                    accessibilityLabel="إلغاء الطلب قبل تأكيد المكتبة"
                    accessibilityRole="button"
                    activeOpacity={0.84}
                    disabled={cancelling}
                    onPress={() => setCancelPrompt(true)}
                    style={styles.cancelOutline}
                  >
                    <MaterialIcons color="#A34840" name="cancel" size={17} />
                    <Text style={styles.cancelOutlineText}>إلغاء الطلب قبل التأكيد</Text>
                  </TouchableOpacity>
                ) : (
                  <View>
                    <Text style={styles.cancelPromptText}>
                      هل تريد إلغاء الطلب؟ سيُحرر الحجز والكوبون إن وُجد، ولا يمكن التراجع من التطبيق.
                    </Text>
                    <View style={styles.cancelActions}>
                      <TouchableOpacity
                        accessibilityLabel="الاحتفاظ بالطلب"
                        accessibilityRole="button"
                        activeOpacity={0.84}
                        disabled={cancelling}
                        onPress={() => setCancelPrompt(false)}
                        style={styles.keepButton}
                      >
                        <Text style={styles.keepButtonText}>الاحتفاظ بالطلب</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityLabel="تأكيد إلغاء الطلب"
                        accessibilityRole="button"
                        activeOpacity={0.84}
                        disabled={cancelling}
                        onPress={() => void cancelPendingOrder()}
                        style={[styles.cancelButton, cancelling && styles.cancelButtonDisabled]}
                      >
                        {cancelling ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={styles.cancelButtonText}>نعم، ألغِ الطلب</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            )}
            {tracking.status !== "PENDING" && tracking.status !== "CANCELLED" && (
              <View style={styles.supportPanel}>
                <Text style={styles.supportHint}>
                  للتعديل أو الإلغاء بعد التأكيد، يراجع فريق المكتبة طلبك قبل أي تغيير في السعر أو المحتوى.
                </Text>
                <TouchableOpacity
                  accessibilityLabel={`طلب مساعدة للطلب ${tracking.orderNumber}`}
                  accessibilityRole="button"
                  activeOpacity={0.84}
                  onPress={() => void openOrderSupport()}
                  style={styles.supportButton}
                >
                  <MaterialIcons color="#0C5A4B" name="support-agent" size={17} />
                  <Text style={styles.supportButtonText}>طلب تعديل أو مساعدة</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
        <View style={styles.trackCard}>
          <View style={styles.trackHeading}>
            <View style={styles.trackIcon}>
              <MaterialIcons color="#0C5A4B" name="request-quote" size={24} />
            </View>
            <View>
              <Text style={styles.trackTitle}>متابعة عرض سعر</Text>
              <Text style={styles.trackHint}>
                للطلبات المحفوظة على الجهاز أو الطلبات المرتبطة بحسابك الموثق
              </Text>
            </View>
          </View>
          <TextInput
            autoCapitalize="characters"
            placeholder="رقم طلب العرض SRQ"
            placeholderTextColor="#71817B"
            style={styles.input}
            textAlign="right"
            value={quoteRequestNumber}
            onChangeText={setQuoteRequestNumber}
          />
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={quoteTrackingLoading}
            onPress={() => void trackQuoteRequest()}
            style={[
              styles.trackButton,
              quoteTrackingLoading && styles.trackButtonDisabled,
            ]}
          >
            <Text style={styles.trackButtonText}>متابعة طلب العرض</Text>
            {quoteTrackingLoading ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <MaterialIcons color="#FFFFFF" name="arrow-back" size={18} />
            )}
          </TouchableOpacity>
          {quoteTrackingError && (
            <Text style={styles.trackError}>{quoteTrackingError}</Text>
          )}
        </View>
        {quoteTracking && (
          <View style={styles.liveOrder}>
            <View style={styles.liveTop}>
              <View>
                <Text style={styles.liveOrderNumber}>
                  طلب عرض {quoteTracking.requestNumber}
                </Text>
                <Text style={styles.liveDate}>
                  أُرسل في {new Intl.DateTimeFormat("ar-IQ", {
                    dateStyle: "medium",
                  }).format(new Date(quoteTracking.createdAt))}
                </Text>
              </View>
              <View style={styles.status}>
                <Text style={styles.statusText}>{QUOTE_REQUEST_STATUS_LABELS[quoteTracking.status] ?? "قيد المتابعة"}</Text>
              </View>
            </View>
            <View style={styles.liveDivider} />
            <Text style={styles.liveMeta}>
              النوع: {QUOTE_REQUEST_TYPE_LABELS[quoteTracking.requestType] ?? "طلب مبيعات"}
            </Text>
            <Text style={styles.liveMeta}>
              طريقة التواصل: {quoteTracking.contactPreference === "WHATSAPP" ? "واتساب" : "اتصال هاتفي"}
            </Text>
            {quoteTracking.governorate && (
              <Text style={styles.liveMeta}>المحافظة: {quoteTracking.governorate}</Text>
            )}
            <Text style={styles.liveMeta}>
              لا يحجز هذا الطلب مخزوناً ولا يثبت سعراً قبل إصدار العرض الرسمي.
            </Text>
            {quoteTracking.officialQuotation && (
              <View style={styles.supportPanel}>
                <Text style={styles.supportHint}>
                  صدر العرض الرسمي رقم {quoteTracking.officialQuotation.quoteNumber}.
                  {quoteTracking.officialQuotation.validUntil
                    ? ` صالح حتى ${new Intl.DateTimeFormat("ar-IQ-u-nu-latn", { dateStyle: "medium" }).format(new Date(quoteTracking.officialQuotation.validUntil))}.`
                    : " راجع وسيلة التواصل التي اخترتها لاستلامه."}
                </Text>
              </View>
            )}
            <View style={styles.itemsList}>
              {quoteTracking.items.map((item, index) => (
                <View key={`${item.productName}-${index}`} style={styles.itemRow}>
                  <View style={styles.itemCopy}>
                    <Text numberOfLines={2} style={styles.itemName}>{item.productName}</Text>
                    <Text style={styles.itemUnit}>
                      {[item.variantLabel, `${item.unitName} × ${formatLatinNumber(item.quantity)}`]
                        .filter(Boolean)
                        .join(" — ")}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}
        <View style={styles.note}>
          <MaterialIcons color="#0C5A4B" name="privacy-tip" size={20} />
          <Text style={styles.noteText}>
            لا يُرسل رمز تتبع الشراء أو عرض السعر في الرابط ولا يُحفظ في التخزين العادي؛
            يبقى داخل SecureStore على الجهاز أو ضمن جلسة الهاتف الموثقة.
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
  cancelPanel: { borderTopColor: "#CDE0D5", borderTopWidth: 1, marginTop: 12, paddingTop: 12 },
  cancelOutline: { alignItems: "center", borderColor: "#D9938A", borderRadius: 10, borderWidth: 1, flexDirection: "row-reverse", gap: 6, justifyContent: "center", minHeight: 42, paddingHorizontal: 12 },
  cancelOutlineText: { color: "#A34840", fontSize: 12, fontWeight: "900" },
  cancelPromptText: { color: "#71443E", fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "right" },
  cancelActions: { flexDirection: "row-reverse", gap: 8, marginTop: 10 },
  keepButton: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#A9C6B6", borderRadius: 10, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 40, paddingHorizontal: 8 },
  keepButtonText: { color: "#365D4F", fontSize: 11, fontWeight: "900" },
  cancelButton: { alignItems: "center", backgroundColor: "#A34840", borderRadius: 10, flex: 1, justifyContent: "center", minHeight: 40, paddingHorizontal: 8 },
  cancelButtonDisabled: { opacity: 0.65 },
  cancelButtonText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900" },
  supportPanel: { borderTopColor: "#CDE0D5", borderTopWidth: 1, marginTop: 12, paddingTop: 12 },
  supportHint: { color: "#395B50", fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "right" },
  supportButton: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#9DC5B2", borderRadius: 10, borderWidth: 1, flexDirection: "row-reverse", gap: 6, justifyContent: "center", marginTop: 9, minHeight: 42, paddingHorizontal: 12 },
  supportButtonText: { color: "#0C5A4B", fontSize: 12, fontWeight: "900" },
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
