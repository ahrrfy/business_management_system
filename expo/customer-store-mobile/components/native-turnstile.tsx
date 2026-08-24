import { useCallback, useEffect, useRef } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import { extractTurnstileToken } from "@/lib/turnstile-message";

type NativeTurnstileProps = {
  visible: boolean;
  onVerified: (token: string) => void;
  onCancel: () => void;
  onFailure: () => void;
};

const CHALLENGE_URL = "https://alarabiya.online/store/mobile-turnstile";

/** نافذة ضيقة لتحدي الأمان فقط؛ التطبيق وبقية الشراء يظلان React Native أصليين. */
export function NativeTurnstile({ visible, onVerified, onCancel, onFailure }: NativeTurnstileProps) {
  const failedRef = useRef(false);
  const verifiedRef = useRef(false);
  useEffect(() => {
    if (visible) {
      failedRef.current = false;
      verifiedRef.current = false;
    }
  }, [visible]);
  const failOnce = useCallback(() => {
    if (failedRef.current || verifiedRef.current) return;
    failedRef.current = true;
    onFailure();
  }, [onFailure]);
  return <Modal animationType="slide" onRequestClose={onCancel} presentationStyle="pageSheet" visible={visible}>
    <View style={styles.container}>
      <View style={styles.header}><Text style={styles.title}>تحقق أمان الطلب</Text><Pressable accessibilityLabel="إلغاء التحقق" onPress={onCancel} style={styles.close}><Text style={styles.closeText}>إلغاء</Text></Pressable></View>
      <Text style={styles.subtitle}>هذه النافذة لا تعرض المتجر؛ تستخدم فقط للتحقق من أن إرسال الطلب صادر من شخص حقيقي.</Text>
      <WebView
        domStorageEnabled
        javaScriptEnabled
        onError={failOnce}
        onMessage={(event) => {
          const token = extractTurnstileToken(event.nativeEvent.data);
          if (token && !verifiedRef.current) {
            verifiedRef.current = true;
            onVerified(token);
          }
        }}
        originWhitelist={["https://alarabiya.online/*"]}
        source={{ uri: CHALLENGE_URL }}
        style={styles.webview}
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        userAgent="Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36"
      />
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  container: { backgroundColor: "#F7F5F0", flex: 1, paddingTop: 18 }, header: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", paddingHorizontal: 18 }, title: { color: "#1D2925", fontSize: 18, fontWeight: "900" }, close: { paddingHorizontal: 10, paddingVertical: 8 }, closeText: { color: "#0F5A4A", fontSize: 14, fontWeight: "800" }, subtitle: { color: "#52615B", fontSize: 12, lineHeight: 19, paddingHorizontal: 18, paddingTop: 8, textAlign: "right" }, webview: { backgroundColor: "#F7F5F0", flex: 1, marginTop: 10 },
});
