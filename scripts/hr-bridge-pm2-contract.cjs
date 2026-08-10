"use strict";

const path = require("node:path");

const BRIDGE_PROCESS_NAME = "erp-hr-bridge";
const RELEASE_ID = /^[a-f0-9]{64}$/;
const CONTROL_KEYS = Object.freeze([
  "NODE_ENV",
  "TZ",
  "HR_BRIDGE_LOAD_DOTENV",
]);
const EXPECTED_CONTROL_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  TZ: "UTC",
  HR_BRIDGE_LOAD_DOTENV: "0",
});

const OK = Object.freeze({ ok: true, code: null });
const failure = (code) => Object.freeze({ ok: false, code });

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizedBoolean(value) {
  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }
  if (
    value === false ||
    value === "false" ||
    value === 0 ||
    value === "0"
  ) {
    return false;
  }
  return null;
}

function normalizedExecMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/_mode$/, "");
  return normalized || null;
}

function samePath(actual, expected) {
  return (
    typeof actual === "string" &&
    actual.length > 0 &&
    path.resolve(actual) === path.resolve(expected)
  );
}

function normalizeExpectation(options) {
  if (!isPlainObject(options)) return null;
  const mode = options.mode ?? options.release?.mode;
  const processName = options.processName ?? BRIDGE_PROCESS_NAME;
  const releaseId = options.release?.id ?? options.releaseId;
  const executable =
    options.release?.bootstrapPath ??
    options.release?.executable ??
    options.executable;
  const projectRoot = options.projectRoot;
  const policy = options.policy;
  const controlEnvironment =
    options.controlEnvironment ?? EXPECTED_CONTROL_ENVIRONMENT;

  if (
    !["enabled", "disabled"].includes(mode) ||
    typeof processName !== "string" ||
    processName.length === 0 ||
    !isPlainObject(policy) ||
    !Array.isArray(policy.allowedEnvironmentKeys) ||
    !Array.isArray(policy.pm2EnvironmentMetadataKeys) ||
    !isPlainObject(controlEnvironment) ||
    typeof projectRoot !== "string" ||
    projectRoot.length === 0
  ) {
    return null;
  }

  const controlKeys = Object.keys(controlEnvironment).sort();
  if (
    JSON.stringify(controlKeys) !== JSON.stringify([...CONTROL_KEYS].sort()) ||
    CONTROL_KEYS.some(
      (key) =>
        typeof controlEnvironment[key] !== "string" ||
        controlEnvironment[key] !== EXPECTED_CONTROL_ENVIRONMENT[key],
    ) ||
    CONTROL_KEYS.some((key) => !policy.allowedEnvironmentKeys.includes(key))
  ) {
    return null;
  }

  if (
    mode === "enabled" &&
    (typeof executable !== "string" ||
      executable.length === 0 ||
      typeof releaseId !== "string" ||
      !RELEASE_ID.test(releaseId))
  ) {
    return null;
  }

  const lifecycle = Object.freeze({
    instances: 1,
    execMode: "fork",
    autorestart: true,
    waitReady: true,
    listenTimeout: normalizedInteger(policy.pm2ListenTimeoutMs),
    killTimeout: normalizedInteger(policy.pm2KillTimeoutMs),
    minUptime: normalizedInteger(policy.minUptimeMs),
    maxRestarts: 10,
    restartDelay: 0,
    backoffRestartDelay: 3000,
    stopExitCodes: [normalizedInteger(policy.disabledExitCode)],
  });
  if (
    lifecycle.listenTimeout == null ||
    lifecycle.listenTimeout < 0 ||
    lifecycle.killTimeout == null ||
    lifecycle.killTimeout < 0 ||
    lifecycle.minUptime == null ||
    lifecycle.minUptime < 0 ||
    lifecycle.stopExitCodes[0] == null
  ) {
    return null;
  }

  return Object.freeze({
    mode,
    processName,
    releaseId,
    executable: mode === "enabled" ? path.resolve(executable) : null,
    projectRoot: path.resolve(projectRoot),
    pm2Home:
      typeof options.pm2Home === "string" && options.pm2Home.length > 0
        ? path.resolve(options.pm2Home)
        : null,
    policy,
    controlEnvironment: Object.freeze({ ...controlEnvironment }),
    lifecycle,
  });
}

function readRowShape(row, source) {
  if (!isPlainObject(row)) return null;
  if (source === "live") {
    if (!isPlainObject(row.pm2_env)) return null;
    return { definition: row.pm2_env, environment: row.pm2_env.env };
  }
  if (source === "dump") {
    return { definition: row, environment: row.env };
  }
  return null;
}

