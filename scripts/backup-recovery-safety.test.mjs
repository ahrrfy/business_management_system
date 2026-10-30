import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { publishEncryptedBackup, mirrorPublishedBackup, fingerprint } from "./lib/backup-publication.mjs";

// Keep synthetic evidence; never remove existing files or connect to a database.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "erp-backup-safety-"));
  const sqlFile = join(directory, "erp_test-2026-10-30T01-00-00.sql");
  await writeFile(sqlFile, "-- synthetic SQL only\n".repeat(80));
  return { directory, sqlFile };
}

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
  const gpgPath = value => process.env.BACKUP_TEST_GPG_MSYS === "1"
    ? value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/") : value;
  const run = args => spawnSync(gpg, ["--homedir", home, "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0", ...args].map(gpgPath),
    { input: "synthetic-test-key-only", maxBuffer: 1024 * 1024 });
  await publishEncryptedBackup({ sqlFile, encrypt(partial) {
    const r = run(["--symmetric", "--cipher-algo", "AES256", "-o", partial, sqlFile]);
    assert.equal(r.status, 0, `GPG synthetic encryption must succeed: ${r.stderr}`);
  } });
  const mirror = join(directory, "mirror");
  await mirrorPublishedBackup(`${sqlFile}.gpg`, mirror);
  const encrypted = join(mirror, basename(`${sqlFile}.gpg`));
  const r = run(["--decrypt", encrypted]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout, await readFile(sqlFile));
  const wrongHome = join(directory, "wrong-key-home");
  await mkdir(wrongHome);
  const wrong = spawnSync(gpg, ["--homedir", wrongHome, "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--decrypt", encrypted].map(gpgPath), { input: "wrong-key" });
  assert.notEqual(wrong.status, 0);
  assert.ok((await readdir(directory)).length > 0);
});
