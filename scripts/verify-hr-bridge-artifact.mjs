#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import policy from "./hr-bridge-runtime-policy.cjs";
import releaseTools from "./hr-bridge-release.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, "dist", "hr-bridge-worker.cjs");
const artifactMetafile = path.join(root, "dist", "hr-bridge-worker.meta.json");
const bootstrap = path.join(root, "scripts", "hr-bridge-release-worker.mjs");

if (!fs.existsSync(artifact) || fs.statSync(artifact).size < 1_024) {
  throw new Error("HR_BRIDGE_ARTIFACT_MISSING_OR_EMPTY");
}
let buildMetadata;
try {
  buildMetadata = JSON.parse(fs.readFileSync(artifactMetafile, "utf8"));
} catch {
  throw new Error("HR_BRIDGE_ARTIFACT_METAFILE_INVALID");
}
const artifactOutput = Object.entries(buildMetadata.outputs ?? {}).find(
  ([name]) => path.resolve(root, name) === artifact,
)?.[1];
const builtinSpecifiers = new Set(
  builtinModules.flatMap((name) => [
    name,
    `node:${name.replace(/^node:/, "")}`,
  ]),
);
const unsupportedExternals = (artifactOutput?.imports ?? []).filter(
  (entry) => entry.external && !builtinSpecifiers.has(String(entry.path)),
);
if (!artifactOutput || unsupportedExternals.length > 0) {
  throw new Error("HR_BRIDGE_ARTIFACT_NOT_SELF_CONTAINED");
}

const builtSource = fs.readFileSync(artifact, "utf8");
if (builtSource.includes("tsx/esm/api") || builtSource.includes("tsImport(")) {
  throw new Error("HR_BRIDGE_ARTIFACT_USES_RUNTIME_TYPESCRIPT");
}
if (
  /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'][^"']+\.(?:[cm]?ts|tsx)["']/.test(
    builtSource,
  )
) {
  throw new Error("HR_BRIDGE_ARTIFACT_IMPORTS_TYPESCRIPT_SOURCE");
}
if (
  /(?:__require|require)\(\s*["'](?:bufferutil|utf-8-validate|supports-color|cardinal)["']\s*\)/.test(
    builtSource,
  )
) {
  throw new Error("HR_BRIDGE_ARTIFACT_HAS_MUTABLE_OPTIONAL_REQUIRE");
}

const bootstrapSource = fs.readFileSync(bootstrap, "utf8");
if (
  bootstrapSource.includes("tsx/esm/api") ||
  bootstrapSource.includes("tsImport(")
) {
  throw new Error("HR_BRIDGE_BOOTSTRAP_USES_RUNTIME_TYPESCRIPT");
}
if (
  !bootstrapSource.includes(
    'path.join(projectRoot, "dist", "hr-bridge-worker.cjs")',
  ) ||
  bootstrapSource.includes("process.env.HR_BRIDGE_ARTIFACT_PATH") ||
  !bootstrapSource.includes("pathToFileURL(artifactPath)") ||
  !bootstrapSource.includes("HR_BRIDGE_ENV_SANITIZED") ||
  !bootstrapSource.includes('"hr-bridge-worker.cjs"') ||
  !bootstrapSource.includes('"hr-bridge-pm2.config.cjs"') ||
  !bootstrapSource.includes('"hr-bridge-environment.json"') ||
  !bootstrapSource.includes('"hr-bridge-mode.cjs"') ||
  !bootstrapSource.includes("HR_BRIDGE_EXTERNAL_RUNTIME_REQUIRE_BLOCKED") ||
  !bootstrapSource.includes("Module._load") ||
  !bootstrapSource.includes("hr-bridge-release.json") ||
  !bootstrapSource.includes("HR_BRIDGE_RELEASE_HASH_MISMATCH")
) {
  throw new Error("HR_BRIDGE_BOOTSTRAP_ARTIFACT_PATH_INVALID");
}

const require = createRequire(import.meta.url);
const ecosystemPath = path.join(root, "ecosystem.config.cjs");
const previousEcosystemSmoke = process.env.HR_BRIDGE_ECOSYSTEM_ARTIFACT_SMOKE;
process.env.HR_BRIDGE_ECOSYSTEM_ARTIFACT_SMOKE = "1";
const ecosystem = require(ecosystemPath);
if (previousEcosystemSmoke === undefined)
  delete process.env.HR_BRIDGE_ECOSYSTEM_ARTIFACT_SMOKE;
else process.env.HR_BRIDGE_ECOSYSTEM_ARTIFACT_SMOKE = previousEcosystemSmoke;
const matchingApps =
  ecosystem.apps?.filter((candidate) => candidate.name === "erp-hr-bridge") ??
  [];
const app = matchingApps[0];
if (
  matchingApps.length !== 1 ||
  app?.script !== "scripts/hr-bridge-release-worker.mjs" ||
  app.instances !== 1 ||
  app.exec_mode !== "fork" ||
  app.autorestart !== true ||
  JSON.stringify(app.stop_exit_codes) !==
    JSON.stringify([policy.disabledExitCode]) ||
  app.wait_ready !== true ||
  app.listen_timeout !== policy.pm2ListenTimeoutMs ||
  policy.startupTimeoutMs >= app.listen_timeout ||
  app.min_uptime !== policy.minUptimeMs ||
  app.kill_timeout !== policy.pm2KillTimeoutMs ||
  app.max_restarts < 1 ||
  app.exp_backoff_restart_delay < 1
) {
  throw new Error("HR_BRIDGE_PM2_READINESS_POLICY_INVALID");
}
delete require.cache[require.resolve(ecosystemPath)];
const productionEcosystem = require(ecosystemPath);
delete require.cache[require.resolve(ecosystemPath)];
if (
  productionEcosystem.apps?.some(
    (candidate) => candidate.name === "erp-hr-bridge",
  )
) {
  throw new Error("HR_BRIDGE_MUTABLE_ECOSYSTEM_BYPASS");
}
if (
  !Array.isArray(app.filter_env) ||
  JSON.stringify(app.filter_env) !== JSON.stringify([""])
) {
  throw new Error("HR_BRIDGE_PM2_INHERITED_ENV_FILTER_INVALID");
}

const sourceCommit = (() => {
  try {
    return spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    }).stdout.trim();
  } catch {
    return null;
  }
})();
const releaseFixtureEnvironment = Object.fromEntries(
  Object.entries(app.env).filter(([, value]) => typeof value === "string"),
);
Object.assign(releaseFixtureEnvironment, {
  NODE_ENV: "production",
  TZ: "UTC",
  HR_BRIDGE_LOAD_DOTENV: "0",
  HR_DEVICE_BRIDGE: "0",
  HR_DEVICE_PORT: "",
});

