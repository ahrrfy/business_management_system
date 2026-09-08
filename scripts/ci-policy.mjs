import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT_NARRATIVE_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  ".github/PULL_REQUEST_TEMPLATE.md",
]);

export function requiresHeavyCi(eventName, files) {
  if (eventName !== "pull_request" || files.length === 0) return true;

  return files.some((file) => {
    if (file === "docs/deployment-vps.md") return true;
    if (file.startsWith("docs/") && file.endsWith(".md")) return false;
    if (file.startsWith(".github/ISSUE_TEMPLATE/")) return false;
    return !ROOT_NARRATIVE_FILES.has(file);
  });
}

export function ciGatePasses(heavy, testShardsResult, qualityBuildResult) {
  if (heavy === "true") {
    return testShardsResult === "success" && qualityBuildResult === "success";
  }
  if (heavy === "false") {
    return testShardsResult === "skipped" && qualityBuildResult === "skipped";
  }
  return false;
}

function classifyFromGit() {
  const eventName = process.env.EVENT_NAME ?? "";
  let files = [];

  if (
    eventName === "pull_request" &&
    process.env.BASE_SHA &&
    process.env.HEAD_SHA
  ) {
    const diff = spawnSync(
      "git",
      [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        "--diff-filter=ACDMRT",
        process.env.BASE_SHA,
        process.env.HEAD_SHA,
      ],
      { encoding: "utf8" },
    );
    if (diff.status === 0) {
      files = diff.stdout.split("\0").filter(Boolean);
    }
  }

  const heavy = requiresHeavyCi(eventName, files);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `heavy=${heavy}\n`);
  } else {
    process.stdout.write(`heavy=${heavy}\n`);
  }
}

function assertGate() {
  assert.ok(
    ciGatePasses(
      process.env.HEAVY,
      process.env.TEST_SHARDS_RESULT,
      process.env.QUALITY_BUILD_RESULT,
    ),
    "CI gate rejected an incomplete or failed dependency",
  );
}

function selftest() {
  assert.equal(requiresHeavyCi("push", ["README.md"]), true);
  assert.equal(requiresHeavyCi("pull_request", []), true);
  assert.equal(
    requiresHeavyCi("pull_request", ["README.md", "docs/guide/setup.md"]),
    false,
  );
  assert.equal(
    requiresHeavyCi("pull_request", ["docs/guide.md", "server/index.ts"]),
    true,
  );
  assert.equal(
    requiresHeavyCi("pull_request", ["docs/deployment-vps.md"]),
    true,
  );
  assert.equal(
    requiresHeavyCi("pull_request", ["docs/authz/endpoint-inventory.json"]),
    true,
  );
  assert.equal(
    requiresHeavyCi("pull_request", ["server/old.ts", "docs/old.ts.md"]),
    true,
  );

  assert.equal(ciGatePasses("true", "success", "success"), true);
  for (const failed of ["failure", "cancelled", "skipped"]) {
    assert.equal(ciGatePasses("true", failed, "success"), false);
    assert.equal(ciGatePasses("true", "success", failed), false);
  }
  assert.equal(ciGatePasses("false", "skipped", "skipped"), true);
  assert.equal(ciGatePasses("false", "success", "skipped"), false);
  assert.equal(ciGatePasses("false", "skipped", "success"), false);
  assert.equal(ciGatePasses("", "skipped", "skipped"), false);
  process.stdout.write("ci-policy selftest: OK\n");
}

switch (process.argv[2]) {
  case "scope":
    classifyFromGit();
    break;
  case "gate":
    assertGate();
    break;
  case "--selftest":
    selftest();
    break;
}
