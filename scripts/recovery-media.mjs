// Read-only R2 export of an explicit recovery reference manifest. No sync/delete.
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, realpath, link, open } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fingerprint } from "./lib/backup-publication.mjs";
import { assertPrivateRecoveryDirectory } from "./lib/recovery-mysql.mjs";

export function references(value) {
  if (!Array.isArray(value?.entries) || !value.entries.length || value.entries.length > 6000)
    throw Error("REFERENCE_LIMIT");
  const seen = new Set();
  return value.entries.map(e => {
    if (!/^single\/(studio|storefront-customizer)\/[A-Za-z0-9._/-]+$/.test(e.key) ||
        e.key.includes("..") || e.key.includes("//") || seen.has(e.key) ||
        !/^[a-f0-9]{64}$/.test(e.expectedSha256) ||
        (e.expectedBytes !== undefined && (!Number.isSafeInteger(e.expectedBytes) || e.expectedBytes <= 0)))
      throw Error("REFERENCE_INVALID");
    seen.add(e.key);
    return { key: e.key, sha256: e.expectedSha256, expectedBytes: e.expectedBytes };
  });
}

export function makePlan(refs, inventory, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 ** 3) throw Error("BYTE_LIMIT_INVALID");
  const missing = [], entries = [];
  for (const r of refs) {
    const o = inventory.get(r.key);
    if (!o) { missing.push(r.key); continue; }
    if (!Number.isSafeInteger(o.bytes) || o.bytes <= 0 || o.bytes > 25 * 1024 ** 2 ||
        (r.expectedBytes !== undefined && r.expectedBytes !== o.bytes) ||
        (o.storageClass && o.storageClass !== "STANDARD") || !/^"[a-f0-9-]+"$/i.test(o.etag))
      throw Error("SOURCE_METADATA_INVALID");
    entries.push({ ...r, bytes: o.bytes, etag: o.etag });
  }
  const bytes = entries.reduce((s, e) => s + e.bytes, 0);
  if (bytes > maxBytes) throw Error("BYTE_BUDGET_EXCEEDED");
  return { entries, missing, bytes, maxBytes };
}

