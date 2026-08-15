#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const NGINX_MANAGED_FILES = Object.freeze(
  [
    ["deploy/nginx-ratelimit.conf", "conf.d/alroya-ratelimit-zones.conf"],
    [
      "deploy/nginx-cloudflare-realip.conf",
      "snippets/alroya-cloudflare-realip.conf",
    ],
    ["deploy/nginx-proxy-common.conf", "snippets/alroya-proxy-common.conf"],
    ["deploy/nginx-app-locations.conf", "snippets/alroya-app-locations.conf"],
    ["deploy/nginx-erp.conf", "sites-available/alroya-erp"],
    ["deploy/nginx-public.conf", "sites-available/alroya-public"],
  ].map(([source, target]) => Object.freeze({ source, target, mode: 0o644 })),
);

export const NGINX_MANAGED_LINKS = Object.freeze([
  Object.freeze({
    target: "sites-enabled/alroya-erp",
    link: "../sites-available/alroya-erp",
  }),
  Object.freeze({
    target: "sites-enabled/alroya-public",
    link: "../sites-available/alroya-public",
  }),
]);

export const NGINX_SECRET_RELATIVE_PATH = "snippets/alroya-proxy-secret.conf";
export const NGINX_SECRET_ATTESTATION_RELATIVE_PATH =
  "snippets/alroya-proxy-secret.attestation.json";
export const NGINX_TOPOLOGY_ATTESTATION_RELATIVE_PATH =
  "snippets/alroya-topology.attestation.json";
export const INTERNAL_PROXY_SECRET_PATTERN = /^[a-f0-9]{64}$/iu;

export const NGINX_TLS_DEPENDENCIES = Object.freeze([
  "/etc/letsencrypt/options-ssl-nginx.conf",
  "/etc/letsencrypt/ssl-dhparams.pem",
  "/etc/letsencrypt/live/srv1548487.hstgr.cloud/fullchain.pem",
  "/etc/letsencrypt/live/srv1548487.hstgr.cloud/privkey.pem",
  "/etc/letsencrypt/live/alarabiya.online/fullchain.pem",
  "/etc/letsencrypt/live/alarabiya.online/privkey.pem",
]);

