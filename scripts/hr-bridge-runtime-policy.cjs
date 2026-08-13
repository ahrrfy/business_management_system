"use strict";

/**
 * سياسة دورة حياة عامل جسر الحضور.
 *
 * هذا الملف CommonJS عمداً كي يكون مصدر الحقيقة نفسه متاحاً لملف PM2 (CJS)،
 * ولـ bootstrap/verifier (ESM)، من دون تحميل TypeScript في الإنتاج.
 */
const allowedEnvironmentKeys = Object.freeze([
  "NODE_ENV",
  "TZ",
  "HR_BRIDGE_LOAD_DOTENV",
  "LOG_LEVEL",
  "DB_POOL_LIMIT",
  "DATABASE_URL",
  "CONTROL_DATABASE_URL",
  "HR_DEVICE_BRIDGE",
  "HR_DEVICE_PORT",
  "HR_DEVICE_HOST",
  "HR_DEVICE_IP_ALLOWLIST",
  "HR_DEVICE_SHARED_SECRET",
  "HR_DEVICE_IDENTITY_BINDINGS",
  "HR_DEVICE_LEGACY_IDENTITY_MIGRATION",
  "HR_DEVICE_MAX_PAYLOAD_BYTES",
  "HR_DEVICE_REQUEST_TIMEOUT_MS",
  "HR_DEVICE_IDLE_TIMEOUT_MS",
  "HR_DEVICE_RATE_LIMIT_PER_MINUTE",
  // بلا هذا المفتاح تُنقّى قيمة المشغّل قبل إقلاع العامل المعزول فيعود الإعداد للافتراضي
  // صامتاً — أي «ضبطٌ مُعلَنٌ لا يعمل». أيّ HR_DEVICE_* جديد يجب أن يُدرَج هنا أيضاً.
  "HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE",
  "HR_DEVICE_MAX_WS_PER_IP",
  // اعتماد العنوان التلقائيّ (تعلّم عنوان المتجر بعد تدوير IP المزوّد). بلا إدراجها هنا تُنقّى
  // صامتاً فيعود الجسر للافتراضي (شاهدان) — «ضبطٌ مُعلَنٌ لا يعمل». MIN_WITNESSES=1 قرارُ مالكٍ
  // صريحٌ: تعافٍ أسرع بجلسةِ موظّفٍ واحدة (مقابل خطرٍ أعلى موثَّق في originTrust.ts:42-52).
  "HR_DEVICE_ORIGIN_AUTOTRUST",
  "HR_DEVICE_ORIGIN_MIN_WITNESSES",
  "HR_DEVICE_ORIGIN_TRUST_WINDOW_HOURS",
  "ATTENDANCE_PUSH_INCLUDE_WORKPLACE",
  "NATIVE_PUSH_ENVIRONMENT",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
]);
// PM2 may add these bookkeeping keys to pm2_env.env after applying app.env.
// They carry no application configuration; every other nested key is rejected.
const pm2EnvironmentMetadataKeys = Object.freeze([
  "PM2_HOME",
  "unique_id",
  "PM2_JSON_PROCESSING",
  "HR_BRIDGE_RELEASE_ID",
  "erp-hr-bridge",
  "PWD",
]);

const policy = Object.freeze({
  pm2Version: "7.0.3",
  startupTimeoutMs: 60_000,
  databaseReadinessTimeoutMs: 20_000,
  tcpListenTimeoutMs: 10_000,
  pm2ListenTimeoutMs: 75_000,
  runtimeGateTimeoutMs: 110_000,
  runtimeStableSamples: 3,
  runtimeSampleIntervalMs: 1_000,
  shutdownTimeoutMs: 30_000,
  pm2KillTimeoutMs: 35_000,
  minUptimeMs: 90_000,
  disabledExitCode: 78,
  allowedEnvironmentKeys,
  pm2EnvironmentMetadataKeys,
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
if (policy.pm2KillTimeoutMs <= policy.shutdownTimeoutMs) {
  throw new Error("HR_BRIDGE_POLICY_KILL_TIMEOUT_TOO_SHORT");
}
if (
  policy.runtimeGateTimeoutMs <
  policy.minUptimeMs +
    policy.runtimeStableSamples * policy.runtimeSampleIntervalMs
) {
  throw new Error("HR_BRIDGE_POLICY_GATE_STABILITY_WINDOW_TOO_SHORT");
}

module.exports = policy;
