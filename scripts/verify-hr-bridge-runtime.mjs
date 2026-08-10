#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import sourcePolicy from "./hr-bridge-runtime-policy.cjs";
import releaseTools from "./hr-bridge-release.cjs";

const projectRootArgumentIndex = process.argv.indexOf("--project-root");
const PROJECT_ROOT = path.resolve(
  projectRootArgumentIndex >= 0 && process.argv[projectRootArgumentIndex + 1]
    ? process.argv[projectRootArgumentIndex + 1]
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const releaseIdArgumentIndex = process.argv.indexOf("--release-id");
const expectedReleaseId =
  releaseIdArgumentIndex >= 0 ? process.argv[releaseIdArgumentIndex + 1] : null;
if (releaseIdArgumentIndex >= 0 && !expectedReleaseId) {
  throw new Error("HR_BRIDGE_RELEASE_ID_REQUIRED");
}
if (
  !process.argv.includes("--selftest") &&
  !expectedReleaseId
) {
  throw new Error("HR_BRIDGE_RELEASE_ID_REQUIRED");
}
const expectedRelease = expectedReleaseId
  ? releaseTools.validateRelease(PROJECT_ROOT, expectedReleaseId)
  : null;
const expectedEnvironment = expectedReleaseId
  ? releaseTools.loadReleaseEnvironment(PROJECT_ROOT, expectedReleaseId)
  : null;
const policy = expectedReleaseId
  ? releaseTools.loadReleasePolicy(PROJECT_ROOT, expectedReleaseId)
  : sourcePolicy;
const expectedProcess = expectedRelease
  ? Object.freeze({
      executable: path.resolve(expectedRelease.bootstrapPath),
      cwd: PROJECT_ROOT,
      configuredPort: Number(expectedEnvironment?.HR_DEVICE_PORT || "7788"),
    })
  : null;
function finiteNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const BRIDGE_PROCESS_NAME = "erp-hr-bridge";
const PM2_CONTROL_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  TZ: "UTC",
  HR_BRIDGE_LOAD_DOTENV: "0",
});

function processEnvironmentValue(pm2Env, key) {
  const nested =
    pm2Env?.env && typeof pm2Env.env === "object" ? pm2Env.env : null;
  return nested?.[key];
}

function expectedPm2Home() {
  return path.resolve(
    process.env.PM2_HOME?.trim() ||
      path.join(process.env.HOME?.trim() || homedir(), ".pm2"),
  );
}

