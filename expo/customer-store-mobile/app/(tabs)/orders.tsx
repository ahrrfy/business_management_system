import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { formatIqd, formatLatinNumber, trackStorefrontOrder, type OnlineOrderTracking } from "@/lib/storefront-api";

export default function OrdersScreen() {
  const [orderNumber, setOrderNumber] = useState("");
  const [phone, setPhone] = useState("+964 ");
  const [tracking, setTracking] = useState<OnlineOrderTracking | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);

  const track = async () => {
    if (trackingLoading) return;
    if (!orderNumber.trim() || phone.replace(/\D/g, "").length < 7) {
      setTrackingError("أدخل رقم الطلب ورقم الهاتف المستخدم عند الشراء.");
      return;
    }
    setTrackingLoading(true);
    setTracking(null);
    setTrackingError(null);
    try {
      const result = await trackStorefrontOrder(orderNumber.trim(), phone.trim());
      if (!result) setTrackingError("لم نعثر على طلب مطابق لهذه البيانات.");
      else setTracking(result);
    } catch {
      setTrackingError("تعذر الاتصال بخدمة تتبع الطلبات. حاول لاحقاً.");
    } finally {
      setTrackingLoading(false);
    }
  };

  return <ScreenContainer className="flex-1" containerClassName="bg-background"><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}><Text style={styles.title}>طلباتي</Text><Text style={styles.subtitle}>تابع طلبك بأمان عبر رقم الطلب ورقم الهاتف</Text><View style={styles.trackCard}><View style={styles.trackHeading}><View style={styles.trackIcon}><MaterialIcons color="#0C5A4B" name="local-shipping" size={24} /></View><View><Text style={styles.trackTitle}>تتبع طلب موجود</Text><Text style={styles.trackHint}>أدخل نفس رقم الهاتف المستخدم عند الشراء</Text></View></View><TextInput autoCapitalize="characters" placeholder="رقم الطلب" placeholderTextColor="#71817B" style={styles.input} textAlign="right" value={orderNumber} onChangeText={setOrderNumber} /><TextInput keyboardType="phone-pad" placeholder="رقم الهاتف" placeholderTextColor="#71817B" style={styles.input} textAlign="right" value={phone} onChangeText={setPhone} /><TouchableOpacity activeOpacity={0.85} disabled={trackingLoading} onPress={track} style={[styles.trackButton, trackingLoading && styles.trackButtonDisabled]}><Text style={styles.trackButtonText}>تتبع الطلب</Text>{trackingLoading ? <ActivityIndicator color="#FFFFFF" size="small" /> : <MaterialIcons color="#FFFFFF" name="arrow-back" size={18} />}</TouchableOpacity>{trackingError && <Text style={styles.trackError}>{trackingError}</Text>}</View>{tracking && <View style={styles.liveOrder}><View style={styles.liveTop}><View><Text style={styles.liveOrderNumber}>طلب {tracking.orderNumber}</Text><Text style={styles.liveDate}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(tracking.createdAt))}</Text></View><View style={styles.status}><Text style={styles.statusText}>{tracking.status}</Text></View></View><View style={styles.liveDivider} /><Text style={styles.liveMeta}>المحافظة: {tracking.governorate ?? "غير محددة"}</Text><Text style={styles.liveMeta}>المجموع: {formatIqd(tracking.total)}</Text><Text style={styles.liveMeta}>عدد المنتجات: {formatLatinNumber(tracking.items.length)}</Text></View>}<View style={styles.note}><MaterialIcons color="#0C5A4B" name="privacy-tip" size={20} /><Text style={styles.noteText}>لا تظهر تفاصيل الطلب إلا عند مطابقة رقم الطلب مع رقم الهاتف للحفاظ على خصوصيتك.</Text></View></ScrollView></ScreenContainer>;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 34 }, title: { color: "#20372F", fontSize: 25, fontWeight: "900", textAlign: "right" }, subtitle: { color: "#6A7E75", fontSize: 13, marginTop: 5, textAlign: "right" }, trackCard: { backgroundColor: "#FFFFFF", borderColor: "#E3E8E3", borderRadius: 20, borderWidth: 1, marginTop: 20, padding: 14 }, trackHeading: { alignItems: "center", flexDirection: "row-reverse", marginBottom: 8 }, trackIcon: { alignItems: "center", backgroundColor: "#E7F1EC", borderRadius: 13, height: 45, justifyContent: "center", marginLeft: 10, width: 45 }, trackTitle: { color: "#20372F", fontSize: 15, fontWeight: "900", textAlign: "right" }, trackHint: { color: "#71817B", fontSize: 10, marginTop: 3, textAlign: "right" }, input: { backgroundColor: "#F7F8F6", borderColor: "#E3E8E3", borderRadius: 12, borderWidth: 1, color: "#20372F", height: 45, marginTop: 8, paddingHorizontal: 12 }, trackButton: { alignItems: "center", backgroundColor: "#0C5A4B", borderRadius: 12, flexDirection: "row", gap: 7, height: 47, justifyContent: "center", marginTop: 12 }, trackButtonDisabled: { opacity: 0.65 }, trackButtonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" }, trackError: { color: "#A34840", fontSize: 11, fontWeight: "700", lineHeight: 18, marginTop: 9, textAlign: "right" }, liveOrder: { backgroundColor: "#E7F1EC", borderRadius: 18, marginTop: 16, padding: 14 }, liveTop: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" }, liveOrderNumber: { color: "#20372F", fontSize: 15, fontWeight: "900", textAlign: "right" }, liveDate: { color: "#587067", fontSize: 11, marginTop: 4, textAlign: "right" }, liveDivider: { backgroundColor: "#CDE0D5", height: 1, marginVertical: 12 }, liveMeta: { color: "#395B50", fontSize: 12, fontWeight: "700", marginTop: 5, textAlign: "right" }, status: { backgroundColor: "#FFFFFF", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5 }, statusText: { color: "#0C5A4B", fontSize: 10, fontWeight: "800" }, note: { alignItems: "flex-start", backgroundColor: "#F1F4F1", borderRadius: 14, flexDirection: "row-reverse", gap: 8, marginTop: 16, padding: 12 }, noteText: { color: "#536B61", flex: 1, fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "right" },
});
