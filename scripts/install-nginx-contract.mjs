#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  INTERNAL_PROXY_SECRET_PATTERN,
  NGINX_TLS_DEPENDENCIES,
  PROJECT_ROOT,
  createNginxTopologyAttestation,
  createSecretAttestation,
  readInternalProxySecretsFromEnv,
  resolveNginxContract,
  verifyLiveNginxContract,
} from "./nginx-contract.mjs";
import { verifyNginxConfiguration } from "./verify-nginx-abuse-controls.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INSTALLED_SCRIPT_PATH =
  "/usr/local/libexec/erp/nginx/install-nginx-contract.mjs";
const PRODUCTION_PROJECT_ROOT = "/home/deploy/erp";
const INSTALLED_RELEASE_MANIFEST_PATH =
  "/usr/local/libexec/erp/nginx/nginx-release-manifest.json";
const TRUSTED_NODE_PATH = "/usr/bin/node";
const OPERATION_LOCK_PATH = "/run/erp-nginx-contract.operation.lock";
const PROXY_SECRET_EXAMPLE_RELATIVE_PATH =
  "deploy/nginx-proxy-secret.conf.example";
function createExternalHealthScript(origins) {
  return String.raw`
const origins = ${JSON.stringify(origins)};
for (const origin of origins) {
  let healthy = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(origin + "/healthz", {
        headers: { Accept: "application/json", "User-Agent": "Alroya-Nginx-Contract-Smoke/1.0" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json();
      if (response.ok && payload?.ok === true) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!healthy) throw new Error("NGINX_EXTERNAL_HEALTH_FAILED:" + new URL(origin).hostname);
  console.log("nginx external health: " + new URL(origin).hostname + " OK");
}
`;
}

const NGINX_EXTERNAL_HEALTH_SCRIPT = createExternalHealthScript([
  "https://srv1548487.hstgr.cloud",
  "https://alarabiya.online",
]);
const NGINX_ROLLBACK_HEALTH_SCRIPT = createExternalHealthScript([
  "https://srv1548487.hstgr.cloud",
]);
const ROTATION_JOURNAL_NAME = "proxy-secret-rotation.pending.json";
const ORIGIN_SECRET_CANARY_SCRIPT = String.raw`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const policy = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const results = [];
for (const secret of policy.secrets) {
  const workers = new Map();
  for (let attempt = 0; attempt < policy.workers * 12 && workers.size < policy.workers; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:" + policy.port + "/healthz", {
        headers: {
          "Connection": "close",
          "X-Alroya-Worker-Probe": "1",
          "X-Internal-Proxy-Secret": secret,
        },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const worker = response.headers.get("x-alroya-worker-instance") || "";
      if (!/^[A-Za-z0-9_-]{16}$/.test(worker)) {
        throw new Error("INTERNAL_PROXY_WORKER_ID_INVALID");
      }
      const prior = workers.get(worker);
      if (prior !== undefined && prior !== response.status) {
        throw new Error("INTERNAL_PROXY_WORKER_STATUS_UNSTABLE");
      }
      workers.set(worker, response.status);
    } catch (error) {
      if (String(error?.message || "").startsWith("INTERNAL_PROXY_")) throw error;
    }
  }
  if (workers.size !== policy.workers) {
    throw new Error("INTERNAL_PROXY_WORKER_COVERAGE_FAILED");
  }
  results.push([...workers.values()]);
}
process.stdout.write(JSON.stringify({ results }));
`;
const LOGGER_REDACTION_FETCH_SCRIPT = String.raw`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const response = await fetch(input.origin + "/healthz?probe=" + encodeURIComponent(input.marker), {
  headers: {
    Accept: "application/json",
    Authorization: "Bearer " + input.bearer,
    "User-Agent": "Alroya-Logger-Redaction-Probe/1.0",
  },
  redirect: "error",
  signal: AbortSignal.timeout(5000),
});
const payload = await response.json();
if (!response.ok || payload?.ok !== true) throw new Error("LOGGER_REDACTION_HEALTH_FAILED");
await new Promise((resolve) => setTimeout(resolve, 250));
`;
const LOGGER_REDACTION_ORIGIN = "https://srv1548487.hstgr.cloud";
const LOGGER_REDACTION_MAX_APPEND = 2 * 1024 * 1024;
const APP_ENV_OWNER_HELPER_SCRIPT = String.raw`
import fs from "node:fs";
import path from "node:path";

const chunks = [];
let inputSize = 0;
for await (const chunk of process.stdin) {
  inputSize += chunk.length;
  if (inputSize > 2 * 1024 * 1024) throw new Error("APP_ENV_HELPER_INPUT_INVALID");
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  !input ||
  !["read", "write"].includes(input.action) ||
  typeof input.target !== "string" ||
  !path.isAbsolute(input.target) ||
  !Number.isInteger(input.uid) ||
  input.uid <= 0 ||
  !Number.isInteger(input.gid) ||
  input.gid < 0
) throw new Error("APP_ENV_HELPER_INPUT_INVALID");
if (process.getuid?.() !== input.uid || process.getgid?.() !== input.gid) {
  throw new Error("APP_ENV_HELPER_PRIVILEGE_INVALID");
}

const SECRET = /^[a-f0-9]{64}$/iu;
const same = (left, right) =>
  Buffer.byteLength(left) === Buffer.byteLength(right) &&
  Buffer.from(left).equals(Buffer.from(right));
const assertOwnedFile = (stat) => {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== input.uid ||
    stat.gid !== input.gid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 2 * 1024 * 1024
  ) throw new Error("APP_ENV_HELPER_FILE_INVALID");
};
const descriptor = fs.openSync(
  input.target,
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
);
let content;
try {
  assertOwnedFile(fs.fstatSync(descriptor));
  content = fs.readFileSync(descriptor, "utf8");
} finally {
  fs.closeSync(descriptor);
}

const matches = { current: [], previous: [] };
for (const rawLine of content.split(/\r?\n/u)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const match = /^(?:export\s+)?(INTERNAL_PROXY_SECRET|INTERNAL_PROXY_SECRET_PREVIOUS)\s*=\s*(.*)$/u.exec(line);
  if (!match) continue;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) value = value.slice(1, -1);
  matches[match[1] === "INTERNAL_PROXY_SECRET" ? "current" : "previous"].push(value);
}
if (
  matches.current.length !== 1 ||
  !SECRET.test(matches.current[0]) ||
  matches.previous.length > 1 ||
  (matches.previous.length === 1 &&
    (!SECRET.test(matches.previous[0]) || same(matches.current[0], matches.previous[0])))
) throw new Error("APP_ENV_HELPER_SECRET_INVALID");

const integerValue = (key, fallback, minimum, maximum) => {
  const definition = new RegExp("^\\s*(?:export\\s+)?" + key + "\\s*=", "u");
  const definitions = content.split(/\r?\n/u).filter((line) => definition.test(line));
  if (definitions.length > 1) throw new Error("APP_ENV_HELPER_INTEGER_INVALID");
  if (definitions.length === 0) return fallback;
  const match = /^\s*(?:export\s+)?[A-Z_]+\s*=\s*(?:([0-9]+)|"([0-9]+)"|'([0-9]+)')\s*(?:#.*)?$/u.exec(definitions[0]);
  const value = Number(match?.[1] ?? match?.[2] ?? match?.[3] ?? Number.NaN);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("APP_ENV_HELPER_INTEGER_INVALID");
  }
  return value;
};
const snapshot = {
  current: matches.current[0],
  ...(matches.previous.length === 1 ? { previous: matches.previous[0] } : {}),
  ...(input.includeRuntime === true
    ? {
        port: integerValue("PORT", 3000, 1, 65535),
        webInstances: integerValue("WEB_INSTANCES", 2, 1, 16),
      }
    : {}),
};

if (input.action === "read") {
  process.stdout.write(JSON.stringify(snapshot));
  process.exit(0);
}
if (
  !SECRET.test(input.current ?? "") ||
  (input.previous !== undefined &&
    (!SECRET.test(input.previous) || same(input.current, input.previous)))
) throw new Error("APP_ENV_HELPER_SECRET_INVALID");
const kept = content
  .split(/\r?\n/u)
  .filter((line) => !/^\s*(?:export\s+)?INTERNAL_PROXY_SECRET(?:_PREVIOUS)?\s*=/u.test(line));
while (kept.at(-1) === "") kept.pop();
const rendered = [
  ...kept,
  "INTERNAL_PROXY_SECRET=" + input.current,
  ...(input.previous ? ["INTERNAL_PROXY_SECRET_PREVIOUS=" + input.previous] : []),
].join("\n") + "\n";
const parent = path.dirname(input.target);
const parentDescriptor = fs.openSync(
  parent,
  fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
);
const parentStat = fs.fstatSync(parentDescriptor);
if (!parentStat.isDirectory() || parentStat.uid !== input.uid || parentStat.gid !== input.gid) {
  fs.closeSync(parentDescriptor);
  throw new Error("APP_ENV_HELPER_PARENT_INVALID");
}
const temporary = path.join(parent, ".alroya-" + path.basename(input.target) + "-rotation-stage");
let stageDescriptor;
try {
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  stageDescriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  fs.writeFileSync(stageDescriptor, rendered, "utf8");
  fs.fchmodSync(stageDescriptor, 0o600);
  fs.fsyncSync(stageDescriptor);
  fs.fsyncSync(parentDescriptor);
  if (typeof input.testPausePath === "string") {
    fs.writeFileSync(input.testPausePath + ".ready", "ready", { flag: "wx", mode: 0o600 });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(input.testPausePath + ".continue") && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (!fs.existsSync(input.testPausePath + ".continue")) {
      throw new Error("APP_ENV_HELPER_TEST_TIMEOUT");
    }
  }
  const descriptorStat = fs.fstatSync(stageDescriptor);
  const pathStat = fs.lstatSync(temporary);
  assertOwnedFile(descriptorStat);
  assertOwnedFile(pathStat);
  if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
    throw new Error("APP_ENV_HELPER_STAGE_REPLACED");
  }
  fs.renameSync(temporary, input.target);
  fs.fsyncSync(parentDescriptor);
} finally {
  if (stageDescriptor !== undefined) fs.closeSync(stageDescriptor);
  fs.closeSync(parentDescriptor);
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
process.stdout.write(JSON.stringify({ ok: true }));
`;

