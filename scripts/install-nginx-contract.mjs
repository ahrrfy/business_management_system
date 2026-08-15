#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  INTERNAL_PROXY_SECRET_PATTERN,
  NGINX_TLS_DEPENDENCIES,
  PROJECT_ROOT,
  createNginxTopologyAttestation,
  createSecretAttestation,
  readInternalProxySecretFromEnv,
  resolveNginxContract,
  verifyLiveNginxContract,
} from "./nginx-contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const NGINX_EXTERNAL_HEALTH_SCRIPT = String.raw`
const origins = ["https://srv1548487.hstgr.cloud", "https://alarabiya.online"];
for (const origin of origins) {
  let healthy = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(origin + "/healthz", {
        headers: { Accept: "application/json", "User-Agent": "Alroya-Nginx-Contract-Smoke/1.0" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json();
      if (response.ok && payload?.ok === true) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!healthy) throw new Error("NGINX_EXTERNAL_HEALTH_FAILED:" + new URL(origin).hostname);
  console.log("nginx external health: " + new URL(origin).hostname + " OK");
}
`;

function installerError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertPlainDirectory(directory, code) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw installerError(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw installerError(code);
  return stat;
}

function assertPlainFile(file, code) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw installerError(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw installerError(code);
  }
  return stat;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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

function parseNginxSecret(file, options) {
  const stat = assertPlainFile(file, "NGINX_INSTALL_SECRET_MISSING");
  if (options.strictMode && (stat.mode & 0o777) !== 0o600) {
    throw installerError("NGINX_INSTALL_SECRET_MODE_INVALID");
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    throw installerError("NGINX_INSTALL_SECRET_OWNER_INVALID");
  }
  const meaningfulLines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (meaningfulLines.length !== 1) {
    throw installerError("NGINX_INSTALL_SECRET_CONTENT_INVALID");
  }
  const match = /^set\s+\$alroya_proxy_secret\s+"([a-f0-9]{64})";$/iu.exec(
    meaningfulLines[0],
  );
  if (!match || !INTERNAL_PROXY_SECRET_PATTERN.test(match[1])) {
    throw installerError("NGINX_INSTALL_SECRET_CONTENT_INVALID");
  }
  return Object.freeze({ secret: match[1], stat });
}

function secretsMatch(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertManagedTargetShape(contract, options) {
  for (const directory of [
    contract.nginxRoot,
    ...["conf.d", "snippets", "sites-available", "sites-enabled"].map((name) =>
      path.join(contract.nginxRoot, name),
    ),
  ]) {
    const stat = assertPlainDirectory(
      directory,
      "NGINX_INSTALL_TARGET_DIRECTORY_INVALID",
    );
    if (options.strictMode && (stat.mode & 0o022) !== 0) {
      throw installerError("NGINX_INSTALL_TARGET_DIRECTORY_WRITABLE");
    }
    if (
      options.strictOwnership &&
      (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
    ) {
      throw installerError("NGINX_INSTALL_TARGET_DIRECTORY_OWNER_INVALID");
    }
  }
  for (const entry of contract.files) {
    const stat = lstatOrNull(entry.target);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw installerError("NGINX_INSTALL_TARGET_FILE_UNSAFE");
    }
  }
  for (const entry of contract.links) {
    const stat = lstatOrNull(entry.target);
    if (!stat) continue;
    if (!stat.isSymbolicLink()) {
      throw installerError("NGINX_INSTALL_TARGET_LINK_UNSAFE");
    }
  }
  const attestationStat = lstatOrNull(contract.secretAttestationPath);
  if (
    attestationStat &&
    (!attestationStat.isFile() || attestationStat.isSymbolicLink())
  ) {
    throw installerError("NGINX_INSTALL_ATTESTATION_TARGET_UNSAFE");
  }
  const topologyStat = lstatOrNull(contract.topologyAttestationPath);
  if (
    topologyStat &&
    (!topologyStat.isFile() || topologyStat.isSymbolicLink())
  ) {
    throw installerError("NGINX_INSTALL_ATTESTATION_TARGET_UNSAFE");
  }
}

function assertTlsDependencies(dependencies) {
  for (const dependency of dependencies) {
    let stat;
    try {
      stat = fs.statSync(dependency);
    } catch {
      throw installerError("NGINX_INSTALL_TLS_DEPENDENCY_MISSING");
    }
    if (!stat.isFile() || stat.size < 1) {
      throw installerError("NGINX_INSTALL_TLS_DEPENDENCY_INVALID");
    }
  }
}

function ensureBackupRoot(backupRoot, options) {
  if (!fs.existsSync(backupRoot)) {
    fs.mkdirSync(backupRoot, { mode: 0o700 });
    if (options.strictOwnership)
      fs.chownSync(backupRoot, options.expectedUid, options.expectedGid);
  }
  const stat = assertPlainDirectory(
    backupRoot,
    "NGINX_INSTALL_BACKUP_ROOT_INVALID",
  );
  if (options.strictMode && (stat.mode & 0o777) !== 0o700) {
    throw installerError("NGINX_INSTALL_BACKUP_ROOT_MODE_INVALID");
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    throw installerError("NGINX_INSTALL_BACKUP_ROOT_OWNER_INVALID");
  }
}

function captureTarget(target, backupDirectory, index) {
  const stat = lstatOrNull(target);
  if (!stat) return Object.freeze({ target, state: "missing" });
  if (stat.isSymbolicLink()) {
    return Object.freeze({
      target,
      state: "symlink",
      link: fs.readlinkSync(target),
      uid: stat.uid,
      gid: stat.gid,
    });
  }
  if (!stat.isFile())
    throw installerError("NGINX_INSTALL_BACKUP_TARGET_UNSAFE");
  const backupName = `entry-${index}.bin`;
  const backupFile = path.join(backupDirectory, backupName);
  fs.copyFileSync(target, backupFile, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupFile, 0o600);
  fsyncFile(backupFile);
  return Object.freeze({
    target,
    state: "file",
    backupName,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  });
}

function createBackup(contract, backupRoot, options) {
  const backupDirectory = path.join(
    backupRoot,
    `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`,
  );
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  if (options.strictOwnership) {
    fs.chownSync(backupDirectory, options.expectedUid, options.expectedGid);
  }
  const targets = backupTargets(contract);
  const entries = targets.map((target, index) =>
    captureTarget(target, backupDirectory, index),
  );
  const manifestPath = path.join(backupDirectory, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), entries }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  fsyncFile(manifestPath);
  fsyncDirectory(backupDirectory);
  fsyncDirectory(backupRoot);
  return Object.freeze({ backupDirectory, entries });
}

function backupTargets(contract) {
  return [
    ...contract.files.map((entry) => entry.target),
    ...contract.links.map((entry) => entry.target),
    contract.secretAttestationPath,
    contract.topologyAttestationPath,
  ];
}

function pendingJournalPath(backupRoot) {
  return path.join(backupRoot, "pending.json");
}

function assertOwnedMode(stat, mode, options, code) {
  if (options.strictMode && (stat.mode & 0o777) !== mode) {
    throw installerError(code);
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    throw installerError(code);
  }
}

function writePendingJournal(backup, backupRoot, options) {
  const target = pendingJournalPath(backupRoot);
  if (lstatOrNull(target)) {
    throw installerError("NGINX_INSTALL_PENDING_ALREADY_EXISTS");
  }
  const temporary = path.join(
    backupRoot,
    `.pending-stage-${randomUUID()}.json`,
  );
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 1,
        backupDirectory: backup.backupDirectory,
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    applyOwnerAndMode(temporary, 0o600, options);
    fsyncFile(temporary);
    fs.renameSync(temporary, target);
    fsyncDirectory(backupRoot);
  } finally {
    if (lstatOrNull(temporary)) fs.unlinkSync(temporary);
  }
}

function clearPendingJournal(backupRoot) {
  const target = pendingJournalPath(backupRoot);
  if (!lstatOrNull(target)) return;
  fs.unlinkSync(target);
  fsyncDirectory(backupRoot);
}

function readPendingBackup(contract, backupRoot, options) {
  const journalPath = pendingJournalPath(backupRoot);
  const journalStat = lstatOrNull(journalPath);
  if (!journalStat) return null;
  if (
    !journalStat.isFile() ||
    journalStat.isSymbolicLink() ||
    journalStat.size < 20 ||
    journalStat.size > 4096
  ) {
    throw installerError("NGINX_INSTALL_PENDING_INVALID");
  }
  assertOwnedMode(
    journalStat,
    0o600,
    options,
    "NGINX_INSTALL_PENDING_SECURITY_INVALID",
  );
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    throw installerError("NGINX_INSTALL_PENDING_INVALID");
  }
  const backupDirectory = path.resolve(journal?.backupDirectory ?? "");
  if (
    journal?.version !== 1 ||
    path.dirname(backupDirectory) !== backupRoot ||
    path.basename(backupDirectory).length < 20
  ) {
    throw installerError("NGINX_INSTALL_PENDING_INVALID");
  }
  const backupDirectoryStat = assertPlainDirectory(
    backupDirectory,
    "NGINX_INSTALL_PENDING_BACKUP_INVALID",
  );
  assertOwnedMode(
    backupDirectoryStat,
    0o700,
    options,
    "NGINX_INSTALL_PENDING_BACKUP_SECURITY_INVALID",
  );
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const manifestStat = assertPlainFile(
    manifestPath,
    "NGINX_INSTALL_PENDING_MANIFEST_INVALID",
  );
  if (manifestStat.size > 1024 * 1024) {
    throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
  }
  assertOwnedMode(
    manifestStat,
    0o600,
    options,
    "NGINX_INSTALL_PENDING_MANIFEST_SECURITY_INVALID",
  );
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
  }
  const expectedTargets = backupTargets(contract);
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== expectedTargets.length
  ) {
    throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
  }
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry?.target !== expectedTargets[index]) {
      throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
    }
    if (entry.state === "missing") continue;
    if (entry.state === "symlink") {
      if (
        typeof entry.link !== "string" ||
        entry.link.length < 1 ||
        entry.link.includes("\0") ||
        !Number.isInteger(entry.uid) ||
        !Number.isInteger(entry.gid)
      ) {
        throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
      }
      continue;
    }
    if (
      entry.state !== "file" ||
      entry.backupName !== `entry-${index}.bin` ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      !Number.isInteger(entry.uid) ||
      !Number.isInteger(entry.gid)
    ) {
      throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
    }
    const backupFile = path.join(backupDirectory, entry.backupName);
    const backupStat = lstatOrNull(backupFile);
    if (!backupStat?.isFile() || backupStat.isSymbolicLink()) {
      throw installerError("NGINX_INSTALL_PENDING_BACKUP_FILE_INVALID");
    }
    assertOwnedMode(
      backupStat,
      0o600,
      options,
      "NGINX_INSTALL_PENDING_BACKUP_FILE_SECURITY_INVALID",
    );
  }
  return Object.freeze({
    backupDirectory,
    entries: Object.freeze(manifest.entries),
  });
}

function applyOwnerAndMode(
  file,
  mode,
  options,
  uid = options.expectedUid,
  gid = options.expectedGid,
) {
  fs.chmodSync(file, mode);
  if (options.strictOwnership) fs.chownSync(file, uid, gid);
}

function stageContract(contract, options, secretAttestation) {
  const token = randomUUID();
  const staged = [];
  try {
    for (const entry of contract.files) {
      const temporary = path.join(
        path.dirname(entry.target),
        `.alroya-${path.basename(entry.target)}-stage-${token}`,
      );
      fs.copyFileSync(entry.source, temporary, fs.constants.COPYFILE_EXCL);
      applyOwnerAndMode(temporary, entry.mode, options);
      fsyncFile(temporary);
      staged.push(
        Object.freeze({ kind: "file", temporary, target: entry.target }),
      );
    }
    const attestationTemporary = path.join(
      path.dirname(contract.secretAttestationPath),
      `.alroya-${path.basename(contract.secretAttestationPath)}-stage-${token}`,
    );
    fs.writeFileSync(attestationTemporary, secretAttestation, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    applyOwnerAndMode(attestationTemporary, 0o644, options);
    fsyncFile(attestationTemporary);
    staged.push(
      Object.freeze({
        kind: "file",
        temporary: attestationTemporary,
        target: contract.secretAttestationPath,
      }),
    );
    for (const entry of contract.links) {
      const temporary = path.join(
        path.dirname(entry.target),
        `.alroya-${path.basename(entry.target)}-stage-${token}`,
      );
      fs.symlinkSync(entry.link, temporary);
      staged.push(
        Object.freeze({ kind: "link", temporary, target: entry.target }),
      );
    }
    for (const item of staged) fsyncDirectory(path.dirname(item.temporary));
    return staged;
  } catch (error) {
    for (const item of staged) {
      if (lstatOrNull(item.temporary)) fs.unlinkSync(item.temporary);
    }
    throw installerError("NGINX_INSTALL_STAGING_FAILED", error);
  }
}

function removeStaged(staged) {
  for (const item of staged) {
    if (!lstatOrNull(item.temporary)) continue;
    fs.unlinkSync(item.temporary);
    fsyncDirectory(path.dirname(item.temporary));
  }
}

function installStaged(staged, operations) {
  for (const [index, item] of staged.entries()) {
    operations.rename(item.temporary, item.target, "install");
    fsyncDirectory(path.dirname(item.target));
    operations.afterInstallItem?.(item.target, index);
  }
}

function installGeneratedAttestation(target, payload, options, operations) {
  const temporary = path.join(
    path.dirname(target),
    `.alroya-${path.basename(target)}-stage-${randomUUID()}`,
  );
  try {
    fs.writeFileSync(temporary, payload, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    applyOwnerAndMode(temporary, 0o644, options);
    fsyncFile(temporary);
    operations.rename(temporary, target, "install");
    fsyncDirectory(path.dirname(target));
    operations.afterInstallItem?.(target, -1);
  } finally {
    if (lstatOrNull(temporary)) fs.unlinkSync(temporary);
  }
}

function restoreEntry(entry, backupDirectory, options, operations, token) {
  const parent = path.dirname(entry.target);
  if (entry.state === "missing") {
    if (lstatOrNull(entry.target)) fs.unlinkSync(entry.target);
    fsyncDirectory(parent);
    return;
  }
  const temporary = path.join(
    parent,
    `.alroya-${path.basename(entry.target)}-rollback-${token}`,
  );
  if (entry.state === "symlink") {
    fs.symlinkSync(entry.link, temporary);
    if (options.strictOwnership) {
      fs.lchownSync(temporary, entry.uid, entry.gid);
    }
  } else if (entry.state === "file") {
    fs.copyFileSync(
      path.join(backupDirectory, entry.backupName),
      temporary,
      fs.constants.COPYFILE_EXCL,
    );
    applyOwnerAndMode(temporary, entry.mode, options, entry.uid, entry.gid);
    fsyncFile(temporary);
  } else {
    throw installerError("NGINX_INSTALL_BACKUP_STATE_INVALID");
  }
  operations.rename(temporary, entry.target, "rollback");
  fsyncDirectory(parent);
}

function rollback(backup, options, operations) {
  const token = randomUUID();
  for (const entry of [...backup.entries].reverse()) {
    restoreEntry(entry, backup.backupDirectory, options, operations, token);
  }
  operations.nginxTest();
  operations.reload();
  operations.smoke();
}

function recoverPendingInstall(contract, options) {
  const backup = readPendingBackup(contract, options.backupRoot, options);
  if (!backup) return false;
  try {
    rollback(backup, options, options.operations);
    clearPendingJournal(options.backupRoot);
    return true;
  } catch (error) {
    throw installerError("NGINX_INSTALL_PENDING_RECOVERY_FAILED", error);
  }
}

function defaultOperations(projectRoot) {
  return Object.freeze({
    staticCheck: () =>
      execFileSync(
        process.execPath,
        ["scripts/verify-nginx-abuse-controls.mjs"],
        {
          cwd: projectRoot,
          stdio: "inherit",
          timeout: 30_000,
        },
      ),
    renderedConfig: () =>
      String(
        execFileSync("nginx", ["-T"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        }),
      ),
    rename: (source, destination) => fs.renameSync(source, destination),
    nginxTest: () =>
      execFileSync("nginx", ["-t"], { stdio: "inherit", timeout: 30_000 }),
    reload: () =>
      execFileSync("systemctl", ["reload", "nginx"], {
        stdio: "inherit",
        timeout: 30_000,
      }),
    smoke: () =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", NGINX_EXTERNAL_HEALTH_SCRIPT],
        {
          cwd: projectRoot,
          stdio: "inherit",
          timeout: 60_000,
          env: Object.fromEntries(
            ["PATH", "LANG", "LC_ALL", "SystemRoot", "WINDIR"].flatMap((key) =>
              typeof process.env[key] === "string"
                ? [[key, process.env[key]]]
                : [],
            ),
          ),
        },
      ),
  });
}

function normalizeOptions(options) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const nginxRoot = path.resolve(options.nginxRoot ?? "/etc/nginx");
  const strictOwnership =
    options.strictOwnership ?? process.platform !== "win32";
  const strictMode = options.strictMode ?? process.platform !== "win32";
  return Object.freeze({
    projectRoot,
    nginxRoot,
    appEnvPath: path.resolve(
      options.appEnvPath ?? path.join(projectRoot, ".env"),
    ),
    backupRoot: path.resolve(options.backupRoot ?? "/var/backups/alroya-nginx"),
    tlsDependencies: options.tlsDependencies ?? NGINX_TLS_DEPENDENCIES,
    managedFiles: options.managedFiles,
    managedLinks: options.managedLinks,
    strictOwnership,
    strictMode,
    expectedUid: options.expectedUid ?? 0,
    expectedGid: options.expectedGid ?? 0,
    requireRoot: options.requireRoot ?? true,
    faultInjection: options.faultInjection === true,
    operations: options.operations ?? defaultOperations(projectRoot),
  });
}

export function installNginxContract(input = {}) {
  const options = normalizeOptions(input);
  if (
    options.requireRoot &&
    (process.platform !== "linux" ||
      typeof process.getuid !== "function" ||
      process.getuid() !== 0)
  ) {
    throw installerError("NGINX_INSTALL_ROOT_REQUIRED");
  }
  const contract = resolveNginxContract(options);
  if (lstatOrNull(options.backupRoot)) {
    ensureBackupRoot(options.backupRoot, options);
    recoverPendingInstall(contract, options);
  }
  assertManagedTargetShape(contract, options);
  assertTlsDependencies(options.tlsDependencies);
  const nginxSecret = parseNginxSecret(contract.secretPath, options);
  let appSecret;
  try {
    appSecret = readInternalProxySecretFromEnv(options.appEnvPath);
  } catch (error) {
    throw installerError("NGINX_INSTALL_APP_SECRET_INVALID", error);
  }
  if (!secretsMatch(nginxSecret.secret, appSecret)) {
    throw installerError("NGINX_INSTALL_SECRET_MISMATCH");
  }
  const secretAttestation = createSecretAttestation(
    nginxSecret.secret,
    nginxSecret.stat,
  );
  options.operations.staticCheck();
  ensureBackupRoot(options.backupRoot, options);

  let backup;
  let staged = [];
  try {
    backup = createBackup(contract, options.backupRoot, options);
    staged = stageContract(contract, options, secretAttestation);
    writePendingJournal(backup, options.backupRoot, options);
    installStaged(staged, options.operations);
    const topologyAttestation = createNginxTopologyAttestation(
      options.operations.renderedConfig(),
      { nginxRoot: contract.nginxRoot },
    );
    installGeneratedAttestation(
      contract.topologyAttestationPath,
      topologyAttestation,
      options,
      options.operations,
    );
    options.operations.nginxTest();
    options.operations.reload();
    verifyLiveNginxContract(options);
    options.operations.smoke();
    clearPendingJournal(options.backupRoot);
    return Object.freeze({ backupDirectory: backup.backupDirectory });
  } catch (error) {
    if (
      options.faultInjection &&
      error?.code === "NGINX_INSTALL_SIMULATED_POWER_LOSS"
    ) {
      throw error;
    }
    removeStaged(staged);
    if (!backup) throw error;
    try {
      rollback(backup, options, options.operations);
      clearPendingJournal(options.backupRoot);
    } catch (rollbackError) {
      throw installerError(
        "NGINX_INSTALL_FAILED_ROLLBACK_FAILED",
        new AggregateError([error, rollbackError]),
      );
    }
    throw installerError("NGINX_INSTALL_FAILED_ROLLBACK_OK", error);
  }
}

function main() {
  if (process.argv.length !== 2)
    throw installerError("NGINX_INSTALL_ARGUMENTS_INVALID");
  const result = installNginxContract();
  console.log("nginx contract install: OK");
  console.log(`recoverable backup: ${result.backupDirectory}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    const code = error?.code ?? error?.message ?? "NGINX_INSTALL_FAILED";
    console.error(`nginx contract install: FAILED: ${code}`);
    if (code === "NGINX_INSTALL_FAILED_ROLLBACK_OK") {
      console.error("previous nginx contract restored and reloaded");
    }
    if (code === "NGINX_INSTALL_FAILED_ROLLBACK_FAILED") {
      console.error(
        "rollback failed; use the retained backup and stop deployment",
      );
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  }
}
