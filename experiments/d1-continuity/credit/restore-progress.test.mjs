import test from "node:test";
import assert from "node:assert/strict";
import { countRestoreResult } from "./restore-progress.mjs";

test("restore commit with lost reply and identical replay advances checkpoint exactly once", () => {
  const progress = {
    applied: 0,
    replayed: 0,
    observedApplied: 0,
    observedReplayed: 0,
  };
  // Epoch2 existed before this run. Epoch3 commits, its reply is lost and the
  // exact same record is retried: only the retry response is observable.
  countRestoreResult(progress, 2, 2, { applied: 0, replayed: 1 });
  countRestoreResult(progress, 2, 3, { applied: 0, replayed: 1 });
  assert.deepEqual(progress, {
    applied: 1,
    replayed: 1,
    observedApplied: 0,
    observedReplayed: 2,
  });
});

test("invalid zero or multiple-record confirmations never advance restore progress", () => {
  for (const body of [
    { applied: 0, replayed: 0 },
    { applied: 1, replayed: 1 },
  ]) {
    const progress = {
      applied: 0,
      replayed: 0,
      observedApplied: 0,
      observedReplayed: 0,
    };
    assert.throws(() => countRestoreResult(progress, 2, 3, body));
    assert.equal(progress.applied + progress.replayed, 0);
  }
});
