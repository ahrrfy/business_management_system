import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { Card } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import {
  completeNativeTwoFactor,
  signInWithNativeTransport,
} from "@/lib/secureTransport";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import { completeTwoFactorSignIn } from "@/lib/signInFlow";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";

type Step = "credentials" | "twoFactor";

const PROD_TEST_ACCOUNTS = [
  {
    roleTitle: "المدير العام والمالك",
    displayName: "أحمد خالد الزبيدي",
    identifier: "ahrrfy",
    badge: "صلاحيات كاملة",
    icon: "shield-checkmark" as const,
    color: "#0E806A",
  },
  {
    roleTitle: "مدير الفرع والمبيعات",
    displayName: "حيدر فلاح",
    identifier: "hydr.flah",
    badge: "إدارة الفروع",
    icon: "briefcase" as const,
    color: "#2563EB",
  },
  {
    roleTitle: "كاشير الصندوق والعمليات",
    displayName: "أحمد الكاشير",
    identifier: "tray",
    badge: "نقطة البيع",
    icon: "cart" as const,
    color: "#D97706",
  },
];

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/invalid login (identifier|password)/i.test(message) || /البريد أو كلمة المرور غير صحيحة/i.test(message)) {
    return "معرّف الدخول أو كلمة المرور غير صحيحة. يرجى التحقق وإعادة المحاولة.";
  }
  if (/two-factor/i.test(message) || /رمز/i.test(message)) {
    return "تعذر التحقق من رمز المصادقة. تأكد من صحة الرمز وحاول مجدداً.";
  }
  if (/session|required|network|connection|unavailable/i.test(message)) {
    return "تعذر الاتصال بالخادم المركزي للنظام. تحقق من اتصال الشبكة.";
  }
  return message || "تعذر إتمام الدخول الآمن. لم يتم حفظ أي بيانات حساسة.";
}

