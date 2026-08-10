import { resolveBridgeSecurityConfig } from "./bridgeSecurity";
import { enabledDeviceIdentityRuntimeFailure } from "./registry";

/** يفشل عامل الجسر قبل listen إذا كانت أي هوية مفعّلة غير مكتملة أو مشتركة. */
export async function assertEnabledDeviceIdentityReadiness(): Promise<void> {
  const failure = await enabledDeviceIdentityRuntimeFailure(resolveBridgeSecurityConfig());
  if (failure) throw new Error(`HR_DEVICE_IDENTITY_NOT_READY:${failure}`);
}