function installerError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertPlainDirectory(directory, code) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw installerError(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw installerError(code);
  return stat;
}

function assertPlainFile(file, code) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw installerError(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw installerError(code);
  }
  return stat;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncFile(file) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(file, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function runtimeEnvironment() {
  return Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "SystemRoot", "WINDIR"].flatMap((key) =>
      typeof process.env[key] === "string" ? [[key, process.env[key]]] : [],
    ),
  );
}

export function runAppEnvironmentOwnerHelper(input) {
  const projectRoot = path.resolve(input.projectRoot);
  const appEnvPath = path.resolve(input.appEnvPath);
  if (
    process.platform !== "linux" ||
    typeof process.getuid !== "function" ||
    process.getuid() !== 0 ||
    path.dirname(appEnvPath) !== projectRoot ||
    !["read", "write"].includes(input.action)
  ) {
    throw installerError("NGINX_ROTATION_APP_ENV_OWNER_INVALID");
  }
  const projectStat = assertPlainDirectory(
    projectRoot,
    "NGINX_ROTATION_APP_ENV_OWNER_INVALID",
  );
  const envStat = assertPlainFile(
    appEnvPath,
    "NGINX_ROTATION_APP_ENV_OWNER_INVALID",
  );
  if (
    projectStat.uid === 0 ||
    envStat.uid !== projectStat.uid ||
    envStat.gid !== projectStat.gid ||
    envStat.nlink !== 1 ||
    (envStat.mode & 0o777) !== 0o600
  ) {
    throw installerError("NGINX_ROTATION_APP_ENV_OWNER_INVALID");
  }
  const payload = {
    action: input.action,
    target: appEnvPath,
    uid: projectStat.uid,
    gid: projectStat.gid,
    ...(input.action === "write"
      ? {
          current: input.current,
          ...(input.previous ? { previous: input.previous } : {}),
        }
      : {}),
    ...(typeof input.testPausePath === "string"
      ? { testPausePath: input.testPausePath }
      : {}),
    ...(input.includeRuntime === true ? { includeRuntime: true } : {}),
  };
  const runtime =
    path.resolve(SCRIPT_PATH) === INSTALLED_SCRIPT_PATH
      ? TRUSTED_NODE_PATH
      : process.execPath;
  let output;
  try {
    output = execFileSync(
      runtime,
      ["--input-type=module", "-e", APP_ENV_OWNER_HELPER_SCRIPT],
      {
        cwd: projectRoot,
        uid: projectStat.uid,
        gid: projectStat.gid,
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: runtimeEnvironment(),
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    );
  } catch {
    throw installerError("NGINX_ROTATION_APP_ENV_HELPER_FAILED");
  }
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw installerError("NGINX_ROTATION_APP_ENV_HELPER_FAILED");
  }
  if (input.action === "write") {
    if (
      JSON.stringify(result) !== JSON.stringify({ ok: true })
    ) {
      throw installerError("NGINX_ROTATION_APP_ENV_HELPER_FAILED");
    }
    return Object.freeze(result);
  }
  if (
    !INTERNAL_PROXY_SECRET_PATTERN.test(result?.current ?? "") ||
    (result?.previous !== undefined &&
      (!INTERNAL_PROXY_SECRET_PATTERN.test(result.previous) ||
        secretsMatch(result.current, result.previous))) ||
    (input.includeRuntime === true &&
      (!Number.isInteger(result?.port) ||
        result.port < 1 ||
        result.port > 65_535 ||
        !Number.isInteger(result?.webInstances) ||
        result.webInstances < 1 ||
        result.webInstances > 16)) ||
    JSON.stringify(Object.keys(result).sort()) !==
      JSON.stringify(
        [
          "current",
          ...(result.previous === undefined ? [] : ["previous"]),
          ...(input.includeRuntime === true ? ["port", "webInstances"] : []),
        ].sort(),
      )
  ) {
    throw installerError("NGINX_ROTATION_APP_ENV_HELPER_FAILED");
  }
  return Object.freeze(result);
}

function sleepMilliseconds(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function verifyLoggerRedactionAppend({
  file,
  descriptor,
  snapshot,
  marker,
  bearer,
  secrets,
  timeoutMilliseconds = 5_000,
}) {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    const pathStat = fs.lstatSync(file);
    const descriptorStat = fs.fstatSync(descriptor);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !descriptorStat.isFile() ||
      !sameFileIdentity(pathStat, snapshot) ||
      !sameFileIdentity(descriptorStat, snapshot) ||
      descriptorStat.size < snapshot.size
    ) {
      throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
    }
    const length = descriptorStat.size - snapshot.size;
    if (length > LOGGER_REDACTION_MAX_APPEND) {
      throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
    }
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      const read = fs.readSync(descriptor, buffer, 0, length, snapshot.size);
      if (read !== length) {
        throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
      }
    }
    const appended = buffer.toString("utf8");
    if (
      secrets.some((secret) => appended.includes(secret)) ||
      appended.includes(bearer)
    ) {
      throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
    }
    const markerRecords = appended
      .split("\n")
      .slice(0, -1)
      .filter((record) => record.includes(marker));
    if (markerRecords.length > 0) {
      if (markerRecords.some((record) => /Bearer/iu.test(record))) {
        throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
      }
      const finalPathStat = fs.lstatSync(file);
      const finalDescriptorStat = fs.fstatSync(descriptor);
      if (
        !sameFileIdentity(finalPathStat, snapshot) ||
        !sameFileIdentity(finalDescriptorStat, snapshot) ||
        finalDescriptorStat.size < descriptorStat.size
      ) {
        throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
      }
      return Object.freeze({ ok: true });
    }
    if (Date.now() < deadline) sleepMilliseconds(100);
  } while (Date.now() < deadline);
  throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
}

