import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

export const canonical = (v) =>
  Array.isArray(v)
    ? "[" + v.map(canonical).join(",") + "]"
    : v && typeof v === "object"
      ? "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
          .join(",") +
        "}"
      : JSON.stringify(v);
export const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const signed = (v, secret) => ({
  ...v,
  signature: createHmac("sha256", secret).update(canonical(v)).digest("hex"),
});
function verifySigned(v, secret) {
  const { signature, ...unsigned } = v;
  assert.match(signature ?? "", /^[a-f0-9]{64}$/);
  assert.ok(
    timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(signed(unsigned, secret).signature, "hex"),
    ),
    "Invalid checkpoint signature",
  );
  return unsigned;
}
const cashIdentity = {
  labId: "actual-cash-20261017",
  schemaVersion: "actual-cash-v1",
};
function verifyRecord(r, secret, identity = cashIdentity) {
  const v = verifySigned(r, secret);
  assert.equal(v.version, 1);
  assert.equal(v.labId, identity.labId);
  assert.equal(v.schemaVersion, identity.schemaVersion);
  assert.equal(v.requestId, v.plan.requestId);
  assert.equal(v.epoch, v.plan.expectedEpoch + 1);
  assert.equal(v.planHash, sha256(canonical(v.plan)));
  assert.equal(v.envelopeHash, sha256(canonical(v.plan.request)));
  return r;
}
async function checked(call, target, route, input) {
  const r = await call(target, route, input);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

// Hash complete state incrementally; never materialize historical command plans
// together in a Worker or retain all history in the load-driver heap.
export async function readPagedSnapshot(
  call,
  target,
  { onRow = () => {} } = {},
) {
  const manifest = await checked(call, target, "/snapshot?manifest=1"),
    digest = createHash("sha256");
  assert.ok(Number.isSafeInteger(manifest.epoch));
  digest.update("cash-snapshot-v1\n" + manifest.epoch + "\n");
  const counts = {},
    pages = {};
  let totalRows = 0,
    maxPageBytes = 0;
  for (const table of manifest.tables) {
    assert.ok(Number.isSafeInteger(table.count) && table.count >= 0);
    assert.ok(Array.isArray(table.primary) && table.primary.length);
    digest.update(table.name + "\n");
    let after = null,
      count = 0,
      n = 0;
    const cursors = new Set(),
      keys = new Set();
    if (table.count)
      for (;;) {
        const route =
          "/snapshot?table=" +
          encodeURIComponent(table.name) +
          "&epoch=" +
          manifest.epoch +
          "&limit=100" +
          (after ? "&after=" + encodeURIComponent(JSON.stringify(after)) : "");
        const p = await checked(call, target, route);
        assert.equal(p.epoch, manifest.epoch);
        assert.equal(p.table, table.name);
        assert.ok(Array.isArray(p.rows));
        maxPageBytes = Math.max(
          maxPageBytes,
          Buffer.byteLength(JSON.stringify(p)),
        );
        assert.ok(
          Buffer.byteLength(JSON.stringify(p)) <= 128 * 1024,
          "Snapshot page byte budget",
        );
        assert.ok(++n <= table.count + 1);
        for (const row of p.rows) {
          const k = canonical(table.primary.map((k) => row[k]));
          assert.ok(!keys.has(k), "Duplicate paged row");
          keys.add(k);
          digest.update(canonical(row) + "\n");
          onRow(table.name, row);
          count++;
        }
        assert.ok(count <= table.count);
        if (p.complete) {
          assert.equal(p.nextCursor, null);
          break;
        }
        assert.ok(p.rows.length);
        const cursor = canonical(p.nextCursor);
        assert.equal(
          cursor,
          canonical(table.primary.map((k) => p.rows.at(-1)[k])),
        );
        assert.ok(!cursors.has(cursor), "Repeated snapshot cursor");
        cursors.add(cursor);
        after = p.nextCursor;
      }
    assert.equal(count, table.count, "Truncated snapshot table " + table.name);
    counts[table.name] = count;
    pages[table.name] = n;
    totalRows += count;
  }
  const end = await checked(call, target, "/snapshot?manifest=1");
  assert.deepEqual(end, manifest, "Source changed during paged snapshot");
  return {
    epoch: manifest.epoch,
    counts,
    pages,
    totalRows,
    maxPageBytes,
    sha256: digest.digest("hex"),
  };
}

async function scanFile(file, secret, identity = cashIdentity) {
  const digest = createHash("sha256");
  let header = null,
    footer = null,
    last = 1,
    count = 0;
  const handle = await open(file, "r");
  try {
    const s = await handle.stat();
    assert.ok(s.size > 0);
    const b = Buffer.alloc(1);
    await handle.read(b, 0, 1, s.size - 1);
    assert.equal(
      b[0],
      10,
      "Incomplete export line preserved; use a new export file",
    );
  } finally {
    await handle.close();
  }
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    const v = JSON.parse(line);
    assert.ok(!footer, "Data after complete export footer");
    if (!header) {
      verifySigned(v, secret);
      assert.equal(v.type, "header");
      assert.equal(v.format, "cash-journal-ndjson-v1");
      assert.equal(v.labId, identity.labId);
      assert.equal(v.schemaVersion, identity.schemaVersion);
      assert.ok(Number.isSafeInteger(v.throughEpoch) && v.throughEpoch >= 1);
      header = v;
      continue;
    }
    if (v.type === "complete") {
      verifySigned(v, secret);
      assert.equal(v.headerHash, sha256(canonical(header)));
      assert.equal(v.throughEpoch, header.throughEpoch);
      assert.equal(v.count, count);
      assert.equal(last, header.throughEpoch);
      assert.equal(v.digest, digest.copy().digest("hex"));
      footer = v;
      continue;
    }
    verifyRecord(v, secret, identity);
    assert.equal(v.epoch, last + 1);
    assert.ok(v.epoch <= header.throughEpoch);
    last = v.epoch;
    count++;
    digest.update(line + "\n");
  }
  assert.ok(header);
  return { header, footer, last, count, digest };
}
export async function validateJournalFile(
  file,
  secret,
  identity = cashIdentity,
) {
  const s = await scanFile(file, secret, identity);
  assert.ok(s.footer, "Export checkpoint is incomplete");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return {
    header: s.header,
    count: s.count,
    throughEpoch: s.last,
    sha256: digest.digest("hex"),
  };
}

