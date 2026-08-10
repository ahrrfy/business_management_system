#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import policy from "./hr-bridge-runtime-policy.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, "dist", "hr-bridge-worker.js");
const bootstrap = path.join(root, "scripts", "hr-bridge-worker.mjs");

if (!fs.existsSync(artifact) || fs.statSync(artifact).size < 1_024) {
  throw new Error("HR_BRIDGE_ARTIFACT_MISSING_OR_EMPTY");
}

const builtSource = fs.readFileSync(artifact, "utf8");
if (builtSource.includes("tsx/esm/api") || builtSource.includes("tsImport(")) {
  throw new Error("HR_BRIDGE_ARTIFACT_USES_RUNTIME_TYPESCRIPT");
}
if (/(?:from\s*|import\s*\()["'][^"']+\.ts["']/.test(builtSource)) {
  throw new Error("HR_BRIDGE_ARTIFACT_IMPORTS_TYPESCRIPT_SOURCE");
}

const bootstrapSource = fs.readFileSync(bootstrap, "utf8");
if (
  bootstrapSource.includes("tsx/esm/api") ||
  bootstrapSource.includes("tsImport(")
) {
  throw new Error("HR_BRIDGE_BOOTSTRAP_USES_RUNTIME_TYPESCRIPT");
}
if (!bootstrapSource.includes("../dist/hr-bridge-worker.js")) {
  throw new Error("HR_BRIDGE_BOOTSTRAP_ARTIFACT_PATH_INVALID");
}

const require = createRequire(import.meta.url);
const ecosystem = require(path.join(root, "ecosystem.config.cjs"));
const matchingApps =
  ecosystem.apps?.filter((candidate) => candidate.name === "erp-hr-bridge") ??
  [];
const app = matchingApps[0];
if (
  matchingApps.length !== 1 ||
  app?.script !== "scripts/hr-bridge-worker.mjs" ||
  app.instances !== 1 ||
  app.exec_mode !== "fork" ||
  app.autorestart !== true ||
  JSON.stringify(app.stop_exit_codes) !== "[0]" ||
  app.wait_ready !== true ||
  app.listen_timeout !== policy.pm2ListenTimeoutMs ||
  policy.startupTimeoutMs >= app.listen_timeout ||
  app.min_uptime !== policy.minUptimeMs ||
  app.kill_timeout <= policy.shutdownTimeoutMs ||
  app.max_restarts < 1 ||
  app.exp_backoff_restart_delay < 1
) {
  throw new Error("HR_BRIDGE_PM2_READINESS_POLICY_INVALID");
}

const env = {
  ...process.env,
  NODE_ENV: "test",
  TZ: "UTC",
  DATABASE_URL: "",
  CONTROL_DATABASE_URL: "",
  HR_DEVICE_BRIDGE: "0",
  HR_DEVICE_PORT: "",
};

const startedAt = Date.now();
const disabledResult = spawnSync(process.execPath, [bootstrap], {
  cwd: root,
  env,
  encoding: "utf8",
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
});

if (
  disabledResult.error ||
  disabledResult.status !== 0 ||
  disabledResult.signal
) {
  throw new Error(
    `HR_BRIDGE_ARTIFACT_SMOKE_FAILED status=${disabledResult.status ?? "none"} ` +
      `signal=${disabledResult.signal ?? "none"}`,
  );
}

// المسار المفعّل بلا DB يجب أن يُكمل تحميل الحزمة ثم يفشل fail-closed، لا أن يعلق.
const failingPreflight = spawnSync(
  process.execPath,
  [bootstrap, "--preflight"],
  {
    cwd: root,
    env: { ...env, HR_DEVICE_BRIDGE: "1", HR_DEVICE_PORT: "7788" },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  },
);
if (
  failingPreflight.error ||
  failingPreflight.signal ||
  failingPreflight.status !== 1 ||
  !failingPreflight.stdout.includes("HR_BRIDGE_MODULES_LOADED") ||
  !failingPreflight.stdout.includes("HR_BRIDGE_STARTUP_FAILED")
) {
  throw new Error(
    `HR_BRIDGE_PREFLIGHT_FAIL_CLOSED_SMOKE_FAILED status=${failingPreflight.status ?? "none"} ` +
      `signal=${failingPreflight.signal ?? "none"}`,
  );
}

console.log(
  `hr bridge artifact gate: disabled + fail-closed preflight smokes passed ` +
    `(${Date.now() - startedAt}ms)`,
);
