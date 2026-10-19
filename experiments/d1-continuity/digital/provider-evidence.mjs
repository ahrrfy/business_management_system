// Offline evidence checks only. No synthetic provider, runner or connection import.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => sha(JSON.stringify(value));
const cache = new Map();
const resultsRoot =
  path.resolve("experiments/d1-continuity/digital/results") + path.sep;

function identity(state, key) {
  const rows = state.digitalSaleExecutionClaims.filter(
    (r) => r.providerIdempotencyKey === key,
  );
  assert.equal(
    rows.length,
    1,
    "Provider key must identify one actual execution claim",
  );
  const claim = rows[0],
    item = state.digitalSaleIntentItems.find(
      (r) => r.id === claim.intentItemId,
    );
  assert.ok(item, "Claim has no real intent item");
  const intent = state.digitalSaleIntents.find((r) => r.id === item.intentId);
  assert.ok(intent);
  return {
    key,
    intentId: intent.id,
    itemId: item.id,
    providerId: item.providerId,
    offeringId: item.offeringId,
    providerReference: item.providerReference,
    claimedBy: claim.claimedBy,
    claimToken: claim.claimToken,
    branchId: intent.branchId,
  };
}

function providerUnits(scenario) {
  const claims = new Map(),
    units = [];
  for (const [index, command] of scenario.commands.entries()) {
    const successes =
      command.op === "CLAIM" && !command.error
        ? [{ input: command.input, result: command.result }]
        : command.op === "RACE_CLAIM" && !command.error
          ? command.result.flatMap((r, i) =>
              r.status === "fulfilled"
                ? [{ input: command.input[i], result: r.value }]
                : [],
            )
          : [];
    for (const { input, result } of successes) {
      const owner = identity(command.after, result.providerIdempotencyKey);
      assert.equal(result.intentItemId, owner.itemId);
      assert.ok(result.intentItemIds.includes(input.intentItemId));
      assert.equal(input.intentId, owner.intentId);
      assert.equal(input.claimToken, owner.claimToken);
      assert.equal(result.claimToken, owner.claimToken);
      assert.equal(command.actor.userId, owner.claimedBy);
      assert.equal(command.actor.branchId, owner.branchId);
      assert.equal(
        result.providerIdempotencyKey,
        `digital-issue:${owner.intentId}:${owner.itemId}`,
      );
      claims.set(owner.key, owner);
    }
    if (!["PROVIDER", "PROVIDER_RESTART"].includes(command.op)) continue;
    const request = command.input.request,
      options = command.input.options ?? {};
    assert.equal(request.synthetic, true);
    assert.equal(request.namespace, scenario.name);
    const owner = identity(command.before, request.providerIdempotencyKey);
    assert.deepEqual(
      owner,
      claims.get(owner.key),
      "Provider must use a preceding successful real claim return",
    );
    assert.equal(command.actor.userId, owner.claimedBy);
    assert.equal(command.actor.branchId, owner.branchId);
    assert.equal(request.providerReference, owner.providerReference);
    assert.deepEqual(
      command.after,
      command.before,
      "Provider boundary changed financial rows",
    );
    assert.equal(
      command.providerEvents.length,
      1,
      "Exactly one durable event per provider boundary",
    );
    const event = command.providerEvents[0];
    assert.ok(["ISSUED", "REPLAY"].includes(event.event));
    assert.ok(["SUCCESS", "FAILED"].includes(event.result.status));
    assert.deepEqual(
      event,
      {
        sequence: event.sequence,
        namespace: request.namespace,
        key: owner.key,
        requestHash: digest(request),
        event: event.event,
        result: {
          status: event.result.status,
          providerReference: request.providerReference,
        },
        loseResponse: options.loseResponse ?? false,
      },
      "Provider event must bind exact request hash and payload",
    );
    if (event.event === "ISSUED")
      assert.equal(event.result.status, options.outcome ?? "SUCCESS");
    if (event.loseResponse) {
      assert.equal(command.result, null);
      assert.equal(command.error?.code, "SYNTHETIC_RESPONSE_LOST");
      assert.equal(command.error.message, "SYNTHETIC_PROVIDER_RESPONSE_LOST");
    } else {
      assert.ok(!command.error);
      assert.deepEqual(command.result, {
        ...event.result,
        replay: event.event === "REPLAY",
      });
    }
    units.push({
      scenario: scenario.name,
      commandIndex: index,
      commandHash: digest(command),
      event,
      request,
      identity: owner,
    });
  }
  return units;
}

