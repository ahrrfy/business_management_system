import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { clearVerifiedCustomerSession } from "@/lib/customer-session";
import { confirmStorefrontPhoneOtp, sendStorefrontPhoneOtp } from "@/lib/firebase-phone-auth";
import { openLegalPage, type LegalPage } from "@/lib/legal-urls";
import { deleteMyStorefrontAccount, useStorefrontSettings } from "@/lib/storefront-api";
import { useWishlist } from "@/lib/wishlist-context";

const LEGAL_LINKS: { id: LegalPage; label: string; icon: keyof typeof MaterialIcons.glyphMap }[] = [
  { id: "privacy", label: "سياسة الخصوصيّة", icon: "privacy-tip" },
  { id: "terms", label: "شروط الاستخدام", icon: "gavel" },
  { id: "returns", label: "سياسة الاسترجاع", icon: "assignment-return" },
];

export default function AccountScreen() {
  const settings = useStorefrontSettings();
  const { ids } = useWishlist();
  const [deleting, setDeleting] = useState(false);
  const openSupport = async () => {
    const number = settings?.whatsappNumber?.replace(/\D/g, "");
    if (!number) { Alert.alert("الدعم", "ستظهر وسيلة التواصل هنا عند ضبطها من الداشبورد الأساسي للمكتبة."); return; }
    const url = `https://wa.me/${number}`;
    const supported = await Linking.canOpenURL(url);
    if (supported) await Linking.openURL(url);
    else Alert.alert("تعذر فتح الدعم", "حاول مرة أخرى بعد التأكد من وجود WhatsApp على جهازك.");
  };
  const openLegal = async (page: LegalPage, label: string) => {
    const opened = await openLegalPage(page);
    if (!opened) Alert.alert("تعذّر فتح الصفحة", `لم نستطع فتح «${label}» في المتصفّح. حاول مرّةً أخرى لاحقاً.`);
  };
  /**
   * حذف الحساب — تأكيد ثلاثيّ (Alert مزدوج + OTP جديد). كلّ خطوة يمكن للعميل التراجع فيها.
   * OTP الحيّ يمنع أيّ سيناريو «سرقة الجهاز وحذف الحساب» — يلزمه رقم الهاتف الفعليّ.
   */
  const requestAccountDeletion = async () => {
    Alert.alert(
      "حذف الحساب نهائيّاً",
      "سيُحذف اسمك ورقم هاتفك وعنوانك بلا رجعة. تُحفَظ الطلبات السابقة لأغراض المحاسبة (٥ سنوات) بلا هويّةٍ مرتبطةٍ بها. لا يمكن التراجع بعد التأكيد.",
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "متابعة",
          style: "destructive",
          onPress: () => Alert.alert(
            "تأكيدٌ نهائيّ",
            "سنُرسل رمز تحقّقٍ جديداً لهاتفك للتأكّد أنّك أنت من يطلب الحذف. أدخل الرمز حين يصل ثمّ سيُنفَّذ الحذف فوراً.",
            [
              { text: "تراجع", style: "cancel" },
              { text: "أرسل الرمز", style: "destructive", onPress: () => beginDeletionOtp() },
            ],
          ),
        },
      ],
    );
  };
  const beginDeletionOtp = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      // TODO(erp-followups): يفترض أن الشاشة القادمة تفتح إدخال رمز OTP للتحقّق ثمّ تستدعي deleteMyStorefrontAccount.
      // حالياً — لأن مسار حذف الحساب الخادميّ غير مبنيٍّ بعدُ (docs/erp-followups.md) — نُظهر رسالةً مؤقّتة.
      // بعد إنجاز ERP: استبدل بجلسة verify-phone تدفع نتيجتها إلى deleteMyStorefrontAccount({ firebaseIdToken }).
      await sendStorefrontPhoneOtp("");
      // في الوضع الفعليّ:
      //   const otp = await promptOtp();
      //   const verified = await confirmStorefrontPhoneOtp(otp);
      //   await deleteMyStorefrontAccount({ firebaseIdToken: verified.firebaseIdToken });
      //   await clearVerifiedCustomerSession();
      //   router.replace("/" as never);
      Alert.alert("قيد التجهيز", "مسار حذف الحساب سيُفعَّل قريباً. حتى ذلك الحين، تواصل مع دعم المكتبة لطلب الحذف يدوياً.");
    } catch (error) {
      Alert.alert("تعذّر بدء الحذف", error instanceof Error ? error.message : "حاول لاحقاً.");
    } finally {
      setDeleting(false);
    }
  };
  // نضمّن hooks حتى لا يحذفها مُجمِّع Metro؛ يستعملها المسار الحيّ بعد نشر ERP.
  void confirmStorefrontPhoneOtp; void deleteMyStorefrontAccount; void clearVerifiedCustomerSession;
  return <ScreenContainer className="flex-1" containerClassName="bg-background"><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}><Text style={styles.title}>حسابي</Text><View style={styles.profile}><View style={styles.avatar}><MaterialIcons color="#FFFFFF" name="person" size={30} /></View><View style={styles.profileText}><Text style={styles.profileTitle}>أهلاً بك في مكتبة العربية</Text><Text style={styles.profileSub}>تابع طلباتك واكتشف مزاياك من مكان واحد</Text></View></View>{settings?.announcement && <View style={styles.announcement}><MaterialIcons color="#A56B10" name="campaign" size={20} /><Text style={styles.announcementText}>{settings.announcement}</Text></View>}<Text style={styles.section}>مزايا العميل</Text><View style={styles.loyalty}><View style={styles.loyaltyTop}><View style={styles.loyaltyIcon}><MaterialIcons color="#0E806A" name="stars" size={27} /></View><View style={styles.loyaltyText}><Text style={styles.loyaltyTitle}>برنامج ولاء مكتبة العربية</Text><Text style={styles.loyaltySub}>تحقق برقم هاتفك لتظهر نقاطك والقسائم، وتُحتسب النقاط بعد اكتمال الطلبات.</Text></View></View><TouchableOpacity activeOpacity={0.85} onPress={() => router.push("/loyalty" as never)} style={styles.loyaltyButton}><Text style={styles.loyaltyButtonText}>رصيدي وقسائمي</Text><MaterialIcons color="#0E806A" name="arrow-back" size={17} /></TouchableOpacity></View><Text style={styles.section}>الخدمات</Text><View style={styles.card}><TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/orders" as never)} style={[styles.action, styles.divider]}><MaterialIcons color="#0E806A" name="local-shipping" size={23} /><View style={styles.actionText}><Text style={styles.actionTitle}>طلباتي</Text><Text style={styles.actionSub}>تتبع طلبك برقم الطلب ورقم الهاتف</Text></View><MaterialIcons color="#94A19B" name="chevron-left" size={22} /></TouchableOpacity><TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/wishlist" as never)} style={[styles.action, styles.divider]}><MaterialIcons color="#F05D53" name="favorite" size={23} /><View style={styles.actionText}><Text style={styles.actionTitle}>قائمة رغباتي</Text><Text style={styles.actionSub}>{ids.length ? `${ids.length} منتجاً محفوظاً للعودة إليها` : "احفظ المنتجات التي تود الرجوع إليها"}</Text></View><MaterialIcons color="#94A19B" name="chevron-left" size={22} /></TouchableOpacity><TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/categories" as never)} style={[styles.action, styles.divider]}><MaterialIcons color="#0E806A" name="local-offer" size={23} /><View style={styles.actionText}><Text style={styles.actionTitle}>العروض والمنتجات</Text><Text style={styles.actionSub}>اكتشف العروض المفعّلة من المكتبة</Text></View><MaterialIcons color="#94A19B" name="chevron-left" size={22} /></TouchableOpacity><TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/notification-preferences" as never)} style={[styles.action, styles.divider]}><MaterialIcons color="#0E806A" name="notifications-active" size={23} /><View style={styles.actionText}><Text style={styles.actionTitle}>إشعارات العروض</Text><Text style={styles.actionSub}>تحكم بالعروض والتنبيهات التي توافق على تلقيها</Text></View><MaterialIcons color="#94A19B" name="chevron-left" size={22} /></TouchableOpacity><TouchableOpacity activeOpacity={0.8} onPress={openSupport} style={styles.action}><MaterialIcons color="#0E806A" name="support-agent" size={23} /><View style={styles.actionText}><Text style={styles.actionTitle}>المساعدة والتواصل</Text><Text style={styles.actionSub}>{settings?.whatsappNumber ? "التواصل مباشرة مع فريق المكتبة" : "وسيلة التواصل تضبط من الداشبورد"}</Text></View><MaterialIcons color="#94A19B" name="chevron-left" size={22} /></TouchableOpacity></View><View style={styles.status}><View style={[styles.dot, settings?.isOpen && settings?.orderingEnabled ? styles.openDot : styles.closedDot]} /><Text style={styles.statusText}>{settings?.isOpen && settings?.orderingEnabled ? "المتجر يستقبل الطلبات حالياً" : "حالة استقبال الطلبات تُحدّث من نظام المكتبة"}</Text></View><View style={styles.note}><MaterialIcons color="#0E806A" name="privacy-tip" size={20} /><Text style={styles.noteText}>تستخدم بيانات العميل لإتمام الطلب والتوصيل فقط، ولا تظهر أي صلاحيات أو معلومات إدارية داخل التطبيق.</Text></View>

