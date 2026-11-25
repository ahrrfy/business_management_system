import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const RETENTION_LOCK_STALE_MS = 30 * 60 * 1000;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function drainRetentionLockSync(directory) {
  try {
    if (!lstatSync(directory).isDirectory()) return;
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const lockPath = join(directory, ".retention.lock");
  const owner = `${process.pid}:${randomUUID()}`;
  for (let i = 0; i < 40; i++) {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${owner}\n${new Date().toISOString()}\n`);
      closeSync(fd);
      try {
        if (readFileSync(lockPath, "utf8").split("\n", 1)[0] === owner) unlinkSync(lockPath);
      } catch {}
      return;
    } catch (error) {
      if (fd != null) try { closeSync(fd); } catch {}
      if (error?.code !== "EEXIST") throw error;
      let st = null;
      try { st = lstatSync(lockPath); } catch {}
      if (st && Date.now() - st.mtimeMs > RETENTION_LOCK_STALE_MS) {
        throw new Error(`قفل تدوير النسخ الاحتياطية قديم ويتطلب مراجعة المشغّل: ${lockPath}`);
      }
      if (i < 39) sleepSync(100);
    }
  }
  throw new Error(`توجد عملية تدوير نسخ احتياطية جارية حالياً؛ انتظر انتهاءها قبل الاستعادة: ${lockPath}`);
}

export const maintenanceLockPath = join(
  tmpdir(),
  `erp-restore-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12)}.lock`,
);

export function acquireMaintenanceLock(targetFile) {
  if (process.env.MAINTENANCE_LOCK_HELD_BY_PARENT === "1") return () => {};
  const owner = `${process.pid}:${randomUUID()}`;
  let fd;
  try {
    fd = openSync(maintenanceLockPath, "wx", 0o600);
    writeFileSync(fd, `${owner}\n${new Date().toISOString()}\n`);
    closeSync(fd);
  } catch (error) {
    if (fd != null) try { closeSync(fd); } catch {}
    if (error?.code === "EEXIST") {
      throw new Error(`عملية restore/reset أخرى مقفلة. افحص القفل تشغيلياً: ${maintenanceLockPath}`);
    }
    throw error;
  }
  const releaseMain = () => {
    try {
      if (readFileSync(maintenanceLockPath, "utf8").split("\n", 1)[0] === owner) unlinkSync(maintenanceLockPath);
    } catch {}
  };
  try {
    const dirs = new Set([resolve(process.cwd(), process.env.BACKUP_DIR ?? "backups")]);
    if (typeof targetFile === "string" && targetFile.trim()) {
      dirs.add(dirname(resolve(targetFile)));
    }
    for (const dir of dirs) drainRetentionLockSync(dir);
    if (typeof targetFile === "string" && targetFile.trim()) {
      if (!existsSync(targetFile) || statSync(targetFile).size < 512) {
        throw new Error(`ملف الاستعادة المحدد لم يعد متاحاً بعد حاجز التدوير: ${targetFile}`);
      }
    }
  } catch (error) {
    releaseMain();
    throw error;
  }
  const heartbeat = setInterval(() => {
    try { const now = new Date(); utimesSync(maintenanceLockPath, now, now); } catch {}
  }, 60_000);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    releaseMain();
  };
}
