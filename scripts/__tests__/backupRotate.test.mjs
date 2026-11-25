import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireRetentionLock, parseBackupSqlName, rotateBackups } from "../backup-rotate.mjs";
import { acquireMaintenanceLock } from "../lib/maintenance-lock.mjs";

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
  // Exactly 10 kept by floor, 2 oldest marked in .retiring/ while keeping public `.gpg` + `.manifest.json` accessible during 60m grace!
  assert.equal(r1.encryptedRetired.length, 2);
  assert.ok(r1.encryptedRetired.includes(oldest));
  await fs.stat(path.join(dir, `${oldest}.gpg`));
  await fs.stat(path.join(dir, `${oldest}.gpg.manifest.json`));
  await fs.stat(path.join(dir, ".retiring", `${oldest}.retired.json`));

  // Before 60m grace expires, Phase 2 keeps public archive paths and .retiring/ marker intact
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
  await fs.stat(path.join(dir, `${oldest}.gpg`));
  await fs.stat(path.join(dir, `${oldest}.gpg.manifest.json`));

  // After 61 minutes, Phase 2 physically purges public archive + .retiring/ AND writes latest-verified-restore.json!
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
  await assert.rejects(fs.stat(path.join(dir, `${oldest}.gpg`)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(dir, `${oldest}.gpg.manifest.json`)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(dir, ".retiring", `${oldest}.retired.json`)), { code: "ENOENT" });
  const summary = JSON.parse(await fs.readFile(path.join(reports, "latest-verified-restore.json"), "utf8"));
  assert.deepEqual(summary, {
    version: 1,
    name: oldest,
    at: restoredAt,
    byDatabase: { erp: { name: oldest, at: restoredAt } },
  });
});