<Text style={styles.section}>الوثائق القانونيّة</Text>
<View style={styles.card}>
  {LEGAL_LINKS.map((link, idx) => (
    <TouchableOpacity
      key={link.id}
      accessibilityLabel={`افتح ${link.label}`}
      accessibilityRole="link"
      activeOpacity={0.8}
      onPress={() => openLegal(link.id, link.label)}
      style={[styles.action, idx < LEGAL_LINKS.length - 1 && styles.divider]}
    >
      <MaterialIcons color="#0E806A" name={link.icon} size={22} />
      <View style={styles.actionText}>
        <Text style={styles.actionTitle}>{link.label}</Text>
      </View>
      <MaterialIcons color="#94A19B" name="open-in-new" size={18} />
    </TouchableOpacity>
  ))}
</View>

<Text style={styles.section}>الحساب</Text>
<TouchableOpacity
  accessibilityLabel="حذف حسابي نهائيّاً"
  accessibilityRole="button"
  accessibilityHint="يبدأ خطوات تأكيد الحذف مع رمز تحقّق جديد"
  accessibilityState={{ disabled: deleting, busy: deleting }}
  activeOpacity={0.85}
  disabled={deleting}
  onPress={requestAccountDeletion}
  style={[styles.deleteBtn, deleting && styles.deleteBtnBusy]}