function runLoggerRedactionGate(projectRoot, secrets) {
  const file = path.join(projectRoot, "logs", "erp-out.log");
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const snapshot = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (
      !snapshot.isFile() ||
      pathStat.isSymbolicLink() ||
      !sameFileIdentity(snapshot, pathStat)
    ) {
      throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
    }
    const marker = `lrp-${randomBytes(16).toString("hex")}`;
    const bearer = randomBytes(32).toString("hex");
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", LOGGER_REDACTION_FETCH_SCRIPT],
      {
        cwd: projectRoot,
        input: JSON.stringify({
          origin: LOGGER_REDACTION_ORIGIN,
          marker,
          bearer,
        }),
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 15_000,
        env: runtimeEnvironment(),
      },
    );
    return verifyLoggerRedactionAppend({
      file,
      descriptor,
      snapshot,
      marker,
      bearer,
      secrets,
    });
  } catch {
    throw installerError("NGINX_ROTATION_LOG_REDACTION_GATE_FAILED");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isFlockParent(action) {
  if (process.platform !== "linux") return false;
  try {
    if (
      fs.realpathSync(`/proc/${process.ppid}/exe`) !==
      fs.realpathSync("/usr/bin/flock")
    ) {
      return false;
    }
    const command = fs
      .readFileSync(`/proc/${process.ppid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
    return (
      JSON.stringify(command) ===
      JSON.stringify([
        "/usr/bin/flock",
        "-n",
        "-x",
        "-E",
        "75",
        OPERATION_LOCK_PATH,
        TRUSTED_NODE_PATH,
        SCRIPT_PATH,
        "--under-flock",
        action,
      ])
    );
  } catch {
    return false;
  }
}

function prepareOperationLockFile() {
  const parentStat = assertPlainDirectory(
    path.dirname(OPERATION_LOCK_PATH),
    "NGINX_OPERATION_LOCK_PARENT_INVALID",
  );
  if (
    (parentStat.mode & 0o022) !== 0 ||
    parentStat.uid !== 0 ||
    parentStat.gid !== 0
  ) {
    throw installerError("NGINX_OPERATION_LOCK_PARENT_INVALID");
  }
  const descriptor = fs.openSync(
    OPERATION_LOCK_PATH,
    fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw installerError("NGINX_OPERATION_LOCK_INVALID");
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.fchownSync(descriptor, 0, 0);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(OPERATION_LOCK_PATH));
}

function runMainUnderFlock(action) {
  prepareOperationLockFile();
  try {
    execFileSync(
      "/usr/bin/flock",
      [
        "-n",
        "-x",
        "-E",
        "75",
        OPERATION_LOCK_PATH,
        TRUSTED_NODE_PATH,
        SCRIPT_PATH,
        "--under-flock",
        action,
      ],
      {
        cwd: PRODUCTION_PROJECT_ROOT,
        stdio: "inherit",
        timeout: 10 * 60_000,
        env: runtimeEnvironment(),
      },
    );
  } catch (error) {
    if (error?.status === 75) {
      throw installerError("NGINX_OPERATION_LOCK_BUSY");
    }
    const failure = installerError("NGINX_OPERATION_LOCK_FAILED");
    failure.exitStatus = Number.isInteger(error?.status) ? error.status : 1;
    throw failure;
  }
}

function writeAtomicFile(target, content, mode, options, label) {
  const existing = assertPlainFile(target, "NGINX_ROTATION_TARGET_INVALID");
  const temporary = path.join(
    path.dirname(target),
    `.alroya-${path.basename(target)}-rotation-stage`,
  );
  try {
    const staged = lstatOrNull(temporary);
    if (staged) {
      if (!staged.isFile() || staged.isSymbolicLink()) {
        throw installerError("NGINX_ROTATION_STAGING_INVALID");
      }
      fs.unlinkSync(temporary);
      fsyncDirectory(path.dirname(temporary));
    }
    fs.writeFileSync(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    applyOwnerAndMode(temporary, mode, options, existing.uid, existing.gid);
    const temporaryStat = fs.lstatSync(temporary);
    if (
      !temporaryStat.isFile() ||
      temporaryStat.isSymbolicLink() ||
      temporaryStat.nlink !== 1
    ) {
      throw installerError("NGINX_ROTATION_STAGING_INVALID");
    }
    fsyncFile(temporary);
    fsyncDirectory(path.dirname(temporary));
    options.afterRotationMutation?.(`${label}-staged`);
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
    options.afterRotationMutation?.(`${label}-renamed`);
  } finally {
    if (!options.faultInjection && lstatOrNull(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function renderAppSecrets(file, current, previous) {
  const kept = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/^\s*(?:export\s+)?INTERNAL_PROXY_SECRET(?:_PREVIOUS)?\s*=/u.test(
          line,
        ),
    );
  while (kept.at(-1) === "") kept.pop();
  return `${[
    ...kept,
    `INTERNAL_PROXY_SECRET=${current}`,
    ...(previous ? [`INTERNAL_PROXY_SECRET_PREVIOUS=${previous}`] : []),
  ].join("\n")}\n`;
}

function renderNginxSecret(secret) {
  return `set $alroya_proxy_secret "${secret}";\n`;
}

function rotationJournalPath(options) {
  return path.join(options.rotationDirectory, ROTATION_JOURNAL_NAME);
}

function writeRotationJournal(record, options) {
  const target = rotationJournalPath(options);
  const temporary = path.join(
    options.rotationDirectory,
    ".proxy-secret-rotation.pending.stage",
  );
  try {
    if (lstatOrNull(temporary)) fs.unlinkSync(temporary);
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    applyOwnerAndMode(temporary, 0o600, options);
    fsyncFile(temporary);
    fsyncDirectory(options.rotationDirectory);
    options.afterRotationMutation?.(`journal-${record.state}-staged`);
    fs.renameSync(temporary, target);
    fsyncDirectory(options.rotationDirectory);
    options.afterRotationMutation?.(`journal-${record.state}-renamed`);
  } finally {
    if (!options.faultInjection && lstatOrNull(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function reconcileRotationJournalStaging(options) {
  const target = rotationJournalPath(options);
  const temporary = path.join(
    options.rotationDirectory,
    ".proxy-secret-rotation.pending.stage",
  );
  const staged = lstatOrNull(temporary);
  if (!staged) return;
  if (!staged.isFile() || staged.isSymbolicLink() || staged.size > 4096) {
    throw installerError("NGINX_ROTATION_JOURNAL_INVALID");
  }
  assertOwnedMode(staged, 0o600, options, "NGINX_ROTATION_JOURNAL_INVALID");
  if (lstatOrNull(target)) {
    fs.unlinkSync(temporary);
    fsyncDirectory(options.rotationDirectory);
    return;
  }
  try {
    const record = JSON.parse(fs.readFileSync(temporary, "utf8"));
    if (record?.version !== 1 || typeof record.state !== "string")
      throw new Error();
  } catch {
    fs.unlinkSync(temporary);
    fsyncDirectory(options.rotationDirectory);
    return;
  }
  fs.renameSync(temporary, target);
  fsyncDirectory(options.rotationDirectory);
}

function readRotationJournal(options) {
  const directoryStat = lstatOrNull(options.rotationDirectory);
  if (!directoryStat) return null;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw installerError("NGINX_ROTATION_DIRECTORY_INVALID");
  }
  assertOwnedMode(
    directoryStat,
    0o700,
    options,
    "NGINX_ROTATION_DIRECTORY_INVALID",
  );
  reconcileRotationJournalStaging(options);
  const target = rotationJournalPath(options);
  const stat = lstatOrNull(target);
  if (!stat) {
    if (fs.readdirSync(options.rotationDirectory).length === 0) {
      fs.rmdirSync(options.rotationDirectory);
      fsyncDirectory(path.dirname(options.rotationDirectory));
      return null;
    }
    throw installerError("NGINX_ROTATION_JOURNAL_INVALID");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw installerError("NGINX_ROTATION_JOURNAL_INVALID");
  }
  assertOwnedMode(stat, 0o600, options, "NGINX_ROTATION_JOURNAL_INVALID");
  let record;
  try {
    record = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw installerError("NGINX_ROTATION_JOURNAL_INVALID");
  }
  if (
    record?.version !== 1 ||
    ![
      "preparing",
      "prepared",
      "switching",
      "switched",
      "retiring",
      "rollback-primed",
      "rolling-back",
      "cleanup-retired",
      "cleanup-rolled-back",
    ].includes(record?.state) ||
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(["state", "version"])
  ) {
    throw installerError("NGINX_ROTATION_JOURNAL_INVALID");
  }
  if (record.state !== "preparing" && !record.state.startsWith("cleanup-")) {
    for (const name of ["old-secret.bin", "next-secret.bin"]) {
      const secretStat = assertPlainFile(
        path.join(options.rotationDirectory, name),
        "NGINX_ROTATION_MATERIAL_INVALID",
      );
      assertOwnedMode(
        secretStat,
        0o600,
        options,
        "NGINX_ROTATION_MATERIAL_INVALID",
      );
    }
  }
  return Object.freeze(record);
}

function writeRotationMaterial(options, name, secret) {
  const target = path.join(options.rotationDirectory, name);
  const temporary = path.join(options.rotationDirectory, `.${name}.staging`);
  const existing = lstatOrNull(target);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw installerError("NGINX_ROTATION_MATERIAL_INVALID");
    }
    const content = fs.readFileSync(target, "utf8").trim();
    if (secretsMatch(content, secret)) return;
    fs.unlinkSync(target);
    fsyncDirectory(options.rotationDirectory);
  }
  const staged = lstatOrNull(temporary);
  if (staged) {
    if (!staged.isFile() || staged.isSymbolicLink()) {
      throw installerError("NGINX_ROTATION_MATERIAL_INVALID");
    }
    if (!secretsMatch(fs.readFileSync(temporary, "utf8").trim(), secret)) {
      fs.unlinkSync(temporary);
      fsyncDirectory(options.rotationDirectory);
    }
  }
  if (!lstatOrNull(temporary)) {
    fs.writeFileSync(temporary, `${secret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    applyOwnerAndMode(temporary, 0o600, options);
    fsyncFile(temporary);
    fsyncDirectory(options.rotationDirectory);
  }
  options.afterRotationMutation?.(`material-${name}-staged`);
  fs.renameSync(temporary, target);
  fsyncDirectory(options.rotationDirectory);
  options.afterRotationMutation?.(`material-${name}-renamed`);
}

function prepareRotationMaterial(options, oldSecret) {
  const parent = path.dirname(options.rotationDirectory);
  if (!lstatOrNull(parent)) fs.mkdirSync(parent, { mode: 0o700 });
  const parentStat = assertPlainDirectory(
    parent,
    "NGINX_ROTATION_PARENT_INVALID",
  );
  assertOwnedMode(parentStat, 0o700, options, "NGINX_ROTATION_PARENT_INVALID");
  const existingDirectory = lstatOrNull(options.rotationDirectory);
  if (!existingDirectory) {
    fs.mkdirSync(options.rotationDirectory, { mode: 0o700 });
    if (options.strictOwnership) {
      fs.chownSync(
        options.rotationDirectory,
        options.expectedUid,
        options.expectedGid,
      );
    }
    fs.chmodSync(options.rotationDirectory, 0o700);
  } else {
    const directoryStat = assertPlainDirectory(
      options.rotationDirectory,
      "NGINX_ROTATION_DIRECTORY_INVALID",
    );
    assertOwnedMode(
      directoryStat,
      0o700,
      options,
      "NGINX_ROTATION_DIRECTORY_INVALID",
    );
  }
  fsyncDirectory(path.dirname(options.rotationDirectory));
  if (!lstatOrNull(rotationJournalPath(options))) {
    writeRotationJournal({ version: 1, state: "preparing" }, options);
  }
  writeRotationMaterial(options, "old-secret.bin", oldSecret);
  const nextPath = path.join(options.rotationDirectory, "next-secret.bin");
  const nextTemporary = path.join(
    options.rotationDirectory,
    ".next-secret.bin.staging",
  );
  let next;
  for (const candidate of [nextPath, nextTemporary]) {
    const stat = lstatOrNull(candidate);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const content = fs.readFileSync(candidate, "utf8").trim();
    if (
      INTERNAL_PROXY_SECRET_PATTERN.test(content) &&
      !secretsMatch(oldSecret, content)
    ) {
      next = content;
      break;
    }
  }
  if (!next) next = options.generateSecret();
  if (
    !INTERNAL_PROXY_SECRET_PATTERN.test(next) ||
    secretsMatch(oldSecret, next)
  ) {
    throw installerError("NGINX_ROTATION_NEXT_SECRET_INVALID");
  }
  writeRotationMaterial(options, "next-secret.bin", next);
  options.afterRotationMutation?.("rotation-material");
  return setRotationState(
    { version: 1, state: "preparing" },
    "prepared",
    options,
  );
}

function rotationSecrets(options) {
  const old = fs
    .readFileSync(
      path.join(options.rotationDirectory, "old-secret.bin"),
      "utf8",
    )
    .trim();
  const next = fs
    .readFileSync(
      path.join(options.rotationDirectory, "next-secret.bin"),
      "utf8",
    )
    .trim();
  if (
    !INTERNAL_PROXY_SECRET_PATTERN.test(old) ||
    !INTERNAL_PROXY_SECRET_PATTERN.test(next) ||
    secretsMatch(old, next)
  ) {
    throw installerError("NGINX_ROTATION_MATERIAL_INVALID");
  }
  return Object.freeze({ old, next });
}

function setRotationState(record, state, options) {
  const updated = Object.freeze({ ...record, state });
  writeRotationJournal(updated, options);
  return updated;
}

function removeRotationMaterial(record, terminalState, options) {
  let cleanupRecord = record;
  if (record.state !== terminalState) {
    cleanupRecord = setRotationState(record, terminalState, options);
  }
  const expected = new Set([
    ROTATION_JOURNAL_NAME,
    "old-secret.bin",
    "next-secret.bin",
  ]);
  const actual = fs.readdirSync(options.rotationDirectory);
  if (actual.some((name) => !expected.has(name))) {
    throw installerError("NGINX_ROTATION_DIRECTORY_DIRTY");
  }
  for (const name of ["old-secret.bin", "next-secret.bin"]) {
    const target = path.join(options.rotationDirectory, name);
    if (lstatOrNull(target)) fs.unlinkSync(target);
    fsyncDirectory(options.rotationDirectory);
    options.afterRotationMutation?.(`cleanup-${name}`);
  }
  const journal = rotationJournalPath(options);
  if (lstatOrNull(journal)) fs.unlinkSync(journal);
  fsyncDirectory(options.rotationDirectory);
  options.afterRotationMutation?.("cleanup-journal");
  fs.rmdirSync(options.rotationDirectory);
  fsyncDirectory(path.dirname(options.rotationDirectory));
  return cleanupRecord;
}

function assertRotationRoot(options) {
  if (
    options.requireRoot &&
    (process.platform !== "linux" ||
      typeof process.getuid !== "function" ||
      process.getuid() !== 0)
  ) {
    throw installerError("NGINX_ROTATION_ROOT_REQUIRED");
  }
}

function readAppEnvironment(options, includeRuntime = false) {
  if (options.requireRoot) {
    return runAppEnvironmentOwnerHelper({
      projectRoot: options.projectRoot,
      appEnvPath: options.appEnvPath,
      action: "read",
      includeRuntime,
    });
  }
  return Object.freeze({
    ...readInternalProxySecretsFromEnv(options.appEnvPath),
    ...(includeRuntime
      ? {
          port: readInternalPort(options.appEnvPath),
          webInstances: readWebInstanceCount(options.appEnvPath),
        }
      : {}),
  });
}

function writeAppSecretPair(options, current, previous) {
  if (options.requireRoot) {
    runAppEnvironmentOwnerHelper({
      projectRoot: options.projectRoot,
      appEnvPath: options.appEnvPath,
      action: "write",
      current,
      previous,
    });
    return;
  }
  writeAtomicFile(
    options.appEnvPath,
    renderAppSecrets(options.appEnvPath, current, previous),
    0o600,
    options,
    "app-env",
  );
}

function appSecretsMatch(options, current, previous) {
  try {
    const actual = readAppEnvironment(options);
    return (
      secretsMatch(actual.current, current) &&
      (previous
        ? Boolean(actual.previous) && secretsMatch(actual.previous, previous)
        : actual.previous === undefined)
    );
  } catch {
    return false;
  }
}

function assertSteadyProxySecret(options, contract, terminalCode) {
  const app = readAppEnvironment(options);
  const live = parseNginxSecret(contract.secretPath, options);
  if (app.previous || !secretsMatch(app.current, live.secret)) {
    throw installerError(terminalCode);
  }
}

function readStrictIntegerEnv(
  file,
  key,
  { defaultValue, minimum, maximum, errorCode },
) {
  const definition = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "u");
  const matches = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter((line) => definition.test(line));
  if (matches.length > 1) throw installerError(errorCode);
  if (matches.length === 0) return defaultValue;
  const valueMatch =
    /^\s*(?:export\s+)?[A-Z_]+\s*=\s*(?:([0-9]+)|"([0-9]+)"|'([0-9]+)')\s*(?:#.*)?$/u.exec(
      matches[0],
    );
  const value = Number(
    valueMatch?.[1] ?? valueMatch?.[2] ?? valueMatch?.[3] ?? Number.NaN,
  );
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw installerError(errorCode);
  }
  return value;
}

function readWebInstanceCount(file) {
  return readStrictIntegerEnv(file, "WEB_INSTANCES", {
    defaultValue: 2,
    minimum: 1,
    maximum: 16,
    errorCode: "NGINX_ROTATION_WEB_INSTANCES_INVALID",
  });
}

function readInternalPort(file) {
  return readStrictIntegerEnv(file, "PORT", {
    defaultValue: 3000,
    minimum: 1,
    maximum: 65_535,
    errorCode: "NGINX_ROTATION_PORT_INVALID",
  });
}

function probeOrigin(options, secrets) {
  const app = readAppEnvironment(options, true);
  const workers = app.webInstances;
  const result = options.operations.originProbe({
    port: app.port,
    workers,
    secrets,
  });
  if (
    !result ||
    !Array.isArray(result.results) ||
    result.results.length !== secrets.length ||
    result.results.some(
      (statuses) =>
        !Array.isArray(statuses) ||
        statuses.length !== workers ||
        statuses.some((status) => !Number.isInteger(status)),
    )
  ) {
    throw installerError("NGINX_ROTATION_ORIGIN_PROBE_INVALID");
  }
  return result.results;
}

function assertOriginPolicy(options, accepted, rejected = []) {
  const statuses = probeOrigin(options, [...accepted, ...rejected]);
  const expected = [...accepted.map(() => 200), ...rejected.map(() => 403)];
  if (
    statuses.some((workerStatuses, index) =>
      workerStatuses.some((status) => status !== expected[index]),
    )
  ) {
    throw installerError("NGINX_ROTATION_ORIGIN_POLICY_MISMATCH");
  }
}

function writeLiveNginxSecret(contract, options, secret) {
  writeAtomicFile(
    contract.secretPath,
    renderNginxSecret(secret),
    0o600,
    options,
    "nginx-secret",
  );
}

function rotationOptions(input) {
  const options = normalizeOptions(input);
  assertRotationRoot(options);
  ensureBackupRoot(options.backupRoot, options);
  const contract = resolveNginxContract(options);
  verifyReleaseInputs(contract, options);
  if (options.requireRoot) readAppEnvironment(options);
  else assertPlainFile(options.appEnvPath, "NGINX_ROTATION_APP_ENV_INVALID");
  parseNginxSecret(contract.secretPath, options);
  return Object.freeze({ options, contract });
}

function parseNginxSecret(file, options) {
  const stat = assertPlainFile(file, "NGINX_INSTALL_SECRET_MISSING");
  if (options.strictMode && (stat.mode & 0o777) !== 0o600) {
    throw installerError("NGINX_INSTALL_SECRET_MODE_INVALID");
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    throw installerError("NGINX_INSTALL_SECRET_OWNER_INVALID");
  }
  const meaningfulLines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (meaningfulLines.length !== 1) {
    throw installerError("NGINX_INSTALL_SECRET_CONTENT_INVALID");
  }
  const match = /^set\s+\$alroya_proxy_secret\s+"([a-f0-9]{64})";$/iu.exec(
    meaningfulLines[0],
  );
  if (!match || !INTERNAL_PROXY_SECRET_PATTERN.test(match[1])) {
    throw installerError("NGINX_INSTALL_SECRET_CONTENT_INVALID");
  }
  return Object.freeze({ secret: match[1], stat });
}

function secretsMatch(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertManagedTargetShape(contract, options) {
  for (const directory of [
    contract.nginxRoot,
    ...["conf.d", "snippets", "sites-available", "sites-enabled"].map((name) =>
      path.join(contract.nginxRoot, name),
    ),
  ]) {
    const stat = assertPlainDirectory(
      directory,
      "NGINX_INSTALL_TARGET_DIRECTORY_INVALID",
    );
    if (options.strictMode && (stat.mode & 0o022) !== 0) {
      throw installerError("NGINX_INSTALL_TARGET_DIRECTORY_WRITABLE");
    }
    if (
      options.strictOwnership &&
      (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
    ) {
      throw installerError("NGINX_INSTALL_TARGET_DIRECTORY_OWNER_INVALID");
    }
  }
  for (const entry of contract.files) {
    const stat = lstatOrNull(entry.target);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw installerError("NGINX_INSTALL_TARGET_FILE_UNSAFE");
    }
  }
  for (const entry of contract.links) {
    const stat = lstatOrNull(entry.target);
    if (!stat) continue;
    if (!stat.isSymbolicLink()) {
      throw installerError("NGINX_INSTALL_TARGET_LINK_UNSAFE");
    }
  }
  const attestationStat = lstatOrNull(contract.secretAttestationPath);
  if (
    attestationStat &&
    (!attestationStat.isFile() || attestationStat.isSymbolicLink())
  ) {
    throw installerError("NGINX_INSTALL_ATTESTATION_TARGET_UNSAFE");
  }
  const topologyStat = lstatOrNull(contract.topologyAttestationPath);
  if (
    topologyStat &&
    (!topologyStat.isFile() || topologyStat.isSymbolicLink())
  ) {
    throw installerError("NGINX_INSTALL_ATTESTATION_TARGET_UNSAFE");
  }
}

function assertTlsDependencies(dependencies) {
  for (const dependency of dependencies) {
    let stat;
    try {
      stat = fs.statSync(dependency);
    } catch {
      throw installerError("NGINX_INSTALL_TLS_DEPENDENCY_MISSING");
    }
    if (!stat.isFile() || stat.size < 1) {
      throw installerError("NGINX_INSTALL_TLS_DEPENDENCY_INVALID");
    }
  }
}

function ensureBackupRoot(backupRoot, options) {
  if (!fs.existsSync(backupRoot)) {
    fs.mkdirSync(backupRoot, { mode: 0o700 });
    if (options.strictOwnership)
      fs.chownSync(backupRoot, options.expectedUid, options.expectedGid);
  }
  const stat = assertPlainDirectory(
    backupRoot,
    "NGINX_INSTALL_BACKUP_ROOT_INVALID",
  );
  if (options.strictMode && (stat.mode & 0o777) !== 0o700) {
    throw installerError("NGINX_INSTALL_BACKUP_ROOT_MODE_INVALID");
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    throw installerError("NGINX_INSTALL_BACKUP_ROOT_OWNER_INVALID");
  }
}

function captureTarget(target, backupDirectory, index) {
  const stat = lstatOrNull(target);
  if (!stat) return Object.freeze({ target, state: "missing" });
  if (stat.isSymbolicLink()) {
    return Object.freeze({
      target,
      state: "symlink",
      link: fs.readlinkSync(target),
      uid: stat.uid,
      gid: stat.gid,
    });
  }
  if (!stat.isFile())
    throw installerError("NGINX_INSTALL_BACKUP_TARGET_UNSAFE");
  const backupName = `entry-${index}.bin`;
  const backupFile = path.join(backupDirectory, backupName);
  fs.copyFileSync(target, backupFile, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupFile, 0o600);
  fsyncFile(backupFile);
  return Object.freeze({
    target,
    state: "file",
    backupName,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  });
}

function createBackup(contract, backupRoot, options) {
  const backupDirectory = path.join(
    backupRoot,
    `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`,
  );
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  if (options.strictOwnership) {
    fs.chownSync(backupDirectory, options.expectedUid, options.expectedGid);
  }
  const targets = backupTargets(contract);
  const entries = targets.map((target, index) =>
    captureTarget(target, backupDirectory, index),
  );
  const manifestPath = path.join(backupDirectory, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), entries }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  fsyncFile(manifestPath);
  fsyncDirectory(backupDirectory);
  fsyncDirectory(backupRoot);
  return Object.freeze({ backupDirectory, entries });
}

function backupTargets(contract) {
  return [
    ...contract.files.map((entry) => entry.target),
    ...contract.links.map((entry) => entry.target),
    contract.secretAttestationPath,
    contract.topologyAttestationPath,
  ];
}

function pendingJournalPath(backupRoot) {
  return path.join(backupRoot, "pending.json");
}

function assertOwnedMode(stat, mode, options, code) {
  if (options.strictMode && (stat.mode & 0o777) !== mode) {
    throw installerError(code);
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    throw installerError(code);
  }
}

function writePendingJournal(backup, backupRoot, options) {
  const target = pendingJournalPath(backupRoot);
  if (lstatOrNull(target)) {
    throw installerError("NGINX_INSTALL_PENDING_ALREADY_EXISTS");
  }
  const temporary = path.join(
    backupRoot,
    `.pending-stage-${randomUUID()}.json`,
  );
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 1,
        backupDirectory: backup.backupDirectory,
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    applyOwnerAndMode(temporary, 0o600, options);
    fsyncFile(temporary);
    fs.renameSync(temporary, target);
    fsyncDirectory(backupRoot);
  } finally {
    if (lstatOrNull(temporary)) fs.unlinkSync(temporary);
  }
}