export default function SignInScreen() {
  const { refreshWorkspace } = useWorkspaceAccess();
  const [step, setStep] = useState<Step>("credentials");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openAllowedWorkspace = (
    next: Awaited<ReturnType<typeof refreshWorkspace>>,
  ) => {
    if (next.mode === "ready" && next.today?.navigation.ownerCenter) {
      router.replace("/(tabs)");
    } else if (next.mode === "ready" && next.today?.navigation.personal) {
      router.replace("/(tabs)/my-day");
    } else {
      router.replace("/(tabs)/work");
    }
  };

  const handleLogin = async () => {
    const trimmedId = identifier.trim();
    if (!trimmedId || !password) {
      setError("اكتب معرف الدخول وكلمة المرور.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (Platform.OS !== "web") {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      await unlockLocalSession();
      const result = await signInWithNativeTransport({
        identifier: trimmedId,
        password,
        remember,
      });
      setPassword("");
      if (result.requiresTwoFactor && result.ticket) {
        setTicket(result.ticket);
        setStep("twoFactor");
        return;
      }
      const refreshed = await refreshWorkspace({ localProtectionAlreadyConfirmed: true });
      openAllowedWorkspace(refreshed);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const selectQuickAccount = (acc: typeof PROD_TEST_ACCOUNTS[0]) => {
    if (Platform.OS !== "web") {
      void Haptics.selectionAsync().catch(() => {});
    }
    setIdentifier(acc.identifier);
    setPassword("");
    setError(null);
  };

  const submitTwoFactor = async () => {
    if (!ticket || (!twoFactorCode.trim() && !recoveryCode.trim())) {
      setError("اكتب رمز التحقق أو رمز الاسترداد.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await completeTwoFactorSignIn(
        { ticket, code: twoFactorCode, recoveryCode },
        { completeNativeTwoFactor, refreshWorkspace, unlockLocalSession },
      );
      setTwoFactorCode("");
      setRecoveryCode("");
      openAllowedWorkspace(next);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", default: undefined })}
      style={styles.page}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Brand Banner */}
        <View style={styles.brandContainer}>
          <View style={styles.logoBadge}>
            <Ionicons name="business" size={32} color="#D4AF37" />
          </View>
          <Text style={styles.companyName}>المكتبة العربية للطباعة والقرطاسية</Text>
          <Text style={styles.appName}>سوبر العربية — منظومة الرؤية</Text>
          <View style={styles.statusPill}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>قاعدة بيانات الإنتاج المركزية المتزامنة</Text>
          </View>
        </View>

        {/* Quick Roles Section */}
        {step === "credentials" && (
          <View style={styles.quickSection}>
            <View style={styles.quickSectionHeader}>
              <Ionicons name="flash-outline" size={16} color="#D4AF37" />
              <Text style={styles.quickSectionTitle}>الدخول التجريبي بالحسابات المعتمدة</Text>
            </View>
            <View style={styles.quickAccountsList}>
              {PROD_TEST_ACCOUNTS.map((acc) => (
                <Pressable
                  key={acc.identifier}
                  accessibilityRole="button"
                  onPress={() => selectQuickAccount(acc)}
                  style={({ pressed }) => [
                    styles.quickCard,
                    pressed && styles.quickCardPressed,
                  ]}
                >
                  <View style={styles.quickCardRight}>
                    <View style={[styles.quickCardIconWrap, { backgroundColor: acc.color + "18" }]}>
                      <Ionicons name={acc.icon} size={20} color={acc.color} />
                    </View>
                    <View style={styles.quickCardText}>
                      <View style={styles.quickCardTitleRow}>
                        <Text style={styles.quickCardTitle}>{acc.roleTitle}</Text>
                        <View style={[styles.quickBadge, { backgroundColor: acc.color + "15" }]}>
                          <Text style={[styles.quickBadgeText, { color: acc.color }]}>{acc.badge}</Text>
                        </View>
                      </View>
                      <Text style={styles.quickCardSub}>{acc.displayName} • ({acc.identifier})</Text>
                    </View>
                  </View>
                  <Ionicons name="arrow-back" size={16} color={colors.mutedInk} />
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Manual Credentials / Two-Factor Form */}
        <Card>
          <View style={styles.formHeader}>
            <Text style={styles.formTitle}>
              {step === "credentials" ? "الدخول اليدوي ببياناتك" : "التحقق بخطوتين (2FA)"}
            </Text>
            <Text style={styles.formSubtitle}>
              {step === "credentials"
                ? "أدخل اسم المستخدم أو البريد الإلكتروني وكلمة المرور المعتمدة بالنظام."
                : "أدخل رمز تطبيق المصادقة (TOTP) أو رمز الاسترداد المحفوظ لديك."}
            </Text>
          </View>

          {step === "credentials" ? (
            <View style={styles.form}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>اسم المستخدم أو البريد</Text>
                <View style={styles.inputContainer}>
                  <Ionicons name="person-outline" size={20} color={colors.mutedInk} style={styles.inputIcon} />
                  <TextInput
                    autoCapitalize="none"
                    autoComplete="username"
                    autoCorrect={false}
                    onChangeText={setIdentifier}
                    placeholder="مثال: ahrrfy"
                    placeholderTextColor={colors.mutedInk}
                    style={styles.field}
                    textAlign="right"
                    value={identifier}
                  />
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>كلمة المرور</Text>
                <View style={styles.inputContainer}>
                  <Pressable
                    onPress={() => setShowPassword(!showPassword)}
                    style={styles.passwordToggle}
                  >
                    <Ionicons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
                      size={20}
                      color={colors.mutedInk}
                    />
                  </Pressable>
                  <TextInput
                    autoComplete="current-password"
                    onChangeText={setPassword}
                    placeholder="••••••••••••"
                    placeholderTextColor={colors.mutedInk}
                    secureTextEntry={!showPassword}
                    style={styles.field}
                    textAlign="right"
                    value={password}
                  />
                  <Ionicons name="lock-closed-outline" size={20} color={colors.mutedInk} style={styles.inputIcon} />
                </View>
              </View>

              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: remember }}
                onPress={() => setRemember(!remember)}
                style={styles.remember}
              >
                <View style={[styles.checkbox, remember && styles.checkboxSelected]}>
                  {remember && <Ionicons name="checkmark" size={14} color="#FFF" />}
                </View>
                <Text style={styles.rememberText}>البقاء متصلاً على هذا الجهاز</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void handleLogin()}
                style={({ pressed }) => [styles.primary, (pressed || busy) && styles.primaryPressed]}
              >
                {busy ? (
                  <View style={styles.loadingRow}>
                    <Text style={styles.primaryText}>جارٍ التحقق وتوثيق الجلسة…</Text>
                  </View>
                ) : (
                  <View style={styles.loadingRow}>
                    <Ionicons name="log-in-outline" size={20} color="#FFF" />
                    <Text style={styles.primaryText}>دخول آمن للنظام</Text>
                  </View>
                )}
              </Pressable>
            </View>
          ) : (
            <View style={styles.form}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>رمز التحقق (6 أرقام)</Text>
                <TextInput
                  autoComplete="one-time-code"
                  keyboardType="number-pad"
                  maxLength={6}
                  onChangeText={(val) => setTwoFactorCode(val.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  placeholderTextColor={colors.mutedInk}
                  style={[styles.field, styles.twoFactorInput]}
                  textAlign="center"
                  value={twoFactorCode}
                />
              </View>

              <View style={styles.separator} />

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>أو رمز الاسترداد الاحتياطي</Text>
                <TextInput
                  autoCapitalize="characters"
                  autoCorrect={false}
                  onChangeText={setRecoveryCode}
                  placeholder="XXXXXXXX"
                  placeholderTextColor={colors.mutedInk}
                  style={styles.field}
                  textAlign="center"
                  value={recoveryCode}
                />
              </View>

              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void submitTwoFactor()}
                style={({ pressed }) => [styles.primary, (pressed || busy) && styles.primaryPressed]}
              >
                <Text style={styles.primaryText}>{busy ? "جارٍ التحقق…" : "إتمام المصادقة"}</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setStep("credentials");
                  setTicket(null);
                  setTwoFactorCode("");
                  setRecoveryCode("");
                  setError(null);
                }}
                style={styles.secondary}
              >
                <Text style={styles.secondaryText}>العودة لبيانات الدخول</Text>
              </Pressable>
            </View>
          )}

          {error && (
            <View style={styles.errorContainer}>
              <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
              <Text accessibilityRole="alert" style={styles.errorText}>
                {error}
              </Text>
            </View>
          )}
        </Card>

        {/* Security badge footer */}
        <View style={styles.securityFooter}>
          <Ionicons name="shield-checkmark" size={16} color={colors.brand} />
          <Text style={styles.securityFooterText}>
            جلسة مشفرة بنظام التوثيق المتعدد • متوافق مع سياسات الأمان والحراسة
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: "#061512", flex: 1 },
  content: { gap: space.md, padding: space.md, paddingTop: 40, paddingBottom: 40 },
  brandContainer: {
    alignItems: "center",
    gap: space.xs,
    paddingVertical: space.sm,
  },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: "#0A2520",
    borderWidth: 1.5,
    borderColor: "#D4AF37",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
  companyName: {
    color: "#E2E8F0",
    fontFamily: "Cairo_700Bold",
    fontSize: 19,
    textAlign: "center",
  },
  appName: {
    color: "#D4AF37",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 14,
    textAlign: "center",
  },
  statusPill: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#0E806A20",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 16,
    marginTop: space.xxs,
    borderWidth: 1,
    borderColor: "#0E806A40",
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#10B981",
  },
  statusText: {
    color: "#6EE7B7",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },

  quickSection: {
    gap: space.xs,
  },
  quickSectionHeader: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.xxs,
  },
  quickSectionTitle: {
    color: "#D4AF37",
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  quickAccountsList: {
    gap: space.xs,
  },
  quickCard: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#0C231E",
    padding: space.sm,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "#18433A",
  },
  quickCardPressed: {
    backgroundColor: "#133830",
    borderColor: "#D4AF37",
  },
  quickCardRight: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: space.sm,
    flex: 1,
  },
  quickCardIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  quickCardText: {
    flex: 1,
    gap: 2,
  },
  quickCardTitleRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 8,
  },
  quickCardTitle: {
    color: "#F8FAFC",
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  quickBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  quickBadgeText: {
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
  },
  quickCardSub: {
    color: "#94A3B8",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    textAlign: "right",
  },

  formHeader: {
    marginBottom: space.sm,
    gap: 4,
  },
  formTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 18,
    textAlign: "right",
  },
  formSubtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "right",
  },
  form: { gap: space.sm },
  fieldGroup: { gap: space.xxs },
  label: { color: colors.ink, fontFamily: "Cairo_600SemiBold", fontSize: 13, textAlign: "right" },
  inputContainer: {
    flexDirection: "row-reverse",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: 1,
    minHeight: 50,
  },
  inputIcon: {
    paddingHorizontal: space.sm,
  },
  passwordToggle: {
    paddingHorizontal: space.sm,
  },
  field: {
    flex: 1,
    color: colors.ink,
    fontFamily: "Cairo_400Regular",
    fontSize: 15,
    minHeight: 50,
    paddingHorizontal: space.xs,
  },
  twoFactorInput: {
    fontSize: 22,
    letterSpacing: 4,
    fontWeight: "bold",
  },
  remember: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: space.xs,
    minHeight: 40,
  },
  checkbox: {
    borderColor: colors.mutedInk,
    borderRadius: 5,
    borderWidth: 1.5,
    height: 20,
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  rememberText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
    textAlign: "right",
  },
  primary: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    justifyContent: "center",
    minHeight: 52,
    marginTop: space.xs,
  },
  primaryPressed: { opacity: 0.75 },
  primaryText: { color: "#FFF", fontFamily: "Cairo_700Bold", fontSize: 16 },
  loadingRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: space.xs,
  },
  secondary: { alignItems: "center", justifyContent: "center", minHeight: 44 },
  secondaryText: { color: colors.brand, fontFamily: "Cairo_600SemiBold", fontSize: 14 },
  separator: { backgroundColor: colors.outline, height: StyleSheet.hairlineWidth, marginVertical: space.xxs },
  errorContainer: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: space.xs,
    backgroundColor: "#EF444415",
    borderColor: "#EF444440",
    borderWidth: 1,
    borderRadius: radius.field,
    padding: space.sm,
    marginTop: space.xs,
  },
  errorText: {
    color: colors.danger,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    flex: 1,
    textAlign: "right",
  },
  securityFooter: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: space.xs,
  },
  securityFooterText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "center",
  },
});