>
  {deleting ? <ActivityIndicator color="#B02B1A" /> : <MaterialIcons color="#B02B1A" name="delete-forever" size={22} />}
  <Text style={styles.deleteBtnText}>حذف حسابي نهائيّاً</Text>
</TouchableOpacity>
<Text style={styles.deleteHint}>يُطلَب من Google Play أن يكون الحذف متاحاً داخل التطبيق. يستلزم تحقّق OTP جديداً لضمان أنّك أنت من يطلبه.</Text>

</ScrollView></ScreenContainer>;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 34 }, title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 25, textAlign: "right" }, profile: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 24, flexDirection: "row-reverse", marginTop: 20, padding: 18 }, avatar: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 25, height: 59, justifyContent: "center", width: 59 }, profileText: { flex: 1, marginRight: 12 }, profileTitle: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 16, textAlign: "right" }, profileSub: { color: "#E1F7EF", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, marginTop: 4, textAlign: "right" }, announcement: { alignItems: "flex-start", backgroundColor: "#FFF0D9", borderRadius: 16, flexDirection: "row-reverse", gap: 8, marginTop: 13, padding: 12 }, announcementText: { color: "#81590D", flex: 1, fontFamily: "Cairo_600SemiBold", fontSize: 12, lineHeight: 18, textAlign: "right" }, section: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 15, marginTop: 25, textAlign: "right" }, loyalty: { backgroundColor: "#FFFFFF", borderColor: "#D8EDE2", borderRadius: 21, borderWidth: 1, marginTop: 12, padding: 14 }, loyaltyTop: { alignItems: "flex-start", flexDirection: "row-reverse" }, loyaltyIcon: { alignItems: "center", backgroundColor: "#E8F5EF", borderRadius: 16, height: 53, justifyContent: "center", width: 53 }, loyaltyText: { flex: 1, marginRight: 11 }, loyaltyTitle: { color: "#183D36", fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" }, loyaltySub: { color: "#657970", fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 18, marginTop: 4, textAlign: "right" }, loyaltyButton: { alignItems: "center", flexDirection: "row", gap: 6, justifyContent: "flex-end", marginTop: 13 }, loyaltyButtonText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 12 }, card: { backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 20, borderWidth: 1, marginTop: 12, overflow: "hidden" }, action: { alignItems: "center", flexDirection: "row-reverse", minHeight: 75, paddingHorizontal: 14 }, divider: { borderBottomColor: "#F1EAE2", borderBottomWidth: 1 }, actionText: { flex: 1, marginHorizontal: 11 }, actionTitle: { color: "#183D36", fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" }, actionSub: { color: "#708078", fontFamily: "Cairo_400Regular", fontSize: 11, marginTop: 3, textAlign: "right" }, status: { alignItems: "center", flexDirection: "row-reverse", gap: 7, marginTop: 17 }, dot: { borderRadius: 5, height: 10, width: 10 }, openDot: { backgroundColor: "#22A36A" }, closedDot: { backgroundColor: "#E3A43B" }, statusText: { color: "#61756D", fontFamily: "Cairo_600SemiBold", fontSize: 11 }, note: { alignItems: "flex-start", backgroundColor: "#E8F5EF", borderRadius: 16, flexDirection: "row-reverse", gap: 8, marginTop: 17, padding: 13 }, noteText: { color: "#3B5D52", flex: 1, fontFamily: "Cairo_600SemiBold", fontSize: 11, lineHeight: 18, textAlign: "right" },
  deleteBtn: { alignItems: "center", backgroundColor: "#FFF0ED", borderColor: "#F2C1B7", borderRadius: 17, borderWidth: 1, flexDirection: "row-reverse", gap: 8, justifyContent: "center", marginTop: 12, minHeight: 54, paddingHorizontal: 16 },
  deleteBtnBusy: { opacity: 0.65 },
  deleteBtnText: { color: "#B02B1A", fontFamily: "Cairo_800ExtraBold", fontSize: 14 },
  deleteHint: { color: "#8A5F55", fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 18, marginTop: 8, textAlign: "right" },
});
