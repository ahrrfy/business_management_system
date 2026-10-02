import { router, Tabs, useSegments } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppTabsIcon } from "@/components/AppTabsIcon";
import { colors } from "@/constants/theme";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const access = useWorkspaceAccess();
  const ownerCenter = access.mode === "ready" && access.today?.navigation.ownerCenter === true;
  const personal = access.mode === "ready" && access.today?.navigation.personal === true;
  const work = access.mode === "ready" && (access.today?.navigation.work === true || ownerCenter);

  useEffect(() => {
    if (access.mode === "signedOut" || access.mode === "error") {
      router.replace("/sign-in");
      return;
    }
    const current = segments.at(-1);
    if (current === "(tabs)" && !ownerCenter) {
      router.replace(personal ? "/(tabs)/my-day" : work ? "/(tabs)/work" : "/(tabs)/account");
    } else if (current === "my-day" && !personal) {
      router.replace(ownerCenter ? "/(tabs)" : work ? "/(tabs)/work" : "/(tabs)/account");
    } else if (current === "work" && !work) {
      router.replace(personal ? "/(tabs)/my-day" : ownerCenter ? "/(tabs)" : "/(tabs)/account");
    }
  }, [access.mode, ownerCenter, personal, segments, work]);

  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.mutedInk,
        tabBarHideOnKeyboard: true,
        tabBarItemStyle: { alignItems: "center", justifyContent: "center", paddingVertical: 1 },
        tabBarLabelStyle: { fontFamily: "Cairo_600SemiBold", fontSize: 10, lineHeight: 14 },
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.outline,
          direction: "rtl",
          height: Platform.OS === "web" ? 68 : 64 + insets.bottom,
          paddingBottom: Platform.OS === "web" ? 6 : Math.max(insets.bottom, 6),
          paddingTop: 6,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          href: ownerCenter ? undefined : null,
          title: "الرئيسية",
          tabBarIcon: ({ focused }) => <AppTabsIcon focused={focused} name="home-outline" />,
        }}
      />
      <Tabs.Screen
        name="my-day"
        options={{
          href: personal ? undefined : null,
          title: "يومي",
          tabBarIcon: ({ focused }) => <AppTabsIcon focused={focused} name="calendar-outline" />,
        }}
      />
      <Tabs.Screen
        name="work"
        options={{
          href: work ? undefined : null,
          title: "العمليات",
          tabBarIcon: ({ focused }) => <AppTabsIcon focused={focused} name="grid-outline" />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "حسابي",
          tabBarIcon: ({ focused }) => <AppTabsIcon focused={focused} name="person-outline" />,
        }}
      />
    </Tabs>
  );
}
