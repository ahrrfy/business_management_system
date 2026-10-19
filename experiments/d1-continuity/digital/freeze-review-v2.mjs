// Explicit v2 offline review freeze. Never rewrites v1 or captured evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { validateEvidence, validateProviderEvidence } from "./validate.mjs";
const root = "experiments/d1-continuity/digital",
  out = root + "/results/review-v2";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (file) => hash(readFileSync(file));
const json = (file) => JSON.parse(readFileSync(file));
const save = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
const retentionPath =
  "D:/business_management_system-worktrees/continuity-plan-20261017/.superpowers/sdd/returns-q2-review-v1-retention.json";
const retention = json(retentionPath),
  v1Path = root + "/results/freeze-manifest.json",
  v1 = json(v1Path);
assert.equal(
  fileHash(v1Path),
  "6ad9dfc1a8e77764cd886ef71b2baba94158545753cdac4b9cfb8a7f04a7f6d7",
);
assert.equal(fileHash(v1.reportPath), v1.reportSha256);
const changed = root + "/validate.mjs";
for (const entry of retention.entries) {
  assert.equal(
    fileHash(path.join(retention.root, entry.file)),
    entry.sha256,
    "Retained v1 changed: " + entry.file,
  );
  if (entry.file !== changed)
    assert.equal(
      fileHash(entry.file),
      entry.sha256,
      "Original capture/source/provenance changed: " + entry.file,
    );
}
assert.equal(
  v1.sourceHashes[changed],
  "97e9cfb9c8c7ba9bf1cd48e561466c6925a523d937cd8ab54521478598c987a1",
);
const red = readFileSync(out + "/red.log", "utf8"),
  green = readFileSync(out + "/green.log", "utf8");
const checks = json(out + "/checks.json");
assert.equal(checks.regressions.exitCode, 0);
assert.equal(checks.guards.exitCode, 0);
assert.ok(red.includes(v1.sourceHashes[changed]));
assert.match(red, /tests 24/);
assert.match(red, /fail 21/);
assert.match(green, /tests 29/);
assert.match(green, /pass 29/);
assert.match(green, /fail 0/);
assert.ok(
  green.includes(fileHash(changed)),
  "GREEN must exercise frozen validator bytes",
);
const canonical = json(v1.canonical),
  proof = validateProviderEvidence(canonical),
  validation = validateEvidence(canonical);
assert.equal(proof.canonicalUnits, 16);
assert.equal(proof.interruptedEvents.length, 2);
assert.equal(validation.commands, 125);
assert.equal(validation.scenarios, 10);
assert.equal(canonical.networkAttempts.length, 0);
for (const [file, expected] of Object.entries(canonical.sourceHashes))
  assert.equal(fileHash(file), expected);
for (const [file, expected] of Object.entries(canonical.preservedQ1))
  assert.equal(fileHash(file), expected, "Prior Q1 evidence drift: " + file);
const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
assert.equal(
  git([
    "diff",
    "--name-only",
    canonical.base,
    "--",
    "server",
    "client",
    "shared",
    "drizzle",
  ]),
  "",
);
assert.equal(git(["diff", "--cached", "--name-only"]), "");
save(out + "/provider-provenance.json", {
  derivedOffline: true,
  canonical: { path: v1.canonical, sha256: fileHash(v1.canonical) },
  v1FreezeSha256: fileHash(v1Path),
  sources: proof.sources,
  canonicalBoundaryUnits: proof.canonicalUnits,
  durableLedgerEvents: canonical.providerLedger.length,
  retainedInterruptedEvents: proof.interruptedEvents,
});
const sourceHashes = Object.fromEntries(
  readdirSync(root)
    .filter((n) => n !== "results")
    .map((n) => [root + "/" + n, fileHash(root + "/" + n)]),
);
const artifactHashes = Object.fromEntries(
  readdirSync(out).map((n) => [out + "/" + n, fileHash(out + "/" + n)]),
);
const reportPath = ".superpowers/sdd/digital-q2-oracle-review-v2-report.md";
const frozen = {
  status: "FROZEN_AWAITING_INDEPENDENT_FOCUSED_REVIEW",
  scope: "R1/R2 offline verifier corrections only",
  base: canonical.base,
  branch: git(["branch", "--show-current"]),
  v1: {
    path: v1Path,
    sha256: fileHash(v1Path),
    reportPath: v1.reportPath,
    reportSha256: fileHash(v1.reportPath),
    retentionPath,
    retentionSha256: fileHash(retentionPath),
    retentionRoot: retention.root,
    retainedFilesVerified: retention.entries.length,
    unchangedCurrentFiles: retention.entries.length - 1,
    onlyChangedV1File: changed,
  },
  canonical: v1.canonical,
  canonicalSha256: fileHash(v1.canonical),
  validation,
  counts: {
    captureUnits: 125,
    originalServiceInvocations: 111,
    canonicalProviderBoundaryUnits: 16,
    durableProviderLedgerEvents: 18,
    hashLinkedInterruptedEvents: 2,
    scenarios: 10,
    originalMySqlShapes: 132,
    externalAttempts: 0,
    databaseProviderCloudOperationsThisRevision: 0,
  },
  regression: {
    red: {
      tests: 24,
      failed: 21,
      passed: 3,
      validatorSha256: v1.sourceHashes[changed],
    },
    green: { tests: 29, passed: 29, failed: 0 },
  },
  checks,
  originalSourceEquality: true,
  originalSourceHashes: canonical.sourceHashes,
  preservedQ1: canonical.preservedQ1,
  sourceHashes,
  artifactHashes,
  reportPath,
  reportSha256: fileHash(reportPath),
  inheritedValidation:
    "v1 type check and 46 guards passed; v2 focused tests and 46 guards passed; no financial matrix rerun",
};
save(out + "/freeze-manifest-v2.json", frozen);
console.log(
  JSON.stringify({
    status: frozen.status,
    manifest: out + "/freeze-manifest-v2.json",
    sha256: fileHash(out + "/freeze-manifest-v2.json"),
    sourceHashes,
    unchangedV1Files: frozen.v1.unchangedCurrentFiles,
    validation,
  }),
);
