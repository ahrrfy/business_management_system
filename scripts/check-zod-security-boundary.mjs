import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const minimum = [4, 6, 6];
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
function validateLock(text) {
  if (/:[ \t]*["']?(?:npm:)?zod@(?:\^|~)?3\./m.test(text))
    fail("legacy Zod alias");
  for (const match of text.matchAll(/^  zod@([^:\r\n]+):/gm))
    if (!fixed(match[1])) fail(`vulnerable version ${match[1]}`);
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
    validateLock(fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
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
  for (const file of [
    "client/src",
    "server",
    "shared",
    "expo/customer-store-mobile",
    "expo/superapp-mobile",
  ].flatMap(files)) {
    if (
      /(?:from\s*|(?:import|require)\s*\(\s*)["']zod\/v3(?:\/[^"']*)?["']/.test(
        fs.readFileSync(file, "utf8"),
      )
    )
      fail(`legacy runtime API: ${file}`);
  }
  if (
    fs.readFileSync("osv-scanner.toml", "utf8").includes("GHSA-mrhx-c7xc-m3w5")
  )
    fail("Zod advisory must not be ignored");
  console.log(
    "Zod security boundary: all resolved versions are patched; no legacy exception.",
  );
}
function selftest() {
  assert.doesNotThrow(() => validateLock("  zod@4.6.6:\n"));
  for (const version of ["3.25.76", "3.24.2", "4.4.3", "4.6.5"])
    assert.throws(() => validateLock(`  zod@${version}:\n`));
  assert.throws(() => validateLock("      zod3: zod@3.25.76\n"));
  assert.throws(() => validateLock("      zod3: npm:zod@^3.25.76\n"));
  assert.equal(fixed("^4.6.6"), true);
  assert.equal(fixed("4.7.0"), true);
  assert.equal(fixed("4.6.5"), false);
  assert.equal(fixed("^3.25.76"), false);
  console.log("Zod security boundary self-test passed.");
}
if (process.argv.includes("--selftest")) selftest();
else check();
