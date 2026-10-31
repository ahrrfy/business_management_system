import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import {
  assessPolicyCatalogUpgrade,
  verifyOperationPolicyUpgrade,
} from "./operation-policy-compatibility.mjs";

const RETIRED = "operation.payroll.advanceThresholds";
const SALE = "operation.sales.create";
const RETURN = "operation.returns.create";
const TEMP_PREFIX = "operation-policy-compatibility-";

function operation(key, overrides = {}) {
  return {
    key,
    path: key.slice("operation.".length),
    delegable: true,
    supportsRecordScope: false,
    reservedKind: null,
    ...overrides,
  };
}

function assess(overrides = {}) {
  return assessPolicyCatalogUpgrade({
    previousCatalog: [operation(SALE), operation(RETURN)],
    currentCatalog: [operation(SALE), operation(RETURN)],
    previousRetirements: [],
    currentRetirements: [],
    ...overrides,
  });
}

test("requires every deleted operation key to enter the retirement manifest", () => {
  const previousCatalog = [operation(SALE), operation(RETURN)];
  const currentCatalog = [operation(SALE)];
  assert.match(
    assess({ previousCatalog, currentCatalog }).join("\n"),
    /deleted.*operation\.returns\.create/i,
  );
  assert.deepEqual(
    assess({
      previousCatalog,
      currentCatalog,
      currentRetirements: [RETURN],
    }),
    [],
  );
});

test("keeps retirement append-only and prevents live resurrection", () => {
  assert.match(
    assess({ previousRetirements: [RETIRED] }).join("\n"),
    /removed from.*manifest.*advanceThresholds/i,
  );
  assert.match(
    assess({
      previousCatalog: [],
      currentCatalog: [operation(RETIRED)],
      previousRetirements: [RETIRED],
      currentRetirements: [RETIRED],
    }).join("\n"),
    /retired.*live.*advanceThresholds/i,
  );
  assert.deepEqual(
    assess({
      previousCatalog: [],
      currentCatalog: [
        operation(RETIRED, {
          delegable: false,
          reservedKind: "RETIRED",
        }),
      ],
      previousRetirements: [RETIRED],
      currentRetirements: [RETIRED],
    }),
    [],
  );
});

test("blocks record-scope withdrawal only while an operation remains delegable", () => {
  const scoped = operation(SALE, { supportsRecordScope: true });
  assert.match(
    assess({
      previousCatalog: [scoped],
      currentCatalog: [operation(SALE)],
    }).join("\n"),
    /record scope.*operation\.sales\.create/i,
  );
  assert.deepEqual(
    assess({
      previousCatalog: [scoped],
      currentCatalog: [
        operation(SALE, {
          delegable: false,
          supportsRecordScope: false,
          reservedKind: "RETIRED",
        }),
      ],
      currentRetirements: [SALE],
    }),
    [],
  );
});

test("rejects malformed manifests but permits the reviewed legacy bootstrap", () => {
  const malformed = assess({
    currentRetirements: [RETIRED, RETIRED, "payroll.advanceThresholds", 42],
  }).join("\n");
  assert.match(malformed, /duplicate.*advanceThresholds/i);
  assert.match(malformed, /canonical.*payroll\.advanceThresholds/i);
  assert.match(malformed, /string/i);
  assert.match(
    assess({ currentRetirements: { key: RETIRED } }).join("\n"),
    /must be an array/i,
  );
  assert.deepEqual(
    assess({
      previousCatalog: [],
      currentCatalog: [],
      previousRetirements: [],
      currentRetirements: [RETIRED],
    }),
    [],
  );
});

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toUpperCase().startsWith("GIT_"),
      ),
    ),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root, relativePath, contents) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function renderEntries(
  entries,
  exportName = "GENERATED_OPERATION_PERMISSIONS",
) {
  return [
    `export const ${exportName} = [`,
    ...entries.map((entry) => `  ${JSON.stringify(entry)},`),
    "];",
    "",
  ].join("\n");
}

function writeSplitCatalog(root, entries) {
  const midpoint = Math.ceil(entries.length / 2);
  write(
    root,
    "shared/operationPermissionCatalog.part1.generated.ts",
    renderEntries(entries.slice(0, midpoint), "PART_1"),
  );
  write(
    root,
    "shared/operationPermissionCatalog.part2.generated.ts",
    renderEntries(entries.slice(midpoint), "PART_2"),
  );
  write(
    root,
    "shared/operationPermissionCatalog.generated.ts",
    "export const GENERATED_OPERATION_PERMISSIONS = [];\n",
  );
}

function writeMonolithicCatalog(root, entries) {
  write(
    root,
    "shared/operationPermissionCatalog.generated.ts",
    renderEntries(entries),
  );
}

function writeRetirements(root, entries) {
  write(
    root,
    "shared/operationPermissionRetirements.json",
    `${JSON.stringify(entries, null, 2)}\n`,
  );
}

function commit(root, message) {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.email=guard@example.invalid",
    "-c",
    "user.name=Policy Guard Test",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}

