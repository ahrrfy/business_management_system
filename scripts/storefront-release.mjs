import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readWebRelease } from "./build-web.mjs";

const FINGERPRINT = /^[a-f0-9]{64}$/;
function plainDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STOREFRONT_RELEASE_DIRECTORY_INVALID");
}
function statOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function roots(projectRoot) {
  const root = path.resolve(projectRoot);
  plainDirectory(root);
  const runtime = path.join(root, ".runtime");
  const releases = path.join(runtime, "storefront-releases");
  for (const directory of [runtime, releases]) {
    if (!statOrNull(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    plainDirectory(directory);
  }
  if (fs.statSync(root).dev !== fs.statSync(releases).dev) throw new Error("STOREFRONT_RELEASE_CROSS_DEVICE");
  return { root, runtime, releases, current: path.join(runtime, "storefront-current") };
}
function targetFor(layout, fingerprint) {
  if (!FINGERPRINT.test(fingerprint)) throw new Error("STOREFRONT_RELEASE_FINGERPRINT_INVALID");
  return path.join(layout.releases, fingerprint);
}
function currentTarget(layout) {
  const stat = statOrNull(layout.current);
  if (!stat) return null; // First rollout continues serving the retained unified shell.
  if (!stat.isSymbolicLink()) throw new Error("STOREFRONT_CURRENT_LINK_INVALID");
  const target = path.resolve(layout.runtime, fs.readlinkSync(layout.current));
  if (!FINGERPRINT.test(path.basename(target)) || target !== targetFor(layout, path.basename(target))) throw new Error("STOREFRONT_CURRENT_LINK_INVALID");
  const release = readWebRelease(target, "storefront");
  if (release.fingerprint !== path.basename(target)) throw new Error("STOREFRONT_CURRENT_HASH_INVALID");
  return target;
}
function syncTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) syncTree(file);
    else if (entry.isFile()) {
      const fd = fs.openSync(file, process.platform === "win32" ? "r+" : "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else throw new Error("STOREFRONT_RELEASE_SPECIAL_FILE");
  }
  syncDirectory(directory);
}

/** Prepare complete immutable content before database/worker activation; never alter a live root. */
export function prepareStorefrontRelease(projectRoot, source) {
  const layout = roots(projectRoot);
  const sourceRoot = path.resolve(source);
  if (!sourceRoot.startsWith(`${layout.root}${path.sep}`)) throw new Error("STOREFRONT_RELEASE_SOURCE_OUTSIDE_PROJECT");
  plainDirectory(sourceRoot);
  const manifest = readWebRelease(sourceRoot, "storefront");
  const target = targetFor(layout, manifest.fingerprint);
  if (statOrNull(target)) {
    if (readWebRelease(target, "storefront").fingerprint !== manifest.fingerprint) throw new Error("STOREFRONT_RELEASE_HASH_INVALID");
    return Object.freeze({ fingerprint: manifest.fingerprint, target });
  }
  const temporary = path.join(layout.releases, `.stage-${randomUUID()}`);
  try {
    fs.cpSync(sourceRoot, temporary, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    if (readWebRelease(temporary, "storefront").fingerprint !== manifest.fingerprint) throw new Error("STOREFRONT_RELEASE_COPY_INVALID");
    syncTree(temporary);
    fs.renameSync(temporary, target);
    syncDirectory(layout.releases);
  } finally {
    if (statOrNull(temporary)) fs.rmSync(temporary, { recursive: true });
  }
  return Object.freeze({ fingerprint: manifest.fingerprint, target });
}

/** Called only after the server inventory fence is RELEASED and internal health passes.
 * Frontend activation is independent: interruption preserves a complete old or new root.
 * Rollback uses the same function with a retained fingerprint; it never restores a database.
 */
export function activateStorefrontRelease(projectRoot, fingerprint) {
  const layout = roots(projectRoot);
  const target = targetFor(layout, fingerprint);
  if (readWebRelease(target, "storefront").fingerprint !== fingerprint) throw new Error("STOREFRONT_RELEASE_HASH_INVALID");
  const previous = currentTarget(layout);
  if (previous === target) return { changed: false, fingerprint, previousFingerprint: fingerprint };
  const temporary = path.join(layout.runtime, `.storefront-current-stage-${randomUUID()}`);
  try {
    fs.symlinkSync(process.platform === "win32" ? target : path.relative(layout.runtime, target), temporary,
      process.platform === "win32" ? "junction" : "dir");
    // Linux deployment uses atomic rename. Windows is solely a local test fixture.
    if (process.platform === "win32" && statOrNull(layout.current)) fs.unlinkSync(layout.current);
    fs.renameSync(temporary, layout.current);
    syncDirectory(layout.runtime);
  } finally {
    if (statOrNull(temporary)) fs.unlinkSync(temporary);
  }
  return { changed: true, fingerprint, previousFingerprint: previous ? path.basename(previous) : null };
}

/** Retain the current root plus at least the previous two complete versions. */
export function pruneStorefrontReleases(projectRoot, { keep = 3 } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 3) throw new Error("STOREFRONT_RETENTION_TOO_SMALL");
  const layout = roots(projectRoot);
  const current = currentTarget(layout);
  if (!current) return { removed: 0 };
  const candidates = fs.readdirSync(layout.releases).filter(name => FINGERPRINT.test(name)).map(name => {
    const target = targetFor(layout, name);
    plainDirectory(target);
    if (readWebRelease(target, "storefront").fingerprint !== name) throw new Error("STOREFRONT_RETENTION_HASH_INVALID");
    return { target, time: fs.statSync(target).mtimeMs };
  }).sort((a, b) => b.time - a.time);
  const retained = new Set([current, ...candidates.filter(row => row.target !== current).slice(0, keep - 1).map(row => row.target)]);
  let removed = 0;
  for (const row of candidates) if (!retained.has(row.target)) { fs.rmSync(row.target, { recursive: true }); removed++; }
  syncDirectory(layout.releases);
  return { removed };
}
