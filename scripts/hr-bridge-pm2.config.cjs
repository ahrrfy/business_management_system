"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const releaseDirectory = __dirname;
const manifestPath = path.join(releaseDirectory, "hr-bridge-release.json");
if (!fs.existsSync(manifestPath)) {
  throw new Error("HR_BRIDGE_RELEASE_PM2_CONFIG_SOURCE_FORBIDDEN");
}

const projectRoot = path.resolve(
  releaseDirectory,
  "..",
  "..",
  "..",
  "..",
);
const policy = require(path.join(
  releaseDirectory,
  "hr-bridge-runtime-policy.cjs",
));
const createHrBridgePm2App = require(path.join(
  releaseDirectory,
  "hr-bridge-pm2-app.cjs",
));
const { deriveHrBridgeMode } = require(path.join(
  releaseDirectory,
  "hr-bridge-mode.cjs",
));
const environmentPath = path.join(
  releaseDirectory,
  "hr-bridge-environment.json",
);
const environmentStat = fs.lstatSync(environmentPath);
if (!environmentStat.isFile() || environmentStat.isSymbolicLink()) {
  throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
}
if (
  process.platform !== "win32" &&
  (environmentStat.mode & 0o777) !== 0o600
) {
  throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_PERMISSIONS_INVALID");
}
let manifest;
let snapshot;
const environmentBytes = fs.readFileSync(environmentPath);
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  snapshot = JSON.parse(environmentBytes.toString("utf8"));
} catch {
  throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
}
const environmentHash = crypto
  .createHash("sha256")
  .update(environmentBytes)
  .digest("hex");
const allowed = new Set(policy.allowedEnvironmentKeys);
if (
  manifest?.version !== 2 ||
  manifest?.id !== path.basename(releaseDirectory) ||
  !/^[a-f0-9]{64}$/.test(manifest.id) ||
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
  manifest?.files?.environment !== environmentHash ||
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
deriveHrBridgeMode(snapshot.values);
const canonicalValues = Object.fromEntries(
  Object.entries(snapshot.values).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  ),
);
if (
  environmentBytes.toString("utf8") !==
  `${JSON.stringify({ version: 1, values: canonicalValues })}\n`
) {
  throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
}
const deploymentEnvironment = Object.freeze({
  NODE_ENV: "production",
  TZ: "UTC",
  HR_BRIDGE_LOAD_DOTENV: "0",
});

module.exports = {
  apps: [
    createHrBridgePm2App({
      projectRoot,
      script: path.join(releaseDirectory, "hr-bridge-worker.mjs"),
      policy,
      deploymentEnvironment,
      releaseId: manifest.id,
    }),
  ],
};
