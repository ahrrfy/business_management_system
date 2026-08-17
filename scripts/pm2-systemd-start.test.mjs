#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startPm2ForSystemd } from "./pm2-systemd-start.mjs";
import { installPm2SystemdContract } from "./install-pm2-systemd-contract.mjs";

const UID = 1001;
const VERSION = "7.0.3";
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function addDaemon(procRoot, pm2Home, pid, startTime = "987654") {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "status"),
    `Name:\tnode\nState:\tS (sleeping)\nPid:\t${pid}\nPPid:\t1\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\n`,
  );
  const fields = ["S", "1", ...Array(17).fill("0"), startTime];
  fs.writeFileSync(
    path.join(dir, "stat"),
    `${pid} (node) ${fields.join(" ")}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "cmdline"),
    `PM2 v${VERSION}: God Daemon (${pm2Home})\0`,
  );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-systemd-start-"));
  const procRoot = path.join(root, "proc");
  const pm2Home = path.join(root, "home", ".pm2");
  fs.mkdirSync(procRoot, { recursive: true });
  fs.mkdirSync(pm2Home, { recursive: true, mode: 0o700 });
  return { root, procRoot, pm2Home };
}

function readPidFile(pm2Home) {
  return fs.readFileSync(path.join(pm2Home, "pm2.pid"), "utf8");
}

{
  const f = fixture();
  try {
    addDaemon(f.procRoot, f.pm2Home, 4242);
    let resurrectCalls = 0;
    const result = await startPm2ForSystemd({
      pm2Home: f.pm2Home,
      procRoot: f.procRoot,
      uid: UID,
      expectedVersion: VERSION,
      runResurrect: async () => {
        resurrectCalls += 1;
      },
    });

    assert.equal(resurrectCalls, 1);
    assert.deepEqual(result, { pid: 4242, startTime: "987654" });
    assert.equal(readPidFile(f.pm2Home), "4242\n");
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(f.pm2Home, "pm2.pid")).mode & 0o777,
        0o600,
      );
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const result = await startPm2ForSystemd({
      pm2Home: f.pm2Home,
      procRoot: f.procRoot,
      uid: UID,
      expectedVersion: VERSION,
      runResurrect: async () => {
        addDaemon(f.procRoot, f.pm2Home, 5252, "123456");
      },
    });

    assert.deepEqual(result, { pid: 5252, startTime: "123456" });
    assert.equal(readPidFile(f.pm2Home), "5252\n");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    addDaemon(f.procRoot, f.pm2Home, 6001);
    addDaemon(f.procRoot, f.pm2Home, 6002);
    let resurrected = false;
    await assert.rejects(
      startPm2ForSystemd({
        pm2Home: f.pm2Home,
        procRoot: f.procRoot,
        uid: UID,
        expectedVersion: VERSION,
        runResurrect: async () => {
          resurrected = true;
        },
      }),
      /PM2_SYSTEMD_MULTIPLE_DAEMONS/,
    );
    assert.equal(resurrected, false);
    assert.equal(fs.existsSync(path.join(f.pm2Home, "pm2.pid")), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const dropIn = fs.readFileSync(
    path.join(
      PROJECT_ROOT,
      "deploy/systemd/pm2-deploy.service.d/20-pidfile-reconcile.conf",
    ),
    "utf8",
  );
  assert.match(dropIn, /^\[Service\]$/mu);
  assert.match(dropIn, /^ExecStart=$/mu);
  assert.match(
    dropIn,
    /^ExecStart=\/usr\/bin\/node \/home\/deploy\/erp\/scripts\/pm2-systemd-start\.mjs$/mu,
  );
  assert.doesNotMatch(dropIn, /^ExecStop=/mu);
  const directives = dropIn
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(directives, /\b(?:kill|restart|stop)\b/iu);

  const deploymentVerifier = fs.readFileSync(
    path.join(PROJECT_ROOT, "scripts/verify-hr-bridge-deployment.mjs"),
    "utf8",
  );
  assert.match(
    deploymentVerifier,
    /pm2-systemd-start\.test\.mjs/u,
    "the production build must execute the PM2/systemd PID-file regression guard",
  );
}

{
  const f = fixture();
  try {
    const source = path.join(f.root, "source.conf");
    const target = path.join(f.root, "systemd", "20-pidfile-reconcile.conf");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      source,
      "[Service]\nExecStart=\nExecStart=/safe-wrapper\n",
    );
    let reloads = 0;
    installPm2SystemdContract({
      sourceFile: source,
      targetFile: target,
      runDaemonReload: () => {
        reloads += 1;
      },
      verifyLoadedContract: () => true,
    });
    assert.equal(reloads, 1);
    assert.equal(
      fs.readFileSync(target, "utf8"),
      fs.readFileSync(source, "utf8"),
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const source = path.join(f.root, "source.conf");
    const target = path.join(f.root, "systemd", "20-pidfile-reconcile.conf");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, "new-contract\n");
    fs.writeFileSync(target, "previous-contract\n");
    let reloads = 0;
    assert.throws(
      () =>
        installPm2SystemdContract({
          sourceFile: source,
          targetFile: target,
          runDaemonReload: () => {
            reloads += 1;
          },
          verifyLoadedContract: () => {
            throw new Error("verification failed");
          },
        }),
      /PM2_SYSTEMD_CONTRACT_INSTALL_FAILED_ROLLBACK_OK/,
    );
    assert.equal(reloads, 2);
    assert.equal(fs.readFileSync(target, "utf8"), "previous-contract\n");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

console.log("pm2 systemd pidfile selftest: OK");
