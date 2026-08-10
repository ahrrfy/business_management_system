#!/usr/bin/env node

/**
 * One-time bridge adopter.
 *
 * Run this controller from a detached, built worktree containing the new
 * release machinery while --project-root still points at the untouched legacy
 * checkout. The legacy checkout is deliberately never pulled by this script.
 */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import releaseTools from "./hr-bridge-release.cjs";
import activation from "./hr-bridge-activation.cjs";
import sourcePolicy from "./hr-bridge-runtime-policy.cjs";

const CONTROLLER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BRIDGE_NAME = "erp-hr-bridge";

function fail(code) {
  throw new Error(code);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: options.env ?? process.env,
  });
}

function capture(command, args, cwd, timeoutMs = 10_000) {
  return String(
    run(command, args, { cwd, capture: true, timeoutMs }),
  ).trim();
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function controlSubprocessEnvironment() {
  const keys = [
    "HOME",
    "PM2_HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
}

function parseProjectRoot() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--project-root") {
    fail("HR_BRIDGE_ADOPTION_ARGUMENTS_INVALID");
  }
  return path.resolve(args[1]);
}

function assertIdentity(projectRoot) {
  if (process.platform !== "linux") fail("DEPLOY_PLATFORM_UNSUPPORTED");
  const account = userInfo();
  if (
    process.getuid?.() === 0 ||
    account.username !== "deploy" ||
    path.resolve(process.env.HOME || "") !== path.resolve(account.homedir) ||
    path.resolve(
      process.env.PM2_HOME || path.join(process.env.HOME || "", ".pm2"),
    ) !== path.resolve(account.homedir, ".pm2") ||
    projectRoot === CONTROLLER_ROOT
  ) {
    fail("HR_BRIDGE_ADOPTION_IDENTITY_OR_LAYOUT_INVALID");
  }
}

function assertPm2Version(expectedVersion) {
  const launcher = fs.realpathSync(capture("which", ["pm2"], CONTROLLER_ROOT));
  let packageRoot = path.dirname(launcher);
  while (true) {
    const packageFile = path.join(packageRoot, "package.json");
    if (fs.existsSync(packageFile)) {
      const candidate = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      if (candidate?.name === "pm2") break;
    }
    const parent = path.dirname(packageRoot);
    if (parent === packageRoot) fail("PM2_PACKAGE_NOT_RESOLVED");
    packageRoot = parent;
  }
  const cliOutput = capture("pm2", ["--version"], CONTROLLER_ROOT);
  const cliVersion = cliOutput.match(/\b\d+\.\d+\.\d+\b/g)?.at(-1);
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ).version;
  const probe = String.raw`
const pm2 = require(process.argv[1]);
const fail = () => { try { pm2.disconnect(); } catch {} process.exit(1); };
pm2.connect((connectError) => {
  if (connectError) return fail();
  pm2.getVersion((versionError, version) => {
    if (versionError) return fail();
    pm2.disconnect();
    process.stdout.write(String(version));
  });
});`;
  const result = spawnSync(process.execPath, ["-e", probe, packageRoot], {
    cwd: CONTROLLER_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  const daemonVersion = result.stdout
    ?.match(/\b\d+\.\d+\.\d+\b/g)
    ?.at(-1);
  if (
    result.error ||
    result.status !== 0 ||
    cliVersion !== expectedVersion ||
    packageVersion !== expectedVersion ||
    daemonVersion !== expectedVersion
  ) {
    fail("PM2_VERSION_UNSUPPORTED");
  }
}

function gitHead(root) {
  const top = path.resolve(capture("git", ["rev-parse", "--show-toplevel"], root));
  const branch = capture(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    root,
  );
  const dirty = capture(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    root,
  );
  const dirtyLines = dirty ? dirty.split(/\r?\n/) : [];
  const onlyManagedRuntime =
    dirtyLines.length === 1 && dirtyLines[0] === "?? .runtime/";
  if (onlyManagedRuntime) {
    const runtime = path.join(root, ".runtime");
    const stat = fs.lstatSync(runtime);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      JSON.stringify(fs.readdirSync(runtime).sort()) !==
        JSON.stringify(["hr-bridge"])
    ) {
      fail("HR_BRIDGE_ADOPTION_MANAGED_RUNTIME_INVALID");
    }
  }
  if (
    top !== root ||
    branch !== "main" ||
    (dirty && !onlyManagedRuntime)
  ) {
    fail("HR_BRIDGE_ADOPTION_LEGACY_CHECKOUT_INVALID");
  }
  return capture("git", ["rev-parse", "HEAD"], root);
}

