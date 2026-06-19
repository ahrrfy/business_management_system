// Builds alroya-bridge.exe — a single Windows executable that bundles Node 22 + the bridge code.
// Pipeline:
//   1. esbuild  →  dist/bundle.cjs       (single-file CommonJS bundle)
//   2. node --experimental-sea-config  →  dist/sea-prep.blob
//   3. cp node.exe  →  dist/alroya-bridge.exe
//   4. postject inject blob into the exe
//
// Requires: Node 22+, esbuild (devDep), postject (devDep).
// Usage:    `pnpm --filter alroya-bridge install` then `node installer-source/bridge/build-sea.mjs`
//
// Outputs:  installer-source/bridge/dist/alroya-bridge.exe (~50 MB)

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = join(ROOT, "dist");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const BRIDGE_VERSION = PKG.version;

function step(n, label) {
  process.stdout.write(`\n[${n}/4] ${label}\n`);
}

function sha256(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

async function bundleEsbuild() {
  step(1, "esbuild — bundling TypeScript → dist/bundle.cjs");
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });
  await esbuild.build({
    entryPoints: [join(ROOT, "src", "server.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(DIST, "bundle.cjs"),
    minify: true,
    sourcemap: false,
    treeShaking: true,
    legalComments: "none",
    define: { "process.env.ALROYA_BRIDGE_VERSION": JSON.stringify(BRIDGE_VERSION) },
    // Node 22 has these as built-ins; mark anything truly external if needed
    external: [],
    banner: { js: "/* alroya-bridge " + BRIDGE_VERSION + " */" },
  });
  const sz = statSync(join(DIST, "bundle.cjs")).size;
  console.log(`  bundle.cjs ready (${(sz / 1024).toFixed(1)} KB)`);
}

function generateBlob() {
  step(2, "node --experimental-sea-config → dist/sea-prep.blob");
  execFileSync(
    process.execPath,
    ["--experimental-sea-config", join(ROOT, "sea-config.json")],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (!existsSync(join(DIST, "sea-prep.blob"))) {
    throw new Error("sea-prep.blob did not appear after running SEA generator");
  }
}

function copyNodeBinary() {
  step(3, "copy current node.exe → dist/alroya-bridge.exe");
  const target = join(DIST, "alroya-bridge.exe");
  if (existsSync(target)) rmSync(target);
  copyFileSync(process.execPath, target);
  return target;
}

function injectBlob(target) {
  step(4, "postject inject SEA blob");
  // Resolve postject CLI without depending on PATH (pnpm/npm install hoisting).
  let cli;
  try {
    cli = fileURLToPath(import.meta.resolve("postject/dist/cli.js"));
  } catch {
    throw new Error(
      "postject not installed. Run `pnpm --filter alroya-bridge install` first " +
      "(or `npm i` inside installer-source/bridge).",
    );
  }
  execFileSync(
    process.execPath,
    [
      cli,
      target,
      "NODE_SEA_BLOB",
      join(DIST, "sea-prep.blob"),
      "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { stdio: "inherit" },
  );
}

function writeVersionMeta(target) {
  const meta = {
    version: BRIDGE_VERSION,
    sha256: sha256(target),
    size: statSync(target).size,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(DIST, "version.json"), JSON.stringify(meta, null, 2));
  console.log("\nbuilt:", meta);
}

async function main() {
  await bundleEsbuild();
  generateBlob();
  const target = copyNodeBinary();
  injectBlob(target);
  writeVersionMeta(target);
  console.log("\n✓ alroya-bridge.exe ready at", resolve(target));
}

main().catch((e) => {
  console.error("\n✗ build failed:", e?.message ?? e);
  process.exit(1);
});
