/**
 * installerRouter — exposes the latest bridge/installer version so the local
 * print bridge on each cashier machine can poll for self-updates.
 *
 * Source of truth: installer-source/version.json at the repo root (read on each
 * request — file is tiny and not hot-pathed; daily polling per device).
 *
 * Two access modes:
 *  - tRPC procedure `installer.latestVersion` (this file) for in-app use.
 *  - REST GET /api/installer/latest-version (wired in server/index.ts) for the
 *    standalone bridge process, which does not embed tRPC client.
 *
 * Both are publicProcedure — no auth — because the bridge has no user session
 * and the data exposed (version + URL to a public asset) is not sensitive.
 */

import fs from "node:fs";
import path from "node:path";
import { publicProcedure, router } from "../trpc";

export interface InstallerVersionMeta {
  bridge: string;
  installer: string;
  url: string;
  sha256: string;
  publishedAt?: string;
  notes?: string;
}

const VERSION_PATH = path.join(process.cwd(), "installer-source", "version.json");

/** Read installer-source/version.json. Returns null on missing/malformed file. */
export function readInstallerVersion(): InstallerVersionMeta | null {
  try {
    if (!fs.existsSync(VERSION_PATH)) return null;
    const raw = fs.readFileSync(VERSION_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<InstallerVersionMeta>;
    if (typeof parsed.bridge !== "string" || typeof parsed.installer !== "string") return null;
    return {
      bridge: parsed.bridge,
      installer: parsed.installer,
      url: typeof parsed.url === "string" ? parsed.url : "",
      sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : "",
      publishedAt: typeof parsed.publishedAt === "string" ? parsed.publishedAt : undefined,
      notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
    };
  } catch {
    return null;
  }
}

const FALLBACK: InstallerVersionMeta = { bridge: "0.0.0", installer: "0.0.0", url: "", sha256: "" };

export const installerRouter = router({
  latestVersion: publicProcedure.query(() => {
    return readInstallerVersion() ?? FALLBACK;
  }),
});
