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
import { createServer as createNetServer } from "node:net";
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
const WEB_CANDIDATE_ID = /^candidate-[a-z0-9][a-z0-9._-]{0,122}$/;
const WEB_ACTIVATION_JOURNAL = "web-activation-pending.json";
const WEB_FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
  "DB_ROOT_PW",
  "DB_CONTAINER",
  "DB_APP_PW",
  "DB_CONTROL_PW",
  "ADMIN_PASSWORD",
]);

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

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
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
  return { projectRoot: resolvedRoot, runtimeRoot, releasesRoot };
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

function fsyncFile(file) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(file, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function webActivationJournalPath(projectRoot) {
  return path.join(
    path.resolve(projectRoot),
    ".runtime",
    WEB_ACTIVATION_JOURNAL,
  );
}

function assertWebRuntimePrivate(runtimeRoot) {
  const stat = assertPlainDirectory(
    runtimeRoot,
    "WEB_ACTIVATION_RUNTIME_INVALID",
  );
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()))
  ) {
    throw codedError("WEB_ACTIVATION_RUNTIME_SECURITY_INVALID");
  }
}

function pendingWebActivationSnapshot(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const journalPath = webActivationJournalPath(resolvedRoot);
  const journalStat = lstatOrNull(journalPath);
  if (!journalStat) return null;
  const runtimeRoot = path.dirname(journalPath);
  assertWebRuntimePrivate(runtimeRoot);
  if (
    !journalStat.isFile() ||
    journalStat.isSymbolicLink() ||
    journalStat.size < 20 ||
    journalStat.size > 4096 ||
    (process.platform !== "win32" &&
      ((journalStat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" &&
          journalStat.uid !== process.getuid())))
  ) {
    throw codedError("WEB_ACTIVATION_JOURNAL_INVALID");
  }
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw codedError("WEB_ACTIVATION_JOURNAL_INVALID", error);
  }
  if (
    journal?.version !== 1 ||
    journal?.phase !== "pending" ||
    !WEB_ARTIFACT_ID.test(journal?.id ?? "") ||
    journal?.previous !==
      path.join("web-releases", journal?.id ?? "", "previous") ||
    journal?.candidate !==
      path.join("web-releases", journal?.id ?? "", "candidate")
  ) {
    throw codedError("WEB_ACTIVATION_JOURNAL_INVALID");
  }
  const roots = ensureWebReleaseRoot(resolvedRoot);
  const releaseDirectory = path.join(roots.releasesRoot, journal.id);
  const metadataPath = path.join(releaseDirectory, "metadata.json");
  assertPlainFile(metadataPath, "WEB_ACTIVATION_RELEASE_INVALID");
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    throw codedError("WEB_ACTIVATION_RELEASE_INVALID", error);
  }
  if (metadata?.version !== 2 || metadata?.id !== journal.id) {
    throw codedError("WEB_ACTIVATION_RELEASE_INVALID");
  }
  const snapshot = Object.freeze({
    id: journal.id,
    projectRoot: roots.projectRoot,
    runtimeRoot: roots.runtimeRoot,
    releasesRoot: roots.releasesRoot,
    releaseDirectory,
    legacyDistPath: path.join(roots.projectRoot, "dist"),
    activeLinkPath: path.join(roots.runtimeRoot, "web-current"),
    previousPath: path.join(releaseDirectory, "previous"),
    candidatePath: path.join(releaseDirectory, "candidate"),
  });
  validateWebArtifactSnapshot(snapshot);
  assertWebArtifactReady(
    snapshot.candidatePath,
    "WEB_ACTIVATION_CANDIDATE_INVALID",
  );
  return snapshot;
}

export function hasPendingWebActivation(projectRoot) {
  return lstatOrNull(webActivationJournalPath(projectRoot)) !== null;
}

function writeWebActivationJournal(snapshot) {
  validateWebArtifactSnapshot(snapshot);
  assertWebArtifactReady(
    snapshot.candidatePath,
    "WEB_ACTIVATION_CANDIDATE_INVALID",
  );
  assertWebRuntimePrivate(snapshot.runtimeRoot);
  const target = webActivationJournalPath(snapshot.projectRoot);
  if (lstatOrNull(target)) {
    throw codedError("WEB_ACTIVATION_PENDING_ALREADY_EXISTS");
  }
  const temporary = path.join(
    snapshot.runtimeRoot,
    `.web-activation-stage-${randomUUID()}.json`,
  );
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 1,
        phase: "pending",
        id: snapshot.id,
        previous: path.relative(snapshot.runtimeRoot, snapshot.previousPath),
        candidate: path.relative(snapshot.runtimeRoot, snapshot.candidatePath),
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fsyncFile(temporary);
    fs.renameSync(temporary, target);
    fsyncDirectory(snapshot.runtimeRoot);
  } finally {
    if (lstatOrNull(temporary)) fs.unlinkSync(temporary);
  }
}

function clearWebActivationJournal(snapshot) {
  const pending = pendingWebActivationSnapshot(snapshot.projectRoot);
  if (!pending) return;
  if (pending.id !== snapshot.id) {
    throw codedError("WEB_ACTIVATION_JOURNAL_MISMATCH");
  }
  fs.unlinkSync(webActivationJournalPath(snapshot.projectRoot));
  fsyncDirectory(snapshot.runtimeRoot);
}

