import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { NativeTurnstile } from "@/components/native-turnstile";
import { IraqiPhoneInput } from "@/components/iraqi-phone-input";
import { ScreenContainer } from "@/components/screen-container";
import {
  clearPendingCheckoutAttempt,
  requestIdForFingerprint,
} from "@/lib/checkout-attempt";
import { useCart } from "@/lib/cart-context";
import { checkoutRequestLines, checkoutSelectionFingerprint, checkoutSelectionIssue, checkoutSelectionNotes } from "@/lib/checkout-selection";
import { selectionDescription } from "@/lib/product-selection";
import {
  classifyNetworkError,
  createStorefrontOrder,
  formatIqd,
  formatLatinNumber,
  quoteStorefrontOrder,
  type StorefrontOrderQuote,
} from "@/lib/storefront-api";
import { governorates } from "@/shared/governorates";
import { canonicalIraqiLocalPhone, normalizeIraqiPhone } from "@/lib/iraqi-phone";
import { saveRecentOrder } from "@/lib/recent-orders";
import { loadVerifiedCustomerSession, type VerifiedCustomerSession } from "@/lib/customer-session";

export default function CheckoutScreen() {
  const { clearCart, isRestoring, itemCount, lines } = useCart();
  // سلّةٌ فارغةٌ عند الدخول ⇒ إعادة توجيهٍ سلسة بدل نموذجٍ يفشل عند الضغط برسالةٍ مبهمة.
  // ⚠️ P2 مراجعة Codex: يجب انتظار isRestoring=false — CartProvider يبدأ بـlines=[] أثناء
  // استعادة AsyncStorage، فتوجيهٌ فوريّ يطرد العميل العائد من checkout قبل استعادة سلّته.
  useEffect(() => {
    if (!isRestoring && lines.length === 0) {
      router.replace("/(tabs)/cart" as never);
    }
  }, [isRestoring, lines.length]);
  const [name, setName] = useState("");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [address, setAddress] = useState("");
  const [governorate, setGovernorate] = useState("baghdad");
  const [quote, setQuote] = useState<StorefrontOrderQuote | null>(null);
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(
    null,
  );
  const [couponFeedback, setCouponFeedback] = useState<string | null>(null);
  const [showGovernorates, setShowGovernorates] = useState(false);
  const [showVerification, setShowVerification] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifiedSession, setVerifiedSession] = useState<VerifiedCustomerSession | null>(null);
  useEffect(() => {
    let active = true;
    void loadVerifiedCustomerSession().then((session) => {
      if (!active || !session) return;
      setVerifiedSession(session);
      setName((current) => current || session.customer.name);
      setPhoneLocal((current) => current || canonicalIraqiLocalPhone(session.customer.phone));
    });
    return () => { active = false; };
  }, []);
  const governorateName =
    governorates.find((item) => item.id === governorate)?.name ?? "بغداد";
  const requestLines = useMemo(() => checkoutRequestLines(lines), [lines]);
  const customerSessionToken = verifiedSession && normalizeIraqiPhone(phoneLocal) === verifiedSession.customer.phone
    ? verifiedSession.token
    : undefined;
  const validate = () => {
    const selectionIssue = checkoutSelectionIssue(lines);
    if (selectionIssue) {
      setError(selectionIssue);
      return false;
    }
    if (
      !name.trim() ||
      !normalizeIraqiPhone(phoneLocal) ||
      address.trim().length < 3
    ) {
      setError("أدخل الاسم ورقم هاتف عراقي صحيحاً وعنوان التوصيل بصورة صحيحة.");
      return false;
    }
    if (requestLines.length !== lines.length || requestLines.length === 0) {
      setError(
        "تعذر التحقق من عناصر السلة. عد إلى السلة وحدّث المنتجات ثم حاول مرة أخرى.",
      );
      return false;
    }
    return true;
  };
  const prepare = async () => {
    if (submitting || !validate()) return;
    setSubmitting(true);
    setError(null);
    try {
      const nextQuote = await quoteStorefrontOrder(
        governorate,
        requestLines,
        appliedCouponCode ?? undefined,
        customerSessionToken,
      );
      setQuote(nextQuote);
      setCouponFeedback(
        nextQuote.couponCode
          ? `تم تطبيق ${nextQuote.couponProgramName ?? "الكوبون"} وخصم ${formatIqd(nextQuote.couponDiscount)}`
          : null,
      );
    } catch (reason) {
      const message = classifyNetworkError(reason).message;
      setError(message);
      if (appliedCouponCode) {
        setAppliedCouponCode(null);
        setCouponFeedback(message);
      }
    } finally {
      setSubmitting(false);
    }
  };
  const applyCoupon = () => {
    const normalized = couponDraft.trim().toUpperCase().replace(/\s+/g, "");
    if (!normalized) {
      setCouponFeedback("اكتب رمز الكوبون أولاً.");
      return;
    }
    setAppliedCouponCode(normalized);
    setCouponDraft(normalized);
    setQuote(null);
    setCouponFeedback("سيُتحقق من الكوبون عند مراجعة السعر النهائي.");
  };
  const removeCoupon = () => {
    setCouponDraft("");
    setAppliedCouponCode(null);
    setCouponFeedback(null);
    setQuote(null);
  };
  const submitVerifiedOrder = async (turnstileToken: string) => {
    if (!quote || submitting || !validate()) return;
    setShowVerification(false);
    setSubmitting(true);
    setError(null);
    try {
      const customerPhone = normalizeIraqiPhone(phoneLocal);
      if (!customerPhone) throw new Error("رقم الهاتف العراقي غير مكتمل.");
      const fingerprint = JSON.stringify({
        name: name.trim(),
        phone: customerPhone,
        governorate,
        address: address.trim(),
        couponCode: quote.couponCode,
        total: quote.total,
        selectionDetails: checkoutSelectionFingerprint(lines),
        lines: quote.lines.map((line) => [
          line.productUnitId,
          line.quantity,
          line.unitPrice,
        ]),
      });
      const clientRequestId = await requestIdForFingerprint(fingerprint);
      const result = await createStorefrontOrder({
        couponCode: quote.couponCode ?? undefined,
        customerName: name.trim(),
        customerPhone,
        governorate,
        addressText: address.trim(),
        notes: checkoutSelectionNotes(lines),
        lines: quote.lines.map((line) => ({
          productUnitId: line.productUnitId,
          quantity: line.quantity,
          expectedUnitPrice: line.unitPrice,
        })),
        expectedGrandTotal: quote.total,
        clientRequestId,
        turnstileToken,
        customerSessionToken,
      });
      const placedAt = new Date().toISOString();
      // نجاح الخادم هو الحقيقة النهائية: تعذّر التخزين المحلي لا يجوز أن يعرض
      // «فشل الطلب» بعد إنشائه فعلاً أو يدفع العميل إلى إعادة الإرسال.
      await Promise.allSettled([
        saveRecentOrder({
          orderNumber: result.orderNumber,
          phone: customerPhone,
          total: result.total,
          placedAt,
          reservationExpiresAt: result.reservationExpiresAt,
          guestTrackingToken: result.guestTrackingToken,
          guestTrackingExpiresAt: result.guestTrackingExpiresAt,
        }),
        clearPendingCheckoutAttempt(),
      ]);
      clearCart();
      router.replace({
        pathname: "/order-confirmation",
        params: { orderNumber: result.orderNumber },
      } as never);
    } catch (reason) {
      const classified = classifyNetworkError(reason);
      // ⚠️ لا إعادة محاولة تلقائية بعد فشل إنشاء الطلب: حماية من ازدواج الطلب على شبكة متذبذبة.
      const suffix =
        classified.kind === "OFFLINE" || classified.kind === "TIMEOUT"
          ? " أعد المحاولة عند توفر الاتصال، ولن نُرسل الطلب مرّتين."
          : "";
      setError(`${classified.message}${suffix}`);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 24}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.topbar}>
            <TouchableOpacity
              accessibilityLabel="رجوع"
              accessibilityRole="button"
              activeOpacity={0.8}
              disabled={submitting}
              onPress={() => router.back()}
              style={styles.back}
            >
              <MaterialIcons color="#0C5A4B" name="arrow-forward" size={23} />
            </TouchableOpacity>
            <Text style={styles.topTitle}>إتمام الطلب</Text>
            <View style={styles.back} />
          </View>
          <View style={styles.steps}>
            <View style={styles.stepActive}>
              <Text style={styles.stepNumber}>1</Text>
              <Text style={styles.stepText}>البيانات</Text>
            </View>
            <View style={styles.stepLine} />
            <View style={[styles.step, quote && styles.stepActive]}>
              <Text style={styles.stepNumber}>2</Text>
              <Text style={styles.stepText}>المراجعة</Text>
            </View>
            <View style={styles.stepLine} />
            <View style={styles.step}>
              <Text style={styles.stepNumber}>3</Text>
              <Text style={styles.stepText}>التأكيد</Text>
            </View>
          </View>
          <View style={styles.summary}>
            <View style={styles.summaryIcon}>
              <MaterialIcons color="#0C5A4B" name="shopping-bag" size={25} />
            </View>
            <View style={styles.summaryText}>
              <Text style={styles.summaryTitle}>طلبك جاهز للمراجعة</Text>
              <Text style={styles.summarySub}>
                {formatLatinNumber(itemCount)} منتجات في السلة
              </Text>
            </View>
            {quote && (
              <Text style={styles.total}>{formatIqd(quote.total)}</Text>
            )}
          </View>
          <View style={styles.selectionReview}>
            <Text style={styles.selectionReviewTitle}>اختيارات المنتجات</Text>
            {lines.map((line) => (
              <View key={line.lineId} style={styles.selectionReviewLine}>
                <Text style={styles.selectionReviewQuantity}>× {formatLatinNumber(line.quantity)}</Text>
                <View style={styles.selectionReviewCopy}>
                  <Text numberOfLines={1} style={styles.selectionReviewProduct}>{line.product.title}</Text>
                  <Text numberOfLines={3} style={styles.selectionReviewDetails}>{selectionDescription(line.selectionDetails)}</Text>
                </View>
              </View>
            ))}
          </View>
          <Text style={styles.label}>بيانات التواصل</Text>
          <View style={styles.form}>
            <TextInput
              editable={!submitting}
              placeholder="الاسم الكامل"
              placeholderTextColor="#71817B"
              style={styles.input}
              textAlign="right"
              value={name}
              onChangeText={(value) => {
                setName(value);
                setQuote(null);
              }}
            />
            <View style={styles.line} />
            <IraqiPhoneInput
              editable={!submitting}
              onChangeText={(value) => {
                setPhoneLocal(value);
                setQuote(null);
              }}
              value={phoneLocal}
            />
          </View>
          <Text style={styles.phoneHint}>
            المفتاح +964 ثابت في اليسار؛ اكتب 7XXXXXXXXX أو 07XXXXXXXXX بأرقام
            لاتينية.
          </Text>
          <Text style={styles.label}>مكان التوصيل</Text>
          <View style={styles.form}>
            <TouchableOpacity
              accessibilityLabel={`محافظة التوصيل الحالية: ${governorateName}. اضغط للتغيير`}
              accessibilityRole="button"
              activeOpacity={0.8}
              disabled={submitting}
              onPress={() => setShowGovernorates(true)}
              style={styles.governorate}
            >
              <MaterialIcons color="#0C5A4B" name="location-on" size={20} />
              <Text style={styles.governorateText}>{governorateName}</Text>
              <MaterialIcons color="#71817B" name="expand-more" size={20} />
            </TouchableOpacity>
            <View style={styles.line} />
            <TextInput
              editable={!submitting}
              multiline
              placeholder="اكتب العنوان بالتفصيل"
              placeholderTextColor="#71817B"
              style={[styles.input, styles.address]}
              textAlign="right"
              value={address}
              onChangeText={(value) => {
                setAddress(value);
                setQuote(null);
              }}
            />
          </View>
          <Text style={styles.label}>كوبون الخصم (اختياري)</Text>
          <View style={styles.couponRow}>
            <TextInput
              autoCapitalize="characters"
              editable={!submitting}
              placeholder="مثال: WELCOME10"
              placeholderTextColor="#71817B"
              style={styles.couponInput}
              textAlign="right"
              value={couponDraft}
              onChangeText={(value) => {
                setCouponDraft(value);
                if (
                  appliedCouponCode &&
                  value.trim().toUpperCase() !== appliedCouponCode
                ) {
                  setAppliedCouponCode(null);
                  setQuote(null);
                  setCouponFeedback(null);
                }
              }}
            />
            <TouchableOpacity
              accessibilityLabel={
                appliedCouponCode ? "إزالة الكوبون" : "تطبيق الكوبون"
              }
              accessibilityRole="button"
              activeOpacity={0.82}
              disabled={submitting}
              onPress={appliedCouponCode ? removeCoupon : applyCoupon}
              style={[
                styles.couponButton,
                appliedCouponCode && styles.couponButtonApplied,
              ]}
            >
              <Text style={styles.couponButtonText}>
                {appliedCouponCode ? "إزالة" : "تطبيق"}
              </Text>
            </TouchableOpacity>
          </View>
          {couponFeedback && (
            <Text
              style={[
                styles.couponFeedback,
                appliedCouponCode && styles.couponFeedbackApplied,
              ]}
            >
              {couponFeedback}
            </Text>
          )}
          {quote && (
            <View style={styles.quoteCard}>
              <Text style={styles.quoteTitle}>مراجعة السعر النهائي</Text>
              <View style={styles.quoteRow}>
                <Text style={styles.quoteValue}>
                  {formatIqd(quote.subtotal)}
                </Text>
                <Text style={styles.quoteLabel}>المنتجات</Text>
              </View>
              <View style={styles.quoteRow}>
                <Text style={styles.quoteValue}>
                  {formatIqd(quote.deliveryFee)}
                </Text>
                <Text style={styles.quoteLabel}>
                  التوصيل إلى {governorateName}
                </Text>
              </View>
              {Number(quote.couponDiscount) > 0 && (
                <View style={styles.quoteRow}>
                  <Text style={styles.discountValue}>
                    - {formatIqd(quote.couponDiscount)}
                  </Text>
                  <Text style={styles.quoteLabel}>
                    {quote.couponProgramName ?? "خصم الكوبون"}
                  </Text>
                </View>
              )}
              <View style={styles.quoteDivider} />
              <View style={styles.quoteRow}>
                <Text style={styles.finalValue}>{formatIqd(quote.total)}</Text>
                <Text style={styles.finalLabel}>الإجمالي النهائي</Text>
              </View>
              <Text style={styles.quoteNote}>
                هذه القيم محسوبة من نظام المكتبة الآن، وستثبت عند تأكيد الطلب.
              </Text>
              <View style={styles.codRow}>
                <MaterialIcons color="#0C5A4B" name="payments" size={18} />
                <Text style={styles.codText}>
                  طريقة الدفع: نقداً عند الاستلام
                </Text>
              </View>
            </View>
          )}
          <View style={styles.notice}>
            <MaterialIcons color="#0C5A4B" name="verified-user" size={20} />
            <Text style={styles.noticeText}>
              نطلب تحققاً أمنياً قصيراً فقط عند التأكيد لحماية الطلبات من
              التكرار وإساءة الاستخدام.
            </Text>
          </View>
          {error && (
            <View style={styles.error}>
              <MaterialIcons color="#B64B24" name="error-outline" size={19} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          <TouchableOpacity
            accessibilityLabel={
              quote ? "تأكيد وإرسال الطلب" : "مراجعة السعر النهائي"
            }
            accessibilityRole="button"
            accessibilityState={{ disabled: submitting, busy: submitting }}
            activeOpacity={0.88}
            disabled={submitting}
            onPress={quote ? () => setShowVerification(true) : prepare}
            style={[styles.submit, submitting && styles.submitDisabled]}
          >
            <Text style={styles.submitText}>
              {submitting
                ? "جار تحديث الطلب…"
                : quote
                  ? "تأكيد وإرسال الطلب"
                  : "مراجعة السعر النهائي"}
            </Text>
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <MaterialIcons
                color="#FFFFFF"
                name={quote ? "lock" : "arrow-back"}
                size={19}
              />
            )}
          </TouchableOpacity>
          <Text style={styles.footer}>
            لن ينشأ طلب قبل عرض السعر النهائي والتأكيد الأمني.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
      <NativeTurnstile
        visible={showVerification}
        onCancel={() => setShowVerification(false)}
        onFailure={() => {
          setShowVerification(false);
          setError("تعذر إكمال تحقق الأمان. تحقق من الاتصال ثم حاول مرة أخرى.");
        }}
        onVerified={submitVerifiedOrder}
      />
      <Modal
        animationType="slide"
        onRequestClose={() => setShowGovernorates(false)}
        presentationStyle="pageSheet"
        visible={showGovernorates}
      >
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>اختر المحافظة</Text>
          <FlatList
            data={governorates}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => {
                  setGovernorate(item.id);
                  setQuote(null);
                  setShowGovernorates(false);
                }}
                style={styles.governorateItem}
              >
                <Text style={styles.governorateItemText}>{item.name}</Text>
                {item.id === governorate && (
                  <MaterialIcons
                    color="#0C5A4B"
                    name="check-circle"
                    size={21}
                  />
                )}
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, paddingBottom: 34 },
  topbar: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 17,
  },
  back: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  topTitle: { color: "#20372F", fontSize: 17, fontWeight: "900" },
  steps: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "center",
    marginBottom: 18,
  },
  step: { alignItems: "center" },
  stepActive: { alignItems: "center" },
  stepNumber: {
    alignItems: "center",
    backgroundColor: "#E2EAE5",
    borderRadius: 11,
    color: "#547167",
    fontSize: 11,
    fontWeight: "900",
    height: 22,
    paddingTop: 3,
    textAlign: "center",
    width: 22,
  },
  stepText: { color: "#70817A", fontSize: 10, fontWeight: "800", marginTop: 4 },
  stepLine: {
    backgroundColor: "#DCE5DF",
    height: 1,
    marginHorizontal: 8,
    width: 35,
  },
  summary: {
    alignItems: "center",
    backgroundColor: "#E7F1EC",
    borderRadius: 19,
    flexDirection: "row-reverse",
    padding: 14,
  },
  summaryIcon: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    height: 47,
    justifyContent: "center",
    width: 47,
  },
  summaryText: { flex: 1, marginRight: 11 },
  summaryTitle: {
    color: "#20372F",
    fontSize: 14,
    fontWeight: "900",
    textAlign: "right",
  },
  summarySub: {
    color: "#5D756B",
    fontSize: 11,
    marginTop: 4,
    textAlign: "right",
  },
  total: { color: "#0C5A4B", fontSize: 13, fontWeight: "900" },
  selectionReview: { backgroundColor: "#FFFFFF", borderColor: "#E3E8E3", borderRadius: 16, borderWidth: 1, marginTop: 12, padding: 13 },
  selectionReviewTitle: { color: "#20372F", fontSize: 13, fontWeight: "900", textAlign: "right" },
  selectionReviewLine: { alignItems: "flex-start", borderTopColor: "#EDF0ED", borderTopWidth: 1, flexDirection: "row-reverse", marginTop: 9, paddingTop: 9 },
  selectionReviewCopy: { flex: 1 },
  selectionReviewProduct: { color: "#29483E", fontSize: 11, fontWeight: "800", textAlign: "right" },
  selectionReviewDetails: { color: "#6A7E75", fontSize: 10, lineHeight: 17, marginTop: 2, textAlign: "right" },
  selectionReviewQuantity: { color: "#0C5A4B", fontSize: 11, fontWeight: "900", marginRight: 9 },
  label: {
    color: "#20372F",
    fontSize: 14,
    fontWeight: "900",
    marginTop: 23,
    textAlign: "right",
  },
  form: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E3E8E3",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 9,
    overflow: "hidden",
  },
  couponRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 9,
  },
  couponInput: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E3E8E3",
    borderRadius: 14,
    borderWidth: 1,
    color: "#20372F",
    flex: 1,
    height: 53,
    paddingHorizontal: 14,
  },
  couponButton: {
    alignItems: "center",
    backgroundColor: "#315C72",
    borderRadius: 14,
    height: 53,
    justifyContent: "center",
    minWidth: 78,
    paddingHorizontal: 14,
  },
  couponButtonApplied: { backgroundColor: "#8B5A44" },
  couponButtonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
  couponFeedback: {
    color: "#8B5A44",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 18,
    marginTop: 7,
    textAlign: "right",
  },
  couponFeedbackApplied: { color: "#0C5A4B" },
  input: { color: "#20372F", fontSize: 14, height: 53, paddingHorizontal: 14 },
  address: { height: 90, paddingTop: 13, textAlignVertical: "top" },
  phoneHint: {
    color: "#71817B",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    lineHeight: 17,
    marginTop: 7,
    textAlign: "right",
  },
  governorate: {
    alignItems: "center",
    flexDirection: "row-reverse",
    height: 53,
    paddingHorizontal: 14,
  },
  governorateText: {
    color: "#20372F",
    flex: 1,
    fontSize: 14,
    fontWeight: "800",
    marginHorizontal: 8,
    textAlign: "right",
  },
  line: { backgroundColor: "#EDF0ED", height: 1 },
  quoteCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#DCE8E1",
    borderRadius: 19,
    borderWidth: 1,
    marginTop: 19,
    padding: 15,
  },
  quoteTitle: {
    color: "#20372F",
    fontSize: 15,
    fontWeight: "900",
    marginBottom: 8,
    textAlign: "right",
  },
  quoteRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 9,
  },
  quoteLabel: { color: "#64786F", fontSize: 12, fontWeight: "700" },
  quoteValue: { color: "#3D5A50", fontSize: 13, fontWeight: "800" },
  discountValue: { color: "#0C7A61", fontSize: 13, fontWeight: "900" },
  quoteDivider: { backgroundColor: "#E7ECE8", height: 1, marginTop: 12 },
  finalValue: {
    color: "#0C5A4B",
    fontSize: 18,
    fontWeight: "900",
    marginTop: 2,
  },
  finalLabel: {
    color: "#20372F",
    fontSize: 14,
    fontWeight: "900",
    marginTop: 5,
  },
  quoteNote: {
    color: "#687B73",
    fontSize: 10,
    lineHeight: 17,
    marginTop: 12,
    textAlign: "right",
  },
  codRow: {
    alignItems: "center",
    backgroundColor: "#E7F1EC",
    borderRadius: 12,
    flexDirection: "row-reverse",
    gap: 7,
    marginTop: 12,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  codText: {
    color: "#315B50",
    flex: 1,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "right",
  },
  notice: {
    alignItems: "flex-start",
    backgroundColor: "#E7F1EC",
    borderRadius: 14,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 17,
    padding: 12,
  },
  noticeText: {
    color: "#385A4F",
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 18,
    textAlign: "right",
  },
  error: {
    alignItems: "flex-start",
    backgroundColor: "#FFF0ED",
    borderRadius: 13,
    flexDirection: "row-reverse",
    gap: 7,
    marginTop: 12,
    padding: 11,
  },
  errorText: {
    color: "#A13E33",
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 18,
    textAlign: "right",
  },
  submit: {
    alignItems: "center",
    backgroundColor: "#0C5A4B",
    borderRadius: 16,
    flexDirection: "row-reverse",
    gap: 8,
    height: 56,
    justifyContent: "center",
    marginTop: 17,
  },
  submitDisabled: { opacity: 0.65 },
  submitText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  footer: { color: "#77867F", fontSize: 10, marginTop: 9, textAlign: "center" },
  modal: {
    backgroundColor: "#F7F5F0",
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 20,
  },
  modalTitle: {
    color: "#20372F",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 14,
    textAlign: "right",
  },
  governorateItem: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderBottomColor: "#EDF0ED",
    borderBottomWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    minHeight: 54,
    paddingHorizontal: 14,
  },
  governorateItemText: { color: "#20372F", fontSize: 14, fontWeight: "700" },
});
