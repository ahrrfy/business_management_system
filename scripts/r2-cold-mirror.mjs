#!/usr/bin/env node
/**
 * مرآة R2 باردة تراكمية: copy + manifest + verify فقط. لا يوجد مسار حذف أو sync.
 * لا يطبع account/bucket/key/path أو تفاصيل SDK.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export const MIRROR_MANIFEST_FORMAT = "alroya-r2-cold-mirror/v1";
export const MIRROR_CONFIRMATION = "RUN_CUMULATIVE_PRIVATE_R2_MIRROR";
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024;

export class R2ColdMirrorError extends Error {
  constructor(code, cause) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "R2ColdMirrorError";
    this.code = code;
  }
}

function assertSafeKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(key) ||
      key.includes("..") || key.includes("//")) {
    throw new R2ColdMirrorError("MIRROR_KEY_INVALID");
  }
}

export function resolveMirrorObjectPath(root, key) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new R2ColdMirrorError("MIRROR_DIR_INVALID");
  assertSafeKey(key);
  const objectRoot = resolve(root, "objects");
  const destination = resolve(objectRoot, ...key.split("/"));
  if (destination !== objectRoot && !destination.startsWith(`${objectRoot}${sep}`)) {
    throw new R2ColdMirrorError("MIRROR_KEY_INVALID");
  }
  return destination;
}

function validEntry(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
    typeof value.sourcePresent === "boolean" &&
    typeof value.lastSeenAt === "string" && typeof value.verifiedAt === "string";
}

export function mergeCumulativeMirrorEntries(previous, verified, nowIso) {
  if (!previous || typeof previous !== "object" || Array.isArray(previous) || !Array.isArray(verified)) {
    throw new R2ColdMirrorError("MIRROR_MANIFEST_INVALID");
  }
  const next = {};
  for (const [key, entry] of Object.entries(previous)) {
    assertSafeKey(key);
    if (!validEntry(entry)) throw new R2ColdMirrorError("MIRROR_MANIFEST_INVALID");
    next[key] = { ...entry, sourcePresent: false };
  }
  for (const item of verified) {
    assertSafeKey(item?.key);
    if (!/^[0-9a-f]{64}$/.test(item?.sha256) || !Number.isSafeInteger(item?.bytes) || item.bytes <= 0) {
      throw new R2ColdMirrorError("MIRROR_VERIFICATION_INVALID");
    }
    next[item.key] = {
      sha256: item.sha256,
      bytes: item.bytes,
      sourcePresent: true,
      lastSeenAt: nowIso,
      verifiedAt: nowIso,
    };
  }
  return next;
}

export function assertMirrorManifestCoversSource(entries, verified) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Array.isArray(verified)) {
    throw new R2ColdMirrorError("MIRROR_MANIFEST_INVALID");
  }
  for (const item of verified) {
    const entry = entries[item?.key];
    if (!validEntry(entry) || entry.sourcePresent !== true || entry.sha256 !== item.sha256 || entry.bytes !== item.bytes) {
      throw new R2ColdMirrorError("MIRROR_MANIFEST_STALE");
    }
  }
}

export function safeMirrorFailureCode(error) {
  return error instanceof R2ColdMirrorError || /^MIRROR_[A-Z0-9_]+$/.test(error?.code)
    ? error.code
    : "MIRROR_UNEXPECTED_FAILURE";
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new R2ColdMirrorError(`MIRROR_${name}_REQUIRED`);
  return value;
}

function expectedHashForKey(key) {
  const match = /\/([0-9a-f]{64})\.[a-z0-9]{2,5}$/i.exec(key);
  if (!match) throw new R2ColdMirrorError("MIRROR_CONTENT_ADDRESS_REQUIRED");
  return match[1].toLowerCase();
}

async function assertNoSymlinkPath(root, destination) {
  const objectRoot = resolve(root, "objects");
  const rel = relative(objectRoot, destination);
  let current = objectRoot;
  for (const segment of rel.split(/[\\/]/).slice(0, -1)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new R2ColdMirrorError("MIRROR_SYMLINK_FORBIDDEN");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { recursive: false, mode: 0o700 });
    }
  }
}

async function sha256File(path, maximumBytes = MAX_OBJECT_BYTES) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > maximumBytes) {
    throw new R2ColdMirrorError("MIRROR_LOCAL_OBJECT_INVALID");
  }
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of handle.createReadStream()) {
      total += chunk.length;
      if (total > maximumBytes) throw new R2ColdMirrorError("MIRROR_LOCAL_OBJECT_INVALID");
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes: total };
}

export async function verifyCumulativeMirrorFiles(root, entries) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new R2ColdMirrorError("MIRROR_MANIFEST_INVALID");
  }
  let verified = 0;
  for (const [key, entry] of Object.entries(entries)) {
    assertSafeKey(key);
    if (!validEntry(entry)) throw new R2ColdMirrorError("MIRROR_MANIFEST_INVALID");
    let actual;
    try {
      actual = await sha256File(resolveMirrorObjectPath(root, key));
    } catch (error) {
      if (error?.code === "ENOENT") throw new R2ColdMirrorError("MIRROR_LOCAL_OBJECT_MISSING");
      throw error;
    }
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new R2ColdMirrorError("MIRROR_LOCAL_HASH_MISMATCH");
    }
    verified += 1;
  }
  return verified;
}

function toNodeStream(body) {
  if (body instanceof Readable) return body;
  if (body && typeof body.transformToWebStream === "function") return Readable.fromWeb(body.transformToWebStream());
  if (body && typeof body.getReader === "function") return Readable.fromWeb(body);
  throw new R2ColdMirrorError("MIRROR_GET_BODY_INVALID");
}

async function copyObject(client, commands, bucket, key, destination, expectedBytes) {
  const temp = `${destination}.partial-${randomUUID()}`;
  try {
    const handle = await open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    let total = 0;
    try {
      const response = await client.send(new commands.GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new R2ColdMirrorError("MIRROR_GET_BODY_INVALID");
      for await (const chunk of toNodeStream(response.Body)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_OBJECT_BYTES) throw new R2ColdMirrorError("MIRROR_OBJECT_TOO_LARGE");
        await handle.write(bytes);
        hash.update(bytes);
      }
      await handle.sync();
    } catch (error) {
      throw error instanceof R2ColdMirrorError ? error : new R2ColdMirrorError("MIRROR_GET_FAILED", error);
    } finally {
      await handle.close();
    }
    if (total !== expectedBytes || total <= 0 || hash.digest("hex") !== expectedHashForKey(key)) {
      throw new R2ColdMirrorError("MIRROR_SOURCE_HASH_MISMATCH");
    }
    await copyFile(temp, destination, fsConstants.COPYFILE_EXCL);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function loadPreviousManifest(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) throw new R2ColdMirrorError("MIRROR_MANIFEST_INVALID");
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || value.format !== MIRROR_MANIFEST_FORMAT || !value.entries || typeof value.entries !== "object") {
      throw new R2ColdMirrorError("MIRROR_MANIFEST_INVALID");
    }
    return { value, digest: createHash("sha256").update(bytes).digest("hex"), exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { value: { format: MIRROR_MANIFEST_FORMAT, entries: {} }, digest: null, exists: false };
    }
    throw error instanceof R2ColdMirrorError ? error : new R2ColdMirrorError("MIRROR_MANIFEST_INVALID", error);
  }
}

async function writeManifest(root, value) {
  const path = resolve(root, "manifest.json");
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const temp = `${path}.partial-${randomUUID()}`;
  await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
  await writeFile(resolve(root, "manifest.sha256"), `${digest}  manifest.json\n`, { mode: 0o600 });
  return digest;
}

async function main() {
  if (process.env.R2_MIRROR_CONFIRM !== MIRROR_CONFIRMATION) {
    throw new R2ColdMirrorError("MIRROR_CONFIRMATION_REQUIRED");
  }
  const mode = process.env.R2_MIRROR_MODE?.trim().toLowerCase() || "copy";
  if (mode !== "copy" && mode !== "verify") throw new R2ColdMirrorError("MIRROR_MODE_INVALID");
  const accountId = requiredEnv("R2_ACCOUNT_ID");
  const bucket = requiredEnv("R2_IMAGE_BUCKET");
  const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
  const prefix = process.env.R2_MIRROR_PREFIX?.trim() || "single/studio/";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\/$/.test(prefix) || prefix.includes("..") || prefix.includes("//")) {
    throw new R2ColdMirrorError("MIRROR_PREFIX_INVALID");
  }
  const root = resolve(requiredEnv("R2_COLD_MIRROR_DIR"));
  const rootParts = parsePath(root);
  const relationToWorkspace = relative(process.cwd(), root);
  if (!isAbsolute(root) || root === rootParts.root || (!relationToWorkspace.startsWith("..") && !isAbsolute(relationToWorkspace))) {
    throw new R2ColdMirrorError("MIRROR_DIR_MUST_BE_EXTERNAL");
  }
  await mkdir(resolve(root, "objects"), { recursive: true, mode: 0o700 });
  const [{ S3Client, ListObjectsV2Command, GetObjectCommand }] = await Promise.all([import("@aws-sdk/client-s3")]);
  const commands = { GetObjectCommand };
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
      socketTimeout: 20_000,
      throwOnRequestTimeout: true,
    },
  });
  const loadedManifest = await loadPreviousManifest(resolve(root, "manifest.json"));
  const previous = loadedManifest.value;
  if (mode === "verify" && !loadedManifest.exists) throw new R2ColdMirrorError("MIRROR_MANIFEST_REQUIRED");
  const sourceScopeSha256 = createHash("sha256").update(`${accountId}\0${bucket}`).digest("hex");
  if (previous.sourceScopeSha256 !== undefined && previous.sourceScopeSha256 !== sourceScopeSha256) {
    throw new R2ColdMirrorError("MIRROR_SOURCE_SCOPE_MISMATCH");
  }
  const verified = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1_000,
    }));
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      const expectedBytes = object.Size;
      assertSafeKey(key);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_OBJECT_BYTES) {
        throw new R2ColdMirrorError("MIRROR_REMOTE_OBJECT_INVALID");
      }
      const destination = resolveMirrorObjectPath(root, key);
      await assertNoSymlinkPath(root, destination);
      let local;
      try {
        local = await sha256File(destination);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        if (mode === "verify") throw new R2ColdMirrorError("MIRROR_LOCAL_OBJECT_MISSING");
        await copyObject(client, commands, bucket, key, destination, expectedBytes);
        local = await sha256File(destination);
      }
      if (local.bytes !== expectedBytes || local.sha256 !== expectedHashForKey(key)) {
        throw new R2ColdMirrorError("MIRROR_LOCAL_HASH_MISMATCH");
      }
      verified.push({ key, sha256: local.sha256, bytes: local.bytes });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) throw new R2ColdMirrorError("MIRROR_LIST_PAGINATION_INVALID");
  } while (continuationToken);

  let entries;
  let digest;
  if (mode === "verify") {
    assertMirrorManifestCoversSource(previous.entries, verified);
    entries = previous.entries;
    await verifyCumulativeMirrorFiles(root, entries);
    digest = loadedManifest.digest;
  } else {
    const completedAt = new Date().toISOString();
    entries = mergeCumulativeMirrorEntries(previous.entries, verified, completedAt);
    await verifyCumulativeMirrorFiles(root, entries);
    digest = await writeManifest(root, {
      format: MIRROR_MANIFEST_FORMAT,
      completedAt,
      sourcePrefix: prefix,
      sourceScopeSha256,
      entries,
    });
  }
  process.stdout.write(`R2 cold mirror: OK mode=${mode} objects=${verified.length} retained=${Object.keys(entries).length} manifest_sha256=${digest}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`R2 cold mirror: FAIL code=${safeMirrorFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
