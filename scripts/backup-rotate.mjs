// تدوير النسخ الاحتياطية المحصّن ثنائي الطبقات (Plain SQL + Encrypted GFS + Two-Phase .retiring/).
//
// السياسة (قابلة للضبط عبر .env، وتُطبَّق لكل قاعدة بيانات على حدة):
//   BACKUP_KEEP_PLAIN_SQL        = 3   الإبقاء على آخر نسختين نصيتين + أحدث نسخة نصية لليوم السابق
//                                      (ولا يُحذف أي ملف .sql إلا بعد إثبات أرشيفه المشفر .sql.gpg + .manifest.json)
//   BACKUP_KEEP_ALL_HOURS        = 48  الإبقاء على جميع الأرشيفات المشفرة الموثقة خلال آخر ٤٨ ساعة
//   BACKUP_KEEP_DAILY            = 14  أحدث نسخة مشفرة موثقة لكل يوم لآخر ١٤ يوماً (UTC)
//   BACKUP_KEEP_WEEKLY           = 8   أحدث نسخة مشفرة موثقة لكل أسبوع لآخر ٨ أسابيع (UTC ISO)
//   BACKUP_KEEP_MONTHLY          = 6   أحدث نسخة مشفرة موثقة لكل شهر لآخر ٦ أشهر (UTC)
//   BACKUP_MIN_KEEP_ENCRYPTED    = 10  سقف أدنى صلب لا يُمس دونه أي أرشيف مشفر موثق
//   BACKUP_KEEP_FAILED_ATTEMPTS  = 5   الإبقاء على آخر ٥ إيصالات محاولات فاشلة/يتيمة للتشخيص
//
// المرحلة الأولى من تقاعد الأرشيف المشفر تنقله ذرياً إلى backups/.retiring/ لمدة ٦٠ دقيقة
// (أو ٧٢ ساعة عند الحذف اليدوي للمالك) حتى لا تتأثر أي جلسة سحب خارجي جارية، ثم تُحذف فيزيائياً.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { sweepDownloadCache } from "./vps-maintenance.mjs";

const GFS_RETIRING_TTL_MS = 60 * 60 * 1000;
const STALE_STARTED_MS = 6 * 60 * 60 * 1000;
const FAILED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_LOCK_STALE_MS = 30 * 60 * 1000;
const RESTORE_LOCK_STALE_MS = 5 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/;

function int(v, d) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/**
 * يحلّل اسم النسخة الاحتياطية بدقة مرساة من اليمين لمنع تداخل أسماء القواعد التي تحوي شرطة
 * (مثل `erp` مقابل `erp-baghdad`).
 */
export function parseBackupSqlName(name) {
  if (typeof name !== "string" || name.includes("..") || name !== path.basename(name)) {
    return null;
  }
  const m = /^([A-Za-z0-9_$-]+)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3})Z-[0-9a-f]{8})?\.sql$/i.exec(
    name,
  );
  if (!m) return null;
  const [, dbName, Y, Mo, D, H, Mi, S, milliseconds = "000"] = m;
  const stamp = new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:${S}.${milliseconds}Z`);
  if (Number.isNaN(stamp.getTime())) return null;
  return { dbName, date: stamp };
}

export function parseStamp(name) {
  return parseBackupSqlName(name)?.date ?? null;
}

export function utcDayKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function utcMonthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function utcWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

if (process.argv.includes("--selftest")) {
  assert.equal(
    parseStamp("erp-2026-08-12T10-36-22-123Z-acde1234.sql")?.toISOString(),
    "2026-08-12T10:36:22.123Z",
  );
  assert.equal(
    parseStamp("erp-2026-08-12T10-36-22.sql")?.toISOString(),
    "2026-08-12T10:36:22.000Z",
  );
  assert.equal(
    parseBackupSqlName("erp-baghdad-2026-08-12T10-36-22-123Z-acde1234.sql")?.dbName,
    "erp-baghdad",
  );
  assert.equal(parseStamp("erp-invalid.sql"), null);
  console.log("backup filename parser selftest: OK");
  process.exit(0);
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readSmallJson(file, maxBytes = 64 * 1024) {
  const st = await lstatOrNull(file);
  if (!st || !st.isFile() || st.size > maxBytes) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function atomicWriteJson(file, payload) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function hasActiveRestoreOrDrillFence(env = process.env) {
  const ownerDir = env.ERP_OWNER_RESTORE_DIRECTORY?.trim();
  if (ownerDir && path.isAbsolute(ownerDir)) {
    try {
      lstatSync(path.join(path.resolve(ownerDir), "maintenance"));
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") return true;
    }
  }
  const tmpEntries = await fs.readdir(tmpdir()).catch(() => []);
  const now = Date.now();
  for (const entry of tmpEntries) {
    if (!/^erp-restore-[a-f0-9]{12}\.lock$/i.test(entry)) continue;
    const st = await lstatOrNull(path.join(tmpdir(), entry));
    if (st?.isFile() && now - st.mtimeMs <= RESTORE_LOCK_STALE_MS) return true;
  }
  return false;
}

export async function acquireRetentionLock(backupDir, { now = Date.now(), waitAttempts = 10 } = {}) {
  await fs.mkdir(backupDir, { recursive: true });
  const lockPath = join(backupDir, ".retention.lock");
  const owner = `${process.pid}:${randomUUID()}`;
  for (let i = 0; i < waitAttempts; i++) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${owner}\n${new Date(now).toISOString()}\n`);
      await handle.close();
      return async () => {
        const cur = (await fs.readFile(lockPath, "utf8").catch(() => "")).split("\n", 1)[0];
        if (cur === owner) await fs.unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const st = await lstatOrNull(lockPath);
      if (st && Date.now() - st.mtimeMs > RETENTION_LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }
      if (i < waitAttempts - 1) await delay(150);
    }
  }
  return null;
}

