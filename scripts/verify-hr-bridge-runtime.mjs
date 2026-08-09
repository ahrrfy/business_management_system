#!/usr/bin/env node

import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function parseBridgeProcess(pm2Json) {
  let rows;
  try {
    rows = JSON.parse(pm2Json);
  } catch {
    return { ok: false, reason: "PM2_JSON_INVALID", pid: null };
  }
  if (!Array.isArray(rows)) return { ok: false, reason: "PM2_JSON_INVALID", pid: null };
  const matches = rows.filter((row) => row?.name === "erp-hr-bridge");
  if (matches.length !== 1) return { ok: false, reason: "PM2_BRIDGE_COUNT_INVALID", pid: null };
  const row = matches[0];
  const pid = Number(row.pid);
  if (row?.pm2_env?.status !== "online" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "PM2_BRIDGE_NOT_ONLINE", pid: null };
  }
  const rawPort = row?.pm2_env?.HR_DEVICE_PORT;
  const configuredPort = rawPort == null || String(rawPort).trim() === "" ? 7788 : Number(rawPort);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    return { ok: false, reason: "PM2_BRIDGE_PORT_INVALID", pid };
  }
  return { ok: true, reason: null, pid, configuredPort };
}

function listenerPort(localAddress) {
  const match = /(?:^|\]):(\d+)$/.exec(localAddress) ?? /:(\d+)$/.exec(localAddress);
  return match ? Number(match[1]) : null;
}

export function findListeningBridge(socketOutput, port, pid) {
  for (const line of socketOutput.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[0] !== "LISTEN" || listenerPort(fields[3]) !== port) continue;
    const processDetails = fields.slice(5).join(" ");
    // fail-closed: بلا PID لا نستطيع إثبات أن المستمع هو عامل PM2 المقصود.
    if (!processDetails || (!processDetails.includes(`pid=${pid},`) && !processDetails.includes(`pid=${pid})`))) {
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
    return { ok: false, reason: "PM2_BRIDGE_PORT_MISMATCH", pid: processState.pid };
  }
  if (!findListeningBridge(socketOutput, port, processState.pid)) {
    return { ok: false, reason: "BRIDGE_PORT_NOT_LISTENING", pid: processState.pid };
  }
  return processState;
}

function snapshot(port) {
  const options = { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 };
  const pm2Json = execFileSync("pm2", ["jlist"], options);
  const sockets = execFileSync("ss", ["-H", "-ltnp"], options);
  return verifyBridgeRuntimeSnapshot(pm2Json, sockets, port);
}

async function verifyLive() {
  const port = Number(process.env.HR_DEVICE_PORT || "7788");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HR_DEVICE_PORT_INVALID");
  }
  const deadline = Date.now() + 20_000;
  let lastReason = "BRIDGE_RUNTIME_UNKNOWN";
  while (Date.now() < deadline) {
    try {
      const result = snapshot(port);
      if (result.ok) {
        console.log(`hr bridge runtime gate: PM2 online and TCP ${port} listening`);
        return;
      }
      lastReason = result.reason ?? lastReason;
    } catch {
      lastReason = "BRIDGE_RUNTIME_PROBE_FAILED";
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(lastReason);
}

function selftest() {
  const online = JSON.stringify([{ name: "erp-hr-bridge", pid: 7312, pm2_env: { status: "online", HR_DEVICE_PORT: "7788" } }]);
  const offline = JSON.stringify([{ name: "erp-hr-bridge", pid: 7312, pm2_env: { status: "stopped" } }]);
  const wrongConfiguredPort = JSON.stringify([{ name: "erp-hr-bridge", pid: 7312, pm2_env: { status: "online", HR_DEVICE_PORT: "7789" } }]);
  const ipv4 = 'LISTEN 0 511 0.0.0.0:7788 0.0.0.0:* users:(("node",pid=7312,fd=22))';
  const ipv6 = 'LISTEN 0 511 [::]:7788 [::]:* users:(("node",pid=7312,fd=22))';
  const wrongListener = 'LISTEN 0 511 0.0.0.0:7789 0.0.0.0:* users:(("node",pid=7312,fd=22))';
  const wrongOwner = 'LISTEN 0 511 0.0.0.0:7788 0.0.0.0:* users:(("node",pid=9999,fd=22))';
  const hiddenOwner = "LISTEN 0 511 0.0.0.0:7788 0.0.0.0:*";
  const cases = [
    verifyBridgeRuntimeSnapshot(online, ipv4, 7788).ok === true,
    verifyBridgeRuntimeSnapshot(online, ipv6, 7788).ok === true,
    verifyBridgeRuntimeSnapshot(offline, ipv4, 7788).reason === "PM2_BRIDGE_NOT_ONLINE",
    verifyBridgeRuntimeSnapshot("[]", ipv4, 7788).reason === "PM2_BRIDGE_COUNT_INVALID",
    verifyBridgeRuntimeSnapshot(online, wrongOwner, 7788).reason === "BRIDGE_PORT_NOT_LISTENING",
    verifyBridgeRuntimeSnapshot(online, hiddenOwner, 7788).reason === "BRIDGE_PORT_NOT_LISTENING",
    verifyBridgeRuntimeSnapshot(online, wrongListener, 7788).reason === "BRIDGE_PORT_NOT_LISTENING",
    verifyBridgeRuntimeSnapshot(wrongConfiguredPort, ipv4, 7788).reason === "PM2_BRIDGE_PORT_MISMATCH",
  ];
  if (cases.some((passed) => !passed)) throw new Error("hr bridge runtime selftest failed");
  console.log(`hr bridge runtime selftest: ${cases.length}/${cases.length} passed`);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyLive().catch((error) => {
    console.error(`hr bridge runtime gate: failed (${error instanceof Error ? error.message : "UNKNOWN"})`);
    process.exitCode = 1;
  });
}