function assertControllerCheckout() {
  const top = path.resolve(
    capture("git", ["rev-parse", "--show-toplevel"], CONTROLLER_ROOT),
  );
  const head = capture("git", ["rev-parse", "HEAD"], CONTROLLER_ROOT);
  const remote = capture(
    "git",
    ["rev-parse", "refs/remotes/origin/main"],
    CONTROLLER_ROOT,
  );
  const dirty = capture(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no"],
    CONTROLLER_ROOT,
  );
  if (top !== CONTROLLER_ROOT || head !== remote || dirty) {
    fail("HR_BRIDGE_ADOPTION_CONTROLLER_CHECKOUT_INVALID");
  }
  return head;
}

function hashFile(file, code) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    fail(code);
  }
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function loadLegacyDefinition(projectRoot) {
  const ecosystemPath = path.join(projectRoot, "ecosystem.config.cjs");
  const probe = String.raw`
const crypto = require("node:crypto");
const path = require("node:path");
const root = path.resolve(process.argv[1]);
const file = path.resolve(process.argv[2]);
const apps = require(file)?.apps;
const matches = Array.isArray(apps) ? apps.filter((app) => app?.name === "erp-hr-bridge") : [];
if (matches.length !== 1) process.exit(2);
const app = matches[0];
const cwd = path.resolve(app.cwd || root);
const executable = path.resolve(cwd, String(app.script || ""));
const entries = Object.entries(app.env || {})
  .filter(([, value]) => value !== undefined)
  .map(([key, value]) => [key, String(value)])
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
const environmentHash = crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
const contract = {
  executable,
  cwd,
  environmentKeys: entries.map(([key]) => key),
  environmentHash,
  instances: Number(app.instances ?? 1),
  execMode: String(app.exec_mode || "fork").replace(/_mode$/, ""),
  autorestart: app.autorestart !== false,
  waitReady: app.wait_ready === true,
  listenTimeout: Number(app.listen_timeout || 0),
  killTimeout: Number(app.kill_timeout || 0),
  stopExitCodes: Array.isArray(app.stop_exit_codes) ? app.stop_exit_codes : [],
  maxRestarts: Number(app.max_restarts || 0),
  minUptime: Number(app.min_uptime || 0),
  backoff: Number(app.exp_backoff_restart_delay || 0),
};
const definitionHash = crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex");
process.stdout.write(JSON.stringify({ ...contract, definitionHash }));`;
  const result = spawnSync(
    process.execPath,
    ["-e", probe, projectRoot, ecosystemPath],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: controlSubprocessEnvironment(),
    },
  );
  if (result.error || result.status !== 0) {
    fail("HR_BRIDGE_LEGACY_RESTORE_DEFINITION_INVALID");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("HR_BRIDGE_LEGACY_RESTORE_DEFINITION_INVALID");
  }
}

