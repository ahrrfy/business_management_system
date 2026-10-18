import test from "node:test";
import assert from "node:assert/strict";
import { nativeLab, saleInput } from "./native.mjs";
import { countRestoreResult } from "./restore-progress.mjs";
import { readPagedSnapshot } from "../cash/paged-client.mjs";

test("native restore after losing a committed reply is an identical replay with accurate checkpoint accounting", async () => {
  const l = await nativeLab({ name: "restore-lost-reply", coordinated: true });
  try {
    await l.ok(l.source, "/sale", saleInput("restore-reply-lost-20261018"));
    const call = (target, route, input) => l.call(target, route, input);
    const source = await readPagedSnapshot(call, l.source),
      before = await readPagedSnapshot(call, l.restore),
      journal = await l.ok(l.source, "/recovery-log?afterEpoch=1&limit=1"),
      record = journal.body.records[0];
    // Commit and deliberately discard this response, as a disconnected client
    // would. Only the identical retry is allowed to advance client progress.
    await l.ok(l.restore, "/restore", { records: [record] });
    const retry = await l.ok(l.restore, "/restore", { records: [record] });
    assert.equal(retry.body.applied, 0);
    assert.equal(retry.body.replayed, 1);
    const progress = {
      applied: 0,
      replayed: 0,
      observedApplied: 0,
      observedReplayed: 0,
    };
    countRestoreResult(progress, before.epoch, record.epoch, retry.body);
    assert.equal(progress.applied, source.epoch - before.epoch);
    assert.deepEqual(await readPagedSnapshot(call, l.restore), source);
    assert.equal(source.counts.invoices, 1);
  } finally {
    await l.close();
  }
});
