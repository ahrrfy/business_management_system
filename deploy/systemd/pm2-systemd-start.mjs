#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEPLOY_HOME = "/home/deploy";
const PM2_HOME = "/home/deploy/.pm2";
const PM2_BIN = "/usr/lib/node_modules/pm2/bin/pm2";
const NODE_BIN = "/usr/bin/node";
const SETPRIV_BIN = "/usr/bin/setpriv";
const PASSWD_FILE = "/etc/passwd";
const PID_DIRECTORY = "/run/erp-pm2";
const PID_FILE = "/run/erp-pm2/pm2-deploy.pid";
const INSTALLED_HELPER = "/usr/local/libexec/erp/pm2-systemd-start.mjs";
const EXPECTED_PM2_VERSION = "7.0.3";
const DEPLOY_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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
      "--clear-groups",
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
  if (
    process.platform !== "linux" ||
    process.geteuid?.() !== 0 ||
    process.getegid?.() !== 0 ||
    process.argv.length !== 2 ||
    fileURLToPath(import.meta.url) !== INSTALLED_HELPER
  ) {
    throw codedError("PM2_SYSTEMD_ROOT_HELPER_IDENTITY_INVALID");
  }

  assertTrustedRootPath(INSTALLED_HELPER);
  assertTrustedRootPath(NODE_BIN);
  assertTrustedRootPath(SETPRIV_BIN);
  assertTrustedRootPath(PM2_BIN);
  assertTrustedRootPath(PASSWD_FILE);
  const account = parseDeployAccount(fs.readFileSync(PASSWD_FILE, "utf8"));
  assertDeployDirectory(account.home, account);
  assertDeployDirectory(PM2_HOME, account, true);
  ensurePidDirectory();

  const daemon = await reconcilePm2ForSystemd({
    pm2Home: PM2_HOME,
    pidFile: PID_FILE,
    deployUid: account.uid,
    expectedVersion: EXPECTED_PM2_VERSION,
    runResurrect: () => runResurrectAsDeploy(account),
  });
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
