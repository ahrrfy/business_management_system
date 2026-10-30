#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEPLOY_HOME = "/home/deploy";
const PM2_HOME = "/home/deploy/.pm2";
const PM2_BIN = "/usr/lib/node_modules/pm2/bin/pm2";
const NODE_BIN = "/opt/alroya-erp/node-v24.22.1-linux-x64/bin/node";
const SETPRIV_BIN = "/usr/bin/setpriv";
const PASSWD_FILE = "/etc/passwd";
const PID_DIRECTORY = "/run/erp-pm2";
const PID_FILE = "/run/erp-pm2/pm2-deploy.pid";
const INSTALLED_HELPER = "/usr/local/libexec/erp/pm2-systemd-start.mjs";
const EXPECTED_PM2_VERSION = "7.0.3";
// Standalone root-owned helper: only reads bounded JSON/bytes, never imports or
// executes deploy-owned source before deciding whether ERP resurrection is safe.
export function assertInventoryResurrection(pm2Home) {
  // PM2 7.0.3 resurrect falls back to dump.pm2.bak when the primary is absent.
  // A ping-only daemon and a fresh boot legitimately have neither file. Check
  // the fallback too; missing primary alone must not bypass ERP admission.
  let dump;
  let dumpStat;
  for (const name of ["dump.pm2", "dump.pm2.bak"]) {
    const candidate = path.join(pm2Home, name);
    try {
      dumpStat = fs.lstatSync(candidate);
      dump = candidate;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!dump) {
    // Missing dumps do not prove an existing daemon is ERP-free once durable
    // activation intent exists. Only a never-activated empty home may boot.
    try {
      fs.lstatSync(path.join(pm2Home, "erp-inventory-activation.json"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    throw codedError("INVENTORY_BOOT_RECOVERY_REQUIRED");
  }
  if (!dumpStat.isFile() || dumpStat.isSymbolicLink() || dumpStat.size > 4 * 1024 * 1024) throw codedError("INVENTORY_BOOT_DUMP_UNTRUSTED");
  const rows = JSON.parse(fs.readFileSync(dump, "utf8"));
  if (!Array.isArray(rows)) throw codedError("INVENTORY_BOOT_DUMP_INVALID");
  const erp = rows.filter(r => ["erp-server", "erp-hr-bridge", "erp-provision-worker"].includes(r.name));
  if (!erp.length) return; // Unrelated applications may still resurrect.
  const file = path.join(pm2Home, "erp-inventory-activation.json");
  // Legacy pre-activation installations have no intent yet. Once activation
  // starts, the fsynced journal is retained permanently, including rollback.
  let s;
  try {
    s = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!s.isFile() || s.isSymbolicLink() || s.size > 65536 || (process.platform !== "win32" && (s.mode & 0o777) !== 0o600)) throw codedError("INVENTORY_BOOT_JOURNAL_UNTRUSTED");
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (journal.version !== 1 || !["READY", "CANDIDATES", "PRE_RELEASE", "RELEASED", "ROLLED_BACK"].includes(journal.phase)) throw codedError("INVENTORY_BOOT_RECOVERY_REQUIRED");
  const artifacts = journal.phase === "ROLLED_BACK" ? journal.priorArtifacts : journal.artifacts;
  if (["RELEASED", "ROLLED_BACK"].includes(journal.phase) &&
      !(journal.phase === "ROLLED_BACK" && journal.initialReadyVersion === 0 && journal.active === null)) {
    const active = journal.active;
    if (!active || active.readyVersion !== 1 ||
        (journal.phase === "ROLLED_BACK" && journal.initialReadyVersion !== 1) ||
        (journal.phase === "RELEASED" && (active.activationId !== journal.id || active.commit !== journal.commit)) || active.database !== journal.database || active.serverUuid !== journal.serverUuid ||
        !/^[a-f0-9-]{36}$/.test(active.activationId) || !/^[a-f0-9]{40}$/.test(active.commit) ||
        !/^[a-f0-9]{40}$/.test(active.projectionCommit) || JSON.stringify(active.artifacts) !== JSON.stringify(artifacts))
      throw codedError("INVENTORY_BOOT_ACTIVE_MANIFEST_INVALID");
  }
  if (!Array.isArray(artifacts) || !artifacts.some(a => a.name === "erp-server") ||
      new Set(artifacts.map(a => a.name)).size !== artifacts.length ||
      artifacts.some(a => !["erp-server", "erp-hr-bridge"].includes(a.name) || !Number.isSafeInteger(a.instances) || a.instances < 1))
    throw codedError("INVENTORY_BOOT_ARTIFACT_SET_MISMATCH");
  if (!Array.isArray(artifacts) || artifacts.reduce((n, a) => n + a.instances, 0) !== erp.length) throw codedError("INVENTORY_BOOT_ARTIFACT_SET_MISMATCH");
  for (const a of artifacts) {
    if (!path.isAbsolute(a.script) || !path.isAbsolute(a.bundle) || !/^[a-f0-9]{64}$/.test(a.hash) || !/^[a-f0-9]{64}$/.test(a.scriptHash)) throw codedError("INVENTORY_BOOT_ARTIFACT_INVALID");
    const matching = erp.filter(r => r.name === a.name && path.resolve(r.pm_exec_path) === a.script);
    const hash = f => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    if (matching.length !== a.instances || hash(a.bundle) !== a.hash || hash(a.script) !== a.scriptHash) throw codedError("INVENTORY_BOOT_ARTIFACT_MISMATCH");
  }
}
const DEPLOY_PATH =
  "/opt/alroya-erp/node-v24.22.1-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function parseDeployAccount(passwd) {
  const matches = passwd
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("deploy:"));
  if (matches.length !== 1)
    throw codedError("PM2_SYSTEMD_DEPLOY_ACCOUNT_INVALID");
  const fields = matches[0].split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5];
  if (
    fields.length !== 7 ||
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !Number.isSafeInteger(gid) ||
    gid < 1 ||
    home !== DEPLOY_HOME
  ) {
    throw codedError("PM2_SYSTEMD_DEPLOY_ACCOUNT_INVALID");
  }
  return { uid, gid, home };
}

export function buildResurrectCommand(account) {
  if (
    !account ||
    !Number.isSafeInteger(account.uid) ||
    account.uid < 1 ||
    !Number.isSafeInteger(account.gid) ||
    account.gid < 1 ||
    account.home !== DEPLOY_HOME
  ) {
    throw codedError("PM2_SYSTEMD_DEPLOY_ACCOUNT_INVALID");
  }
  return {
    file: SETPRIV_BIN,
    args: [
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      `--reuid=${account.uid}`,
      `--regid=${account.gid}`,
      // Resolve deploy's own groups (including Docker), never inherit root's.
      // Clearing them breaks backups in workers spawned by a fresh PM2 daemon.
      "--init-groups",
      "--",
      NODE_BIN,
      PM2_BIN,
      "resurrect",
    ],
    options: {
      cwd: account.home,
      env: {
        HOME: account.home,
        LOGNAME: "deploy",
        PATH: DEPLOY_PATH,
        PM2_HOME,
        USER: "deploy",
      },
      stdio: "inherit",
    },
  };
}

function readProcIdentity(procRoot, entry, expected) {
  const pid = Number(entry);
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  const directory = path.join(procRoot, entry);
  try {
    const status = fs.readFileSync(path.join(directory, "status"), "utf8");
    const uid = Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]);
    const ppid = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]);
    if (uid !== expected.uid || ppid !== 1) return null;

    const cmdline = fs
      .readFileSync(path.join(directory, "cmdline"))
      .toString("utf8")
      .replace(/\0+$/u, "");
    const title = `PM2 v${expected.version}: God Daemon (${expected.pm2Home})`;
    if (cmdline !== title) return null;

    const stat = fs.readFileSync(path.join(directory, "stat"), "utf8").trim();
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) throw codedError("PM2_SYSTEMD_PROC_STAT_INVALID");
    const startTime = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/u)[19];
    if (!/^\d+$/u.test(startTime ?? "")) {
      throw codedError("PM2_SYSTEMD_PROC_STAT_INVALID");
    }
    return { pid, startTime };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

