// Offline freeze for the independent review gate. No DB/provider access.
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { validateEvidence } from "./validate.mjs";
const root = "experiments/d1-continuity/digital",
  sha = (b) => createHash("sha256").update(b).digest("hex");
const latest = JSON.parse(
  await readFile(root + "/results/latest.json", "utf8"),
);
assert.equal(latest.status, "DONE_WITH_CONCERNS");
const canonical = JSON.parse(
  await readFile(latest.out + "/oracle.json", "utf8"),
);
const checks = JSON.parse(
  await readFile(root + "/results/checks.json", "utf8"),
);
assert.equal(checks.types.exitCode, 0);
assert.equal(checks.guards.exitCode, 0);
assert.equal(checks.tests.failed, 0);
assert.equal(checks.tests.passed, 4);
const originalDiff = execFileSync(
  "git",
  [
    "diff",
    "--name-only",
    canonical.base,
    "--",
    "server",
    "client",
    "shared",
    "drizzle",
  ],
  { encoding: "utf8", windowsHide: true },
).trim();
assert.equal(originalDiff, "");
assert.equal(
  execFileSync("git", ["diff", "--cached", "--name-only"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  "",
  "Freeze must precede staging/commit",
);
const frozen = {
  status: "FROZEN_AWAITING_INDEPENDENT_REVIEW",
  base: canonical.base,
  branch: execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  canonical: latest.out + "/oracle.json",
  validation: validateEvidence(canonical),
  checks,
  originalSourceEquality: true,
  preservedQ1: canonical.preservedQ1,
  originalSourceHashes: canonical.sourceHashes,
  sourceHashes: {},
  contractReferenceHashes: {},
  artifactHashes: {},
  provenance: [],
};
for (const [file, expected] of Object.entries(canonical.sourceHashes))
  assert.equal(
    sha(await readFile(file)),
    expected,
    file + " original hash drift",
  );
for (const [file, expected] of Object.entries(canonical.preservedQ1))
  assert.equal(
    sha(await readFile(file)),
    expected,
    "Prior Q1 evidence drift: " + file,
  );
for (const name of (await readdir(root)).filter((n) => n !== "results"))
  frozen.sourceHashes[root + "/" + name] = sha(
    await readFile(root + "/" + name),
  );
for (const file of [
  "experiments/d1-continuity/accounting/mysql-lab.mjs",
  "server/services/__tests__/digitalCardsIntent.test.ts",
  "server/services/__tests__/digitalCardsFinalize.test.ts",
  "server/services/__tests__/digitalCardsMixedCart.test.ts",
  "server/services/__tests__/digitalCardsHardening.test.ts",
  "drizzle/migrations/0332_digital_card_baskets.sql",
])
  frozen.contractReferenceHashes[file] = sha(await readFile(file));
let currentPath = frozen.canonical;
const seen = new Set(),
  resultsRoot = path.resolve(root, "results") + path.sep;
while (currentPath) {
  assert.ok(path.resolve(currentPath).startsWith(resultsRoot));
  assert.ok(!seen.has(currentPath));
  seen.add(currentPath);
  const bytes = await readFile(currentPath),
    evidence = JSON.parse(bytes),
    directory = path.dirname(currentPath);
  frozen.provenance.push({
    path: currentPath,
    sha256: sha(bytes),
    status: evidence.status,
    scenarios: evidence.scenarios.length,
    commands: evidence.scenarios.reduce((n, s) => n + s.commands.length, 0),
    continuation: evidence.continuedFrom ?? null,
    blocker: evidence.blocker ?? null,
  });
  for (const name of await readdir(directory))
    frozen.artifactHashes[(directory + "/" + name).replaceAll("\\", "/")] = sha(
      await readFile(path.join(directory, name)),
    );
  if (evidence.continuedFrom) {
    assert.equal(
      sha(await readFile(evidence.continuedFrom.path)),
      evidence.continuedFrom.sha256,
    );
    currentPath = evidence.continuedFrom.path;
  } else currentPath = null;
}
for (const name of [
  "latest.json",
  "checks.json",
  "guard-test.log",
  "check-guards.log",
])
  frozen.artifactHashes[root + "/results/" + name] = sha(
    await readFile(root + "/results/" + name),
  );
for (const name of (await readdir(root + "/results")).filter((n) =>
  n.startsWith("tests-"),
))
  for (const child of await readdir(root + "/results/" + name))
    frozen.artifactHashes[root + "/results/" + name + "/" + child] = sha(
      await readFile(root + "/results/" + name + "/" + child),
    );
frozen.reportPath = ".superpowers/sdd/digital-q2-oracle-report.md";
frozen.reportSha256 = sha(await readFile(frozen.reportPath));
await writeFile(
  root + "/results/freeze-manifest.json",
  JSON.stringify(frozen, null, 2),
);
console.log(
  JSON.stringify({
    status: frozen.status,
    sourceFiles: Object.keys(frozen.sourceHashes).length,
    originalHashes: Object.keys(frozen.originalSourceHashes).length,
    artifacts: Object.keys(frozen.artifactHashes).length,
    runs: frozen.provenance.length,
    manifestSha256: sha(await readFile(root + "/results/freeze-manifest.json")),
  }),
);
