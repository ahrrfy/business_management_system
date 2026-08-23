import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { clearVerifiedCustomerSession, loadVerifiedCustomerSession, type VerifiedCustomerSession } from "@/lib/customer-session";
import { formatLatinNumber, getStorefrontCustomerBenefits, type StorefrontCustomerBenefits } from "@/lib/storefront-api";

export default function LoyaltyScreen() {
  const [session, setSession] = useState<VerifiedCustomerSession | null | undefined>(undefined);
  const [benefits, setBenefits] = useState<StorefrontCustomerBenefits | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const current = await loadVerifiedCustomerSession();
    setSession(current);
    if (!current) { setBenefits(null); setLoading(false); return; }
    try {
      setBenefits(await getStorefrontCustomerBenefits(current.token));
    } catch (error) {
      await clearVerifiedCustomerSession();
      setSession(null);
      setBenefits(null);
      Alert.alert("انتهت جلسة المزايا", error instanceof Error ? error.message : "أعد تحقق الهاتف لمتابعة رصيدك.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <ScreenContainer className="items-center justify-center"><ActivityIndicator color="#075B4E" size="large" /></ScreenContainer>;
  if (!session) return <ScreenContainer className="flex-1" containerClassName="bg-background"><View style={styles.empty}><View style={styles.emptyIcon}><MaterialIcons name="verified-user" size={35} color="#075B4E" /></View><Text style={styles.emptyTitle}>فعّل رصيد الولاء والقسائم</Text><Text style={styles.emptyText}>تحقق برقم هاتفك كي تظهر نقاطك والقسائم المخصصة لك بشكل آمن.</Text><TouchableOpacity style={styles.primary} onPress={() => router.push("/verify-phone" as never)}><Text style={styles.primaryText}>تحقق من رقم الهاتف</Text></TouchableOpacity></View></ScreenContainer>;

  const loyalty = benefits?.loyalty;
  return <ScreenContainer className="flex-1" containerClassName="bg-background"><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}><TouchableOpacity onPress={() => router.back()} style={styles.back}><MaterialIcons name="arrow-forward" size={22} color="#40594F" /></TouchableOpacity><Text style={styles.title}>الولاء والقسائم</Text><Text style={styles.sub}>مرحباً {benefits?.customer.name ?? session.customer.name}</Text>
    <View style={styles.balanceCard}><View style={styles.balanceTop}><View><Text style={styles.balanceLabel}>رصيدك المتاح</Text><Text style={styles.balance}>{formatLatinNumber(loyalty?.pointsBalance ?? "0")}</Text><Text style={styles.points}>نقطة ولاء</Text></View><View style={styles.star}><MaterialIcons name="stars" size={35} color="#E9B949" /></View></View>{loyalty ? <Text style={styles.rules}>كل نقطة تعادل {formatLatinNumber(loyalty.iqdDiscountPerPoint)} د.ع. يبدأ الاستبدال من {formatLatinNumber(loyalty.minRedeemPoints)} نقطة وبحد أقصى {formatLatinNumber(loyalty.maxRedeemPercent)}% من قيمة المنتجات.</Text> : <Text style={styles.rules}>سيظهر رصيدك هنا بمجرد تفعيل برنامج الولاء من الداشبورد واستحقاق نقاط مكتملة.</Text>}</View>
    <View style={styles.verify}><MaterialIcons name="verified" size={20} color="#16835D" /><Text style={styles.verifyText}>رقم الهاتف متحقق ومربوط بسجل العميل. تُحتسب النقاط بعد تسليم الطلب.</Text></View>
    <Text style={styles.section}>القسائم الخاصة بك</Text>{benefits?.coupons.length ? benefits.coupons.map((coupon) => <View key={coupon.id} style={styles.coupon}><View><Text style={styles.couponName}>{coupon.name}</Text><Text style={styles.couponCode}>{coupon.code}</Text></View><Text style={styles.couponDate}>{coupon.validTo ? `حتى ${coupon.validTo}` : "صالحة حالياً"}</Text></View>) : <View style={styles.blank}><Text style={styles.blankText}>لا توجد قسائم شخصية فعّالة حالياً.</Text></View>}
    <Text style={styles.section}>سجل النقاط</Text>{loyalty?.ledger.length ? loyalty.ledger.map((entry, index) => <View key={`${entry.createdAt}-${index}`} style={styles.ledger}><View><Text style={styles.ledgerTitle}>{entry.note ?? entry.entryType}</Text><Text style={styles.ledgerDate}>{new Date(entry.createdAt).toLocaleDateString("en-US")}</Text></View><View style={styles.ledgerAmount}><Text style={[styles.delta, String(entry.pointsDelta).startsWith("-") ? styles.negative : styles.positive]}>{Number(entry.pointsDelta) > 0 ? "+" : ""}{formatLatinNumber(entry.pointsDelta)}</Text><Text style={styles.after}>الرصيد {formatLatinNumber(entry.balanceAfter)}</Text></View></View>) : <View style={styles.blank}><Text style={styles.blankText}>لم تسجل حركة نقاط حتى الآن.</Text></View>}
    <TouchableOpacity onPress={() => router.push("/verify-phone" as never)} style={styles.reverify}><Text style={styles.reverifyText}>تغيير أو إعادة تحقق رقم الهاتف</Text></TouchableOpacity>
  </ScrollView></ScreenContainer>;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 34 }, back: { alignSelf: "flex-start", padding: 5 }, title: { color: "#19352D", fontSize: 25, fontWeight: "900", marginTop: 8, textAlign: "right" }, sub: { color: "#687E74", fontSize: 12, marginTop: 4, textAlign: "right" }, balanceCard: { backgroundColor: "#075B4E", borderRadius: 23, marginTop: 18, padding: 19 }, balanceTop: { alignItems: "flex-start", flexDirection: "row-reverse", justifyContent: "space-between" }, balanceLabel: { color: "#CBE5DA", fontSize: 12, fontWeight: "800", textAlign: "right" }, balance: { color: "#FFFFFF", fontSize: 36, fontWeight: "900", marginTop: 5 }, points: { color: "#E8F1EC", fontSize: 12, fontWeight: "700" }, star: { backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 25, padding: 9 }, rules: { color: "#D4E8DF", fontSize: 11, lineHeight: 18, marginTop: 18, textAlign: "right" }, verify: { alignItems: "flex-start", backgroundColor: "#EAF7F0", borderRadius: 14, flexDirection: "row-reverse", gap: 8, marginTop: 13, padding: 12 }, verifyText: { color: "#346653", flex: 1, fontSize: 11, lineHeight: 17, textAlign: "right" }, section: { color: "#2A443A", fontSize: 15, fontWeight: "900", marginTop: 25, textAlign: "right" }, coupon: { alignItems: "center", backgroundColor: "#FFF7E7", borderColor: "#F2DCAD", borderRadius: 16, borderWidth: 1, flexDirection: "row-reverse", justifyContent: "space-between", marginTop: 10, padding: 14 }, couponName: { color: "#614914", fontSize: 13, fontWeight: "900", textAlign: "right" }, couponCode: { color: "#8E6916", fontSize: 15, fontWeight: "900", letterSpacing: 1, marginTop: 5 }, couponDate: { color: "#8D753B", fontSize: 10 }, blank: { backgroundColor: "#FFFFFF", borderColor: "#E2EAE5", borderRadius: 15, borderWidth: 1, marginTop: 10, padding: 15 }, blankText: { color: "#718279", fontSize: 12, textAlign: "right" }, ledger: { alignItems: "center", backgroundColor: "#FFFFFF", borderBottomColor: "#EDF0ED", borderBottomWidth: 1, flexDirection: "row-reverse", justifyContent: "space-between", paddingVertical: 13 }, ledgerTitle: { color: "#29453A", fontSize: 12, fontWeight: "800", textAlign: "right" }, ledgerDate: { color: "#839189", fontSize: 10, marginTop: 4, textAlign: "right" }, ledgerAmount: { alignItems: "flex-end" }, delta: { fontSize: 14, fontWeight: "900" }, positive: { color: "#15865A" }, negative: { color: "#C95A41" }, after: { color: "#7B8A82", fontSize: 9, marginTop: 3 }, reverify: { alignItems: "center", marginTop: 24, padding: 12 }, reverifyText: { color: "#075B4E", fontSize: 12, fontWeight: "800" }, empty: { alignItems: "center", flex: 1, justifyContent: "center", padding: 27 }, emptyIcon: { alignItems: "center", backgroundColor: "#E7F1EC", borderRadius: 29, height: 58, justifyContent: "center", width: 58 }, emptyTitle: { color: "#1C392F", fontSize: 21, fontWeight: "900", marginTop: 18, textAlign: "center" }, emptyText: { color: "#6D8077", fontSize: 13, lineHeight: 22, marginTop: 8, textAlign: "center" }, primary: { alignItems: "center", backgroundColor: "#075B4E", borderRadius: 15, justifyContent: "center", marginTop: 24, minHeight: 52, paddingHorizontal: 30 }, primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
});
