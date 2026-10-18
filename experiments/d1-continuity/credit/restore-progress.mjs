import assert from "node:assert/strict";

// A retry can report replayed even when this run performed the original commit.
// Classify checkpoint progress using its captured starting epoch, separately
// from the server's observed response counters. Final row hashes are the oracle.
export function countRestoreResult(progress, startingEpoch, epoch, result) {
  assert.ok(Number.isSafeInteger(startingEpoch) && startingEpoch >= 1);
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 2);
  assert.ok([0, 1].includes(result.applied));
  assert.ok([0, 1].includes(result.replayed));
  assert.equal(result.applied + result.replayed, 1);
  progress[epoch <= startingEpoch ? "replayed" : "applied"]++;
  progress.observedApplied += result.applied;
  progress.observedReplayed += result.replayed;
}