export async function inspectVerifiedManifest(directory, sqlName) {
  const archiveName = `${sqlName}.gpg`;
  const manifestPath = join(directory, `${archiveName}.manifest.json`);
  const archivePath = join(directory, archiveName);
  const [archiveStat, manifestStat] = await Promise.all([
    lstatOrNull(archivePath),
    lstatOrNull(manifestPath),
  ]);
  if (!archiveStat?.isFile() || !manifestStat?.isFile()) return null;
  if (archiveStat.mtimeMs > manifestStat.mtimeMs) return null;
  const manifest = await readSmallJson(manifestPath);
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.file !== archiveName ||
    manifest.size !== archiveStat.size ||
    !SHA256_RE.test(manifest.sha256 ?? "") ||
    manifest.source?.file !== sqlName ||
    !Number.isSafeInteger(manifest.source?.size) ||
    manifest.source.size < 512 ||
    !SHA256_RE.test(manifest.source?.sha256 ?? "")
  ) {
    return null;
  }
  return manifest;
}

async function preserveLatestRestoreSummary(reportDir, sqlName, manifest) {
  if (!manifest) return;
  const restorePath = join(reportDir, `${sqlName}.restore.json`);
  const report = await readSmallJson(restorePath);
  if (
    !report ||
    report.status !== "SQL_RESTORED_CORE_READS_PASSED" ||
    report.productionContact !== false ||
    report.stopped !== true ||
    typeof report.finishedAt !== "string" ||
    report.sqlFingerprint?.size !== manifest.source.size ||
    report.sqlFingerprint?.sha256 !== manifest.source.sha256
  ) {
    return;
  }
  const summaryPath = join(reportDir, "latest-verified-restore.json");
  const current = await readSmallJson(summaryPath);
  if (!current || typeof current.at !== "string" || report.finishedAt > current.at) {
    await atomicWriteJson(summaryPath, {
      version: 1,
      name: sqlName,
      at: report.finishedAt,
    });
  }
}