function discoverPm2Daemons({ procRoot, pm2Home, deployUid, expectedVersion }) {
  const expected = {
    pm2Home: path.resolve(pm2Home),
    uid: deployUid,
    version: expectedVersion,
  };
  return fs
    .readdirSync(procRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => readProcIdentity(procRoot, entry.name, expected))
    .filter(Boolean)
    .sort((left, right) => left.pid - right.pid);
}

function oneDaemon(options) {
  const daemons = discoverPm2Daemons(options);
  if (daemons.length > 1) throw codedError("PM2_SYSTEMD_MULTIPLE_DAEMONS");
  return daemons[0] ?? null;
}

function sameProcess(left, right) {
  return (
    !!left &&
    !!right &&
    left.pid === right.pid &&
    left.startTime === right.startTime
  );
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writePidFileAtomically(pidFile, daemon, verify) {
  const directory = path.dirname(pidFile);
  const temp = path.join(
    directory,
    `.${path.basename(pidFile)}.${process.pid}.${randomUUID()}`,
  );
  let fd;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o644,
    );
    fs.writeFileSync(fd, `${daemon.pid}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temp, 0o644);
    if (!sameProcess(daemon, verify()))
      throw codedError("PM2_SYSTEMD_DAEMON_CHANGED");
    fs.renameSync(temp, pidFile);
    fs.chmodSync(pidFile, 0o644);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function reconcilePm2ForSystemd({
  pm2Home,
  pidFile,
  procRoot = "/proc",
  deployUid,
  expectedVersion,
  runResurrect,
}) {
  const discovery = { procRoot, pm2Home, deployUid, expectedVersion };
  const before = oneDaemon(discovery);
  await runResurrect();
  const after = oneDaemon(discovery);
  if (!after) throw codedError("PM2_SYSTEMD_DAEMON_NOT_FOUND");
  if (before && !sameProcess(before, after))
    throw codedError("PM2_SYSTEMD_DAEMON_CHANGED");
  writePidFileAtomically(pidFile, after, () => oneDaemon(discovery));
  if (!sameProcess(after, oneDaemon(discovery)))
    throw codedError("PM2_SYSTEMD_DAEMON_CHANGED");
  return after;
}

function assertTrustedRootPath(target, expectedKind = "file") {
  let current = target;
  while (true) {
    const stat = fs.lstatSync(current);
    const kindValid =
      current === target
        ? expectedKind === "directory"
          ? stat.isDirectory()
          : stat.isFile()
        : stat.isDirectory();
    if (
      !kindValid ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0
    ) {
      throw codedError("PM2_SYSTEMD_TRUSTED_PATH_INVALID");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertDeployDirectory(target, account, allowMissing = false) {
  try {
    const stat = fs.lstatSync(target);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== account.uid
    ) {
      throw codedError("PM2_SYSTEMD_DEPLOY_DIRECTORY_INVALID");
    }
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
}

function ensurePidDirectory() {
  assertTrustedRootPath("/run", "directory");
  try {
    fs.mkdirSync(PID_DIRECTORY, { mode: 0o755 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  fs.chmodSync(PID_DIRECTORY, 0o755);
  assertTrustedRootPath(PID_DIRECTORY, "directory");
}

function runResurrectAsDeploy(account) {
  const command = buildResurrectCommand(account);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, command.options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal == null) resolve();
      else reject(codedError("PM2_SYSTEMD_RESURRECT_FAILED"));
    });
  });
}

async function main() {
  const inspectOnly =
    process.argv.length === 3 && process.argv[2] === "--inspect";
  if (
    process.platform !== "linux" ||
    process.geteuid?.() !== 0 ||
    process.getegid?.() !== 0 ||
    (process.argv.length !== 2 && !inspectOnly) ||
    fileURLToPath(import.meta.url) !== INSTALLED_HELPER
  ) {
    throw codedError("PM2_SYSTEMD_ROOT_HELPER_IDENTITY_INVALID");
  }

  assertTrustedRootPath(INSTALLED_HELPER);
  assertTrustedRootPath(PASSWD_FILE);
  const account = parseDeployAccount(fs.readFileSync(PASSWD_FILE, "utf8"));
  assertDeployDirectory(account.home, account);
  assertDeployDirectory(PM2_HOME, account, true);
  if (inspectOnly) {
    const daemon = oneDaemon({
      procRoot: "/proc",
      pm2Home: PM2_HOME,
      deployUid: account.uid,
      expectedVersion: EXPECTED_PM2_VERSION,
    });
    if (!daemon) throw codedError("PM2_SYSTEMD_DAEMON_NOT_FOUND");
    console.log(`${daemon.pid} ${daemon.startTime}`);
    return;
  }

  assertTrustedRootPath(NODE_BIN);
  assertTrustedRootPath(SETPRIV_BIN);
  assertTrustedRootPath(PM2_BIN);
  ensurePidDirectory();
  assertInventoryResurrection(PM2_HOME);

  const daemon = await reconcilePm2ForSystemd({
    pm2Home: PM2_HOME,
    pidFile: PID_FILE,
    deployUid: account.uid,
    expectedVersion: EXPECTED_PM2_VERSION,
    runResurrect: () => runResurrectAsDeploy(account),
  });
  if (fs.realpathSync(`/proc/${daemon.pid}/exe`) !== fs.realpathSync(NODE_BIN)) {
    throw codedError("PM2_SYSTEMD_NODE_RUNTIME_MISMATCH");
  }
  assertDeployDirectory(PM2_HOME, account);
  const pidStat = fs.lstatSync(PID_FILE);
  if (
    !pidStat.isFile() ||
    pidStat.isSymbolicLink() ||
    pidStat.uid !== 0 ||
    pidStat.gid !== 0 ||
    (pidStat.mode & 0o777) !== 0o644 ||
    fs.readFileSync(PID_FILE, "utf8") !== `${daemon.pid}\n`
  ) {
    throw codedError("PM2_SYSTEMD_PID_FILE_INVALID");
  }
  console.log(`pm2-systemd-start: trusted daemon pid ${daemon.pid} reconciled`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `pm2-systemd-start: FAILED: ${error?.code ?? error?.message ?? "UNKNOWN"}`,
    );
    process.exitCode = 1;
  });
}