function descriptor(evidence) {
  return {
    scenarioHashes: evidence.scenarios.map(digest),
    providerLedger: evidence.providerLedger,
    continuedFrom: evidence.continuedFrom,
    interrupted:
      evidence.status === "BLOCKED" &&
      evidence.scenarios.at(-1)?.name === evidence.blocker?.scenario
        ? providerUnits(evidence.scenarios.at(-1))
        : [],
  };
}

function provenance(evidence) {
  let child = descriptor(evidence);
  const retained = [],
    sources = [],
    seen = new Set();
  while (child.continuedFrom) {
    const link = child.continuedFrom,
      absolute = path.resolve(link.path);
    assert.ok(
      absolute.startsWith(resultsRoot),
      "Provenance outside isolated results",
    );
    assert.ok(!seen.has(absolute), "Provenance cycle");
    seen.add(absolute);
    const bytes = readFileSync(absolute),
      sourceHash = sha(bytes);
    assert.equal(
      sourceHash,
      link.sha256,
      "Interrupted provenance source hash mismatch",
    );
    let parent = cache.get(sourceHash);
    if (!parent) {
      parent = descriptor(JSON.parse(bytes));
      cache.set(sourceHash, parent);
    }
    assert.ok(
      Number.isInteger(link.retainedCompletedScenarios) &&
        link.retainedCompletedScenarios >= 0,
    );
    assert.ok(
      link.retainedCompletedScenarios <=
        Math.min(parent.scenarioHashes.length, child.scenarioHashes.length),
    );
    assert.deepEqual(
      child.scenarioHashes.slice(0, link.retainedCompletedScenarios),
      parent.scenarioHashes.slice(0, link.retainedCompletedScenarios),
      "Carried scenario bytes changed",
    );
    assert.deepEqual(
      child.providerLedger.slice(0, parent.providerLedger.length),
      parent.providerLedger,
      "Durable ledger prefix differs from hash-linked prior run",
    );
    retained.push(
      ...parent.interrupted.map((unit) => ({
        ...unit,
        source: link.path,
        sourceHash,
      })),
    );
    sources.push({ path: link.path, sha256: sourceHash });
    child = parent;
  }
  return { retained, sources };
}

export function validateProviderEvidence(evidence) {
  const canonical = evidence.scenarios.flatMap(providerUnits);
  assert.ok(canonical.length > 0, "No captured provider boundary units");
  const { retained, sources } = provenance(evidence);
  const issued = new Map(),
    ledger = evidence.providerLedger;
  for (const [index, event] of ledger.entries()) {
    assert.equal(
      event.sequence,
      index + 1,
      "Ledger sequence missing/duplicated",
    );
    const key = JSON.stringify([event.namespace, event.key]);
    if (event.event === "ISSUED") {
      assert.ok(!issued.has(key), "Duplicate synthetic provider issuance");
      issued.set(key, event);
    } else {
      assert.equal(event.event, "REPLAY");
      const prior = issued.get(key);
      assert.ok(prior, "Replay without durable issue");
      assert.equal(event.requestHash, prior.requestHash);
      assert.deepEqual(event.result, prior.result);
    }
  }
  const covered = new Set();
  for (const unit of canonical) {
    assert.ok(
      !covered.has(unit.event.sequence),
      "Two commands claim the same ledger event",
    );
    assert.deepEqual(
      ledger[unit.event.sequence - 1],
      unit.event,
      "Captured boundary event absent/mutated in ledger",
    );
    covered.add(unit.event.sequence);
  }
  const interrupted = [];
  for (const event of ledger.filter((e) => !covered.has(e.sequence))) {
    const candidates = retained.filter(
      (u) => u.event.sequence === event.sequence,
    );
    assert.ok(candidates.length > 0, "Unproven extra ledger event");
    const unit = candidates[0];
    assert.deepEqual(event, unit.event);
    assert.ok(
      canonical.some(
        (next) =>
          next.event.sequence > event.sequence &&
          next.event.event === "REPLAY" &&
          next.event.namespace === event.namespace &&
          next.event.key === event.key &&
          next.event.requestHash === event.requestHash &&
          digest(next.event.result) === digest(event.result) &&
          digest(next.identity) === digest(unit.identity),
      ),
      "Interrupted issuance lacks canonical replay with identical claim/provider identity",
    );
    interrupted.push(unit);
    covered.add(event.sequence);
  }
  assert.equal(
    covered.size,
    ledger.length,
    "Incomplete provider ledger coverage",
  );
  return {
    issued,
    canonicalUnits: canonical.length,
    interruptedEvents: interrupted,
    sources,
  };
}
