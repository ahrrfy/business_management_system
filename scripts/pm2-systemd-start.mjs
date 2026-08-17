#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const policy = require("./hr-bridge-runtime-policy.cjs");
const DEFAULT_PM2_BIN = "/usr/lib/node_modules/pm2/bin/pm2";

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readProcIdentity(procRoot, entry, expected) {
  const pid = Number(entry);
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  const dir = path.join(procRoot, entry);
  try {
    const status = fs.readFileSync(path.join(dir, "status"), "utf8");
    const uid = Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]);
    const ppid = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]);
    if (uid !== expected.uid || ppid !== 1) return null;

    const cmdline = fs
      .readFileSync(path.join(dir, "cmdline"))
      .toString("utf8")
      .replace(/\0+$/u, "");
    const title = `PM2 v${expected.version}: God Daemon (${expected.pm2Home})`;
    if (cmdline !== title) return null;

    const stat = fs.readFileSync(path.join(dir, "stat"), "utf8").trim();
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) throw codedError("PM2_SYSTEMD_PROC_STAT_INVALID");
    const fields = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    if (!/^\d+$/u.test(startTime ?? "")) {
      throw codedError("PM2_SYSTEMD_PROC_STAT_INVALID");
    }
    return { pid, startTime };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

export function discoverPm2Daemons({
  procRoot = "/proc",
  pm2Home,
  uid,
  expectedVersion,
}) {
  const expected = {
    pm2Home: path.resolve(pm2Home),
    uid,
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

function writePidFileAtomically(pm2Home, daemon, verify) {
  const target = path.join(pm2Home, "pm2.pid");
  const temp = path.join(
    pm2Home,
    `.pm2.pid.systemd-${process.pid}-${randomUUID()}`,
  );
  let fd;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(fd, `${daemon.pid}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (!sameProcess(daemon, verify())) {
      throw codedError("PM2_SYSTEMD_DAEMON_CHANGED");
    }
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
    if (process.platform !== "win32") {
      const dirFd = fs.openSync(pm2Home, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function startPm2ForSystemd({
  pm2Home,
  procRoot = "/proc",
  uid,
  expectedVersion,
  runResurrect,
}) {
  const discovery = { pm2Home, procRoot, uid, expectedVersion };
  const before = oneDaemon(discovery);
  await runResurrect();
  const after = oneDaemon(discovery);
  if (!after) throw codedError("PM2_SYSTEMD_DAEMON_NOT_FOUND");
  if (before && !sameProcess(before, after)) {
    throw codedError("PM2_SYSTEMD_DAEMON_CHANGED");
  }
  writePidFileAtomically(pm2Home, after, () => oneDaemon(discovery));
  if (!sameProcess(after, oneDaemon(discovery))) {
    throw codedError("PM2_SYSTEMD_DAEMON_CHANGED");
  }
  return after;
}

function assertProductionInputs(pm2Home, pm2Bin, uid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(uid) || uid < 1) {
    throw codedError("PM2_SYSTEMD_LINUX_IDENTITY_REQUIRED");
  }
  if (!path.isAbsolute(pm2Home) || !path.isAbsolute(pm2Bin)) {
    throw codedError("PM2_SYSTEMD_PATH_INVALID");
  }
  const homeStat = fs.lstatSync(pm2Home);
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    homeStat.uid !== uid
  ) {
    throw codedError("PM2_SYSTEMD_HOME_INVALID");
  }
  const binStat = fs.lstatSync(pm2Bin);
  if (!binStat.isFile() || binStat.isSymbolicLink()) {
    throw codedError("PM2_SYSTEMD_BINARY_INVALID");
  }
}

function resurrect(pm2Bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pm2Bin, "resurrect"], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal == null) resolve();
      else reject(codedError("PM2_SYSTEMD_RESURRECT_FAILED"));
    });
  });
}

async function main() {
  const pm2Home = process.env.PM2_HOME?.trim();
  const uid = process.getuid?.();
  if (!pm2Home) throw codedError("PM2_SYSTEMD_HOME_REQUIRED");
  assertProductionInputs(pm2Home, DEFAULT_PM2_BIN, uid);
  const daemon = await startPm2ForSystemd({
    pm2Home,
    uid,
    expectedVersion: policy.pm2Version,
    runResurrect: () => resurrect(DEFAULT_PM2_BIN),
  });
  console.log(`pm2-systemd-start: daemon pid ${daemon.pid} reconciled`);
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
