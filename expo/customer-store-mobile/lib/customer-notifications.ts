import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { loadVerifiedCustomerSession } from "@/lib/customer-session";
import { registerStorefrontPushDevice } from "@/lib/storefront-api";

const PREFERENCE_KEY = "customer-store:marketing-push-enabled:v1";
const PUSH_TOKEN_KEY = "customer-store:expo-push-token:v1";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
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
  try {
    return (await AsyncStorage.getItem(PREFERENCE_KEY)) === "true";
  } catch {
    return false;
  }
}

async function requestExpoPushToken(): Promise<CustomerPushRegistration> {
  const platform = nativePlatform();
  if (!platform) return { ok: false, message: "إشعارات التطبيق متاحة على الهاتف فقط." };
  try {
    if (platform === "ANDROID") {
      await Notifications.setNotificationChannelAsync("store_updates", {
        name: "عروض وتحديثات مكتبة العربية",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 200, 250],
        lightColor: "#0E806A",
        enableVibrate: true,
        showBadge: true,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    const result = current.status === "granted"
      ? current
      : await Notifications.requestPermissionsAsync({
          ios: {
            allowAlert: true,
            allowBadge: true,
            allowSound: true,
            allowDisplayInCarPlay: false,
            allowCriticalAlerts: false,
            provideAppNotificationSettings: false,
            allowProvisional: false,
          },
        });
    if (result.status !== "granted") {
      return { ok: false, message: "لم تُمنح موافقة الإشعارات. يمكنك تفعيلها لاحقاً من إعدادات الهاتف." };
    }
    const projectId = easProjectId();
    if (!projectId) {
      return { ok: false, message: "لم تكتمل تهيئة إشعارات الإصدار الرسمي بعد." };
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    return token ? { ok: true, token } : { ok: false, message: "تعذر الحصول على رمز جهاز الإشعارات." };
  } catch {
    return { ok: false, message: "تعذر إعداد الإشعارات حالياً. تحقق من الاتصال ثم أعد المحاولة." };
  }
}

/** يرسل إشعاراً محلياً تجريبياً فورياً للتحقق من نغمة الصوت وظهوره في شاشة القفل واللوحة العلوية */
export async function scheduleTestCustomerNotification(): Promise<{ ok: boolean; message: string }> {
  const platform = nativePlatform();
  if (!platform) {
    return { ok: false, message: "إشعارات التطبيق متاحة على أجهزة الهاتف فقط." };
  }
  try {
    if (platform === "ANDROID") {
      await Notifications.setNotificationChannelAsync("store_updates", {
        name: "عروض وتحديثات مكتبة العربية",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 200, 250],
        lightColor: "#0E806A",
        enableVibrate: true,
        showBadge: true,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    const result = current.status === "granted"
      ? current
      : await Notifications.requestPermissionsAsync({
          ios: {
            allowAlert: true,
            allowBadge: true,
            allowSound: true,
          },
        });
    if (result.status !== "granted") {
      return { ok: false, message: "يرجى منح إذن الإشعارات من إعدادات الهاتف أولاً." };
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "المكتبة العربية",
        body: "طلبك قيد التجهيز وسيصلك إشعار فوري عند خروجه مع المندوب!",
        sound: "default",
        badge: 1,
        data: { path: "/(tabs)/orders" },
      },
      trigger: null,
    });
    return { ok: true, message: "تم إرسال إشعار التجربة بنجاح مع نغمة الصوت." };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "تعذر تشغيل الإشعار.";
    return { ok: false, message: msg };
  }
}

export async function enableMarketingPush(): Promise<CustomerPushRegistration> {
  const registration = await requestExpoPushToken();
  if (!registration.ok) return registration;

  const platform = nativePlatform();
  if (!platform) return { ok: false, message: "إشعارات التطبيق متاحة على الهاتف فقط." };

  try {
    const session = await loadVerifiedCustomerSession();
    await registerStorefrontPushDevice({
      expoPushToken: registration.token,
      marketingOptIn: true,
      transactionalOptIn: true,
      platform,
      appVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown",
      customerSessionToken: session?.token,
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
  try {
    const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    const platform = nativePlatform();
    if (token && platform) {
      const session = await loadVerifiedCustomerSession();
      await registerStorefrontPushDevice({
        expoPushToken: token,
        marketingOptIn: false,
        transactionalOptIn: true,
        platform,
        appVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown",
        customerSessionToken: session?.token,
      });
    }
    await AsyncStorage.setItem(PREFERENCE_KEY, "false");
    return { ok: true, token: token ?? "" };
  } catch {
    return { ok: false, message: "تعذر إيقاف الإعلانات في النظام الأساسي حالياً. أعد المحاولة عند توفر الاتصال." };
  }
}

/** يطلب إذن الهاتف بعد إنشاء الطلب ويسجّل مسار الحالة فقط، من دون تفعيل التسويق. */
export async function enableTransactionalPush(customerSessionToken?: string): Promise<CustomerPushRegistration> {
  const registration = await requestExpoPushToken();
  if (!registration.ok) return registration;
  const platform = nativePlatform();
  if (!platform) return { ok: false, message: "إشعارات التطبيق متاحة على الهاتف فقط." };
  try {
    await registerStorefrontPushDevice({
      expoPushToken: registration.token,
      marketingOptIn: await isMarketingPushEnabled(),
      transactionalOptIn: true,
      platform,
      appVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown",
      customerSessionToken: customerSessionToken ?? (await loadVerifiedCustomerSession())?.token,
    });
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, registration.token);
    return registration;
  } catch {
    return { ok: false, message: "تعذر ربط إشعارات حالة الطلب حالياً. يمكنك تفعيلها لاحقاً من الإعدادات." };
  }
}

/** يعيد ربط رمزٍ سبق تسجيله بجلسة العميل بعد تسجيل الدخول أو عند تشغيل التطبيق. */
export async function syncCustomerPushIdentity(customerSessionToken?: string): Promise<boolean> {
  try {
    const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    const platform = nativePlatform();
    if (!token || !platform) return false;
    const sessionToken = customerSessionToken ?? (await loadVerifiedCustomerSession())?.token;
    if (!sessionToken) return false;
    await registerStorefrontPushDevice({
      expoPushToken: token,
      marketingOptIn: await isMarketingPushEnabled(),
      transactionalOptIn: true,
      platform,
      appVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown",
      customerSessionToken: sessionToken,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * يجدول تنبيهاً محلياً صوتياً للسلة المتروكة بعد ساعتين إذا لم يتم إتمام الشراء
 */
export async function scheduleAbandonedCartAlert(
  itemCount: number,
  delaySeconds: number = 7200,
): Promise<{ ok: boolean; message: string }> {
  const platform = nativePlatform();
  if (!platform || itemCount <= 0) {
    return { ok: false, message: "لا تتوفر أصناف بالسلة أو المنصة غير مدعومة." };
  }
  try {
    if (platform === "ANDROID") {
      await Notifications.setNotificationChannelAsync("store_cart_reminders", {
        name: "تذكير السلة غير المكتملة",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 200, 150, 200],
        lightColor: "#0E806A",
        enableVibrate: true,
        showBadge: true,
      });
    }

    const current = await Notifications.getPermissionsAsync();
    if (current.status !== "granted") {
      return { ok: false, message: "إذن الإشعارات غير مفعل." };
    }

    await Notifications.scheduleNotificationAsync({
      identifier: "abandoned-cart-reminder",
      content: {
        title: "هل نسيت سلتك في مكتبة العربية؟ 🛒",
        body: `لديك ${itemCount} أصناف بانتظارك في السلة، أكمل طلبك الآن قبل نفاد الكمية!`,
        sound: "default",
        badge: 1,
        data: { path: "/(tabs)/cart" },
      },
      trigger: {
        seconds: delaySeconds,
      } as Notifications.NotificationTriggerInput,
    });

    return { ok: true, message: "تمت جدولة تذكير السلة بنجاح." };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "تعذر جدولة الإشعار.";
    return { ok: false, message: msg };
  }
}

/**
 * يجدول إشعاراً بعروض وتخفيضات نهاية الأسبوع أو العروض الخاطفة
 */
export async function scheduleFlashSaleAlert(
  title: string,
  body: string,
  delaySeconds: number = 3600,
): Promise<{ ok: boolean; message: string }> {
  const platform = nativePlatform();
  if (!platform) {
    return { ok: false, message: "الإشعارات متاحة على الهاتف فقط." };
  }
  try {
    if (platform === "ANDROID") {
      await Notifications.setNotificationChannelAsync("store_flash_sales", {
        name: "العروض الخاطفة والخصومات",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 200, 250],
        lightColor: "#E11D48",
        enableVibrate: true,
        showBadge: true,
      });
    }

    const current = await Notifications.getPermissionsAsync();
    if (current.status !== "granted") {
      return { ok: false, message: "إذن الإشعارات غير مفعل." };
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: "default",
        badge: 1,
        data: { path: "/(tabs)/categories" },
      },
      trigger: {
        seconds: delaySeconds,
      } as Notifications.NotificationTriggerInput,
    });

    return { ok: true, message: "تمت جدولة إشعار العرض بنجاح." };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "تعذر جدولة الإشعار.";
    return { ok: false, message: msg };
  }
}
