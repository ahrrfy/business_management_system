import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { useRef } from "react";
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  formatLatinNumber,
  type StorefrontCategory,
} from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";

export const CLAYMORPHIC_SPRING_CONFIG = {
  scale: 0.92,
  damping: 15,
  stiffness: 300,
} as const;

export type ClayTheme = {
  bg: string;
  pillBg: string;
  borderHighlight: string;
  shadowColor: string;
  iconColor: string;
  textColor: string;
};

export const CLAY_PALETTES: ClayTheme[] = [
  {
    bg: "#E6F9F3",
    pillBg: "#D1F4E8",
    borderHighlight: "rgba(255, 255, 255, 0.9)",
    shadowColor: "#059669",
    iconColor: "#059669",
    textColor: "#065F46",
  },
  {
    bg: "#FFF3EB",
    pillBg: "#FFE4D4",
    borderHighlight: "rgba(255, 255, 255, 0.9)",
    shadowColor: "#EA580C",
    iconColor: "#EA580C",
    textColor: "#9A3412",
  },
  {
    bg: "#F5F0FF",
    pillBg: "#EDE4FF",
    borderHighlight: "rgba(255, 255, 255, 0.9)",
    shadowColor: "#9333EA",
    iconColor: "#9333EA",
    textColor: "#6B21A8",
  },
  {
    bg: "#FFF0F3",
    pillBg: "#FFE0E6",
    borderHighlight: "rgba(255, 255, 255, 0.9)",
    shadowColor: "#E11D48",
    iconColor: "#E11D48",
    textColor: "#9F1239",
  },
  {
    bg: "#EEF6FF",
    pillBg: "#DBEBFE",
    borderHighlight: "rgba(255, 255, 255, 0.9)",
    shadowColor: "#2563EB",
    iconColor: "#2563EB",
    textColor: "#1E40AF",
  },
  {
    bg: "#FEF9E7",
    pillBg: "#FEF0C7",
    borderHighlight: "rgba(255, 255, 255, 0.9)",
    shadowColor: "#D97706",
    iconColor: "#D97706",
    textColor: "#92400E",
  },
];

type CategoryItemProps = {
  category: StorefrontCategory | { id: number | string; name: string; icon?: string; availableCount?: number };
  index: number;
  isSelected?: boolean;
  onPress: (id: string) => void;
};

function ClaymorphicCategoryItem({
  category,
  index,
  isSelected = false,
  onPress,
}: CategoryItemProps) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const palette = CLAY_PALETTES[index % CLAY_PALETTES.length];

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: CLAYMORPHIC_SPRING_CONFIG.scale,
      damping: CLAYMORPHIC_SPRING_CONFIG.damping,
      stiffness: CLAYMORPHIC_SPRING_CONFIG.stiffness,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1.0,
      damping: CLAYMORPHIC_SPRING_CONFIG.damping,
      stiffness: CLAYMORPHIC_SPRING_CONFIG.stiffness,
      useNativeDriver: true,
    }).start();
  };

  const handlePress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
      () => undefined,
    );
    onPress(String(category.id));
  };

  const iconName =
    "icon" in category && category.icon
      ? (category.icon as any)
      : (["menu-book", "edit", "school", "card-giftcard", "palette", "print"][
          index % 6
        ] as any);

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        accessibilityLabel={`قسم ${category.name}`}
        accessibilityRole="button"
        activeOpacity={0.92}
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          styles.card,
          {
            backgroundColor: palette.bg,
            shadowColor: palette.shadowColor,
          },
          isSelected && styles.cardSelected,
        ]}
      >
        {/* Embossed highlight overlay */}
        <View
          style={[
            styles.embossedHighlight,
            { borderColor: palette.borderHighlight },
          ]}
        />

        {/* 3D Pillowed Icon Container */}
        <View
          style={[
            styles.iconContainer,
            {
              backgroundColor: palette.pillBg,
              borderColor: palette.borderHighlight,
            },
          ]}
        >
          <MaterialIcons
            color={palette.iconColor}
            name={iconName}
            size={28}
          />
        </View>

        <Text
          numberOfLines={1}
          style={[styles.name, { color: palette.textColor }]}
        >
          {category.name}
        </Text>

        {"availableCount" in category &&
          typeof category.availableCount === "number" && (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>
                {formatLatinNumber(category.availableCount)} مادة
              </Text>
            </View>
          )}

        {isSelected && (
          <View style={styles.activeIndicator}>
            <MaterialIcons
              color={storefrontDesign.primitive.white}
              name="check"
              size={12}
            />
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

type ClaymorphicCategoriesProps = {
  categories: readonly (
    | StorefrontCategory
    | { id: number | string; name: string; icon?: string; availableCount?: number }
  )[];
  selectedCategoryId?: string | null;
  onSelectCategory: (categoryId: string) => void;
  onViewAll?: () => void;
  title?: string;
  overline?: string;
};

export function ClaymorphicCategories({
  categories,
  selectedCategoryId,
  onSelectCategory,
  onViewAll,
  title = "أقسام المتجر والمسواك",
  overline = "تصفح مسواكك حسب القسم",
}: ClaymorphicCategoriesProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.overline}>{overline}</Text>
          <Text style={styles.title}>{title}</Text>
        </View>
        {onViewAll && (
          <TouchableOpacity
            accessibilityLabel="عرض كل الأقسام والمسواك"
            activeOpacity={0.8}
            onPress={onViewAll}
            style={styles.viewAllBtn}
          >
            <Text style={styles.viewAllText}>كل المسواك</Text>
            <MaterialIcons
              color={storefrontDesign.semantic.brand}
              name="arrow-back"
              size={14}
            />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {categories.map((cat, idx) => (
          <ClaymorphicCategoryItem
            category={cat}
            index={idx}
            isSelected={selectedCategoryId === String(cat.id)}
            key={`${cat.id}-${cat.name}`}
            onPress={onSelectCategory}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 14,
    width: "100%",
  },
  header: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerTitleWrap: {
    alignItems: "flex-end",
  },
  overline: {
    color: storefrontDesign.semantic.brand,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10,
    letterSpacing: 0.3,
    textAlign: "right",
  },
  title: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
    marginTop: 1,
    textAlign: "right",
  },
  viewAllBtn: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 4,
  },
  viewAllText: {
    color: storefrontDesign.semantic.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 11.5,
  },
  scrollContent: {
    flexDirection: "row-reverse",
    gap: 12,
    paddingHorizontal: 2,
    paddingVertical: 6,
  },
  card: {
    alignItems: "center",
    borderRadius: 22,
    elevation: 3,
    minHeight: 120,
    overflow: "hidden",
    paddingBottom: 10,
    paddingHorizontal: 8,
    paddingTop: 10,
    position: "relative",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    width: 96,
  },
  cardSelected: {
    borderColor: storefrontDesign.semantic.brand,
    borderWidth: 2,
  },
  embossedHighlight: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1.5,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  iconContainer: {
    alignItems: "center",
    borderRadius: 18,
    borderWidth: 1,
    height: 54,
    justifyContent: "center",
    marginBottom: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    width: 54,
  },
  name: {
    fontFamily: "Cairo_700Bold",
    fontSize: 11.5,
    lineHeight: 16,
    textAlign: "center",
  },
  countBadge: {
    backgroundColor: "rgba(255, 255, 255, 0.75)",
    borderRadius: 6,
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  countText: {
    color: "#475569",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 9,
  },
  activeIndicator: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brand,
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    left: 6,
    position: "absolute",
    top: 6,
    width: 18,
  },
});
