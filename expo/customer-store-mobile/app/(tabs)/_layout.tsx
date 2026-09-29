import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HapticTab } from "@/components/haptic-tab";
import { useCart } from "@/lib/cart-context";

export default function TabLayout() {
  const { itemCount } = useCart();
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === "web" ? 8 : Math.max(insets.bottom, 8);
  const tabBarHeight = 60 + bottomPadding;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#10B981",
        tabBarActiveBackgroundColor: "rgba(16, 185, 129, 0.15)",
        tabBarInactiveTintColor: "#94A3B8",
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          backgroundColor: "rgba(15, 23, 42, 0.95)",
          borderColor: "rgba(16, 185, 129, 0.22)",
          borderWidth: 1.5,
          borderRadius: 28,
          bottom: Platform.OS === "web" ? 14 : Math.max(insets.bottom, 12),
          elevation: 14,
          height: tabBarHeight,
          left: 14,
          paddingBottom: bottomPadding,
          paddingTop: 6,
          position: "absolute",
          right: 14,
          shadowColor: "#059669",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.22,
          shadowRadius: 18,
        },
        // Cairo glyphs exceed React Navigation's implicit 10px line box on web,
        // which visually clips Arabic labels even when the tab bar itself fits.
        tabBarLabelStyle: {
          fontFamily: "Cairo_700Bold",
          fontSize: 9.5,
          lineHeight: 16,
          marginTop: 1,
        },
        tabBarIconStyle: { marginTop: 0 },
        tabBarItemStyle: {
          borderRadius: 20,
          marginHorizontal: 2,
          paddingVertical: 3,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "الرئيسية",
          tabBarIcon: ({ color }) => (
            <MaterialIcons color={color} name="home" size={24} />
          ),
        }}
      />
      <Tabs.Screen
        name="deals"
        options={{
          title: "العروض",
          tabBarIcon: ({ color }) => (
            <MaterialIcons color={color} name="local-fire-department" size={24} />
          ),
        }}
      />
      <Tabs.Screen
        name="perks"
        options={{
          title: "مكافآتي",
          tabBarIcon: ({ color }) => (
            <MaterialIcons color={color} name="stars" size={24} />
          ),
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: "السلة",
          tabBarBadge: itemCount > 0 ? itemCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: "#EF4444",
            color: "#FFFFFF",
            fontFamily: "Cairo_800ExtraBold",
            fontSize: 10,
            lineHeight: 14,
            minWidth: 18,
            height: 18,
          },
          tabBarIcon: ({ color }) => (
            <MaterialIcons color={color} name="shopping-cart" size={24} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "حسابي",
          tabBarIcon: ({ color }) => (
            <MaterialIcons color={color} name="person" size={24} />
          ),
        }}
      />
      {/* Existing routes kept active and accessible but hidden from bottom capsule */}
      <Tabs.Screen
        name="categories"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}
