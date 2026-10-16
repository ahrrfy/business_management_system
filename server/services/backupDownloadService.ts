import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const TTL = 24 * 60 * 60 * 1000;
const SLOTS = 16;
const MAX_BYTES = 1024 * 1024 * 1024;
type Owner = { userId: number; companyId: number | null; name: string };
type Snapshot = Owner & {
  id: string;
  expiresAt: number;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
};
export class BackupDownloadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const regular = async (file: string) => {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Unsafe backup download file");
  return info;
};
async function readSnapshot(slot: string): Promise<Snapshot | null> {
  try {
    const info = await lstat(slot);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const meta = path.join(slot, "snapshot.json");
    if ((await regular(meta)).size > 4096) return null;
    const value: Snapshot = JSON.parse(await readFile(meta, "utf8"));
    if (
      !/^[a-f0-9-]{36}$/.test(value.id) ||
      !Number.isSafeInteger(value.size) ||
      value.size <= 0 ||
      value.size > MAX_BYTES ||
      !Number.isFinite(value.expiresAt)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
function sameOwner(snapshot: Owner, owner: Owner) {
  return (
    snapshot.userId === owner.userId &&
    snapshot.companyId === owner.companyId &&
    snapshot.name === owner.name
  );
}
async function materialize(slot: string, snapshot: Snapshot) {
  const file = path.join(slot, `${snapshot.id}.sql`);
  const info = await regular(file);
  if (
    info.size !== snapshot.size ||
    info.mtimeMs !== snapshot.mtimeMs ||
    info.ino !== snapshot.ino ||
    info.dev !== snapshot.dev
  )
    throw new Error("Backup snapshot changed");
  return { id: snapshot.id, path: file, size: snapshot.size };
}
async function expireSlot(slot: string, now: number) {
  let locked = false;
  let expiredGeneration = false;
  try {
    const info = await lstat(slot);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const snapshot = await readSnapshot(slot);
    if ((snapshot?.expiresAt ?? info.mtimeMs + TTL) > now) return;
    // An exclusive directory also makes expiration safe between PM2 workers.
    await mkdir(path.join(slot, ".cleanup"));
    locked = true;
    // Re-read after locking: the slot may now hold a newer live generation.
    const current = await readSnapshot(slot);
    const lockedInfo = await lstat(slot);
    if (
      current
        ? current.expiresAt > now
        : lockedInfo.ino !== info.ino ||
          lockedInfo.dev !== info.dev ||
          lockedInfo.birthtimeMs !== info.birthtimeMs ||
          info.mtimeMs + TTL > now
    )
      return;
    const entries = await readdir(slot);
    const sqlNames = current
      ? [`${current.id}.sql`]
      : entries.filter((name) => /^[a-f0-9-]{36}\.sql$/.test(name));
    if (sqlNames.length > 1) return;
    if (
      entries.some(
        (name) => !["snapshot.json", ...sqlNames, ".cleanup"].includes(name),
      )
    )
      return;
    expiredGeneration = true;
    for (const name of ["snapshot.json", ...sqlNames]) {
      const file = path.join(slot, name);
      try {
        await regular(file);
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch {
    /* Unknown files and another worker's reservation stay protected. */
  } finally {
    if (locked) {
      await rmdir(path.join(slot, ".cleanup")).catch(() => {});
      if (expiredGeneration) await rmdir(slot).catch(() => {});
    }
  }
}

/** Private hard links pin immutable SQL through rotation/reloads without another SQL copy.
 * Sixteen atomic slot reservations and a 1 GiB per-file limit bound retained data;
 * unexpired snapshots are never evicted to admit a new download. */
export async function getBackupDownload(
  input: Owner & {
    directory: string;
    sourcePath?: string;
    downloadId?: string;
  },
  now = Date.now(),
) {
  const cache = path.join(path.resolve(input.directory), ".download-cache");
  await mkdir(cache, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const cacheInfo = await lstat(cache);
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink())
    throw new Error("Unsafe backup download cache");
  const slots = Array.from({ length: SLOTS }, (_, i) =>
    path.join(cache, String(i).padStart(2, "0")),
  );
  if (input.downloadId && !/^[a-f0-9-]{36}$/.test(input.downloadId))
    throw new BackupDownloadError(
      410,
      "انتهت صلاحية رابط التنزيل؛ اختر النسخة مجدداً.",
    );
  const snapshots = await Promise.all(slots.map(readSnapshot));
  if (input.downloadId) {
    const index = snapshots.findIndex(
      (value) => value?.id === input.downloadId,
    );
    const snapshot = snapshots[index];
    if (!snapshot || !sameOwner(snapshot, input) || snapshot.expiresAt <= now)
      throw new BackupDownloadError(
        410,
        "انتهت صلاحية رابط التنزيل؛ اختر النسخة مجدداً.",
      );
    return materialize(slots[index], snapshot);
  }
  if (
    !input.sourcePath ||
    path.dirname(path.resolve(input.sourcePath)) !==
      path.resolve(input.directory) ||
    path.basename(input.sourcePath) !== input.name
  )
    throw new BackupDownloadError(400, "اسم نسخة غير صالح أو غير موجود.");
  const source = await regular(input.sourcePath);
  if (source.size <= 0)
    throw new BackupDownloadError(
      500,
      "النسخة على الخادم فارغة؛ أنشئ نسخة جديدة قبل التنزيل.",
    );
  if (source.size > MAX_BYTES)
    throw new BackupDownloadError(
      413,
      "حجم النسخة يتجاوز حد التنزيل الآمن؛ تواصل مع مسؤول النظام.",
    );
  const reused = snapshots.findIndex(
    (value) =>
      value &&
      sameOwner(value, input) &&
      value.expiresAt > now &&
      value.ino === source.ino &&
      value.dev === source.dev &&
      value.size === source.size &&
      value.mtimeMs === source.mtimeMs,
  );
  if (reused >= 0) return materialize(slots[reused], snapshots[reused]!);
  for (const slot of slots) {
    await expireSlot(slot, now);
    try {
      await mkdir(slot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const snapshot: Snapshot = {
      userId: input.userId,
      companyId: input.companyId,
      name: input.name,
      id: randomUUID(),
      expiresAt: now + TTL,
      size: source.size,
      mtimeMs: source.mtimeMs,
      ino: source.ino,
      dev: source.dev,
    };
    try {
      await link(input.sourcePath, path.join(slot, `${snapshot.id}.sql`));
      const result = await materialize(slot, snapshot);
      await writeFile(
        path.join(slot, "snapshot.json"),
        JSON.stringify(snapshot),
        { flag: "wx", mode: 0o600 },
      );
      return result;
    } catch (error) {
      await unlink(path.join(slot, `${snapshot.id}.sql`)).catch(() => {});
      // A failed exclusive metadata write must never remove another reservation.
      await rmdir(slot).catch(() => {});
      throw error;
    }
  }
  throw new BackupDownloadError(
    503,
    "مساحة التنزيل المؤقت مشغولة؛ أعد المحاولة لاحقاً.",
  );
}
