"use strict";

const HR_DEVICE_DEFAULT_PORT = 7788;

/**
 * Pure release-mode derivation. The immutable release controller and runtime
 * bootstrap both use this function, then the bootstrap also verifies that the
 * bundled application reports the same mode before accepting its result.
 */
function deriveHrBridgeMode(environment) {
  if (
    environment == null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_CONFIG_INVALID");
  }
  const rawPort = String(environment.HR_DEVICE_PORT ?? "").trim();
  const explicitPort = Number(rawPort || "0");
  const portWasSpecified = rawPort.length > 0;
  const hasValidExplicitPort =
    Number.isInteger(explicitPort) &&
    explicitPort > 0 &&
    explicitPort <= 65_535;
  if (portWasSpecified && !hasValidExplicitPort) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_CONFIG_INVALID");
  }
  const enabled =
    (environment.HR_DEVICE_BRIDGE === "1" || hasValidExplicitPort) &&
    !environment.CONTROL_DATABASE_URL;
  return Object.freeze({
    mode: enabled ? "enabled" : "disabled",
    port: hasValidExplicitPort ? explicitPort : HR_DEVICE_DEFAULT_PORT,
  });
}

module.exports = Object.freeze({
  HR_DEVICE_DEFAULT_PORT,
  deriveHrBridgeMode,
});
