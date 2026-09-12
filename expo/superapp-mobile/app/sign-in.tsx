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

import { Card } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import {
  completeNativeTwoFactor,
  signInWithNativeTransport,
} from "@/lib/secureTransport";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";

type Step = "credentials" | "twoFactor";

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/invalid login (identifier|password)/i.test(message)) return "تحقق من بيانات الدخول ثم حاول مرة أخرى.";
  if (/two-factor/i.test(message)) return "تعذر التحقق من الرمز. تحقق منه وحاول مرة أخرى.";
  if (/session|required|network|connection|unavailable/i.test(message)) {
    return "تعذر إتمام الاتصال المحمي الآن. تحقق من الشبكة أو أعد المحاولة لاحقاً.";
  }
  return "تعذر إتمام الطلب الآن. لم يتم حفظ كلمة المرور في التطبيق.";
}

export default function SignInScreen() {
  const { refreshWorkspace } = useWorkspaceAccess();
  const [step, setStep] = useState<Step>("credentials");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openAllowedWorkspace = async () => {
    const next = await refreshWorkspace();
    if (next.mode === "ready" && next.today?.navigation.ownerCenter) {
      router.replace("/(tabs)");
    } else if (next.mode === "ready" && next.today?.navigation.personal) {
      router.replace("/(tabs)/my-day");
    } else {
      router.replace("/(tabs)/account");
    }
  };

  const submitCredentials = async () => {
    if (!identifier.trim() || !password) {
      setError("اكتب معرف الدخول وكلمة المرور.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unlockLocalSession();
      const result = await signInWithNativeTransport({
        identifier: identifier.trim(),
        password,
        remember,
      });
      setPassword("");
      if (result.requiresTwoFactor && result.ticket) {
        setTicket(result.ticket);
        setStep("twoFactor");
        return;
      }
      await openAllowedWorkspace();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitTwoFactor = async () => {
    if (!ticket || (!twoFactorCode.trim() && !recoveryCode.trim())) {
      setError("اكتب رمز التحقق أو رمز الاسترداد.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unlockLocalSession();
      await completeNativeTwoFactor({
        ticket,
        code: twoFactorCode,
        recoveryCode,
      });
      setTwoFactorCode("");
      setRecoveryCode("");
      await openAllowedWorkspace();
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
        <View style={styles.header}>
          <Text style={styles.overline}>سوبر العربية</Text>
          <Text style={styles.title}>{step === "credentials" ? "دخول آمن" : "التحقق بخطوتين"}</Text>
          <Text style={styles.subtitle}>
            {step === "credentials"
              ? "تُحفظ الجلسة داخل حماية الجهاز فقط، ولا تظهر كلمة المرور أو الرمز داخل التطبيق."
              : "أدخل رمز تطبيق المصادقة أو رمز الاسترداد لإتمام الدخول."}
          </Text>
        </View>

        <Card>
          {step === "credentials" ? (
            <View style={styles.form}>
              <Field
                autoCapitalize="none"
                autoComplete="username"
                label="معرف الدخول"
                onChangeText={setIdentifier}
                placeholder="اسم المستخدم أو البريد"
                value={identifier}
              />
              <Field
                autoComplete="current-password"
                label="كلمة المرور"
                onChangeText={setPassword}
                placeholder="كلمة المرور"
                secureTextEntry
                value={password}
              />
              <Pressable
                accessibilityHint="عند إيقافه تنتهي الجلسة بحسب سياسة الخادم"
                accessibilityRole="checkbox"
                accessibilityState={{ checked: remember }}
                onPress={() => setRemember((current) => !current)}
                style={styles.remember}
              >
                <View style={[styles.checkbox, remember && styles.checkboxSelected]} />
                <Text style={styles.rememberText}>البقاء مسجلاً على هذا الجهاز</Text>
              </Pressable>
              <ActionButton busy={busy} label="متابعة" onPress={() => void submitCredentials()} />
            </View>
          ) : (
            <View style={styles.form}>
              <Field
                autoComplete="one-time-code"
                keyboardType="number-pad"
                label="رمز التحقق"
                maxLength={6}
                onChangeText={(value) => setTwoFactorCode(value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6 أرقام"
                value={twoFactorCode}
              />
              <View style={styles.separator} />
              <Field
                autoCapitalize="characters"
                autoCorrect={false}
                label="أو رمز الاسترداد"
                onChangeText={setRecoveryCode}
                placeholder="رمز الاسترداد"
                value={recoveryCode}
              />
              <ActionButton busy={busy} label="إتمام الدخول" onPress={() => void submitTwoFactor()} />
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
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        </Card>

        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.cancel}>
          <Text style={styles.cancelText}>إلغاء</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: {
  autoCapitalize?: "none" | "characters";
  autoComplete?: "username" | "current-password" | "one-time-code";
  autoCorrect?: boolean;
  keyboardType?: "default" | "number-pad";
  label: string;
  maxLength?: number;
  onChangeText(value: string): void;
  placeholder: string;
  secureTextEntry?: boolean;
  value: string;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        autoCapitalize={props.autoCapitalize}
        autoComplete={props.autoComplete}
        autoCorrect={props.autoCorrect}
        keyboardType={props.keyboardType}
        maxLength={props.maxLength}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.mutedInk}
        secureTextEntry={props.secureTextEntry}
        style={styles.field}
        textAlign="left"
        value={props.value}
      />
    </View>
  );
}

function ActionButton({ busy, label, onPress }: { busy: boolean; label: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.primary, (pressed || busy) && styles.primaryPressed]}
    >
      <Text style={styles.primaryText}>{busy ? "جارٍ التحقق…" : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  content: { gap: space.lg, padding: space.md, paddingTop: 48 },
  header: { gap: space.xxs },
  overline: { color: colors.brand, fontFamily: "Cairo_600SemiBold", fontSize: 13, textAlign: "right" },
  title: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 28, lineHeight: 40, textAlign: "right" },
  subtitle: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 14, lineHeight: 24, textAlign: "right" },
  form: { gap: space.md },
  fieldGroup: { gap: space.xxs },
  label: { color: colors.ink, fontFamily: "Cairo_600SemiBold", fontSize: 13, textAlign: "right" },
  field: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, color: colors.ink, fontFamily: "Cairo_400Regular", fontSize: 16, minHeight: 52, paddingHorizontal: space.sm, writingDirection: "ltr" },
  remember: { alignItems: "center", flexDirection: "row-reverse", gap: space.xs, minHeight: 48 },
  checkbox: { borderColor: colors.mutedInk, borderRadius: 4, borderWidth: 1, height: 18, width: 18 },
  checkboxSelected: { backgroundColor: colors.brand, borderColor: colors.brand },
  rememberText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 13, textAlign: "right" },
  primary: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, justifyContent: "center", minHeight: 52 },
  primaryPressed: { opacity: 0.65 },
  primaryText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 16 },
  secondary: { alignItems: "center", justifyContent: "center", minHeight: 48 },
  secondaryText: { color: colors.brand, fontFamily: "Cairo_600SemiBold", fontSize: 14 },
  separator: { backgroundColor: colors.outline, height: StyleSheet.hairlineWidth },
  error: { color: colors.danger, fontFamily: "Cairo_600SemiBold", fontSize: 13, lineHeight: 22, marginTop: space.md, textAlign: "right" },
  cancel: { alignItems: "center", minHeight: 48, justifyContent: "center" },
  cancelText: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 14 },
});