export function snapshotWebArtifact(projectRoot, options = {}) {
  const {
    projectRoot: resolvedRoot,
    runtimeRoot,
    releasesRoot,
  } = ensureWebReleaseRoot(projectRoot);
  const id = options.id ?? `web-${Date.now()}-${randomUUID().slice(0, 12)}`;
  if (!WEB_ARTIFACT_ID.test(id)) throw codedError("WEB_ARTIFACT_ID_INVALID");
  const legacyDistPath = path.join(resolvedRoot, "dist");
  const activeLinkPath = path.join(runtimeRoot, "web-current");
  let baselinePath = legacyDistPath;
  const existingActiveLink = lstatOrNull(activeLinkPath);
  if (existingActiveLink) {
    const activeStat = existingActiveLink;
    if (!activeStat.isSymbolicLink()) {
      throw codedError("WEB_ARTIFACT_CURRENT_LINK_INVALID");
    }
    baselinePath = path.resolve(
      path.dirname(activeLinkPath),
      fs.readlinkSync(activeLinkPath),
    );
    if (!baselinePath.startsWith(`${releasesRoot}${path.sep}`)) {
      throw codedError("WEB_ARTIFACT_CURRENT_LINK_INVALID");
    }
  }
  assertWebArtifactReady(baselinePath, "WEB_ARTIFACT_BASELINE_INVALID");
  if (fs.lstatSync(baselinePath).dev !== fs.lstatSync(releasesRoot).dev) {
    throw codedError("WEB_ARTIFACT_RELEASE_CROSS_DEVICE");
  }

  const releaseDirectory = path.join(releasesRoot, id);
  const temporaryDirectory = path.join(
    releasesRoot,
    `.tmp-${id}-${randomUUID()}`,
  );
  if (fs.existsSync(releaseDirectory) || fs.existsSync(temporaryDirectory)) {
    throw codedError("WEB_ARTIFACT_RELEASE_EXISTS");
  }
  const previousPath = path.join(releaseDirectory, "previous");
  const candidatePath = path.join(releaseDirectory, "candidate");
  try {
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
    const temporaryPrevious = path.join(temporaryDirectory, "previous");
    fs.cpSync(baselinePath, temporaryPrevious, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    assertWebArtifactReady(
      temporaryPrevious,
      "WEB_ARTIFACT_BASELINE_COPY_INVALID",
    );
    fs.writeFileSync(
      path.join(temporaryDirectory, "metadata.json"),
      `${JSON.stringify({ version: 2, id, createdAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temporaryDirectory, releaseDirectory);
    fsyncDirectory(releasesRoot);
    if (!existingActiveLink) {
      const temporaryLink = path.join(
        runtimeRoot,
        `.web-current-stage-${randomUUID()}`,
      );
      createWebDirectoryLink(previousPath, temporaryLink);
      fs.renameSync(temporaryLink, activeLinkPath);
      fsyncDirectory(runtimeRoot);
    }
  } catch (error) {
    if (fs.existsSync(temporaryDirectory)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    throw codedError("WEB_ARTIFACT_SNAPSHOT_FAILED", error);
  }
  return Object.freeze({
    id,
    projectRoot: resolvedRoot,
    runtimeRoot,
    releasesRoot,
    releaseDirectory,
    legacyDistPath,
    activeLinkPath,
    previousPath,
    candidatePath,
  });
}

function validateWebArtifactSnapshot(snapshot) {
  const roots = ensureWebReleaseRoot(snapshot?.projectRoot ?? "");
  if (!WEB_ARTIFACT_ID.test(snapshot?.id ?? "")) {
    throw codedError("WEB_ARTIFACT_SNAPSHOT_INVALID");
  }
  const expectedRelease = path.join(roots.releasesRoot, snapshot.id);
  if (
    path.resolve(snapshot.runtimeRoot) !== roots.runtimeRoot ||
    path.resolve(snapshot.releasesRoot) !== roots.releasesRoot ||
    path.resolve(snapshot.releaseDirectory) !== expectedRelease ||
    path.resolve(snapshot.legacyDistPath) !==
      path.join(roots.projectRoot, "dist") ||
    path.resolve(snapshot.activeLinkPath) !==
      path.join(roots.runtimeRoot, "web-current") ||
    path.resolve(snapshot.previousPath) !==
      path.join(expectedRelease, "previous") ||
    path.resolve(snapshot.candidatePath) !==
      path.join(expectedRelease, "candidate")
  ) {
    throw codedError("WEB_ARTIFACT_SNAPSHOT_INVALID");
  }
  assertPlainDirectory(expectedRelease, "WEB_ARTIFACT_SNAPSHOT_INVALID");
  assertWebArtifactReady(
    snapshot.previousPath,
    "WEB_ARTIFACT_BASELINE_INVALID",
  );
  const activeStat = fs.lstatSync(snapshot.activeLinkPath);
  if (!activeStat.isSymbolicLink()) {
    throw codedError("WEB_ARTIFACT_CURRENT_LINK_INVALID");
  }
  return roots;
}

function createWebDirectoryLink(target, link) {
  if (process.platform === "win32") {
    fs.symlinkSync(path.resolve(target), link, "junction");
    return;
  }
  fs.symlinkSync(path.relative(path.dirname(link), target), link, "dir");
}

function replaceWebCurrentLink(activeLinkPath, target, runtimeRoot) {
  const temporaryLink = path.join(
    runtimeRoot,
    `.web-current-stage-${randomUUID()}`,
  );
  try {
    createWebDirectoryLink(target, temporaryLink);
    if (process.platform === "win32") {
      // Production deployment is Linux-only. Windows lacks POSIX atomic
      // replacement of an existing directory junction; this branch exists
      // solely so the cross-platform unit suite can exercise release logic.
      if (lstatOrNull(activeLinkPath)) fs.unlinkSync(activeLinkPath);
      fs.renameSync(temporaryLink, activeLinkPath);
    } else {
      fs.renameSync(temporaryLink, activeLinkPath);
    }
    fsyncDirectory(runtimeRoot);
  } finally {
    if (lstatOrNull(temporaryLink)) fs.unlinkSync(temporaryLink);
  }
}

export function isWebCandidateActive(snapshot) {
  validateWebArtifactSnapshot(snapshot);
  const stat = lstatOrNull(snapshot.activeLinkPath);
  if (!stat?.isSymbolicLink()) return false;
  return (
    path.resolve(
      path.dirname(snapshot.activeLinkPath),
      fs.readlinkSync(snapshot.activeLinkPath),
    ) === path.resolve(snapshot.candidatePath)
  );
}

function ensureWebCandidateRoot(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  assertPlainDirectory(resolvedRoot, "WEB_CANDIDATE_PROJECT_ROOT_INVALID");
  const runtimeRoot = path.join(resolvedRoot, ".runtime");
  if (fs.existsSync(runtimeRoot)) {
    assertPlainDirectory(runtimeRoot, "WEB_CANDIDATE_RUNTIME_ROOT_INVALID");
  } else {
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  }
  const candidatesRoot = path.join(runtimeRoot, "web-candidates");
  if (fs.existsSync(candidatesRoot)) {
    assertPlainDirectory(candidatesRoot, "WEB_CANDIDATE_ROOT_INVALID");
  } else {
    fs.mkdirSync(candidatesRoot, { mode: 0o700 });
  }
  if (fs.lstatSync(resolvedRoot).dev !== fs.lstatSync(candidatesRoot).dev) {
    throw codedError("WEB_CANDIDATE_CROSS_DEVICE");
  }
  return { projectRoot: resolvedRoot, candidatesRoot };
}

function defaultWebCandidateOperations(projectRoot) {
  return Object.freeze({
    createWorktree: (sourceRoot, expectedSha) =>
      execFileSync(
        "git",
        ["worktree", "add", "--detach", sourceRoot, expectedSha],
        {
          cwd: projectRoot,
          stdio: "inherit",
          timeout: 60_000,
        },
      ),
    linkDependencies: (sourceRoot) => {
      const dependencies = path.join(projectRoot, "node_modules");
      assertPlainDirectory(dependencies, "WEB_CANDIDATE_DEPENDENCIES_INVALID");
      fs.symlinkSync(
        dependencies,
        path.join(sourceRoot, "node_modules"),
        "dir",
      );
      const environment = path.join(projectRoot, ".env");
      assertPlainFile(environment, "WEB_CANDIDATE_ENVIRONMENT_INVALID");
      fs.symlinkSync(environment, path.join(sourceRoot, ".env"), "file");
    },
    build: (sourceRoot) =>
      execFileSync("pnpm", ["build"], {
        cwd: sourceRoot,
        stdio: "inherit",
        timeout: 10 * 60_000,
      }),
    removeWorktree: (sourceRoot) =>
      execFileSync("git", ["worktree", "remove", "--force", sourceRoot], {
        cwd: projectRoot,
        stdio: "ignore",
        timeout: 60_000,
      }),
  });
}

function validateWebCandidate(candidate) {
  const roots = ensureWebCandidateRoot(candidate?.projectRoot ?? "");
  if (!WEB_CANDIDATE_ID.test(candidate?.id ?? "")) {
    throw codedError("WEB_CANDIDATE_INVALID");
  }
  const expectedDirectory = path.join(roots.candidatesRoot, candidate.id);
  const expectedSourceRoot = path.join(expectedDirectory, "source");
  if (
    path.resolve(candidate.candidateDirectory) !== expectedDirectory ||
    path.resolve(candidate.sourceRoot) !== expectedSourceRoot ||
    path.resolve(candidate.distPath) !== path.join(expectedSourceRoot, "dist")
  ) {
    throw codedError("WEB_CANDIDATE_INVALID");
  }
  assertPlainDirectory(expectedDirectory, "WEB_CANDIDATE_INVALID");
  assertPlainDirectory(expectedSourceRoot, "WEB_CANDIDATE_INVALID");
  assertWebArtifactReady(candidate.distPath, "WEB_CANDIDATE_ARTIFACT_INVALID");
  return roots;
}

export function prepareWebCandidate(projectRoot, options = {}) {
  const roots = ensureWebCandidateRoot(projectRoot);
  const expectedSha = options.expectedSha;
  if (!SHA.test(expectedSha ?? ""))
    throw codedError("WEB_CANDIDATE_SHA_INVALID");
  const id =
    options.id ?? `candidate-${Date.now()}-${randomUUID().slice(0, 12)}`;
  if (!WEB_CANDIDATE_ID.test(id)) throw codedError("WEB_CANDIDATE_ID_INVALID");
  const candidateDirectory = path.join(roots.candidatesRoot, id);
  const sourceRoot = path.join(candidateDirectory, "source");
  const operations =
    options.operations ?? defaultWebCandidateOperations(roots.projectRoot);
  if (fs.existsSync(candidateDirectory))
    throw codedError("WEB_CANDIDATE_EXISTS");
  fs.mkdirSync(candidateDirectory, { mode: 0o700 });
  let worktreeCreated = false;
  try {
    operations.createWorktree(sourceRoot, expectedSha);
    worktreeCreated = true;
    assertPlainDirectory(sourceRoot, "WEB_CANDIDATE_WORKTREE_INVALID");
    operations.linkDependencies(sourceRoot);
    operations.build(sourceRoot);
    const distPath = path.join(sourceRoot, "dist");
    assertWebArtifactReady(distPath, "WEB_CANDIDATE_BUILD_INVALID");
    fsyncDirectory(candidateDirectory);
    return Object.freeze({
      id,
      projectRoot: roots.projectRoot,
      candidatesRoot: roots.candidatesRoot,
      candidateDirectory,
      sourceRoot,
      distPath,
      operations,
    });
  } catch (error) {
    if (worktreeCreated) {
      try {
        operations.removeWorktree(sourceRoot);
      } catch {
        // The candidate directory is ignored and never becomes live. Retain it
        // when the worktree registry cannot be cleaned safely.
      }
    }
    if (fs.existsSync(candidateDirectory) && !fs.existsSync(sourceRoot)) {
      fs.rmSync(candidateDirectory, { recursive: true, force: false });
    }
    throw codedError("WEB_CANDIDATE_BUILD_FAILED", error);
  }
}

export function installWebCandidate(snapshot, candidate) {
  const snapshotRoots = validateWebArtifactSnapshot(snapshot);
  const candidateRoots = validateWebCandidate(candidate);
  if (snapshotRoots.projectRoot !== candidateRoots.projectRoot) {
    throw codedError("WEB_CANDIDATE_PROJECT_MISMATCH");
  }
  if (
    fs.lstatSync(snapshot.releaseDirectory).dev !==
      fs.lstatSync(candidate.distPath).dev ||
    fs.existsSync(snapshot.candidatePath)
  ) {
    throw codedError("WEB_CANDIDATE_ATOMIC_SWAP_INVALID");
  }
  try {
    fs.renameSync(candidate.distPath, snapshot.candidatePath);
    assertWebArtifactReady(
      snapshot.candidatePath,
      "WEB_CANDIDATE_ARTIFACT_INVALID",
    );
    fsyncDirectory(snapshot.releaseDirectory);
    writeWebActivationJournal(snapshot);
    replaceWebCurrentLink(
      snapshot.activeLinkPath,
      snapshot.candidatePath,
      snapshot.runtimeRoot,
    );
  } catch (error) {
    throw codedError("WEB_CANDIDATE_ATOMIC_SWAP_FAILED", error);
  }
  fsyncDirectory(snapshotRoots.runtimeRoot);
  return snapshot;
}

export function cleanupWebCandidate(candidate) {
  if (!candidate) return;
  const roots = ensureWebCandidateRoot(candidate.projectRoot);
  const expectedDirectory = path.join(roots.candidatesRoot, candidate.id);
  if (
    !WEB_CANDIDATE_ID.test(candidate.id ?? "") ||
    path.resolve(candidate.candidateDirectory) !== expectedDirectory ||
    path.resolve(candidate.sourceRoot) !==
      path.join(expectedDirectory, "source")
  ) {
    throw codedError("WEB_CANDIDATE_INVALID");
  }
  if (fs.existsSync(candidate.sourceRoot)) {
    candidate.operations.removeWorktree(candidate.sourceRoot);
  }
  if (fs.existsSync(candidate.candidateDirectory)) {
    assertPlainDirectory(candidate.candidateDirectory, "WEB_CANDIDATE_INVALID");
    fs.rmSync(candidate.candidateDirectory, { recursive: true, force: false });
  }
  fsyncDirectory(roots.candidatesRoot);
}

export function rollbackWebArtifact(snapshot, operations) {
  const roots = validateWebArtifactSnapshot(snapshot);
  if (
    typeof operations?.reload !== "function" ||
    typeof operations?.health !== "function"
  ) {
    throw codedError("WEB_ARTIFACT_ROLLBACK_OPERATIONS_INVALID");
  }
  try {
    replaceWebCurrentLink(
      snapshot.activeLinkPath,
      snapshot.previousPath,
      snapshot.runtimeRoot,
    );
  } catch (error) {
    throw codedError("WEB_ARTIFACT_SWAP_FAILED", error);
  }
  fsyncDirectory(roots.runtimeRoot);
  try {
    operations.reload();
    operations.health();
    clearWebActivationJournal(snapshot);
  } catch (error) {
    throw codedError("WEB_ARTIFACT_ROLLBACK_RUNTIME_FAILED", error);
  }
  return snapshot;
}

export function commitWebArtifact(snapshot) {
  if (!isWebCandidateActive(snapshot)) {
    throw codedError("WEB_ACTIVATION_CANDIDATE_NOT_ACTIVE");
  }
  clearWebActivationJournal(snapshot);
  return snapshot;
}

export function recoverPendingWebActivation(projectRoot, operations) {
  const snapshot = pendingWebActivationSnapshot(projectRoot);
  if (!snapshot) return null;
  if (
    typeof operations?.reload !== "function" ||
    typeof operations?.health !== "function"
  ) {
    throw codedError("WEB_ACTIVATION_RECOVERY_OPERATIONS_INVALID");
  }
  try {
    replaceWebCurrentLink(
      snapshot.activeLinkPath,
      snapshot.previousPath,
      snapshot.runtimeRoot,
    );
    operations.reload();
    operations.health();
    clearWebActivationJournal(snapshot);
    return snapshot;
  } catch (error) {
    throw codedError("WEB_ACTIVATION_RECOVERY_FAILED", error);
  }
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isSafeInteger(port) || port < 1) {
          reject(codedError("WEB_ROLLBACK_PREFLIGHT_PORT_INVALID"));
        } else resolve(port);
      });
    });
  });
}

function rollbackProbeHeaders(environment) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "Alroya-Deploy-Rollback-Preflight/1.0",
  };
  if (environment.REQUIRE_INTERNAL_PROXY_SECRET === "1") {
    const secret = environment.INTERNAL_PROXY_SECRET ?? "";
    if (!/^[a-f0-9]{64}$/i.test(secret)) {
      throw codedError("WEB_ROLLBACK_PREFLIGHT_SECRET_INVALID");
    }
    headers["X-Internal-Proxy-Secret"] = secret;
  }
  return headers;
}

function rollbackProbeTrpcUrl(origin, procedure, input) {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  return `${origin}/api/trpc/${procedure}?input=${encoded}`;
}

async function readRollbackProbeJson(url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw codedError("WEB_ROLLBACK_PREFLIGHT_HTTP_INVALID");
  try {
    return await response.json();
  } catch (error) {
    throw codedError("WEB_ROLLBACK_PREFLIGHT_JSON_INVALID", error);
  }
}

async function probeRollbackWebServer(child, context) {
  const origin = `http://127.0.0.1:${context.port}`;
  const headers = rollbackProbeHeaders(context.environment);
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (child.rollbackPreflightSpawnError) {
      throw codedError(
        "WEB_ROLLBACK_PREFLIGHT_START_FAILED",
        child.rollbackPreflightSpawnError,
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw codedError("WEB_ROLLBACK_PREFLIGHT_PROCESS_EXITED");
    }
    try {
      const payload = await readRollbackProbeJson(`${origin}/healthz`, headers);
      if (payload?.ok === true) {
        healthy = true;
        break;
      }
    } catch {
      // Startup is asynchronous; retry until the bounded readiness deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!healthy) throw codedError("WEB_ROLLBACK_PREFLIGHT_HEALTH_FAILED");

  const [settingsPayload, categoriesPayload, catalogPayload] =
    await Promise.all([
      readRollbackProbeJson(
        rollbackProbeTrpcUrl(origin, "storefront.settings", null),
        headers,
      ),
      readRollbackProbeJson(
        rollbackProbeTrpcUrl(origin, "storefront.categories", null),
        headers,
      ),
      readRollbackProbeJson(
        rollbackProbeTrpcUrl(origin, "storefront.catalog", { limit: 1 }),
        headers,
      ),
    ]);
  const settings = settingsPayload?.result?.data?.json;
  const categories = categoriesPayload?.result?.data?.json;
  const catalog = catalogPayload?.result?.data?.json;
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    !Array.isArray(categories) ||
    !catalog ||
    !Array.isArray(catalog.items)
  ) {
    throw codedError("WEB_ROLLBACK_PREFLIGHT_STOREFRONT_INVALID");
  }
}

async function stopRollbackProbe(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs) =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const onExit = () => {
        child.off("exit", onExit);
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) onExit();
    });
  child.kill("SIGTERM");
  if (await waitForExit(15_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(5_000))) {
    throw codedError("WEB_ROLLBACK_PREFLIGHT_STOP_FAILED");
  }
}

function defaultRollbackPreflightOperations(snapshot, environment) {
  const forbiddenEnvironment = Object.fromEntries(
    WEB_FORBIDDEN_ENVIRONMENT_KEYS.map((key) => [key, ""]),
  );
  return Object.freeze({
    reservePort: reserveLoopbackPort,
    start: (port) => {
      const child = spawn(
        process.execPath,
        [path.join(snapshot.previousPath, "index.js")],
        {
          cwd: snapshot.projectRoot,
          env: {
            ...controlSubprocessEnvironment(),
            ...forbiddenEnvironment,
            ...environment,
            NODE_ENV: "production",
            HOST: "127.0.0.1",
            PORT: String(port),
            ALLOW_PUBLIC_BIND: "0",
            NODE_APP_INSTANCE: "rollback-preflight",
            WEB_INSTANCES: "2",
          },
          stdio: "ignore",
        },
      );
      child.once("error", (error) => {
        child.rollbackPreflightSpawnError = error;
      });
      return child;
    },
    probe: probeRollbackWebServer,
    stop: stopRollbackProbe,
  });
}

export async function verifyRollbackWebArtifactCompatibility(
  snapshot,
  environment,
  options = {},
) {
  validateWebArtifactSnapshot(snapshot);
  if (
    !environment ||
    !["0", "1"].includes(environment.REQUIRE_INTERNAL_PROXY_SECRET)
  ) {
    throw codedError("WEB_ROLLBACK_PREFLIGHT_ENVIRONMENT_INVALID");
  }
  const operations =
    options.operations ??
    defaultRollbackPreflightOperations(snapshot, environment);
  if (
    typeof operations.reservePort !== "function" ||
    typeof operations.start !== "function" ||
    typeof operations.probe !== "function" ||
    typeof operations.stop !== "function"
  ) {
    throw codedError("WEB_ROLLBACK_PREFLIGHT_OPERATIONS_INVALID");
  }
  let child;
  let failure = null;
  try {
    const port = await operations.reservePort();
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw codedError("WEB_ROLLBACK_PREFLIGHT_PORT_INVALID");
    }
    child = await operations.start(port);
    if (!child) throw codedError("WEB_ROLLBACK_PREFLIGHT_START_FAILED");
    await operations.probe(child, { port, environment, snapshot });
  } catch (error) {
    failure = error;
  }
  if (child) {
    try {
      await operations.stop(child);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error]) : error;
    }
  }
  if (failure) {
    throw codedError("WEB_ROLLBACK_PREFLIGHT_FAILED", failure);
  }
  return snapshot;
}

