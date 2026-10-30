// A bounded janitor for expired backup download pins, never original backups.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_ROOT = "/home/deploy/erp";
const GRACE_MS = 60 * 60 * 1000;
const UUID = /^[a-f0-9-]{36}$/;

async function directory(file) {
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("UNSAFE_CACHE_DIRECTORY");
  }
  return stat;
}

async function roots(root) {
  if ((await fs.realpath(root)) !== path.resolve(root)) {
    throw new Error("UNSAFE_PROJECT_PATH");
  }
  const backups = path.join(root, "backups");
  await directory(backups);
  const cache = path.join(backups, ".download-cache");
  const stat = await directory(cache);
  if ((await fs.realpath(cache)) !== cache) {
    throw new Error("UNSAFE_CACHE_PATH");
  }
  return { cache, stat };
}

async function generation(slot, now, locked = false) {
  const slotStat = await directory(slot);
  const names = await fs.readdir(slot);
  const metaPath = path.join(slot, "snapshot.json");
  const meta = await fs.lstat(metaPath);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 4096) return null;
  const snapshot = JSON.parse(await fs.readFile(metaPath, "utf8"));
  if (
    !UUID.test(snapshot.id) ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size <= 0 ||
    snapshot.size > 1024 ** 3 ||
    !Number.isFinite(snapshot.expiresAt) ||
    snapshot.expiresAt > now - GRACE_MS
  ) {
    return null;
  }
  const sqlName = snapshot.id + ".sql";
  const allowed = ["snapshot.json", sqlName, ...(locked ? [".cleanup"] : [])];
  if (names.some((name) => !allowed.includes(name))) return null;
  const sqlPath = path.join(slot, sqlName);
  const sql = await fs.lstat(sqlPath);
  if (
    !sql.isFile() ||
    sql.isSymbolicLink() ||
    sql.size !== snapshot.size ||
    sql.ino !== snapshot.ino ||
    sql.dev !== snapshot.dev ||
    sql.mtimeMs !== snapshot.mtimeMs
  ) {
    return null;
  }
  return { slotStat, snapshot, meta, sql, sqlPath, metaPath };
}

function sameFile(left, right) {
  return left.ino === right.ino && left.dev === right.dev;
}

/** Default dry run. Apply uses the same .cleanup mutex as backupDownloadService. */
export async function sweepDownloadCache({
  root = PROJECT_ROOT,
  now = Date.now(),
  apply = false,
} = {}) {
  const result = { apply, candidates: [], removed: [], skipped: 0 };
  let initial;
  try {
    initial = await roots(path.resolve(root));
  } catch (error) {
    if (error.code === "ENOENT") return { ...result, absent: true };
    throw error;
  }
  for (let index = 0; index < 16; index++) {
    const name = String(index).padStart(2, "0");
    const slot = path.join(initial.cache, name);
    let before;
    try {
      before = await generation(slot, now);
    } catch (error) {
      if (error.code !== "ENOENT") result.skipped++;
      continue;
    }
    if (!before) {
      result.skipped++;
      continue;
    }
    const candidate = {
      slot: name,
      bytes: before.sql.size,
      expiresAt: new Date(before.snapshot.expiresAt).toISOString(),
      reclaimableBytes: before.sql.nlink === 1 ? before.sql.blocks * 512 : 0,
    };
    result.candidates.push(candidate);
    if (!apply) continue;
    const lock = path.join(slot, ".cleanup");
    let held = false;
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      held = true;
      const checkedRoots = await roots(path.resolve(root));
      const current = await generation(slot, now, true);
      if (
        !sameFile(initial.stat, checkedRoots.stat) ||
        !current ||
        !sameFile(before.slotStat, current.slotStat) ||
        !sameFile(before.meta, current.meta) ||
        !sameFile(before.sql, current.sql) ||
        current.snapshot.id !== before.snapshot.id ||
        current.snapshot.expiresAt !== before.snapshot.expiresAt
      ) {
        result.skipped++;
        continue;
      }
      // Leave expired metadata and the slot for the application's own allocator.
      // Removing a slot after unlocking can erase a newer empty reservation.
      await fs.unlink(current.sqlPath);
      result.removed.push(candidate);
    } catch (error) {
      if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
      result.skipped++;
    } finally {
      if (held) {
        await fs.rmdir(lock);
      }
    }
  }
  return result;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (
      process.argv
        .slice(2)
        .some((arg) => !["--apply", "--dry-run"].includes(arg))
    ) {
      throw new Error("USAGE: vps-maintenance.mjs [--dry-run|--apply]");
    }
    if (
      process.argv.includes("--apply") &&
      process.argv.includes("--dry-run")
    ) {
      throw new Error("CONFLICTING_MAINTENANCE_MODE");
    }
    console.log(
      JSON.stringify(
        await sweepDownloadCache({
          apply: process.argv.includes("--apply"),
        }),
      ),
    );
  } catch (error) {
    console.error(error.code ?? error.message);
    process.exitCode = 1;
  }
}
