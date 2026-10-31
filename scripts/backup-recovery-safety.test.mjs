import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rename } from "node:fs/promises";
import { existsSync, writeFileSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { publishEncryptedBackup, mirrorPublishedBackup, fingerprint } from "./lib/backup-publication.mjs";
import { encryptBackupWithOwnedAgent } from "./lib/backup-gpg.mjs";

test("the real backup encrypt callback owns its GPG agent before publication", async () => {
  const source = await readFile(new URL("./backup.mjs", import.meta.url), "utf8");
  assert.match(source, /import\s*\{\s*encryptBackupWithOwnedAgent\s*\}\s*from\s*["']\.\/lib\/backup-gpg\.mjs["']/);
  assert.match(source, /encrypt\(partialFile\)\s*\{\s*return encryptBackupWithOwnedAgent\(/);
  assert.doesNotMatch(source, /spawnSync\("gpg"/);
});

// Keep synthetic evidence; never remove existing files or connect to a database.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "erp-backup-safety-"));
  const sqlFile = join(directory, "erp_test-2026-10-30T01-00-00.sql");
  await writeFile(sqlFile, "-- synthetic SQL only\n".repeat(80));
  return { directory, sqlFile };
}

async function agentFixture(scenario = "success", msys = false) {
  const fixtureFiles = await fixture();
  let live = false;
  let clock = 0;
  let pidReads = 0;
  const calls = [];
  const state = { home: null, calls };
  const options = {
    sqlFile: fixtureFiles.sqlFile, passphrase: "test-passphrase-canary", msys,
    gpg: msys ? join(fixtureFiles.directory, "gpg.exe") : "gpg",
    shutdownTimeoutMs: 100,
    environment: { PATH: "platform-only", DB_ROOT_PW: "root-secret-canary", ERP_INVENTORY_CONTROL_DATABASE_URL: "control-secret-canary", GNUPGHOME: "must-not-inherit", BACKUP_GPG_PASSPHRASE: "must-not-inherit" },
    now: () => clock, wait: async ms => { clock += ms; },
    alive(pid) {
      assert.equal(pid, msys ? 7777 : 4242);
      if (scenario === "probe-error") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return scenario === "never-live" ? false : live;
    },
    run(command, args, settings) {
      calls.push({ command, args, settings });
      assert.equal(settings.env.DB_ROOT_PW, undefined);
      assert.equal(settings.env.ERP_INVENTORY_CONTROL_DATABASE_URL, undefined);
      assert.equal(settings.env.BACKUP_GPG_PASSPHRASE, undefined);
      assert.equal(settings.env.GNUPGHOME, settings.env.HOME);
      assert.equal(JSON.stringify(args).includes(options.passphrase), false);
      if (args.includes("--homedir")) state.home = settings.env.GNUPGHOME;
      if (args.includes("--launch")) {
        if (scenario === "missing-tool") return { status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        live = true;
      }
      if (args.includes("GETINFO pid")) {
        pidReads++;
        if (scenario === "final-probe-error" && pidReads > 1) return { status: 1 };
        return { status: 0, stdout: scenario === "bad-pid" ? "D 4242\nD 4243\nOK\n" : scenario === "replacement" && pidReads > 1 ? "D 4243\nOK\n" : "D 4242\nOK\n" };
      }
      if (basename(command) === "ps.exe") return { status: 0, stdout: "PID PPID PGID WINPID TTY UID STIME COMMAND\n4242 1 4242 7777 ? 1 00:00 /usr/bin/gpg-agent\n" + (scenario === "bad-mapping" ? "4242 1 4242 8888 ? 1 00:00 /usr/bin/gpg-agent\n" : "") };
      if (args.includes("--symmetric")) {
        assert.equal(settings.input, options.passphrase);
        assert.ok(args.includes("AES256"));
        assert.ok(args.includes("loopback"));
        assert.equal(args[args.indexOf("--passphrase-fd") + 1], "0");
        if (scenario === "encryption") return { status: 2 };
        writeFileSync(options.partialFile, "synthetic ciphertext");
        if (scenario === "home-identity") {
          assert.equal(dirname(realpathSync(state.home)), realpathSync(tmpdir()));
          assert.ok(basename(state.home).startsWith("erp-backup-gpg-"));
          renameSync(state.home, `${state.home}.saved`);
          mkdirSync(state.home);
          writeFileSync(join(state.home, "preserve-marker"), "replacement must remain");
        }
      } else assert.equal(settings.input, undefined);
      if (args.includes("--kill")) {
        assert.deepEqual(args.slice(-2), ["--kill", "gpg-agent"]);
        if (scenario === "kill") return { status: 1 };
        if (scenario !== "still-live") live = false;
      }
      return { status: 0, stdout: "" };
    },
  };
  const publish = () => publishEncryptedBackup({ sqlFile: fixtureFiles.sqlFile, encrypt(partialFile) {
    options.partialFile = partialFile;
    return encryptBackupWithOwnedAgent(options);
  } });
  return { ...fixtureFiles, state, publish };
}

test("owned agent is stopped before ciphertext publication; platform-only environment and stdin secret", async () => {
  const f = await agentFixture();
  await f.publish();
  assert.equal(existsSync(f.state.home), false);
  assert.equal(existsSync(`${f.sqlFile}.gpg.manifest.json`), true);
  assert.equal(f.state.calls.filter(c => c.args.includes("--kill")).length, 1);
  assert.ok(f.state.calls.find(c => c.args.includes("--no-autostart")));
});

test("encryption failure still ends the owned agent and preserves SQL without publication", async () => {
  const f = await agentFixture("encryption");
  await assert.rejects(f.publish(), /BACKUP_ENCRYPTION_FAILED/);
  assert.equal(existsSync(f.state.home), false);
  assert.equal(existsSync(f.sqlFile), true);
  assert.equal(existsSync(`${f.sqlFile}.gpg.manifest.json`), false);
});

for (const scenario of ["kill", "still-live", "never-live", "probe-error", "bad-pid", "missing-tool", "home-identity", "replacement", "final-probe-error"]) {
  test(`${scenario} fails closed and retains the owned diagnostic home and SQL`, async () => {
    const f = await agentFixture(scenario);
    await assert.rejects(f.publish(), error => error.code === "BACKUP_GPG_AGENT_CLEANUP_FAILED" && error.diagnosticHome === f.state.home);
    assert.equal(existsSync(f.state.home), true);
    assert.equal(existsSync(f.sqlFile), true);
    assert.equal(existsSync(`${f.sqlFile}.gpg`), false);
    assert.equal(existsSync(`${f.sqlFile}.gpg.manifest.json`), false);
    assert.equal(f.state.calls.filter(c => c.args.includes("--kill")).length, scenario === "home-identity" ? 0 : 1);
    if (scenario === "home-identity") assert.equal(await readFile(join(f.state.home, "preserve-marker"), "utf8"), "replacement must remain");
  });
}

test("explicit MSYS PID mapping must be singular before the native PID can be probed", async () => {
  const good = await agentFixture("success", true);
  await good.publish();
  assert.equal(existsSync(good.state.home), false);
  const bad = await agentFixture("bad-mapping", true);
  await assert.rejects(bad.publish(), /BACKUP_GPG_AGENT_CLEANUP_FAILED/);
  assert.equal(bad.state.calls.some(c => c.args.includes("--symmetric")), false);
  assert.equal(existsSync(bad.state.home), true);
});

test("concurrent backups use distinct homes and never kill by PID or process name", async () => {
  const [a, b] = await Promise.all([agentFixture(), agentFixture()]);
  await Promise.all([a.publish(), b.publish()]);
  assert.notEqual(a.state.home, b.state.home);
  for (const f of [a, b]) assert.ok(f.state.calls.every(c => c.command !== "kill" && c.command !== "pkill"));
});

test("ciphertext and receipt are invisible until encryption completes; hash roundtrip", async () => {
  const { sqlFile } = await fixture();
  const m = await publishEncryptedBackup({ sqlFile, async encrypt(partial) {
    await writeFile(partial, "synthetic ciphertext");
    assert.equal(existsSync(`${sqlFile}.gpg`), false);
    assert.equal(existsSync(`${sqlFile}.gpg.manifest.json`), false);
  } });
  assert.deepEqual(await fingerprint(`${sqlFile}.gpg`), { size: m.size, sha256: m.sha256 });
  assert.equal(m.recovery.status, "NOT_RESTORE_VERIFIED");
  assert.equal(m.source.sha256, (await fingerprint(sqlFile)).sha256);
  await assert.rejects(publishEncryptedBackup({ sqlFile, encrypt() { assert.fail("must not overwrite"); } }), /EXISTS/);
});

test("nonzero encryption, empty output and changing SQL never publish a receipt", async () => {
  for (const scenario of ["failed", "empty", "changed"]) {
    const { sqlFile } = await fixture();
    await assert.rejects(publishEncryptedBackup({ sqlFile, async encrypt(partial) {
      await writeFile(partial, scenario === "empty" ? "" : "partial");
      if (scenario === "failed") throw new Error("simulated gpg failure");
      if (scenario === "changed") await writeFile(sqlFile, "modified".repeat(100));
    } }));
    assert.equal(existsSync(`${sqlFile}.gpg`), false);
    assert.equal(existsSync(`${sqlFile}.gpg.manifest.json`), false);
  }
});

test("offsite copy validates data, is repeatable, preserves a corrupt prior destination", async () => {
  const { sqlFile, directory } = await fixture();
  await publishEncryptedBackup({ sqlFile, encrypt: p => writeFile(p, "ciphertext") });
  const mirror = join(directory, "mirror");
  await mirrorPublishedBackup(`${sqlFile}.gpg`, mirror);
  await mirrorPublishedBackup(`${sqlFile}.gpg`, mirror);
  const target = join(mirror, basename(`${sqlFile}.gpg`));
  await rename(`${target}.manifest.json`, `${target}.manifest.saved`);
  await mirrorPublishedBackup(`${sqlFile}.gpg`, mirror);
  assert.equal(JSON.parse(await readFile(`${target}.manifest.json`, "utf8")).sha256, (await fingerprint(target)).sha256);
  await writeFile(target, "corrupt");
  await assert.rejects(mirrorPublishedBackup(`${sqlFile}.gpg`, mirror), /EXISTS_UNVERIFIED/);
  assert.equal(await readFile(target, "utf8"), "corrupt");
  await assert.rejects(mirrorPublishedBackup(`${sqlFile}.gpg`, sqlFile));
});

test("actual GPG AES256 encrypt, offsite copy, decrypt and wrong-key rejection on synthetic SQL", async t => {
  const gpg = process.env.BACKUP_TEST_GPG;
  if (!gpg) return t.skip("Set BACKUP_TEST_GPG for an isolated real encryption roundtrip");
  const { sqlFile, directory } = await fixture();
  const home = join(directory, "gpg-home");
  await mkdir(home);
  const wrongHome = join(directory, "wrong-key-home");
  await mkdir(wrongHome);
  const msys = process.env.BACKUP_TEST_GPG_MSYS === "1";
  const gpgconf = join(dirname(gpg), process.platform === "win32" ? "gpgconf.exe" : "gpgconf");
  const connectAgent = join(dirname(gpg), process.platform === "win32" ? "gpg-connect-agent.exe" : "gpg-connect-agent");
  const gpgPath = value => process.env.BACKUP_TEST_GPG_MSYS === "1"
    ? value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/") : value;
  const isolatedEnv = isolated => Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: isolated, GNUPGHOME: isolated, LC_ALL: "C" }).filter(([, value]) => value !== undefined));
  const control = (command, args, isolated = home) => spawnSync(command, ["--homedir", isolated, ...args].map(gpgPath),
    { encoding: "utf8", timeout: 5000, env: isolatedEnv(isolated) });
  const run = (args, isolated = home, passphrase = "synthetic-test-key-only") => spawnSync(gpg,
    ["--homedir", isolated, "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0", ...args].map(gpgPath),
    { input: passphrase, maxBuffer: 1024 * 1024, env: isolatedEnv(isolated) });
  let ownedHome;
  let ownedPid;
  try {
  // Another private home/agent must survive the backup helper unchanged.
  await writeFile(join(home, "preserve-marker"), "unrelated home stays intact");
  assert.equal(control(gpgconf, ["--launch", "gpg-agent"]).status, 0);
  const otherBefore = control(connectAgent, ["--no-autostart", "GETINFO pid", "/bye"]);
  assert.equal(otherBefore.status, 0);
  await publishEncryptedBackup({ sqlFile, encrypt(partialFile) {
    return encryptBackupWithOwnedAgent({ sqlFile, partialFile, passphrase: "synthetic-test-key-only", gpg, msys,
      run(command, args, options) {
        ownedHome = options.env.GNUPGHOME;
        const result = spawnSync(command, args, options);
        if (basename(command) === "ps.exe" && result.status === 0) ownedPid = Number(result.stdout.trim().split(/\r?\n/)[1].trim().split(/\s+/)[3]);
        if (!msys && args.includes("GETINFO pid")) ownedPid = Number(result.stdout.match(/^D (\d+)\r?$/m)?.[1]);
        return result;
      },
    });
  } });
  assert.equal(existsSync(ownedHome), false);
  assert.throws(() => process.kill(ownedPid, 0), error => error.code === "ESRCH");
  const otherAfter = control(connectAgent, ["--no-autostart", "GETINFO pid", "/bye"]);
  assert.equal(otherAfter.status, 0);
  assert.equal(otherAfter.stdout, otherBefore.stdout);
  assert.equal(await readFile(join(home, "preserve-marker"), "utf8"), "unrelated home stays intact");
  const mirror = join(directory, "mirror");
  await mirrorPublishedBackup(`${sqlFile}.gpg`, mirror);
  const encrypted = join(mirror, basename(`${sqlFile}.gpg`));
    const r = run(["--decrypt", encrypted]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout, await readFile(sqlFile));
    const wrong = run(["--decrypt", encrypted], wrongHome, "wrong-key");
    assert.notEqual(wrong.status, 0);
  } finally {
    for (const isolated of [home, wrongHome]) assert.equal(control(gpgconf, ["--kill", "gpg-agent"], isolated).status, 0);
  }
  assert.ok((await readdir(directory)).length > 0);
});