function auditLifecycle(definition, expected) {
  if (
    normalizedInteger(definition.instances) !== expected.instances ||
    normalizedExecMode(definition.exec_mode) !== expected.execMode ||
    normalizedBoolean(definition.autorestart) !== expected.autorestart ||
    normalizedBoolean(definition.wait_ready) !== expected.waitReady ||
    normalizedInteger(definition.listen_timeout) !== expected.listenTimeout ||
    normalizedInteger(definition.kill_timeout) !== expected.killTimeout ||
    normalizedInteger(definition.min_uptime) !== expected.minUptime ||
    normalizedInteger(definition.max_restarts) !== expected.maxRestarts ||
    normalizedInteger(definition.restart_delay) !== expected.restartDelay ||
    normalizedInteger(definition.exp_backoff_restart_delay) !==
      expected.backoffRestartDelay
  ) {
    return failure("HR_BRIDGE_PM2_LIFECYCLE_MISMATCH");
  }

  if (!Array.isArray(definition.stop_exit_codes)) {
    return failure("HR_BRIDGE_PM2_LIFECYCLE_MISMATCH");
  }
  const stopExitCodes = definition.stop_exit_codes.map(normalizedInteger);
  if (
    stopExitCodes.some((value) => value == null) ||
    JSON.stringify(stopExitCodes) !== JSON.stringify(expected.stopExitCodes)
  ) {
    return failure("HR_BRIDGE_PM2_LIFECYCLE_MISMATCH");
  }
  return OK;
}

function metadataValueIsValid(key, value, expected) {
  if (key === "PM2_HOME") {
    if (typeof value !== "string" || value.length === 0) return false;
    return expected.pm2Home
      ? samePath(value, expected.pm2Home)
      : path.isAbsolute(value);
  }
  if (key === "unique_id") {
    return typeof value === "string" && value.length > 0 && value.length <= 200;
  }
  if (key === "PM2_JSON_PROCESSING") {
    return value === true || value === "true";
  }
  if (key === "PWD") {
    return samePath(value, expected.projectRoot);
  }
  if (key === expected.processName) {
    return (
      value === "{}" ||
      (isPlainObject(value) && Object.keys(value).length === 0)
    );
  }
  // HR_BRIDGE_RELEASE_ID is an obligatory control value, not optional
  // bookkeeping, and is validated before this function is called.
  return false;
}

function auditEnvironment(environment, expected) {
  if (!isPlainObject(environment)) {
    return failure("HR_BRIDGE_PM2_ENVIRONMENT_MISSING");
  }

  const expectedValues = {
    ...expected.controlEnvironment,
    HR_BRIDGE_RELEASE_ID: expected.releaseId,
  };
  for (const [key, value] of Object.entries(expectedValues)) {
    if (
      typeof environment[key] !== "string" ||
      environment[key] !== value
    ) {
      return failure("HR_BRIDGE_PM2_ENVIRONMENT_MISMATCH");
    }
  }

  const metadataKeys = new Set(expected.policy.pm2EnvironmentMetadataKeys);
  for (const [key, value] of Object.entries(environment)) {
    if (Object.hasOwn(expectedValues, key)) continue;
    if (!metadataKeys.has(key)) {
      // This deliberately rejects other policy-allowed application variables,
      // including database URLs and shared secrets. The immutable bootstrap
      // reads those from its 0600 snapshot; PM2 receives controls only.
      return failure("HR_BRIDGE_PM2_ENVIRONMENT_KEYSET_MISMATCH");
    }
    if (!metadataValueIsValid(key, value, expected)) {
      return failure("HR_BRIDGE_PM2_METADATA_INVALID");
    }
  }
  return OK;
}

function auditBridgePm2Rows(rows, options) {
  try {
    const expected = normalizeExpectation(options);
    const source = options?.source;
    if (!expected || !["live", "dump"].includes(source)) {
      return failure("HR_BRIDGE_PM2_EXPECTATION_INVALID");
    }
    if (!Array.isArray(rows)) {
      return failure("HR_BRIDGE_PM2_ROWS_INVALID");
    }
    const matches = rows.filter((row) => row?.name === expected.processName);
    const expectedCount = expected.mode === "enabled" ? 1 : 0;
    if (matches.length !== expectedCount) {
      return failure("HR_BRIDGE_PM2_PROCESS_COUNT_INVALID");
    }
    if (expectedCount === 0) return OK;

    const shape = readRowShape(matches[0], source);
    if (!shape) return failure("HR_BRIDGE_PM2_ROW_INVALID");
    if (!samePath(shape.definition.pm_exec_path, expected.executable)) {
      return failure("HR_BRIDGE_PM2_RELEASE_PATH_MISMATCH");
    }
    if (!samePath(shape.definition.pm_cwd, expected.projectRoot)) {
      return failure("HR_BRIDGE_PM2_CWD_MISMATCH");
    }

    const lifecycle = auditLifecycle(shape.definition, expected.lifecycle);
    if (!lifecycle.ok) return lifecycle;
    return auditEnvironment(shape.environment, expected);
  } catch {
    return failure("HR_BRIDGE_PM2_AUDIT_FAILED");
  }
}

