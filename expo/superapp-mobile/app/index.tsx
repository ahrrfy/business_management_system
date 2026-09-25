import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";
import { colors, space } from "@/constants/theme";

export default function Index() {
  const access = useWorkspaceAccess();

  useEffect(() => {
    if (access.mode === "checking") return;

    if (access.mode === "signedOut" || access.mode === "error") {
      router.replace("/sign-in");
      return;
    }

    if (access.mode === "ready") {
      if (access.today?.navigation.ownerCenter) {
        router.replace("/(tabs)");
      } else if (access.today?.navigation.personal) {
        router.replace("/(tabs)/my-day");
      } else if (access.today?.navigation.work) {
        router.replace("/(tabs)/work");
      } else {
        router.replace("/(tabs)/account");
      }
    }
  }, [access.mode, access.today]);

  return (
    <View accessibilityLabel="شاشة بدء سوبر العربية" style={styles.container}>
      <View style={styles.brandBadge}>
        <Text style={styles.brandTitle}>سوبر العربية</Text>
        <Text style={styles.brandSubtitle}>منظومة إدارة أعمال الرؤية العربية</Text>
      </View>
      <ActivityIndicator color={colors.brand} size="large" style={styles.loader} />
      <Text style={styles.status}>جارٍ التحقق من حماية الجلسة والاتصال...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: colors.canvas,
    flex: 1,
    justifyContent: "center",
    padding: space.xl,
  },
  brandBadge: {
    alignItems: "center",
    marginBottom: space.xxl,
  },
  brandTitle: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 28,
    marginBottom: space.xs,
  },
  brandSubtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 14,
  },
  loader: {
    marginVertical: space.lg,
  },
  status: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 14,
  },
});