test("preserves per-database drill/restore summaries, purges nonstandard retired names, and serializes with restore lock", async (t) => {
  const dir = await makeTempDir(t);
  const reports = path.join(dir, "restore-reports");
  const retiring = path.join(dir, ".retiring");
  await fs.mkdir(reports, { recursive: true });
  await fs.mkdir(retiring, { recursive: true });

  const erpSnap = "erp-2026-10-10T09-00-00-000Z-aaaa0010.sql";
  const co2Snap = "erp_co2-2026-10-11T09-00-00-000Z-bbbb0020.sql";
  const manualSnap = "manual.sql";

  await writeVerifiedSet(retiring, erpSnap, { withSql: false });
  await writeVerifiedSet(retiring, co2Snap, { withSql: false });
  await writeVerifiedSet(retiring, manualSnap, { withSql: false });

  // Attach a validated `.drill.json` (no `.restore.json`) to `erpSnap` and a `.restore.json` to `co2Snap`
  const drillAt = "2026-10-10T10:30:00.000Z";
  await fs.writeFile(
    path.join(reports, `${erpSnap}.drill.json`),
    JSON.stringify({
      version: 1,
      file: erpSnap,
      source: { size: Buffer.byteLength(GPG_PAYLOAD), sha256: sha256(GPG_PAYLOAD) },
      lease: "1234:11111111-2222-3333-4444-555555555555",
      startedAt: "2026-10-10T10:00:00.000Z",
      finishedAt: drillAt,
      result: {
        status: "VERIFIED",
        tableCount: 42,
        rowCounts: { users: 2, branches: 1, invoices: 10, products: 20 },
        attachmentCheck: {
          scope: "KNOWN_FILE_REFERENCES_V1",
          references: 3,
          inlineVerified: 2,
          mirroredVerified: 1,
        },
      },
    }),
  );
  const co2RestoredAt = "2026-10-12T14:00:00.000Z";
  await fs.writeFile(
    path.join(reports, `${co2Snap}.restore.json`),
    JSON.stringify({
      status: "SQL_RESTORED_CORE_READS_PASSED",
      productionContact: false,
      stopped: true,
      finishedAt: co2RestoredAt,
      sourceBefore: { size: Buffer.byteLength(GPG_PAYLOAD), sha256: sha256(GPG_PAYLOAD) },
      sourceAfter: { size: Buffer.byteLength(GPG_PAYLOAD), sha256: sha256(GPG_PAYLOAD) },
      sqlFingerprint: { size: Buffer.byteLength(SQL_PAYLOAD), sha256: sha256(SQL_PAYLOAD) },
    }),
  );

  const expiredMeta = (file) => ({
    version: 1,
    file,
    reason: "OWNER_RETIRE",
    retiredAt: "2026-11-20T00:00:00.000Z",
    expiresAt: "2026-11-23T00:00:00.000Z",
  });
  for (const s of [erpSnap, co2Snap, manualSnap]) {
    await fs.writeFile(path.join(retiring, `${s}.retired.json`), JSON.stringify(expiredMeta(s)));
  }

  // While maintenance/restore lock is held, rotation skips immediately after acquiring retention lock
  const sampleTarget = path.join(dir, "active-restore-input.sql");
  await fs.writeFile(sampleTarget, SQL_PAYLOAD);
  const prevHeld = process.env.MAINTENANCE_LOCK_HELD_BY_PARENT;
  delete process.env.MAINTENANCE_LOCK_HELD_BY_PARENT;
  const releaseRestore = acquireMaintenanceLock(sampleTarget);
  try {
    const skipped = await rotateBackups({ backupDir: dir, now: Date.parse("2026-11-25T12:00:00.000Z") });
    assert.equal(skipped.skippedReason, "RESTORE_OR_DRILL_ACTIVE");
    await fs.stat(path.join(retiring, `${manualSnap}.gpg`));
  } finally {
    releaseRestore();
    if (prevHeld !== undefined) process.env.MAINTENANCE_LOCK_HELD_BY_PARENT = prevHeld;
  }

  const applied = await rotateBackups({ backupDir: dir, now: Date.parse("2026-11-25T12:00:00.000Z") });
  assert.deepEqual(new Set(applied.retiringPurged), new Set([erpSnap, co2Snap, manualSnap]));
  await assert.rejects(fs.stat(path.join(retiring, `${manualSnap}.gpg`)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(retiring, `${manualSnap}.retired.json`)), { code: "ENOENT" });

  const summary = JSON.parse(await fs.readFile(path.join(reports, "latest-verified-restore.json"), "utf8"));
  assert.deepEqual(summary.byDatabase, {
    erp: { name: erpSnap, at: drillAt },
    erp_co2: { name: co2Snap, at: co2RestoredAt },
  });
});

test("preserves current invocation SQL when keepPlainSql is 0 and fails closed on stale retention lock", async (t) => {
  const dir = await makeTempDir(t);
  const older = "erp-2026-11-25T10-00-00-000Z-dddd0001.sql";
  const current = "erp-2026-11-25T11-00-00-000Z-dddd0002.sql";
  await writeVerifiedSet(dir, older);
  await writeVerifiedSet(dir, current);

  const rotated = await rotateBackups({
    backupDir: dir,
    keepPlainSql: 0,
    preserveSqlNames: [current],
    now: Date.parse("2026-11-25T11:05:00.000Z"),
  });
  assert.deepEqual(rotated.plainSqlDeleted, [older]);
  await fs.stat(path.join(dir, current)); // preserved for receipt/download consumer!
  await assert.rejects(fs.stat(path.join(dir, older)), { code: "ENOENT" });

  // Stale `.retention.lock` fails closed without unlinking a replacement lock
  const lockPath = path.join(dir, ".retention.lock");
  await fs.writeFile(lockPath, "999999:stale-owner\n2026-11-25T00:00:00.000Z\n");
  const staleDate = new Date(Date.now() - 45 * 60 * 1000);
  await fs.utimes(lockPath, staleDate, staleDate);
  const lock = await acquireRetentionLock(dir, { waitAttempts: 2 });
  assert.equal(lock, null);
  await fs.stat(lockPath); // untouched — never unlinked without CAS!
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
