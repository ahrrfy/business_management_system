import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { registerStorefrontPushDevice } from "@/lib/storefront-api";

const PREFERENCE_KEY = "customer-store:marketing-push-enabled:v1";
const PUSH_TOKEN_KEY = "customer-store:expo-push-token:v1";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export type CustomerPushRegistration =
  | { ok: true; token: string }
  | { ok: false; message: string };

function easProjectId(): string | null {
  const expoExtra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const easConfig = Constants.easConfig as { projectId?: unknown } | null;
  const value = easConfig?.projectId ?? expoExtra?.eas?.projectId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nativePlatform(): "IOS" | "ANDROID" | null {
  if (Platform.OS === "ios") return "IOS";
  if (Platform.OS === "android") return "ANDROID";
  return null;
}

export async function isMarketingPushEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(PREFERENCE_KEY)) === "true";
}

async function requestExpoPushToken(): Promise<CustomerPushRegistration> {
  const platform = nativePlatform();
  if (!platform) return { ok: false, message: "إشعارات التطبيق متاحة على الهاتف فقط." };

  if (platform === "ANDROID") {
    await Notifications.setNotificationChannelAsync("store_updates", {
      name: "عروض وتحديثات مكتبة العربية",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180, 120, 180],
      lightColor: "#075B4E",
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const result = current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
  if (result.status !== "granted") {
    return { ok: false, message: "لم تُمنح موافقة الإشعارات. يمكنك تفعيلها لاحقاً من إعدادات الهاتف." };
  }

  const projectId = easProjectId();
  if (!projectId) {
    return { ok: false, message: "لم تكتمل تهيئة إشعارات الإصدار الرسمي بعد." };
  }

  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    return token ? { ok: true, token } : { ok: false, message: "تعذر الحصول على رمز جهاز الإشعارات." };
  } catch {
    return { ok: false, message: "تعذر إعداد الإشعارات حالياً. تحقق من الاتصال ثم أعد المحاولة." };
  }
}

export async function enableMarketingPush(): Promise<CustomerPushRegistration> {
  const registration = await requestExpoPushToken();
  if (!registration.ok) return registration;

  const platform = nativePlatform();
  if (!platform) return { ok: false, message: "إشعارات التطبيق متاحة على الهاتف فقط." };

  try {
    await registerStorefrontPushDevice({
      expoPushToken: registration.token,
      marketingOptIn: true,
      transactionalOptIn: true,
      platform,
      appVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown",
    });
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, registration.token);
    await AsyncStorage.setItem(PREFERENCE_KEY, "true");
    return registration;
  } catch {
    return { ok: false, message: "تعذر حفظ تفضيلك في النظام الأساسي. لم نفعّل الإعلانات بعد." };
  }
}

/** لا يلغي رسائل حالة الطلب، وإنما يلغي عروضاً وحملات تسويقية اختيارية فقط على الخادم والجهاز. */
export async function disableMarketingPush(): Promise<CustomerPushRegistration> {
  const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
  const platform = nativePlatform();
  if (token && platform) {
    try {
      await registerStorefrontPushDevice({
        expoPushToken: token,
        marketingOptIn: false,
        transactionalOptIn: true,
        platform,
        appVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown",
      });
    } catch {
      return { ok: false, message: "تعذر إيقاف الإعلانات في النظام الأساسي حالياً. أعد المحاولة عند توفر الاتصال." };
    }
  }
  await AsyncStorage.setItem(PREFERENCE_KEY, "false");
  return { ok: true, token: token ?? "" };
}
