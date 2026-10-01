import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { colors, radius, space } from "@/constants/theme";

type UnifiedScreenHeaderProps = {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
  rightAction?: {
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
    label: string;
  };
  badge?: {
    label: string;
    variant?: "success" | "warning" | "brand";
  };
};

export function UnifiedScreenHeader({
  title,
  subtitle,
  showBack = true,
  onBack,
  rightAction,
  badge = { label: "قاعدة بيانات الإنتاج", variant: "success" },
}: UnifiedScreenHeaderProps) {
  const handleBack = () => {
    void Haptics.selectionAsync();
    if (onBack) {
      onBack();
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(tabs)");
    }
  };

  return (
    <View style={styles.headerContainer}>
      <View style={styles.topRow}>
        {showBack ? (
          <Pressable
            accessibilityLabel="رجوع للشاشة السابقة"
            accessibilityRole="button"
            onPress={handleBack}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Ionicons color={colors.ink} name="chevron-forward" size={22} />
          </Pressable>
        ) : (
          <View style={styles.brandMark}>
            <Ionicons color={colors.surface} name="cube" size={18} />
          </View>
        )}

        <View style={styles.titleColumn}>
          <Text numberOfLines={1} style={styles.titleText}>
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={styles.subtitleText}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.actionsRow}>
          {rightAction ? (
            <Pressable
              accessibilityLabel={rightAction.label}
              accessibilityRole="button"
              onPress={() => {
                void Haptics.selectionAsync();
                rightAction.onPress();
              }}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.ink} name={rightAction.icon} size={20} />
            </Pressable>
          ) : null}

          {badge ? (
            <View
              style={[
                styles.badgeContainer,
                badge.variant === "warning" && styles.badgeWarning,
                badge.variant === "brand" && styles.badgeBrand,
              ]}
            >
              <View
                style={[
                  styles.badgeDot,
                  badge.variant === "warning" && styles.dotWarning,
                  badge.variant === "brand" && styles.dotBrand,
                ]}
              />
              <Text
                style={[
                  styles.badgeText,
                  badge.variant === "warning" && styles.badgeTextWarning,
                  badge.variant === "brand" && styles.badgeTextBrand,
                ]}
              >
                {badge.label}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  topRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: space.sm,
    justifyContent: "space-between",
  },
  brandMark: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.compact,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.outline,
    borderRadius: radius.compact,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }],
  },
  titleColumn: {
    flex: 1,
    gap: 2,
    justifyContent: "center",
  },
  titleText: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 18,
    lineHeight: 26,
    textAlign: "right",
  },
  subtitleText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "right",
  },
  actionsRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: space.xs,
  },
  badgeContainer: {
    alignItems: "center",
    backgroundColor: colors.successSoft,
    borderColor: "#A7F3D0",
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeWarning: {
    backgroundColor: colors.warningSoft,
    borderColor: "#FDE68A",
  },
  badgeBrand: {
    backgroundColor: colors.brandSoft,
    borderColor: "#A7F3D0",
  },
  badgeDot: {
    backgroundColor: colors.success,
    borderRadius: radius.pill,
    height: 6,
    width: 6,
  },
  dotWarning: {
    backgroundColor: colors.warning,
  },
  dotBrand: {
    backgroundColor: colors.brand,
  },
  badgeText: {
    color: colors.success,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  badgeTextWarning: {
    color: colors.warning,
  },
  badgeTextBrand: {
    color: colors.brand,
  },
});
