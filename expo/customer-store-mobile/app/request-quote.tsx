import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { IraqiPhoneInput } from "@/components/iraqi-phone-input";
import { NativeTurnstile } from "@/components/native-turnstile";
import { ScreenContainer } from "@/components/screen-container";
import { requestIdForFingerprint } from "@/lib/checkout-attempt";
import { useCart } from "@/lib/cart-context";
import { checkoutRequestLines } from "@/lib/checkout-selection";
import { loadVerifiedCustomerSession, type VerifiedCustomerSession } from "@/lib/customer-session";
import { canonicalIraqiLocalPhone, normalizeIraqiPhone } from "@/lib/iraqi-phone";
import { selectionDescription } from "@/lib/product-selection";
import { saveRecentQuoteRequest } from "@/lib/recent-quote-requests";
import { classifyNetworkError, createStorefrontQuoteRequest } from "@/lib/storefront-api";
import { governorates } from "@/shared/governorates";

type QuoteType = "BULK" | "CUSTOM_PRINT" | "BUSINESS" | "GENERAL";
const quoteTypes: { value: QuoteType; label: string }[] = [
  { value: "BULK", label: "كمية وجملة" },
  { value: "CUSTOM_PRINT", label: "طباعة وتخصيص" },
  { value: "BUSINESS", label: "شركة أو مكتب" },
  { value: "GENERAL", label: "طلب مبيعات" },
];

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function RequestQuoteScreen() {
  const params = useLocalSearchParams<{
    productUnitId?: string | string[];
    productTitle?: string | string[];
    selection?: string | string[];
  }>();
  const { isRestoring, lines } = useCart();
  const directProductUnitId = Number(firstValue(params.productUnitId));
  const directProductTitle = firstValue(params.productTitle)?.trim().slice(0, 120) ?? "";
  const directSelection = firstValue(params.selection)?.trim().slice(0, 500) ?? "";
  const requestLines = useMemo(() => {
    const merged = new Map(checkoutRequestLines(lines).map((line) => [line.productUnitId, line.quantity]));
    if (Number.isSafeInteger(directProductUnitId) && directProductUnitId > 0) {
      merged.set(directProductUnitId, Math.max(1, merged.get(directProductUnitId) ?? 0));
    }
    return Array.from(merged, ([productUnitId, quantity]) => ({ productUnitId, quantity }));
  }, [directProductUnitId, lines]);
  const [name, setName] = useState("");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [governorate, setGovernorate] = useState("baghdad");
  const [requestType, setRequestType] = useState<QuoteType>("BULK");
  const [contactPreference, setContactPreference] = useState<"PHONE" | "WHATSAPP">("WHATSAPP");
  const [note, setNote] = useState("");
  const [session, setSession] = useState<VerifiedCustomerSession | null>(null);
  const [showVerification, setShowVerification] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestNumber, setRequestNumber] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isSafeInteger(directProductUnitId) || directProductUnitId <= 0) return;
    setRequestType("CUSTOM_PRINT");
    if (directSelection) {
      setNote((current) => current || `تفاصيل التخصيص: ${directSelection}`);
    }
  }, [directProductUnitId, directSelection]);

  useEffect(() => {
    let active = true;
    void loadVerifiedCustomerSession().then((value) => {
      if (!active || !value) return;
      setSession(value);
      setName((current) => current || value.customer.name);
      setPhoneLocal((current) => current || canonicalIraqiLocalPhone(value.customer.phone));
    });
    return () => { active = false; };
  }, []);

  const submitVerifiedQuoteRequest = async (turnstileToken: string) => {
    setShowVerification(false);
    const customerPhone = normalizeIraqiPhone(phoneLocal);
    if (!name.trim() || !customerPhone || note.trim().length < 5 || requestLines.length === 0) {
      setError("أدخل الاسم ورقم هاتف عراقي ووصف احتياجك، وأضف منتجاً واحداً على الأقل إلى السلة.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const clientRequestId = await requestIdForFingerprint(JSON.stringify({
        kind: "storefront-quote-request",
        name: name.trim(),
        phone: customerPhone,
        companyName: companyName.trim(),
        governorate,
        requestType,
        contactPreference,
        note: note.trim(),
        lines: requestLines,
      }));
      const result = await createStorefrontQuoteRequest({
        customerName: name.trim(),
        customerPhone,
        companyName: companyName.trim() || undefined,
        governorate,
        requestType,
        contactPreference,
        note: note.trim(),
        clientRequestId,
        turnstileToken,
        customerSessionToken:
          session && session.customer.phone === customerPhone ? session.token : undefined,
        lines: requestLines,
      });
      await Promise.allSettled([
        saveRecentQuoteRequest({
          requestNumber: result.requestNumber,
          placedAt: new Date().toISOString(),
          guestTrackingToken: result.guestTrackingToken,
          guestTrackingExpiresAt: result.guestTrackingExpiresAt,
        }),
      ]);
      setRequestNumber(result.requestNumber);
    } catch (reason) {
      setError(classifyNetworkError(reason).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isRestoring && requestLines.length === 0 && !requestNumber) {
    return <ScreenContainer className="flex-1" containerClassName="bg-background"><View style={styles.empty}><View style={styles.emptyIcon}><MaterialIcons color="#0C5A4B" name="format-list-bulleted" size={28} /></View><Text style={styles.emptyTitle}>أضف احتياجك أولاً</Text><Text style={styles.emptyText}>اختر المنتجات أو وحدات الطباعة التي تريد تسعيرها، ثم أرسلها لفريق المبيعات.</Text><TouchableOpacity accessibilityRole="button" onPress={() => router.replace("/(tabs)/categories" as never)} style={styles.primary}><Text style={styles.primaryText}>استعرض المنتجات</Text></TouchableOpacity></View></ScreenContainer>;
  }

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.topbar}><TouchableOpacity accessibilityLabel="رجوع" accessibilityRole="button" disabled={submitting} onPress={() => router.back()} style={styles.back}><MaterialIcons color="#0C5A4B" name="arrow-forward" size={23} /></TouchableOpacity><Text style={styles.title}>طلب عرض سعر</Text><View style={styles.back} /></View>
        {requestNumber ? (
          <View style={styles.success}><View style={styles.successIcon}><MaterialIcons color="#0C5A4B" name="task-alt" size={30} /></View><Text style={styles.successTitle}>وصل طلبك إلى فريق المبيعات</Text><Text style={styles.successText}>رقم المتابعة: {requestNumber}</Text><Text style={styles.successNote}>هذا استفسار وليس طلب شراء ولا يحجز مخزوناً أو يثبت سعراً. يراجع موظف المبيعات التفاصيل ثم يصدر العرض الرسمي قبل موافقتك. وعند الموافقة، يُعاد التحقق من السعر والتوفر.</Text><TouchableOpacity accessibilityRole="button" onPress={() => router.replace({ pathname: "/orders", params: { quoteRequestNumber: requestNumber } } as never)} style={styles.primary}><Text style={styles.primaryText}>تتبع طلب العرض</Text></TouchableOpacity></View>
        ) : <>
          <View style={styles.intro}><MaterialIcons color="#0C5A4B" name="business-center" size={25} /><View style={styles.introCopy}><Text style={styles.introTitle}>للكميات والطباعة وتجهيز الشركات</Text><Text style={styles.introText}>أرسل احتياجك مرة واحدة، وسيراجع الفريق التوفر والمواصفات ويعود إليك بعرض سعر واضح.</Text></View></View>
          <View style={styles.process}><Text style={styles.processTitle}>مراحل طلب الشركات والمكاتب</Text><View style={styles.processRow}><MaterialIcons color="#0C5A4B" name="info-outline" size={18} /><Text style={styles.processText}>طلب العرض استفسار وليس طلب شراء أو حجز مخزون.</Text></View><View style={styles.processRow}><MaterialIcons color="#0C5A4B" name="fact-check" size={18} /><Text style={styles.processText}>يراجع موظف المبيعات التفاصيل ثم يصدر العرض الرسمي قبل موافقتك.</Text></View><View style={styles.processRow}><MaterialIcons color="#0C5A4B" name="sync" size={18} /><Text style={styles.processText}>عند الموافقة على العرض، يُعاد التحقق من السعر والتوفر قبل تسجيلها.</Text></View></View>
          <Text style={styles.section}>المنتجات المطلوبة</Text>
          <View style={styles.card}>{lines.map((line) => <View key={line.lineId} style={styles.line}><View style={styles.lineCopy}><Text numberOfLines={1} style={styles.lineTitle}>{line.product.title}</Text><Text numberOfLines={2} style={styles.lineSub}>{selectionDescription(line.selectionDetails)}</Text></View><Text style={styles.lineQty}>× {line.quantity}</Text></View>)}{directProductTitle ? <View style={styles.line}><View style={styles.lineCopy}><Text numberOfLines={1} style={styles.lineTitle}>{directProductTitle}</Text><Text numberOfLines={2} style={styles.lineSub}>{directSelection || "منتج مخصص — يراجع الموظف تفاصيل التجهيز والتسعير"}</Text></View><Text style={styles.lineQty}>طلب عرض</Text></View> : null}</View>
          <Text style={styles.section}>نوع الطلب</Text>
          <View style={styles.choices}>{quoteTypes.map((item) => <TouchableOpacity key={item.value} accessibilityRole="button" onPress={() => setRequestType(item.value)} style={[styles.choice, requestType === item.value && styles.choiceActive]}><Text style={[styles.choiceText, requestType === item.value && styles.choiceTextActive]}>{item.label}</Text></TouchableOpacity>)}</View>
          <Text style={styles.section}>بيانات التواصل</Text>
          <View style={styles.card}><TextInput editable={!submitting} placeholder="الاسم الكامل" placeholderTextColor="#71817B" style={styles.input} textAlign="right" value={name} onChangeText={setName} /><View style={styles.divider} /><IraqiPhoneInput editable={!submitting} value={phoneLocal} onChangeText={setPhoneLocal} /><View style={styles.divider} /><TextInput editable={!submitting} placeholder="اسم الشركة أو المكتب (اختياري)" placeholderTextColor="#71817B" style={styles.input} textAlign="right" value={companyName} onChangeText={setCompanyName} /></View>
          <Text style={styles.section}>طريقة التواصل المفضلة</Text>
          <View style={styles.choices}><TouchableOpacity accessibilityRole="button" onPress={() => setContactPreference("WHATSAPP")} style={[styles.choice, contactPreference === "WHATSAPP" && styles.choiceActive]}><Text style={[styles.choiceText, contactPreference === "WHATSAPP" && styles.choiceTextActive]}>واتساب</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" onPress={() => setContactPreference("PHONE")} style={[styles.choice, contactPreference === "PHONE" && styles.choiceActive]}><Text style={[styles.choiceText, contactPreference === "PHONE" && styles.choiceTextActive]}>اتصال هاتفي</Text></TouchableOpacity></View>
          <Text style={styles.section}>المحافظة ووصف الطلب</Text>
          <View style={styles.card}><View style={styles.governorates}>{governorates.map((item) => <TouchableOpacity key={item.id} accessibilityRole="button" onPress={() => setGovernorate(item.id)} style={[styles.governorate, governorate === item.id && styles.governorateActive]}><Text style={[styles.governorateText, governorate === item.id && styles.governorateTextActive]}>{item.name}</Text></TouchableOpacity>)}</View><View style={styles.divider} /><TextInput editable={!submitting} multiline placeholder="مثال: نحتاج طباعة شعار على الدفاتر، أو تجهيز 20 مكتباً، مع أي مقاسات أو ملاحظات مهمة." placeholderTextColor="#71817B" style={[styles.input, styles.noteInput]} textAlign="right" value={note} onChangeText={setNote} /></View>
          <View style={styles.notice}><MaterialIcons color="#0C5A4B" name="info-outline" size={20} /><Text style={styles.noticeText}>لا يترتب على طلب العرض دفع أو حجز أو سعر نهائي. يصدر موظف المبيعات عرضاً رسمياً بعد المراجعة، ثم تختار الموافقة عليه.</Text></View>
          {error && <View style={styles.error}><MaterialIcons color="#A34840" name="error-outline" size={19} /><Text style={styles.errorText}>{error}</Text></View>}
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: submitting, busy: submitting }} disabled={submitting} onPress={() => setShowVerification(true)} style={[styles.primary, submitting && styles.primaryDisabled]}>{submitting ? <ActivityIndicator color="#FFFFFF" size="small" /> : <><MaterialIcons color="#FFFFFF" name="send" size={18} /><Text style={styles.primaryText}>إرسال طلب العرض</Text></>}</TouchableOpacity>
        </>}
      </ScrollView>
      <NativeTurnstile
        visible={showVerification}
        onCancel={() => setShowVerification(false)}
        onFailure={() => {
          setShowVerification(false);
          setError("تعذر إكمال تحقق الأمان. تحقق من الاتصال ثم حاول مرة أخرى.");
        }}
        onVerified={submitVerifiedQuoteRequest}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 34 }, topbar: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" }, back: { alignItems: "center", height: 40, justifyContent: "center", width: 40 }, title: { color: "#20372F", fontSize: 20, fontWeight: "900" }, intro: { alignItems: "flex-start", backgroundColor: "#E7F1EC", borderRadius: 18, flexDirection: "row-reverse", gap: 10, marginTop: 16, padding: 15 }, introCopy: { flex: 1 }, introTitle: { color: "#20372F", fontSize: 14, fontWeight: "900", textAlign: "right" }, introText: { color: "#587067", fontSize: 11, lineHeight: 18, marginTop: 4, textAlign: "right" }, process: { backgroundColor: "#FFFFFF", borderColor: "#D8E6DE", borderRadius: 16, borderWidth: 1, marginTop: 12, padding: 13 }, processTitle: { color: "#20372F", fontSize: 13, fontWeight: "900", textAlign: "right" }, processRow: { alignItems: "flex-start", flexDirection: "row-reverse", gap: 8, marginTop: 10 }, processText: { color: "#536B61", flex: 1, fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "right" }, section: { color: "#20372F", fontSize: 14, fontWeight: "900", marginTop: 21, textAlign: "right" }, card: { backgroundColor: "#FFFFFF", borderColor: "#E3E8E3", borderRadius: 16, borderWidth: 1, marginTop: 9, overflow: "hidden" }, line: { alignItems: "center", borderBottomColor: "#EDF0ED", borderBottomWidth: 1, flexDirection: "row-reverse", justifyContent: "space-between", padding: 13 }, lineCopy: { flex: 1, marginLeft: 10 }, lineTitle: { color: "#29483E", fontSize: 12, fontWeight: "900", textAlign: "right" }, lineSub: { color: "#71817B", fontSize: 10, marginTop: 3, textAlign: "right" }, lineQty: { color: "#0C5A4B", fontSize: 13, fontWeight: "900" }, choices: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 8, marginTop: 9 }, choice: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#D9E4DE", borderRadius: 11, borderWidth: 1, minHeight: 39, paddingHorizontal: 12, paddingVertical: 9 }, choiceActive: { backgroundColor: "#0C5A4B", borderColor: "#0C5A4B" }, choiceText: { color: "#4B655B", fontSize: 11, fontWeight: "800" }, choiceTextActive: { color: "#FFFFFF" }, input: { color: "#20372F", fontSize: 13, minHeight: 48, paddingHorizontal: 13 }, divider: { backgroundColor: "#E8EDE9", height: 1 }, governorates: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 7, padding: 12 }, governorate: { backgroundColor: "#F3F6F3", borderRadius: 9, paddingHorizontal: 9, paddingVertical: 7 }, governorateActive: { backgroundColor: "#D4E8DF" }, governorateText: { color: "#526B60", fontSize: 10, fontWeight: "700" }, governorateTextActive: { color: "#0C5A4B", fontWeight: "900" }, noteInput: { lineHeight: 21, minHeight: 125, paddingTop: 12, textAlignVertical: "top" }, notice: { alignItems: "flex-start", backgroundColor: "#F1F4F1", borderRadius: 13, flexDirection: "row-reverse", gap: 8, marginTop: 16, padding: 12 }, noticeText: { color: "#536B61", flex: 1, fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "right" }, error: { alignItems: "flex-start", backgroundColor: "#FFF0ED", borderRadius: 12, flexDirection: "row-reverse", gap: 8, marginTop: 14, padding: 12 }, errorText: { color: "#A34840", flex: 1, fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "right" }, primary: { alignItems: "center", backgroundColor: "#0C5A4B", borderRadius: 14, flexDirection: "row-reverse", gap: 8, justifyContent: "center", marginTop: 18, minHeight: 50, paddingHorizontal: 20 }, primaryDisabled: { opacity: 0.65 }, primaryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" }, empty: { alignItems: "center", flex: 1, justifyContent: "center", padding: 28 }, emptyIcon: { alignItems: "center", backgroundColor: "#E7F1EC", borderRadius: 28, height: 56, justifyContent: "center", width: 56 }, emptyTitle: { color: "#20372F", fontSize: 20, fontWeight: "900", marginTop: 17 }, emptyText: { color: "#657B71", fontSize: 12, lineHeight: 20, marginTop: 8, textAlign: "center" }, success: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#D8E6DE", borderRadius: 20, borderWidth: 1, marginTop: 24, padding: 22 }, successIcon: { alignItems: "center", backgroundColor: "#E7F1EC", borderRadius: 28, height: 56, justifyContent: "center", width: 56 }, successTitle: { color: "#20372F", fontSize: 18, fontWeight: "900", marginTop: 15, textAlign: "center" }, successText: { color: "#0C5A4B", fontSize: 16, fontWeight: "900", marginTop: 9 }, successNote: { color: "#60776D", fontSize: 11, lineHeight: 19, marginTop: 14, textAlign: "center" },
});
