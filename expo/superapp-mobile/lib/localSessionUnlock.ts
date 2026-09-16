import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";

type LocalProtectionErrorCode =
  | "E_LOCAL_PROTECTION_REQUIRED"
  | "E_LOCAL_PROTECTION_CANCELLED"
  | "E_LOCAL_PROTECTION_FAILED";

class LocalProtectionError extends Error {
  readonly code: LocalProtectionErrorCode;

  constructor(code: LocalProtectionErrorCode, message: string) {
    super(message);
    this.name = "LocalProtectionError";
    this.code = code;
  }
}

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
  // Biometric enrollment is not required when Android can authenticate with
  // the secure screen-lock credential. The system prompt is the authority.
  const result = await LocalAuthentication.authenticateAsync({
    biometricsSecurityLevel: "strong",
    cancelLabel: "إلغاء",
    disableDeviceFallback: false,
    fallbackLabel: "استخدام رمز الجهاز",
    promptMessage: "تأكيد هويتك لفتح جلسة العمل",
  }).catch(() => ({ success: false as const, error: "not_available" as const }));

  if (result.success) return;
  if (["not_available", "not_enrolled", "passcode_not_set"].includes(result.error)) {
    throw new LocalProtectionError(
      "E_LOCAL_PROTECTION_REQUIRED",
      "يتطلب هذا الجهاز قفلاً آمناً أو بصمة لحماية جلسة العمل.",
    );
  }
  if (["user_cancel", "system_cancel", "app_cancel"].includes(result.error)) {
    throw new LocalProtectionError(
      "E_LOCAL_PROTECTION_CANCELLED",
      "أُلغي فتح حماية الجهاز.",
    );
  }
  throw new LocalProtectionError(
    "E_LOCAL_PROTECTION_FAILED",
    "لم يتم فتح جلسة العمل. أعد التحقق عندما تكون مستعداً.",
  );
}
