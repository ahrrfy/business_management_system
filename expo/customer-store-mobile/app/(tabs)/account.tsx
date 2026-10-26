import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { IraqiPhoneInput } from "@/components/iraqi-phone-input";
import { ScreenContainer } from "@/components/screen-container";
import {
  ACCOUNT_DELETION_DISCLOSURE,
  confirmAndDeleteStorefrontAccountStep,
  extractIraqiPhoneLocalInput,
  isMobilePhoneOtpAvailable,
  sendAccountDeletionOtpStep,
} from "@/lib/account-deletion";
import {
  clearVerifiedCustomerSession,
  loadVerifiedCustomerSession,
  type VerifiedCustomerSession,
} from "@/lib/customer-session";
import {
  confirmStorefrontPhoneOtp,
  sendStorefrontPhoneOtp,
} from "@/lib/firebase-phone-auth";
import { LEGAL_ENABLED, openLegalPage, type LegalPage } from "@/lib/legal-urls";
import {
  deleteMyStorefrontAccount,
  useStorefrontSettings,
} from "@/lib/storefront-api";
import { useWishlist } from "@/lib/wishlist-context";

const LEGAL_LINKS: {
  id: LegalPage;
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap;
}[] = [
  { id: "privacy", label: "سياسة الخصوصيّة", icon: "privacy-tip" },
  { id: "terms", label: "شروط الاستخدام", icon: "gavel" },
  { id: "returns", label: "سياسة الاسترجاع", icon: "assignment-return" },
  { id: "deleteAccount", label: "صفحة طلب حذف الحساب", icon: "delete-forever" },
];

type DeletionModalStep = "PHONE" | "CODE" | "WEB_FALLBACK" | "DELETED";