function environmentProjectionHash(environment, keys) {
  const entries = keys
    .map((key) => [key, environment?.[key]])
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function assertLegacyDefinition(projectRoot, legacy, row = null) {
  const ecosystemPath = path.join(projectRoot, "ecosystem.config.cjs");
  const environmentPath = path.join(projectRoot, ".env");
  const ecosystemHash = hashFile(
    ecosystemPath,
    "HR_BRIDGE_LEGACY_RESTORE_SOURCE_INVALID",
  );
  const environmentHash = hashFile(
    environmentPath,
    "HR_BRIDGE_LEGACY_RESTORE_SOURCE_INVALID",
  );
  const definition = loadLegacyDefinition(projectRoot);
  if (
    definition.executable !== legacy.executable ||
    definition.cwd !== projectRoot ||
    (legacy.ecosystemHash && legacy.ecosystemHash !== ecosystemHash) ||
    (legacy.environmentFileHash &&
      legacy.environmentFileHash !== environmentHash) ||
    (legacy.definitionHash && legacy.definitionHash !== definition.definitionHash)
  ) {
    fail("HR_BRIDGE_LEGACY_RESTORE_SOURCE_CHANGED");
  }
  if (row) {
    const pm2Env = row.pm2_env ?? row;
    const liveEnvironment = pm2Env.env ?? row.env;
    const liveMode = String(pm2Env.exec_mode || "fork").replace(/_mode$/, "");
    if (
      environmentProjectionHash(
        liveEnvironment,
        definition.environmentKeys,
      ) !== definition.environmentHash ||
      Number(pm2Env.instances ?? 1) !== definition.instances ||
      liveMode !== definition.execMode ||
      Boolean(pm2Env.autorestart) !== definition.autorestart ||
      Boolean(pm2Env.wait_ready) !== definition.waitReady ||
      Number(pm2Env.listen_timeout || 0) !== definition.listenTimeout ||
      Number(pm2Env.kill_timeout || 0) !== definition.killTimeout ||
      JSON.stringify(pm2Env.stop_exit_codes ?? []) !==
        JSON.stringify(definition.stopExitCodes) ||
      Number(pm2Env.max_restarts || 0) !== definition.maxRestarts ||
      Number(pm2Env.min_uptime || 0) !== definition.minUptime ||
      Number(pm2Env.exp_backoff_restart_delay || 0) !== definition.backoff
    ) {
      fail("HR_BRIDGE_LEGACY_LIVE_DEFINITION_MISMATCH");
    }
  }
  return {
    ecosystemHash,
    environmentFileHash: environmentHash,
    definitionHash: definition.definitionHash,
  };
}

function pm2Rows(projectRoot) {
  const rows = JSON.parse(capture("pm2", ["jlist"], projectRoot));
  if (!Array.isArray(rows)) fail("PM2_JSON_INVALID");
  return rows;
}

function bridgeRows(projectRoot) {
  return pm2Rows(projectRoot).filter((row) => row?.name === BRIDGE_NAME);
}

function socketOutput(projectRoot) {
  return capture("ss", ["-H", "-ltnp"], projectRoot);
}

function listenerOwnedBy(socketText, port, pid) {
  return socketText.split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return (
      fields[0] === "LISTEN" &&
      Number(fields[3]?.match(/:(\d+)$/)?.[1]) === port &&
      (fields.slice(5).join(" ").includes(`pid=${pid},`) ||
        fields.slice(5).join(" ").includes(`pid=${pid})`))
    );
  });
}

function classifyLegacy(projectRoot, legacy) {
  let stable = 0;
  let stableHealth = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = bridgeRows(projectRoot);
    const row = rows[0];
    const pid = Number(row?.pid);
    const validShape =
      rows.length === 1 &&
      row?.pm2_env?.status === "online" &&
      path.resolve(row?.pm2_env?.pm_exec_path || "") === legacy.executable &&
      path.resolve(row?.pm2_env?.pm_cwd || "") === projectRoot &&
      Number.isInteger(pid) &&
      pid > 0;
    if (!validShape) {
      stable = 0;
      stableHealth = null;
      sleep(1_000);
      continue;
    }
    const health = listenerOwnedBy(
      socketOutput(projectRoot),
      legacy.port,
      pid,
    )
      ? "healthy"
      : "unhealthy";
    if (health === stableHealth) stable += 1;
    else {
      stableHealth = health;
      stable = 1;
    }
    if (stable >= 3) return health;
    sleep(1_000);
  }
  fail("HR_BRIDGE_LEGACY_RUNTIME_NOT_RESTORABLE");
}

function verifyLegacy(projectRoot, legacy) {
  const observed = classifyLegacy(projectRoot, legacy);
  if (legacy.health === "healthy" && observed !== "healthy") {
    fail("HR_BRIDGE_HEALTHY_LEGACY_DEGRADED");
  }
  return observed;
}

