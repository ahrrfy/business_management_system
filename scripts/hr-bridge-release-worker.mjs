#!/usr/bin/env node

/**
 * Bootstrap إنتاجي صغير لجسر الحضور.
 *
 * يبدأ الـwatchdog قبل تحميل الحزمة كي يغطي تعليق الاستيراد غير المتزامن، ثم يحمّل
 * JavaScript مبنياً مسبقاً. التعليق المتزامن يمسكه verifier الخارجي (PM2+TCP).
 * لا يُشغَّل TypeScript أو tsx داخل عملية الإنتاج.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import Module, { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const bootId = randomUUID();
const bootStartedAt = Date.now();
const preflightOnly = process.argv.includes("--preflight");
const artifactSmoke = process.argv.includes("--artifact-smoke");
const nativeRequireSelftest = process.argv.includes(
  "--native-require-selftest",
);
const bootstrapPath = fileURLToPath(import.meta.url);
const bootstrapDirectory = path.dirname(bootstrapPath);
const releaseManifestPath = path.join(
  bootstrapDirectory,
  "hr-bridge-release.json",
);
const releaseLayout = existsSync(releaseManifestPath);
if (!releaseLayout && !artifactSmoke) {
  throw new Error("HR_BRIDGE_MUTABLE_SOURCE_RUNTIME_FORBIDDEN");
}
const projectRoot = releaseLayout
  ? path.resolve(bootstrapDirectory, "..", "..", "..", "..")
  : path.resolve(bootstrapDirectory, "..");
const artifactPath = releaseLayout
  ? path.join(bootstrapDirectory, "hr-bridge-worker.cjs")
  : path.join(projectRoot, "dist", "hr-bridge-worker.cjs");
const policyPath = releaseLayout
  ? path.join(bootstrapDirectory, "hr-bridge-runtime-policy.cjs")
  : path.join(projectRoot, "scripts", "hr-bridge-runtime-policy.cjs");
const modePath = releaseLayout
  ? path.join(bootstrapDirectory, "hr-bridge-mode.cjs")
  : path.join(projectRoot, "scripts", "hr-bridge-mode.cjs");
const pm2AppPath = releaseLayout
  ? path.join(bootstrapDirectory, "hr-bridge-pm2-app.cjs")
  : path.join(projectRoot, "scripts", "hr-bridge-pm2-app.cjs");
const pm2ConfigPath = releaseLayout
  ? path.join(bootstrapDirectory, "hr-bridge-pm2.config.cjs")
  : path.join(projectRoot, "scripts", "hr-bridge-pm2.config.cjs");
const environmentPath = releaseLayout
  ? path.join(bootstrapDirectory, "hr-bridge-environment.json")
  : null;

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertRegularFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("HR_BRIDGE_RELEASE_FILE_INVALID");
  }
}

let releaseId = null;
if (releaseLayout) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  } catch {
    throw new Error("HR_BRIDGE_RELEASE_MANIFEST_INVALID");
  }
  releaseId = path.basename(bootstrapDirectory);
  if (
    manifest?.version !== 2 ||
    manifest?.id !== releaseId ||
    !/^[a-f0-9]{64}$/.test(releaseId) ||
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(["createdAt", "files", "id", "sourceCommit", "version"]) ||
    JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !==
      JSON.stringify([
        "artifact",
        "bootstrap",
        "environment",
        "mode",
        "pm2App",
        "pm2Config",
        "policy",
      ]) ||
    (manifest.sourceCommit !== null &&
      (typeof manifest.sourceCommit !== "string" ||
        !/^[a-f0-9]{40}$/.test(manifest.sourceCommit))) ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    throw new Error("HR_BRIDGE_RELEASE_MANIFEST_INVALID");
  }
  const files = {
    bootstrap: bootstrapPath,
    policy: policyPath,
    mode: modePath,
    pm2App: pm2AppPath,
    pm2Config: pm2ConfigPath,
    artifact: artifactPath,
    environment: environmentPath,
  };
  const hashes = {};
  for (const [key, file] of Object.entries(files)) {
    assertRegularFile(file);
    hashes[key] = hashFile(file);
    if (manifest.files?.[key] !== hashes[key]) {
      throw new Error("HR_BRIDGE_RELEASE_HASH_MISMATCH");
    }
  }
  const stable = Object.keys(files)
    .sort()
    .map((key) => `${key}:${hashes[key]}`)
    .join("\n");
  if (createHash("sha256").update(stable).digest("hex") !== releaseId) {
    throw new Error("HR_BRIDGE_RELEASE_ID_MISMATCH");
  }
  if (
    !preflightOnly &&
    process.env.HR_BRIDGE_RELEASE_ID !== releaseId
  ) {
    throw new Error("HR_BRIDGE_RELEASE_RUNTIME_MARKER_INVALID");
  }
} else {
  assertRegularFile(artifactPath);
  assertRegularFile(policyPath);
  assertRegularFile(modePath);
  assertRegularFile(pm2AppPath);
  assertRegularFile(pm2ConfigPath);
}

const { default: policy } = await import(pathToFileURL(policyPath).href);
const { default: modeModule } = await import(pathToFileURL(modePath).href);
const { deriveHrBridgeMode } = modeModule;
const allowedEnvironmentKeys = new Set(policy.allowedEnvironmentKeys);

function pickAllowedEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => allowedEnvironmentKeys.has(key) && value !== undefined,
    ),
  );
}

function replaceProcessEnvironment(next) {
  const previousCount = Object.keys(process.env).length;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
  return Math.max(0, previousCount - Object.keys(next).length);
}

function readReleaseEnvironment() {
  if (
    process.platform !== "win32" &&
    (lstatSync(environmentPath).mode & 0o777) !== 0o600
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_PERMISSIONS_INVALID");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(environmentPath, "utf8"));
  } catch {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  }
  const allowed = new Set(policy.allowedEnvironmentKeys);
  if (
    snapshot?.version !== 1 ||
    snapshot?.values == null ||
    typeof snapshot.values !== "object" ||
    Array.isArray(snapshot.values) ||
    Object.entries(snapshot.values).some(
      ([key, value]) => !allowed.has(key) || typeof value !== "string",
    ) ||
    snapshot.values.NODE_ENV !== "production" ||
    snapshot.values.TZ !== "UTC" ||
    snapshot.values.HR_BRIDGE_LOAD_DOTENV !== "0"
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  }
  const canonicalValues = Object.fromEntries(
    Object.entries(snapshot.values).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  if (
    readFileSync(environmentPath, "utf8") !==
    `${JSON.stringify({ version: 1, values: canonicalValues })}\n`
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  }
  return snapshot.values;
}

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

checkpoint("HR_BRIDGE_BOOT", { mode: preflightOnly ? "preflight" : "runtime" });

// يجب أن يبقى referenced كي يقتل import/startup غير المتزامن إذا لم يكتمل.
const startupWatchdog = setTimeout(() => {
  checkpoint("HR_BRIDGE_STARTUP_TIMEOUT", {
    timeoutMs: policy.startupTimeoutMs,
  });
  process.exit(1);
}, policy.startupTimeoutMs);

try {
  let expectedReleaseMode = null;
  if (releaseLayout) {
    const releaseEnvironment = readReleaseEnvironment();
    expectedReleaseMode = deriveHrBridgeMode(releaseEnvironment).mode;
    const removedKeyCount = replaceProcessEnvironment(releaseEnvironment);
    checkpoint("HR_BRIDGE_ENV_SANITIZED", { removedKeyCount });
  } else if (preflightOnly || artifactSmoke) {
    // الإنتاج وPM2 يقرآن ملف المشروع نفسه كمصدر حتمي. artifact-smoke وحده يستخدم
    // القالب ويسمح بقيم fixture من الأب؛ لا توجد production override لمسار الملف.
    const { config } = await import("dotenv");
    const originalEnvironment = pickAllowedEnvironment(process.env);
    const fileEnvironment = {};
    const envResult = config({
      path: path.join(projectRoot, ".env.example"),
      processEnv: fileEnvironment,
      quiet: true,
    });
    if (envResult.error) throw new Error("HR_BRIDGE_ENV_FILE_NOT_READABLE");
    const removedKeyCount = replaceProcessEnvironment({
      ...pickAllowedEnvironment(fileEnvironment),
      ...originalEnvironment,
      // Artifact smoke must exercise the exact production logger/runtime path;
      // development transports spawn extra worker assets by design.
      NODE_ENV: "production",
      TZ: "UTC",
    });
    checkpoint("HR_BRIDGE_ENV_SANITIZED", { removedKeyCount });
    expectedReleaseMode = deriveHrBridgeMode(process.env).mode;
  } else {
    if (process.env.HR_BRIDGE_LOAD_DOTENV !== "0") {
      throw new Error("HR_BRIDGE_MANAGED_ENVIRONMENT_REQUIRED");
    }

    // PM2 injects process metadata in addition to app.env. Strip every key that
    // is not part of the bridge's positive allowlist before importing application
    // code, so an inherited shell secret is never visible to the worker graph.
    const removedKeyCount = replaceProcessEnvironment(
      pickAllowedEnvironment(process.env),
    );
    checkpoint("HR_BRIDGE_ENV_SANITIZED", { removedKeyCount });
  }

  const allowedNativeModules = new Set(
    builtinModules.flatMap((name) => [
      name,
      `node:${name.replace(/^node:/, "")}`,
    ]),
  );
  const originalNativeLoad = Module._load;
  Module._load = function guardedHrBridgeNativeLoad(
    request,
    parent,
    isMain,
  ) {
    if (
      path.resolve(String(request)) !== path.resolve(artifactPath) &&
      !allowedNativeModules.has(request)
    ) {
      throw new Error("HR_BRIDGE_EXTERNAL_RUNTIME_REQUIRE_BLOCKED");
    }
    return originalNativeLoad.call(this, request, parent, isMain);
  };
  if (nativeRequireSelftest) {
    let blocked = 0;
    for (const request of [
      "cardinal",
      "bufferutil",
      "utf-8-validate",
      "supports-color",
    ]) {
      try {
        Module._load(request, undefined, false);
      } catch (error) {
        if (error?.message === "HR_BRIDGE_EXTERNAL_RUNTIME_REQUIRE_BLOCKED") {
          blocked += 1;
        }
      }
    }
    if (blocked !== 4) throw new Error("HR_BRIDGE_NATIVE_REQUIRE_GUARD_FAILED");
    clearTimeout(startupWatchdog);
    checkpoint("HR_BRIDGE_NATIVE_REQUIRE_GUARD_OK", { blockedCount: blocked });
    process.exit(0);
  }

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

  if (
    (expectedReleaseMode === "disabled" && result !== "disabled") ||
    (expectedReleaseMode === "enabled" && result === "disabled")
  ) {
    throw new Error("HR_BRIDGE_RELEASE_MODE_RESULT_MISMATCH");
  }

  clearTimeout(startupWatchdog);
  if (result === "disabled") process.exit(policy.disabledExitCode);
  if (result !== "running") process.exit(0);
} catch (error) {
  clearTimeout(startupWatchdog);
  checkpoint("HR_BRIDGE_STARTUP_FAILED", {
    error: error instanceof Error ? error.message : String(error),
  });
  // الخروج القسري مقصود: قد تكون عملية DB المعلّقة ما زالت تمسك event loop.
  process.exit(1);
}