export function pruneWebArtifactSnapshots(projectRoot, options = {}) {
  const { runtimeRoot, releasesRoot } = ensureWebReleaseRoot(projectRoot);
  const keepRecent = options.keepRecent ?? WEB_ARTIFACT_RETENTION;
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 1 || keepRecent > 20) {
    throw codedError("WEB_ARTIFACT_RETENTION_INVALID");
  }
  const protectedIds = new Set(options.protectedIds ?? []);
  if ([...protectedIds].some((id) => !WEB_ARTIFACT_ID.test(id))) {
    throw codedError("WEB_ARTIFACT_RETENTION_PROTECTION_INVALID");
  }
  const activeLinkPath = path.join(runtimeRoot, "web-current");
  const activeLinkStat = lstatOrNull(activeLinkPath);
  if (activeLinkStat) {
    const stat = activeLinkStat;
    if (!stat.isSymbolicLink()) {
      throw codedError("WEB_ARTIFACT_CURRENT_LINK_INVALID");
    }
    const activeTarget = path.resolve(
      path.dirname(activeLinkPath),
      fs.readlinkSync(activeLinkPath),
    );
    const relative = path.relative(releasesRoot, activeTarget);
    const activeId = relative.split(path.sep)[0];
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !WEB_ARTIFACT_ID.test(activeId)
    ) {
      throw codedError("WEB_ARTIFACT_CURRENT_LINK_INVALID");
    }
    protectedIds.add(activeId);
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
  entries.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
  );
  const kept = new Set(
    entries
      .filter((entry) => protectedIds.has(entry.name))
      .map((entry) => entry.name),
  );
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
  return String(run(command, args, { capture: true, timeoutMs })).trim();
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
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (top !== PROJECT_ROOT) throw new Error("DEPLOY_REPOSITORY_ROOT_INVALID");
  if (branch !== "main") throw new Error("DEPLOY_BRANCH_MUST_BE_MAIN");
  if (dirty) throw new Error("DEPLOY_WORKTREE_NOT_CLEAN");
  if (expectedSha && head !== expectedSha) {
    throw new Error("DEPLOY_REEXEC_SHA_MISMATCH");
  }
  return { head, remote };
}

