#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  assertInventoryResurrection,
  buildResurrectCommand,
  parseDeployAccount,
  reconcilePm2ForSystemd,
} from "../deploy/systemd/pm2-systemd-start.mjs";

const UID = 1001;
const GID = 1002;
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
  const pidFile = path.join(root, "run", "erp-pm2", "pm2-deploy.pid");
  fs.mkdirSync(procRoot, { recursive: true });
  fs.mkdirSync(pm2Home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o755 });
  return { root, procRoot, pm2Home, pidFile };
}

{
  const f = fixture();
  try {
    // Both states occur in the real Linux contract: ping-only adoption and a
    // fresh boot with no PM2 home. PM2 has no saved workload to resurrect.
    assert.doesNotThrow(() => assertInventoryResurrection(f.pm2Home));
    assert.doesNotThrow(() =>
      assertInventoryResurrection(path.join(f.root, "not-created")),
    );

    const dump = path.join(f.pm2Home, "dump.pm2");
    const backup = `${dump}.bak`;
    const journalPath = path.join(f.pm2Home, "erp-inventory-activation.json");
    const script = path.join(f.root, "approved.cjs");
    fs.writeFileSync(script, "approved ERP artifact");
    const hash = createHash("sha256").update(fs.readFileSync(script)).digest("hex");
    const journal = {
      version: 1,
      phase: "READY",
      artifacts: [
        { name: "erp-server", script, bundle: script, hash, scriptHash: hash, instances: 1 },
      ],
    };
    const saveJournal = (value) =>
      fs.writeFileSync(journalPath, JSON.stringify(value), { mode: 0o600 });
    const saveBackup = (pm_exec_path) => fs.writeFileSync(
      backup,
      JSON.stringify([{ name: "erp-server", pm_exec_path }]),
    );
    saveBackup(script);
    // Genuine legacy absence remains allowed, but existsSync also reports false
    // for a retained dangling link. Use a real junction on Windows (no elevation).
    assert.doesNotThrow(() => assertInventoryResurrection(f.pm2Home));
    fs.symlinkSync(
      path.join(f.root, "missing-journal-target"),
      journalPath,
      process.platform === "win32" ? "junction" : "file",
    );
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.lstatSync(journalPath).isSymbolicLink(), true);
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_JOURNAL_UNTRUSTED/,
    );
    fs.unlinkSync(journalPath);
    fs.mkdirSync(journalPath);
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_JOURNAL_UNTRUSTED/,
    );
    fs.rmdirSync(journalPath);
    fs.writeFileSync(journalPath, "{", { mode: 0o600 });
    assert.throws(() => assertInventoryResurrection(f.pm2Home), SyntaxError);
    fs.unlinkSync(journalPath);
    // Do not turn uncertain journal metadata into legacy absence. These errors
    // cannot be induced portably with filesystem permissions on Windows.
    const lstatSync = fs.lstatSync;
    try {
      for (const code of ["EACCES", "EIO"]) {
        const failure = Object.assign(new Error(code), { code });
        fs.lstatSync = (file, ...args) => {
          if (file === journalPath) throw failure;
          return lstatSync(file, ...args);
        };
        assert.throws(() => assertInventoryResurrection(f.pm2Home), failure);
      }
    } finally {
      fs.lstatSync = lstatSync;
    }
    saveJournal(journal);
    assert.doesNotThrow(() => assertInventoryResurrection(f.pm2Home));
    saveJournal({ ...journal, phase: "FATAL" });
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_RECOVERY_REQUIRED/,
    );
    saveJournal(journal);
    saveBackup(path.join(f.root, "stale.cjs"));
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_ARTIFACT_MISMATCH/,
    );
    saveBackup(script);
    fs.writeFileSync(script, "tampered ERP artifact");
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_ARTIFACT_MISMATCH/,
    );
    fs.writeFileSync(backup, "{");
    assert.throws(() => assertInventoryResurrection(f.pm2Home), SyntaxError);
    fs.writeFileSync(backup, "{}");
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_DUMP_INVALID/,
    );
    fs.unlinkSync(backup);
    fs.mkdirSync(backup);
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_DUMP_UNTRUSTED/,
    );
    fs.rmdirSync(backup);
    // A broken primary must fail closed rather than silently allowing PM2's
    // fallback; a valid primary takes precedence over a hostile backup.
    fs.writeFileSync(dump, "{");
    saveBackup(script);
    assert.throws(() => assertInventoryResurrection(f.pm2Home), SyntaxError);
    fs.writeFileSync(dump, "[]");
    assert.doesNotThrow(() => assertInventoryResurrection(f.pm2Home));
    fs.unlinkSync(dump);
    fs.unlinkSync(backup);
    for (const phase of ["PRE_RELEASE", "READY", "RELEASED"]) {
      saveJournal({ ...journal, phase });
      assert.throws(
        () => assertInventoryResurrection(f.pm2Home),
        /INVENTORY_BOOT_RECOVERY_REQUIRED/,
      );
    }
    fs.writeFileSync(journalPath, "{");
    assert.throws(
      () => assertInventoryResurrection(f.pm2Home),
      /INVENTORY_BOOT_RECOVERY_REQUIRED/,
    );
    fs.unlinkSync(journalPath);
    assert.doesNotThrow(() => assertInventoryResurrection(f.pm2Home));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const account = parseDeployAccount(
    "root:x:0:0:root:/root:/bin/bash\ndeploy:x:1001:1002::/home/deploy:/bin/bash\n",
  );
  assert.deepEqual(account, { uid: UID, gid: GID, home: "/home/deploy" });
  assert.throws(
    () => parseDeployAccount("deploy:x:1001:1002::/srv/deploy:/bin/bash\n"),
    /PM2_SYSTEMD_DEPLOY_ACCOUNT_INVALID/,
  );
  assert.throws(
    () =>
      parseDeployAccount(
        "deploy:x:1001:1002::/home/deploy:/bin/bash\ndeploy:x:2001:2002::/home/deploy:/bin/bash\n",
      ),
    /PM2_SYSTEMD_DEPLOY_ACCOUNT_INVALID/,
  );
}