function auditLiveBridgePm2Rows(rows, options) {
  return auditBridgePm2Rows(rows, { ...options, source: "live" });
}

function auditDumpBridgePm2Rows(rows, options) {
  return auditBridgePm2Rows(rows, { ...options, source: "dump" });
}

function assertAudit(report) {
  if (!report.ok) throw new Error(report.code);
  return true;
}

function assertLiveBridgePm2Rows(rows, options) {
  return assertAudit(auditLiveBridgePm2Rows(rows, options));
}

function assertDumpBridgePm2Rows(rows, options) {
  return assertAudit(auditDumpBridgePm2Rows(rows, options));
}

function bridgePm2RowsMatch(rows, options) {
  return auditBridgePm2Rows(rows, options).ok;
}

function runSelftest() {
  const assert = require("node:assert/strict");
  const root = path.resolve("/srv/example");
  const release = {
    id: "a".repeat(64),
    mode: "enabled",
    bootstrapPath: path.join(root, ".runtime", "bridge-worker.mjs"),
  };
  const policy = {
    pm2ListenTimeoutMs: 75_000,
    pm2KillTimeoutMs: 35_000,
    minUptimeMs: 90_000,
    disabledExitCode: 78,
    allowedEnvironmentKeys: [...CONTROL_KEYS, "DATABASE_URL"],
    pm2EnvironmentMetadataKeys: [
      "PM2_HOME",
      "unique_id",
      "PM2_JSON_PROCESSING",
      "HR_BRIDGE_RELEASE_ID",
      BRIDGE_PROCESS_NAME,
      "PWD",
    ],
  };
  const environment = {
    ...EXPECTED_CONTROL_ENVIRONMENT,
    HR_BRIDGE_RELEASE_ID: release.id,
    PM2_HOME: path.resolve("/srv/example-pm2"),
    PWD: root,
    [BRIDGE_PROCESS_NAME]: "{}",
  };
  const definition = {
    pm_exec_path: release.bootstrapPath,
    pm_cwd: root,
    instances: "1",
    exec_mode: "fork_mode",
    autorestart: "true",
    wait_ready: 1,
    listen_timeout: "75000",
    kill_timeout: 35_000,
    min_uptime: "90000",
    max_restarts: 10,
    restart_delay: "0",
    exp_backoff_restart_delay: "3000",
    stop_exit_codes: ["78"],
  };
  const options = {
    release,
    policy,
    projectRoot: root,
    controlEnvironment: EXPECTED_CONTROL_ENVIRONMENT,
    pm2Home: environment.PM2_HOME,
  };
  const live = [{ name: BRIDGE_PROCESS_NAME, pm2_env: { ...definition, env: environment } }];
  const dump = [{ name: BRIDGE_PROCESS_NAME, ...definition, env: environment }];
  assert.deepEqual(auditLiveBridgePm2Rows(live, options), OK);
  assert.deepEqual(auditDumpBridgePm2Rows(dump, options), OK);
  assert.equal(assertLiveBridgePm2Rows(live, options), true);

  const drifted = structuredClone(live);
  drifted[0].pm2_env.max_restarts = 11;
  assert.equal(
    auditLiveBridgePm2Rows(drifted, options).code,
    "HR_BRIDGE_PM2_LIFECYCLE_MISMATCH",
  );

  const leaked = structuredClone(dump);
  leaked[0].env.DATABASE_URL = "must-not-be-reported";
  assert.equal(
    auditDumpBridgePm2Rows(leaked, options).code,
    "HR_BRIDGE_PM2_ENVIRONMENT_KEYSET_MISMATCH",
  );

  const disabledOptions = {
    ...options,
    mode: "disabled",
    release: { ...release, mode: "disabled" },
  };
  assert.equal(auditDumpBridgePm2Rows([], disabledOptions).ok, true);
  assert.equal(
    auditDumpBridgePm2Rows(dump, disabledOptions).code,
    "HR_BRIDGE_PM2_PROCESS_COUNT_INVALID",
  );
  process.stdout.write("hr bridge pm2 contract selftest: passed\n");
}

module.exports = Object.freeze({
  BRIDGE_PROCESS_NAME,
  EXPECTED_CONTROL_ENVIRONMENT,
  assertDumpBridgePm2Rows,
  assertLiveBridgePm2Rows,
  auditBridgePm2Rows,
  auditDumpBridgePm2Rows,
  auditLiveBridgePm2Rows,
  bridgePm2RowsMatch,
});

if (require.main === module) {
  if (process.argv[2] !== "--selftest") {
    throw new Error("HR_BRIDGE_PM2_CONTRACT_ARGUMENT_INVALID");
  }
  runSelftest();
}
