import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { sweepDownloadCache } from "../vps-maintenance.mjs";

const now = Date.now();
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "erp-housekeeping-test-"));
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(absolute).startsWith("erp-housekeeping-test-"));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const backups = path.join(root, "backups");
  const cache = path.join(backups, ".download-cache");
  await fs.mkdir(cache, { recursive: true });
  const source = path.join(backups, "important-backup.sql");
  await fs.writeFile(source, "-- irreplaceable original backup\n");
  const makeSlot = async (name = "00", expiresAt = now - 86400000) => {
    const slot = path.join(cache, name);
    await fs.mkdir(slot);
    const id = randomUUID();
    const pin = path.join(slot, id + ".sql");
    await fs.link(source, pin);
    const info = await fs.stat(pin);
    const metadata = {
      id,
      expiresAt,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ino: info.ino,
      dev: info.dev,
      userId: 1,
      companyId: null,
      name: path.basename(source),
    };
    await fs.writeFile(
      path.join(slot, "snapshot.json"),
      JSON.stringify(metadata),
    );
    return { slot, pin, metadata };
  };
  return { root, backups, cache, source, makeSlot };
}

test("dry run reports expired pins without writing or changing originals", async (t) => {
  const f = await fixture(t);
  const pin = await f.makeSlot();
  const before = await fs.readdir(pin.slot);
  const result = await sweepDownloadCache({ root: f.root, now });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(await fs.readdir(pin.slot), before);
  assert.equal(
    await fs.readFile(f.source, "utf8"),
    "-- irreplaceable original backup\n",
  );
});

test("apply removes expired pins and preserves originals and other backups", async (t) => {
  const f = await fixture(t);
  const pin = await f.makeSlot();
  await fs.writeFile(path.join(f.backups, "important.sql.gpg"), "encrypted");
  await fs.mkdir(path.join(f.backups, "manual-recovery"));
  await fs.writeFile(
    path.join(f.backups, "manual-recovery", "evidence"),
    "preserve",
  );
  const result = await sweepDownloadCache({ root: f.root, now, apply: true });
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].reclaimableBytes, 0);
  await assert.rejects(fs.stat(pin.pin), { code: "ENOENT" });
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(pin.slot, "snapshot.json"), "utf8")),
    pin.metadata,
  );
  assert.equal(
    await fs.readFile(f.source, "utf8"),
    "-- irreplaceable original backup\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.backups, "important.sql.gpg"), "utf8"),
    "encrypted",
  );
  assert.equal(
    await fs.readFile(
      path.join(f.backups, "manual-recovery", "evidence"),
      "utf8",
    ),
    "preserve",
  );
  assert.equal(
    (await sweepDownloadCache({ root: f.root, now, apply: true })).removed
      .length,
    0,
  );
});

test("reclaims a pin left after source rotation", async (t) => {
  const f = await fixture(t);
  const pin = await f.makeSlot();
  await fs.unlink(f.source);
  const result = await sweepDownloadCache({ root: f.root, now, apply: true });
  assert.equal(result.removed.length, 1);
  await assert.rejects(fs.stat(pin.pin), { code: "ENOENT" });
});

test("protects live downloads and the one-hour expiry grace period", async (t) => {
  const f = await fixture(t);
  const live = await f.makeSlot("00", now + 1000);
  const grace = await f.makeSlot("01", now - 1800000);
  assert.equal(
    (await sweepDownloadCache({ root: f.root, now, apply: true })).removed
      .length,
    0,
  );
  await fs.stat(live.pin);
  await fs.stat(grace.pin);
});

test("an unknown entry, reservation, or another worker's mutex blocks deletion", async (t) => {
  const f = await fixture(t);
  const unknown = await f.makeSlot("00");
  const locked = await f.makeSlot("01");
  await fs.writeFile(path.join(unknown.slot, "keep-me"), "data");
  await fs.mkdir(path.join(locked.slot, ".cleanup"));
  await fs.mkdir(path.join(f.cache, "02"));
  assert.equal(
    (await sweepDownloadCache({ root: f.root, now, apply: true })).removed
      .length,
    0,
  );
  await fs.stat(unknown.pin);
  await fs.stat(locked.pin);
  await fs.stat(path.join(f.cache, "02"));
});

