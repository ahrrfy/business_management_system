import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";

/**
 * Native session material is also protected by the platform keystore. This
 * visible prompt establishes the short system-authentication window before a
 * named native request can decrypt the session; it is not a replacement for
 * server-side two-factor verification.
 */
export async function unlockLocalSession(): Promise<void> {
  // iOS Keychain owns `biometryCurrentSet` and presents its own protected
  // prompt during the native read. A JavaScript prompt first would be duplicate
  // UX without extending the Keychain authorization window.
  if (Platform.OS === "ios") return;
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  if (!hasHardware || !isEnrolled) {
    throw new Error("يتطلب هذا الجهاز قفلاً آمناً وبصمة أو رمز الجهاز لحماية جلسة العمل.");
  }
  const result = await LocalAuthentication.authenticateAsync({
    biometricsSecurityLevel: "strong",
    cancelLabel: "إلغاء",
    disableDeviceFallback: false,
    fallbackLabel: "استخدام رمز الجهاز",
    promptMessage: "تأكيد هويتك لفتح جلسة العمل",
  });
  if (!result.success) {
    throw new Error("لم يتم فتح جلسة العمل. أعد التحقق عندما تكون مستعداً.");
  }
}
