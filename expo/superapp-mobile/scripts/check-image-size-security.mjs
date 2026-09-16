import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const minimumMetroVersion = "0.83.8";

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function fail(message) {
  console.error(`[image-size security] ${message}`);
  process.exitCode = 1;
}

const lockfilePath = fileURLToPath(new URL("../pnpm-lock.yaml", import.meta.url));
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const lockfile = readFileSync(lockfilePath, "utf8");
if (/^\s{2}image-size@/m.test(lockfile) || /^\s{6}image-size:/m.test(lockfile)) {
  fail("pnpm-lock.yaml contains image-size or a dependency edge to it.");
}

const metroVersion = lockfile.match(/^\s{2}metro@(\d+\.\d+\.\d+):/m)?.[1];
if (!metroVersion) fail("pnpm-lock.yaml does not contain a resolved Metro package.");

// Resolve through Expo instead of assuming pnpm's virtual-store layout. That
// keeps the security check valid for normal installs and for a short external
// virtual store used when Windows path limits affect local native builds.
const projectRequire = createRequire(join(appRoot, "package.json"));
const expoPackagePath = projectRequire.resolve("expo/package.json");
const expoRequire = createRequire(expoPackagePath);
const metroPath = expoRequire.resolve("metro/package.json");
if (!existsSync(metroPath)) fail(`Metro ${metroVersion} is not installed.`);
const metroPackage = JSON.parse(readFileSync(metroPath, "utf8"));
if (compareVersions(metroPackage.version, minimumMetroVersion) < 0) {
  fail(`Metro ${metroPackage.version} is older than ${minimumMetroVersion}.`);
}
if (metroPackage.dependencies?.["image-size"]) {
  fail(`Metro ${metroPackage.version} directly depends on image-size.`);
}

const require = createRequire(import.meta.url);
try { fail(`image-size is installed at ${require.resolve("image-size/package.json")}.`); } catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}

if (!process.exitCode) {
  console.log(`[image-size security] Metro ${metroPackage.version} is installed without image-size.`);
}
