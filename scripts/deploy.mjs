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
const WEB_ARTIFACT_ID = /^web-[a-z0-9][a-z0-9._-]{0,126}$/;
const WEB_ARTIFACT_RETENTION = 3;

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertPlainDirectory(directory, code) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError(code);
  return stat;
}

function assertPlainFile(file, code) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw codedError(code);
  }
}

function assertWebArtifactReady(directory, code) {
  assertPlainDirectory(directory, code);
  assertPlainFile(path.join(directory, "index.js"), code);
  assertPlainDirectory(path.join(directory, "public"), code);
  assertPlainFile(path.join(directory, "public", "index.html"), code);
}

function ensureWebReleaseRoot(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  assertPlainDirectory(resolvedRoot, "WEB_ARTIFACT_PROJECT_ROOT_INVALID");
  const runtimeRoot = path.join(resolvedRoot, ".runtime");
  if (fs.existsSync(runtimeRoot)) {
    assertPlainDirectory(runtimeRoot, "WEB_ARTIFACT_RUNTIME_ROOT_INVALID");
  } else {
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  }
  const releasesRoot = path.join(runtimeRoot, "web-releases");
  if (fs.existsSync(releasesRoot)) {
    assertPlainDirectory(releasesRoot, "WEB_ARTIFACT_RELEASE_ROOT_INVALID");
  } else {
    fs.mkdirSync(releasesRoot, { mode: 0o700 });
  }
  if (fs.lstatSync(resolvedRoot).dev !== fs.lstatSync(releasesRoot).dev) {
    throw codedError("WEB_ARTIFACT_RELEASE_CROSS_DEVICE");
  }
  return { projectRoot: resolvedRoot, releasesRoot };
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function snapshotWebArtifact(projectRoot, options = {}) {
  const { projectRoot: resolvedRoot, releasesRoot } = ensureWebReleaseRoot(projectRoot);
  const id = options.id ?? `web-${Date.now()}-${randomUUID().slice(0, 12)}`;
  if (!WEB_ARTIFACT_ID.test(id)) throw codedError("WEB_ARTIFACT_ID_INVALID");
  const distPath = path.join(resolvedRoot, "dist");
  assertWebArtifactReady(distPath, "WEB_ARTIFACT_BASELINE_INVALID");
  if (fs.lstatSync(distPath).dev !== fs.lstatSync(releasesRoot).dev) {
    throw codedError("WEB_ARTIFACT_RELEASE_CROSS_DEVICE");
  }

  const releaseDirectory = path.join(releasesRoot, id);
  const temporaryDirectory = path.join(releasesRoot, `.tmp-${id}-${randomUUID()}`);
  if (fs.existsSync(releaseDirectory) || fs.existsSync(temporaryDirectory)) {
    throw codedError("WEB_ARTIFACT_RELEASE_EXISTS");
  }
  const previousPath = path.join(releaseDirectory, "previous");
  const failedCandidatePath = path.join(releaseDirectory, "failed-candidate");
  try {
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
    const temporaryPrevious = path.join(temporaryDirectory, "previous");
    fs.cpSync(distPath, temporaryPrevious, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    assertWebArtifactReady(temporaryPrevious, "WEB_ARTIFACT_BASELINE_COPY_INVALID");
    fs.writeFileSync(
      path.join(temporaryDirectory, "metadata.json"),
      `${JSON.stringify({ version: 1, id, createdAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temporaryDirectory, releaseDirectory);
    fsyncDirectory(releasesRoot);
  } catch (error) {
    if (fs.existsSync(temporaryDirectory)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    throw codedError("WEB_ARTIFACT_SNAPSHOT_FAILED", error);
  }
  return Object.freeze({
    id,
    projectRoot: resolvedRoot,
    releasesRoot,
    releaseDirectory,
    distPath,
    previousPath,
    failedCandidatePath,
  });
}

function validateWebArtifactSnapshot(snapshot) {
  const roots = ensureWebReleaseRoot(snapshot?.projectRoot ?? "");
  if (!WEB_ARTIFACT_ID.test(snapshot?.id ?? "")) {
    throw codedError("WEB_ARTIFACT_SNAPSHOT_INVALID");
  }
  const expectedRelease = path.join(roots.releasesRoot, snapshot.id);
  if (
    path.resolve(snapshot.releasesRoot) !== roots.releasesRoot ||
    path.resolve(snapshot.releaseDirectory) !== expectedRelease ||
    path.resolve(snapshot.distPath) !== path.join(roots.projectRoot, "dist") ||
    path.resolve(snapshot.previousPath) !== path.join(expectedRelease, "previous") ||
    path.resolve(snapshot.failedCandidatePath) !== path.join(expectedRelease, "failed-candidate")
  ) {
    throw codedError("WEB_ARTIFACT_SNAPSHOT_INVALID");
  }
  assertPlainDirectory(expectedRelease, "WEB_ARTIFACT_SNAPSHOT_INVALID");
  assertWebArtifactReady(snapshot.previousPath, "WEB_ARTIFACT_BASELINE_INVALID");
  if (fs.existsSync(snapshot.failedCandidatePath)) {
    throw codedError("WEB_ARTIFACT_FAILED_CANDIDATE_EXISTS");
  }
  return roots;
}

export function rollbackWebArtifact(snapshot, operations) {
  const roots = validateWebArtifactSnapshot(snapshot);
  if (typeof operations?.reload !== "function" || typeof operations?.health !== "function") {
    throw codedError("WEB_ARTIFACT_ROLLBACK_OPERATIONS_INVALID");
  }
  const candidateExists = fs.existsSync(snapshot.distPath);
  if (candidateExists) {
    assertPlainDirectory(snapshot.distPath, "WEB_ARTIFACT_CANDIDATE_INVALID");
    if (fs.lstatSync(snapshot.distPath).dev !== fs.lstatSync(snapshot.previousPath).dev) {
      throw codedError("WEB_ARTIFACT_RELEASE_CROSS_DEVICE");
    }
    fs.renameSync(snapshot.distPath, snapshot.failedCandidatePath);
  }
  try {
    fs.renameSync(snapshot.previousPath, snapshot.distPath);
  } catch (error) {
    let restoreError = null;
    if (candidateExists && !fs.existsSync(snapshot.distPath)) {
      try {
        fs.renameSync(snapshot.failedCandidatePath, snapshot.distPath);
      } catch (candidateRestoreError) {
        restoreError = candidateRestoreError;
      }
    }
    throw codedError(
      "WEB_ARTIFACT_SWAP_FAILED",
      restoreError ? new AggregateError([error, restoreError]) : error,
    );
  }
  fsyncDirectory(roots.projectRoot);
  fsyncDirectory(snapshot.releaseDirectory);
  try {
    operations.reload();
    operations.health();
  } catch (error) {
    throw codedError("WEB_ARTIFACT_ROLLBACK_RUNTIME_FAILED", error);
  }
  return snapshot;
}

export function pruneWebArtifactSnapshots(projectRoot, options = {}) {
  const { releasesRoot } = ensureWebReleaseRoot(projectRoot);
  const keepRecent = options.keepRecent ?? WEB_ARTIFACT_RETENTION;
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 1 || keepRecent > 20) {
    throw codedError("WEB_ARTIFACT_RETENTION_INVALID");
  }
  const protectedIds = new Set(options.protectedIds ?? []);
  if ([...protectedIds].some((id) => !WEB_ARTIFACT_ID.test(id))) {
    throw codedError("WEB_ARTIFACT_RETENTION_PROTECTION_INVALID");
  }
  const entries = [];
  const temporaryEntries = [];
  for (const name of fs.readdirSync(releasesRoot)) {
    if (/^\.tmp-web-[a-z0-9][a-z0-9._-]*-[0-9a-f-]{36}$/i.test(name)) {
      const directory = path.join(releasesRoot, name);
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw codedError("WEB_ARTIFACT_RELEASE_ENTRY_INVALID");
      }
      temporaryEntries.push(directory);
      continue;
    }
    if (!WEB_ARTIFACT_ID.test(name)) continue;
    const directory = path.join(releasesRoot, name);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw codedError("WEB_ARTIFACT_RELEASE_ENTRY_INVALID");
    }
    entries.push({ name, directory, mtimeMs: stat.mtimeMs });
  }
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  const kept = new Set(entries.filter((entry) => protectedIds.has(entry.name)).map((entry) => entry.name));
  for (const entry of entries) {
    if (kept.size >= keepRecent) break;
    kept.add(entry.name);
  }
  let removed = 0;
  for (const directory of temporaryEntries) {
    fs.rmSync(directory, { recursive: true, force: false });
    removed++;
  }
  for (const entry of entries) {
    if (kept.has(entry.name)) continue;
    fs.rmSync(entry.directory, { recursive: true, force: false });
    removed++;
  }
  if (removed > 0) fsyncDirectory(releasesRoot);
  return { kept: kept.size, removed };
}

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

function readDeploymentEnvironmentFile(dotenvConfig) {
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
  return parsed;
}

function readBridgeDeploymentEnvironment(policy, dotenvConfig) {
  const parsed = readDeploymentEnvironmentFile(dotenvConfig);
  const environment = {};
  for (const key of policy.allowedEnvironmentKeys) {
    if (typeof parsed[key] === "string") environment[key] = parsed[key];
  }
  environment.NODE_ENV = "production";
  environment.TZ = "UTC";
  environment.HR_BRIDGE_LOAD_DOTENV = "0";
  return environment;
}

function readWebHealthEnvironment(dotenvConfig) {
  const parsed = readDeploymentEnvironmentFile(dotenvConfig);
  const port = Number(parsed.PORT || 3000);
  const requireSecret = parsed.REQUIRE_INTERNAL_PROXY_SECRET === "1" ? "1" : "0";
  const secret = parsed.INTERNAL_PROXY_SECRET?.trim() ?? "";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw codedError("WEB_HEALTH_PORT_INVALID");
  }
  if (requireSecret === "1" && !/^[a-f0-9]{64}$/i.test(secret)) {
    throw codedError("WEB_HEALTH_PROXY_SECRET_INVALID");
  }
  return {
    PORT: String(port),
    REQUIRE_INTERNAL_PROXY_SECRET: requireSecret,
    ...(requireSecret === "1" ? { INTERNAL_PROXY_SECRET: secret } : {}),
  };
}

function reloadWebProcess() {
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
  );
}

const INTERNAL_WEB_HEALTH_SCRIPT = String.raw`
const port = Number(process.env.PORT || 3000);
const headers = {};
if (process.env.REQUIRE_INTERNAL_PROXY_SECRET === "1") {
  const secret = process.env.INTERNAL_PROXY_SECRET || "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) process.exit(2);
  headers["X-Internal-Proxy-Secret"] = secret;
}
let healthy = false;
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/healthz", {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (response.ok && body?.ok === true) {
      healthy = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!healthy) process.exit(3);
`;

function verifyInternalWebHealth(environment) {
  run(process.execPath, ["--input-type=module", "-e", INTERNAL_WEB_HEALTH_SCRIPT], {
    timeoutMs: 20_000,
    env: { ...controlSubprocessEnvironment(), ...environment },
  });
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
    step("1/11 تثبيت الاعتماديات المقفلة", () =>
      run("pnpm", ["install", "--frozen-lockfile"], {
        timeoutMs: 5 * 60_000,
      }),
    );
    const dotenvModule = await import("dotenv");
    const deploymentEnvironment = readBridgeDeploymentEnvironment(
      policy,
      dotenvModule.config,
    );
    const webHealthEnvironment = readWebHealthEnvironment(dotenvModule.config);
    let webArtifact = null;
    let candidate = null;
    let committed = null;
    let smokeStarted = false;
    try {
      step("2/11 حفظ إصدار الويب السابق ثم بناء المرشح وفحص Nginx", () => {
        webArtifact = snapshotWebArtifact(PROJECT_ROOT, {
          id: `web-${Date.now()}-${expectedHead.slice(0, 12)}`,
        });
        pruneWebArtifactSnapshots(PROJECT_ROOT, {
          keepRecent: WEB_ARTIFACT_RETENTION,
          protectedIds: [webArtifact.id],
        });
        run("pnpm", ["build"], { timeoutMs: 10 * 60_000 });
        run(process.execPath, ["scripts/verify-nginx-abuse-controls.mjs"], {
          timeoutMs: 30_000,
        });
      });
      const repository = assertRepository(expectedHead);
      if (repository.head !== repository.remote) {
        throw new Error("DEPLOY_HEAD_NOT_ORIGIN_MAIN");
      }
      const candidateRelease = releaseTools.prepareRelease(PROJECT_ROOT, {
        sourceCommit: expectedHead,
        deploymentEnvironment,
      });
      const provisional = { id: candidateRelease.id, mode: "enabled" };
      const beforeMode = step("3/11 فحص المرشح قبل لمس قاعدة البيانات", () =>
        runPreflight(provisional, releaseTools),
      );

      step("4/11 إنشاء نسخة احتياطية", () => run("pnpm", ["db:backup"]));
      step("5/11 تطبيق الهجرات الآمنة وإصلاح الاستقبال والتوصيل", () => {
        run("pnpm", ["db:migrate:safe"]);
        run("node", [
          "scripts/ci-apply-extra-migrations.mjs",
          "--only=drizzle/migrations/0178_repair_reception_schema_drift.sql",
        ]);
        run("node", [
          "scripts/ci-apply-extra-migrations.mjs",
          "--only=drizzle/migrations/extras/0178_delivery_phase2_state_and_ledgers.sql",
        ]);
      });
      step("6/11 التحقق من مخطط قاعدة البيانات", () =>
        run("pnpm", ["db:verify"], { timeoutMs: 5 * 60_000 }),
      );

      const afterMode = step("7/11 فحص المرشح بعد الهجرات", () =>
        runPreflight(provisional, releaseTools),
      );
      if (beforeMode !== afterMode) {
        throw new Error("HR_BRIDGE_MODE_CHANGED_DURING_DEPLOY");
      }
      candidate = { id: candidateRelease.id, mode: afterMode };
      committed = releaseTools.readState(PROJECT_ROOT).current;
      if (committed) {
        step("8/11 إثبات صلاحية إصدار الرجوع مع المخطط الجديد", () => {
          const rollbackMode = runPreflight(committed, releaseTools);
          if (rollbackMode !== committed.mode) {
            throw new Error("HR_BRIDGE_ROLLBACK_MODE_DRIFT");
          }
        });
      } else {
        console.log("\n▶ 8/11 لا يوجد إصدار immutable سابق (أول انتقال فقط)." );
      }

      step("9/11 إعادة تحميل خادم الويب", reloadWebProcess);

      smokeStarted = true;
      step("10/11 فحص المتجر خارجياً عبر المضيفين", () =>
        run(process.execPath, ["scripts/verify-nginx-storefront-readiness.mjs"], {
          timeoutMs: 5 * 60_000,
        }),
      );
    } catch (candidateError) {
      if (!webArtifact) throw candidateError;
      try {
        step("رجوع آمن إلى إصدار الويب السابق والتحقق الداخلي", () =>
          rollbackWebArtifact(webArtifact, {
            reload: reloadWebProcess,
            health: () => verifyInternalWebHealth(webHealthEnvironment),
          }),
        );
        try {
          pruneWebArtifactSnapshots(PROJECT_ROOT, {
            keepRecent: WEB_ARTIFACT_RETENTION,
            protectedIds: [webArtifact.id],
          });
        } catch {
          console.warn("WEB_ARTIFACT_RETENTION_DEFERRED");
        }
      } catch (rollbackError) {
        throw codedError(
          "WEB_CANDIDATE_FAILED_ROLLBACK_FAILED",
          new AggregateError([candidateError, rollbackError]),
        );
      }
      throw codedError(
        smokeStarted
          ? "WEB_STOREFRONT_SMOKE_FAILED_ROLLBACK_OK"
          : "WEB_CANDIDATE_FAILED_ROLLBACK_OK",
        candidateError,
      );
    }

    step("11/11 تفعيل إصدار الجسر والتحقق والحفظ الذري", () => {
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
    try {
      pruneWebArtifactSnapshots(PROJECT_ROOT, {
        keepRecent: WEB_ARTIFACT_RETENTION,
        protectedIds: [webArtifact.id],
      });
    } catch {
      console.warn("WEB_ARTIFACT_RETENTION_DEFERRED");
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

function reportDeploymentFailure(error) {
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
  if (code === "WEB_STOREFRONT_SMOKE_FAILED_ROLLBACK_OK") {
    console.error("   فشل فحص المتجر؛ أُعيد إصدار الويب السابق وتحققت صحته داخلياً، وحُفظ المرشح الفاشل للتشخيص.");
  }
  if (code === "WEB_CANDIDATE_FAILED_ROLLBACK_OK") {
    console.error("   فشل مرشح الويب قبل الجاهزية؛ أُعيد الإصدار السابق وتحققت صحته داخلياً.");
  }
  if (code === "WEB_CANDIDATE_FAILED_ROLLBACK_FAILED") {
    console.error("   فشل مرشح الويب وفشل الرجوع أو التحقق الداخلي؛ يلزم تدخل تشغيلي فوري.");
    process.exitCode = 2;
    return;
  }
  console.error("   لا تنفّذ db:restore تلقائياً؛ الاستعادة تتطلب إثبات تلف بيانات وقراراً موثقاً.");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === DEPLOY_SCRIPT) {
  dispatch().catch(reportDeploymentFailure);
}
