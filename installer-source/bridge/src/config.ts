import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeConfig } from "./types.js";

function appDataDir(): string {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AlruyaERP");
}

export function getConfigPath(): string {
  return path.join(appDataDir(), "config.json");
}

export function loadConfig(): BridgeConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error(`لم يُعثر على ملف الإعدادات: ${p}\nشغّل المُثبِّت أو حرّر الملف يدوياً.`);
  }
  const raw = fs.readFileSync(p, "utf8");
  let parsed: BridgeConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`ملف الإعدادات تالف: ${(e as Error).message}`);
  }
  if (!parsed.cloudUrl) throw new Error("config.json: cloudUrl مفقود");
  if (!parsed.hmacSecret || parsed.hmacSecret.length < 16) {
    throw new Error("config.json: hmacSecret مفقود أو قصير (≥ 16 محرف)");
  }
  if (!parsed.port) parsed.port = 9101;
  return parsed;
}
