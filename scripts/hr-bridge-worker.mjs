#!/usr/bin/env node

/**
 * Legacy continuity bootstrap.
 *
 * Keep this mutable path compatible until every existing VPS has adopted an
 * immutable baseline. Normal deployment never starts this file; the one-time
 * adopter moves PM2 to a release-local bootstrap before pulling this checkout.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import Module, { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import policy from "./hr-bridge-runtime-policy.cjs";

const bootId = randomUUID();
const bootStartedAt = Date.now();
const preflightOnly = process.argv.includes("--preflight");
const artifactPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "hr-bridge-worker.cjs",
);

const allowed = new Set(policy.allowedEnvironmentKeys);
const managedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => allowed.has(key) && typeof value === "string",
  ),
);
managedEnvironment.NODE_ENV = "production";
managedEnvironment.TZ = "UTC";
managedEnvironment.HR_BRIDGE_LOAD_DOTENV = "0";
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, managedEnvironment);

function checkpoint(phase, details = {}) {
  process.stdout.write(
    `${JSON.stringify({
      phase,
      bootId,
      pid: process.pid,
      elapsedMs: Date.now() - bootStartedAt,
      ...details,
    })}\n`,
  );
}

checkpoint("HR_BRIDGE_BOOT", {
  mode: preflightOnly ? "preflight" : "legacy-runtime",
});

const startupWatchdog = setTimeout(() => {
  checkpoint("HR_BRIDGE_STARTUP_TIMEOUT", {
    timeoutMs: policy.startupTimeoutMs,
  });
  process.exit(1);
}, policy.startupTimeoutMs);

try {
  const builtins = new Set(
    builtinModules.flatMap((name) => [name, `node:${name.replace(/^node:/, "")}`]),
  );
  const originalLoad = Module._load;
  Module._load = function guardedLegacyNativeLoad(request, parent, isMain) {
    if (path.resolve(String(request)) !== artifactPath && !builtins.has(request)) {
      throw new Error("HR_BRIDGE_EXTERNAL_RUNTIME_REQUIRE_BLOCKED");
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const workerModule = await import(pathToFileURL(artifactPath).href);
  const runHrBridgeWorker =
    workerModule.runHrBridgeWorker ?? workerModule.default?.runHrBridgeWorker;
  if (typeof runHrBridgeWorker !== "function") {
    throw new Error("HR_BRIDGE_ARTIFACT_EXPORT_INVALID");
  }
  checkpoint("HR_BRIDGE_MODULES_LOADED");
  const result = await runHrBridgeWorker({
    bootId,
    preflightOnly,
    databaseTimeoutMs: policy.databaseReadinessTimeoutMs,
    listenTimeoutMs: policy.tcpListenTimeoutMs,
    shutdownTimeoutMs: policy.shutdownTimeoutMs,
    onReady: () => {
      if (typeof process.send === "function") process.send("ready");
      checkpoint("HR_BRIDGE_READY_SENT");
    },
  });
  clearTimeout(startupWatchdog);
  // Legacy ecosystem definitions used stop_exit_codes:[0]. Keep continuity
  // compatible; immutable release-local PM2 definitions alone use exit 78.
  if (result === "disabled") process.exit(0);
  if (result !== "running") process.exit(0);
} catch (error) {
  clearTimeout(startupWatchdog);
  checkpoint("HR_BRIDGE_STARTUP_FAILED", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
