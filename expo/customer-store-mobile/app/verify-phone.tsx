import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { IraqiPhoneInput } from "@/components/iraqi-phone-input";
import { ScreenContainer } from "@/components/screen-container";
import { saveVerifiedCustomerSession } from "@/lib/customer-session";
import { confirmStorefrontPhoneOtp, sendStorefrontPhoneOtp } from "@/lib/firebase-phone-auth";
import { openLegalPage } from "@/lib/legal-urls";
import { claimStorefrontFirebaseCustomer } from "@/lib/storefront-api";

export default function VerifyPhoneScreen() {
  const [name, setName] = useState("");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"PHONE" | "CODE">("PHONE");
  const [busy, setBusy] = useState(false);

  const sendCode = async () => {
    if (name.trim().length < 2) {
      Alert.alert("الاسم مطلوب", "اكتب اسمك كما يظهر في طلبات المكتبة.");
      return;
    }
    setBusy(true);
    try {
      await sendStorefrontPhoneOtp(phoneLocal);
      setStep("CODE");
    } catch (error) {
      Alert.alert("تعذر إرسال الرمز", error instanceof Error ? error.message : "حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setBusy(true);
    try {
      const verified = await confirmStorefrontPhoneOtp(code);
      const session = await claimStorefrontFirebaseCustomer({ firebaseIdToken: verified.firebaseIdToken, displayName: name.trim() });
      await saveVerifiedCustomerSession(session);
      router.replace("/loyalty" as never);
    } catch (error) {
      Alert.alert("تعذر إتمام التحقق", error instanceof Error ? error.message : "حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 24} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <TouchableOpacity onPress={() => router.back()} style={styles.close} accessibilityLabel="رجوع" accessibilityRole="button"><MaterialIcons name="close" size={23} color="#52655D" /></TouchableOpacity>
        <View style={styles.icon}><MaterialIcons name="verified-user" size={34} color="#075B4E" /></View>
        <Text style={styles.title}>{step === "PHONE" ? "فعّل مزاياك برقم الهاتف" : "أدخل رمز التحقق"}</Text>
        <Text style={styles.lead}>{step === "PHONE" ? "يُستخدم رقمك لربط رصيد الولاء والقسائم بحسابك، ولا يظهر للآخرين." : "أرسلنا رمزاً من 6 أرقام إلى هاتفك. لا تشارك الرمز مع أي شخص."}</Text>

        {step === "PHONE" ? <>
          <Text style={styles.label}>الاسم</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholder="الاسم الكامل" placeholderTextColor="#8A9992" textAlign="right" maxLength={120} returnKeyType="next" />
          <Text style={styles.label}>رقم الهاتف</Text>
          <IraqiPhoneInput onChangeText={setPhoneLocal} value={phoneLocal} />
          <Text style={styles.help}>اكتب 7XXXXXXXXX أو 07XXXXXXXXX؛ المفتاح +964 ثابت في اليسار.</Text>
          <TouchableOpacity accessibilityLabel="إرسال رمز التحقق إلى الهاتف" accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={sendCode} style={[styles.primary, busy && styles.disabled]}>{busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>إرسال رمز التحقق</Text>}</TouchableOpacity>
        </> : <>
          <Text style={styles.label}>رمز التحقق</Text>
          <TextInput value={code} onChangeText={setCode} style={[styles.input, styles.code]} placeholder="000000" placeholderTextColor="#8A9992" textAlign="center" keyboardType="number-pad" maxLength={6} autoFocus />
          <TouchableOpacity accessibilityLabel="تأكيد الرمز وتفعيل الحساب" accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={verifyCode} style={[styles.primary, busy && styles.disabled]}>{busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>تأكيد الهاتف</Text>}</TouchableOpacity>
          <TouchableOpacity accessibilityLabel="تعديل الرقم أو إعادة إرسال الرمز" accessibilityRole="button" disabled={busy} onPress={() => { setStep("PHONE"); setCode(""); }} style={styles.secondary}><Text style={styles.secondaryText}>تعديل الرقم أو إعادة الإرسال</Text></TouchableOpacity>
        </>}
        <View style={styles.note}><MaterialIcons name="lock-outline" size={18} color="#075B4E" /><Text style={styles.noteText}>التحقق مطلوب فقط قبل استخدام النقاط والقسائم الشخصية. تبقى عملية التصفح والشراء الأساسية متاحة دون إنشاء حساب.</Text></View>
        <TouchableOpacity
          accessibilityLabel="اقرأ سياسة الخصوصيّة قبل التحقّق"
          accessibilityRole="link"
          activeOpacity={0.7}
          onPress={async () => {
            const opened = await openLegalPage("privacy");
            if (!opened) Alert.alert("تعذّر فتح الرابط", "لا يوجد متصفّح متاح لفتح صفحة السياسة.");
          }}
          style={styles.policyLink}
        >
          <MaterialIcons color="#075B4E" name="privacy-tip" size={16} />
          <Text style={styles.policyLinkText}>سياسة الخصوصيّة</Text>
        </TouchableOpacity>
      </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, content: { flexGrow: 1, padding: 22, paddingTop: 28 }, close: { alignSelf: "flex-start", padding: 6 }, icon: { alignItems: "center", alignSelf: "center", backgroundColor: "#E7F1EC", borderRadius: 28, height: 56, justifyContent: "center", marginTop: 22, width: 56 }, title: { color: "#19352D", fontSize: 23, fontWeight: "900", marginTop: 18, textAlign: "center" }, lead: { color: "#647870", fontSize: 13, lineHeight: 22, marginTop: 8, textAlign: "center" }, label: { color: "#314A41", fontSize: 13, fontWeight: "800", marginTop: 25, textAlign: "right" }, input: { backgroundColor: "#FFFFFF", borderColor: "#D7E4DD", borderRadius: 14, borderWidth: 1, color: "#19352D", fontSize: 16, marginTop: 8, minHeight: 52, paddingHorizontal: 14 }, code: { fontSize: 24, fontWeight: "800", letterSpacing: 7 }, help: { color: "#75877F", fontSize: 11, marginTop: 7, textAlign: "right" }, primary: { alignItems: "center", backgroundColor: "#075B4E", borderRadius: 15, justifyContent: "center", marginTop: 25, minHeight: 53 }, primaryText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" }, disabled: { opacity: 0.65 }, secondary: { alignItems: "center", padding: 15 }, secondaryText: { color: "#075B4E", fontSize: 13, fontWeight: "800" }, note: { alignItems: "flex-start", backgroundColor: "#F0F7F3", borderRadius: 14, flexDirection: "row-reverse", gap: 8, marginTop: 24, padding: 13 }, noteText: { color: "#476359", flex: 1, fontSize: 11, lineHeight: 18, textAlign: "right" },
  policyLink: { alignItems: "center", alignSelf: "flex-end", flexDirection: "row-reverse", gap: 6, marginTop: 14, paddingHorizontal: 4, paddingVertical: 8 },
  policyLinkText: { color: "#075B4E", fontSize: 12, fontWeight: "800", textDecorationLine: "underline" },
});