function metadataValueIsValid(key, value) {
  if (key === "PM2_HOME") {
    return typeof value === "string" && path.resolve(value) === expectedPm2Home();
  }
  if (key === "unique_id") {
    return typeof value === "string" && value.length > 0 && value.length <= 200;
  }
  if (key === "PM2_JSON_PROCESSING") {
    return value === true || value === "true";
  }
  if (key === "HR_BRIDGE_RELEASE_ID") {
    return (
      expectedReleaseId == null ||
      (typeof value === "string" && value === expectedReleaseId)
    );
  }
  if (key === BRIDGE_PROCESS_NAME) {
    return (
      value === "{}" ||
      (value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    );
  }
  if (key === "PWD") {
    return typeof value === "string" && path.resolve(value) === PROJECT_ROOT;
  }
  return false;
}

function auditManagedEnvironment(pm2Env) {
  const applicationEnv =
    pm2Env?.env && typeof pm2Env.env === "object" && !Array.isArray(pm2Env.env)
      ? pm2Env.env
      : null;
  if (!applicationEnv || applicationEnv.HR_BRIDGE_LOAD_DOTENV !== "0") {
    return { ok: false, reason: "PM2_BRIDGE_MANAGED_ENVIRONMENT_MISSING" };
  }
  const allowed = new Set(policy.allowedEnvironmentKeys);
  const metadata = new Set(policy.pm2EnvironmentMetadataKeys);
  const unknown = Object.keys(applicationEnv).filter(
    (key) => !allowed.has(key) && !metadata.has(key),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: "PM2_BRIDGE_ENV_LEAK",
      leakCount: unknown.length,
    };
  }
  const invalidMetadata = Object.entries(applicationEnv).filter(
    ([key, value]) => metadata.has(key) && !metadataValueIsValid(key, value),
  );
  if (
    invalidMetadata.length > 0 ||
    !Object.hasOwn(applicationEnv, "PM2_HOME") ||
    !Object.hasOwn(applicationEnv, BRIDGE_PROCESS_NAME) ||
    (expectedReleaseId != null &&
      !Object.hasOwn(applicationEnv, "HR_BRIDGE_RELEASE_ID"))
  ) {
    return { ok: false, reason: "PM2_BRIDGE_METADATA_INVALID" };
  }
  if (expectedEnvironment) {
    const allowedEntries = Object.entries(applicationEnv).filter(([key]) =>
      allowed.has(key),
    );
    const mismatchCount =
      allowedEntries.filter(
        ([key, value]) =>
          !Object.hasOwn(PM2_CONTROL_ENVIRONMENT, key) ||
          String(value) !== PM2_CONTROL_ENVIRONMENT[key],
      ).length +
      Object.keys(PM2_CONTROL_ENVIRONMENT).filter(
        (key) => !Object.hasOwn(applicationEnv, key),
      ).length;
    if (mismatchCount > 0)
      return {
        ok: false,
        reason: "PM2_BRIDGE_ENVIRONMENT_MISMATCH",
        mismatchCount,
      };
  }
  return { ok: true, reason: null };
}

export function parseBridgeProcess(pm2Json, expectation = null) {
  let rows;
  try {
    rows = JSON.parse(pm2Json);
  } catch {
    return {
      ok: false,
      reason: "PM2_JSON_INVALID",
      pid: null,
      status: "unknown",
    };
  }
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      reason: "PM2_JSON_INVALID",
      pid: null,
      status: "unknown",
    };
  }
  const matches = rows.filter((row) => row?.name === BRIDGE_PROCESS_NAME);
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: "PM2_BRIDGE_COUNT_INVALID",
      pid: null,
      status: "missing",
      processCount: matches.length,
    };
  }

  const row = matches[0];
  const env = row?.pm2_env ?? {};
  const pid = Number(row.pid);
  const status = typeof env.status === "string" ? env.status : "unknown";
  const pmUptime = finiteNumber(env.pm_uptime);
  const diagnostics = {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    status,
    restartCount: finiteNumber(env.restart_time, 0),
    unstableRestarts: finiteNumber(env.unstable_restarts, 0),
    exitCode: finiteNumber(env.exit_code),
    uptimeMs: pmUptime == null ? null : Math.max(0, Date.now() - pmUptime),
  };

  const environmentAudit = auditManagedEnvironment(env);
  if (!environmentAudit.ok) {
    return { ...diagnostics, ...environmentAudit };
  }

  if (status !== "online" || diagnostics.pid == null) {
    return { ok: false, reason: "PM2_BRIDGE_NOT_ONLINE", ...diagnostics };
  }

  if (expectation) {
    const executable =
      typeof env.pm_exec_path === "string"
        ? path.resolve(env.pm_exec_path)
        : null;
    const cwd =
      typeof env.pm_cwd === "string" ? path.resolve(env.pm_cwd) : null;
    if (executable !== expectation.executable) {
      return {
        ok: false,
        reason: "PM2_BRIDGE_RELEASE_PATH_MISMATCH",
        ...diagnostics,
      };
    }
    if (cwd !== expectation.cwd) {
      return {
        ok: false,
        reason: "PM2_BRIDGE_CWD_MISMATCH",
        ...diagnostics,
      };
    }
  }

  const rawPort = processEnvironmentValue(env, "HR_DEVICE_PORT");
  const configuredPort = Number.isInteger(expectation?.configuredPort)
    ? expectation.configuredPort
    : rawPort == null || String(rawPort).trim() === ""
      ? 7788
      : Number(rawPort);
  if (
    !Number.isInteger(configuredPort) ||
    configuredPort < 1 ||
    configuredPort > 65_535
  ) {
    return {
      ok: false,
      reason: "PM2_BRIDGE_PORT_INVALID",
      configuredPort,
      ...diagnostics,
    };
  }
  return { ok: true, reason: null, configuredPort, ...diagnostics };
}

