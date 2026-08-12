#!/usr/bin/env node

/**
 * Production deployment controller.
 *
 * Only Node built-ins are loaded before git synchronization. If pull changes
 * this file, the updated controller is re-executed before any mutable step.
 * The HR bridge is activated as an immutable, journalled release with automatic
 * rollback; database restoration is deliberately never automatic.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEPLOY_SCRIPT = fileURLToPath(import.meta.url);
const SHA = /^[a-f0-9]{40}$/;
const BRIDGE_PROCESS_NAME = "erp-hr-bridge";
const SYNC_LOCK_TOKEN_ENV = "HR_BRIDGE_DEPLOY_SYNC_LOCK_TOKEN";
const SYNC_LOCK_PARENT_PID_ENV = "HR_BRIDGE_DEPLOY_SYNC_LOCK_PARENT_PID";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    env: options.env ?? process.env,
  });
}

function capture(command, args, timeoutMs = 15_000) {
  return String(
    run(command, args, { capture: true, timeoutMs }),
  ).trim();
}

function git(args, timeoutMs = 30_000) {
  return capture("git", args, timeoutMs);
}

function assertDeploymentIdentity() {
  if (process.platform !== "linux") {
    throw new Error("DEPLOY_PLATFORM_UNSUPPORTED");
  }
  const account = userInfo();
  const expectedHome = path.resolve(account.homedir);
  const effectiveHome = path.resolve(process.env.HOME || "");
  const expectedPm2Home = path.join(expectedHome, ".pm2");
  const effectivePm2Home = path.resolve(
    process.env.PM2_HOME?.trim() || path.join(effectiveHome, ".pm2"),
  );
  if (
    process.getuid?.() === 0 ||
    account.username !== "deploy" ||
    effectiveHome !== expectedHome ||
    effectivePm2Home !== expectedPm2Home
  ) {
    throw new Error("DEPLOY_IDENTITY_INVALID");
  }
}

function assertRepository(expectedSha = null) {
  const top = path.resolve(git(["rev-parse", "--show-toplevel"]));
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "refs/remotes/origin/main"]);
  const dirty = git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (top !== PROJECT_ROOT) throw new Error("DEPLOY_REPOSITORY_ROOT_INVALID");
  if (branch !== "main") throw new Error("DEPLOY_BRANCH_MUST_BE_MAIN");
  if (dirty) throw new Error("DEPLOY_WORKTREE_NOT_CLEAN");
  if (expectedSha && head !== expectedSha) {
    throw new Error("DEPLOY_REEXEC_SHA_MISMATCH");
  }
  return { head, remote };
}

function readPm2DumpRowsBeforePull() {
  const home = process.env.PM2_HOME?.trim() ||
    (process.env.HOME ? path.join(process.env.HOME, ".pm2") : "");
  if (!home) throw new Error("PM2_HOME_INVALID");
  const dumpPath = path.join(path.resolve(home), "dump.pm2");
  if (!fs.existsSync(dumpPath)) return [];
  const stat = fs.lstatSync(dumpPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error("PM2_DUMP_INVALID");
  }
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  } catch {
    throw new Error("PM2_DUMP_INVALID");
  }
  if (!Array.isArray(rows)) throw new Error("PM2_DUMP_INVALID");
  return rows;
}

function assertImmutableBaselineOwnsBridge(current, liveRows, dumpRows) {
  if (current) return;
  if (
    liveRows.some((row) => row?.name === BRIDGE_PROCESS_NAME) ||
    dumpRows.some((row) => row?.name === BRIDGE_PROCESS_NAME)
  ) {
    throw new Error("HR_BRIDGE_LEGACY_ADOPTION_REQUIRED");
  }
}

function assertBridgeBaselineBeforePull() {
  const adoptionJournal = path.join(
    PROJECT_ROOT,
    ".runtime",
    "hr-bridge",
    "legacy-adoption.json",
  );
  if (fs.existsSync(adoptionJournal)) {
    throw new Error("HR_BRIDGE_LEGACY_ADOPTION_INCOMPLETE");
  }
  const stateFile = path.join(
    PROJECT_ROOT,
    ".runtime",
    "hr-bridge",
    "state.json",
  );
  let state = null;
  if (fs.existsSync(stateFile)) {
    const stat = fs.lstatSync(stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
    }
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
    }
    if (state?.version !== 2) {
      throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
    }
    if (state.pending) return { pending: true };
  }
  const allRows = pm2Rows();
  const dumpRows = readPm2DumpRowsBeforePull();
  const rows = allRows.filter((row) => row?.name === BRIDGE_PROCESS_NAME);
  const current = state?.current ?? null;
  assertImmutableBaselineOwnsBridge(current, allRows, dumpRows);
  if (!current) {
    return { pending: false };
  }
  if (
    !/^[a-f0-9]{64}$/.test(current.id || "") ||
    !["enabled", "disabled"].includes(current.mode)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
  }
  if (current.mode === "disabled") {
    return { pending: false, reconcile: true };
  }
  const expected = path.resolve(
    PROJECT_ROOT,
    ".runtime",
    "hr-bridge",
    "releases",
    current.id,
    "hr-bridge-worker.mjs",
  );
  const releaseBootstrap = fs.lstatSync(expected);
  if (!releaseBootstrap.isFile() || releaseBootstrap.isSymbolicLink()) {
    throw new Error("HR_BRIDGE_RELEASE_FILE_INVALID");
  }
  return {
    pending: false,
    // Full live+dump/lifecycle attestation is deliberately done while both
    // sync and deployment locks are held, before git can mutate the checkout.
    reconcile: true,
  };
}

function runPrePullGuardSelftest() {
  let legacyDumpBlocked = false;
  try {
    assertImmutableBaselineOwnsBridge(null, [], [
      { name: BRIDGE_PROCESS_NAME, pm_exec_path: "/legacy/worker.mjs" },
    ]);
  } catch (error) {
    legacyDumpBlocked =
      error?.message === "HR_BRIDGE_LEGACY_ADOPTION_REQUIRED";
  }
  if (!legacyDumpBlocked) {
    throw new Error("HR_BRIDGE_PREPULL_DUMP_GUARD_SELFTEST_FAILED");
  }
  console.log("hr bridge pre-pull guard selftest: legacy dump blocks source mutation");
}

function syncLockProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function syncLockWait(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function fsyncSyncLockDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readSyncLock(lockPath) {
  const stat = fs.lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new Error("HR_BRIDGE_DEPLOY_SYNC_LOCK_INVALID");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    throw new Error("HR_BRIDGE_DEPLOY_SYNC_LOCK_INVALID");
  }
  if (
    parsed?.version !== 1 ||
    parsed?.namespace !== "sync" ||
    typeof parsed.token !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(parsed.token) ||
    typeof parsed.createdNs !== "string" ||
    !/^\d+$/.test(parsed.createdNs) ||
    typeof parsed.held !== "boolean" ||
    !Array.isArray(parsed.pids) ||
    parsed.pids.length === 0 ||
    parsed.pids.some((pid) => !Number.isInteger(pid) || pid <= 0)
  ) {
    throw new Error("HR_BRIDGE_DEPLOY_SYNC_LOCK_INVALID");
  }
  return parsed;
}

function writeSyncLock(directory, lockPath, payload, replace = false) {
  const destination = replace
    ? `${lockPath}.tmp-${process.pid}-${randomUUID()}`
    : lockPath;
  const fd = fs.openSync(destination, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (replace) fs.renameSync(destination, lockPath);
  fsyncSyncLockDirectory(directory);
}

function compareSyncLocks(left, right) {
  const leftTime = BigInt(left.record.createdNs);
  const rightTime = BigInt(right.record.createdNs);
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  return left.record.token.localeCompare(right.record.token);
}

function syncLockCandidateWins(entries, ownFile) {
  if (
    entries.some(
      (entry) => entry.file !== ownFile && entry.record.held,
    )
  ) {
    return false;
  }
  return [...entries].sort(compareSyncLocks)[0]?.file === ownFile;
}

function liveSyncLocks(directory, ownFile = null) {
  const live = [];
  for (const name of fs.readdirSync(directory)) {
    if (name.includes(".tmp-")) continue;
    const match = name.match(/^([0-9]+)-([0-9a-f-]{36})\.json$/i);
    if (!match) throw new Error("HR_BRIDGE_DEPLOY_SYNC_LOCK_INVALID");
    const file = path.join(directory, name);
    let record;
    try {
      record = readSyncLock(file);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (
      record.token !== match[2] ||
      !record.pids.includes(Number(match[1]))
    ) {
      throw new Error("HR_BRIDGE_DEPLOY_SYNC_LOCK_INVALID");
    }
    if (record.pids.some(syncLockProcessIsAlive)) {
      live.push({ file, record });
      continue;
    }
    if (file === ownFile) continue;
    try {
      fs.unlinkSync(file);
      fsyncSyncLockDirectory(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return live;
}

function acquirePrePullLock(directoryOverride = null) {
  const root = path.resolve(
    directoryOverride || path.join(PROJECT_ROOT, ".runtime", "hr-bridge"),
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, "sync-locks");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const inheritedToken = process.env[SYNC_LOCK_TOKEN_ENV]?.trim();
  const inheritedParentPid = Number(
    process.env[SYNC_LOCK_PARENT_PID_ENV],
  );
  delete process.env[SYNC_LOCK_TOKEN_ENV];
  delete process.env[SYNC_LOCK_PARENT_PID_ENV];
  if (inheritedToken) {
    const matches = liveSyncLocks(directory).filter(
      (entry) => entry.record.token === inheritedToken,
    );
    if (matches.length !== 1) {
      throw new Error("HR_BRIDGE_DEPLOY_SYNC_HANDOFF_INVALID");
    }
    const [{ file: lockPath, record: existing }] = matches;
    if (
      !existing.held ||
      !Number.isInteger(inheritedParentPid) ||
      inheritedParentPid <= 0 ||
      !existing.pids.includes(inheritedParentPid) ||
      !syncLockProcessIsAlive(inheritedParentPid)
    ) {
      throw new Error("HR_BRIDGE_DEPLOY_SYNC_HANDOFF_INVALID");
    }
    writeSyncLock(directory, lockPath, {
      ...existing,
      pids: [...new Set([...existing.pids, process.pid])],
    }, true);
    return Object.freeze({
      token: inheritedToken,
      inherited: true,
      release() {},
    });
  }
  if (Number.isFinite(inheritedParentPid)) {
    throw new Error("HR_BRIDGE_DEPLOY_SYNC_HANDOFF_INVALID");
  }

  const token = randomUUID();
  const lockPath = path.join(directory, `${process.pid}-${token}.json`);
  let record = {
    version: 1,
    namespace: "sync",
    token,
    createdNs: process.hrtime.bigint().toString(),
    held: false,
    pids: [process.pid],
  };
  writeSyncLock(directory, lockPath, record);
  try {
    const candidates = liveSyncLocks(directory, lockPath);
    if (!syncLockCandidateWins(candidates, lockPath)) {
      throw new Error("HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING");
    }
    record = { ...record, held: true };
    writeSyncLock(directory, lockPath, record, true);
    syncLockWait(20);
    const held = liveSyncLocks(directory, lockPath)
      .filter((entry) => entry.record.held)
      .sort(compareSyncLocks);
    if (held[0]?.file !== lockPath) {
      throw new Error("HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING");
    }
  } catch (error) {
    try {
      fs.unlinkSync(lockPath);
      fsyncSyncLockDirectory(directory);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const existing = readSyncLock(lockPath);
      if (existing.token === token) {
        fs.unlinkSync(lockPath);
        fsyncSyncLockDirectory(directory);
      }
    } catch {
      // Fail closed: never remove a lock whose ownership cannot be proven.
    }
  };
  return Object.freeze({ token, inherited: false, release });
}

function synchronizeAndMaybeReexec(syncLock) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const before = assertRepository().head;
    run("git", ["pull", "--ff-only", "origin", "main"], {
      timeoutMs: 60_000,
    });
    const afterState = assertRepository();
    if (afterState.head !== afterState.remote) {
      throw new Error("DEPLOY_HEAD_NOT_ORIGIN_MAIN");
    }
    if (afterState.head !== before) {
      const child = spawnSync(
        process.execPath,
        [DEPLOY_SCRIPT, "--after-pull", afterState.head],
        {
          cwd: PROJECT_ROOT,
          stdio: "inherit",
          env: {
            ...process.env,
            [SYNC_LOCK_TOKEN_ENV]: syncLock.token,
            [SYNC_LOCK_PARENT_PID_ENV]: String(process.pid),
          },
        },
      );
      if (child.error) throw child.error;
      syncLock.release();
      process.exit(child.status ?? 1);
    }
    return afterState.head;
  }

  if (args.length !== 2 || args[0] !== "--after-pull" || !SHA.test(args[1])) {
    throw new Error("DEPLOY_ARGUMENTS_INVALID");
  }
  const state = assertRepository(args[1]);
  if (state.head !== state.remote) {
    throw new Error("DEPLOY_HEAD_NOT_ORIGIN_MAIN");
  }
  return state.head;
}

async function runSyncLockSelftest() {
  const directory = fs.mkdtempSync(
    path.join(tmpdir(), "hr-bridge-sync-lock-selftest-"),
  );
  const parentLock = acquirePrePullLock(directory);
  let child = null;
  try {
    child = spawn(
      process.execPath,
      [DEPLOY_SCRIPT, "--sync-lock-child", directory],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          [SYNC_LOCK_TOKEN_ENV]: parentLock.token,
          [SYNC_LOCK_PARENT_PID_ENV]: String(process.pid),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_TIMEOUT")),
        20_000,
      );
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("SYNC_LOCK_CHILD_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const contender = spawnSync(
      process.execPath,
      [DEPLOY_SCRIPT, "--sync-lock-contender", directory],
      { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 5_000 },
    );
    if (
      contender.error ||
      contender.status !== 0 ||
      !contender.stdout.includes("SYNC_LOCK_CONTENDER_BLOCKED")
    ) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_CONTENDER_NOT_BLOCKED");
    }
    const childStatus = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    if (childStatus !== 0) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_CHILD_FAILED");
    }

    const heldPriorityRoot = path.join(directory, "held-priority");
    const heldPriorityDirectory = path.join(heldPriorityRoot, "sync-locks");
    fs.mkdirSync(heldPriorityDirectory, { recursive: true, mode: 0o700 });
    const heldPriorityToken = randomUUID();
    fs.writeFileSync(
      path.join(
        heldPriorityDirectory,
        `${process.pid}-${heldPriorityToken}.json`,
      ),
      `${JSON.stringify({
        version: 1,
        namespace: "sync",
        token: heldPriorityToken,
        createdNs: "9".repeat(30),
        held: true,
        pids: [process.pid],
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    let heldPriorityBlocked = false;
    try {
      acquirePrePullLock(heldPriorityRoot);
    } catch (error) {
      heldPriorityBlocked =
        error?.message === "HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING";
    }
    if (!heldPriorityBlocked) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_HELD_PRIORITY_SELFTEST_FAILED");
    }

    const stalePid = 2_147_483_647;
    const staleToken = randomUUID();
    const locksDirectory = path.join(directory, "race", "sync-locks");
    fs.mkdirSync(locksDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(locksDirectory, `${stalePid}-${staleToken}.json`),
      `${JSON.stringify({
        version: 1,
        namespace: "sync",
        token: staleToken,
        createdNs: "1",
        held: true,
        pids: [stalePid],
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const gate = path.join(directory, "race-gate");
    const winner = path.join(directory, "race-winner");
    const racers = [0, 1].map(() =>
      spawn(
        process.execPath,
        [DEPLOY_SCRIPT, "--sync-lock-race-contender", path.join(directory, "race"), gate, winner],
        {
          cwd: PROJECT_ROOT,
          env: controlSubprocessEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    const readyDeadline = Date.now() + 10_000;
    while (
      fs.readdirSync(directory).filter((name) => name.endsWith(".ready"))
        .length < 2
    ) {
      if (Date.now() >= readyDeadline) {
        throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_RACE_READY_TIMEOUT");
      }
      sleep(20);
    }
    fs.writeFileSync(gate, "go\n", { flag: "wx" });
    const raceResults = await Promise.all(
      racers.map(
        (racer) =>
          new Promise((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            racer.stdout.on("data", (chunk) => {
              stdout += String(chunk);
            });
            racer.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            racer.once("error", reject);
            racer.once("exit", (code) => resolve({ code, stdout, stderr }));
          }),
      ),
    );
    if (
      raceResults.some((result) => result.code !== 0) ||
      raceResults.filter((result) => result.stdout.includes("RACE_WINNER"))
        .length !== 1 ||
      raceResults.filter((result) => result.stdout.includes("RACE_BLOCKED"))
        .length !== 1
    ) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_RACE_FAILED");
    }
  } finally {
    if (child?.exitCode == null) child?.kill();
    parentLock.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log("hr bridge sync lock selftest: handoff, nested selftest, and fenced stale race passed");
}

function assertPm2Version(expectedVersion) {
  const launcher = fs.realpathSync(capture("which", ["pm2"], 10_000));
  let packageRoot = path.dirname(launcher);
  while (true) {
    const packageFile = path.join(packageRoot, "package.json");
    if (fs.existsSync(packageFile)) {
      const candidate = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      if (candidate?.name === "pm2") break;
    }
    const parent = path.dirname(packageRoot);
    if (parent === packageRoot) throw new Error("PM2_PACKAGE_NOT_RESOLVED");
    packageRoot = parent;
  }
  const cliOutput = capture("pm2", ["--version"], 10_000);
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
  const daemonProbe = spawnSync(process.execPath, ["-e", probe, packageRoot], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  const daemonVersion = daemonProbe.stdout
    ?.match(/\b\d+\.\d+\.\d+\b/g)
    ?.at(-1);
  if (
    daemonProbe.error ||
    daemonProbe.status !== 0 ||
    cliVersion !== expectedVersion ||
    packageVersion !== expectedVersion ||
    daemonVersion !== expectedVersion
  ) {
    throw new Error(
      `PM2_VERSION_UNSUPPORTED:expected=${expectedVersion}:cli=${cliVersion ?? "unknown"}:package=${packageVersion ?? "unknown"}:daemon=${daemonVersion ?? "unknown"}`,
    );
  }
}

function pm2Rows() {
  const rows = JSON.parse(capture("pm2", ["jlist"], 10_000));
  if (!Array.isArray(rows)) throw new Error("PM2_JSON_INVALID");
  return rows;
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function stopBridge(policy) {
  const matches = pm2Rows().filter((row) => row?.name === BRIDGE_PROCESS_NAME);
  for (const row of matches) {
    const id = Number(row?.pm_id);
    if (!Number.isInteger(id) || id < 0) {
      throw new Error("PM2_BRIDGE_ID_INVALID");
    }
    run("pm2", ["delete", String(id)], {
      timeoutMs: policy.pm2KillTimeoutMs + 15_000,
    });
  }
  const deadline = Date.now() + policy.pm2KillTimeoutMs + 10_000;
  while (Date.now() < deadline) {
    if (!pm2Rows().some((row) => row?.name === BRIDGE_PROCESS_NAME)) return;
    sleep(250);
  }
  throw new Error("PM2_BRIDGE_DELETE_TIMEOUT");
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
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
}

function runControlEnvironmentSelftest() {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.HR_BRIDGE_PRELOAD_CANARY) process.exit(2)",
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 5_000,
      env: controlSubprocessEnvironment(),
    },
  );
  if (probe.error || probe.status !== 0) {
    throw new Error("HR_BRIDGE_CONTROL_ENVIRONMENT_SELFTEST_FAILED");
  }
  console.log("hr bridge control environment selftest: NODE_OPTIONS/NODE_PATH stripped");
}

function readBridgeDeploymentEnvironment(policy, dotenvConfig) {
  const environmentFile = path.join(PROJECT_ROOT, ".env");
  const stat = fs.lstatSync(environmentFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 1024 * 1024 ||
    (process.platform === "linux" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("HR_BRIDGE_ENV_FILE_SECURITY_INVALID");
  }
  const parsed = {};
  const result = dotenvConfig({
    path: environmentFile,
    processEnv: parsed,
    quiet: true,
  });
  if (result.error) throw new Error("HR_BRIDGE_ENV_FILE_NOT_READABLE");
  const environment = {};
  for (const key of policy.allowedEnvironmentKeys) {
    if (typeof parsed[key] === "string") environment[key] = parsed[key];
  }
  environment.NODE_ENV = "production";
  environment.TZ = "UTC";
  environment.HR_BRIDGE_LOAD_DOTENV = "0";
  return environment;
}

function runPreflight(descriptor, releaseTools) {
  const release = releaseTools.validateRelease(PROJECT_ROOT, descriptor.id);
  const policy = releaseTools.loadReleasePolicy(PROJECT_ROOT, descriptor.id);
  const result = spawnSync(
    process.execPath,
    [release.bootstrapPath, "--preflight"],
    {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: controlSubprocessEnvironment(),
      timeout: policy.startupTimeoutMs + 10_000,
    },
  );
  if (result.error) throw result.error;
  const mode =
    result.status === 0
      ? "enabled"
      : result.status === policy.disabledExitCode
        ? "disabled"
        : null;
  if (!mode) throw new Error("HR_BRIDGE_PREFLIGHT_FAILED");
  return mode;
}

function bridgePm2ContractOptions(
  descriptor,
  fallbackReleaseId,
  releaseTools,
) {
  const selected = descriptor ?? {
    id: fallbackReleaseId,
    mode: "disabled",
  };
  const release = releaseTools.validateRelease(PROJECT_ROOT, selected.id);
  return {
    release: { ...release, mode: selected.mode },
    policy: releaseTools.loadReleasePolicy(PROJECT_ROOT, selected.id),
    projectRoot: PROJECT_ROOT,
    pm2Home: path.resolve(
      process.env.PM2_HOME || path.join(process.env.HOME, ".pm2"),
    ),
  };
}

function verifySavedDump(
  descriptor,
  fallbackReleaseId,
  releaseTools,
  pm2Contract,
) {
  const pm2Home = path.resolve(
    process.env.PM2_HOME || path.join(process.env.HOME, ".pm2"),
  );
  const dumpPath = path.join(pm2Home, "dump.pm2");
  const stat = fs.lstatSync(dumpPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error("PM2_DUMP_INVALID");
  }
  const rows = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  if (!Array.isArray(rows)) throw new Error("PM2_DUMP_INVALID");
  pm2Contract.assertDumpBridgePm2Rows(
    rows,
    bridgePm2ContractOptions(descriptor, fallbackReleaseId, releaseTools),
  );
}

function makeActivationOperations(
  fallbackReleaseId,
  releaseTools,
  pm2Contract,
  protectedReleaseIds = [],
) {
  let lastVerified = null;
  const verify = (descriptor) => {
    const releaseId = descriptor?.id ?? fallbackReleaseId;
    releaseTools.validateRelease(PROJECT_ROOT, releaseId);
    const args = [
      "scripts/verify-hr-bridge-runtime.mjs",
      "--release-id",
      releaseId,
    ];
    if (!descriptor || descriptor.mode === "disabled") {
      args.push("--expect-disabled");
    }
    run(process.execPath, args, {
      timeoutMs:
        releaseTools.loadReleasePolicy(PROJECT_ROOT, releaseId)
          .runtimeGateTimeoutMs + 15_000,
    });
    lastVerified = descriptor;
  };
  return {
    stop() {
      const ids = [
        fallbackReleaseId,
        lastVerified?.id,
        ...protectedReleaseIds,
      ].filter(Boolean);
      const policies = ids.map((id) =>
        releaseTools.loadReleasePolicy(PROJECT_ROOT, id),
      );
      const longest = policies.reduce(
        (selected, candidate) =>
          candidate.pm2KillTimeoutMs > selected.pm2KillTimeoutMs
            ? candidate
            : selected,
        policies[0],
      );
      stopBridge(longest);
    },
    start(descriptor) {
      const release = releaseTools.validateRelease(PROJECT_ROOT, descriptor.id);
      const policy = releaseTools.loadReleasePolicy(PROJECT_ROOT, descriptor.id);
      run("pm2", ["start", release.pm2ConfigPath, "--only", BRIDGE_PROCESS_NAME], {
        timeoutMs: policy.pm2ListenTimeoutMs + 15_000,
        env: controlSubprocessEnvironment(),
      });
    },
    verify,
    save() {
      run("pm2", ["save"], { timeoutMs: 30_000 });
      const pm2Home = path.resolve(
        process.env.PM2_HOME || path.join(process.env.HOME, ".pm2"),
      );
      const dumpPath = path.join(pm2Home, "dump.pm2");
      const dumpFd = fs.openSync(dumpPath, "r");
      try {
        fs.fsyncSync(dumpFd);
      } finally {
        fs.closeSync(dumpFd);
      }
      if (process.platform === "linux") {
        const homeFd = fs.openSync(pm2Home, "r");
        try {
          fs.fsyncSync(homeFd);
        } finally {
          fs.closeSync(homeFd);
        }
      }
      verify(lastVerified);
      verifySavedDump(
        lastVerified,
        fallbackReleaseId,
        releaseTools,
        pm2Contract,
      );
    },
  };
}

function step(label, action) {
  console.log(`\n▶ ${label}…`);
  return action();
}

function reconcileCommittedBridge(
  descriptor,
  releaseTools,
  pm2Contract,
) {
  if (!descriptor) return;
  const operations = makeActivationOperations(
    descriptor.id,
    releaseTools,
    pm2Contract,
    [descriptor.id],
  );
  const exactLiveShape = pm2Contract.auditLiveBridgePm2Rows(
    pm2Rows(),
    bridgePm2ContractOptions(descriptor, descriptor.id, releaseTools),
  ).ok;
  if (!exactLiveShape) {
    operations.stop();
    if (descriptor.mode === "enabled") operations.start(descriptor);
    operations.verify(descriptor);
  } else {
    try {
      operations.verify(descriptor);
    } catch {
      operations.stop();
      if (descriptor.mode === "enabled") operations.start(descriptor);
      operations.verify(descriptor);
    }
  }
  operations.save();
}

async function deploy(expectedHead) {
  const [
    { default: policy },
    releaseModule,
    activationModule,
    pm2ContractModule,
  ] = await Promise.all([
    import("./hr-bridge-runtime-policy.cjs"),
    import("./hr-bridge-release.cjs"),
    import("./hr-bridge-activation.cjs"),
    import("./hr-bridge-pm2-contract.cjs"),
  ]);
  const releaseTools = releaseModule.default;
  const activation = activationModule.default;
  const pm2Contract = pm2ContractModule.default;
  assertPm2Version(policy.pm2Version);
  const releaseLock = releaseTools.acquireDeploymentLock(PROJECT_ROOT);
  try {
    const initialState = releaseTools.readState(PROJECT_ROOT);
    if (initialState.pending) {
      step("استعادة آخر إصدار ملتزم بعد نشر منقطع", () => {
        const operations = makeActivationOperations(
          initialState.pending.candidate.id,
          releaseTools,
          pm2Contract,
          [initialState.pending.prior?.id].filter(Boolean),
        );
        activation.recoverInterruptedActivation(
          PROJECT_ROOT,
          operations,
          releaseTools,
        );
      });
    }
    const settledState = releaseTools.readState(PROJECT_ROOT);
    if (settledState.current) {
      reconcileCommittedBridge(
        settledState.current,
        releaseTools,
        pm2Contract,
      );
    }
    step("1/10 تثبيت الاعتماديات المقفلة", () =>
      run("pnpm", ["install", "--frozen-lockfile"], {
        timeoutMs: 5 * 60_000,
      }),
    );
    const dotenvModule = await import("dotenv");
    step("2/10 بناء وفحص إصدار الإنتاج", () =>
      run("pnpm", ["build"], { timeoutMs: 10 * 60_000 }),
    );
    const repository = assertRepository(expectedHead);
    if (repository.head !== repository.remote) {
      throw new Error("DEPLOY_HEAD_NOT_ORIGIN_MAIN");
    }
    const deploymentEnvironment = readBridgeDeploymentEnvironment(
      policy,
      dotenvModule.config,
    );
    const candidateRelease = releaseTools.prepareRelease(PROJECT_ROOT, {
      sourceCommit: expectedHead,
      deploymentEnvironment,
    });
    const provisional = { id: candidateRelease.id, mode: "enabled" };
    const beforeMode = step("3/10 فحص المرشح قبل لمس قاعدة البيانات", () =>
      runPreflight(provisional, releaseTools),
    );

    step("4/10 إنشاء نسخة احتياطية", () => run("pnpm", ["db:backup"]));
    step("5/10 تطبيق الهجرات الآمنة وإصلاح مخطط الاستقبال", () => {
      run("pnpm", ["db:migrate:safe"]);
      run("node", [
        "scripts/ci-apply-extra-migrations.mjs",
        "--only=drizzle/migrations/0177_repair_reception_schema_drift.sql",
      ]);
    });
    step("6/10 التحقق من مخطط قاعدة البيانات", () =>
      run("pnpm", ["db:verify"], { timeoutMs: 5 * 60_000 }),
    );

    const afterMode = step("7/10 فحص المرشح بعد الهجرات", () =>
      runPreflight(provisional, releaseTools),
    );
    if (beforeMode !== afterMode) {
      throw new Error("HR_BRIDGE_MODE_CHANGED_DURING_DEPLOY");
    }
    const candidate = { id: candidateRelease.id, mode: afterMode };
    const committed = releaseTools.readState(PROJECT_ROOT).current;
    if (committed) {
      step("8/10 إثبات صلاحية إصدار الرجوع مع المخطط الجديد", () => {
        const rollbackMode = runPreflight(committed, releaseTools);
        if (rollbackMode !== committed.mode) {
          throw new Error("HR_BRIDGE_ROLLBACK_MODE_DRIFT");
        }
      });
    } else {
      console.log("\n▶ 8/10 لا يوجد إصدار immutable سابق (أول انتقال فقط)." );
    }

    step("9/10 إعادة تحميل خادم الويب", () =>
      run(
        "pm2",
        [
          "reload",
          "ecosystem.config.cjs",
          "--only",
          "erp-server",
          "--update-env",
        ],
        { timeoutMs: 2 * 60_000 },
      ),
    );

    step("10/10 تفعيل إصدار الجسر والتحقق والحفظ الذري", () => {
      const operations = makeActivationOperations(
        candidate.id,
        releaseTools,
        pm2Contract,
        [committed?.id].filter(Boolean),
      );
      activation.activateBridgeRelease(
        PROJECT_ROOT,
        candidate,
        operations,
        releaseTools,
      );
    });
    const retention = releaseTools.pruneBridgeReleasesAfterCommit(
      PROJECT_ROOT,
      { committedCandidateId: candidate.id, keepRecent: 2 },
    );
    if (retention.failed > 0) {
      console.warn("HR_BRIDGE_RELEASE_RETENTION_DEFERRED");
    }
  } finally {
    releaseLock();
  }
}

async function recoverBeforePull() {
  const [
    { default: policy },
    releaseModule,
    activationModule,
    pm2ContractModule,
  ] = await Promise.all([
    import("./hr-bridge-runtime-policy.cjs"),
    import("./hr-bridge-release.cjs"),
    import("./hr-bridge-activation.cjs"),
    import("./hr-bridge-pm2-contract.cjs"),
  ]);
  const releaseTools = releaseModule.default;
  const activation = activationModule.default;
  const pm2Contract = pm2ContractModule.default;
  assertPm2Version(policy.pm2Version);
  const unlock = releaseTools.acquireDeploymentLock(PROJECT_ROOT);
  try {
    const state = releaseTools.readState(PROJECT_ROOT);
    if (state.pending) {
      const operations = makeActivationOperations(
        state.pending.candidate.id,
        releaseTools,
        pm2Contract,
        [state.pending.prior?.id].filter(Boolean),
      );
      activation.recoverInterruptedActivation(
        PROJECT_ROOT,
        operations,
        releaseTools,
      );
    }
    const settled = releaseTools.readState(PROJECT_ROOT);
    reconcileCommittedBridge(settled.current, releaseTools, pm2Contract);
  } finally {
    unlock();
  }
}

async function main() {
  assertDeploymentIdentity();
  process.chdir(PROJECT_ROOT);
  const releaseSyncLock = acquirePrePullLock();
  try {
    const baseline = assertBridgeBaselineBeforePull();
    if (baseline?.pending || baseline?.reconcile) {
      await recoverBeforePull();
    }
    const expectedHead = synchronizeAndMaybeReexec(releaseSyncLock);
    console.log("🚀 نشر إنتاجي هندسي — بداية");
    const startedAt = Date.now();
    await deploy(expectedHead);
    console.log(
      `\n✓ اكتمل النشر في ${((Date.now() - startedAt) / 1000).toFixed(1)} ثانية.`,
    );
    console.log("   جسر الحضور يعمل من إصدار immutable وتم حفظ PM2 بعد بوابة الاستقرار.");
  } finally {
    releaseSyncLock.release();
  }
}

async function dispatch() {
  const [mode, directory, ...rest] = process.argv.slice(2);
  if (mode === "--selftest-sync-lock") {
    if (directory || rest.length > 0) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_ARGUMENTS_INVALID");
    }
    await runSyncLockSelftest();
    return;
  }
  if (mode === "--selftest-control-environment") {
    if (directory || rest.length > 0) {
      throw new Error("HR_BRIDGE_CONTROL_ENVIRONMENT_SELFTEST_ARGUMENTS_INVALID");
    }
    runControlEnvironmentSelftest();
    return;
  }
  if (mode === "--selftest-prepull-guard") {
    if (directory || rest.length > 0) {
      throw new Error("HR_BRIDGE_PREPULL_GUARD_SELFTEST_ARGUMENTS_INVALID");
    }
    runPrePullGuardSelftest();
    return;
  }
  if (mode === "--sync-lock-child") {
    if (!directory || rest.length > 0) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_ARGUMENTS_INVALID");
    }
    const inherited = acquirePrePullLock(directory);
    if (
      process.env[SYNC_LOCK_TOKEN_ENV] ||
      process.env[SYNC_LOCK_PARENT_PID_ENV]
    ) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_HANDOFF_ENV_NOT_SANITIZED");
    }
    if (process.env.HR_BRIDGE_SYNC_LOCK_NESTED !== "1") {
      const nested = spawnSync(
        process.execPath,
        [DEPLOY_SCRIPT, "--selftest-sync-lock"],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            HR_BRIDGE_SYNC_LOCK_NESTED: "1",
          },
        },
      );
      if (nested.error || nested.status !== 0) {
        throw new Error("HR_BRIDGE_SYNC_LOCK_NESTED_SELFTEST_FAILED");
      }
    }
    process.stdout.write("SYNC_LOCK_CHILD_READY\n");
    sleep(2_000);
    inherited.release();
    return;
  }
  if (mode === "--sync-lock-contender") {
    if (!directory || rest.length > 0) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_ARGUMENTS_INVALID");
    }
    try {
      const unexpected = acquirePrePullLock(directory);
      unexpected.release();
    } catch (error) {
      if (error?.message === "HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING") {
        process.stdout.write("SYNC_LOCK_CONTENDER_BLOCKED\n");
        return;
      }
      throw error;
    }
    throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_CONTENDER_NOT_BLOCKED");
  }
  if (mode === "--sync-lock-race-contender") {
    const [gate, winner, ...extra] = rest;
    if (!directory || !gate || !winner || extra.length > 0) {
      throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_ARGUMENTS_INVALID");
    }
    const ready = path.join(
      path.dirname(gate),
      `${path.basename(gate)}.${process.pid}.ready`,
    );
    fs.writeFileSync(ready, "ready\n", { flag: "wx" });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(gate)) {
      if (Date.now() >= deadline) {
        throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_RACE_GATE_TIMEOUT");
      }
      sleep(10);
    }
    try {
      const lock = acquirePrePullLock(directory);
      try {
        fs.writeFileSync(winner, `${process.pid}\n`, { flag: "wx" });
        process.stdout.write("RACE_WINNER\n");
        sleep(1_000);
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error?.message === "HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING") {
        process.stdout.write("RACE_BLOCKED\n");
        return;
      }
      throw error;
    }
    return;
  }
  await main();
}

dispatch().catch((error) => {
  const code = error?.code || error?.message || "DEPLOY_FAILED";
  console.error(`\n⛔ فشل النشر: ${code}`);
  if (String(code).startsWith("PM2_VERSION_UNSUPPORTED")) {
    console.error("   نفّذ كـ root: sudo npm install -g pm2@7.0.3");
    console.error("   ثم: sudo -iu deploy pm2 update");
  }
  if (code === "DEPLOY_IDENTITY_INVALID") {
    console.error(
      "   نفّذ: sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'",
    );
  }
  if (code === "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_OK") {
    console.error("   فشل المرشح، لكن الإصدار السابق أُعيد وتحقق ثم حُفظ بنجاح.");
  }
  if (code === "HR_BRIDGE_ACTIVATION_FAILED_NO_BASELINE") {
    console.error(
      "   فشل أول مرشح بعد إثبات غياب العامل؛ أزيل المرشح ولم يُسمَّ ذلك rollback.",
    );
  }
  if (code === "HR_BRIDGE_LEGACY_ADOPTION_REQUIRED") {
    console.error(
      "   بقي عامل legacy بلا baseline؛ لم يُنفَّذ git pull ولم تُمس العملية. اتبع قسم adopter في docs/deployment-vps.md.",
    );
  }
  if (code === "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_FAILED") {
    console.error("   فشل المرشح وفشل الرجوع؛ بقي journal لمنع أي نشر جديد حتى التعافي.");
    process.exitCode = 2;
    return;
  }
  console.error("   لا تنفّذ db:restore تلقائياً؛ الاستعادة تتطلب إثبات تلف بيانات وقراراً موثقاً.");
  process.exitCode = 1;
});
