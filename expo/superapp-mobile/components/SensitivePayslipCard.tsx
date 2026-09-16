import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Card } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import { exportPersonalPayslipPdf } from "@/lib/payslipExport";
import { formatIqd } from "@/lib/format";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import {
  revealNativeMobilePayslip,
  type MobileToday,
  type MobilePayslip,
} from "@/lib/secureTransport";

type VerificationKind = "TOTP" | "RECOVERY";

function statusText(status: "approved" | "paid"): string {
  return status === "paid" ? "مصروفة" : "معتمدة";
}

function amount(value: string): string {
  return formatIqd(value);
}

function addDecimalStrings(left: string, right: string): string {
  const parse = (value: string) => {
    const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
    if (!match) throw new Error("قيمة المبلغ غير صالحة للعرض.");
    const scale = 4;
    return BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(scale, "0"));
  };
  const total = parse(left) + parse(right);
  const whole = total / 10_000n;
  const fraction = (total % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * The amount is never fetched on initial render. It becomes visible only after
 * a new, server-consumed second factor; the app never asks for a password or
 * retains the code after the native request finishes.
 */
export function SensitivePayslipCard({
  employeeName,
  payroll,
}: {
  employeeName: string;
  payroll: MobileToday["personal"]["payroll"];
}) {
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [kind, setKind] = useState<VerificationKind>("TOTP");
  const [value, setValue] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [payslip, setPayslip] = useState<MobilePayslip["personal"]["payslip"] | null>(null);

  useEffect(() => {
    // A newer payroll period must never leave a previous sensitive amount on screen.
    setPayslip(null);
    setValue("");
    setVerificationOpen(false);
  }, [payroll?.period]);

  if (!payroll) {
    return (
      <Card>
        <Text style={styles.title}>لا توجد قسيمة متاحة الآن</Text>
        <Text style={styles.text}>لا تعرض الشاشة راتباً أو بدلات أو تفاصيل مالية عند غياب القسيمة المعتمدة.</Text>
      </Card>
    );
  }

  const reveal = async () => {
    const clean = value.trim();
    if (!clean) {
      Alert.alert("أدخل رمز التحقق", kind === "TOTP" ? "أدخل الرمز المؤقت المكوّن من ستة أرقام." : "أدخل رمز الاسترداد.");
      return;
    }
    setRevealing(true);
    try {
      await unlockLocalSession();
      const result = await revealNativeMobilePayslip(
        kind === "TOTP" ? { code: clean } : { recoveryCode: clean },
      );
      if (result.personal.state !== "READY" || !result.personal.payslip) {
        setPayslip(null);
        Alert.alert("لا توجد قسيمة متاحة", "لا توجد قسيمة معتمدة أو مصروفة مرتبطة بحسابك.");
        return;
      }
      setPayslip(result.personal.payslip);
      setVerificationOpen(false);
    } catch (error) {
      Alert.alert(
        "تعذر فتح القسيمة",
        error instanceof Error ? error.message : "أعد المحاولة لاحقاً.",
      );
    } finally {
      // Do not retain a TOTP or recovery value in React state after any path.
      setValue("");
      setRevealing(false);
    }
  };

  const exportPdf = async () => {
    if (!payslip) return;
    setExporting(true);
    try {
      // The server factor opened the data; a local biometric/PIN unlock keeps a
      // shoulder-surfed, still-open phone from immediately sharing it.
      await unlockLocalSession();
      await exportPersonalPayslipPdf({ employeeName, payslip });
    } catch (error) {
      Alert.alert(
        "تعذر تصدير القسيمة",
        error instanceof Error ? error.message : "أعد المحاولة لاحقاً.",
      );
    } finally {
      setExporting(false);
    }
  };

  if (!payslip) {
    return (
      <Card>
        <Text style={styles.title}>حالة القسيمة: {statusText(payroll.status)}</Text>
        <Text style={styles.text}>الفترة: {payroll.period} · فتح التفاصيل أو تصديرها يتطلب رمز تحقق ثنائي جديد.</Text>
        {!verificationOpen ? (
          <Pressable accessibilityRole="button" onPress={() => setVerificationOpen(true)} style={styles.primary}>
            <Text style={styles.primaryText}>فتح القسيمة بالتحقق الثنائي</Text>
          </Pressable>
        ) : (
          <View style={styles.verification}>
            <Text style={styles.verifyTitle}>تحقق إضافي للقسيمة</Text>
            <Text style={styles.text}>لا تكتب كلمة المرور هنا. يُستهلك الرمز مرة واحدة من الخادم.</Text>
            <View style={styles.switchRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => { setKind("TOTP"); setValue(""); }}
                style={[styles.switch, kind === "TOTP" && styles.switchActive]}
              >
                <Text style={[styles.switchText, kind === "TOTP" && styles.switchTextActive]}>رمز التطبيق</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => { setKind("RECOVERY"); setValue(""); }}
                style={[styles.switch, kind === "RECOVERY" && styles.switchActive]}
              >
                <Text style={[styles.switchText, kind === "RECOVERY" && styles.switchTextActive]}>رمز استرداد</Text>
              </Pressable>
            </View>
            <TextInput
              accessibilityLabel={kind === "TOTP" ? "رمز التحقق الثنائي" : "رمز الاسترداد"}
              autoCapitalize="characters"
              autoComplete={kind === "TOTP" ? "one-time-code" : "off"}
              keyboardType={kind === "TOTP" ? "number-pad" : "default"}
              maxLength={kind === "TOTP" ? 6 : 64}
              onChangeText={setValue}
              placeholder={kind === "TOTP" ? "000000" : "XXXXX-XXXXX"}
              placeholderTextColor={colors.mutedInk}
              secureTextEntry
              style={styles.input}
              value={value}
            />
            <Pressable
              accessibilityRole="button"
              disabled={revealing}
              onPress={() => void reveal()}
              style={[styles.primary, revealing && styles.disabled]}
            >
              <Text style={styles.primaryText}>{revealing ? "جارٍ التحقق…" : "فتح القسيمة"}</Text>
            </Pressable>
          </View>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <Text style={styles.title}>قسيمة {payslip.period} · {statusText(payslip.status)}</Text>
      <View style={styles.amountBlock}>
        <Text style={styles.amountLabel}>صافي الراتب</Text>
        <Text style={styles.amount}>{amount(payslip.net)}</Text>
      </View>
      <View style={styles.lines}>
        <PayslipLine label="الأجر الإجمالي" value={payslip.gross} />
        <PayslipLine label="البدلات" value={payslip.allowances} />
        <PayslipLine label="الإضافي والعمولات" value={addDecimalStrings(payslip.overtime, payslip.commission)} />
        <PayslipLine label="الاستقطاعات" value={payslip.deductions} />
      </View>
      <Pressable
        accessibilityLabel="تصدير قسيمة الراتب الشخصية PDF"
        accessibilityRole="button"
        disabled={exporting}
        onPress={() => void exportPdf()}
        style={[styles.export, exporting && styles.disabled]}
      >
        <Text style={styles.exportText}>{exporting ? "جارٍ تجهيز ملف PDF…" : "تصدير قسيمة الراتب PDF"}</Text>
      </Pressable>
      <Text style={styles.hint}>يُنشأ الملف مؤقتاً ثم تختار أنت جهة مشاركته؛ لا يُحفظ تلقائياً في التنزيلات.</Text>
    </Card>
  );
}

function PayslipLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{amount(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, lineHeight: 25, textAlign: "right" },
  text: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 13, lineHeight: 22, marginTop: space.xxs, textAlign: "right" },
  primary: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, justifyContent: "center", marginTop: space.md, minHeight: 48, paddingHorizontal: space.md },
  primaryText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "center" },
  verification: { borderTopColor: colors.outline, borderTopWidth: 1, marginTop: space.md, paddingTop: space.md },
  verifyTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" },
  switchRow: { flexDirection: "row-reverse", gap: space.sm, marginTop: space.md },
  switch: { alignItems: "center", borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 42, paddingHorizontal: space.sm },
  switchActive: { backgroundColor: colors.surfaceMuted, borderColor: colors.brand },
  switchText: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  switchTextActive: { color: colors.brand },
  input: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, color: colors.ink, fontFamily: "Cairo_600SemiBold", fontSize: 16, marginTop: space.md, minHeight: 48, paddingHorizontal: space.md, textAlign: "center" },
  amountBlock: { backgroundColor: colors.surfaceMuted, borderRadius: radius.field, marginTop: space.md, padding: space.md },
  amountLabel: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 12, textAlign: "right" },
  amount: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 22, lineHeight: 34, marginTop: space.xxs, textAlign: "right" },
  lines: { borderTopColor: colors.outline, borderTopWidth: 1, gap: space.sm, marginTop: space.md, paddingTop: space.md },
  line: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" },
  lineLabel: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 13 },
  lineValue: { color: colors.ink, fontFamily: "Cairo_600SemiBold", fontSize: 13 },
  export: { alignItems: "center", borderColor: colors.brand, borderRadius: radius.field, borderWidth: 1, justifyContent: "center", marginTop: space.md, minHeight: 48, paddingHorizontal: space.md },
  exportText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "center" },
  hint: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 19, marginTop: space.sm, textAlign: "right" },
  disabled: { opacity: 0.55 },
});
