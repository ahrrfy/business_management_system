import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useCart } from "@/lib/cart-context";
import { Platform } from "react-native";

export default function TabLayout() {
  const { itemCount } = useCart();
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === "web" ? 8 : Math.max(insets.bottom, 8);
  const tabBarHeight = 58 + bottomPadding;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#0E806A",
        tabBarActiveBackgroundColor: "rgba(14, 128, 106, 0.09)",
        tabBarInactiveTintColor: "#5A6E68",
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          bottom: Platform.OS === "web" ? 14 : Math.max(insets.bottom, 14),
          borderRadius: 28,
          borderWidth: 1,
          borderColor: "rgba(241, 229, 218, 0.95)",
          elevation: 10,
          height: tabBarHeight,
          left: 16,
          paddingBottom: bottomPadding,
          paddingTop: 6,
          position: "absolute",
          right: 16,
          backgroundColor: "rgba(255, 255, 255, 0.98)",
          shadowColor: "#183D36",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.08,
          shadowRadius: 20,
        },
        // Cairo glyphs exceed React Navigation's implicit 10px line box on web,
        // which visually clips Arabic labels even when the tab bar itself fits.
        tabBarLabelStyle: {
          fontFamily: "Cairo_700Bold",
          fontSize: 9.5,
          lineHeight: 16,
          marginTop: 0,
        },
        tabBarIconStyle: { marginTop: 0 },
        tabBarItemStyle: { borderRadius: 20, marginHorizontal: 2, paddingVertical: 2 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "الرئيسية",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="house.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="categories"
        options={{
          title: "التصنيفات",
          tabBarIcon: ({ color }) => (
            <IconSymbol
              size={26}
              name="rectangle.grid.2x2.fill"
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: "السلة",
          tabBarBadge: itemCount > 0 ? itemCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: "#FF4757",
            color: "#FFFFFF",
            fontFamily: "Cairo_800ExtraBold",
            fontSize: 10,
          },
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="cart.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: "طلباتي",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="shippingbox.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "حسابي",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={27} name="person.crop.circle" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
