"use strict";

module.exports = function createHrBridgePm2App(options) {
  const {
    projectRoot,
    script,
    policy,
    deploymentEnvironment,
    releaseId = null,
  } = options;
  if (
    !projectRoot ||
    !script ||
    !policy ||
    !deploymentEnvironment
  ) {
    throw new Error("HR_BRIDGE_PM2_FACTORY_INPUT_INVALID");
  }
  if (releaseId !== null && !/^[a-f0-9]{64}$/.test(releaseId)) {
    throw new Error("HR_BRIDGE_PM2_RELEASE_ID_INVALID");
  }
  const allowed = new Set(policy.allowedEnvironmentKeys);
  const entries = Object.entries(deploymentEnvironment);
  if (
    entries.some(
      ([key, value]) => !allowed.has(key) || typeof value !== "string",
    ) ||
    deploymentEnvironment.NODE_ENV !== "production" ||
    deploymentEnvironment.TZ !== "UTC" ||
    deploymentEnvironment.HR_BRIDGE_LOAD_DOTENV !== "0"
  ) {
    throw new Error("HR_BRIDGE_PM2_ENVIRONMENT_INVALID");
  }
  const environment = Object.fromEntries(entries);
  return {
    name: "erp-hr-bridge",
    script,
    cwd: projectRoot,
    instances: 1,
    exec_mode: "fork",
    watch: false,
    autorestart: true,
    // 78 (EX_CONFIG) محجوز لـ«الجسر معطّل عمداً»؛ SIGKILL/OOM لا يصبح توقفاً مقصوداً.
    stop_exit_codes: [policy.disabledExitCode],
    restart_delay: 0,
    exp_backoff_restart_delay: 3000,
    max_restarts: 10,
    min_uptime: policy.minUptimeMs,
    wait_ready: true,
    // PM2 fail-open عند listen_timeout؛ watchdog والبوابة الخارجية إلزاميان أيضاً.
    listen_timeout: policy.pm2ListenTimeoutMs,
    kill_timeout: policy.pm2KillTimeoutMs,
    // القائمة الفعلية (لا boolean) تحذف بيئة CLI، ثم env يعيد allowlist فقط.
    // PM2 7 applies array entries as substring filters. A single empty string
    // removes every inherited daemon/CLI key; app.env below then rebuilds the
    // complete positive allowlist. Fresh delete+start is mandatory.
    filter_env: [""],
    env: {
      ...environment,
      ...(releaseId ? { HR_BRIDGE_RELEASE_ID: releaseId } : {}),
    },
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/hr-bridge-error.log",
    out_file: "logs/hr-bridge-out.log",
    merge_logs: true,
  };
};