function listenerPort(localAddress) {
  const match =
    /(?:^|\]):(\d+)$/.exec(localAddress) ?? /:(\d+)$/.exec(localAddress);
  return match ? Number(match[1]) : null;
}

export function findListeningBridge(socketOutput, port, pid) {
  for (const line of socketOutput.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length < 4 ||
      fields[0] !== "LISTEN" ||
      listenerPort(fields[3]) !== port
    )
      continue;
    const processDetails = fields.slice(5).join(" ");
    // fail-closed: بلا PID لا نستطيع إثبات أن المستمع هو عامل PM2 المقصود.
    if (
      !processDetails ||
      (!processDetails.includes(`pid=${pid},`) &&
        !processDetails.includes(`pid=${pid})`))
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function verifyBridgeRuntimeSnapshot(
  pm2Json,
  socketOutput,
  port,
  expectation = null,
) {
  const processState = parseBridgeProcess(pm2Json, expectation);
  if (!processState.ok) return processState;
  if (processState.configuredPort !== port) {
    return { ...processState, ok: false, reason: "PM2_BRIDGE_PORT_MISMATCH" };
  }
  if (!findListeningBridge(socketOutput, port, processState.pid)) {
    return { ...processState, ok: false, reason: "BRIDGE_PORT_NOT_LISTENING" };
  }
  return processState;
}

export function verifyBridgeDisabledSnapshot(
  pm2Json,
  socketOutput = "",
  forbiddenPorts = [],
) {
  let rows;
  try {
    rows = JSON.parse(pm2Json);
  } catch {
    return { ok: false, reason: "PM2_JSON_INVALID", processCount: null };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, reason: "PM2_JSON_INVALID", processCount: null };
  }
  const processCount = rows.filter(
    (row) => row?.name === BRIDGE_PROCESS_NAME,
  ).length;
  if (processCount !== 0) {
    return { ok: false, reason: "PM2_BRIDGE_MUST_BE_ABSENT", processCount };
  }
  const forbidden = new Set(forbiddenPorts);
  const occupied = socketOutput.split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return (
      fields.length >= 4 &&
      fields[0] === "LISTEN" &&
      forbidden.has(listenerPort(fields[3]))
    );
  });
  return occupied
    ? { ok: false, reason: "BRIDGE_DISABLED_PORT_STILL_LISTENING", processCount }
    : { ok: true, reason: null, processCount };
}

/** منطق نقي لنافذة الاستقرار؛ يسهّل اختباره بعيداً عن PM2 وss الحقيقيين. */
export function advanceBridgeStability(previous, result) {
  if (!result?.ok) return { key: null, samples: 0, ready: false };
  const key = `${result.pid}:${result.restartCount}`;
  const samples = previous?.key === key ? previous.samples + 1 : 1;
  const reachedMinimumUptime =
    result.uptimeMs != null && result.uptimeMs >= policy.minUptimeMs;
  return {
    key,
    samples,
    ready: reachedMinimumUptime && samples >= policy.runtimeStableSamples,
  };
}

function snapshot(port) {
  const options = {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  };
  const pm2Json = execFileSync("pm2", ["jlist"], options);
  const sockets = execFileSync("ss", ["-H", "-ltnp"], options);
  return verifyBridgeRuntimeSnapshot(pm2Json, sockets, port, expectedProcess);
}

function diagnosticSummary(result) {
  return [
    `reason=${result?.reason ?? "UNKNOWN"}`,
    `status=${result?.status ?? "unknown"}`,
    `pid=${result?.pid ?? "none"}`,
    `restarts=${result?.restartCount ?? "unknown"}`,
    `unstable=${result?.unstableRestarts ?? "unknown"}`,
    `exit=${result?.exitCode ?? "unknown"}`,
    `uptimeMs=${result?.uptimeMs ?? "unknown"}`,
  ].join(" ");
}

