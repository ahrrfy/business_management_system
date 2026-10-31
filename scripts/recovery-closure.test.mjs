import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { references, makePlan, saveObject } from "./recovery-media.mjs";
import { planDefiners, prepareRecoveryMysql, assertPrivateRecoveryDirectory } from "./lib/recovery-mysql.mjs";

const data = Buffer.from("synthetic recovery image");
const sha256 = createHash("sha256").update(data).digest("hex");
const key = `single/studio/original/${sha256}.png`;
const entry = { key, sha256, bytes: data.length, etag: '"abcdef"' };
const inventory = new Map([[key, { bytes: data.length, etag: entry.etag, storageClass: "STANDARD" }]]);
const get = async () => ({ Body: Readable.from([data]), ContentLength: data.length, ETag: entry.etag });

test("unknown definers and stored code types fail before provisioning", () => {
  assert.deepEqual(planDefiners([{ definer: "erp_app@%", kind: "TRIGGER" }], []), ["erp_app@%"]);
  assert.deepEqual(planDefiners([{ definer: "root@localhost", kind: "EVENT" }], [{ user: "root", host: "localhost" }]), []);
  for (const o of [{ definer: "someone@%", kind: "TRIGGER" }, { definer: "erp_app@%", kind: "ROUTINE" }])
    assert.throws(() => planDefiners([o], []), /UNREVIEWED/);
});

test("definer preparation locks new principal, scopes rights, and does not modify existing accounts", () => {
  const statements = []; let created = false, guards = 0;
  const sql = q => {
    statements.push(q);
    if (q.includes("information_schema.TRIGGERS")) return JSON.stringify({ definer: "erp_app@%", kind: "TRIGGER" });
    if (q.includes("FROM mysql.user")) return created ? JSON.stringify({ user: "erp_app", host: "%", locked: "Y" }) : "";
    created = true; return "";
  };
  const result = prepareRecoveryMysql(sql, () => guards++);
  assert.equal(result.missingDefiners, 0); assert.ok(guards >= 2);
  const ddl = statements.find(q => q.includes("CREATE USER"));
  assert.match(ddl, /ACCOUNT LOCK/); assert.match(ddl, /ON erp\.\*/);
  assert.doesNotMatch(ddl, /DELETE|ALL PRIVILEGES|GRANT OPTION|FILE|ALTER USER|ON \*\.\*/);
  statements.length = 0;
  prepareRecoveryMysql(sql, () => {});
  assert.equal(statements.some(q => q.includes("CREATE USER")), false);
  assert.throws(() => prepareRecoveryMysql(sql, () => { throw Error("ISOLATION_VIOLATION"); }), /ISOLATION/);
});

test("reference validation rejects duplicate keys, traversal, missing hashes, and invalid sizes", () => {
  const e = { key, expectedSha256: sha256 };
  assert.equal(references({ entries: [e] }).length, 1);
  for (const entries of [[e, e], [{ ...e, key: "single/studio/../escape" }], [{ key }], [{ ...e, expectedBytes: -1 }]])
    assert.throws(() => references({ entries }));
});

test("download plan enforces total budget, metadata, and Standard storage before any GET", () => {
  assert.equal(makePlan([entry], inventory, data.length).bytes, data.length);
  assert.throws(() => makePlan([entry], inventory, data.length - 1), /BUDGET/);
  assert.throws(() => makePlan([entry], new Map([[key, { ...inventory.get(key), storageClass: "STANDARD_IA" }]]), 1000), /METADATA/);
  assert.equal(makePlan([entry], new Map(), 1000).missing.length, 1);
  assert.throws(() => makePlan([{ ...entry, expectedBytes: 999 }], inventory, 1000), /METADATA/);
});

test("verified objects publish exclusively, reuse without GET, and retain partials", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-media-"));
  assert.equal((await saveObject(root, entry, get)).reused, false);
  assert.equal((await saveObject(root, entry, () => assert.fail("no GET on reuse"))).reused, true);
  const parent = join(root, "objects/single/studio/original");
  assert.equal((await readdir(parent)).length, 2);
  assert.deepEqual(await readFile(join(parent, `${sha256}.png`)), data);
});

test("four concurrent downloads safely create shared parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-concurrent-"));
  const entries = Array.from({ length: 4 }, (_, n) => ({ ...entry, key: `single/studio/group${n}/${sha256}.png` }));
  const saved = await Promise.all(entries.map(e => saveObject(root, e, get)));
  assert.equal(saved.length, 4);
  for (const e of entries) assert.deepEqual(await readFile(join(root, "objects", e.key)), data);
});

test("a world-readable evidence directory cannot receive recovery admin credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-public-"));
  if (process.platform === "win32") {
    const r = spawnSync("icacls", [root, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdio: "ignore" });
    assert.equal(r.status, 0);
  } else await chmod(root, 0o755);
  await assert.rejects(assertPrivateRecoveryDirectory(root), /PRIVATE_EVIDENCE_DIRECTORY_REQUIRED/);
});

test("bad bytes never publish and an existing corrupt file is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-media-"));
  await assert.rejects(saveObject(root, { ...entry, sha256: "a".repeat(64) }, get), /HASH/);
  const parent = join(root, "objects/single/studio/original");
  assert.ok((await readdir(parent)).every(f => f.endsWith(".partial")));
  const path = join(parent, `${sha256}.png`);
  await writeFile(path, "existing evidence");
  await assert.rejects(saveObject(root, entry, get), /EXISTING/);
  assert.equal(await readFile(path, "utf8"), "existing evidence");
});

test("symlink path cannot redirect media outside the mirror", async t => {
  const root = await mkdtemp(join(tmpdir(), "recovery-media-"));
  const outside = await mkdtemp(join(tmpdir(), "recovery-outside-"));
  await mkdir(join(root, "objects"));
  try { await symlink(outside, join(root, "objects/single"), "junction"); }
  catch (e) { if (e.code === "EPERM") return t.skip("symlink permission unavailable"); throw e; }
  await assert.rejects(saveObject(root, entry, get), /SYMLINK/);
  assert.deepEqual(await readdir(outside), []);
});
