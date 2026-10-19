import test from "node:test";
import assert from "node:assert/strict";
import { setupLab, oracle, wire } from "./native-support.mjs";
test("ACTIVE missing approval is inert; acknowledged key survives changed policy/map and rejects actor drift", async () => {
  const l = await setupLab("accounting-admission");
  try {
    const baseline = oracle.scenarios.find(
      (s) => s.name === "ACTIVE-credit-unpaid",
    );
    await l.seed(baseline.commands[0].before);
    const input = wire(baseline.commands[0].input);
    await l.db
      .prepare(
        "UPDATE doubleEntrySettings SET policyApprovalReference=NULL WHERE id=1",
      )
      .run();
    const before = await l.graph(),
      missing = await l.call(l.source, "/sale", input);
    assert.notEqual(missing.status, 200);
    assert.equal(
      missing.body.message,
      oracle.scenarios[0].commands[0].error.message,
    );
    assert.deepEqual(await l.graph(), before);
    await l.db
      .prepare(
        "UPDATE doubleEntrySettings SET policyApprovalReference=? WHERE id=1",
      )
      .bind(
        baseline.commands[0].before.doubleEntrySettings[0]
          .policyApprovalReference,
      )
      .run();
    const original = await l.ok(l.source, "/sale", input);
    await l.db
      .prepare(
        "UPDATE doubleEntrySettings SET policyApprovalPolicyHash='changed-current-policy' WHERE id=1",
      )
      .run();
    await l.db
      .prepare(
        "DELETE FROM statutoryAccountMappings WHERE internalAccountId IN(SELECT id FROM accounts WHERE systemRole=?)",
      )
      .bind("AR")
      .run();
    const committed = await l.graph(),
      replay = await l.ok(l.source, "/sale", input);
    for (const [key, value] of Object.entries(original.body))
      if (key !== "idempotentReplay") assert.deepEqual(replay.body[key], value);
    assert.equal(replay.body.idempotentReplay, true);
    assert.deepEqual(await l.graph(), committed);
    assert.equal((await l.call(l.source, "/sale", input, "", "2")).status, 409);
    assert.deepEqual(await l.graph(), committed);
    assert.equal(l.outbound.length, 0);
  } finally {
    await l.close();
  }
});
