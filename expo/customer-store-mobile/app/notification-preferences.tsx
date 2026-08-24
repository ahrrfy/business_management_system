import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { disableMarketingPush, enableMarketingPush, isMarketingPushEnabled } from "@/lib/customer-notifications";
import { openLegalPage } from "@/lib/legal-urls";

export default function NotificationPreferencesScreen() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    isMarketingPushEnabled().then(setEnabled).finally(() => setLoading(false));
  }, []);

  const toggleMarketing = useCallback(async (next: boolean) => {
    if (updating) return;
    setUpdating(true);
    try {
      if (!next) {
        const result = await disableMarketingPush();
        if (result.ok) setEnabled(false);
        else Alert.alert("تعذر إيقاف الإشعارات", result.message);
        return;
      }
      const result = await enableMarketingPush();
      if (result.ok) setEnabled(true);
      else Alert.alert("تعذر تفعيل الإشعارات", result.message);
    } finally {
      setUpdating(false);
    }
  }, [updating]);

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background" edges={["top", "bottom", "left", "right"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.content}>
        <View style={styles.hero}><View style={styles.icon}><MaterialIcons name="notifications-active" size={30} color="#075B4E" /></View><Text style={styles.title}>إشعاراتك</Text><Text style={styles.subtitle}>أنت تتحكم في العروض التي تصلك. لن نرسل إعلاناً دون موافقتك.</Text></View>
        <View style={styles.card}><View style={styles.row}><View style={styles.rowText}><Text style={styles.rowTitle}>عروض وتخفيضات مكتبة العربية</Text><Text style={styles.rowSubtitle}>تنبيهات اختيارية عن التخفيضات والبنرات والمنتجات المناسبة.</Text></View>{loading ? <ActivityIndicator color="#075B4E" /> : <Switch value={enabled} onValueChange={toggleMarketing} disabled={updating || Platform.OS === "web"} trackColor={{ false: "#D6DDD9", true: "#A8D8C8" }} thumbColor={enabled ? "#075B4E" : "#F7F7F7"} />}</View></View>
        <View style={styles.info}><MaterialIcons name="local-shipping" size={20} color="#075B4E"/><Text style={styles.infoText}>إشعارات حالة الطلب مهمة للتوصيل والمتابعة، أما الرسائل التسويقية فهي اختيارية ويمكن إيقافها في أي وقت.</Text></View>
        <View style={styles.info}><MaterialIcons name="privacy-tip" size={20} color="#075B4E"/><Text style={styles.infoText}>يقتصر رابط الإشعار على صفحات التطبيق الداخلية، ولا ينقل رقم هاتفك أو رصيدك في نص الإشعار.</Text></View>
        <TouchableOpacity
          accessibilityLabel="اقرأ سياسة الخصوصيّة لبيانات الإشعارات"
          accessibilityRole="link"
          activeOpacity={0.7}
          onPress={async () => {
            const opened = await openLegalPage("privacy");
            if (!opened) Alert.alert("تعذّر فتح الرابط", "لا يوجد متصفّح متاح لفتح صفحة السياسة.");
          }}
          style={styles.policyLink}
        >
          <MaterialIcons color="#075B4E" name="open-in-new" size={16} />
          <Text style={styles.policyLinkText}>سياسة الخصوصيّة وبيانات الإشعارات</Text>
        </TouchableOpacity>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, padding: 18 }, hero: { alignItems: "flex-end", marginTop: 8 }, icon: { alignItems: "center", backgroundColor: "#E1F1EA", borderRadius: 20, height: 64, justifyContent: "center", width: 64 }, title: { color: "#19372E", fontSize: 25, fontWeight: "900", marginTop: 15, textAlign: "right" }, subtitle: { color: "#61756D", fontSize: 13, lineHeight: 21, marginTop: 7, textAlign: "right" }, card: { backgroundColor: "#FFFFFF", borderColor: "#D9E8E1", borderRadius: 20, borderWidth: 1, marginTop: 27, padding: 16 }, row: { alignItems: "center", flexDirection: "row-reverse", gap: 12 }, rowText: { flex: 1 }, rowTitle: { color: "#20372F", fontSize: 15, fontWeight: "900", textAlign: "right" }, rowSubtitle: { color: "#6A7B74", fontSize: 11, lineHeight: 18, marginTop: 5, textAlign: "right" }, info: { alignItems: "flex-start", backgroundColor: "#EAF5F0", borderRadius: 15, flexDirection: "row-reverse", gap: 9, marginTop: 14, padding: 13 }, infoText: { color: "#375E50", flex: 1, fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "right" }, policyLink: { alignItems: "center", alignSelf: "flex-end", flexDirection: "row-reverse", gap: 6, marginTop: 18, paddingHorizontal: 4, paddingVertical: 10 }, policyLinkText: { color: "#075B4E", fontSize: 12, fontWeight: "800", textDecorationLine: "underline" },
});