function clearPendingJournal(backupRoot) {
  const target = pendingJournalPath(backupRoot);
  if (!lstatOrNull(target)) return;
  fs.unlinkSync(target);
  fsyncDirectory(backupRoot);
}

function readPendingBackup(contract, backupRoot, options) {
  const journalPath = pendingJournalPath(backupRoot);
  const journalStat = lstatOrNull(journalPath);
  if (!journalStat) return null;
  if (
    !journalStat.isFile() ||
    journalStat.isSymbolicLink() ||
    journalStat.size < 20 ||
    journalStat.size > 4096
  ) {
    throw installerError("NGINX_INSTALL_PENDING_INVALID");
  }
  assertOwnedMode(
    journalStat,
    0o600,
    options,
    "NGINX_INSTALL_PENDING_SECURITY_INVALID",
  );
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    throw installerError("NGINX_INSTALL_PENDING_INVALID");
  }
  const backupDirectory = path.resolve(journal?.backupDirectory ?? "");
  if (
    journal?.version !== 1 ||
    path.dirname(backupDirectory) !== backupRoot ||
    path.basename(backupDirectory).length < 20
  ) {
    throw installerError("NGINX_INSTALL_PENDING_INVALID");
  }
  const backupDirectoryStat = assertPlainDirectory(
    backupDirectory,
    "NGINX_INSTALL_PENDING_BACKUP_INVALID",
  );
  assertOwnedMode(
    backupDirectoryStat,
    0o700,
    options,
    "NGINX_INSTALL_PENDING_BACKUP_SECURITY_INVALID",
  );
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const manifestStat = assertPlainFile(
    manifestPath,
    "NGINX_INSTALL_PENDING_MANIFEST_INVALID",
  );
  if (manifestStat.size > 1024 * 1024) {
    throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
  }
  assertOwnedMode(
    manifestStat,
    0o600,
    options,
    "NGINX_INSTALL_PENDING_MANIFEST_SECURITY_INVALID",
  );
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
  }
  const expectedTargets = backupTargets(contract);
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== expectedTargets.length
  ) {
    throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
  }
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry?.target !== expectedTargets[index]) {
      throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
    }
    if (entry.state === "missing") continue;
    if (entry.state === "symlink") {
      if (
        typeof entry.link !== "string" ||
        entry.link.length < 1 ||
        entry.link.includes("\0") ||
        !Number.isInteger(entry.uid) ||
        !Number.isInteger(entry.gid)
      ) {
        throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
      }
      continue;
    }
    if (
      entry.state !== "file" ||
      entry.backupName !== `entry-${index}.bin` ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      !Number.isInteger(entry.uid) ||
      !Number.isInteger(entry.gid)
    ) {
      throw installerError("NGINX_INSTALL_PENDING_MANIFEST_INVALID");
    }
    const backupFile = path.join(backupDirectory, entry.backupName);
    const backupStat = lstatOrNull(backupFile);
    if (!backupStat?.isFile() || backupStat.isSymbolicLink()) {
      throw installerError("NGINX_INSTALL_PENDING_BACKUP_FILE_INVALID");
    }
    assertOwnedMode(
      backupStat,
      0o600,
      options,
      "NGINX_INSTALL_PENDING_BACKUP_FILE_SECURITY_INVALID",
    );
  }
  return Object.freeze({
    backupDirectory,
    entries: Object.freeze(manifest.entries),
  });
}

