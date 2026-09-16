import { requireOptionalNativeModule } from "expo";

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
 * The optional lookup stays unavailable on web and Expo Go by design.
 */
export async function getDeviceProofRuntimeStatus(): Promise<DeviceProofRuntimeStatus> {
  if (!deviceProof) return { kind: "unavailable" };

  const status = await deviceProof.getDeviceKeyStatus();
  return {
    kind: "available",
    keyExists: status.keyExists,
    storage: status.storage,
  };
}

/**
 * Deliberately returns capability state only. Endpoint, certificate pins, and
 * session cookies remain inside the native module and never enter JavaScript.
 */
export async function getSecureTransportRuntimeStatus(): Promise<SecureTransportRuntimeStatus> {
  if (!deviceProof?.getSecureTransportStatus) return { kind: "unavailable" };
  const status = await deviceProof.getSecureTransportStatus();
  return { kind: "available", ...status };
}
