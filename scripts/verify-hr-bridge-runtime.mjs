#!/usr/bin/env node

import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import policy from "./hr-bridge-runtime-policy.cjs";

function finiteNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseBridgeProcess(pm2Json) {
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
  const matches = rows.filter((row) => row?.name === "erp-hr-bridge");
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

  if (status !== "online" || diagnostics.pid == null) {
    return { ok: false, reason: "PM2_BRIDGE_NOT_ONLINE", ...diagnostics };
  }

  const rawPort = env.HR_DEVICE_PORT;
  const configuredPort =
    rawPort == null || String(rawPort).trim() === "" ? 7788 : Number(rawPort);
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

export function verifyBridgeRuntimeSnapshot(pm2Json, socketOutput, port) {
  const processState = parseBridgeProcess(pm2Json);
  if (!processState.ok) return processState;
  if (processState.configuredPort !== port) {
    return { ...processState, ok: false, reason: "PM2_BRIDGE_PORT_MISMATCH" };
  }
  if (!findListeningBridge(socketOutput, port, processState.pid)) {
    return { ...processState, ok: false, reason: "BRIDGE_PORT_NOT_LISTENING" };
  }
  return processState;
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
    ready:
      reachedMinimumUptime && samples >= policy.runtimeStableSamples,
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
  return verifyBridgeRuntimeSnapshot(pm2Json, sockets, port);
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
  const port = Number(process.env.HR_DEVICE_PORT || "7788");
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
        if (["errored", "stopped"].includes(result.status)) {
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

function selftest() {
  const online = JSON.stringify([
    {
      name: "erp-hr-bridge",
      pid: 7312,
      pm2_env: {
        status: "online",
        HR_DEVICE_PORT: "7788",
        restart_time: 4,
        unstable_restarts: 0,
        pm_uptime: Date.now() - 5_000,
      },
    },
  ]);
  const offline = JSON.stringify([
    { name: "erp-hr-bridge", pid: 7312, pm2_env: { status: "stopped" } },
  ]);
  const wrongConfiguredPort = JSON.stringify([
    {
      name: "erp-hr-bridge",
      pid: 7312,
      pm2_env: { status: "online", HR_DEVICE_PORT: "7789" },
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
    advanceBridgeStability(third, { ...healthy, restartCount: 5 }).samples === 1,
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
  verifyLive().catch((error) => {
    console.error(
      `hr bridge runtime gate: failed (${error instanceof Error ? error.message : "UNKNOWN"})`,
    );
    process.exitCode = 1;
  });
}