function contractError(code, details = []) {
  const error = new Error(code);
  error.code = code;
  error.details = Object.freeze([...details]);
  return error;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fingerprintsMatch(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readInternalProxySecretFromEnv(file) {
  assertPlainFile(file, "NGINX_APP_ENV_INVALID");
  const matches = [];
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?INTERNAL_PROXY_SECRET\s*=\s*(.*)$/u.exec(
      line,
    );
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    matches.push(value);
  }
  if (matches.length !== 1 || !INTERNAL_PROXY_SECRET_PATTERN.test(matches[0])) {
    throw contractError("NGINX_APP_SECRET_INVALID");
  }
  return matches[0];
}

export function createSecretAttestation(secret, secretStat) {
  if (
    !INTERNAL_PROXY_SECRET_PATTERN.test(secret) ||
    !secretStat?.isFile() ||
    secretStat.isSymbolicLink()
  ) {
    throw contractError("NGINX_SECRET_ATTESTATION_INPUT_INVALID");
  }
  return `${JSON.stringify({
    version: 1,
    secretSha256: sha256(Buffer.from(secret, "utf8")),
    secretSize: secretStat.size,
    secretMtimeMs: secretStat.mtimeMs,
    secretCtimeMs: secretStat.ctimeMs,
    secretDevice: secretStat.dev,
    secretInode: secretStat.ino,
  })}\n`;
}

function readNginxProxySecret(file) {
  const meaningfulLines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (meaningfulLines.length !== 1) {
    throw contractError("NGINX_LIVE_SECRET_CONTENT_INVALID");
  }
  const match = /^set\s+\$alroya_proxy_secret\s+"([a-f0-9]{64})";$/iu.exec(
    meaningfulLines[0],
  );
  if (!match || !INTERNAL_PROXY_SECRET_PATTERN.test(match[1])) {
    throw contractError("NGINX_LIVE_SECRET_CONTENT_INVALID");
  }
  return match[1];
}

function renderedConfigurationFiles(rendered) {
  if (
    typeof rendered !== "string" ||
    rendered.length < 1 ||
    rendered.length > 16 * 1024 * 1024
  ) {
    throw contractError("NGINX_RENDERED_CONFIG_INVALID");
  }
  const files = [];
  for (const line of rendered.split(/\r?\n/u)) {
    const marker = /^# configuration file (.+):\s*$/u.exec(line.trim());
    if (!marker) continue;
    const file = path.resolve(marker[1]);
    if (!path.isAbsolute(marker[1]) || files.includes(file)) continue;
    files.push(file);
  }
  if (files.length < 1 || files.length > 512) {
    throw contractError("NGINX_RENDERED_CONFIG_FILES_INVALID");
  }
  return files;
}

export function verifyRenderedNginxTopology(rendered, options = {}) {
  const nginxRoot = path.resolve(options.nginxRoot ?? "/etc/nginx");
  const expectedFiles = new Map([
    [
      "srv1548487.hstgr.cloud",
      path.join(nginxRoot, "sites-enabled", "alroya-erp"),
    ],
    [
      "alarabiya.online",
      path.join(nginxRoot, "sites-enabled", "alroya-public"),
    ],
    [
      "www.alarabiya.online",
      path.join(nginxRoot, "sites-enabled", "alroya-public"),
    ],
  ]);
  const occurrences = new Map(
    [...expectedFiles.keys()].map((host) => [host, []]),
  );
  let currentFile = null;
  for (const rawLine of rendered.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const marker = /^# configuration file (.+):\s*$/u.exec(line);
    if (marker) {
      currentFile = path.resolve(marker[1]);
      continue;
    }
    const directive = /^server_name\s+([^;]+);/u.exec(
      line.replace(/#.*$/u, "").trim(),
    );
    if (!directive) continue;
    const tokens = directive[1].trim().toLowerCase().split(/\s+/u);
    const normalizedDirective = directive[1]
      .toLowerCase()
      .replaceAll("\\.", ".");
    for (const [host, expectedFile] of expectedFiles) {
      if (
        tokens.includes(host) ||
        (currentFile !== expectedFile && normalizedDirective.includes(host))
      ) {
        occurrences.get(host).push(currentFile);
      }
    }
  }
  for (const [host, expectedFile] of expectedFiles) {
    const found = occurrences.get(host);
    if (found.length !== 2 || found.some((file) => file !== expectedFile)) {
      throw contractError("NGINX_RENDERED_VHOST_CONFLICT", [host]);
    }
  }
  return Object.freeze({
    files: Object.freeze(renderedConfigurationFiles(rendered)),
  });
}

function topologyFileRecord(file, ignoredParent = null) {
  let lstat;
  let stat;
  let parent;
  try {
    lstat = fs.lstatSync(file);
    stat = fs.statSync(file);
    parent = fs.lstatSync(path.dirname(file));
  } catch {
    throw contractError("NGINX_TOPOLOGY_FILE_INVALID");
  }
  if ((!lstat.isFile() && !lstat.isSymbolicLink()) || !stat.isFile()) {
    throw contractError("NGINX_TOPOLOGY_FILE_INVALID");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw contractError("NGINX_TOPOLOGY_PARENT_INVALID");
  }
  return Object.freeze({
    path: file,
    type: lstat.isSymbolicLink() ? "symlink" : "file",
    link: lstat.isSymbolicLink() ? fs.readlinkSync(file) : null,
    mode: lstat.mode & 0o777,
    uid: lstat.uid,
    gid: lstat.gid,
    size: lstat.size,
    mtimeMs: lstat.mtimeMs,
    targetSize: stat.size,
    targetMtimeMs: stat.mtimeMs,
    parentMode: parent.mode & 0o777,
    parentUid: parent.uid,
    parentGid: parent.gid,
    parentMtimeMs:
      ignoredParent &&
      path.resolve(path.dirname(file)) === path.resolve(ignoredParent)
        ? null
        : parent.mtimeMs,
  });
}

export function createNginxTopologyAttestation(rendered, options = {}) {
  const topology = verifyRenderedNginxTopology(rendered, options);
  const ignoredParent = path.join(
    path.resolve(options.nginxRoot ?? "/etc/nginx"),
    "snippets",
  );
  const files = topology.files
    .map((file) => topologyFileRecord(file, ignoredParent))
    .sort((left, right) => left.path.localeCompare(right.path));
  return `${JSON.stringify({ version: 1, files })}\n`;
}

function assertPlainDirectory(directory, code) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw contractError(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw contractError(code);
  return stat;
}

function assertPlainFile(file, code) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw contractError(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw contractError(code);
  }
  return stat;
}

export function resolveNginxContract(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const nginxRoot = path.resolve(options.nginxRoot ?? "/etc/nginx");
  assertPlainDirectory(projectRoot, "NGINX_CONTRACT_PROJECT_ROOT_INVALID");
  assertPlainDirectory(nginxRoot, "NGINX_CONTRACT_ROOT_INVALID");

  const files = (options.managedFiles ?? NGINX_MANAGED_FILES).map((entry) => {
    const source = path.resolve(projectRoot, entry.source);
    const target = path.resolve(nginxRoot, entry.target);
    if (!source.startsWith(`${projectRoot}${path.sep}`)) {
      throw contractError("NGINX_CONTRACT_SOURCE_ESCAPE");
    }
    if (!target.startsWith(`${nginxRoot}${path.sep}`)) {
      throw contractError("NGINX_CONTRACT_TARGET_ESCAPE");
    }
    assertPlainFile(source, "NGINX_CONTRACT_SOURCE_INVALID");
    return Object.freeze({ ...entry, source, target });
  });
  const links = (options.managedLinks ?? NGINX_MANAGED_LINKS).map((entry) => {
    const target = path.resolve(nginxRoot, entry.target);
    const resolvedLink = path.resolve(path.dirname(target), entry.link);
    if (
      !target.startsWith(`${nginxRoot}${path.sep}`) ||
      !resolvedLink.startsWith(`${nginxRoot}${path.sep}`)
    ) {
      throw contractError("NGINX_CONTRACT_LINK_ESCAPE");
    }
    return Object.freeze({ ...entry, target, resolvedLink });
  });
  return Object.freeze({
    projectRoot,
    nginxRoot,
    files: Object.freeze(files),
    links: Object.freeze(links),
    secretPath: path.resolve(nginxRoot, NGINX_SECRET_RELATIVE_PATH),
    secretAttestationPath: path.resolve(
      nginxRoot,
      NGINX_SECRET_ATTESTATION_RELATIVE_PATH,
    ),
    topologyAttestationPath: path.resolve(
      nginxRoot,
      NGINX_TOPOLOGY_ATTESTATION_RELATIVE_PATH,
    ),
  });
}

function inspectSecretMetadata(secretPath, options, issues) {
  let stat;
  try {
    stat = fs.lstatSync(secretPath);
  } catch {
    issues.push("NGINX_LIVE_SECRET_MISSING");
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 40) {
    issues.push("NGINX_LIVE_SECRET_INVALID");
    return null;
  }
  if (options.strictMode !== false && (stat.mode & 0o777) !== 0o600) {
    issues.push("NGINX_LIVE_SECRET_MODE_INVALID");
  }
  if (
    options.strictOwnership !== false &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    issues.push("NGINX_LIVE_SECRET_OWNER_INVALID");
  }
  return stat;
}

function inspectSecretAttestation(contract, secretStat, options, issues) {
  let stat;
  try {
    stat = fs.lstatSync(contract.secretAttestationPath);
  } catch {
    issues.push("NGINX_LIVE_SECRET_ATTESTATION_MISSING");
    return;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 80 ||
    stat.size > 1024
  ) {
    issues.push("NGINX_LIVE_SECRET_ATTESTATION_INVALID");
    return;
  }
  if (options.strictMode && (stat.mode & 0o777) !== 0o644) {
    issues.push("NGINX_LIVE_SECRET_ATTESTATION_MODE_INVALID");
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    issues.push("NGINX_LIVE_SECRET_ATTESTATION_OWNER_INVALID");
  }
  let attestation;
  try {
    attestation = JSON.parse(
      fs.readFileSync(contract.secretAttestationPath, "utf8"),
    );
  } catch {
    issues.push("NGINX_LIVE_SECRET_ATTESTATION_INVALID");
    return;
  }
  if (
    attestation?.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(attestation?.secretSha256 ?? "") ||
    !Number.isFinite(attestation?.secretSize) ||
    !Number.isFinite(attestation?.secretMtimeMs) ||
    !Number.isFinite(attestation?.secretCtimeMs) ||
    !Number.isFinite(attestation?.secretDevice) ||
    !Number.isFinite(attestation?.secretInode) ||
    !secretStat ||
    attestation.secretSize !== secretStat.size ||
    attestation.secretMtimeMs !== secretStat.mtimeMs ||
    attestation.secretCtimeMs !== secretStat.ctimeMs ||
    attestation.secretDevice !== secretStat.dev ||
    attestation.secretInode !== secretStat.ino
  ) {
    issues.push("NGINX_LIVE_SECRET_ATTESTATION_STALE");
  }
  try {
    const liveSecret = readNginxProxySecret(contract.secretPath);
    if (
      !fingerprintsMatch(
        attestation?.secretSha256 ?? "",
        sha256(Buffer.from(liveSecret, "utf8")),
      )
    ) {
      issues.push("NGINX_LIVE_SECRET_CONTENT_MISMATCH");
    }
  } catch (error) {
    if (error?.code !== "EACCES" && error?.code !== "EPERM") {
      issues.push(error?.code ?? "NGINX_LIVE_SECRET_CONTENT_INVALID");
    }
  }
  let appSecret;
  try {
    appSecret = readInternalProxySecretFromEnv(options.appEnvPath);
  } catch {
    issues.push("NGINX_LIVE_APP_SECRET_INVALID");
    return;
  }
  const appFingerprint = sha256(Buffer.from(appSecret, "utf8"));
  if (!fingerprintsMatch(attestation?.secretSha256 ?? "", appFingerprint)) {
    issues.push("NGINX_LIVE_SECRET_MISMATCH");
  }
}

function inspectContractDirectories(contract, options, issues) {
  const directories = [
    contract.nginxRoot,
    ...["conf.d", "snippets", "sites-available", "sites-enabled"].map((name) =>
      path.join(contract.nginxRoot, name),
    ),
  ];
  for (const directory of directories) {
    let stat;
    try {
      stat = fs.lstatSync(directory);
    } catch {
      issues.push(`NGINX_LIVE_DIRECTORY_MISSING:${directory}`);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      issues.push(`NGINX_LIVE_DIRECTORY_TYPE_INVALID:${directory}`);
      continue;
    }
    if (options.strictMode && (stat.mode & 0o022) !== 0) {
      issues.push(`NGINX_LIVE_DIRECTORY_WRITABLE:${directory}`);
    }
    if (
      options.strictOwnership &&
      (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
    ) {
      issues.push(`NGINX_LIVE_DIRECTORY_OWNER_INVALID:${directory}`);
    }
  }
}

function inspectTopologyAttestation(contract, options, issues) {
  let stat;
  try {
    stat = fs.lstatSync(contract.topologyAttestationPath);
  } catch {
    issues.push("NGINX_LIVE_TOPOLOGY_ATTESTATION_MISSING");
    return;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 100 ||
    stat.size > 1024 * 1024
  ) {
    issues.push("NGINX_LIVE_TOPOLOGY_ATTESTATION_INVALID");
    return;
  }
  if (options.strictMode && (stat.mode & 0o777) !== 0o644) {
    issues.push("NGINX_LIVE_TOPOLOGY_ATTESTATION_MODE_INVALID");
  }
  if (
    options.strictOwnership &&
    (stat.uid !== options.expectedUid || stat.gid !== options.expectedGid)
  ) {
    issues.push("NGINX_LIVE_TOPOLOGY_ATTESTATION_OWNER_INVALID");
  }
  let attestation;
  try {
    attestation = JSON.parse(
      fs.readFileSync(contract.topologyAttestationPath, "utf8"),
    );
  } catch {
    issues.push("NGINX_LIVE_TOPOLOGY_ATTESTATION_INVALID");
    return;
  }
  if (
    attestation?.version !== 1 ||
    !Array.isArray(attestation.files) ||
    attestation.files.length < 1 ||
    attestation.files.length > 512
  ) {
    issues.push("NGINX_LIVE_TOPOLOGY_ATTESTATION_INVALID");
    return;
  }
  for (const expected of attestation.files) {
    let actual;
    try {
      actual = topologyFileRecord(
        path.resolve(expected?.path ?? ""),
        path.dirname(contract.topologyAttestationPath),
      );
    } catch {
      issues.push("NGINX_LIVE_TOPOLOGY_DRIFT");
      return;
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      issues.push("NGINX_LIVE_TOPOLOGY_DRIFT");
      return;
    }
  }
}

export function verifyLiveNginxContract(options = {}) {
  const contract = resolveNginxContract(options);
  const normalized = {
    strictMode: options.strictMode ?? process.platform !== "win32",
    strictOwnership: options.strictOwnership ?? process.platform !== "win32",
    expectedUid: options.expectedUid ?? 0,
    expectedGid: options.expectedGid ?? 0,
    appEnvPath: path.resolve(
      options.appEnvPath ?? path.join(contract.projectRoot, ".env"),
    ),
  };
  const issues = [];
  inspectContractDirectories(contract, normalized, issues);

  for (const entry of contract.files) {
    let stat;
    try {
      stat = fs.lstatSync(entry.target);
    } catch {
      issues.push(`NGINX_LIVE_FILE_MISSING:${entry.target}`);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push(`NGINX_LIVE_FILE_TYPE_INVALID:${entry.target}`);
      continue;
    }
    if (normalized.strictMode && (stat.mode & 0o777) !== entry.mode) {
      issues.push(`NGINX_LIVE_FILE_MODE_INVALID:${entry.target}`);
    }
    if (
      normalized.strictOwnership &&
      (stat.uid !== normalized.expectedUid ||
        stat.gid !== normalized.expectedGid)
    ) {
      issues.push(`NGINX_LIVE_FILE_OWNER_INVALID:${entry.target}`);
    }
    const expectedHash = sha256(fs.readFileSync(entry.source));
    const actualHash = sha256(fs.readFileSync(entry.target));
    if (expectedHash !== actualHash) {
      issues.push(`NGINX_LIVE_FILE_DRIFT:${entry.target}`);
    }
  }

  for (const entry of contract.links) {
    let stat;
    try {
      stat = fs.lstatSync(entry.target);
    } catch {
      issues.push(`NGINX_LIVE_LINK_MISSING:${entry.target}`);
      continue;
    }
    if (!stat.isSymbolicLink()) {
      issues.push(`NGINX_LIVE_LINK_TYPE_INVALID:${entry.target}`);
      continue;
    }
    const rawLink = fs.readlinkSync(entry.target);
    const resolved = path.resolve(path.dirname(entry.target), rawLink);
    if (resolved !== entry.resolvedLink) {
      issues.push(`NGINX_LIVE_LINK_DRIFT:${entry.target}`);
    }
  }

  const secretStat = inspectSecretMetadata(
    contract.secretPath,
    normalized,
    issues,
  );
  inspectSecretAttestation(contract, secretStat, normalized, issues);
  inspectTopologyAttestation(contract, normalized, issues);
  if (issues.length > 0)
    throw contractError("NGINX_LIVE_CONTRACT_DRIFT", issues);
  return Object.freeze({
    files: contract.files.length,
    links: contract.links.length,
  });
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--live") {
    throw contractError("NGINX_CONTRACT_ARGUMENTS_INVALID");
  }
  const result = verifyLiveNginxContract();
  console.log(
    `nginx live contract: OK files=${result.files} links=${result.links}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    const code = error?.code ?? error?.message ?? "NGINX_LIVE_CONTRACT_FAILED";
    console.error(`nginx live contract: FAILED: ${code}`);
    for (const issue of error?.details ?? []) console.error(`- ${issue}`);
    console.error(
      'repair: sudo "$(command -v node)" scripts/install-nginx-contract.mjs',
    );
    process.exitCode = 1;
  }
}
