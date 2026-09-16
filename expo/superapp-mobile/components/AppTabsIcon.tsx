import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet } from "react-native";

import { useReducedMotion } from "@/components/AnimatedReveal";
import { colors } from "@/constants/theme";

type IconName = "home-outline" | "calendar-outline" | "checkmark-circle-outline" | "person-outline";

export function AppTabsIcon({ name, focused }: { name: IconName; focused: boolean }) {
  const reducedMotion = useReducedMotion();
  const active = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      active.setValue(focused ? 1 : 0);
      return;
    }
    Animated.spring(active, {
      damping: 17,
      mass: 0.65,
      stiffness: 230,
      toValue: focused ? 1 : 0,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [active, focused, reducedMotion]);

  return (
    <Animated.View
      style={[
        styles.iconWrap,
        focused && styles.iconWrapFocused,
        { transform: [{ scale: active.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }] },
      ]}
    >
      <Ionicons color={focused ? colors.brand : colors.mutedInk} name={name} size={21} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  iconWrap: { alignItems: "center", height: 30, justifyContent: "center", width: 48 },
  iconWrapFocused: { backgroundColor: colors.brandSoft, borderRadius: 16 },
});
