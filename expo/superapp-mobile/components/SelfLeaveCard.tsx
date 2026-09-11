import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Card } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import {
  createNativeMobileRequestId,
  requestNativeMobileLeave,
  withdrawLatestNativeMobileLeave,
  type MobileToday,
} from "@/lib/secureTransport";
import { unlockLocalSession } from "@/lib/localSessionUnlock";

const LEAVE_TYPES = ["سنوية", "مرضية", "أمومة", "بدون راتب"] as const;
type LeaveType = (typeof LEAVE_TYPES)[number];

function statusText(status: string): string {
  return ({ pending: "قيد الموافقة", approved: "موافق عليه", rejected: "مغلق أو مسحوب" })[status] ?? "تم تحديثه";
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Personal leave is intentionally a small, closed flow: no employee picker,
 * no branch selector, no leave id and no local queue. The server owns scope
 * and idempotency; native code produces the opaque retry key.
 */
export function SelfLeaveCard({
  leave,
  onChanged,
  todayDate,
}: {
  leave: MobileToday["personal"]["leave"];
  onChanged(): Promise<void>;
  todayDate: string;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>("سنوية");
  const [fromDate, setFromDate] = useState(todayDate);
  const [toDate, setToDate] = useState(todayDate);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const requestKey = useRef<string | null>(null);
  const withdrawKey = useRef<string | null>(null);

  const clearRequestRetry = () => {
    requestKey.current = null;
  };

  const submit = async () => {
    if (!validDay(fromDate) || !validDay(toDate) || toDate < fromDate) {
      Alert.alert("تحقق من التواريخ", "اكتب تاريخي البداية والنهاية بصيغة 2026-09-10، ولا تجعل النهاية قبل البداية.");
      return;
    }
    setSending(true);
    try {
      await unlockLocalSession();
      requestKey.current ??= await createNativeMobileRequestId();
      const result = await requestNativeMobileLeave({
        leaveType,
        fromDate,
        toDate,
        reason,
        clientRequestId: requestKey.current,
      });
      requestKey.current = null;
      setReason("");
      setFormOpen(false);
      Alert.alert(
        result.idempotent ? "تم تأكيد الطلب السابق" : "تم إرسال طلب الإجازة",
        `${result.leave.fromDate} إلى ${result.leave.toDate} · ${statusText(result.leave.status)}`,
      );
      await onChanged();
    } catch (error) {
      Alert.alert("تعذر إرسال طلب الإجازة", error instanceof Error ? error.message : "أعد المحاولة لاحقاً.");
    } finally {
      setSending(false);
    }
  };

  const withdraw = async () => {
    setWithdrawing(true);
    try {
      await unlockLocalSession();
      withdrawKey.current ??= await createNativeMobileRequestId();
      const result = await withdrawLatestNativeMobileLeave(withdrawKey.current);
      withdrawKey.current = null;
      Alert.alert(
        result.idempotent ? "تم تأكيد السحب السابق" : "تم سحب طلب الإجازة",
        `${result.leave.fromDate} إلى ${result.leave.toDate}`,
      );
      await onChanged();
    } catch (error) {
      Alert.alert("تعذر سحب الطلب", error instanceof Error ? error.message : "أعد المحاولة لاحقاً.");
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <Card>
      <Text style={styles.title}>{leave ? `الإجازة الأخيرة: ${statusText(leave.status)}` : "طلب إجازة"}</Text>
      <Text style={styles.text}>
        {leave ? `${leave.fromDate} إلى ${leave.toDate}` : "تُرسل بيانات طلبك فقط؛ يحدد الخادم الموظف والفرع ولا يقبل اختياراً منهما."}
      </Text>

      {leave?.status === "pending" ? (
        <Pressable
          accessibilityLabel="سحب آخر طلب إجازة معلّق"
          accessibilityRole="button"
          disabled={withdrawing}
          onPress={() => void withdraw()}
          style={[styles.outline, withdrawing && styles.disabled]}
        >
          <Text style={styles.outlineText}>{withdrawing ? "جارٍ سحب الطلب…" : "سحب الطلب المعلّق"}</Text>
        </Pressable>
      ) : null}

      {!formOpen ? (
        <Pressable accessibilityRole="button" onPress={() => setFormOpen(true)} style={styles.primary}>
          <Text style={styles.primaryText}>طلب إجازة جديدة</Text>
        </Pressable>
      ) : (
        <View style={styles.form}>
          <Text style={styles.formTitle}>تفاصيل طلب الإجازة</Text>
          <View style={styles.types}>
            {LEAVE_TYPES.map((type) => (
              <Pressable
                accessibilityRole="button"
                key={type}
                onPress={() => { clearRequestRetry(); setLeaveType(type); }}
                style={[styles.type, leaveType === type && styles.typeActive]}
              >
                <Text style={[styles.typeText, leaveType === type && styles.typeTextActive]}>{type}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            accessibilityLabel="تاريخ بداية الإجازة"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            onChangeText={(value) => { clearRequestRetry(); setFromDate(value); }}
            placeholder="2026-09-10"
            placeholderTextColor={colors.mutedInk}
            style={styles.input}
            value={fromDate}
          />
          <TextInput
            accessibilityLabel="تاريخ نهاية الإجازة"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            onChangeText={(value) => { clearRequestRetry(); setToDate(value); }}
            placeholder="2026-09-10"
            placeholderTextColor={colors.mutedInk}
            style={styles.input}
            value={toDate}
          />
          <TextInput
            accessibilityLabel="سبب الإجازة اختياري"
            maxLength={1000}
            multiline
            onChangeText={(value) => { clearRequestRetry(); setReason(value.replace(/[\r\n]+/g, " ")); }}
            placeholder="سبب مختصر اختياري"
            placeholderTextColor={colors.mutedInk}
            style={[styles.input, styles.reason]}
            textAlignVertical="top"
            value={reason}
          />
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              onPress={() => void submit()}
              style={[styles.primary, styles.action, sending && styles.disabled]}
            >
              <Text style={styles.primaryText}>{sending ? "جارٍ الإرسال…" : "إرسال الطلب"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              onPress={() => { setFormOpen(false); setReason(""); clearRequestRetry(); }}
              style={[styles.outline, styles.action]}
            >
              <Text style={styles.outlineText}>إلغاء</Text>
            </Pressable>
          </View>
        </View>
      )}
      <Text style={styles.hint}>يمنع التطبيق الإرسال المكرر داخل هذه المحاولة، والخادم يربط مفتاح الإعادة بملفك الشخصي فقط.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, lineHeight: 25, textAlign: "right" },
  text: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 13, lineHeight: 22, marginTop: space.xxs, textAlign: "right" },
  primary: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, justifyContent: "center", marginTop: space.md, minHeight: 48, paddingHorizontal: space.md },
  primaryText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "center" },
  outline: { alignItems: "center", borderColor: colors.brand, borderRadius: radius.field, borderWidth: 1, justifyContent: "center", marginTop: space.md, minHeight: 48, paddingHorizontal: space.md },
  outlineText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "center" },
  form: { borderTopColor: colors.outline, borderTopWidth: 1, marginTop: space.md, paddingTop: space.md },
  formTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" },
  types: { flexDirection: "row-reverse", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
  type: { alignItems: "center", borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, minHeight: 40, paddingHorizontal: space.sm, paddingVertical: space.xxs },
  typeActive: { backgroundColor: colors.surfaceMuted, borderColor: colors.brand },
  typeText: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  typeTextActive: { color: colors.brand },
  input: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, color: colors.ink, fontFamily: "Cairo_400Regular", fontSize: 14, marginTop: space.sm, minHeight: 48, paddingHorizontal: space.md, textAlign: "right" },
  reason: { minHeight: 96, paddingTop: space.sm },
  actions: { flexDirection: "row-reverse", gap: space.sm },
  action: { flex: 1 },
  hint: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 19, marginTop: space.sm, textAlign: "right" },
  disabled: { opacity: 0.55 },
});
