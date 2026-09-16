import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { colors, radius, space } from "@/constants/theme";

export function PreviewBanner({ tone = "light" }: { tone?: "light" | "dark" }) {
  const dark = tone === "dark";
  return (
    <View
      accessibilityLabel="وضع المعاينة الآمنة؛ لا اتصال بالخادم ولا تنفيذ للمعاملات"
      accessibilityRole="summary"
      style={[styles.container, dark && styles.containerDark]}
    >
      <Ionicons color={dark ? "#DCE4FF" : colors.info} name="shield-checkmark-outline" size={15} />
      <Text numberOfLines={1} style={[styles.body, dark && styles.bodyDark]}>
        معاينة آمنة · لا اتصال بالخادم ولا تنفيذ للمعاملات
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: colors.infoSoft,
    borderRadius: radius.pill,
    flexDirection: "row-reverse",
    gap: space.xs,
    minHeight: 34,
    paddingHorizontal: space.sm,
  },
  containerDark: { backgroundColor: "#07175BAA", borderColor: "#FFFFFF33", borderWidth: StyleSheet.hairlineWidth },
  body: {
    color: colors.info,
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    lineHeight: 19,
    textAlign: "right",
  },
  bodyDark: { color: "#DCE4FF" },
});
