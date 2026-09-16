// `expo` re-exports the Expo Modules bridge and is already a direct app
// dependency. Keeping this import here avoids a second, hoisting-sensitive
// JavaScript dependency on `expo-modules-core` for a local module.
import { requireNativeModule } from "expo";

/**
 * A public, stable identifier for the local device-proof key. The actual
 * KeyStore/Keychain alias never crosses the native boundary.
 */
export type DeviceKeyDescriptor = Readonly<{
  keyId: string;
  keyThumbprint: string;
  publicKeySpkiBase64Url: string;
  algorithm: "ES256";
  clientId: "superapp-expo";
  clientVersion: "1";
  proofVersion: "1";
}>;

export type DeviceKeyStatus = Readonly<{
  keyExists: boolean;
  keyAliasVersion: "device-proof-v1";
  algorithm: "ES256";
  storage: "android-keystore" | "ios-secure-enclave" | "ios-keychain-simulator";
}>;

/**
 * A DER-encoded ECDSA signature over the server's canonical registration
 * message. `ticket` is deliberately not returned so it cannot be mistaken for
 * a local session credential.
 */
export type DeviceRegistrationProof = DeviceKeyDescriptor &
  Readonly<{
    signatureDerBase64Url: string;
  }>;

export type DeviceKeyDeletion = Readonly<{
  deleted: boolean;
  keyAliasVersion: "device-proof-v1";
}>;

/** A status-only surface. It identifies whether this compiled build is able to
 * make protected requests; it never reveals the endpoint, pins, or a session. */
export type SecureTransportStatus = Readonly<{
  configured: boolean;
  environment: "development" | "production";
  pinning: "configured" | "required" | "development-unpinned";
  session: "present" | "none";
  reason: "endpoint_invalid" | "production_pin_missing" | null;
}>;

type AlrueyaSecureTransportNativeModule = {
  getOrCreateDeviceKey(): Promise<DeviceKeyDescriptor>;
  getDeviceKeyStatus(): Promise<DeviceKeyStatus>;
  createRegistrationProof(ticket: string): Promise<DeviceRegistrationProof>;
  deleteDeviceKey(): Promise<DeviceKeyDeletion>;
  getSecureTransportStatus(): Promise<SecureTransportStatus>;
  createMobileRequestId(): Promise<string>;
  login(
    identifier: string,
    password: string,
    remember: boolean,
    companyCode: string | null,
  ): Promise<string>;
  verifyTwoFactor(
    ticket: string,
    code: string | null,
    recoveryCode: string | null,
  ): Promise<string>;
  getMobileToday(): Promise<string>;
  getMobileAttendanceHistory(): Promise<string>;
  revealMobilePayslip(code: string | null, recoveryCode: string | null): Promise<string>;
  requestMobileLeave(
    leaveType: string,
    fromDate: string,
    toDate: string,
    reason: string | null,
    clientRequestId: string,
  ): Promise<string>;
  withdrawLatestMobileLeave(clientRequestId: string): Promise<string>;
  startFocusedMobileTask(clientRequestId: string): Promise<string>;
  resolveFocusedMobileTask(resolutionNote: string | null, clientRequestId: string): Promise<string>;
  getMobileCommandCenter(): Promise<string>;
  logout(): Promise<Readonly<{ cleared: true }>>;
};

/**
 * This module intentionally has no token getter, setter, generic sign method,
 * or generic HTTP method. The native implementation owns the device-bound
 * cookie, counter, nonce, and signature; JavaScript can call only named,
 * reviewed procedures.
 */
export default requireNativeModule<AlrueyaSecureTransportNativeModule>(
  "AlrueyaSecureTransport",
);
