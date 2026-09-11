import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, space } from "@/constants/theme";

export type ExperienceStateKind = "loading" | "empty" | "offline" | "error" | "success" | "pending";

const presentation: Record<ExperienceStateKind, {
  color: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  surface: string;
}> = {
  loading: { color: colors.brand, icon: "sync-outline", surface: colors.brandSoft },
  empty: { color: colors.info, icon: "file-tray-outline", surface: colors.infoSoft },
  offline: { color: colors.warning, icon: "cloud-offline-outline", surface: colors.warningSoft },
  error: { color: colors.danger, icon: "alert-circle-outline", surface: colors.dangerSoft },
  success: { color: colors.success, icon: "checkmark-circle-outline", surface: colors.successSoft },
  pending: { color: colors.warning, icon: "time-outline", surface: colors.warningSoft },
};

export function ExperienceState({
  actionLabel,
  compact = false,
  detail,
  onAction,
  state,
  title,
}: {
  actionLabel?: string;
  compact?: boolean;
  detail: string;
  onAction?: () => void;
  state: ExperienceStateKind;
  title: string;
}) {
  const current = presentation[state];
  return (
    <View
      accessibilityLabel={`${title}. ${detail}`}
      accessibilityLiveRegion={state === "error" || state === "success" ? "polite" : "none"}
      accessibilityRole={state === "error" ? "alert" : undefined}
      style={[styles.container, compact && styles.compact]}
    >
      <View style={[styles.icon, { backgroundColor: current.surface }]}>
        {state === "loading" ? (
          <ActivityIndicator color={current.color} size="small" />
        ) : (
          <Ionicons color={current.color} name={current.icon} size={compact ? 20 : 25} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function SyncStatus({
  label,
  state,
}: {
  label: string;
  state: "synced" | "offline" | "pending" | "error";
}) {
  const kind: ExperienceStateKind = state === "synced" ? "success" : state;
  const current = presentation[kind];
  return (
    <View accessibilityLabel={label} accessibilityRole="text" style={[styles.sync, { backgroundColor: current.surface }]}>
      <Ionicons color={current.color} name={current.icon} size={14} />
      <Text numberOfLines={1} style={[styles.syncText, { color: current.color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    gap: space.sm,
    minHeight: 88,
    padding: space.md,
  },
  compact: { minHeight: 68, padding: space.sm },
  icon: { alignItems: "center", borderRadius: radius.field, height: 44, justifyContent: "center", width: 44 },
  body: { flex: 1 },
  title: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 14, lineHeight: 23, textAlign: "right" },
  detail: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  action: { alignItems: "center", borderColor: colors.brand, borderRadius: radius.compact, borderWidth: 1, justifyContent: "center", minHeight: 44, paddingHorizontal: space.sm },
  actionText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 12 },
  pressed: { opacity: 0.66 },
  sync: { alignItems: "center", alignSelf: "flex-start", borderRadius: radius.pill, flexDirection: "row-reverse", gap: 5, minHeight: 30, paddingHorizontal: 10 },
  syncText: { fontFamily: "Cairo_600SemiBold", fontSize: 12 },
});