function applyOwnerAndMode(
  file,
  mode,
  options,
  uid = options.expectedUid,
  gid = options.expectedGid,
) {
  fs.chmodSync(file, mode);
  if (options.strictOwnership) fs.chownSync(file, uid, gid);
}

function hashBytes(content) {
  return createHash("sha256").update(content).digest("hex");
}

function releaseRelativePath(projectRoot, source) {
  return path.relative(projectRoot, source).split(path.sep).join("/");
}

function assertReleaseHash(content, relative, manifest) {
  if (!manifest) return;
  const expected = manifest.files[relative];
  const actual = hashBytes(content);
  if (!/^[a-f0-9]{64}$/u.test(expected) || !secretsMatch(actual, expected)) {
    throw installerError("NGINX_RELEASE_INPUT_HASH_MISMATCH");
  }
}

function stagedConfiguration(staged, proxySecretExample) {
  const byRelative = new Map(
    staged
      .filter((item) => item.kind === "file" && item.relativeSource)
      .map((item) => [
        item.relativeSource,
        fs.readFileSync(item.temporary, "utf8"),
      ]),
  );
  const read = (relative) => {
    const content = byRelative.get(relative);
    if (typeof content !== "string") {
      throw installerError("NGINX_INSTALL_STAGED_CONFIGURATION_INVALID");
    }
    return content;
  };
  return Object.freeze({
    zones: read("deploy/nginx-ratelimit.conf"),
    internalSite: read("deploy/nginx-erp.conf"),
    publicSite: read("deploy/nginx-public.conf"),
    realIp: read("deploy/nginx-cloudflare-realip.conf"),
    proxyCommon: read("deploy/nginx-proxy-common.conf"),
    proxySecretExample,
    appLocations: read("deploy/nginx-app-locations.conf"),
    configFiles: Object.fromEntries(
      [...byRelative.entries()].map(([relative, content]) => [
        path.basename(relative),
        content,
      ]),
    ),
  });
}

