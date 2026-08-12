import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const maintenanceLockPath = join(
  tmpdir(),
  `erp-restore-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12)}.lock`,
);

export function acquireMaintenanceLock() {
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
  const heartbeat = setInterval(() => {
    try { const now = new Date(); utimesSync(maintenanceLockPath, now, now); } catch {}
  }, 60_000);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    try {
      if (readFileSync(maintenanceLockPath, "utf8").split("\n", 1)[0] === owner) unlinkSync(maintenanceLockPath);
    } catch {}
  };
}
