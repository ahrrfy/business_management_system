import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "AlruyaERP",
  "logs",
);
const LOG_PATH = path.join(LOG_DIR, "bridge.log");
const MAX_SIZE = 1024 * 1024; // 1 MB
const KEEP = 5;

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < MAX_SIZE) return;
  } catch {
    return; // file doesn't exist
  }
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${LOG_PATH}.${i}`;
    const to = `${LOG_PATH}.${i + 1}`;
    if (fs.existsSync(from)) {
      try { fs.renameSync(from, to); } catch { /* ignore */ }
    }
  }
  try { fs.renameSync(LOG_PATH, `${LOG_PATH}.1`); } catch { /* ignore */ }
}

function ensureDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch { /* best-effort */ }
}

export function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  ensureDir();
  rotateIfNeeded();
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra ?? {}) }) + "\n";
  try {
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch { /* best-effort */ }
  if (process.env.BRIDGE_STDOUT === "1") {
    process.stderr.write(line);
  }
}

export function getLogPath(): string { return LOG_PATH; }