export default function AccountScreen() {
  const settings = useStorefrontSettings();
  const { ids } = useWishlist();
  const [session, setSession] = useState<VerifiedCustomerSession | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletionStep, setDeletionStep] = useState<DeletionModalStep>(() =>
    isMobilePhoneOtpAvailable(Platform.OS) ? "PHONE" : "WEB_FALLBACK",
  );
  const [phoneLocal, setPhoneLocal] = useState("");
  const [targetPhoneDisplay, setTargetPhoneDisplay] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadVerifiedCustomerSession().then((loaded) => {
      if (!active) return;
      setSession(loaded);
      if (loaded?.customer.phone) {
        setPhoneLocal(extractIraqiPhoneLocalInput(loaded.customer.phone));
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const openSupport = async () => {
    const number = settings?.whatsappNumber?.replace(/\D/g, "");
    if (!number) {
      Alert.alert(
        "الدعم",
        "ستظهر وسيلة التواصل هنا عند ضبطها من الداشبورد الأساسي للمكتبة.",
      );
      return;
    }
    const url = `https://wa.me/${number}`;
    const can = await Linking.canOpenURL(url);
    if (can) Linking.openURL(url);
    else
      Alert.alert(
        "تعذّر فتح WhatsApp",
        "حاول مرة أخرى بعد التأكد من وجود WhatsApp على جهازك.",
      );
  };

  const openLegal = async (page: LegalPage, label: string) => {
    const opened = await openLegalPage(page);
    if (!opened)
      Alert.alert(
        "تعذّر فتح الصفحة",
        `لم نستطع فتح «${label}» في المتصفّح. حاول مرّةً أخرى لاحقاً.`,
      );
  };

  const openWebDeletionFallback = async () => {
    const opened = await openLegalPage("deleteAccount");
    if (!opened) {
      Alert.alert(
        "تعذّر فتح الصفحة",
        "لم نستطع فتح صفحة طلب حذف الحساب في المتصفّح. حاول مرة أخرى لاحقاً.",
      );
    }
  };

  const requestAccountDeletion = async () => {
    const latestSession = await loadVerifiedCustomerSession();
    setSession(latestSession);
    if (latestSession?.customer.phone) {
      setPhoneLocal(extractIraqiPhoneLocalInput(latestSession.customer.phone));
    }
    setOtpCode("");
    setDeletionError(null);
    setDeletionStep(
      isMobilePhoneOtpAvailable(Platform.OS) ? "PHONE" : "WEB_FALLBACK",
    );
    setDeleteModalOpen(true);
  };

  const handleSendDeletionOtp = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeletionError(null);
    try {
      const candidatePhone =
        session?.customer.phone &&
        extractIraqiPhoneLocalInput(session.customer.phone) === phoneLocal
          ? session.customer.phone
          : phoneLocal;
      const outcome = await sendAccountDeletionOtpStep(candidatePhone, {
        platformOs: Platform.OS,
        sendOtp: sendStorefrontPhoneOtp,
      });
      if (outcome.nextStep === "WEB_FALLBACK") {
        setDeletionStep("WEB_FALLBACK");
        setDeletionError(outcome.message);
        return;
      }
      setTargetPhoneDisplay(outcome.normalizedPhone);
      setDeletionStep("CODE");
    } catch (error) {
      setDeletionError(
        error instanceof Error
          ? error.message
          : "تعذّر إرسال رمز التحقق الهاتفي. حاول مرة أخرى.",
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleConfirmDeletionOtp = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeletionError(null);
    try {
      await confirmAndDeleteStorefrontAccountStep(otpCode, {
        confirmOtp: confirmStorefrontPhoneOtp,
        deleteAccount: deleteMyStorefrontAccount,
        clearSession: clearVerifiedCustomerSession,
      });
      setSession(null);
      setOtpCode("");
      setDeletionStep("DELETED");
    } catch (error) {
      setDeletionError(
        error instanceof Error
          ? error.message
          : "تعذّر إتمام حذف الحساب حالياً. تحقق من الرمز وحاول مرة أخرى.",
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>حسابي</Text>
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <MaterialIcons color="#FFFFFF" name="person" size={30} />
          </View>
          <View style={styles.profileText}>
            <Text style={styles.profileTitle}>
              {session?.customer.name
                ? `أهلاً بك، ${session.customer.name}`
                : "أهلاً بك في مكتبة العربية"}
            </Text>
            <Text style={styles.profileSub}>
              تابع طلباتك واكتشف مزاياك من مكان واحد
            </Text>
          </View>
        </View>
        {settings?.announcement && (
          <View style={styles.announcement}>
            <MaterialIcons color="#A56B10" name="campaign" size={20} />
            <Text style={styles.announcementText}>{settings.announcement}</Text>
          </View>
        )}
        <Text style={styles.section}>مزايا العميل</Text>
        <View style={styles.loyalty}>
          <View style={styles.loyaltyTop}>
            <View style={styles.loyaltyIcon}>
              <MaterialIcons color="#0E806A" name="stars" size={27} />
            </View>
            <View style={styles.loyaltyText}>
              <Text style={styles.loyaltyTitle}>برنامج ولاء مكتبة العربية</Text>
              <Text style={styles.loyaltySub}>
                تحقق برقم هاتفك لتظهر نقاطك والقسائم، وتُحتسب النقاط بعد اكتمال
                الطلبات.
              </Text>
            </View>
          </View>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push("/loyalty" as never)}
            style={styles.loyaltyButton}
          >
            <Text style={styles.loyaltyButtonText}>رصيدي وقسائمي</Text>
            <MaterialIcons color="#0E806A" name="arrow-back" size={17} />
          </TouchableOpacity>
        </View>
        <Text style={styles.section}>الخدمات</Text>
        <View style={styles.card}>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push("/orders" as never)}
            style={[styles.action, styles.divider]}
          >
            <MaterialIcons color="#0E806A" name="local-shipping" size={23} />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>طلباتي</Text>
              <Text style={styles.actionSub}>
                تتبع طلبك برقم الطلب ورقم الهاتف
              </Text>
            </View>
            <MaterialIcons color="#94A19B" name="chevron-left" size={22} />
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push("/request-quote" as never)}
            style={[styles.action, styles.divider]}
          >
            <MaterialIcons color="#0E806A" name="request-quote" size={23} />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>طلب عرض سعر</Text>
              <Text style={styles.actionSub}>
                للشركات والكميات والطباعة الخاصة
              </Text>
            </View>
            <MaterialIcons color="#94A19B" name="chevron-left" size={22} />
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push("/wishlist" as never)}
            style={[styles.action, styles.divider]}
          >
            <MaterialIcons color="#F05D53" name="favorite" size={23} />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>قائمة رغباتي</Text>
              <Text style={styles.actionSub}>
                {ids.length
                  ? `${ids.length} منتجاً محفوظاً للعودة إليها`
                  : "احفظ المنتجات التي تود الرجوع إليها"}
              </Text>
            </View>
            <MaterialIcons color="#94A19B" name="chevron-left" size={22} />
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push("/categories" as never)}
            style={[styles.action, styles.divider]}
          >
            <MaterialIcons color="#0E806A" name="local-offer" size={23} />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>العروض والمنتجات</Text>
              <Text style={styles.actionSub}>
                اكتشف العروض المفعّلة من المكتبة
              </Text>
            </View>
            <MaterialIcons color="#94A19B" name="chevron-left" size={22} />
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push("/notification-preferences" as never)}
            style={[styles.action, styles.divider]}
          >
            <MaterialIcons
              color="#0E806A"
              name="notifications-active"
              size={23}
            />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>إشعارات العروض</Text>
              <Text style={styles.actionSub}>
                تحكم بالعروض والتنبيهات التي توافق على تلقيها
              </Text>
            </View>
            <MaterialIcons color="#94A19B" name="chevron-left" size={22} />
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={openSupport}
            style={styles.action}
          >
            <MaterialIcons color="#0E806A" name="support-agent" size={23} />
            <View style={styles.actionText}>
              <Text style={styles.actionTitle}>المساعدة والتواصل</Text>
              <Text style={styles.actionSub}>
                {settings?.whatsappNumber
                  ? "التواصل مباشرة مع فريق المكتبة"
                  : "وسيلة التواصل تضبط من الداشبورد"}
              </Text>
            </View>
            <MaterialIcons color="#94A19B" name="chevron-left" size={22} />
          </TouchableOpacity>
        </View>
        <View style={styles.status}>
          <View
            style={[
              styles.dot,
              settings?.isOpen && settings?.orderingEnabled
                ? styles.openDot
                : styles.closedDot,
            ]}
          />
          <Text style={styles.statusText}>
            {settings?.isOpen && settings?.orderingEnabled
              ? "المتجر يستقبل الطلبات حالياً"
              : "حالة استقبال الطلبات تُحدّث من نظام المكتبة"}
          </Text>
        </View>
        <View style={styles.note}>
          <MaterialIcons color="#0E806A" name="privacy-tip" size={20} />
          <Text style={styles.noteText}>
            تستخدم بيانات العميل لإتمام الطلب والتوصيل فقط، ولا تظهر أي صلاحيات
            أو معلومات إدارية داخل التطبيق.
          </Text>
        </View>

        {LEGAL_ENABLED && (
          <>
            <Text style={styles.section}>الوثائق القانونيّة</Text>
            <View style={styles.card}>
              {LEGAL_LINKS.map((link, idx) => (
                <TouchableOpacity
                  key={link.id}
                  accessibilityLabel={`افتح ${link.label}`}
                  accessibilityRole="link"
                  activeOpacity={0.8}
                  onPress={() => openLegal(link.id, link.label)}
                  style={[
                    styles.action,
                    idx < LEGAL_LINKS.length - 1 && styles.divider,
                  ]}
                >
                  <MaterialIcons color="#0E806A" name={link.icon} size={22} />
                  <View style={styles.actionText}>
                    <Text style={styles.actionTitle}>{link.label}</Text>
                  </View>
                  <MaterialIcons color="#94A19B" name="open-in-new" size={18} />
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        <Text style={styles.section}>الحساب</Text>
        <TouchableOpacity
          accessibilityLabel="حذف حسابي نهائيّاً"
          accessibilityRole="button"
          accessibilityHint="يبدأ خطوات تأكيد الحذف الفوري عبر رمز التحقّق الهاتفي"
          accessibilityState={{ disabled: deleting, busy: deleting }}
          activeOpacity={0.85}
          disabled={deleting}
          onPress={() => void requestAccountDeletion()}
          style={[styles.deleteBtn, deleting && styles.deleteBtnBusy]}
        >
          {deleting ? (
            <ActivityIndicator color="#B02B1A" />
          ) : (
            <MaterialIcons color="#B02B1A" name="delete-forever" size={22} />
          )}
          <Text style={styles.deleteBtnText}>حذف حسابي نهائيّاً</Text>
        </TouchableOpacity>
        <Text style={styles.deleteHint}>
          {ACCOUNT_DELETION_DISCLOSURE.summary}{" "}
          {ACCOUNT_DELETION_DISCLOSURE.preconditions}
        </Text>
      </ScrollView>

      <Modal
        animationType="slide"
        onRequestClose={() => !deleting && setDeleteModalOpen(false)}
        presentationStyle="pageSheet"
        visible={deleteModalOpen}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalFlex}
        >
          <ScrollView
            contentContainerStyle={styles.modalContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {ACCOUNT_DELETION_DISCLOSURE.title}
              </Text>
              <TouchableOpacity
                accessibilityLabel="إغلاق نافذة حذف الحساب"
                accessibilityRole="button"
                disabled={deleting}
                onPress={() => setDeleteModalOpen(false)}
                style={styles.modalCloseBtn}
              >
                <MaterialIcons color="#52655D" name="close" size={22} />
              </TouchableOpacity>
            </View>

            <View style={styles.disclosureBox}>
              <Text style={styles.disclosureText}>
                {ACCOUNT_DELETION_DISCLOSURE.summary}
              </Text>
              <Text style={styles.disclosurePreconditions}>
                {ACCOUNT_DELETION_DISCLOSURE.preconditions}
              </Text>
            </View>

            {deletionStep === "DELETED" ? (
              <View style={styles.deletedCard}>
                <MaterialIcons color="#0E806A" name="check-circle" size={36} />
                <Text style={styles.deletedTitle}>تم حذف الحساب بنجاح</Text>
                <Text style={styles.deletedSub}>
                  تم إخفاء بياناتك الشخصية غير المحاسبية فوراً وإبطال الجلسات
                  الفعّالة ومسح جلسة هذا الجهاز، مع الاحتفاظ بالسجلات المحاسبية
                  القانونية لمدة 365 يوماً فقط.
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => setDeleteModalOpen(false)}
                  style={styles.modalPrimaryBtn}
                >
                  <Text style={styles.modalPrimaryBtnText}>تم</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                {deletionStep === "PHONE" && (
                  <View style={styles.stepSection}>
                    <Text style={styles.fieldLabel}>
                      رقم الهاتف المرتبط بالحساب
                    </Text>
                    <IraqiPhoneInput
                      editable={!deleting}
                      onChangeText={setPhoneLocal}
                      value={phoneLocal}
                    />
                    <Text style={styles.fieldHelp}>
                      سنرسل رمز تحقق من 6 أرقام عبر رسالة SMS لتأكيد ملكيتك
                      للرقم قبل تنفيذ الحذف الفوري.
                    </Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityState={{ disabled: deleting, busy: deleting }}
                      disabled={deleting}
                      onPress={() => void handleSendDeletionOtp()}
                      style={[
                        styles.modalDangerBtn,
                        deleting && styles.deleteBtnBusy,
                      ]}
                    >
                      {deleting ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.modalDangerBtnText}>
                          إرسال رمز التحقق للحذف الفوري
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                )}

                {deletionStep === "CODE" && (
                  <View style={styles.stepSection}>
                    <Text style={styles.fieldLabel}>
                      رمز التحقق المرسل إلى {targetPhoneDisplay || "هاتفك"}
                    </Text>
                    <TextInput
                      autoFocus
                      editable={!deleting}
                      keyboardType="number-pad"
                      maxLength={6}
                      onChangeText={setOtpCode}
                      placeholder="000000"
                      placeholderTextColor="#8A9992"
                      style={styles.otpInput}
                      textAlign="center"
                      value={otpCode}
                    />
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityState={{ disabled: deleting, busy: deleting }}
                      disabled={deleting}
                      onPress={() => void handleConfirmDeletionOtp()}
                      style={[
                        styles.modalDangerBtn,
                        deleting && styles.deleteBtnBusy,
                      ]}
                    >
                      {deleting ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.modalDangerBtnText}>
                          تأكيد الرمز وحذف الحساب نهائياً
                        </Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      disabled={deleting}
                      onPress={() => {
                        setOtpCode("");
                        setDeletionError(null);
                        setDeletionStep("PHONE");
                      }}
                      style={styles.modalSecondaryBtn}
                    >
                      <Text style={styles.modalSecondaryBtnText}>
                        تعديل الرقم أو إعادة إرسال الرمز
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {deletionError && (
                  <View style={styles.errorBox}>
                    <MaterialIcons
                      color="#B02B1A"
                      name="error-outline"
                      size={18}
                    />
                    <Text style={styles.errorText}>{deletionError}</Text>
                  </View>
                )}

                <View style={styles.webFallbackCard}>
                  <Text style={styles.webFallbackText}>
                    {ACCOUNT_DELETION_DISCLOSURE.webFallbackNote}
                  </Text>
                  <TouchableOpacity
                    accessibilityLabel="فتح صفحة طلب حذف الحساب عبر الويب"
                    accessibilityRole="link"
                    disabled={deleting}
                    onPress={() => void openWebDeletionFallback()}
                    style={styles.webFallbackBtn}
                  >
                    <MaterialIcons
                      color="#0E806A"
                      name="open-in-new"
                      size={17}
                    />
                    <Text style={styles.webFallbackBtnText}>
                      طلب حذف الحساب عبر الويب (/legal/delete-account)
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 34 },
  title: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 25,
    textAlign: "right",
  },
  profile: {
    alignItems: "center",
    backgroundColor: "#0E806A",
    borderRadius: 24,
    flexDirection: "row-reverse",
    marginTop: 20,
    padding: 18,
  },
  avatar: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: 25,
    height: 59,
    justifyContent: "center",
    width: 59,
  },
  profileText: { flex: 1, marginRight: 12 },
  profileTitle: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 16,
    textAlign: "right",
  },
  profileSub: {
    color: "#E1F7EF",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 19,
    marginTop: 4,
    textAlign: "right",
  },
  announcement: {
    alignItems: "flex-start",
    backgroundColor: "#FFF0D9",
    borderRadius: 16,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 13,
    padding: 12,
  },
  announcementText: {
    color: "#81590D",
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "right",
  },
  section: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 15,
    marginTop: 25,
    textAlign: "right",
  },
  loyalty: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D8EDE2",
    borderRadius: 21,
    borderWidth: 1,
    marginTop: 12,
    padding: 14,
  },
  loyaltyTop: { alignItems: "flex-start", flexDirection: "row-reverse" },
  loyaltyIcon: {
    alignItems: "center",
    backgroundColor: "#E8F5EF",
    borderRadius: 16,
    height: 53,
    justifyContent: "center",
    width: 53,
  },
  loyaltyText: { flex: 1, marginRight: 11 },
  loyaltyTitle: {
    color: "#183D36",
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  loyaltySub: {
    color: "#657970",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 4,
    textAlign: "right",
  },
  loyaltyButton: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "flex-end",
    marginTop: 13,
  },
  loyaltyButtonText: {
    color: "#0E806A",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#EEE3D7",
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 12,
    overflow: "hidden",
  },
  action: {
    alignItems: "center",
    flexDirection: "row-reverse",
    minHeight: 75,
    paddingHorizontal: 14,
  },
  divider: { borderBottomColor: "#F1EAE2", borderBottomWidth: 1 },
  actionText: { flex: 1, marginHorizontal: 11 },
  actionTitle: {
    color: "#183D36",
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  actionSub: {
    color: "#708078",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    marginTop: 3,
    textAlign: "right",
  },
  status: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 7,
    marginTop: 17,
  },
  dot: { borderRadius: 5, height: 10, width: 10 },
  openDot: { backgroundColor: "#22A36A" },
  closedDot: { backgroundColor: "#E3A43B" },
  statusText: {
    color: "#61756D",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  note: {
    alignItems: "flex-start",
    backgroundColor: "#E8F5EF",
    borderRadius: 16,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 17,
    padding: 13,
  },
  noteText: {
    color: "#3B5D52",
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    lineHeight: 18,
    textAlign: "right",
  },
  deleteBtn: {
    alignItems: "center",
    backgroundColor: "#FFF0ED",
    borderColor: "#F2C1B7",
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 8,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 54,
    paddingHorizontal: 16,
  },
  deleteBtnBusy: { opacity: 0.65 },
  deleteBtnText: {
    color: "#B02B1A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
  },
  deleteHint: {
    color: "#8A5F55",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 8,
    textAlign: "right",
  },
  modalFlex: { flex: 1, backgroundColor: "#F8FAF9" },
  modalContent: { padding: 20, paddingBottom: 36 },
  modalHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  modalTitle: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 19,
    textAlign: "right",
  },
  modalCloseBtn: { padding: 6 },
  disclosureBox: {
    backgroundColor: "#FFF5F3",
    borderColor: "#F2C1B7",
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  disclosureText: {
    color: "#69281D",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    lineHeight: 20,
    textAlign: "right",
  },
  disclosurePreconditions: {
    color: "#8A3A2B",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 8,
    textAlign: "right",
  },
  stepSection: { marginTop: 18 },
  fieldLabel: {
    color: "#183D36",
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    marginBottom: 8,
    textAlign: "right",
  },
  fieldHelp: {
    color: "#657970",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 6,
    textAlign: "right",
  },
  otpInput: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D7E4DD",
    borderRadius: 15,
    borderWidth: 1,
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 24,
    letterSpacing: 7,
    minHeight: 54,
    paddingHorizontal: 14,
  },
  modalDangerBtn: {
    alignItems: "center",
    backgroundColor: "#B02B1A",
    borderRadius: 15,
    justifyContent: "center",
    marginTop: 16,
    minHeight: 52,
    paddingHorizontal: 16,
  },
  modalDangerBtnText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
  },
  modalPrimaryBtn: {
    alignItems: "center",
    backgroundColor: "#0E806A",
    borderRadius: 15,
    justifyContent: "center",
    marginTop: 18,
    minHeight: 50,
    paddingHorizontal: 24,
    width: "100%",
  },
  modalPrimaryBtnText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
  },
  modalSecondaryBtn: {
    alignItems: "center",
    marginTop: 10,
    paddingVertical: 10,
  },
  modalSecondaryBtnText: {
    color: "#0E806A",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  errorBox: {
    alignItems: "flex-start",
    backgroundColor: "#FFF0ED",
    borderColor: "#F2C1B7",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 14,
    padding: 12,
  },
  errorText: {
    color: "#B02B1A",
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    lineHeight: 19,
    textAlign: "right",
  },
  webFallbackCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D8EDE2",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 18,
    padding: 14,
  },
  webFallbackText: {
    color: "#476359",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 18,
    textAlign: "right",
  },
  webFallbackBtn: {
    alignItems: "center",
    borderColor: "#0E806A",
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  webFallbackBtnText: {
    color: "#0E806A",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  deletedCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#D8EDE2",
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 18,
    padding: 20,
  },
  deletedTitle: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 17,
    marginTop: 10,
    textAlign: "center",
  },
  deletedSub: {
    color: "#52655D",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 20,
    marginTop: 8,
    textAlign: "center",
  },
});
