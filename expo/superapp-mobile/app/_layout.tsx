import { Cairo_400Regular, Cairo_600SemiBold, Cairo_700Bold, useFonts } from "@expo-google-fonts/cairo";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import "../global.css";
import { colors } from "@/constants/theme";
import { SecureNotificationResponseHandler } from "@/components/SecureNotificationResponseHandler";
import { WorkspaceAccessProvider } from "@/lib/workspaceAccess";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Cairo_400Regular, Cairo_600SemiBold, Cairo_700Bold });

  if (!fontsLoaded) {
    return (
      <View style={{ alignItems: "center", backgroundColor: colors.canvas, flex: 1, justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar backgroundColor={colors.canvas} style="dark" />
      <WorkspaceAccessProvider>
        <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.canvas, flex: 1 }}>
          <SecureNotificationResponseHandler />
          <Stack screenOptions={{ headerShown: false }} />
        </SafeAreaView>
      </WorkspaceAccessProvider>
    </SafeAreaProvider>
  );
}
