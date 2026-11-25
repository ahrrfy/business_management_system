import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseBackupSqlName, rotateBackups } from "../backup-rotate.mjs";

const SQL_PAYLOAD = "-- ALROYA_DB_NEUTRAL_BACKUP:erp\n" + "SELECT 1;\n".repeat(80);
const GPG_PAYLOAD = "encrypted-gpg-payload-bytes-".repeat(25);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "erp-backup-rotate-test-"));
  t.after(async () => {
    const abs = path.resolve(dir);
    assert.ok(abs.startsWith(path.resolve(tmpdir()) + path.sep));
    await fs.rm(abs, { recursive: true, force: true });
  });
  return dir;
}

async function writeVerifiedSet(dir, sqlName, { withSql = true, withManifest = true } = {}) {
  if (withSql) {
    await fs.writeFile(path.join(dir, sqlName), SQL_PAYLOAD);
  }
  await fs.writeFile(path.join(dir, `${sqlName}.gpg`), GPG_PAYLOAD);
  if (withManifest) {
    const manifest = {
      version: 1,
      file: `${sqlName}.gpg`,
      size: Buffer.byteLength(GPG_PAYLOAD),
      sha256: sha256(GPG_PAYLOAD),
      publishedAt: "2026-11-25T09:00:00.000Z",
      source: {
        file: sqlName,
        size: Buffer.byteLength(SQL_PAYLOAD),
        sha256: sha256(SQL_PAYLOAD),
      },
    };
    await fs.writeFile(path.join(dir, `${sqlName}.gpg.manifest.json`), JSON.stringify(manifest));
  }
}

test("parseBackupSqlName isolates hyphenated database names without collision", () => {
  assert.deepEqual(
    parseBackupSqlName("erp-2026-11-25T09-00-01-271Z-eb0b5de1.sql")?.dbName,
    "erp",
  );
  assert.deepEqual(
    parseBackupSqlName("erp-baghdad-2026-11-25T09-00-01-271Z-eb0b5de1.sql")?.dbName,
    "erp-baghdad",
  );
});

test("evicts older plain SQL only when verified GPG exists, preserving 2 newest + 1 previous-day", async (t) => {
  const dir = await makeTempDir(t);
  const s1 = "erp-2026-11-25T12-00-00-000Z-aaaa0001.sql";
  const s2 = "erp-2026-11-25T11-00-00-000Z-aaaa0002.sql";
  const s3SameDay = "erp-2026-11-25T09-00-00-000Z-aaaa0003.sql";
  const s4PrevDay = "erp-2026-11-24T23-00-00-000Z-aaaa0004.sql";
  const s5Unverified = "erp-2026-11-23T23-00-00-000Z-aaaa0005.sql";

  await writeVerifiedSet(dir, s1);
  await writeVerifiedSet(dir, s2);
  await writeVerifiedSet(dir, s3SameDay);
  await writeVerifiedSet(dir, s4PrevDay);
  await writeVerifiedSet(dir, s5Unverified, { withSql: true, withManifest: false });

  const now = Date.parse("2026-11-25T12:30:00.000Z");
  const dry = await rotateBackups({ backupDir: dir, keepPlainSql: 3, now, dryRun: true });
  assert.deepEqual(dry.plainSqlDeleted, [s3SameDay]);
  await fs.stat(path.join(dir, s3SameDay)); // untouched on dryRun

  const applied = await rotateBackups({ backupDir: dir, keepPlainSql: 3, now, dryRun: false });
  assert.deepEqual(applied.plainSqlDeleted, [s3SameDay]);
  await fs.stat(path.join(dir, s1));
  await fs.stat(path.join(dir, s2));
  await fs.stat(path.join(dir, s4PrevDay)); // previous day kept!
  await fs.stat(path.join(dir, s5Unverified)); // unverified GPG never loses plain SQL!
  await assert.rejects(fs.stat(path.join(dir, s3SameDay)), { code: "ENOENT" });
});