{
  const command = buildResurrectCommand({
    uid: UID,
    gid: GID,
    home: "/home/deploy",
  });
  assert.equal(command.file, "/usr/bin/setpriv");
  assert.deepEqual(command.args, [
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    `--reuid=${UID}`,
    `--regid=${GID}`,
    "--init-groups",
    "--",
    "/opt/alroya-erp/node-v24.22.1-linux-x64/bin/node",
    "/usr/lib/node_modules/pm2/bin/pm2",
    "resurrect",
  ]);
  assert.deepEqual(command.options.env, {
    HOME: "/home/deploy",
    LOGNAME: "deploy",
    PATH: "/opt/alroya-erp/node-v24.22.1-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PM2_HOME: "/home/deploy/.pm2",
    USER: "deploy",
  });
  assert.equal(command.options.cwd, "/home/deploy");
}

{
  const f = fixture();
  try {
    addDaemon(f.procRoot, f.pm2Home, 4242);
    let resurrectCalls = 0;
    const result = await reconcilePm2ForSystemd({
      pm2Home: f.pm2Home,
      pidFile: f.pidFile,
      procRoot: f.procRoot,
      deployUid: UID,
      expectedVersion: VERSION,
      runResurrect: async () => {
        resurrectCalls += 1;
      },
    });
    assert.equal(resurrectCalls, 1);
    assert.deepEqual(result, { pid: 4242, startTime: "987654" });
    assert.equal(fs.readFileSync(f.pidFile, "utf8"), "4242\n");
    if (process.platform !== "win32") {
      const stat = fs.statSync(f.pidFile);
      assert.equal(stat.uid, process.geteuid());
      assert.equal(stat.gid, process.getegid());
      assert.equal(stat.mode & 0o777, 0o644);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const result = await reconcilePm2ForSystemd({
      pm2Home: f.pm2Home,
      pidFile: f.pidFile,
      procRoot: f.procRoot,
      deployUid: UID,
      expectedVersion: VERSION,
      runResurrect: async () =>
        addDaemon(f.procRoot, f.pm2Home, 5252, "123456"),
    });
    assert.deepEqual(result, { pid: 5252, startTime: "123456" });
    assert.equal(fs.readFileSync(f.pidFile, "utf8"), "5252\n");
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
      reconcilePm2ForSystemd({
        pm2Home: f.pm2Home,
        pidFile: f.pidFile,
        procRoot: f.procRoot,
        deployUid: UID,
        expectedVersion: VERSION,
        runResurrect: async () => {
          resurrected = true;
        },
      }),
      /PM2_SYSTEMD_MULTIPLE_DAEMONS/,
    );
    assert.equal(resurrected, false);
    assert.equal(fs.existsSync(f.pidFile), false);
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
  assert.match(dropIn, /^PIDFile=\/run\/erp-pm2\/pm2-deploy\.pid$/mu);
  assert.match(dropIn, /^UnsetEnvironment=NODE_OPTIONS NODE_PATH$/mu);
  assert.match(dropIn, /^ExecStart=$/mu);
  assert.match(
    dropIn,
    /^ExecStart=\+\/opt\/alroya-erp\/node-v24\.22\.1-linux-x64\/bin\/node \/usr\/local\/libexec\/erp\/pm2-systemd-start\.mjs$/mu,
  );
  assert.doesNotMatch(dropIn, /\/home\/deploy\/erp/u);
  assert.doesNotMatch(dropIn, /^ExecStop=/mu);

  const helper = fs.readFileSync(
    path.join(PROJECT_ROOT, "deploy/systemd/pm2-systemd-start.mjs"),
    "utf8",
  );
  assert.doesNotMatch(helper, /from\s+["']\.\.?\//u);
  assert.doesNotMatch(helper, /\/home\/deploy\/erp/u);
  assert.doesNotMatch(helper, /hr-bridge-runtime-policy/u);
  assert.ok(helper.indexOf("assertInventoryResurrection(PM2_HOME)") < helper.indexOf("const daemon = await reconcilePm2ForSystemd("),
    "durable ERP activation interlock must run before PM2 resurrection");

  const docs = fs.readFileSync(
    path.join(PROJECT_ROOT, "docs/deployment-vps.md"),
    "utf8",
  );
  assert.doesNotMatch(docs, /sudo\s+\/usr\/bin\/node\s+scripts\/install-pm2/u);
  assert.match(docs, /<CI_GREEN_RELEASE_SHA>/u);
  assert.match(docs, /<RELEASE_PM2_HELPER_SHA256>/u);
  assert.match(docs, /<RELEASE_PM2_DROPIN_SHA256>/u);
  assert.match(docs, /\/usr\/bin\/mktemp \/usr\/local\/libexec\/erp\//u);
  assert.match(docs, /\/usr\/bin\/sha256sum -c -/u);
  assert.match(docs, /\/usr\/bin\/mv -Tf -- "\$helper_tmp"/u);
  assert.match(
    docs,
    /mktemp -d "\/var\/backups\/erp-systemd\/\$\{release_sha\}\.XXXXXX"/u,
  );
  assert.match(docs, /pm2-systemd-start\.mjs --inspect/u);
  assert.doesNotMatch(
    docs,
    /before="\$\(cat \/home\/deploy\/\.pm2\/pm2\.pid\)"/u,
  );

  const ci = fs.readFileSync(
    path.join(PROJECT_ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(ci, /RELEASE_PM2_HELPER_SHA256/u);
  assert.match(ci, /RELEASE_PM2_DROPIN_SHA256/u);
  assert.match(ci, /GITHUB_STEP_SUMMARY/u);

  const deploymentVerifier = fs.readFileSync(
    path.join(PROJECT_ROOT, "scripts/verify-hr-bridge-deployment.mjs"),
    "utf8",
  );
  assert.match(deploymentVerifier, /pm2-systemd-start\.test\.mjs/u);
}

console.log("pm2 systemd pidfile selftest: OK");