async function safePath(root, key) {
  const file = resolve(root, "objects", ...key.split("/"));
  if (!file.startsWith(resolve(root, "objects") + sep)) throw Error("PATH_ESCAPE");
  let part = root;
  for (const segment of file.slice(root.length + 1).split(sep).slice(0, -1)) {
    part = resolve(part, segment);
    try { if ((await lstat(part)).isSymbolicLink()) throw Error("SYMLINK_FORBIDDEN"); }
    catch (e) {
      if (e.code !== "ENOENT") throw e;
      try { await mkdir(part, { mode: 0o700 }); }
      catch (race) { if (race.code !== "EEXIST") throw race; }
      const created = await lstat(part);
      if (!created.isDirectory() || created.isSymbolicLink()) throw Error("SYMLINK_FORBIDDEN");
    }
  }
  try { if ((await lstat(file)).isSymbolicLink()) throw Error("SYMLINK_FORBIDDEN"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  return file;
}

export async function saveObject(root, entry, get) {
  const file = await safePath(root, entry.key);
  try {
    const old = await fingerprint(file);
    if (old.size !== entry.bytes || old.sha256 !== entry.sha256) throw Error("EXISTING_OBJECT_MISMATCH");
    return { key: entry.key, bytes: old.size, sha256: old.sha256, reused: true };
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const response = await get(entry);
  if (response.ContentLength !== entry.bytes || response.ETag !== entry.etag ||
      (response.StorageClass && response.StorageClass !== "STANDARD") || !response.Body)
    throw Error("SOURCE_CHANGED");
  const partial = `${file}.${randomUUID()}.partial`;
  const handle = await open(partial, "wx", 0o600);
  const hash = createHash("sha256"); let bytes = 0;
  try {
    for await (const raw of response.Body) {
      const chunk = Buffer.from(raw); bytes += chunk.length;
      if (bytes > entry.bytes) throw Error("OBJECT_BYTE_LIMIT");
      hash.update(chunk); await handle.writeFile(chunk);
    }
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) throw Error("OBJECT_HASH_MISMATCH");
    await handle.sync();
  } finally { await handle.close(); response.Body.destroy?.(); }
  // Publish exclusively; retain partials, including failures, for audit. No overwrite/delete.
  await link(partial, file);
  return { key: entry.key, bytes, sha256: entry.sha256, reused: false };
}

export async function main(args = process.argv.slice(2)) {
  const val = f => { const i = args.indexOf(f); if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) throw Error("ARGUMENT_REQUIRED"); return args[i + 1]; };
  const mode = val("--mode");
  if (!["inventory", "copy"].includes(mode)) throw Error("MODE_INVALID");
  const raw = await readFile(resolve(val("--references")));
  const refs = references(JSON.parse(raw));
  const sourceManifestSha256 = createHash("sha256").update(raw).digest("hex");
  const maxBytes = Number(val("--max-bytes"));
  makePlan([], new Map(), maxBytes);
  const root = resolve(val("--destination"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw Error("ROOT_SYMLINK_FORBIDDEN");
  await assertPrivateRecoveryDirectory(root);
  const secrets = (await import("dotenv")).parse(await readFile(resolve(val("--secrets-file"))));
  for (const key of ["R2_ACCOUNT_ID", "R2_IMAGE_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])
    if (!secrets[key]) throw Error("R2_CREDENTIAL_REQUIRED");
  if (!/^[a-f0-9]{32}$/.test(secrets.R2_ACCOUNT_ID)) throw Error("R2_ENDPOINT_INVALID");
  const sourceScopeSha256 = createHash("sha256").update(`${secrets.R2_ACCOUNT_ID}\0${secrets.R2_IMAGE_BUCKET}`).digest("hex");
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: "auto", endpoint: `https://${secrets.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: secrets.R2_ACCESS_KEY_ID, secretAccessKey: secrets.R2_SECRET_ACCESS_KEY }, maxAttempts: 1,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, socketTimeout: 20000, throwOnRequestTimeout: true } });
  const deadline = AbortSignal.timeout(15 * 60 * 1000);
  let listRequests = 0, getRequests = 0;
  const inventory = new Map(), report = { format: "alroya-reference-media-recovery/v1", mode, sourceManifestSha256,
    sourceScopeSha256, startedAt: new Date().toISOString(), status: "NOT_VERIFIED", remoteMutations: false, deletions: false };
  try {
    // Two narrow prefixes; no bucket-wide inventory. Hard cap includes paginated requests.
    for (const Prefix of [...new Set(refs.map(r => r.key.split("/").slice(0, 2).join("/") + "/"))]) {
      let ContinuationToken;
      do {
        if (++listRequests > 12) throw Error("LIST_REQUEST_LIMIT");
        const response = await client.send(new ListObjectsV2Command({ Bucket: secrets.R2_IMAGE_BUCKET, Prefix,
          MaxKeys: 1000, ContinuationToken }), { abortSignal: deadline });
        for (const o of response.Contents ?? []) inventory.set(o.Key, { bytes: o.Size, etag: o.ETag, storageClass: o.StorageClass });
        ContinuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        if (response.IsTruncated && !ContinuationToken) throw Error("SOURCE_PAGINATION_INVALID");
      } while (ContinuationToken);
    }
    const plan = makePlan(refs, inventory, maxBytes);
    report.plan = plan;
    if (mode === "copy") {
      report.verified = []; report.failures = [];
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < plan.entries.length) {
          const entry = plan.entries[next++];
          try {
            const result = await saveObject(root, entry, e => {
              if (++getRequests > 6000) throw Error("GET_REQUEST_LIMIT");
              return client.send(new GetObjectCommand({ Bucket: secrets.R2_IMAGE_BUCKET, Key: e.key, IfMatch: e.etag }), { abortSignal: deadline });
            });
            report.verified.push(result);
          } catch (error) {
            report.failures.push({ key: entry.key, code: /^[A-Z_]+$/.test(error.message) ? error.message : "SOURCE_READ_FAILED" });
          }
        }
      }));
      report.status = plan.missing.length || report.failures.length ? "INCOMPLETE" : "REFERENCE_BYTES_VERIFIED";
    } else report.status = plan.missing.length ? "SOURCE_INCOMPLETE" : "INVENTORY_COMPLETE";
  } catch (e) {
    report.failure = /^[A-Z_]+$/.test(e.message) ? e.message : "MEDIA_RECOVERY_FAILED";
    report.failureType = /^[A-Za-z0-9_]{1,80}$/.test(e.name) ? e.name : "UNKNOWN";
    report.httpStatus = Number.isInteger(e.$metadata?.httpStatusCode) ? e.$metadata.httpStatusCode : undefined;
    report.networkCode = /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : undefined;
  }
  finally {
    client.destroy(); report.listRequests = listRequests; report.getRequests = getRequests;
    report.finishedAt = new Date().toISOString();
    const path = resolve(root, `${mode}-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ report: path, status: report.status, objects: report.plan?.entries.length,
      missing: report.plan?.missing.length, bytes: report.plan?.bytes, verified: report.verified?.length,
      failed: report.failures?.length, listRequests, getRequests, failure: report.failure }));
  }
  if (!["INVENTORY_COMPLETE", "REFERENCE_BYTES_VERIFIED"].includes(report.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("MEDIA_RECOVERY_FAILED"); process.exitCode = 1; });