test("preserves invalid metadata and changed payloads", async (t) => {
  const f = await fixture(t);
  const invalid = await f.makeSlot("00");
  const changed = await f.makeSlot("01");
  await fs.writeFile(path.join(invalid.slot, "snapshot.json"), "{broken");
  await fs.unlink(changed.pin);
  await fs.writeFile(changed.pin, "replacement");
  assert.equal(
    (await sweepDownloadCache({ root: f.root, now, apply: true })).removed
      .length,
    0,
  );
  await fs.stat(invalid.pin);
  await fs.stat(changed.pin);
});

test("concurrent sweepers use the application mutex and never remove an original", async (t) => {
  const f = await fixture(t);
  await f.makeSlot();
  const results = await Promise.all([
    sweepDownloadCache({ root: f.root, now, apply: true }),
    sweepDownloadCache({ root: f.root, now, apply: true }),
  ]);
  assert.equal(
    results.reduce((sum, r) => sum + r.removed.length, 0),
    1,
  );
  assert.equal(
    await fs.readFile(f.source, "utf8"),
    "-- irreplaceable original backup\n",
  );
});

test("a new empty application reservation is preserved during lock acquisition", async (t) => {
  const f = await fixture(t);
  const old = await f.makeSlot();
  const nativeMkdir = fs.mkdir.bind(fs);
  let replaced = false;
  t.mock.method(fs, "mkdir", async (target, options) => {
    if (target === path.join(old.slot, ".cleanup") && !replaced) {
      replaced = true;
      await fs.unlink(old.pin);
      await fs.unlink(path.join(old.slot, "snapshot.json"));
      await fs.rmdir(old.slot);
      await nativeMkdir(old.slot);
    }
    return nativeMkdir(target, options);
  });
  const result = await sweepDownloadCache({ root: f.root, now, apply: true });
  assert.ok(replaced);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(await fs.readdir(old.slot), []);
  await fs.link(f.source, path.join(old.slot, "new-allocation.sql"));
});

test("the actual application can immediately reuse a cleaned slot", async (t) => {
  const f = await fixture(t);
  const old = await f.makeSlot();
  await sweepDownloadCache({ root: f.root, now, apply: true });
  const serviceUrl = new URL(
    "../../server/services/backupDownloadService.ts",
    import.meta.url,
  ).href;
  const source = [
    'import fs from "node:fs/promises";',
    "import { getBackupDownload } from " + JSON.stringify(serviceUrl) + ";",
    "const result = await getBackupDownload(" +
      JSON.stringify({
        directory: f.backups,
        sourcePath: f.source,
        name: path.basename(f.source),
        userId: 2,
        companyId: null,
      }) +
      ", " +
      now +
      ");",
    'console.log(JSON.stringify({ id: result.id, path: result.path, data: await fs.readFile(result.path, "utf8") }));',
  ].join("\n");
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-transform-types",
    "--input-type=module",
    "-e",
    source,
  ]);
  const reused = JSON.parse(stdout.trim());
  assert.equal(path.dirname(reused.path), old.slot);
  assert.notEqual(reused.id, old.metadata.id);
  assert.equal(reused.data, "-- irreplaceable original backup\n");
});

test("only the application's sixteen slot names are eligible", async (t) => {
  const f = await fixture(t);
  const unknown = await f.makeSlot("16");
  assert.equal(
    (await sweepDownloadCache({ root: f.root, now, apply: true })).removed
      .length,
    0,
  );
  await fs.stat(unknown.pin);
});

test(
  "symbolic-link cache and payloads are never followed",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const pin = await f.makeSlot();
    await fs.unlink(pin.pin);
    await fs.symlink(f.source, pin.pin);
    assert.equal(
      (await sweepDownloadCache({ root: f.root, now, apply: true })).removed
        .length,
      0,
    );
    await fs.unlink(pin.pin);
    await fs.unlink(path.join(pin.slot, "snapshot.json"));
    await fs.rmdir(pin.slot);
    await fs.rmdir(f.cache);
    await fs.symlink(f.backups, f.cache);
    await assert.rejects(
      sweepDownloadCache({ root: f.root, now, apply: true }),
      /UNSAFE/,
    );
    await fs.stat(f.source);
  },
);

test("service permits writes only to download cache and has no network or root privileges", async () => {
  const service = await fs.readFile(
    new URL(
      "../../deploy/maintenance/erp-housekeeping.service",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(service, /^User=deploy$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(
    service,
    /^ReadWritePaths=\/home\/deploy\/erp\/backups\/\.download-cache$/m,
  );
  assert.match(service, /^PrivateNetwork=true$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
});
