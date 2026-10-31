import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RETIREMENTS_PATH = "shared/operationPermissionRetirements.json";
const CATALOG_MAIN = "shared/operationPermissionCatalog.generated.ts";
const CATALOG_PARTS = [
  "shared/operationPermissionCatalog.part1.generated.ts",
  "shared/operationPermissionCatalog.part2.generated.ts",
];
const OPERATION_KEY =
  /^operation\.(?:[A-Za-z_$][\w$-]*|\d+)(?:\.(?:[A-Za-z_$][\w$-]*|\d+))*$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRetirements(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} retirement manifest must be an array`);
    return [];
  }
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const key = value[index];
    if (typeof key !== "string") {
      errors.push(`${label} retirement entry ${index} must be a string`);
      continue;
    }
    if (!OPERATION_KEY.test(key)) {
      errors.push(
        `${label} retirement entry must be a canonical operation key: ${key}`,
      );
      continue;
    }
    if (seen.has(key)) {
      errors.push(
        `${label} retirement manifest contains duplicate key: ${key}`,
      );
      continue;
    }
    seen.add(key);
    entries.push(key);
  }
  return entries;
}

function readCatalog(value, label, errors) {
  const entries = new Map();
  if (!Array.isArray(value)) {
    errors.push(`${label} catalog must be an array`);
    return entries;
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isRecord(entry)) {
      errors.push(`${label} catalog entry ${index} must be an object`);
      continue;
    }
    const { key, path, delegable, supportsRecordScope, reservedKind } = entry;
    if (typeof key !== "string" || !OPERATION_KEY.test(key)) {
      errors.push(`${label} catalog entry ${index} has a noncanonical key`);
      continue;
    }
    if (typeof path !== "string" || key !== `operation.${path}`) {
      errors.push(`${label} catalog entry has mismatched key/path: ${key}`);
      continue;
    }
    if (typeof delegable !== "boolean")
      errors.push(`${label} catalog entry has invalid delegable flag: ${key}`);
    if (typeof supportsRecordScope !== "boolean")
      errors.push(
        `${label} catalog entry has invalid record-scope flag: ${key}`,
      );
    if (
      reservedKind !== null &&
      reservedKind !== undefined &&
      typeof reservedKind !== "string"
    )
      errors.push(`${label} catalog entry has invalid reserved kind: ${key}`);
    if (entries.has(key)) {
      errors.push(`${label} catalog contains duplicate key: ${key}`);
      continue;
    }
    entries.set(key, entry);
  }
  return entries;
}

/** Pure compatibility rules used by both the guard and focused tests. */
export function assessPolicyCatalogUpgrade({
  previousCatalog,
  currentCatalog,
  previousRetirements,
  currentRetirements,
}) {
  const errors = [];
  const previous = readCatalog(previousCatalog, "Previous", errors);
  const current = readCatalog(currentCatalog, "Current", errors);
  const retiredBefore = readRetirements(
    previousRetirements,
    "Previous",
    errors,
  );
  const retiredNow = readRetirements(currentRetirements, "Current", errors);
  const previousRetired = new Set(retiredBefore);
  const currentRetired = new Set(retiredNow);

  for (const key of previousRetired) {
    if (!currentRetired.has(key))
      errors.push(`Retirement key was removed from the manifest: ${key}`);
  }
  for (const key of previous.keys()) {
    if (!current.has(key) && !currentRetired.has(key))
      errors.push(
        `Deleted operation key is missing from retirement manifest: ${key}`,
      );
  }
  for (const key of currentRetired) {
    const operation = current.get(key);
    if (
      operation &&
      (operation.reservedKind !== "RETIRED" || operation.delegable !== false)
    ) {
      errors.push(
        `Retired operation key is live again: ${key}; it must remain RETIRED and nondelegable`,
      );
    }
  }
  for (const [key, before] of previous) {
    const after = current.get(key);
    if (
      before.delegable === true &&
      before.supportsRecordScope === true &&
      after?.delegable === true &&
      after.supportsRecordScope !== true
    ) {
      errors.push(
        `Delegable operation lost record scope compatibility: ${key}`,
      );
    }
  }
  return errors;
}

function gitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
}

function gitResult(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 30_000_000,
  });
  if (result.error)
    throw new Error(`Unable to execute git: ${result.error.message}`);
  return result;
}

function git(root, args, description) {
  const result = gitResult(root, args);
  if (result.status !== 0) {
    const detail =
      result.stderr.trim().split(/\r?\n/, 1)[0] || `exit ${result.status}`;
    throw new Error(`${description}: ${detail}`);
  }
  return result.stdout.trim();
}

function resolveCommit(root, ref, label = "baseline") {
  if (typeof ref !== "string" || ref.length === 0 || /[\0\r\n]/.test(ref))
    throw new Error(`Git ${label} reference is malformed`);
  let sha;
  try {
    sha = git(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      `Git ${label} is not available locally`,
    );
  } catch (error) {
    throw new Error(
      `Git baseline is not available locally: ${label} (${ref})`,
      {
        cause: error,
      },
    );
  }
  if (!COMMIT_ID.test(sha))
    throw new Error(`Git ${label} did not resolve to a commit object`);
  return sha.toLowerCase();
}

function pathExistsAt(root, sha, path) {
  const output = git(
    root,
    ["ls-tree", "-r", "--name-only", sha, "--", path],
    `Unable to inspect baseline ${sha}`,
  );
  return output.split(/\r?\n/).includes(path);
}

function readPathAt(root, sha, path) {
  return git(
    root,
    ["show", `${sha}:${path}`],
    `Unable to read ${path} from baseline ${sha}`,
  );
}

function parseCatalogSource(source, label, allowEmpty = false) {
  const entries = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      entries.push(JSON.parse(candidate.replace(/,$/, "")));
    } catch (error) {
      throw new Error(
        `${label} has malformed catalog JSON at line ${index + 1}`,
        { cause: error },
      );
    }
  }
  if (!allowEmpty && entries.length === 0)
    throw new Error(`${label} contains no generated operation entries`);
  return entries;
}

function readBaselineCatalog(root, sha) {
  const partPresence = CATALOG_PARTS.map((path) =>
    pathExistsAt(root, sha, path),
  );
  if (partPresence.some(Boolean)) {
    if (!partPresence.every(Boolean))
      throw new Error(
        `Baseline ${sha} has an incomplete split operation catalog`,
      );
    const entries = CATALOG_PARTS.flatMap((path) =>
      parseCatalogSource(readPathAt(root, sha, path), `${sha}:${path}`, true),
    );
    if (entries.length === 0)
      throw new Error(`Baseline ${sha} split operation catalog is empty`);
    return entries;
  }
  if (!pathExistsAt(root, sha, CATALOG_MAIN))
    throw new Error(`Baseline ${sha} operation catalog is missing`);
  return parseCatalogSource(
    readPathAt(root, sha, CATALOG_MAIN),
    `${sha}:${CATALOG_MAIN}`,
  );
}

function parseManifest(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function readBaselineRetirements(root, sha) {
  if (!pathExistsAt(root, sha, RETIREMENTS_PATH)) return [];
  return parseManifest(
    readPathAt(root, sha, RETIREMENTS_PATH),
    `${sha}:${RETIREMENTS_PATH}`,
  );
}

function readGithubEvent(env) {
  if (!env.GITHUB_EVENT_PATH)
    throw new Error("GitHub event is malformed: GITHUB_EVENT_PATH is missing");
  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch (error) {
    throw new Error("GitHub event is malformed or unreadable", {
      cause: error,
    });
  }
  if (!isRecord(event)) throw new Error("GitHub event must be an object");
  return event;
}

function githubBaseline(root, env) {
  const eventName = env.GITHUB_EVENT_NAME;
  const event = readGithubEvent(env);
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const sha = event.pull_request?.base?.sha;
    if (typeof sha !== "string" || !COMMIT_ID.test(sha))
      throw new Error("GitHub event is missing pull_request.base.sha");
    return resolveCommit(root, sha, "pull_request.base.sha");
  }
  if (eventName === "merge_group") {
    const sha = event.merge_group?.base_sha;
    if (typeof sha !== "string" || !COMMIT_ID.test(sha))
      throw new Error("GitHub event is missing merge_group.base_sha");
    return resolveCommit(root, sha, "merge_group.base_sha");
  }
  if (eventName === "push") {
    const before = event.before;
    if (typeof before !== "string" || !COMMIT_ID.test(before))
      throw new Error("GitHub push event is missing a valid before commit");
    if (/^0+$/.test(before)) return null;
    return resolveCommit(root, before, "push.before");
  }
  throw new Error(
    `Unsupported GitHub event for policy compatibility: ${eventName ?? "missing"}`,
  );
}

function resolveBaselines(root, env, baseRef) {
  const head = resolveCommit(root, "HEAD", "HEAD");
  let comparison = null;
  if (baseRef !== undefined)
    comparison = resolveCommit(root, baseRef, "baseRef");
  else if (env.GITHUB_ACTIONS === "true")
    comparison = githubBaseline(root, env);
  else {
    const mergeBase = git(
      root,
      ["merge-base", "HEAD", "origin/main"],
      "Unable to resolve local merge-base with origin/main",
    );
    comparison = resolveCommit(root, mergeBase, "merge-base");
  }
  return [...new Set([head, comparison].filter(Boolean))];
}

/** Compare working generated entries and retirement manifest with every relevant baseline. */
export function verifyOperationPolicyUpgrade({
  root,
  currentCatalog,
  env = process.env,
  baseRef,
}) {
  const repository = resolve(root);
  let manifestSource;
  try {
    manifestSource = readFileSync(join(repository, RETIREMENTS_PATH), "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${RETIREMENTS_PATH}`, { cause: error });
  }
  const currentRetirements = parseManifest(manifestSource, RETIREMENTS_PATH);
  const baselines = resolveBaselines(repository, env, baseRef);
  const failures = [];
  for (const sha of baselines) {
    const errors = assessPolicyCatalogUpgrade({
      previousCatalog: readBaselineCatalog(repository, sha),
      currentCatalog,
      previousRetirements: readBaselineRetirements(repository, sha),
      currentRetirements,
    });
    failures.push(...errors.map((error) => `${sha}: ${error}`));
  }
  if (failures.length > 0)
    throw new Error(
      `Operation policy compatibility check failed:\n- ${failures.join("\n- ")}`,
    );
  return { baselines, retiredKeys: currentRetirements.length };
}