async function sweepExpiredRetiring({ backupDir, offsiteDir, reportDir, now, dryRun }) {
  const retiringDir = join(backupDir, ".retiring");
  const entries = await fs.readdir(retiringDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const purged = [];
  for (const entry of entries) {
    if (!entry.endsWith(".retired.json")) continue;
    const sqlName = entry.slice(0, -".retired.json".length);
    if (!parseBackupSqlName(sqlName)) continue;
    const markerPath = join(retiringDir, entry);
    const meta = await readSmallJson(markerPath);
    const expiresAt = Date.parse(meta?.expiresAt ?? "");
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;

    purged.push(sqlName);
    if (dryRun) continue;

    const retiredManifest = await inspectVerifiedManifest(retiringDir, sqlName);
    await preserveLatestRestoreSummary(reportDir, sqlName, retiredManifest).catch(() => {});

    for (const target of [
      join(retiringDir, `${sqlName}.gpg.manifest.json`),
      join(retiringDir, `${sqlName}.gpg`),
      join(retiringDir, `${sqlName}.attempt.json`),
      join(reportDir, `${sqlName}.restore.json`),
      join(reportDir, `${sqlName}.drill.json`),
    ]) {
      await fs.unlink(target).catch(() => {});
    }

    let offsiteStillPresent = false;
    if (offsiteDir) {
      for (const suffix of [".gpg.manifest.json", ".gpg"]) {
        const offTarget = join(offsiteDir, `${sqlName}${suffix}`);
        await fs.unlink(offTarget).catch(() => {});
      }
      const rem = await lstatOrNull(join(offsiteDir, `${sqlName}.gpg`));
      offsiteStillPresent = !!rem;
    }

    // Remove the tombstone unless an immutable/read-only offsite vault still holds the archive
    // for an owner-retired entry (preventing the row from reappearing in active UI).
    if (!offsiteStillPresent || meta?.reason !== "OWNER_RETIRE") {
      await fs.unlink(markerPath).catch(() => {});
    }
  }
  return purged;
}

async function retireEncryptedArchive({ backupDir, sqlName, now, ttlMs, reason, dryRun }) {
  if (dryRun) return;
  const retiringDir = join(backupDir, ".retiring");
  await fs.mkdir(retiringDir, { recursive: true, mode: 0o700 });
  const markerPath = join(retiringDir, `${sqlName}.retired.json`);
  await atomicWriteJson(markerPath, {
    version: 1,
    file: sqlName,
    reason,
    retiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
  await fs.unlink(join(backupDir, sqlName)).catch(() => {});
  for (const suffix of [".gpg.manifest.json", ".gpg", ".attempt.json"]) {
    const src = join(backupDir, `${sqlName}${suffix}`);
    const dst = join(retiringDir, `${sqlName}${suffix}`);
    await fs.rename(src, dst).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function rotateBackups({
  backupDir = process.env.BACKUP_DIR ?? "backups",
  offsiteDir = process.env.BACKUP_OFFSITE_DIR?.trim() || null,
  dbFilter = null,
  keepPlainSql = int(process.env.BACKUP_KEEP_PLAIN_SQL, 3),
  keepAllHours = int(process.env.BACKUP_KEEP_ALL_HOURS, 48),
  keepDaily = int(process.env.BACKUP_KEEP_DAILY, 14),
  keepWeekly = int(process.env.BACKUP_KEEP_WEEKLY, 8),
  keepMonthly = int(process.env.BACKUP_KEEP_MONTHLY, 6),
  minKeepEncrypted = int(process.env.BACKUP_MIN_KEEP_ENCRYPTED, 10),
  keepFailedAttempts = int(process.env.BACKUP_KEEP_FAILED_ATTEMPTS, 5),
  now = Date.now(),
  dryRun = false,
  env = process.env,
} = {}) {
  const resolvedDir = path.resolve(backupDir);
  const dirStat = await lstatOrNull(resolvedDir);
  if (!dirStat?.isDirectory()) {
    return {
      ok: true,
      dryRun,
      absent: true,
      plainSqlDeleted: [],
      encryptedRetired: [],
      retiringPurged: [],
      failedAttemptsDeleted: [],
    };
  }

  if (await hasActiveRestoreOrDrillFence(env)) {
    return {
      ok: true,
      dryRun,
      skippedReason: "RESTORE_OR_DRILL_ACTIVE",
      plainSqlDeleted: [],
      encryptedRetired: [],
      retiringPurged: [],
      failedAttemptsDeleted: [],
    };
  }

  const releaseLock = dryRun ? async () => {} : await acquireRetentionLock(resolvedDir, { now });
  if (!releaseLock) {
    return {
      ok: true,
      dryRun,
      skippedReason: "RETENTION_LOCK_BUSY",
      plainSqlDeleted: [],
      encryptedRetired: [],
      retiringPurged: [],
      failedAttemptsDeleted: [],
    };
  }

  try {
    const resolvedOffsite = offsiteDir ? path.resolve(offsiteDir) : null;
    const distinctOffsite =
      resolvedOffsite && resolvedOffsite !== resolvedDir ? resolvedOffsite : null;
    const reportDir = join(resolvedDir, "restore-reports");
    const syncAckDir = join(resolvedDir, ".sync-ack");
    const hasSyncAckDir = (await lstatOrNull(syncAckDir))?.isDirectory() === true;

    const retiringPurged = await sweepExpiredRetiring({
      backupDir: resolvedDir,
      offsiteDir: distinctOffsite,
      reportDir,
      now,
      dryRun,
    });
    await sweepDownloadCache({
      root: process.cwd(),
      backupDir: resolvedDir,
      now,
      apply: !dryRun,
    }).catch(() => {});

    const entries = await fs.readdir(resolvedDir);
    const entrySet = new Set(entries);
    const retiringSet = new Set(
      await fs.readdir(join(resolvedDir, ".retiring")).catch(() => []),
    );

    // Group candidate base `.sql` names by exact parsed dbName
    const byDb = new Map();
    for (const entry of entries) {
      const base = entry.replace(/(?:\.attempt\.json|\.gpg(?:\.manifest\.json)?)$/, "");
      const parsed = parseBackupSqlName(base);
      if (!parsed) continue;
      if (dbFilter && parsed.dbName !== dbFilter) continue;
      if (retiringSet.has(`${base}.retired.json`)) continue;
      let group = byDb.get(parsed.dbName);
      if (!group) {
        group = new Map();
        byDb.set(parsed.dbName, group);
      }
      if (!group.has(base)) group.set(base, parsed);
    }

    const plainSqlDeleted = [];
    const encryptedRetired = [];
    const failedAttemptsDeleted = [];

    for (const [, candidatesMap] of byDb) {
      const items = Array.from(candidatesMap.entries())
        .map(([name, meta]) => ({ name, date: meta.date }))
        .sort((a, b) => b.date.getTime() - a.date.getTime() || b.name.localeCompare(a.name));

      // Evaluate verified encrypted status & plain SQL presence
      const enriched = await Promise.all(
        items.map(async (item) => {
          const sqlStat = entrySet.has(item.name)
            ? await lstatOrNull(join(resolvedDir, item.name))
            : null;
          const hasSql = !!sqlStat?.isFile() && sqlStat.size >= 512;
          const localManifest = await inspectVerifiedManifest(resolvedDir, item.name);
          const offsiteManifest =
            !localManifest && distinctOffsite
              ? await inspectVerifiedManifest(distinctOffsite, item.name)
              : null;
          const hasAnyGpg =
            entrySet.has(`${item.name}.gpg`) || entrySet.has(`${item.name}.gpg.manifest.json`);
          const attempt = entrySet.has(`${item.name}.attempt.json`)
            ? await readSmallJson(join(resolvedDir, `${item.name}.attempt.json`))
            : null;
          return {
            ...item,
            hasSql,
            verifiedManifest: localManifest ?? offsiteManifest,
            hasLocalVerified: !!localManifest,
            hasAnyGpg,
            attempt,
          };
        }),
      );

      // ── Tier 1: Hot Plain `.sql` Eviction (2 newest + 1 previous-day, gated on verified GPG) ──
      const plainItems = enriched.filter((item) => item.hasSql);
      const keepSql = new Set();
      if (keepPlainSql > 0 && plainItems.length > 0) {
        const newestDay = utcDayKey(plainItems[0].date);
        const immediateCount = Math.max(1, keepPlainSql - 1);
        for (const item of plainItems.slice(0, immediateCount)) {
          keepSql.add(item.name);
        }
        const prevDayItem = plainItems.find(
          (item) => !keepSql.has(item.name) && utcDayKey(item.date) !== newestDay,
        );
        if (prevDayItem && keepSql.size < keepPlainSql) {
          keepSql.add(prevDayItem.name);
        }
        for (const item of plainItems) {
          if (keepSql.size >= keepPlainSql) break;
          keepSql.add(item.name);
        }
      }

      for (const item of plainItems) {
        if (keepSql.has(item.name)) continue;
        // CRITICAL SAFETY GATE: Never delete plain `.sql` unless a verified `.gpg` + `.manifest.json` exists!
        if (!item.verifiedManifest) continue;
        plainSqlDeleted.push(item.name);
        if (!dryRun) {
          await fs.unlink(join(resolvedDir, item.name)).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        }
      }

      // ── Tier 2: Encrypted `.sql.gpg` GFS Retention (with 60m `.retiring/` cushion) ──
      const verifiedItems = enriched.filter((item) => item.hasLocalVerified);
      const keepEnc = new Set();
      for (const item of verifiedItems.slice(0, minKeepEncrypted)) {
        keepEnc.add(item.name);
      }

      const allHoursCutoff = now - keepAllHours * 3600 * 1000;
      const syncAckSafetyCutoff = now - 14 * 24 * 3600 * 1000;
      const seenDays = new Map();
      const seenWeeks = new Map();
      const seenMonths = new Map();

      for (const item of verifiedItems) {
        if (item.date.getTime() >= allHoursCutoff) {
          keepEnc.add(item.name);
        }
        if (hasSyncAckDir && item.date.getTime() >= syncAckSafetyCutoff) {
          const ackStat = await lstatOrNull(join(syncAckDir, `${item.name}.gpg.ack.json`));
          if (!ackStat?.isFile()) keepEnc.add(item.name);
        }
        const dk = utcDayKey(item.date);
        if (!seenDays.has(dk)) seenDays.set(dk, item.name);
        const wk = utcWeekKey(item.date);
        if (!seenWeeks.has(wk)) seenWeeks.set(wk, item.name);
        const mk = utcMonthKey(item.date);
        if (!seenMonths.has(mk)) seenMonths.set(mk, item.name);
      }

      for (const n of Array.from(seenDays.values()).slice(0, keepDaily)) keepEnc.add(n);
      for (const n of Array.from(seenWeeks.values()).slice(0, keepWeekly)) keepEnc.add(n);
      for (const n of Array.from(seenMonths.values()).slice(0, keepMonthly)) keepEnc.add(n);

      for (const item of verifiedItems) {
        if (keepEnc.has(item.name)) continue;
        // Do not retire an archive whose plain `.sql` is still retained in hot tier
        if (keepSql.has(item.name)) continue;
        encryptedRetired.push(item.name);
        await retireEncryptedArchive({
          backupDir: resolvedDir,
          sqlName: item.name,
          now,
          ttlMs: GFS_RETIRING_TTL_MS,
          reason: "GFS_ROTATE",
          dryRun,
        });
      }

      // ── Tier 3: Orphan FAILED / Stale STARTED `.attempt.json` Cleanup ──
      const orphanAttempts = [];
      for (const item of enriched) {
        if (item.hasSql || item.hasAnyGpg || item.verifiedManifest || !item.attempt) continue;
        const status = item.attempt.status;
        const startedMs = Date.parse(item.attempt.startedAt ?? "");
        if (status === "FAILED") {
          orphanAttempts.push({ ...item, startedMs });
        } else if (status === "STARTED" && Number.isFinite(startedMs) && now - startedMs > STALE_STARTED_MS) {
          const partialStat = await lstatOrNull(join(resolvedDir, `${item.name}.partial`));
          if (!partialStat || now - partialStat.mtimeMs > 3600 * 1000) {
            orphanAttempts.push({ ...item, startedMs });
          }
        }
      }

      orphanAttempts.forEach((item, idx) => {
        const ageExceeded = Number.isFinite(item.startedMs) && now - item.startedMs > FAILED_MAX_AGE_MS;
        if (idx < keepFailedAttempts && !ageExceeded) return;
        failedAttemptsDeleted.push(item.name);
      });

      if (!dryRun) {
        for (const sqlName of failedAttemptsDeleted) {
          await fs.unlink(join(resolvedDir, `${sqlName}.attempt.json`)).catch(() => {});
        }
      }
    }

    return {
      ok: true,
      dryRun,
      plainSqlDeleted,
      encryptedRetired,
      retiringPurged,
      failedAttemptsDeleted,
    };
  } finally {
    await releaseLock();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !["--dry-run", "--apply"].includes(a));
  if (unknown.length > 0) {
    console.error(`USAGE: node scripts/backup-rotate.mjs [--dry-run|--apply|--selftest]`);
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  rotateBackups({ dryRun })
    .then((summary) => {
      console.log(JSON.stringify(summary));
    })
    .catch((error) => {
      console.error("✗ فشل تدوير النسخ الاحتياطية:", error?.message ?? error);
      process.exit(1);
    });
}
