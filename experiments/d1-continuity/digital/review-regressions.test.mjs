// Offline review regressions. Reads immutable captures; never imports the runner/provider.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import * as validator from "./validate.mjs";
const root = "experiments/d1-continuity/digital/results/";
const latest = JSON.parse(readFileSync(root + "latest.json"));
const evidence = JSON.parse(readFileSync(latest.out + "/oracle.json"));
const refusal = evidence.scenarios
  .flatMap((s) => s.commands)
  .find((c) => c.op === "VERIFIED_PREPARE" && c.error);
const providerCheck =
  validator.validateProviderEvidence ?? validator.validateEvidence;
console.log(
  "Validator SHA256",
  createHash("sha256")
    .update(readFileSync(new URL("./validate.mjs", import.meta.url)))
    .digest("hex"),
);
test("R1 authentic verifier/RPC additions preserve the full prior graph", () =>
  validator.assertRefusalUnchanged(refusal));
const auditMutations = {
  "delete all audit rows": (c) => (c.after.auditLogs = []),
  "delete prior row": (c) => c.after.auditLogs.shift(),
  "modify prior row": (c) => (c.after.auditLogs[0].entityId = "tampered"),
  "missing SOD addition": (c) => c.after.auditLogs.splice(-2, 1),
  "missing RPC addition": (c) => c.after.auditLogs.pop(),
  "extra addition": (c) =>
    c.after.auditLogs.push({ ...c.after.auditLogs.at(-1), id: 999 }),
  "wrong actor": (c) => (c.after.auditLogs.at(-2).userId = 999),
  "wrong branch": (c) => (c.after.auditLogs.at(-1).branchId = 999),
  "wrong outcome": (c) =>
    (c.after.auditLogs.at(-2).operation.outcome = "SUCCESS"),
  "wrong subject": (c) => (c.after.auditLogs.at(-2).entityId = "999"),
  "wrong payload": (c) =>
    (c.after.auditLogs.at(-2).newValue.identifier = "tampered"),
};
for (const [name, mutate] of Object.entries(auditMutations))
  test("R1 rejects " + name, () => {
    const c = structuredClone(refusal);
    mutate(c);
    assert.throws(() => validator.assertRefusalUnchanged(c));
  });
test("R2 authentic complete ledger and linked interrupted provenance", () =>
  providerCheck(evidence));
const ledgerMutations = {
  "empty ledger": (e) => (e.providerLedger = []),
  "missing ledger event": (e) => e.providerLedger.splice(0, 1),
  "wrong ledger key": (e) =>
    (e.providerLedger[0].key = "digital-issue:999:999"),
  "wrong ledger payload hash": (e) =>
    (e.providerLedger[0].requestHash = "0".repeat(64)),
  "wrong ledger result": (e) => (e.providerLedger[0].result.status = "FAILED"),
  "missing interrupted event": (e) => e.providerLedger.splice(10, 1),
};
for (const [name, mutate] of Object.entries(ledgerMutations))
  test("R2 rejects " + name, () => {
    const e = {
      ...evidence,
      providerLedger: structuredClone(evidence.providerLedger),
    };
    mutate(e);
    assert.throws(() => providerCheck(e));
  });
const commandMutations = {
  "missing command event": (c) => (c.providerEvents = []),
  "changed request payload": (c) =>
    (c.input.request.providerReference = "tampered"),
  "changed command result": (c) => (c.result.status = "FAILED"),
  "changed command event": (c) =>
    (c.providerEvents[0].requestHash = "0".repeat(64)),
  "wrong provider actor": (c) => (c.actor.userId = 999),
  "wrong raw claim owner": (c) =>
    (c.before.digitalSaleExecutionClaims[0].claimedBy = 999),
  "wrong raw provider identity": (c) =>
    (c.before.digitalSaleIntentItems[0].providerId = 999),
};
for (const [name, mutate] of Object.entries(commandMutations))
  test("R2 rejects " + name, () => {
    const e = {
      ...evidence,
      scenarios: evidence.scenarios.map((s) => ({
        ...s,
        commands: [...s.commands],
      })),
    };
    const s = e.scenarios.find((s) =>
      s.commands.some((c) => c.op === "PROVIDER" && !c.error),
    );
    const i = s.commands.findIndex((c) => c.op === "PROVIDER" && !c.error);
    s.commands[i] = structuredClone(s.commands[i]);
    mutate(s.commands[i]);
    assert.throws(() => providerCheck(e));
  });
test("R2 rejects changed provenance source hash", () => {
  assert.throws(() =>
    providerCheck({
      ...evidence,
      continuedFrom: { ...evidence.continuedFrom, sha256: "0".repeat(64) },
    }),
  );
});
test("R2 exposes exactly 16 canonical and 2 hash-linked interrupted events", () => {
  const proof = validator.validateProviderEvidence(evidence);
  assert.equal(proof.canonicalUnits, 16);
  assert.equal(proof.interruptedEvents.length, 2);
  assert.deepEqual(
    proof.interruptedEvents.map((p) => p.event.sequence),
    [11, 12],
  );
  for (const unit of proof.interruptedEvents) {
    assert.match(unit.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(unit.identity.claimedBy, 1);
    assert.equal(unit.event.event, "ISSUED");
  }
});
test("R2 rejects provider key absent from real successful claim return", () => {
  const e = {
    ...evidence,
    scenarios: evidence.scenarios.map((s) => ({
      ...s,
      commands: [...s.commands],
    })),
  };
  const s = e.scenarios[0],
    i = s.commands.findIndex((c) => c.op === "CLAIM" && !c.error);
  s.commands[i] = structuredClone(s.commands[i]);
  s.commands[i].result.providerIdempotencyKey = "digital-issue:999:999";
  assert.throws(() => providerCheck(e));
});
