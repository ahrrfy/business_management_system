#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_FILE = path.join(
  PROJECT_ROOT,
  "deploy/systemd/pm2-deploy.service.d/20-pidfile-reconcile.conf",
);
const TARGET_FILE =
  "/etc/systemd/system/pm2-deploy.service.d/20-pidfile-reconcile.conf";
const WRAPPER = "/home/deploy/erp/scripts/pm2-systemd-start.mjs";

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
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

function atomicReplace(targetFile, contents, mode = 0o644) {
  const directory = path.dirname(targetFile);
  const temp = path.join(
    directory,
    `.${path.basename(targetFile)}.${process.pid}.${randomUUID()}`,
  );
  let fd;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      mode,
    );
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, targetFile);
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

function previousTarget(targetFile) {
  try {
    const stat = fs.lstatSync(targetFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw codedError("PM2_SYSTEMD_CONTRACT_TARGET_INVALID");
    }
    return { contents: fs.readFileSync(targetFile), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function installPm2SystemdContract({
  sourceFile,
  targetFile,
  runDaemonReload,
  verifyLoadedContract,
}) {
  const sourceStat = fs.lstatSync(sourceFile);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw codedError("PM2_SYSTEMD_CONTRACT_SOURCE_INVALID");
  }
  const contents = fs.readFileSync(sourceFile);
  const previous = previousTarget(targetFile);
  try {
    atomicReplace(targetFile, contents, 0o644);
    runDaemonReload();
    if (verifyLoadedContract() !== true) {
      throw codedError("PM2_SYSTEMD_CONTRACT_VERIFY_FAILED");
    }
  } catch (cause) {
    try {
      if (previous) {
        atomicReplace(targetFile, previous.contents, previous.mode);
      } else {
        try {
          fs.unlinkSync(targetFile);
          fsyncDirectory(path.dirname(targetFile));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      runDaemonReload();
    } catch (rollbackCause) {
      throw codedError(
        "PM2_SYSTEMD_CONTRACT_INSTALL_FAILED_ROLLBACK_FAILED",
        new AggregateError([cause, rollbackCause]),
      );
    }
    throw codedError("PM2_SYSTEMD_CONTRACT_INSTALL_FAILED_ROLLBACK_OK", cause);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw codedError("PM2_SYSTEMD_CONTRACT_SYSTEMCTL_FAILED", result.error);
  }
  return result.stdout.trim();
}

function assertSourceContract() {
  const source = fs.readFileSync(SOURCE_FILE, "utf8");
  if (
    !/^\[Service\]$/mu.test(source) ||
    !/^ExecStart=$/mu.test(source) ||
    !new RegExp(
      `^ExecStart=\\/usr\\/bin\\/node ${WRAPPER.replaceAll("/", "\\/")}$`,
      "mu",
    ).test(source) ||
    /^ExecStop=/mu.test(source)
  ) {
    throw codedError("PM2_SYSTEMD_CONTRACT_SOURCE_INVALID");
  }
}

function assertInstallIdentity() {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw codedError("PM2_SYSTEMD_CONTRACT_ROOT_REQUIRED");
  }
  const directory = path.dirname(TARGET_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0
  ) {
    throw codedError("PM2_SYSTEMD_CONTRACT_DIRECTORY_INVALID");
  }
}

function verifyLoadedContract() {
  const properties = run("systemctl", [
    "show",
    "pm2-deploy.service",
    "--property=Type,User,PIDFile,ExecStart",
    "--no-pager",
  ]);
  return (
    /^Type=forking$/mu.test(properties) &&
    /^User=deploy$/mu.test(properties) &&
    /^PIDFile=\/home\/deploy\/\.pm2\/pm2\.pid$/mu.test(properties) &&
    properties.includes(`/usr/bin/node ${WRAPPER}`)
  );
}

function main() {
  assertInstallIdentity();
  assertSourceContract();
  installPm2SystemdContract({
    sourceFile: SOURCE_FILE,
    targetFile: TARGET_FILE,
    runDaemonReload: () => run("systemctl", ["daemon-reload"]),
    verifyLoadedContract,
  });
  console.log(
    "pm2 systemd contract: installed (service not started or restarted)",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `pm2 systemd contract: FAILED: ${error?.code ?? error?.message ?? "UNKNOWN"}`,
    );
    process.exitCode = 1;
  }
}