async function verifyLive() {
  const port = Number(expectedEnvironment?.HR_DEVICE_PORT || "7788");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HR_DEVICE_PORT_INVALID");
  }
  const deadline = Date.now() + policy.runtimeGateTimeoutMs;
  let lastResult = {
    reason: "BRIDGE_RUNTIME_UNKNOWN",
    status: "unknown",
    pid: null,
  };
  let lastReportedReason = null;
  let stability = { key: null, samples: 0, ready: false };

  while (Date.now() < deadline) {
    try {
      const result = snapshot(port);
      lastResult = result;
      if (result.ok) {
        stability = advanceBridgeStability(stability, result);
        if (stability.ready) {
          console.log(
            `hr bridge runtime gate: PM2 online and TCP ${port} stable ` +
              `(${stability.samples} samples, uptime ${result.uptimeMs}ms, pid ${result.pid})`,
          );
          return;
        }
        lastResult = {
          ...result,
          ok: false,
          reason:
            result.uptimeMs == null || result.uptimeMs < policy.minUptimeMs
              ? "BRIDGE_MIN_UPTIME_NOT_REACHED"
              : "BRIDGE_STABILITY_WINDOW_NOT_REACHED",
        };
      } else {
        stability = advanceBridgeStability(stability, result);
        if (
          ["errored", "stopped"].includes(result.status) ||
          [
            "PM2_BRIDGE_MANAGED_ENVIRONMENT_MISSING",
            "PM2_BRIDGE_ENV_LEAK",
            "PM2_BRIDGE_METADATA_INVALID",
            "PM2_BRIDGE_ENVIRONMENT_MISMATCH",
          ].includes(result.reason)
        ) {
          throw new Error(diagnosticSummary(result));
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("reason="))
        throw error;
      lastResult = {
        ok: false,
        reason: "BRIDGE_RUNTIME_PROBE_FAILED",
        status: "unknown",
        pid: null,
      };
      stability = advanceBridgeStability(stability, lastResult);
    }

    if (lastResult.reason !== lastReportedReason) {
      console.log(
        `hr bridge runtime gate: waiting (${diagnosticSummary(lastResult)})`,
      );
      lastReportedReason = lastResult.reason;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, policy.runtimeSampleIntervalMs),
    );
  }

  throw new Error(diagnosticSummary(lastResult));
}

