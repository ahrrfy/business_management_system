import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const minimum = [4, 6, 6];
const legacy = "3.25.76";
const reviewedSource = "client/src/lib/imageStudio/segment.ts";
const reviewedHash =
  "6e8dd6f8b489887bc6f0bd3a8717549886b90e4b3ff150e24d7797dd640cdc31";
const locks = [
  "pnpm-lock.yaml",
  "expo/customer-store-mobile/pnpm-lock.yaml",
  "expo/superapp-mobile/pnpm-lock.yaml",
];
const fail = (message) => {
  throw new Error(`Zod security boundary: ${message}`);
};
function fixed(version) {
  const match = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}
function validateLock(text, root) {
  if (/:[ \t]*["']?(?:npm:)?zod@(?:\^|~)?3\./m.test(text))
    fail("legacy aliases require a new reachability review");
  const versions = [...text.matchAll(/^  zod@([^:\r\n]+):/gm)].map(
    (match) => match[1],
  );
  for (const version of versions) {
    if (!fixed(version) && !(root && version === legacy))
      fail(`unreviewed vulnerable version ${version}`);
  }
  const uses = text
    .split(/\n(?=  \S)/)
    .filter((block) => /\n      zod: 3\.25\.76(?:\n|$)/.test(block));
  if (
    root &&
    (uses.length !== 1 ||
      !/^  '@imgly\/background-removal@1\.7\.0\(onnxruntime-web@1\.21\.0\)':/.test(
        uses[0],
      ))
  )
    fail("legacy Zod must belong only to the reviewed IMG.LY snapshot");
  if (!root && uses.length)
    fail("legacy Zod outside the browser image library");
}
function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      ["node_modules", ".git", ".expo", "android", "ios"].includes(entry.name)
    )
      return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? files(file)
      : /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [file.replaceAll("\\", "/")]
        : [];
  });
}
function check() {
  for (const file of locks)
    validateLock(
      fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n"),
      file === locks[0],
    );
  for (const directory of [".", "expo/customer-store-mobile"]) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    if (!fixed(manifest.dependencies.zod))
      fail(`direct dependency is not patched: ${directory}`);
    const lock = fs
      .readFileSync(path.join(directory, "pnpm-lock.yaml"), "utf8")
      .replaceAll("\r\n", "\n");
    const direct = lock.match(
      /\n      zod:\n        specifier: ([^\n]+)\n        version: ([^\n]+)/,
    );
    if (!direct || direct[1] !== manifest.dependencies.zod || !fixed(direct[2]))
      fail(`direct lock does not match patched manifest: ${directory}`);
  }
  const source = fs
    .readFileSync(reviewedSource, "utf8")
    .replaceAll("\r\n", "\n");
  if (createHash("sha256").update(source).digest("hex") !== reviewedHash)
    fail(
      "image configuration changed; review reachability before retaining the exception",
    );
  const uses = [];
  for (const file of [
    "client/src",
    "server",
    "shared",
    "expo/customer-store-mobile",
    "expo/superapp-mobile",
  ].flatMap(files)) {
    const sourceText = fs.readFileSync(file, "utf8");
    if (
      /(?:from\s*|(?:import|require)\s*\(\s*)["']zod\/v3(?:\/[^"']*)?["']/.test(
        sourceText,
      )
    )
      fail(`unreviewed legacy API: ${file}`);
    if (
      /(?:from\s*|(?:import|require)\s*\(\s*)["']@imgly\/background-removal(?:\/[^"']*)?["']/.test(
        sourceText,
      )
    )
      uses.push(file);
  }
  if (uses.length !== 1 || uses[0] !== reviewedSource)
    fail("IMG.LY gained another configuration input");
  const config = fs.readFileSync("osv-scanner.toml", "utf8");
  const exception = config
    .split("[[IgnoredVulns]]")
    .filter((block) => /id\s*=\s*"GHSA-mrhx-c7xc-m3w5"/.test(block));
  if (
    exception.length !== 1 ||
    !/ignoreUntil\s*=\s*2026-11-06/.test(exception[0])
  )
    fail("missing bounded advisory exception");
  if (Date.now() >= Date.parse("2026-11-07T00:00:00Z"))
    fail("reachability review expired");
  console.log(
    "Zod security boundary: patched direct dependencies; only fixed-config IMG.LY legacy use, exception expires 2026-11-06.",
  );
}
function selftest() {
  const root =
    "  zod@4.6.6:\n  zod@3.25.76:\n  '@imgly/background-removal@1.7.0(onnxruntime-web@1.21.0)':\n    dependencies:\n      zod: 3.25.76\n";
  assert.doesNotThrow(() => validateLock(root, true));
  assert.doesNotThrow(() => validateLock("  zod@4.6.6:\n", false));
  assert.throws(() => validateLock(root.replace("4.6.6", "4.4.3"), true));
  assert.throws(() => validateLock(root.replaceAll("3.25.76", "3.24.2"), true));
  assert.throws(() =>
    validateLock(root.replace("@imgly/background-removal", "other"), true),
  );
  assert.throws(() => validateLock(root, false));
  assert.throws(() =>
    validateLock(
      root + "  other@1.0.0:\n    dependencies:\n      zod: 3.25.76\n",
      true,
    ),
  );
  assert.throws(() =>
    validateLock(
      root + "  other@1.0.0:\n    dependencies:\n      zod3: zod@3.25.76\n",
      true,
    ),
  );
  assert.throws(() =>
    validateLock(
      root +
        "      zod3:\n        specifier: npm:zod@^3.25.76\n        version: zod@3.25.76\n",
      true,
    ),
  );
  assert.equal(fixed("^4.6.6"), true);
  assert.equal(fixed("4.7.0"), true);
  assert.equal(fixed("4.6.5"), false);
  assert.equal(fixed("^3.25.76"), false);
  console.log("Zod security boundary self-test passed.");
}
if (process.argv.includes("--selftest")) selftest();
else check();
