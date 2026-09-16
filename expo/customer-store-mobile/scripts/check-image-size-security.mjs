import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const minimumMetroVersion = "0.83.8";

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function fail(message) {
  console.error(`[image-size security] ${message}`);
  process.exitCode = 1;
}

const metroPackage = JSON.parse(
  readFileSync(require.resolve("metro/package.json"), "utf8"),
);

if (compareVersions(metroPackage.version, minimumMetroVersion) < 0) {
  fail(
    `Metro ${metroPackage.version} is older than the dependency-removal floor ${minimumMetroVersion}.`,
  );
}

if (metroPackage.dependencies?.["image-size"]) {
  fail(
    `Metro ${metroPackage.version} directly depends on image-size ${metroPackage.dependencies["image-size"]}.`,
  );
}

try {
  const imageSizePackage = require.resolve("image-size/package.json");
  fail(`image-size is still installed at ${imageSizePackage}.`);
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") {
    throw error;
  }
}

const lockfilePath = fileURLToPath(
  new URL("../pnpm-lock.yaml", import.meta.url),
);
const lockfile = readFileSync(lockfilePath, "utf8");
if (
  /^\s{2}image-size@/m.test(lockfile) ||
  /^\s{6}image-size:/m.test(lockfile)
) {
  fail("pnpm-lock.yaml contains an image-size package or dependency edge.");
}

if (!process.exitCode) {
  console.log(
    `[image-size security] Metro ${metroPackage.version} is installed without image-size.`,
  );
}
