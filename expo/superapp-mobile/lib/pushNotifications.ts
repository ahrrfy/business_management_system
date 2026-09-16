import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  registerNativeMobileExpoPush,
  revokeNativeMobileExpoPush,
} from "@/lib/secureTransport";
import { routeForSuperAppNotification } from "@/lib/secureNavigation";

type PushEnvironment = "dev" | "staging" | "prod";

function environment(): PushEnvironment {
  return Constants.expoConfig?.extra?.buildVariant === "production" ? "prod" : "dev";
}

function projectId(): string {
  const value = Constants.expoConfig?.extra?.expoProjectId;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("هذا البناء لا يحمل مشروع إشعارات Expo المراجع بعد.");
  }
  return value;
}

function appVersion(): string {
  const value = Constants.expoConfig?.version;
  if (!value || value.length > 64) throw new Error("تعذر قراءة إصدار التطبيق لتأمين الإشعارات.");
  return value;
}

function platform(): "ANDROID" | "IOS" {
  if (Platform.OS === "android") return "ANDROID";
  if (Platform.OS === "ios") return "IOS";
  throw new Error("إشعارات العمل تعمل من تطبيق الهاتف المثبت فقط.");
}

export async function enableSecureSuperAppNotifications(): Promise<void> {
  const permissions = await Notifications.getPermissionsAsync();
  const granted = permissions.granted
    ? permissions
    : await Notifications.requestPermissionsAsync();
  if (!granted.granted) {
    throw new Error("لم تمنح إذن الإشعارات. يمكنك تفعيله لاحقاً من إعدادات الهاتف.");
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("super_arabia_updates", {
      name: "تحديثات سوبر العربية",
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      sound: "default",
    });
  }
  const expoPushToken = (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data;
  await registerNativeMobileExpoPush({
    expoPushToken,
    platform: platform(),
    environment: environment(),
    appVersion: appVersion(),
  });
}

/** Disables server delivery for this protected device; OS permission stays under the user. */
export async function disableSecureSuperAppNotifications(): Promise<void> {
  await revokeNativeMobileExpoPush();
}

export function observeSecureSuperAppNotificationResponses(
  navigate: (href: ReturnType<typeof routeForSuperAppNotification>) => void,
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const route = routeForSuperAppNotification(response.notification.request.content.data);
    if (route) navigate(route);
  });
  return () => subscription.remove();
}