function stageContract(contract, options, secretAttestation, manifest) {
  const token = randomUUID();
  const staged = [];
  try {
    for (const entry of contract.files) {
      const relativeSource = releaseRelativePath(
        options.projectRoot,
        entry.source,
      );
      const temporary = path.join(
        path.dirname(entry.target),
        `.alroya-${path.basename(entry.target)}-stage-${token}`,
      );
      fs.copyFileSync(entry.source, temporary, fs.constants.COPYFILE_EXCL);
      applyOwnerAndMode(temporary, entry.mode, options);
      fsyncFile(temporary);
      assertReleaseHash(fs.readFileSync(temporary), relativeSource, manifest);
      staged.push(
        Object.freeze({
          kind: "file",
          temporary,
          target: entry.target,
          relativeSource,
        }),
      );
    }
    const attestationTemporary = path.join(
      path.dirname(contract.secretAttestationPath),
      `.alroya-${path.basename(contract.secretAttestationPath)}-stage-${token}`,
    );
    fs.writeFileSync(attestationTemporary, secretAttestation, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    applyOwnerAndMode(attestationTemporary, 0o644, options);
    fsyncFile(attestationTemporary);
    staged.push(
      Object.freeze({
        kind: "file",
        temporary: attestationTemporary,
        target: contract.secretAttestationPath,
      }),
    );
    for (const entry of contract.links) {
      const temporary = path.join(
        path.dirname(entry.target),
        `.alroya-${path.basename(entry.target)}-stage-${token}`,
      );
      fs.symlinkSync(entry.link, temporary);
      staged.push(
        Object.freeze({ kind: "link", temporary, target: entry.target }),
      );
    }
    for (const item of staged) fsyncDirectory(path.dirname(item.temporary));
    const exampleBuffer = fs.readFileSync(
      path.join(options.projectRoot, PROXY_SECRET_EXAMPLE_RELATIVE_PATH),
    );
    assertReleaseHash(
      exampleBuffer,
      PROXY_SECRET_EXAMPLE_RELATIVE_PATH,
      manifest,
    );
    options.operations.staticCheck(
      stagedConfiguration(staged, exampleBuffer.toString("utf8")),
    );
    return staged;
  } catch (error) {
    for (const item of staged) {
      if (lstatOrNull(item.temporary)) fs.unlinkSync(item.temporary);
    }
    throw installerError("NGINX_INSTALL_STAGING_FAILED", error);
  }
}

function removeStaged(staged) {
  for (const item of staged) {
    if (!lstatOrNull(item.temporary)) continue;
    fs.unlinkSync(item.temporary);
    fsyncDirectory(path.dirname(item.temporary));
  }
}

function installStaged(staged, operations) {
  for (const [index, item] of staged.entries()) {
    operations.rename(item.temporary, item.target, "install");
    fsyncDirectory(path.dirname(item.target));
    operations.afterInstallItem?.(item.target, index);
  }
}

function installGeneratedAttestation(target, payload, options, operations) {
  const temporary = path.join(
    path.dirname(target),
    `.alroya-${path.basename(target)}-stage-${randomUUID()}`,
  );
  try {
    fs.writeFileSync(temporary, payload, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    applyOwnerAndMode(temporary, 0o644, options);
    fsyncFile(temporary);
    operations.rename(temporary, target, "install");
    fsyncDirectory(path.dirname(target));
    operations.afterInstallItem?.(target, -1);
  } finally {
    if (lstatOrNull(temporary)) fs.unlinkSync(temporary);
  }
}

function restoreEntry(entry, backupDirectory, options, operations, token) {
  const parent = path.dirname(entry.target);
  if (entry.state === "missing") {
    if (lstatOrNull(entry.target)) fs.unlinkSync(entry.target);
    fsyncDirectory(parent);
    return;
  }
  const temporary = path.join(
    parent,
    `.alroya-${path.basename(entry.target)}-rollback-${token}`,
  );
  if (entry.state === "symlink") {
    fs.symlinkSync(entry.link, temporary);
    if (options.strictOwnership) {
      fs.lchownSync(temporary, entry.uid, entry.gid);
    }
  } else if (entry.state === "file") {
    fs.copyFileSync(
      path.join(backupDirectory, entry.backupName),
      temporary,
      fs.constants.COPYFILE_EXCL,
    );
    applyOwnerAndMode(temporary, entry.mode, options, entry.uid, entry.gid);
    fsyncFile(temporary);
  } else {
    throw installerError("NGINX_INSTALL_BACKUP_STATE_INVALID");
  }
  operations.rename(temporary, entry.target, "rollback");
  fsyncDirectory(parent);
}

function rollback(backup, options, operations) {
  const token = randomUUID();
  for (const entry of [...backup.entries].reverse()) {
    restoreEntry(entry, backup.backupDirectory, options, operations, token);
  }
  operations.nginxTest();
  operations.reload();
  operations.rollbackSmoke();
}

function recoverPendingInstall(contract, options) {
  const backup = readPendingBackup(contract, options.backupRoot, options);
  if (!backup) return false;
  try {
    rollback(backup, options, options.operations);
    clearPendingJournal(options.backupRoot);
    return true;
  } catch (error) {
    throw installerError("NGINX_INSTALL_PENDING_RECOVERY_FAILED", error);
  }
}

function defaultOperations(projectRoot) {
  const externalHealth = (script) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: projectRoot,
      stdio: "inherit",
      timeout: 60_000,
      env: runtimeEnvironment(),
    });
  return Object.freeze({
    staticCheck: (configuration) => {
      const errors = verifyNginxConfiguration(configuration);
      if (errors.length > 0) {
        throw installerError("NGINX_INSTALL_STATIC_CONTRACT_INVALID");
      }
    },
    renderedConfig: () =>
      String(
        execFileSync("/usr/sbin/nginx", ["-T"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        }),
      ),
    rename: (source, destination) => fs.renameSync(source, destination),
    nginxTest: () =>
      execFileSync("/usr/sbin/nginx", ["-t"], {
        stdio: "inherit",
        timeout: 30_000,
      }),
    reload: () =>
      execFileSync("/usr/bin/systemctl", ["reload", "nginx"], {
        stdio: "inherit",
        timeout: 30_000,
      }),
    smoke: () => externalHealth(NGINX_EXTERNAL_HEALTH_SCRIPT),
    rollbackSmoke: () => externalHealth(NGINX_ROLLBACK_HEALTH_SCRIPT),
    loggerRedactionGate: (policy) =>
      runLoggerRedactionGate(projectRoot, policy.secrets),
    originProbe: (policy) =>
      JSON.parse(
        String(
          execFileSync(
            process.execPath,
            ["--input-type=module", "-e", ORIGIN_SECRET_CANARY_SCRIPT],
            {
              cwd: projectRoot,
              input: JSON.stringify(policy),
              stdio: ["pipe", "pipe", "inherit"],
              encoding: "utf8",
              timeout: 30_000,
              env: runtimeEnvironment(),
            },
          ),
        ),
      ),
  });
}