async function verifyDisabledLive() {
  const deadline = Date.now() + 10_000;
  const port = Number(expectedEnvironment?.HR_DEVICE_PORT || "7788");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HR_DEVICE_PORT_INVALID");
  }
  let stableSamples = 0;
  let last = { ok: false, reason: "PM2_BRIDGE_DISABLED_UNKNOWN" };
  while (Date.now() < deadline) {
    try {
      const pm2Json = execFileSync("pm2", ["jlist"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const sockets = execFileSync("ss", ["-H", "-ltnp"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      last = verifyBridgeDisabledSnapshot(pm2Json, sockets, [port]);
      stableSamples = last.ok ? stableSamples + 1 : 0;
      if (stableSamples >= policy.runtimeStableSamples) {
        console.log(
          `hr bridge runtime gate: intentionally disabled and absent from PM2 (${stableSamples} samples)`,
        );
        return;
      }
    } catch {
      last = { ok: false, reason: "PM2_BRIDGE_DISABLED_PROBE_FAILED" };
      stableSamples = 0;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, policy.runtimeSampleIntervalMs),
    );
  }
  throw new Error(
    `reason=${last.reason ?? "UNKNOWN"} count=${last.processCount ?? "unknown"}`,
  );
}

function selftest() {
  const managedEnv = (values = {}) => ({
    HR_BRIDGE_LOAD_DOTENV: "0",
    PM2_HOME: expectedPm2Home(),
    [BRIDGE_PROCESS_NAME]: {},
    ...values,
  });
  const online = JSON.stringify([
    {
      name: "erp-hr-bridge",
      pid: 7312,
      pm2_env: {
        status: "online",
        env: managedEnv({ HR_DEVICE_PORT: "7788" }),
        HR_DEVICE_PORT: "7788",
        restart_time: 4,
        unstable_restarts: 0,
        pm_uptime: Date.now() - 5_000,
        pm_exec_path: path.join(PROJECT_ROOT, "fixture-worker.mjs"),
        pm_cwd: PROJECT_ROOT,
      },
    },
  ]);
  const offline = JSON.stringify([
    {
      name: "erp-hr-bridge",
      pid: 7312,
      pm2_env: {
        status: "stopped",
        env: managedEnv(),
      },
    },
  ]);
  const wrongConfiguredPort = JSON.stringify([
    {
      name: "erp-hr-bridge",
      pid: 7312,
      pm2_env: {
        status: "online",
        env: managedEnv({ HR_DEVICE_PORT: "7789" }),
      },
    },
  ]);
  const ipv4 =
    'LISTEN 0 511 0.0.0.0:7788 0.0.0.0:* users:(("node",pid=7312,fd=22))';
  const ipv6 = 'LISTEN 0 511 [::]:7788 [::]:* users:(("node",pid=7312,fd=22))';
  const wrongListener =
    'LISTEN 0 511 0.0.0.0:7789 0.0.0.0:* users:(("node",pid=7312,fd=22))';
  const wrongOwner =
    'LISTEN 0 511 0.0.0.0:7788 0.0.0.0:* users:(("node",pid=9999,fd=22))';
  const hiddenOwner = "LISTEN 0 511 0.0.0.0:7788 0.0.0.0:*";
  const cases = [
    verifyBridgeRuntimeSnapshot(online, ipv4, 7788).ok === true,
    verifyBridgeRuntimeSnapshot(online, ipv6, 7788).ok === true,
    verifyBridgeRuntimeSnapshot(online, ipv4, 7788).restartCount === 4,
    verifyBridgeRuntimeSnapshot(offline, ipv4, 7788).reason ===
      "PM2_BRIDGE_NOT_ONLINE",
    verifyBridgeRuntimeSnapshot("[]", ipv4, 7788).reason ===
      "PM2_BRIDGE_COUNT_INVALID",
    verifyBridgeRuntimeSnapshot(online, wrongOwner, 7788).reason ===
      "BRIDGE_PORT_NOT_LISTENING",
    verifyBridgeRuntimeSnapshot(online, hiddenOwner, 7788).reason ===
      "BRIDGE_PORT_NOT_LISTENING",
    verifyBridgeRuntimeSnapshot(online, wrongListener, 7788).reason ===
      "BRIDGE_PORT_NOT_LISTENING",
    verifyBridgeRuntimeSnapshot(wrongConfiguredPort, ipv4, 7788).reason ===
      "PM2_BRIDGE_PORT_MISMATCH",
    verifyBridgeDisabledSnapshot("[]").ok === true,
    verifyBridgeDisabledSnapshot(online).reason ===
      "PM2_BRIDGE_MUST_BE_ABSENT",
    verifyBridgeDisabledSnapshot("[]", ipv4, [7788]).reason ===
      "BRIDGE_DISABLED_PORT_STILL_LISTENING",
    verifyBridgeRuntimeSnapshot(online, ipv4, 7788, {
      executable: path.join(PROJECT_ROOT, "fixture-worker.mjs"),
      cwd: PROJECT_ROOT,
    }).ok === true,
    verifyBridgeRuntimeSnapshot(online, ipv4, 7788, {
      executable: path.join(PROJECT_ROOT, "wrong-worker.mjs"),
      cwd: PROJECT_ROOT,
    }).reason === "PM2_BRIDGE_RELEASE_PATH_MISMATCH",
    verifyBridgeRuntimeSnapshot(online, ipv4, 7788, {
      executable: path.join(PROJECT_ROOT, "fixture-worker.mjs"),
      cwd: path.join(PROJECT_ROOT, "wrong-cwd"),
    }).reason === "PM2_BRIDGE_CWD_MISMATCH",
    verifyBridgeRuntimeSnapshot(
      JSON.stringify([
        {
          name: "erp-hr-bridge",
          pid: 7312,
          pm2_env: {
            status: "online",
            env: managedEnv({
              HR_DEVICE_PORT: "7788",
              unique_id: "bridge-fixture",
              PM2_JSON_PROCESSING: true,
              PWD: PROJECT_ROOT,
            }),
            restart_time: 0,
            pm_uptime: Date.now() - 5_000,
          },
        },
      ]),
      ipv4,
      7788,
    ).ok === true,
    verifyBridgeRuntimeSnapshot(
      JSON.stringify([
        {
          name: "erp-hr-bridge",
          pid: 7312,
          pm2_env: {
            status: "online",
            env: managedEnv({
              HR_DEVICE_PORT: "7788",
              SHELL_ONLY_SECRET: "canary",
            }),
          },
        },
      ]),
      ipv4,
      7788,
    ).reason === "PM2_BRIDGE_ENV_LEAK",
    verifyBridgeRuntimeSnapshot(
      JSON.stringify([
        {
          name: "erp-hr-bridge",
          pid: 7312,
          pm2_env: { status: "online", HR_DEVICE_PORT: "7788" },
        },
      ]),
      ipv4,
      7788,
    ).reason === "PM2_BRIDGE_MANAGED_ENVIRONMENT_MISSING",
    verifyBridgeRuntimeSnapshot(
      JSON.stringify([
        {
          name: BRIDGE_PROCESS_NAME,
          pid: 7312,
          pm2_env: {
            status: "online",
            env: managedEnv({ [BRIDGE_PROCESS_NAME]: { injected: true } }),
          },
        },
      ]),
      ipv4,
      7788,
    ).reason === "PM2_BRIDGE_METADATA_INVALID",
    verifyBridgeRuntimeSnapshot(
      JSON.stringify([
        {
          name: BRIDGE_PROCESS_NAME,
          pid: 7312,
          pm2_env: {
            status: "online",
            env: managedEnv({ EMPTY_UNKNOWN_KEY: "" }),
          },
        },
      ]),
      ipv4,
      7788,
    ).reason === "PM2_BRIDGE_ENV_LEAK",
  ];
  const healthy = {
    ok: true,
    pid: 7312,
    restartCount: 4,
    uptimeMs: policy.minUptimeMs,
  };
  const first = advanceBridgeStability(null, healthy);
  const second = advanceBridgeStability(first, healthy);
  const third = advanceBridgeStability(second, healthy);
  cases.push(
    first.samples === 1 && first.ready === false,
    second.samples === 2 && second.ready === false,
    third.samples === 3 && third.ready === true,
    advanceBridgeStability(third, { ...healthy, pid: 8000 }).samples === 1,
    advanceBridgeStability(third, { ...healthy, restartCount: 5 }).samples ===
      1,
    advanceBridgeStability(third, { ok: false }).samples === 0,
    advanceBridgeStability(second, {
      ...healthy,
      uptimeMs: policy.minUptimeMs - 1,
    }).ready === false,
  );
  if (cases.some((passed) => !passed))
    throw new Error("hr bridge runtime selftest failed");
  console.log(
    `hr bridge runtime selftest: ${cases.length}/${cases.length} passed`,
  );
}

if (process.argv.includes("--selftest")) {
  selftest();
} else if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const verification = process.argv.includes("--expect-disabled")
    ? verifyDisabledLive()
    : verifyLive();
  verification.catch((error) => {
    console.error(
      `hr bridge runtime gate: failed (${error instanceof Error ? error.message : "UNKNOWN"})`,
    );
    process.exitCode = 1;
  });
}
