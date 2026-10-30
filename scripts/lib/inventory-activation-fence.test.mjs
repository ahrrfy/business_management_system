import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertInventoryReadinessLifecycle } from "./inventory-activation-journal.mjs";
import {
  assertActivationRecoveryAllowed,
  readActivationJournal,
  runInventoryActivation,
  writeActivationJournal,
} from "./inventory-activation-fence.mjs";

export const fixtureJournal = () => ({
  version: 1,
  id: "12345678-1234-1234-1234-123456789abc",
  phase: "PREPARED",
  nonce: "a".repeat(64),
  commit: "b".repeat(40),
  database: "erp_test",
  serverUuid: "server-one",
  artifacts: [
    {
      name: "erp-server",
      script: path.resolve("candidate/index.js"),
      bundle: path.resolve("candidate/index.js"),
      hash: "c".repeat(64),
      scriptHash: "c".repeat(64),
      instances: 2,
    },
  ],
});
function harness(fail = "", { initialReadyVersion = 0 } = {}) {
  const log = [],
    journal = fixtureJournal();
  journal.priorArtifacts = journal.artifacts.map((a) => ({
    ...a,
    script: path.resolve("prior/index.js"),
    bundle: path.resolve("prior/index.js"),
    hash: "d".repeat(64),
    scriptHash: "d".repeat(64),
  }));
  if (initialReadyVersion === 1)
    journal.priorActive = {
      readyVersion: 1,
      activationId: journal.id,
      commit: "e".repeat(40),
      projectionCommit: "e".repeat(40),
      database: journal.database,
      serverUuid: journal.serverUuid,
      artifacts: journal.priorArtifacts,
    };
  let alive = true;
  const act = (name) => async () => {
    log.push(name);
    if (name === fail) throw new Error(name);
  };
  const operations = Object.fromEntries(
    [
      "preflight",
      "stopOld",
      "assertQuiescent",
      "installCandidate",
      "startCandidates",
      "verifyCandidates",
      "saveCompatibleRestartDefinitions",
      "stopCandidates",
      "restoreArtifact",
      "restartOld",
    ].map((n) => [n, act(n)]),
  );
  operations.acquireGate = async () => {
    await act("acquireGate")();
    return {
      assertLocked: async () => {
        log.push("assertLocked");
        if (!alive || fail === "A_LOST") throw new Error("A_LOST");
      },
      release: async () => {
        await act("A_COMMIT")();
        alive = false;
      },
    };
  };
  let latest;
  const persist = async (j) => {
    latest = structuredClone(j);
    await act(`persist:${j.phase}`)();
  };
  const activate = async (_b, opts) => {
    await opts.fence.assertQuiescentAndLocked();
    await act("B_COMMIT")();
    await opts.fence.assertQuiescentAndLocked();
  };
  const invalidate = async (_b, opts) => {
    await opts.fence.assertQuiescentAndLocked();
    await act("INVALIDATE_COMMIT")();
  };
  return {
    log,
    get latest() {
      return latest;
    },
    run: () =>
      runInventoryActivation({
        journal,
        persist,
        operations,
        activate,
        invalidate,
        initialReadyVersion,
      }),
  };
}
test("release permits boot only after original A commit and durable final phase", async () => {
  const h = harness();
  await h.run();
  assert.ok(h.log.indexOf("B_COMMIT") < h.log.indexOf("startCandidates"));
  assert.ok(h.log.indexOf("verifyCandidates") < h.log.indexOf("A_COMMIT"));
  assert.ok(h.log.indexOf("persist:PRE_RELEASE") < h.log.indexOf("A_COMMIT"));
  assert.ok(h.log.indexOf("A_COMMIT") < h.log.indexOf("persist:RELEASED"));
  assert.ok(!h.log.includes("restartOld"));
});
for (const failure of [
  "installCandidate",
  "startCandidates",
  "verifyCandidates",
  "saveCompatibleRestartDefinitions",
])
  test(`${failure} invalidates and commits before old restart`, async () => {
    const h = harness(failure);
    await assert.rejects(h.run());
    assert.ok(
      h.log.indexOf("stopCandidates") < h.log.indexOf("INVALIDATE_COMMIT"),
    );
    assert.ok(
      h.log.indexOf("INVALIDATE_COMMIT") < h.log.indexOf("persist:ROLLED_BACK"),
    );
    assert.ok(
      h.log.indexOf("persist:ROLLED_BACK") < h.log.indexOf("restartOld"),
    );
  });