// Each completed page is fsynced before advancing. Resume scans and verifies the
// saved immutable prefix; it never truncates evidence or regenerates sale keys.
export async function exportPagedJournal(
  call,
  target,
  file,
  secret,
  {
    snapshotSha256,
    snapshotEpoch,
    resume = false,
    interruptAfterPages = Infinity,
    identity = cashIdentity,
  } = {},
) {
  assert.match(snapshotSha256 ?? "", /^[a-f0-9]{64}$/, "Invalid snapshot hash");
  assert.ok(
    Number.isSafeInteger(snapshotEpoch) && snapshotEpoch >= 1,
    "Invalid SNAPSHOT_EPOCH",
  );
  let saved,
    handle,
    first,
    header,
    digest,
    last = 1,
    count = 0,
    pages = 0;
  if (resume) {
    saved = await scanFile(file, secret, identity);
    assert.equal(
      saved.header.snapshotSha256,
      snapshotSha256,
      "Checkpoint snapshot hash mismatch",
    );
    assert.equal(
      saved.header.throughEpoch,
      snapshotEpoch,
      "Checkpoint SNAPSHOT_EPOCH mismatch",
    );
    if (saved.footer) return validateJournalFile(file, secret, identity);
    ({ header, digest, last, count } = saved);
    handle = await open(file, "a");
  } else {
    first = await checked(
      call,
      target,
      "/recovery-log?afterEpoch=1&throughEpoch=" + snapshotEpoch + "&limit=8",
    );
    assert.equal(
      first.throughEpoch,
      snapshotEpoch,
      "SNAPSHOT_EPOCH changed during export",
    );
    assert.equal(first.labId, identity.labId);
    assert.equal(first.schemaVersion, identity.schemaVersion);
    header = signed(
      {
        type: "header",
        format: "cash-journal-ndjson-v1",
        labId: first.labId,
        schemaVersion: first.schemaVersion,
        throughEpoch: first.throughEpoch,
        snapshotSha256,
      },
      secret,
    );
    digest = createHash("sha256");
    handle = await open(file, "wx");
    await handle.writeFile(JSON.stringify(header) + "\n");
    await handle.sync();
  }
  try {
    while (last < header.throughEpoch) {
      const p =
        first ??
        (await checked(
          call,
          target,
          "/recovery-log?afterEpoch=" +
            last +
            "&throughEpoch=" +
            header.throughEpoch +
            "&limit=8",
        ));
      first = null;
      assert.equal(p.afterEpoch, last);
      assert.equal(p.throughEpoch, header.throughEpoch);
      assert.ok(p.records.length);
      assert.ok(
        Buffer.byteLength(JSON.stringify(p)) <= 128 * 1024,
        "Journal page byte budget",
      );
      for (const r of p.records) {
        verifyRecord(r, secret, identity);
        assert.equal(r.epoch, last + 1);
        assert.ok(r.epoch <= header.throughEpoch);
        const line = JSON.stringify(r) + "\n";
        await handle.writeFile(line);
        digest.update(line);
        last = r.epoch;
        count++;
      }
      assert.equal(p.nextEpoch, last);
      assert.equal(p.complete, last === header.throughEpoch);
      await handle.sync();
      if (++pages >= interruptAfterPages)
        throw Error("SIMULATED_EXPORT_INTERRUPTION_AFTER_FSYNC");
    }
    await handle.writeFile(
      JSON.stringify(
        signed(
          {
            type: "complete",
            count,
            throughEpoch: last,
            digest: digest.digest("hex"),
            headerHash: sha256(canonical(header)),
          },
          secret,
        ),
      ) + "\n",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return validateJournalFile(file, secret, identity);
}
export async function* journalFileRecords(
  file,
  secret,
  identity = cashIdentity,
) {
  await validateJournalFile(file, secret, identity);
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    const r = JSON.parse(line);
    if (!r.type) yield r;
  }
}