function normalizeOptions(options) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const nginxRoot = path.resolve(options.nginxRoot ?? "/etc/nginx");
  const requireRoot = options.requireRoot ?? true;
  const backupRoot = path.resolve(
    options.backupRoot ?? "/var/backups/alroya-nginx",
  );
  const strictOwnership =
    options.strictOwnership ?? process.platform !== "win32";
  const strictMode = options.strictMode ?? process.platform !== "win32";
  const operations = options.operations ?? defaultOperations(projectRoot);
  if (typeof operations.rollbackSmoke !== "function") {
    throw installerError("NGINX_INSTALL_OPERATIONS_INVALID");
  }
  if (typeof operations.originProbe !== "function") {
    throw installerError("NGINX_INSTALL_OPERATIONS_INVALID");
  }
  if (typeof operations.loggerRedactionGate !== "function") {
    throw installerError("NGINX_INSTALL_OPERATIONS_INVALID");
  }
  return Object.freeze({
    projectRoot,
    nginxRoot,
    appEnvPath: path.resolve(
      options.appEnvPath ?? path.join(projectRoot, ".env"),
    ),
    backupRoot,
    rotationDirectory: path.resolve(
      options.rotationDirectory ??
        (requireRoot
          ? "/var/lib/alroya-nginx/rotation-active"
          : path.join(backupRoot, "proxy-secret-rotation-active")),
    ),
    tlsDependencies: options.tlsDependencies ?? NGINX_TLS_DEPENDENCIES,
    managedFiles: options.managedFiles,
    managedLinks: options.managedLinks,
    strictOwnership,
    strictMode,
    expectedUid: options.expectedUid ?? 0,
    expectedGid: options.expectedGid ?? 0,
    requireRoot,
    requireReleaseManifest:
      options.requireReleaseManifest ?? options.requireRoot ?? true,
    releaseManifestPath: path.resolve(
      options.releaseManifestPath ?? INSTALLED_RELEASE_MANIFEST_PATH,
    ),
    faultInjection: options.faultInjection === true,
    generateSecret:
      options.generateSecret ?? (() => randomBytes(32).toString("hex")),
    afterRotationMutation: options.afterRotationMutation,
    operations,
  });
}

export function installNginxContract(input = {}) {
  const options = normalizeOptions(input);
  if (
    options.requireRoot &&
    (process.platform !== "linux" ||
      typeof process.getuid !== "function" ||
      process.getuid() !== 0)
  ) {
    throw installerError("NGINX_INSTALL_ROOT_REQUIRED");
  }
  const contract = resolveNginxContract(options);
  const releaseManifest = verifyReleaseInputs(contract, options);
  if (lstatOrNull(options.backupRoot)) {
    ensureBackupRoot(options.backupRoot, options);
    recoverPendingInstall(contract, options);
  }
  assertManagedTargetShape(contract, options);
  assertTlsDependencies(options.tlsDependencies);
  const nginxSecret = parseNginxSecret(contract.secretPath, options);
  let appSecret;
  try {
    appSecret = readAppEnvironment(options).current;
  } catch (error) {
    throw installerError("NGINX_INSTALL_APP_SECRET_INVALID", error);
  }
  if (!secretsMatch(nginxSecret.secret, appSecret)) {
    throw installerError("NGINX_INSTALL_SECRET_MISMATCH");
  }
  const secretAttestation = createSecretAttestation(
    nginxSecret.secret,
    nginxSecret.stat,
  );
  ensureBackupRoot(options.backupRoot, options);

  let backup;
  let staged = [];
  try {
    backup = createBackup(contract, options.backupRoot, options);
    staged = stageContract(
      contract,
      options,
      secretAttestation,
      releaseManifest,
    );
    writePendingJournal(backup, options.backupRoot, options);
    installStaged(staged, options.operations);
    const topologyAttestation = createNginxTopologyAttestation(
      options.operations.renderedConfig(),
      { nginxRoot: contract.nginxRoot },
    );
    installGeneratedAttestation(
      contract.topologyAttestationPath,
      topologyAttestation,
      options,
      options.operations,
    );
    options.operations.nginxTest();
    options.operations.reload();
    verifyLiveNginxContract(
      liveContractOptions(options, contract, releaseManifest),
    );
    options.operations.smoke();
    clearPendingJournal(options.backupRoot);
    return Object.freeze({ backupDirectory: backup.backupDirectory });
  } catch (error) {
    if (
      options.faultInjection &&
      error?.code === "NGINX_INSTALL_SIMULATED_POWER_LOSS"
    ) {
      throw error;
    }
    removeStaged(staged);
    if (!backup) throw error;
    try {
      rollback(backup, options, options.operations);
      clearPendingJournal(options.backupRoot);
    } catch (rollbackError) {
      throw installerError(
        "NGINX_INSTALL_FAILED_ROLLBACK_FAILED",
        new AggregateError([error, rollbackError]),
      );
    }
    throw installerError("NGINX_INSTALL_FAILED_ROLLBACK_OK", error);
  }
}

export function prepareProxySecretRotation(input = {}) {
  const { options, contract } = rotationOptions(input);
  let record = readRotationJournal(options);
  const appBeforePrepare = readAppEnvironment(options);
  options.operations.loggerRedactionGate({
    secrets: [appBeforePrepare.current, appBeforePrepare.previous].filter(
      Boolean,
    ),
  });
  if (record) {
    if (!["preparing", "prepared"].includes(record.state)) {
      throw installerError("NGINX_ROTATION_ALREADY_ACTIVE");
    }
  } else {
    const baseline = readAppEnvironment(options);
    const live = parseNginxSecret(contract.secretPath, options);
    if (baseline.previous || !secretsMatch(baseline.current, live.secret)) {
      throw installerError("NGINX_ROTATION_BASELINE_INVALID");
    }
    record = prepareRotationMaterial(options, baseline.current);
  }
  if (record.state === "preparing") {
    const live = parseNginxSecret(contract.secretPath, options);
    record = prepareRotationMaterial(options, live.secret);
  }
  const secrets = rotationSecrets(options);
  writeAppSecretPair(options, secrets.old, secrets.next);
  options.afterRotationMutation?.("prepare-env");
  return Object.freeze({ state: "prepared" });
}

export function switchProxySecretRotation(input = {}) {
  const { options, contract } = rotationOptions(input);
  let record = readRotationJournal(options);
  if (!record || !["prepared", "switching"].includes(record.state)) {
    throw installerError("NGINX_ROTATION_SWITCH_STATE_INVALID");
  }
  const secrets = rotationSecrets(options);
  options.operations.loggerRedactionGate({
    secrets: [secrets.old, secrets.next],
  });
  assertOriginPolicy(options, [secrets.old, secrets.next]);
  record = setRotationState(record, "switching", options);
  writeAppSecretPair(options, secrets.next, secrets.old);
  options.afterRotationMutation?.("switch-env");
  writeLiveNginxSecret(contract, options, secrets.next);
  options.afterRotationMutation?.("switch-nginx");
  try {
    installNginxContract(options);
  } catch (error) {
    try {
      writeLiveNginxSecret(contract, options, secrets.old);
      writeAppSecretPair(options, secrets.old, secrets.next);
      installNginxContract(options);
      setRotationState(record, "prepared", options);
    } catch (rollbackError) {
      throw installerError(
        "NGINX_ROTATION_SWITCH_FAILED_ROLLBACK_FAILED",
        new AggregateError([error, rollbackError]),
      );
    }
    throw installerError("NGINX_ROTATION_SWITCH_FAILED_ROLLBACK_OK", error);
  }
  setRotationState(record, "switched", options);
  return Object.freeze({ state: "switched" });
}