test("enforces minKeepEncrypted floor, two-phase .retiring/ cushion, and preserves latest-verified-restore.json", async (t) => {
  const dir = await makeTempDir(t);
  const reports = path.join(dir, "restore-reports");
  await fs.mkdir(reports, { recursive: true });

  // Create 12 daily archives spanning 40 days back so older ones fall outside 3d daily / 1w weekly / 1m monthly
  const names = [];
  for (let d = 0; d < 12; d++) {
    const stamp = new Date(Date.UTC(2026, 10, 25 - d * 3, 9, 0, 0));
    const y = stamp.getUTCFullYear();
    const m = String(stamp.getUTCMonth() + 1).padStart(2, "0");
    const day = String(stamp.getUTCDate()).padStart(2, "0");
    const name = `erp-${y}-${m}-${day}T09-00-00-000Z-000000${String(d).padStart(2, "0")}.sql`;
    names.push(name);
    await writeVerifiedSet(dir, name, { withSql: false });
  }

  // Attach a valid SQL restore proof ONLY to the oldest snapshot (names[11])
  const oldest = names[11];
  const restoredAt = "2026-10-25T10:00:00.000Z";
  await fs.writeFile(
    path.join(reports, `${oldest}.restore.json`),
    JSON.stringify({
      status: "SQL_RESTORED_CORE_READS_PASSED",
      productionContact: false,
      stopped: true,
      finishedAt: restoredAt,
      sourceBefore: { size: Buffer.byteLength(GPG_PAYLOAD), sha256: sha256(GPG_PAYLOAD) },
      sourceAfter: { size: Buffer.byteLength(GPG_PAYLOAD), sha256: sha256(GPG_PAYLOAD) },
      sqlFingerprint: { size: Buffer.byteLength(SQL_PAYLOAD), sha256: sha256(SQL_PAYLOAD) },
    }),
  );

  const now = Date.parse("2026-11-25T12:00:00.000Z");
  const r1 = await rotateBackups({
    backupDir: dir,
    keepAllHours: 1,
    keepDaily: 2,
    keepWeekly: 1,
    keepMonthly: 1,
    minKeepEncrypted: 10,
    now,
  });
  // Exactly 10 kept by floor, 2 oldest moved to .retiring/ (NOT deleted yet!)
  assert.equal(r1.encryptedRetired.length, 2);
  assert.ok(r1.encryptedRetired.includes(oldest));
  await fs.stat(path.join(dir, ".retiring", `${oldest}.gpg`));
  await fs.stat(path.join(dir, ".retiring", `${oldest}.retired.json`));

  // Before 60m grace expires, Phase 2 keeps .retiring/ intact
  const r2 = await rotateBackups({
    backupDir: dir,
    keepAllHours: 1,
    keepDaily: 2,
    keepWeekly: 1,
    keepMonthly: 1,
    minKeepEncrypted: 10,
    now: now + 30 * 60 * 1000,
  });
  assert.equal(r2.retiringPurged.length, 0);
  await fs.stat(path.join(dir, ".retiring", `${oldest}.gpg`));

  // After 61 minutes, Phase 2 physically purges .retiring/ AND writes latest-verified-restore.json!
  const r3 = await rotateBackups({
    backupDir: dir,
    keepAllHours: 1,
    keepDaily: 2,
    keepWeekly: 1,
    keepMonthly: 1,
    minKeepEncrypted: 10,
    now: now + 61 * 60 * 1000,
  });
  assert.ok(r3.retiringPurged.includes(oldest));
  await assert.rejects(fs.stat(path.join(dir, ".retiring", `${oldest}.gpg`)), { code: "ENOENT" });
  const summary = JSON.parse(await fs.readFile(path.join(reports, "latest-verified-restore.json"), "utf8"));
  assert.deepEqual(summary, { version: 1, name: oldest, at: restoredAt });
});

test("isolates multi-tenant databases so erp-baghdad never evicts erp backups", async (t) => {
  const dir = await makeTempDir(t);
  const erp1 = "erp-2026-11-20T09-00-00-000Z-bbbb0001.sql";
  await writeVerifiedSet(dir, erp1);
  for (let i = 1; i <= 5; i++) {
    await writeVerifiedSet(dir, `erp-baghdad-2026-11-25T0${i}-00-00-000Z-cccc000${i}.sql`);
  }
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  await rotateBackups({ backupDir: dir, keepPlainSql: 2, now });
  // `erp`'s single plain SQL must remain untouched despite 5 newer `erp-baghdad` backups!
  await fs.stat(path.join(dir, erp1));
});