for (const failure of [
  "A_LOST",
  "A_COMMIT",
  "persist:RELEASED",
  "assertQuiescent",
])
  test(`${failure} retains fatal interlock and never restarts old`, async () => {
    const h = harness(failure);
    await assert.rejects(h.run(), /FATAL/);
    assert.ok(h.log.includes("persist:FATAL"));
    assert.ok(!h.log.includes("restartOld"));
    assert.ok(!h.log.includes("persist:ROLLED_BACK"));
  });
test("compatible v1 replacement never rebaselines or invalidates ready projection", async () => {
  const h = harness("verifyCandidates", { initialReadyVersion: 1 });
  await assert.rejects(h.run());
  assert.ok(!h.log.includes("B_COMMIT"));
  assert.ok(!h.log.includes("INVALIDATE_COMMIT"));
  assert.ok(h.log.includes("restartOld"));
  assert.equal(h.latest.active?.readyVersion, 1);
  assert.deepEqual(h.latest.active?.artifacts, h.latest.priorArtifacts);
});
for (const phase of [
  "PREPARED",
  "LOCKED",
  "READY",
  "CANDIDATES",
  "PRE_RELEASE",
  "FATAL",
])
  test(`crash recovery in ${phase} refuses before old-binary execution`, () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "inventory-journal-"),
    );
    const file = path.join(directory, "journal.json");
    try {
      writeActivationJournal(file, { ...fixtureJournal(), phase });
      assert.equal(readActivationJournal(file).phase, phase);
      assert.throws(
        () => assertActivationRecoveryAllowed(file, { allowReleased: true }),
        /RECOVERY_REQUIRED/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });
test("activation commit reply loss never invokes invalidation or rollback", async () => {
  const h = harness("B_COMMIT");
  // Dedicated injection uses the exact raw-B uncertain error contract.
  const log = [];
  const operations = {
    preflight: async () => {},
    acquireGate: async () => ({
      assertLocked: async () => {},
      release: async () => log.push("release"),
    }),
    stopOld: async () => {},
    stopCandidates: async () => log.push("stop"),
    assertQuiescent: async () => {},
    restartOld: async () => log.push("old"),
  };
  await assert.rejects(
    runInventoryActivation({
      journal: fixtureJournal(),
      persist: async (j) => log.push(j.phase),
      operations,
      activate: async () => {
        throw new Error("INVENTORY_ACTIVATION_COMMIT_UNCERTAIN");
      },
      invalidate: async () => log.push("invalidate"),
    }),
    /FATAL/,
  );
  assert.deepEqual(log.slice(-2), ["stop", "FATAL"]);
  assert.ok(
    !log.includes("invalidate") &&
      !log.includes("old") &&
      !log.includes("release"),
  );
});

test("initial legacy rollback remains UNREADY and next deployment must rebaseline", async () => {
  const failed = harness("verifyCandidates");
  await assert.rejects(failed.run());
  assert.equal(failed.latest.initialReadyVersion, 0);
  assert.equal(failed.latest.active, null);
  assert.equal(
    assertInventoryReadinessLifecycle(failed.latest, {
      readyVersion: 0,
      activatedCommit: null,
    }),
    null,
  );
  assert.throws(
    () =>
      assertInventoryReadinessLifecycle(failed.latest, {
        readyVersion: 1,
        activatedCommit: "e".repeat(40),
      }),
    /LIFECYCLE/,
  );
  const next = harness();
  await next.run();
  assert.ok(next.log.includes("B_COMMIT"));
  assert.equal(next.latest.active.projectionCommit, next.latest.commit);
});
