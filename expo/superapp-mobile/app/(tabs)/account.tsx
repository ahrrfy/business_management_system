import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { AppMasthead, Card } from "@/components/Ui";
import { AnimatedReveal } from "@/components/AnimatedReveal";
import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { PreviewBanner } from "@/components/PreviewBanner";
import { colors, radius, space } from "@/constants/theme";
import {
  getDeviceProofRuntimeStatus,
  getSecureTransportRuntimeStatus,
  type DeviceProofRuntimeStatus,
  type SecureTransportRuntimeStatus,
} from "@/lib/deviceProof";
import { signOutFromNativeTransport } from "@/lib/secureTransport";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";
import {
  disableSecureSuperAppNotifications,
  enableSecureSuperAppNotifications,
} from "@/lib/pushNotifications";

export default function AccountScreen() {
  const access = useWorkspaceAccess();
  const [deviceProof, setDeviceProof] = useState<DeviceProofRuntimeStatus | null>(null);
  const [transport, setTransport] = useState<SecureTransportRuntimeStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isUpdatingNotifications, setIsUpdatingNotifications] = useState(false);
  const [notificationState, setNotificationState] = useState<"idle" | "enabled" | "disabled">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSecurityDetails, setShowSecurityDetails] = useState(false);
  const [showNotificationDetails, setShowNotificationDetails] = useState(false);

  const refreshDeviceProof = useCallback(async () => {
    setIsChecking(true);
    try {
      const [proof, transportStatus] = await Promise.all([
        getDeviceProofRuntimeStatus(),
        getSecureTransportRuntimeStatus(),
      ]);
      setDeviceProof(proof);
      setTransport(transportStatus);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshDeviceProof();
  }, [refreshDeviceProof]);

  const signOut = async () => {
    setIsSigningOut(true);
    setActionError(null);
    try {
      await unlockLocalSession();
      // Logout invalidates all sessions; remove this device's push binding
      // first when the protected network path is available.
      await disableSecureSuperAppNotifications().catch(() => undefined);
      try {
        await signOutFromNativeTransport();
      } finally {
        // Clear employee data even if remote revocation cannot be confirmed.
        access.clearWorkspace();
        await refreshDeviceProof().catch(() => undefined);
      }
    } catch {
      setActionError("تعذر تأكيد الخروج من الخادم، لكن أزيلت الجلسة المحلية من الجهاز. أعد المحاولة عند توفر الشبكة إذا لزم الأمر.");
    } finally {
      setIsSigningOut(false);
    }
  };

  const updateNotifications = async (intent: "enable" | "disable") => {
    setIsUpdatingNotifications(true);
    setActionError(null);
    try {
      await unlockLocalSession();
      if (intent === "enable") {
        await enableSecureSuperAppNotifications();
        setNotificationState("enabled");
      } else {
        await disableSecureSuperAppNotifications();
        setNotificationState("disabled");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "تعذر تحديث إشعارات هذا الجهاز. أعد المحاولة لاحقاً.");
    } finally {
      setIsUpdatingNotifications(false);
    }
  };

  const description =
    isChecking || !deviceProof
      ? "يتم التحقق من توفر طبقة حماية الجهاز محليًا."
      : deviceProof.kind === "unavailable"
        ? "تحتاج هذه الميزة إلى Development Build على هاتف فعلي؛ لا يعمل المتصفح أو Expo Go كبديل أمني."
        : deviceProof.keyExists
          ? "مفتاح إثبات الجهاز موجود محليًا. تسجيله وربط الجلسة لا يتمان إلا داخل تدفق الدخول الموقّع."
          : "لا يوجد مفتاح بعد. ينشأ المفتاح داخل الحماية الأصلية عند إتمام تدفق الدخول، وليس من هذه الشاشة.";

  const isPreview = !isChecking && Platform.OS === "web" && __DEV__ && (
    transport?.kind === "unavailable" || (transport?.kind === "available" && !transport.configured)
  );
  const connectionReady = transport?.kind === "available" && transport.configured;
  const employee = access.mode === "ready" && access.today?.personal.state === "READY"
    ? access.today.personal.employee
    : null;
  const accountName = employee?.displayName || "حسابي";
  const accountRole = employee?.position || employee?.department || "حساب مؤسسي";
  const trustedDevice = connectionReady && transport?.session === "present" &&
    deviceProof?.kind === "available" && deviceProof.keyExists;
  const menuSections = [
    {
      title: "بيانات العمل",
      items: [
        { icon: "person-outline" as const, title: "بياناتي الوظيفية", detail: "المنصب والقسم ومعلومات الحساب", action: () => setShowSecurityDetails(true) },
        { icon: "calendar-outline" as const, title: "إجازاتي وطلباتي", detail: "طلب الإجازة ومتابعة حالتها", action: () => router.push("/(tabs)/my-day") },
      ],
    },
    {
      title: "مستنداتي",
      items: [
        { icon: "document-text-outline" as const, title: "سجل الحضور", detail: "عرض وتصدير سجل الدوام PDF", action: () => router.push("/(tabs)/my-day") },
        { icon: "receipt-outline" as const, title: "كشف الراتب", detail: "فتح وتصدير الكشف بعد التحقق", action: () => router.push("/(tabs)/my-day") },
      ],
    },
    {
      title: "الأمان والخصوصية",
      items: [
        { icon: "shield-checkmark-outline" as const, title: "حماية الجهاز", detail: "الجلسة والجهاز الموثق وآخر تحقق", action: () => setShowSecurityDetails(true) },
        { icon: "notifications-outline" as const, title: "الإشعارات", detail: "تنبيهات تخصك على هذا الجهاز فقط", action: () => setShowNotificationDetails(true) },
      ],
    },
  ];

  return (
    <ScrollView
      accessibilityLabel="الحساب"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl onRefresh={() => void refreshDeviceProof()} refreshing={isChecking} tintColor={colors.brand} />}
      style={styles.page}
    >
      <AppMasthead
        avatar={accountName.trim().charAt(0) || "ح"}
        name={accountName}
        role={accountRole}
        subtitle={employee ? "بياناتك وخدماتك الشخصية من النظام الأساسي" : "الحساب والجهاز والجلسة الآمنة"}
        title="حسابي"
      >
        {isPreview ? <PreviewBanner tone="dark" /> : null}
        <View style={styles.accountStatus}>
          <View style={styles.accountStatusIcon}><Ionicons color="#35D796" name="shield-checkmark" size={23} /></View>
          <View style={styles.identityBody}>
            <Text style={styles.accountStatusTitle}>{trustedDevice ? "هذا جهاز موثوق" : "خصوصيتك محمية"}</Text>
            <Text style={styles.accountStatusText}>{trustedDevice ? "آخر تحقق: هذه الجلسة · المفتاح داخل حماية الجهاز" : "لا تظهر بياناتك الحساسة قبل التحقق من الجهاز"}</Text>
          </View>
          <Ionicons color="#C7CFF1" name="chevron-back" size={18} />
        </View>
      </AppMasthead>

      <View style={styles.privacyStrip}>
        <View style={styles.privacyBody}>
          <Text style={styles.privacyTitle}>لا تظهر بياناتك إلا لك</Text>
          <Text style={styles.privacyText}>تُفتح المعلومات الحساسة بعد التحقق من الجهاز.</Text>
        </View>
        <Ionicons color={colors.brand} name="lock-closed-outline" size={23} />
      </View>

      <View style={styles.statusRow}>
        <SyncStatus label={trustedDevice ? "متصل بجهاز موثوق" : isPreview ? "معاينة محلية" : connectionReady ? "التحقق مطلوب" : "الاتصال غير متاح"} state={trustedDevice ? "synced" : isPreview ? "offline" : connectionReady ? "pending" : "offline"} />
        <Text style={styles.lastVerification}>{trustedDevice ? "تم التحقق الآن" : "لا بيانات حساسة مكشوفة"}</Text>
      </View>

      {menuSections.map((section, sectionIndex) => (
        <AnimatedReveal delay={80 + sectionIndex * 70} key={section.title}>
          <Text style={styles.groupTitle}>{section.title}</Text>
          <View style={styles.menuSurface}>
            {section.items.map((item, index) => (
              <Pressable
                accessibilityHint={item.detail}
                accessibilityRole="button"
                key={item.title}
                onPress={item.action}
                style={({ pressed }) => [styles.menuRow, index > 0 && styles.menuDivider, pressed && styles.refreshPressed]}
              >
                <View style={styles.menuIcon}><Ionicons color={colors.brand} name={item.icon} size={22} /></View>
                <View style={styles.identityBody}>
                  <Text style={styles.menuTitle}>{item.title}</Text>
                  <Text style={styles.menuDetail}>{item.detail}</Text>
                </View>
                <Ionicons color={colors.mutedInk} name="chevron-back" size={18} />
              </Pressable>
            ))}
          </View>
        </AnimatedReveal>
      ))}

      {showSecurityDetails ? (
        <Card>
          <View style={styles.detailHeader}>
            <Text style={styles.title}>حماية هذا الجهاز</Text>
            <Pressable accessibilityLabel="إغلاق تفاصيل الأمان" accessibilityRole="button" onPress={() => setShowSecurityDetails(false)} style={styles.closeAction}>
              <Ionicons color={colors.mutedInk} name="close" size={23} />
            </Pressable>
          </View>
          <Text style={styles.body}>{description}</Text>
          <ExperienceState
            compact
            detail={trustedDevice ? "المفتاح لا يغادر مخزن الجهاز، ويُطلب فتحه عند الوصول للمعلومات الحساسة." : "لن تُفتح بيانات الراتب أو الحضور الحساسة قبل اكتمال التحقق."}
            state={trustedDevice ? "success" : isChecking ? "loading" : "pending"}
            title={trustedDevice ? "الجهاز موثوق" : "التحقق مطلوب"}
          />
          {deviceProof?.kind === "available" ? (
            <Text style={styles.meta}>
              {deviceProof.storage === "android-keystore"
                ? "المخزن: Android Keystore"
                : deviceProof.storage === "ios-secure-enclave"
                  ? "المخزن: Secure Enclave"
                  : "المخزن: Keychain للمحاكي فقط"}
            </Text>
          ) : null}
          {transport?.kind === "available" ? (
            <Text style={styles.meta}>
              {transport.configured
                ? transport.session === "present"
                  ? "النقل الأصلي محمي وجلسة التطبيق محفوظة داخل الطبقة الأصلية."
                  : "النقل الأصلي مهيأ؛ لا توجد جلسة عمل حالياً."
                : "النقل الأصلي غير مهيأ في هذا البناء، لذلك تبقى البيانات المعروضة معاينة محلية."}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {transport?.kind === "available" && transport.configured ? (
              transport.session === "present" ? (
                <>
                  <Pressable accessibilityRole="button" onPress={() => router.push("/(tabs)/my-day")} style={({ pressed }) => [styles.primary, pressed && styles.refreshPressed]}>
                    <Text style={styles.primaryText}>فتح يومي</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={isSigningOut} onPress={() => void signOut()} style={({ pressed }) => [styles.signOut, (pressed || isSigningOut) && styles.refreshPressed]}>
                    <Text style={styles.signOutText}>{isSigningOut ? "جارٍ إنهاء الجلسة…" : "تسجيل الخروج"}</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable accessibilityRole="button" onPress={() => router.push("../sign-in")} style={({ pressed }) => [styles.primary, pressed && styles.refreshPressed]}>
                  <Text style={styles.primaryText}>بدء الدخول الآمن</Text>
                </Pressable>
              )
            ) : null}
            <Pressable accessibilityHint="يعيد قراءة حالة حماية الجهاز دون إنشاء أو حذف أي مفتاح" accessibilityRole="button" disabled={isChecking} onPress={() => void refreshDeviceProof()} style={({ pressed }) => [styles.refresh, (pressed || isChecking) && styles.refreshPressed]}>
              <Text style={styles.refreshText}>{isChecking ? "جارٍ الفحص…" : "إعادة الفحص"}</Text>
            </Pressable>
          </View>
          {actionError ? <ExperienceState compact detail={actionError} state="error" title="تعذر إكمال الإجراء" /> : null}
        </Card>
      ) : null}

      {showNotificationDetails ? (
        <Card>
          <View style={styles.detailHeader}>
            <Text style={styles.title}>إشعارات هذا الجهاز</Text>
            <Pressable accessibilityLabel="إغلاق تفاصيل الإشعارات" accessibilityRole="button" onPress={() => setShowNotificationDetails(false)} style={styles.closeAction}>
              <Ionicons color={colors.mutedInk} name="close" size={23} />
            </Pressable>
          </View>
          <Text style={styles.body}>تصل رسالة عامة فقط على شاشة القفل. لا تظهر تفاصيل العمل أو الراتب أو الحضور قبل فتح التطبيق.</Text>
          <Text style={styles.meta}>
            {notificationState === "enabled" ? "تم ربط الإشعارات بهذا الجهاز الموثق." : notificationState === "disabled" ? "أوقف هذا الجهاز تسليم الإشعارات من الخادم." : "التحكم اختياري ولا يغيّر إعدادات أي جهاز آخر."}
          </Text>
          {notificationState !== "idle" ? (
            <ExperienceState compact detail="ينطبق التغيير على هذا الجهاز وحده، ولا يكشف محتوى حساساً على شاشة القفل." state="success" title={notificationState === "enabled" ? "تم تفعيل الإشعارات" : "تم إيقاف الإشعارات"} />
          ) : null}
          {transport?.kind === "available" && transport.configured && transport.session === "present" ? (
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" disabled={isUpdatingNotifications} onPress={() => void updateNotifications("enable")} style={({ pressed }) => [styles.primary, (pressed || isUpdatingNotifications) && styles.refreshPressed]}>
                <Text style={styles.primaryText}>{isUpdatingNotifications ? "جارٍ التحديث…" : "تفعيل الإشعارات"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={isUpdatingNotifications} onPress={() => void updateNotifications("disable")} style={({ pressed }) => [styles.signOut, (pressed || isUpdatingNotifications) && styles.refreshPressed]}>
                <Text style={styles.signOutText}>إيقاف على هذا الجهاز</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.note}>سجّل الدخول من تطبيق الهاتف الموثق أولاً لتفعيل هذا الخيار.</Text>
          )}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  content: { gap: space.lg, padding: space.md, paddingBottom: 36 },
  identityRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm },
  avatar: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.pill, height: 42, justifyContent: "center", width: 42 },
  avatarText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 16 },
  identityBody: { flex: 1 },
  brand: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, textAlign: "right" },
  role: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  screenTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 28, lineHeight: 40, textAlign: "right" },
  screenSubtitle: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 14, lineHeight: 23, textAlign: "right" },
  privacyStrip: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.field, flexDirection: "row-reverse", gap: space.sm, padding: space.md },
  privacyBody: { flex: 1 },
  privacyTitle: { color: colors.brandDark, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" },
  privacyText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  statusRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" },
  lastVerification: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "left" },
  groupTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, lineHeight: 26, marginBottom: space.xs, textAlign: "right" },
  menuSurface: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  menuRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm, minHeight: 76, padding: space.sm },
  menuDivider: { borderTopColor: colors.outline, borderTopWidth: StyleSheet.hairlineWidth },
  menuIcon: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.compact, height: 42, justifyContent: "center", width: 42 },
  menuTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 14, lineHeight: 23, textAlign: "right" },
  menuDetail: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  detailHeader: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" },
  closeAction: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44 },
  title: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 17, lineHeight: 27, textAlign: "right" },
  body: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 14, lineHeight: 24, marginTop: space.xs, textAlign: "right" },
  meta: { color: colors.info, fontFamily: "Cairo_700Bold", fontSize: 12, lineHeight: 20, marginTop: space.sm, textAlign: "right" },
  actions: { alignItems: "stretch", gap: space.xs, marginTop: space.md },
  primary: { alignItems: "center", backgroundColor: colors.brand, borderRadius: 12, justifyContent: "center", minHeight: 48, paddingHorizontal: space.md },
  primaryText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "center" },
  refresh: { borderColor: colors.brand, borderRadius: 12, borderWidth: 1, minHeight: 48, paddingHorizontal: space.md, justifyContent: "center" },
  refreshPressed: { opacity: 0.6 },
  refreshText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "center" },
  signOut: { alignItems: "center", borderColor: colors.danger, borderRadius: 12, borderWidth: 1, justifyContent: "center", minHeight: 48, paddingHorizontal: space.md },
  signOutText: { color: colors.danger, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "center" },
  note: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 12, lineHeight: 20, marginTop: space.sm, textAlign: "right" },
  accountStatus: { alignItems: "center", backgroundColor: "#FFFFFF12", borderColor: "#FFFFFF38", borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", gap: space.sm, padding: space.sm },
  accountStatusIcon: { alignItems: "center", backgroundColor: "#35D79618", borderRadius: radius.field, height: 42, justifyContent: "center", width: 42 },
  accountStatusTitle: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" },
  accountStatusText: { color: "#D1D7F3", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, textAlign: "right" },
});
