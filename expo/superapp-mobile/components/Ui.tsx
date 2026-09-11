import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, type PropsWithChildren, type ReactNode } from "react";
import { Animated, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { useReducedMotion } from "@/components/AnimatedReveal";
import { colors, radius, space } from "@/constants/theme";

export function Card({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: PropsWithChildren) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function StatusDot({ color }: { color: string }) {
  return <View accessibilityElementsHidden style={[styles.statusDot, { backgroundColor: color }]} />;
}

export function AnimatedProgress({ label, tone = "dark", value }: { label: string; tone?: "dark" | "light"; value: number }) {
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const safeValue = Math.max(0, Math.min(100, value));

  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(safeValue);
      return;
    }
    Animated.timing(progress, {
      duration: 680,
      toValue: safeValue,
      useNativeDriver: false,
    }).start();
  }, [progress, reducedMotion, safeValue]);

  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ max: 100, min: 0, now: safeValue, text: `${safeValue}%` }}
      style={[styles.progressTrack, tone === "light" && styles.progressTrackLight]}
    >
      <Animated.View
        style={[
          styles.progressFill,
          tone === "light" && styles.progressFillLight,
          { width: progress.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) },
        ]}
      />
    </View>
  );
}

export function AppMasthead({
  avatar,
  children,
  name,
  role,
  subtitle,
  title,
}: PropsWithChildren<{
  avatar: string;
  children?: ReactNode;
  name: string;
  role: string;
  subtitle: string;
  title: string;
}>) {
  return (
    <View style={styles.masthead}>
      <View style={styles.mastheadTop}>
        <View style={styles.mastheadBrandMark}>
          <Ionicons color={colors.surface} name="briefcase" size={20} />
        </View>
        <View style={styles.mastheadIdentity}>
          <Text style={styles.mastheadBrand}>سوبر العربية</Text>
          <Text style={styles.mastheadRole}>{name} · {role}</Text>
        </View>
        <View style={styles.mastheadAvatar}><Text style={styles.mastheadAvatarText}>{avatar}</Text></View>
      </View>
      <View style={styles.mastheadCopy}>
        <Text style={styles.mastheadTitle}>{title}</Text>
        <Text style={styles.mastheadSubtitle}>{subtitle}</Text>
      </View>
      {children}
    </View>
  );
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 20,
    lineHeight: 30,
    textAlign: "right",
  },
  statusDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  progressTrack: { backgroundColor: "#FFFFFF30", borderRadius: radius.pill, height: 7, overflow: "hidden", width: "100%" },
  progressFill: { backgroundColor: "#35D796", borderRadius: radius.pill, height: "100%" },
  progressTrackLight: { backgroundColor: colors.outline },
  progressFillLight: { backgroundColor: colors.brand },
  masthead: {
    backgroundColor: colors.brandDark,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    gap: space.lg,
    marginHorizontal: -space.md,
    marginTop: -space.md,
    overflow: "hidden",
    paddingBottom: space.xl,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  mastheadTop: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm },
  mastheadBrandMark: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  mastheadIdentity: { flex: 1 },
  mastheadBrand: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 16, textAlign: "right" },
  mastheadRole: { color: "#D1D7F3", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, marginTop: 1, textAlign: "right" },
  mastheadAvatar: {
    alignItems: "center",
    backgroundColor: "#FFFFFF1A",
    borderColor: "#FFFFFF45",
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  mastheadAvatarText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 15 },
  mastheadCopy: { gap: 2 },
  mastheadTitle: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 30, lineHeight: 42, textAlign: "right" },
  mastheadSubtitle: { color: "#C5CCEA", fontFamily: "Cairo_400Regular", fontSize: 13, lineHeight: 21, textAlign: "right" },
});
