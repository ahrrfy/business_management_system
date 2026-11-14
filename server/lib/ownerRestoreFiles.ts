import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { ownerRestoreTargetSchema } from "../../shared/ownerRestore";

export function ownerRestorePaths(directory = process.env.ERP_OWNER_RESTORE_DIRECTORY?.trim()) {
  if (!directory || !path.isAbsolute(directory) || /^[\\/]{2}/.test(directory)) return null;
  const root = path.resolve(directory);
  const hash = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 20);
  return {
    root,
    socket: process.platform === "win32" ? `\\\\.\\pipe\\erp-owner-restore-${hash}` : path.join(root, "controller.sock"),
    state: path.join(root, "current.json"),
    fence: path.join(root, "maintenance"),
  };
}

export function ownerRestoreTarget(url: string | undefined) {
  try {
    const parsed = new URL(url ?? "");
    if (parsed.protocol !== "mysql:" || parsed.search || parsed.hash) return null;
    const target = ownerRestoreTargetSchema.safeParse({
      host: parsed.hostname, port: Number(parsed.port || 3306),
      database: decodeURIComponent(parsed.pathname.slice(1)), user: decodeURIComponent(parsed.username),
    });
    return target.success ? target.data : null;
  } catch {
    return null;
  }
}

export function hasOwnerRestoreFence(file: string) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
