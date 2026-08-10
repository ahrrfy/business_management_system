import { resolveBridgeSecurityConfig } from "./bridgeSecurity";
import { enabledDeviceIdentityRuntimeFailure } from "./registry";

/** يفشل العامل قبل listen إذا كانت أي هوية جهاز مفعّلة ناقصة أو مشتركة. */
export async function assertEnabledDeviceIdentityReadiness(): Promise<void> {
  const failure = await enabledDeviceIdentityRuntimeFailure(
    resolveBridgeSecurityConfig(),
  );
  if (failure) throw new Error(`HR_DEVICE_IDENTITY_NOT_READY:${failure}`);
}
