"use strict";

/**
 * سياسة دورة حياة عامل جسر الحضور.
 *
 * هذا الملف CommonJS عمداً كي يكون مصدر الحقيقة نفسه متاحاً لملف PM2 (CJS)،
 * ولـ bootstrap/verifier (ESM)، من دون تحميل TypeScript في الإنتاج.
 */
const policy = Object.freeze({
  startupTimeoutMs: 60_000,
  databaseReadinessTimeoutMs: 20_000,
  tcpListenTimeoutMs: 10_000,
  pm2ListenTimeoutMs: 75_000,
  runtimeGateTimeoutMs: 110_000,
  runtimeStableSamples: 3,
  runtimeSampleIntervalMs: 1_000,
  shutdownTimeoutMs: 10_000,
  minUptimeMs: 90_000,
});

if (
  policy.databaseReadinessTimeoutMs + policy.tcpListenTimeoutMs >=
  policy.startupTimeoutMs
) {
  throw new Error("HR_BRIDGE_POLICY_STARTUP_BUDGET_INVALID");
}
if (policy.startupTimeoutMs >= policy.pm2ListenTimeoutMs) {
  throw new Error("HR_BRIDGE_POLICY_PM2_MUST_OUTLIVE_WATCHDOG");
}
if (policy.pm2ListenTimeoutMs > policy.runtimeGateTimeoutMs) {
  throw new Error("HR_BRIDGE_POLICY_GATE_TOO_SHORT");
}
if (policy.minUptimeMs < policy.startupTimeoutMs) {
  throw new Error("HR_BRIDGE_POLICY_MIN_UPTIME_TOO_SHORT");
}
if (
  policy.runtimeGateTimeoutMs <
  policy.minUptimeMs + policy.runtimeStableSamples * policy.runtimeSampleIntervalMs
) {
  throw new Error("HR_BRIDGE_POLICY_GATE_STABILITY_WINDOW_TOO_SHORT");
}

module.exports = policy;