function stopBridge(projectRoot) {
  const matches = bridgeRows(projectRoot);
  const killTimeoutMs = Math.max(
    sourcePolicy.pm2KillTimeoutMs,
    ...matches.map((row) => Number(row?.pm2_env?.kill_timeout) || 0),
  );
  for (const row of matches) {
    const id = Number(row?.pm_id);
    if (!Number.isInteger(id) || id < 0) fail("PM2_BRIDGE_ID_INVALID");
    run("pm2", ["delete", String(id)], {
      cwd: projectRoot,
      timeoutMs: killTimeoutMs + 15_000,
    });
  }
  const deadline = Date.now() + killTimeoutMs + 10_000;
  while (Date.now() < deadline) {
    if (bridgeRows(projectRoot).length === 0) return;
    sleep(250);
  }
  fail("PM2_BRIDGE_DELETE_TIMEOUT");
}

function fsyncPm2Dump(projectRoot, expected) {
  run("pm2", ["save"], { cwd: projectRoot, timeoutMs: 30_000 });
  const pm2Home = path.resolve(
    process.env.PM2_HOME || path.join(process.env.HOME, ".pm2"),
  );
  for (const target of [path.join(pm2Home, "dump.pm2"), pm2Home]) {
    const fd = fs.openSync(target, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const rows = JSON.parse(
    fs.readFileSync(path.join(pm2Home, "dump.pm2"), "utf8"),
  );
  const matches = Array.isArray(rows)
    ? rows.filter((row) => row?.name === BRIDGE_NAME)
    : [];
  if (expected.mode === "disabled") {
    if (matches.length !== 0) {
      fail("HR_BRIDGE_ADOPTION_PM2_DUMP_MISMATCH");
    }
    return;
  }
  if (
    matches.length !== 1 ||
    path.resolve(matches[0]?.pm_exec_path || "") !== expected.executable ||
    path.resolve(matches[0]?.pm_cwd || "") !== projectRoot
  ) {
    fail("HR_BRIDGE_ADOPTION_PM2_DUMP_MISMATCH");
  }
  if (expected.releaseId) {
    const environment = matches[0]?.env;
    const expectedEnvironment = {
      NODE_ENV: "production",
      TZ: "UTC",
      HR_BRIDGE_LOAD_DOTENV: "0",
      HR_BRIDGE_RELEASE_ID: expected.releaseId,
    };
    const allowedMetadata = new Set(
      sourcePolicy.pm2EnvironmentMetadataKeys,
    );
    if (
      !environment ||
      Object.entries(expectedEnvironment).some(
        ([key, value]) => String(environment[key]) !== value,
      ) ||
      Object.keys(environment).some(
        (key) =>
          !Object.hasOwn(expectedEnvironment, key) &&
          !allowedMetadata.has(key),
      ) ||
      !["fork", "fork_mode"].includes(matches[0]?.exec_mode) ||
      Number(matches[0]?.instances ?? 1) !== 1 ||
      matches[0]?.autorestart !== true ||
      matches[0]?.wait_ready !== true ||
      Number(matches[0]?.listen_timeout) !==
        sourcePolicy.pm2ListenTimeoutMs ||
      Number(matches[0]?.kill_timeout) !== sourcePolicy.pm2KillTimeoutMs ||
      JSON.stringify(matches[0]?.stop_exit_codes) !==
        JSON.stringify([sourcePolicy.disabledExitCode]) ||
      Number(matches[0]?.max_restarts) !== 10 ||
      Number(matches[0]?.min_uptime) !== sourcePolicy.minUptimeMs ||
      Number(matches[0]?.exp_backoff_restart_delay) !== 3000
    ) {
      fail("HR_BRIDGE_ADOPTION_PM2_DUMP_MISMATCH");
    }
  } else if (expected.definitionHash) {
    assertLegacyDefinition(projectRoot, expected, matches[0]);
  }
}

function createExpectedDumpContext(legacy, candidateRuntime) {
  let expected = legacy;
  return Object.freeze({
    useCandidate(descriptor) {
      expected =
        descriptor?.mode === "disabled"
          ? { mode: "disabled" }
          : candidateRuntime;
      return expected;
    },
    useLegacy() {
      expected = legacy;
      return expected;
    },
    current() {
      return expected;
    },
  });
}

function adoptionJournalPath(projectRoot) {
  return path.join(
    releaseTools.runtimeRoot(projectRoot),
    "legacy-adoption.json",
  );
}

function writeJournal(projectRoot, payload) {
  const root = releaseTools.runtimeRoot(projectRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const destination = adoptionJournalPath(projectRoot);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, destination);
  const rootFd = fs.openSync(root, "r");
  try {
    fs.fsyncSync(rootFd);
  } finally {
    fs.closeSync(rootFd);
  }
}

function readJournal(projectRoot) {
  const file = adoptionJournalPath(projectRoot);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    fail("HR_BRIDGE_ADOPTION_JOURNAL_INVALID");
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("HR_BRIDGE_ADOPTION_JOURNAL_INVALID");
  }
}

function removeJournal(projectRoot) {
  const file = adoptionJournalPath(projectRoot);
  if (!fs.existsSync(file)) return;
  fs.unlinkSync(file);
  const fd = fs.openSync(releaseTools.runtimeRoot(projectRoot), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function acquireAdoptionSyncLock(projectRoot) {
  return releaseTools.acquireRuntimeIntentLock(projectRoot, "sync");
}

function readDeploymentEnvironment(projectRoot) {
  const environmentFile = path.join(projectRoot, ".env");
  const stat = fs.lstatSync(environmentFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 1024 * 1024 ||
    (stat.mode & 0o077) !== 0
  ) {
    fail("HR_BRIDGE_ENV_FILE_SECURITY_INVALID");
  }
  const parsed = {};
  const result = dotenvConfig({
    path: environmentFile,
    processEnv: parsed,
    quiet: true,
  });
  if (result.error) fail("HR_BRIDGE_ENV_FILE_NOT_READABLE");
  return Object.fromEntries(
    sourcePolicy.allowedEnvironmentKeys
      .filter((key) => typeof parsed[key] === "string")
      .map((key) => [key, parsed[key]]),
  );
}

function preflight(projectRoot, release) {
  const result = spawnSync(
    process.execPath,
    [release.bootstrapPath, "--preflight"],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: controlSubprocessEnvironment(),
      timeout: sourcePolicy.startupTimeoutMs + 10_000,
    },
  );
  if (result.error) throw result.error;
  const mode =
    result.status === 0
      ? "enabled"
      : result.status === sourcePolicy.disabledExitCode
        ? "disabled"
        : null;
  if (!mode || mode !== release.mode) {
    fail("HR_BRIDGE_ADOPTION_CANDIDATE_PREFLIGHT_FAILED");
  }
  return mode;
}

function verifyCandidate(projectRoot, release, mode = release.mode) {
  const args = [
    path.join(CONTROLLER_ROOT, "scripts", "verify-hr-bridge-runtime.mjs"),
    "--project-root",
    projectRoot,
    "--release-id",
    release.id,
  ];
  if (mode === "disabled") args.push("--expect-disabled");
  run(
    process.execPath,
    args,
    {
      cwd: projectRoot,
      timeoutMs: sourcePolicy.runtimeGateTimeoutMs + 15_000,
    },
  );
}

function restoreLegacy(projectRoot, legacy) {
  assertLegacyDefinition(projectRoot, legacy);
  stopBridge(projectRoot);
  run(
    "pm2",
    [
      "start",
      path.join(projectRoot, "ecosystem.config.cjs"),
      "--only",
      BRIDGE_NAME,
      "--update-env",
    ],
    {
      cwd: projectRoot,
      timeoutMs: sourcePolicy.pm2ListenTimeoutMs + 15_000,
      env: controlSubprocessEnvironment(),
    },
  );
  return verifyLegacy(projectRoot, legacy);
}

function updateActiveCheckout(projectRoot, controllerHead) {
  const before = capture("git", ["rev-parse", "HEAD"], projectRoot);
  if (before !== controllerHead) {
    run("git", ["pull", "--ff-only", "origin", "main"], {
      cwd: projectRoot,
      timeoutMs: 60_000,
    });
  }
  const after = gitHead(projectRoot);
  if (after !== controllerHead) {
    fail("HR_BRIDGE_ADOPTION_ACTIVE_CHECKOUT_UPDATE_FAILED");
  }
}

async function main() {
  const projectRoot = parseProjectRoot();
  assertIdentity(projectRoot);
  assertPm2Version(sourcePolicy.pm2Version);
  const controllerHead = assertControllerCheckout();
  const syncRelease = acquireAdoptionSyncLock(projectRoot);
  try {
    const legacyHead = gitHead(projectRoot);
    const lockRelease = releaseTools.acquireDeploymentLock(projectRoot);
    try {
      const existingState = releaseTools.readState(projectRoot);
      const existingJournal = readJournal(projectRoot);
      if (existingState.current && existingState.pending == null) {
        if (existingState.previous != null) {
          fail("HR_BRIDGE_BASELINE_STATE_NOT_EMPTY");
        }
        const committedRelease = releaseTools.validateRelease(
          projectRoot,
          existingState.current.id,
        );
        if (
          existingJournal &&
          existingJournal.candidateId !== existingState.current.id
        ) {
          fail("HR_BRIDGE_ADOPTION_COMMITTED_BASELINE_INVALID");
        }
        verifyCandidate(
          projectRoot,
          committedRelease,
          existingState.current.mode,
        );
        fsyncPm2Dump(
          projectRoot,
          existingState.current.mode === "disabled"
            ? { mode: "disabled" }
            : {
                executable: path.resolve(committedRelease.bootstrapPath),
                releaseId: committedRelease.id,
              },
        );
        releaseTools.ensureStateDurable(projectRoot);
        if (existingJournal) removeJournal(projectRoot);
        updateActiveCheckout(projectRoot, controllerHead);
        console.log(
          `hr bridge legacy adoption: recovered committed baseline (${existingState.current.id})`,
        );
        return;
      }
      if (existingState.current || existingState.pending) {
        fail("HR_BRIDGE_BASELINE_STATE_NOT_EMPTY");
      }

      if (existingJournal) {
        const journal = existingJournal;
        if (
          journal?.version !== 1 ||
          journal?.legacyHead !== legacyHead ||
          typeof journal?.legacy?.executable !== "string" ||
          !Number.isInteger(journal?.legacy?.port) ||
          !["healthy", "unhealthy"].includes(journal?.legacy?.health) ||
          typeof journal?.legacy?.definitionHash !== "string"
        ) {
          fail("HR_BRIDGE_ADOPTION_JOURNAL_INVALID");
        }
        restoreLegacy(projectRoot, journal.legacy);
        fsyncPm2Dump(projectRoot, journal.legacy);
        removeJournal(projectRoot);
      }

      if (controllerHead === legacyHead) {
        fail("HR_BRIDGE_ADOPTION_MUST_PRECEDE_ACTIVE_CHECKOUT_PULL");
      }
      const rows = bridgeRows(projectRoot);
      if (rows.length !== 1) fail("HR_BRIDGE_LEGACY_PROCESS_COUNT_INVALID");
      const row = rows[0];
      const legacy = {
        executable: path.resolve(row?.pm2_env?.pm_exec_path || ""),
        port: Number(row?.pm2_env?.env?.HR_DEVICE_PORT || 7788),
      };
      if (
        !legacy.executable.startsWith(
          `${path.join(projectRoot, "scripts")}${path.sep}`,
        ) ||
        legacy.executable.includes(`${path.sep}.runtime${path.sep}`) ||
        !Number.isInteger(legacy.port) ||
        legacy.port < 1 ||
        legacy.port > 65_535
      ) {
        fail("HR_BRIDGE_LEGACY_PROCESS_INVALID");
      }
      Object.assign(legacy, assertLegacyDefinition(projectRoot, legacy, row));
      legacy.health = classifyLegacy(projectRoot, legacy);

      const release = releaseTools.prepareRelease(projectRoot, {
        sourceRoot: CONTROLLER_ROOT,
        sourceCommit: controllerHead,
        deploymentEnvironment: readDeploymentEnvironment(projectRoot),
      });
      const candidateMode = preflight(projectRoot, release);
      const candidate = { id: release.id, mode: candidateMode };
      const candidateRuntime =
        candidateMode === "disabled"
          ? { mode: "disabled" }
          : {
              executable: path.resolve(release.bootstrapPath),
              releaseId: release.id,
            };
      const dumpContext = createExpectedDumpContext(
        legacy,
        candidateRuntime,
      );
      const operations = {
        legacyHealth: legacy.health,
        stop: () => stopBridge(projectRoot),
        start: () => {
          dumpContext.useCandidate(candidate);
          run(
            "pm2",
            ["start", release.pm2ConfigPath, "--only", BRIDGE_NAME],
            {
              cwd: projectRoot,
              timeoutMs: sourcePolicy.pm2ListenTimeoutMs + 15_000,
              env: controlSubprocessEnvironment(),
            },
          );
        },
        verify: (descriptor) => {
          dumpContext.useCandidate(descriptor);
          verifyCandidate(projectRoot, release, descriptor.mode);
        },
        save: () => fsyncPm2Dump(projectRoot, dumpContext.current()),
        verifyLegacy: () => verifyLegacy(projectRoot, legacy),
        startLegacy: () => {
          dumpContext.useLegacy();
          restoreLegacy(projectRoot, legacy);
        },
        beginAdoptionJournal: () => {
          fsyncPm2Dump(projectRoot, legacy);
          writeJournal(projectRoot, {
            version: 1,
            legacyHead,
            candidateId: release.id,
            legacy,
            startedAt: new Date().toISOString(),
          });
        },
        finishAdoptionJournal: () => removeJournal(projectRoot),
      };
      activation.adoptLegacyBridgeBaseline(
        projectRoot,
        candidate,
        operations,
        releaseTools,
      );
      releaseTools.ensureStateDurable(projectRoot);
      updateActiveCheckout(projectRoot, controllerHead);
      console.log(
        `hr bridge legacy adoption: immutable baseline committed (${release.id}, prior=${legacy.health})`,
      );
    } finally {
      lockRelease();
    }
  } finally {
    syncRelease();
  }
}

function runDumpContextSelftest() {
  const legacy = {
    executable: "/fixture/legacy-worker.mjs",
    definitionHash: "a".repeat(64),
  };
  const enabledCandidate = {
    executable: "/fixture/release/hr-bridge-worker.mjs",
    releaseId: "b".repeat(64),
  };
  const context = createExpectedDumpContext(legacy, enabledCandidate);
  if (context.current() !== legacy) {
    fail("HR_BRIDGE_ADOPTION_DUMP_CONTEXT_SELFTEST_FAILED");
  }
  const disabled = context.useCandidate({ mode: "disabled" });
  if (
    disabled.mode !== "disabled" ||
    Object.hasOwn(disabled, "executable") ||
    context.current() !== disabled
  ) {
    fail("HR_BRIDGE_ADOPTION_DUMP_CONTEXT_SELFTEST_FAILED");
  }
  if (context.useLegacy() !== legacy || context.current() !== legacy) {
    fail("HR_BRIDGE_ADOPTION_DUMP_CONTEXT_SELFTEST_FAILED");
  }
  if (
    context.useCandidate({ mode: "enabled" }) !== enabledCandidate ||
    context.current() !== enabledCandidate
  ) {
    fail("HR_BRIDGE_ADOPTION_DUMP_CONTEXT_SELFTEST_FAILED");
  }
  console.log(
    "hr bridge adoption dump context selftest: disabled candidate + legacy rollback passed",
  );
}

async function dispatch() {
  if (
    process.argv.length === 3 &&
    process.argv[2] === "--selftest-dump-context"
  ) {
    runDumpContextSelftest();
    return;
  }
  await main();
}

dispatch().catch((error) => {
  const code = error?.code || error?.message || "HR_BRIDGE_ADOPTION_FAILED";
  console.error(`hr bridge legacy adoption failed: ${code}`);
  process.exitCode =
    code === "HR_BRIDGE_ADOPTION_FAILED_LEGACY_RESTORE_FAILED" ? 2 : 1;
});