export function retireProxySecretRotation(input = {}) {
  const { options, contract } = rotationOptions(input);
  let record = readRotationJournal(options);
  if (!record) {
    assertSteadyProxySecret(
      options,
      contract,
      "NGINX_ROTATION_RETIRE_TERMINAL_INVALID",
    );
    return Object.freeze({ state: "retired" });
  }
  if (record?.state === "cleanup-retired") {
    removeRotationMaterial(record, "cleanup-retired", options);
    return Object.freeze({ state: "retired" });
  }
  if (!record || !["switched", "retiring"].includes(record.state)) {
    throw installerError("NGINX_ROTATION_RETIRE_STATE_INVALID");
  }
  const secrets = rotationSecrets(options);
  options.operations.loggerRedactionGate({
    secrets: [secrets.next, secrets.old],
  });
  if (record.state === "switched") {
    record = setRotationState(record, "retiring", options);
    options.afterRotationMutation?.("retire-journal");
    writeAppSecretPair(options, secrets.next);
    options.afterRotationMutation?.("retire-env");
    return Object.freeze({ state: "retiring" });
  }
  if (!appSecretsMatch(options, secrets.next)) {
    writeAppSecretPair(options, secrets.next);
    options.afterRotationMutation?.("retire-env");
    return Object.freeze({ state: "retiring" });
  }
  const [nextStatuses, oldStatuses] = probeOrigin(options, [
    secrets.next,
    secrets.old,
  ]);
  const nextAccepted = nextStatuses.every((status) => status === 200);
  const oldAccepted = oldStatuses.every((status) => status === 200);
  const oldRejected = oldStatuses.every((status) => status === 403);
  if (nextAccepted && oldAccepted) {
    return Object.freeze({ state: "retiring" });
  }
  if (!nextAccepted || !oldRejected) {
    throw installerError("NGINX_ROTATION_ORIGIN_POLICY_MISMATCH");
  }
  installNginxContract(options);
  removeRotationMaterial(record, "cleanup-retired", options);
  return Object.freeze({ state: "retired" });
}

export function rollbackProxySecretRotation(input = {}) {
  const { options, contract } = rotationOptions(input);
  let record = readRotationJournal(options);
  if (!record) {
    assertSteadyProxySecret(
      options,
      contract,
      "NGINX_ROTATION_ROLLBACK_TERMINAL_INVALID",
    );
    return Object.freeze({ state: "rolled-back" });
  }
  if (record.state === "cleanup-rolled-back") {
    removeRotationMaterial(record, "cleanup-rolled-back", options);
    return Object.freeze({ state: "rolled-back" });
  }
  const secrets = rotationSecrets(options);
  options.operations.loggerRedactionGate({
    secrets: [secrets.old, secrets.next],
  });
  if (record.state === "rolling-back") {
    assertOriginPolicy(options, [secrets.old], [secrets.next]);
    removeRotationMaterial(record, "cleanup-rolled-back", options);
    return Object.freeze({ state: "rolled-back" });
  }
  if (record.state === "rollback-primed") {
    const live = parseNginxSecret(contract.secretPath, options);
    const desiredCurrent = secretsMatch(live.secret, secrets.old)
      ? secrets.old
      : secretsMatch(live.secret, secrets.next)
        ? secrets.next
        : null;
    const desiredPrevious = secretsMatch(live.secret, secrets.old)
      ? secrets.next
      : secrets.old;
    if (
      !desiredCurrent ||
      !appSecretsMatch(options, desiredCurrent, desiredPrevious)
    ) {
      if (!desiredCurrent) {
        throw installerError("NGINX_ROTATION_LIVE_SECRET_INVALID");
      }
      writeAppSecretPair(options, desiredCurrent, desiredPrevious);
      options.afterRotationMutation?.("rollback-prime-env");
      installNginxContract(options);
      return Object.freeze({ state: "rollback-primed" });
    }
    assertOriginPolicy(options, [secrets.old, secrets.next]);
    writeLiveNginxSecret(contract, options, secrets.old);
    options.afterRotationMutation?.("rollback-nginx");
    writeAppSecretPair(options, secrets.old);
    options.afterRotationMutation?.("rollback-env");
    installNginxContract(options);
    setRotationState(record, "rolling-back", options);
    return Object.freeze({ state: "rolling-back" });
  }
  const live = parseNginxSecret(contract.secretPath, options);
  if (
    !secretsMatch(live.secret, secrets.old) &&
    !secretsMatch(live.secret, secrets.next)
  ) {
    throw installerError("NGINX_ROTATION_LIVE_SECRET_INVALID");
  }
  setRotationState(record, "rollback-primed", options);
  options.afterRotationMutation?.("rollback-journal");
  writeAppSecretPair(
    options,
    secretsMatch(live.secret, secrets.old) ? secrets.old : secrets.next,
    secretsMatch(live.secret, secrets.old) ? secrets.next : secrets.old,
  );
  options.afterRotationMutation?.("rollback-prime-env");
  installNginxContract(options);
  return Object.freeze({ state: "rollback-primed" });
}

function main() {
  const underFlock = process.argv[2] === "--under-flock";
  const action = (underFlock ? process.argv[3] : process.argv[2]) ?? "install";
  if (
    (underFlock && process.argv.length !== 4) ||
    (!underFlock && process.argv.length > 3)
  ) {
    throw installerError("NGINX_INSTALL_ARGUMENTS_INVALID");
  }
  const actions = {
    install: installNginxContract,
    prepare: prepareProxySecretRotation,
    switch: switchProxySecretRotation,
    retire: retireProxySecretRotation,
    rollback: rollbackProxySecretRotation,
  };
  const operation = actions[action];
  if (!operation) throw installerError("NGINX_INSTALL_ARGUMENTS_INVALID");
  if (
    process.platform === "linux" &&
    typeof process.getuid === "function" &&
    process.getuid() === 0 &&
    path.resolve(SCRIPT_PATH) !== INSTALLED_SCRIPT_PATH
  ) {
    throw installerError("NGINX_INSTALL_UNTRUSTED_EXECUTABLE");
  }
  if (
    path.resolve(SCRIPT_PATH) === INSTALLED_SCRIPT_PATH &&
    fs.realpathSync(process.execPath) !== fs.realpathSync(TRUSTED_NODE_PATH)
  ) {
    throw installerError("NGINX_INSTALL_UNTRUSTED_RUNTIME");
  }
  const input =
    path.resolve(SCRIPT_PATH) === INSTALLED_SCRIPT_PATH
      ? { projectRoot: PRODUCTION_PROJECT_ROOT }
      : {};
  if (
    underFlock &&
    (path.resolve(SCRIPT_PATH) !== INSTALLED_SCRIPT_PATH ||
      !isFlockParent(action))
  ) {
    throw installerError("NGINX_OPERATION_LOCK_PARENT_INVALID");
  }
  if (path.resolve(SCRIPT_PATH) === INSTALLED_SCRIPT_PATH && !underFlock) {
    runMainUnderFlock(action);
    return;
  }
  const result = operation(input);
  console.log(`nginx contract ${action}: OK`);
  if (result.backupDirectory) {
    console.log(`recoverable backup: ${result.backupDirectory}`);
  } else {
    console.log(`rotation state: ${result.state}`);
  }
}

function verifyReleaseInputs(contract, options) {
  if (!options.requireReleaseManifest) return null;
  const stat = assertPlainFile(
    options.releaseManifestPath,
    "NGINX_RELEASE_MANIFEST_INVALID",
  );
  assertOwnedMode(
    stat,
    0o444,
    options,
    "NGINX_RELEASE_MANIFEST_SECURITY_INVALID",
  );
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(options.releaseManifestPath, "utf8"));
  } catch {
    throw installerError("NGINX_RELEASE_MANIFEST_INVALID");
  }
  const expectedKeys = [
    ...contract.files.map((entry) =>
      releaseRelativePath(options.projectRoot, entry.source),
    ),
    PROXY_SECRET_EXAMPLE_RELATIVE_PATH,
  ].sort();
  if (
    manifest?.version !== 1 ||
    !manifest.files ||
    Array.isArray(manifest.files) ||
    JSON.stringify(Object.keys(manifest.files).sort()) !==
      JSON.stringify(expectedKeys)
  ) {
    throw installerError("NGINX_RELEASE_MANIFEST_INVALID");
  }
  for (const relative of expectedKeys) {
    if (!/^[a-f0-9]{64}$/u.test(manifest.files[relative])) {
      throw installerError("NGINX_RELEASE_INPUT_HASH_MISMATCH");
    }
  }
  return Object.freeze(manifest);
}

function liveContractOptions(options, contract, releaseManifest) {
  if (!releaseManifest) return options;
  return {
    ...options,
    expectedFileHashes: Object.fromEntries(
      contract.files.map((entry) => [
        entry.target,
        releaseManifest.files[
          releaseRelativePath(options.projectRoot, entry.source)
        ],
      ]),
    ),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    const code = error?.code ?? error?.message ?? "NGINX_INSTALL_FAILED";
    console.error(`nginx contract install: FAILED: ${code}`);
    if (code === "NGINX_INSTALL_FAILED_ROLLBACK_OK") {
      console.error("previous nginx contract restored and reloaded");
    }
    if (code === "NGINX_INSTALL_FAILED_ROLLBACK_FAILED") {
      console.error(
        "rollback failed; use the retained backup and stop deployment",
      );
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
    if (Number.isInteger(error?.exitStatus)) {
      process.exitCode = error.exitStatus;
    }
  }
}
