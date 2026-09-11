import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { Card } from "@/components/Ui";
import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { colors, radius, space } from "@/constants/theme";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import {
  createNativeMobileRequestId,
  resolveNativeFocusedTask,
  startNativeFocusedTask,
  type MobileToday,
} from "@/lib/secureTransport";

function statusText(status: "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER"): string {
  return ({ NEW: "جديدة", IN_PROGRESS: "قيد التنفيذ", WAITING_CUSTOMER: "بانتظار العميل" })[status];
}

/** The mobile task surface is intentionally narrow: it starts or completes
 * only the focus selected by the server for this employee. */
export function FocusedTaskCard({
  detail,
  focus,
  onChanged,
}: {
  detail: string;
  focus: MobileToday["personal"]["focus"];
  onChanged(): Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; title: string; detail: string } | null>(null);
  const startKey = useRef<string | null>(null);
  const resolveKey = useRef<string | null>(null);

  if (!focus) {
    return (
      <Card>
        <Text style={styles.title}>لا توجد مهمة مخصصة الآن</Text>
        <Text style={styles.text}>{detail}</Text>
      </Card>
    );
  }

  const start = async () => {
    setStarting(true);
    setFeedback(null);
    try {
      await unlockLocalSession();
      startKey.current ??= await createNativeMobileRequestId();
      const result = await startNativeFocusedTask(startKey.current);
      startKey.current = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setFeedback({ kind: "success", title: result.idempotent ? "المهمة بدأت مسبقاً" : "بدأت المهمة", detail: "تم تحديث حالة مهمتك الحالية فقط." });
      await onChanged();
    } catch (error) {
      setFeedback({ kind: "error", title: "تعذر بدء المهمة", detail: error instanceof Error ? error.message : "أعد المحاولة لاحقاً." });
    } finally {
      setStarting(false);
    }
  };

  const resolve = async () => {
    setResolving(true);
    setFeedback(null);
    try {
      await unlockLocalSession();
      resolveKey.current ??= await createNativeMobileRequestId();
      const result = await resolveNativeFocusedTask({
        resolutionNote: note,
        clientRequestId: resolveKey.current,
      });
      resolveKey.current = null;
      setNote("");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setFeedback({ kind: "success", title: result.idempotent ? "تم تأكيد الإنهاء السابق" : "اكتملت المهمة", detail: "لن ينتقل التطبيق إلى مهمة أخرى تلقائياً." });
      await onChanged();
    } catch (error) {
      setFeedback({ kind: "error", title: "تعذر إتمام المهمة", detail: error instanceof Error ? error.message : "أعد المحاولة لاحقاً." });
    } finally {
      setResolving(false);
    }
  };

  return (
    <Card>
      <View style={styles.headingRow}>
        <View style={styles.taskIcon}><Ionicons color={colors.brand} name="checkmark-done-outline" size={22} /></View>
        <View style={styles.headingBody}>
          <Text style={styles.title}>{focus.title}</Text>
          <Text style={styles.text}>{detail} · الحالة: {statusText(focus.status)}</Text>
        </View>
      </View>
      <SyncStatus label={starting || resolving ? "جارٍ إرسال التغيير" : "متصل بالمسار الآمن"} state={starting || resolving ? "pending" : "synced"} />
      {feedback ? <ExperienceState compact detail={feedback.detail} state={feedback.kind} title={feedback.title} /> : null}
      {focus.status === "NEW" ? (
        <Pressable
          accessibilityLabel="بدء المهمة الحالية"
          accessibilityRole="button"
          disabled={starting}
          onPress={() => void start()}
          style={[styles.primary, starting && styles.disabled]}
        >
          <Text style={styles.primaryText}>{starting ? "جارٍ البدء…" : "بدء المهمة"}</Text>
        </Pressable>
      ) : (
        <View style={styles.resolveArea}>
          <TextInput
            accessibilityLabel="ملاحظة إنجاز المهمة"
            maxLength={4000}
            multiline
            onChangeText={(value) => { resolveKey.current = null; setNote(value.replace(/[\r\n]+/g, " ")); }}
            placeholder="ملاحظة الإنجاز عند الحاجة"
            placeholderTextColor={colors.mutedInk}
            style={styles.input}
            textAlignVertical="top"
            value={note}
          />
          <Pressable
            accessibilityLabel="إتمام المهمة الحالية"
            accessibilityRole="button"
            disabled={resolving}
            onPress={() => void resolve()}
            style={[styles.primary, resolving && styles.disabled]}
          >
            <Text style={styles.primaryText}>{resolving ? "جارٍ الإتمام…" : "إتمام المهمة"}</Text>
          </Pressable>
        </View>
      )}
      <Text style={styles.hint}>يحدد الخادم المهمة الحالية من حسابك. لا يرسل التطبيق رقم مهمة أو موظف أو فرع.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, lineHeight: 25, textAlign: "right" },
  text: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 13, lineHeight: 22, marginTop: space.xxs, textAlign: "right" },
  primary: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, justifyContent: "center", marginTop: space.md, minHeight: 48, paddingHorizontal: space.md },
  primaryText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "center" },
  resolveArea: { borderTopColor: colors.outline, borderTopWidth: 1, marginTop: space.md, paddingTop: space.md },
  input: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, color: colors.ink, fontFamily: "Cairo_400Regular", fontSize: 14, minHeight: 92, paddingHorizontal: space.md, paddingTop: space.sm, textAlign: "right" },
  hint: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, marginTop: space.sm, textAlign: "right" },
  disabled: { opacity: 0.55 },
  headingRow: { alignItems: "flex-start", flexDirection: "row-reverse", gap: space.sm },
  headingBody: { flex: 1 },
  taskIcon: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.field, height: 44, justifyContent: "center", width: 44 },
});
