import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useCart } from "@/lib/cart-context";
import { Platform } from "react-native";
import { storefrontDesign } from "@/lib/storefront-design";

export default function TabLayout() {
  const { itemCount } = useCart();
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === "web" ? 8 : Math.max(insets.bottom, 8);
  const tabBarHeight = 58 + bottomPadding;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: storefrontDesign.semantic.brandStrong,
        tabBarActiveBackgroundColor: storefrontDesign.semantic.safeSurface,
        tabBarInactiveTintColor: "#A0A9B5",
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          bottom: Platform.OS === "web" ? 12 : Math.max(insets.bottom, 12),
          borderRadius: 27,
          borderTopWidth: 0,
          elevation: 14,
          height: tabBarHeight,
          left: 16,
          paddingBottom: bottomPadding,
          paddingTop: 7,
          position: "absolute",
          right: 16,
          backgroundColor: storefrontDesign.primitive.white,
          shadowColor: "#6C7A8E",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.16,
          shadowRadius: 18,
        },
        // Cairo glyphs exceed React Navigation's implicit 10px line box on web,
        // which visually clips Arabic labels even when the tab bar itself fits.
        tabBarLabelStyle: {
          fontFamily: "Cairo_600SemiBold",
          fontSize: 9,
          lineHeight: 16,
          marginTop: 0,
        },
        tabBarIconStyle: { marginTop: 0 },
        tabBarItemStyle: { borderRadius: 17, marginHorizontal: 1 },
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
            backgroundColor: "#F05D53",
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