function verifyReleaseFixture(releaseFixtureProjectRoot) {
  const release = releaseTools.prepareRelease(releaseFixtureProjectRoot, {
    sourceCommit,
    sourceRoot: root,
    deploymentEnvironment: releaseFixtureEnvironment,
  });
  releaseTools.validateRelease(releaseFixtureProjectRoot, release.id);

  const parentCanary = "artifact-parent-environment-must-not-win";
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = parentCanary;
  delete require.cache[require.resolve(release.pm2ConfigPath)];
  const releaseEcosystem = require(release.pm2ConfigPath);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  delete require.cache[require.resolve(release.pm2ConfigPath)];
  const releaseApp = releaseEcosystem.apps?.find(
    (candidate) => candidate.name === "erp-hr-bridge",
  );
  if (
    releaseApp?.script !== release.bootstrapPath ||
    releaseApp?.cwd !== releaseFixtureProjectRoot ||
    releaseApp?.wait_ready !== true ||
    releaseApp?.env?.DATABASE_URL === parentCanary ||
    JSON.stringify(releaseApp?.env) !==
      JSON.stringify({
        NODE_ENV: "production",
        TZ: "UTC",
        HR_BRIDGE_LOAD_DOTENV: "0",
        HR_BRIDGE_RELEASE_ID: release.id,
      })
  ) {
    throw new Error("HR_BRIDGE_RELEASE_PM2_DEFINITION_INVALID");
  }
  if (
    Object.keys(app.env).some(
      (key) => !policy.allowedEnvironmentKeys.includes(key),
    ) ||
    app.env.HR_BRIDGE_LOAD_DOTENV !== "0"
  ) {
    throw new Error("HR_BRIDGE_PM2_ENVIRONMENT_ALLOWLIST_INVALID");
  }

  const portableParentKeys = [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
  ];
  const env = Object.fromEntries(
    portableParentKeys
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    NODE_ENV: "production",
    TZ: "UTC",
    HR_BRIDGE_LOAD_DOTENV: "0",
    DATABASE_URL: "",
    CONTROL_DATABASE_URL: "",
    HR_DEVICE_BRIDGE: "0",
    HR_DEVICE_PORT: "",
    HR_DEVICE_IP_ALLOWLIST: "127.0.0.1",
  });

  function smokeFailure(code, result) {
    const phases = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(
      /HR_BRIDGE_[A-Z0-9_:-]+/g,
    );
    return new Error(
      `${code} status=${result.status ?? "none"} ` +
        `signal=${result.signal ?? "none"} phases=${phases?.slice(-8).join(",") ?? "none"}`,
    );
  }

  const startedAt = Date.now();
  const disabledResult = spawnSync(
    process.execPath,
    [bootstrap, "--artifact-smoke"],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );

  if (
    disabledResult.error ||
    disabledResult.status !== policy.disabledExitCode ||
    disabledResult.signal
  ) {
    throw smokeFailure("HR_BRIDGE_ARTIFACT_SMOKE_FAILED", disabledResult);
  }

  // المسار المفعّل بلا DB يجب أن يُكمل تحميل الحزمة ثم يفشل fail-closed، لا أن يعلق.
  const failingPreflight = spawnSync(
    process.execPath,
    [bootstrap, "--preflight", "--artifact-smoke"],
    {
      cwd: root,
      env: {
        ...env,
        // preflight المباشر يجب أن يحمل الملف رغم أن علامة الطفل المُدار = 0.
        HR_DEVICE_BRIDGE: "1",
        HR_DEVICE_PORT: "7788",
      },
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
    throw smokeFailure(
      "HR_BRIDGE_PREFLIGHT_FAIL_CLOSED_SMOKE_FAILED",
      failingPreflight,
    );
  }

  const managedRuntime = spawnSync(
    process.execPath,
    [bootstrap, "--artifact-smoke"],
    {
      cwd: root,
      env: { ...env, HR_DEVICE_BRIDGE: "1", HR_DEVICE_PORT: "7788" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (
    managedRuntime.error ||
    managedRuntime.signal ||
    managedRuntime.status !== 1 ||
    !managedRuntime.stdout.includes("HR_BRIDGE_ENV_SANITIZED") ||
    !managedRuntime.stdout.includes("HR_BRIDGE_ENVIRONMENT_OK") ||
    !managedRuntime.stdout.includes("HR_BRIDGE_STARTUP_FAILED")
  ) {
    throw smokeFailure(
      "HR_BRIDGE_MANAGED_RUNTIME_SMOKE_FAILED",
      managedRuntime,
    );
  }

  const leakedRuntime = spawnSync(
    process.execPath,
    [bootstrap, "--artifact-smoke"],
    {
      cwd: root,
      env: {
        ...env,
        HR_DEVICE_BRIDGE: "1",
        HR_DEVICE_PORT: "7788",
        // Deliberately absent from .env.example: the guard must cover the complete
        // inherited process environment, not only names known to dotenv.
        SHELL_ONLY_SECRET: "artifact-gate-canary-not-a-secret",
      },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (
    leakedRuntime.error ||
    leakedRuntime.signal ||
    leakedRuntime.status !== 1 ||
    !leakedRuntime.stdout.includes("HR_BRIDGE_ENV_SANITIZED") ||
    !leakedRuntime.stdout.includes("HR_BRIDGE_ENVIRONMENT_OK") ||
    leakedRuntime.stdout.includes("HR_BRIDGE_ENVIRONMENT_NOT_ISOLATED") ||
    `${leakedRuntime.stdout}\n${leakedRuntime.stderr}`.includes(
      "artifact-gate-canary-not-a-secret",
    )
  ) {
    throw smokeFailure(
      "HR_BRIDGE_ENVIRONMENT_ISOLATION_SMOKE_FAILED",
      leakedRuntime,
    );
  }

  const releaseRuntimeEnvironment = {
    ...env,
    HR_BRIDGE_RELEASE_ID: release.id,
  };
  for (const marker of [undefined, "0".repeat(64)]) {
    const markerEnvironment = { ...env };
    if (marker !== undefined) markerEnvironment.HR_BRIDGE_RELEASE_ID = marker;
    const markerResult = spawnSync(process.execPath, [release.bootstrapPath], {
      cwd: releaseFixtureProjectRoot,
      env: markerEnvironment,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (
      markerResult.status !== 1 ||
      !`${markerResult.stdout}\n${markerResult.stderr}`.includes(
        "HR_BRIDGE_RELEASE_RUNTIME_MARKER_INVALID",
      )
    ) {
      throw smokeFailure("HR_BRIDGE_RELEASE_MARKER_SMOKE_FAILED", markerResult);
    }
  }

  const releaseDisabled = spawnSync(process.execPath, [release.bootstrapPath], {
    cwd: releaseFixtureProjectRoot,
    env: releaseRuntimeEnvironment,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (
    releaseDisabled.error ||
    releaseDisabled.signal ||
    releaseDisabled.status !== policy.disabledExitCode ||
    !releaseDisabled.stdout.includes("HR_BRIDGE_MODULES_LOADED")
  ) {
    throw smokeFailure("HR_BRIDGE_RELEASE_SMOKE_FAILED", releaseDisabled);
  }

  // Prove dependency closure away from the repository and its node_modules.
  const isolatedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hr-bridge-release-isolated-"),
  );
  const isolatedReleaseDirectory = path.join(
    isolatedRoot,
    ".runtime",
    "hr-bridge",
    "releases",
    release.id,
  );
  fs.mkdirSync(path.dirname(isolatedReleaseDirectory), { recursive: true });
  fs.cpSync(release.directory, isolatedReleaseDirectory, { recursive: true });
  for (const name of [
    "cardinal",
    "bufferutil",
    "utf-8-validate",
    "supports-color",
  ]) {
    const fakeDirectory = path.join(isolatedRoot, "node_modules", name);
    fs.mkdirSync(fakeDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(fakeDirectory, "index.js"),
      'require("node:fs").writeFileSync("mutable-module-loaded", "1");\n',
      "utf8",
    );
  }
  const isolatedBootstrap = path.join(
    isolatedReleaseDirectory,
    path.basename(release.bootstrapPath),
  );
  const isolatedResult = spawnSync(process.execPath, [isolatedBootstrap], {
    cwd: isolatedRoot,
    env: releaseRuntimeEnvironment,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const nativeGuardResult = spawnSync(
    process.execPath,
    [isolatedBootstrap, "--native-require-selftest"],
    {
      cwd: isolatedRoot,
      env: releaseRuntimeEnvironment,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  try {
    if (
      isolatedResult.error ||
      isolatedResult.signal ||
      isolatedResult.status !== policy.disabledExitCode ||
      !isolatedResult.stdout.includes("HR_BRIDGE_MODULES_LOADED")
    ) {
      throw smokeFailure(
        "HR_BRIDGE_RELEASE_ISOLATION_SMOKE_FAILED",
        isolatedResult,
      );
    }
    if (
      nativeGuardResult.error ||
      nativeGuardResult.signal ||
      nativeGuardResult.status !== 0 ||
      !nativeGuardResult.stdout.includes("HR_BRIDGE_NATIVE_REQUIRE_GUARD_OK") ||
      fs.existsSync(path.join(isolatedRoot, "mutable-module-loaded"))
    ) {
      throw smokeFailure(
        "HR_BRIDGE_NATIVE_REQUIRE_GUARD_SMOKE_FAILED",
        nativeGuardResult,
      );
    }
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }

  console.log(
    `hr bridge artifact gate: self-contained release + disabled + preflight + managed-env smokes passed ` +
      `(${Date.now() - startedAt}ms)`,
  );
}

const releaseFixtureProjectRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "hr-bridge-artifact-project-"),
);
try {
  verifyReleaseFixture(releaseFixtureProjectRoot);
} finally {
  fs.rmSync(releaseFixtureProjectRoot, { recursive: true, force: true });
}
