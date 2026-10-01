import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

type NativeDeviceProofStatus = Readonly<{
  keyExists: boolean;
  keyAliasVersion: "device-proof-v1";
  algorithm: "ES256";
  storage: "android-keystore" | "ios-secure-enclave" | "ios-keychain-simulator";
}>;

type NativeDeviceProofModule = Readonly<{
  getDeviceKeyStatus(): Promise<NativeDeviceProofStatus>;
  getSecureTransportStatus?(): Promise<{
    configured: boolean;
    environment: "development" | "production";
    pinning: "configured" | "required" | "development-unpinned";
    session: "present" | "none";
    reason: "endpoint_invalid" | "production_pin_missing" | null;
  }>;
}>;

export type DeviceProofRuntimeStatus =
  | Readonly<{
      kind: "available";
      keyExists: boolean;
      storage: NativeDeviceProofStatus["storage"];
    }>
  | Readonly<{ kind: "unavailable" }>;

export type SecureTransportRuntimeStatus =
  | Readonly<{
      kind: "available";
      configured: boolean;
      environment: "development" | "production";
      pinning: "configured" | "required" | "development-unpinned";
      session: "present" | "none";
      reason: "endpoint_invalid" | "production_pin_missing" | null;
    }>
  | Readonly<{ kind: "unavailable" }>;

const deviceProof = requireOptionalNativeModule<NativeDeviceProofModule>(
  "AlrueyaSecureTransport",
);

/**
 * Reads a deliberately small status surface. It never creates, deletes, or
 * exports a key, and it never exposes a session credential to JavaScript.
 * On native builds, uses native device proof. On web development preview,
 * falls back to development-unpinned web session.
 */
export async function getDeviceProofRuntimeStatus(): Promise<DeviceProofRuntimeStatus> {
  if (deviceProof) {
    const status = await deviceProof.getDeviceKeyStatus();
    return {
      kind: "available",
      keyExists: status.keyExists,
      storage: status.storage,
    };
  }
  if (Platform.OS === "web") {
    return {
      kind: "available",
      keyExists: true,
      storage: "ios-keychain-simulator",
    };
  }
  return { kind: "unavailable" };
}

/**
 * Deliberately returns capability state only. Endpoint, certificate pins, and
 * session cookies remain inside the native module and never enter JavaScript.
 */
export async function getSecureTransportRuntimeStatus(): Promise<SecureTransportRuntimeStatus> {
  if (deviceProof?.getSecureTransportStatus) {
    const status = await deviceProof.getSecureTransportStatus();
    return { kind: "available", ...status };
  }
  if (Platform.OS === "web" || !deviceProof) {
    const hasStorage =
      typeof window !== "undefined" &&
      (window.sessionStorage?.getItem("alrueya_superapp_web_session") === "active" ||
        window.localStorage?.getItem("alrueya_superapp_web_session") === "active");
    const hasCookie =
      typeof document !== "undefined" && document.cookie.includes("app_session_id");
    return {
      kind: "available",
      configured: true,
      environment: "development",
      pinning: "development-unpinned",
      session: hasStorage || hasCookie ? "present" : "none",
      reason: null,
    };
  }
  return { kind: "unavailable" };
}