function readPm2DumpRowsBeforePull() {
  const home =
    process.env.PM2_HOME?.trim() ||
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
    assertImmutableBaselineOwnsBridge(
      null,
      [],
      [{ name: BRIDGE_PROCESS_NAME, pm_exec_path: "/legacy/worker.mjs" }],
    );
  } catch (error) {
    legacyDumpBlocked = error?.message === "HR_BRIDGE_LEGACY_ADOPTION_REQUIRED";
  }
  if (!legacyDumpBlocked) {
    throw new Error("HR_BRIDGE_PREPULL_DUMP_GUARD_SELFTEST_FAILED");
  }
  console.log(
    "hr bridge pre-pull guard selftest: legacy dump blocks source mutation",
  );
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  if (entries.some((entry) => entry.file !== ownFile && entry.record.held)) {
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
    if (record.token !== match[2] || !record.pids.includes(Number(match[1]))) {
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
  const inheritedParentPid = Number(process.env[SYNC_LOCK_PARENT_PID_ENV]);
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
    writeSyncLock(
      directory,
      lockPath,
      {
        ...existing,
        pids: [...new Set([...existing.pids, process.pid])],
      },
      true,
    );
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
    const blocked = path.join(directory, "race-blocked");
    const racers = [0, 3_500].map((delayMs) =>
      spawn(
        process.execPath,
        [
          DEPLOY_SCRIPT,
          "--sync-lock-race-contender",
          path.join(directory, "race"),
          gate,
          winner,
          blocked,
          String(delayMs),
        ],
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
  console.log(
    "hr bridge sync lock selftest: handoff, nested selftest, and fenced stale race passed",
  );
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
  const daemonVersion = daemonProbe.stdout?.match(/\b\d+\.\d+\.\d+\b/g)?.at(-1);
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  console.log(
    "hr bridge control environment selftest: NODE_OPTIONS/NODE_PATH stripped",
  );
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
  return normalizeWebHealthEnvironment(parsed);
}

export function normalizeWebHealthEnvironment(parsed) {
  const port = Number(parsed.PORT || 3000);
  const requireSecret =
    parsed.REQUIRE_INTERNAL_PROXY_SECRET === "1" ? "1" : "0";
  const secret = parsed.INTERNAL_PROXY_SECRET?.trim() ?? "";
  const previousSecret =
    parsed.INTERNAL_PROXY_SECRET_PREVIOUS?.trim() ?? "";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw codedError("WEB_HEALTH_PORT_INVALID");
  }
  if (requireSecret === "1" && !/^[a-f0-9]{64}$/i.test(secret)) {
    throw codedError("WEB_HEALTH_PROXY_SECRET_INVALID");
  }
  if (
    previousSecret &&
    (!/^[a-f0-9]{64}$/i.test(previousSecret) || previousSecret === secret)
  ) {
    throw codedError("WEB_HEALTH_PROXY_PREVIOUS_SECRET_INVALID");
  }
  return {
    PORT: String(port),
    REQUIRE_INTERNAL_PROXY_SECRET: requireSecret,
    ...(requireSecret === "1" ? { INTERNAL_PROXY_SECRET: secret } : {}),
    ...(previousSecret
      ? { INTERNAL_PROXY_SECRET_PREVIOUS: previousSecret }
      : {}),
  };
}

function reloadWebProcess() {
  run(
    "pm2",
    ["reload", "ecosystem.config.cjs", "--only", "erp-server", "--update-env"],
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
  run(
    process.execPath,
    ["--input-type=module", "-e", INTERNAL_WEB_HEALTH_SCRIPT],
    {
      timeoutMs: 20_000,
      env: { ...controlSubprocessEnvironment(), ...environment },
    },
  );
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

function bridgePm2ContractOptions(descriptor, fallbackReleaseId, releaseTools) {
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
      const policy = releaseTools.loadReleasePolicy(
        PROJECT_ROOT,
        descriptor.id,
      );
      run(
        "pm2",
        ["start", release.pm2ConfigPath, "--only", BRIDGE_PROCESS_NAME],
        {
          timeoutMs: policy.pm2ListenTimeoutMs + 15_000,
          env: controlSubprocessEnvironment(),
        },
      );
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

function reconcileCommittedBridge(descriptor, releaseTools, pm2Contract) {
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
  step("0/12 مطابقة عقد Nginx الحي مع المستودع", () => {
    try {
      run(process.execPath, ["scripts/nginx-contract.mjs", "--live"], {
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw codedError("NGINX_LIVE_CONTRACT_DRIFT", error);
    }
  });
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
      reconcileCommittedBridge(settledState.current, releaseTools, pm2Contract);
    }
    step("1/12 تثبيت الاعتماديات المقفلة", () =>
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
    let webCandidate = null;
    let candidate = null;
    let committed = null;
    let smokeStarted = false;
    let webSwapped = false;
    try {
      step("2/12 بناء مرشح الويب المعزول ثم حفظ الإصدار السابق", () => {
        webCandidate = prepareWebCandidate(PROJECT_ROOT, {
          expectedSha: expectedHead,
        });
        webArtifact = snapshotWebArtifact(PROJECT_ROOT, {
          id: `web-${Date.now()}-${expectedHead.slice(0, 12)}`,
        });
        pruneWebArtifactSnapshots(PROJECT_ROOT, {
          keepRecent: WEB_ARTIFACT_RETENTION,
          protectedIds: [webArtifact.id],
        });
        run(
          process.execPath,
          [
            path.join(
              webCandidate.sourceRoot,
              "scripts/verify-nginx-abuse-controls.mjs",
            ),
          ],
          {
            timeoutMs: 30_000,
          },
        );
      });
      const repository = assertRepository(expectedHead);
      if (repository.head !== repository.remote) {
        throw new Error("DEPLOY_HEAD_NOT_ORIGIN_MAIN");
      }
      const candidateRelease = releaseTools.prepareRelease(PROJECT_ROOT, {
        sourceCommit: expectedHead,
        deploymentEnvironment,
        sourceRoot: webCandidate.sourceRoot,
      });
      const provisional = { id: candidateRelease.id, mode: "enabled" };
      const beforeMode = step("3/12 فحص المرشح قبل لمس قاعدة البيانات", () =>
        runPreflight(provisional, releaseTools),
      );

      step("4/12 إنشاء نسخة احتياطية", () => run("pnpm", ["db:backup"]));
      step("5/12 تطبيق الهجرات الآمنة وإصلاح الاستقبال والتوصيل", () => {
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
      step("6/12 التحقق من مخطط قاعدة البيانات", () =>
        run("pnpm", ["db:verify"], { timeoutMs: 5 * 60_000 }),
      );

      const afterMode = step("7/12 فحص المرشح بعد الهجرات", () =>
        runPreflight(provisional, releaseTools),
      );
      if (beforeMode !== afterMode) {
        throw new Error("HR_BRIDGE_MODE_CHANGED_DURING_DEPLOY");
      }
      candidate = { id: candidateRelease.id, mode: afterMode };
      committed = releaseTools.readState(PROJECT_ROOT).current;
      await step(
        "8/12 إثبات صلاحية إصداري الرجوع مع المخطط الجديد",
        async () => {
          await verifyRollbackWebArtifactCompatibility(
            webArtifact,
            webHealthEnvironment,
          );
          if (!committed) return;
          const rollbackMode = runPreflight(committed, releaseTools);
          if (rollbackMode !== committed.mode) {
            throw new Error("HR_BRIDGE_ROLLBACK_MODE_DRIFT");
          }
        },
      );

      step("9/12 تبديل حزمة الويب ذرياً ثم إعادة تحميل الخادم", () => {
        try {
          installWebCandidate(webArtifact, webCandidate);
        } finally {
          // rename may have committed the link before a later fsync surfaced
          // an I/O error. Inspect durable state so rollback is never skipped.
          webSwapped = isWebCandidateActive(webArtifact);
        }
        reloadWebProcess();
      });

      smokeStarted = true;
      step("10/12 فحص المتجر خارجياً عبر المضيفين", () => {
        run(
          process.execPath,
          ["scripts/verify-nginx-storefront-readiness.mjs"],
          {
            timeoutMs: 5 * 60_000,
          },
        );
        commitWebArtifact(webArtifact);
      });
    } catch (candidateError) {
      const activationPending =
        webArtifact && hasPendingWebActivation(webArtifact.projectRoot);
      if (!webArtifact || (!webSwapped && !activationPending)) {
        throw candidateError;
      }
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
    } finally {
      if (webCandidate) {
        try {
          cleanupWebCandidate(webCandidate);
        } catch {
          console.warn("WEB_CANDIDATE_CLEANUP_DEFERRED");
        }
      }
    }

    step("11/12 تفعيل إصدار الجسر والتحقق والحفظ الذري", () => {
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

async function recoverPendingWebActivationBeforePull() {
  if (!hasPendingWebActivation(PROJECT_ROOT)) return;
  const dotenvModule = await import("dotenv");
  const webHealthEnvironment = readWebHealthEnvironment(dotenvModule.config);
  recoverPendingWebActivation(PROJECT_ROOT, {
    reload: reloadWebProcess,
    health: () => verifyInternalWebHealth(webHealthEnvironment),
  });
}

async function main() {
  assertDeploymentIdentity();
  process.chdir(PROJECT_ROOT);
  const releaseSyncLock = acquirePrePullLock();
  try {
    await recoverPendingWebActivationBeforePull();
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
    console.log(
      "   جسر الحضور يعمل من إصدار immutable وتم حفظ PM2 بعد بوابة الاستقرار.",
    );
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
      throw new Error(
        "HR_BRIDGE_CONTROL_ENVIRONMENT_SELFTEST_ARGUMENTS_INVALID",
      );
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
    const [gate, winner, blocked, delayRaw, ...extra] = rest;
    const delayMs = Number(delayRaw);
    if (
      !directory ||
      !gate ||
      !winner ||
      !blocked ||
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 5_000 ||
      extra.length > 0
    ) {
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
    if (delayMs > 0) sleep(delayMs);
    try {
      const lock = acquirePrePullLock(directory);
      try {
        fs.writeFileSync(winner, `${process.pid}\n`, { flag: "wx" });
        const blockedDeadline = Date.now() + 10_000;
        while (!fs.existsSync(blocked)) {
          if (Date.now() >= blockedDeadline) {
            throw new Error("HR_BRIDGE_SYNC_LOCK_SELFTEST_BLOCKED_TIMEOUT");
          }
          sleep(10);
        }
        process.stdout.write("RACE_WINNER\n");
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error?.message === "HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING") {
        fs.writeFileSync(blocked, `${process.pid}\n`, { flag: "wx" });
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
  if (code === "NGINX_LIVE_CONTRACT_DRIFT") {
    console.error(
      "   أُوقف النشر قبل البناء والهجرات لأن إعداد Nginx الحي لا يطابق العقد الملتزم.",
    );
    console.error(
      "   أصلحه بالمثبت root-owned: sudo /usr/bin/node /usr/local/libexec/erp/nginx/install-nginx-contract.mjs install",
    );
  }
  if (code === "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_OK") {
    console.error(
      "   فشل المرشح، لكن الإصدار السابق أُعيد وتحقق ثم حُفظ بنجاح.",
    );
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
    console.error(
      "   فشل المرشح وفشل الرجوع؛ بقي journal لمنع أي نشر جديد حتى التعافي.",
    );
    process.exitCode = 2;
    return;
  }
  if (code === "WEB_STOREFRONT_SMOKE_FAILED_ROLLBACK_OK") {
    console.error(
      "   فشل فحص المتجر؛ أُعيد إصدار الويب السابق وتحققت صحته داخلياً، وحُفظ المرشح الفاشل للتشخيص.",
    );
  }
  if (code === "WEB_CANDIDATE_FAILED_ROLLBACK_OK") {
    console.error(
      "   فشل مرشح الويب قبل الجاهزية؛ أُعيد الإصدار السابق وتحققت صحته داخلياً.",
    );
  }
  if (code === "WEB_CANDIDATE_FAILED_ROLLBACK_FAILED") {
    console.error(
      "   فشل مرشح الويب وفشل الرجوع أو التحقق الداخلي؛ يلزم تدخل تشغيلي فوري.",
    );
    process.exitCode = 2;
    return;
  }
  if (String(code).startsWith("WEB_ACTIVATION_")) {
    console.error(
      "   بقي journal تفعيل الويب مانعاً للنشر؛ لا تحذفه يدوياً قبل إثبات مساري previous/current وصحة الإصدار السابق.",
    );
    process.exitCode = 2;
    return;
  }
  console.error(
    "   لا تنفّذ db:restore تلقائياً؛ الاستعادة تتطلب إثبات تلف بيانات وقراراً موثقاً.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === DEPLOY_SCRIPT) {
  dispatch().catch(reportDeploymentFailure);
}