function withPoisonedGitEnvironment(callback) {
  const poison = {
    GIT_DIR: join(tmpdir(), "outside.git"),
    GIT_WORK_TREE: join(tmpdir(), "outside-worktree"),
    GIT_INDEX_FILE: join(tmpdir(), "outside-index"),
  };
  const previous = new Map(
    Object.keys(poison).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, poison);
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => {
    const exact = resolve(root);
    if (
      dirname(exact) !== resolve(tmpdir()) ||
      !basename(exact).startsWith(TEMP_PREFIX) ||
      !exact.startsWith(`${resolve(tmpdir())}${sep}`)
    ) {
      throw new Error(`Refusing unsafe fixture cleanup: ${exact}`);
    }
    rmSync(exact, { recursive: true, force: true });
  });
  git(root, ["init", "--quiet"]);
  return root;
}

test("compares uncommitted current state with HEAD", (t) => {
  const root = repository(t);
  const previous = [operation(SALE), operation(RETURN)];
  writeSplitCatalog(root, previous);
  const head = commit(root, "baseline");
  writeRetirements(root, []);
  assert.throws(
    () =>
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        baseRef: "HEAD",
      }),
    /deleted.*operation\.returns\.create/i,
  );
  writeRetirements(root, [RETURN]);
  assert.deepEqual(
    withPoisonedGitEnvironment(() =>
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        baseRef: "HEAD",
      }),
    ),
    { baselines: [head], retiredKeys: 1 },
  );
});

test("uses local merge-base and supports legacy monolithic catalogs", async (t) => {
  await t.test("local merge-base", (t) => {
    const root = repository(t);
    writeSplitCatalog(root, [operation(SALE), operation(RETURN)]);
    const base = commit(root, "base");
    git(root, ["update-ref", "refs/remotes/origin/main", base]);
    writeSplitCatalog(root, [operation(SALE)]);
    const head = commit(root, "delete without manifest");
    writeRetirements(root, [RETURN]);
    assert.deepEqual(
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        env: {},
      }),
      { baselines: [head, base], retiredKeys: 1 },
    );
  });
  await t.test("monolithic baseline", (t) => {
    const root = repository(t);
    const catalog = [operation(SALE)];
    writeMonolithicCatalog(root, catalog);
    const head = commit(root, "monolithic");
    writeRetirements(root, []);
    assert.deepEqual(
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: catalog,
        baseRef: head,
      }),
      { baselines: [head], retiredKeys: 0 },
    );
  });
});

test("reads PR, merge-group, and push baselines from GitHub event payloads", (t) => {
  const root = repository(t);
  writeSplitCatalog(root, [operation(SALE), operation(RETURN)]);
  const base = commit(root, "base");
  writeSplitCatalog(root, [operation(SALE)]);
  writeRetirements(root, [RETURN]);
  const head = commit(root, "retired deletion");
  const eventPath = join(root, "event.json");

  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: base } } }),
  );
  assert.deepEqual(
    verifyOperationPolicyUpgrade({
      root,
      currentCatalog: [operation(SALE)],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
      },
    }),
    { baselines: [head, base], retiredKeys: 1 },
  );

  writeFileSync(eventPath, JSON.stringify({ merge_group: { base_sha: base } }));
  assert.deepEqual(
    verifyOperationPolicyUpgrade({
      root,
      currentCatalog: [operation(SALE)],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "merge_group",
        GITHUB_EVENT_PATH: eventPath,
      },
    }),
    { baselines: [head, base], retiredKeys: 1 },
  );

  writeFileSync(eventPath, JSON.stringify({ before: base }));
  assert.deepEqual(
    verifyOperationPolicyUpgrade({
      root,
      currentCatalog: [operation(SALE)],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventPath,
      },
    }),
    { baselines: [head, base], retiredKeys: 1 },
  );

  writeFileSync(eventPath, JSON.stringify({ before: "0".repeat(40) }));
  assert.deepEqual(
    verifyOperationPolicyUpgrade({
      root,
      currentCatalog: [operation(SALE)],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventPath,
      },
    }),
    { baselines: [head], retiredKeys: 1 },
  );
});

test("fails closed for malformed CI events and unavailable history", (t) => {
  const root = repository(t);
  writeSplitCatalog(root, [operation(SALE)]);
  commit(root, "base");
  writeRetirements(root, []);
  write(root, "shared/operationPermissionRetirements.json", "{ malformed json");
  assert.throws(
    () =>
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        baseRef: "HEAD",
      }),
    /not valid JSON/i,
  );
  writeRetirements(root, []);
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, "{}");
  assert.throws(
    () =>
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
        },
      }),
    /pull_request\.base\.sha/i,
  );

  writeFileSync(eventPath, JSON.stringify({ merge_group: {} }));
  assert.throws(
    () =>
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_EVENT_PATH: eventPath,
        },
      }),
    /merge_group\.base_sha/i,
  );

  writeFileSync(eventPath, JSON.stringify({ before: "a".repeat(40) }));
  assert.throws(
    () =>
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_PATH: eventPath,
        },
      }),
    /baseline.*not available/i,
  );
  assert.throws(
    () =>
      verifyOperationPolicyUpgrade({
        root,
        currentCatalog: [operation(SALE)],
        baseRef: "--help",
      }),
    /baseline.*not available/i,
  );
});
