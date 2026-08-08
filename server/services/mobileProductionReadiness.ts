import { readFcmCredentials } from "./nativePushService";

export type MobileReadinessIssue =
  | "FCM_CONFIGURATION_INVALID"
  | "TWO_FACTOR_ENCRYPTION_KEY_INVALID"
  | "TWO_FACTOR_ENFORCEMENT_DISABLED"
  | "NATIVE_PUSH_ENVIRONMENT_INVALID"
  | "ATTENDANCE_DEVICE_BRIDGE_DISABLED";

export interface MobileProductionReadiness {
  required: boolean;
  ready: boolean;
  issues: MobileReadinessIssue[];
}

function validEncryptionKey(raw: string | undefined): boolean {
  if (!raw) return false;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    return false;
  }
  return Buffer.from(raw, "base64").length === 32;
}

/**
 * بوابة إقلاع خالصة من الأسرار: لا تُرجع إلا رموز نقص ثابتة. يصبح الفشل الصارم فعّالاً
 * عند SUPER_APP_NATIVE_REQUIRED=1 في الإنتاج؛ وبذلك لا يدّعي النشر دعم push/2FA/جهاز
 * الحضور بينما إحدى حلقاته غير مهيأة.
 */
export function checkMobileProductionReadiness(
  env: NodeJS.ProcessEnv = process.env,
): MobileProductionReadiness {
  const required =
    env.NODE_ENV === "production" && env.SUPER_APP_NATIVE_REQUIRED === "1";
  if (!required) return { required: false, ready: true, issues: [] };

  const issues: MobileReadinessIssue[] = [];
  try {
    readFcmCredentials(
      env.FCM_SERVICE_ACCOUNT_JSON,
      env.FCM_PROJECT_ID?.trim(),
    );
  } catch {
    issues.push("FCM_CONFIGURATION_INVALID");
  }
  if (!validEncryptionKey(env.INTEGRATIONS_ENCRYPTION_KEY)) {
    issues.push("TWO_FACTOR_ENCRYPTION_KEY_INVALID");
  }
  if (env.TWO_FACTOR_ENFORCEMENT?.toLowerCase() !== "on") {
    issues.push("TWO_FACTOR_ENFORCEMENT_DISABLED");
  }
  if ((env.NATIVE_PUSH_ENVIRONMENT ?? "prod") !== "prod") {
    issues.push("NATIVE_PUSH_ENVIRONMENT_INVALID");
  }
  const devicePort = Number(env.HR_DEVICE_PORT ?? "0");
  const deviceBridgeEnabled =
    !env.CONTROL_DATABASE_URL &&
    (env.HR_DEVICE_BRIDGE === "1" ||
      (Number.isInteger(devicePort) && devicePort > 0));
  if (!deviceBridgeEnabled) {
    issues.push("ATTENDANCE_DEVICE_BRIDGE_DISABLED");
  }
  return { required, ready: issues.length === 0, issues };
}

export function assertMobileProductionReadiness(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = checkMobileProductionReadiness(env);
  if (!result.ready) {
    throw new Error(`MOBILE_PRODUCTION_NOT_READY:${result.issues.join(",")}`);
  }
}
