import test from "node:test";
import assert from "node:assert/strict";
import { nativeLab, saleInput } from "./native.mjs";
const controls = async (l) => {
  const ns = await l.source.getDurableObjectNamespace(
    "CREDIT_WRITER",
    "primary",
  );
  return async (p) =>
    (
      await ns
        .get(ns.idFromName("actual-credit-20261018:primary:writer-v1"))
        .fetch("http://credit.test" + p)
    ).json();
};
const until = async (control, predicate) => {
  for (let i = 0; i < 500; i++) {
    const s = await control("/test-state");
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("PIPELINE_BARRIER_TIMEOUT");
};
test("native successor reads during independent ACK but cannot write; four cashier identities preserve exact sale/collection trails", async () => {
  const l = await nativeLab({
    coordinated: true,
    multipleCashiers: true,
    name: "pipeline-native",
  });
  try {
    const control = await controls(l),
      inputs = [11, 12, 13, 14].map((id) =>
        saleInput("pipeline-cashier-" + id, { customerId: 5, shiftId: id }),
      );
    for (const terminal of [11, 12, 13, 14])
      assert.equal(
        (await l.ok(l.source, "/ready", undefined, "", "", String(terminal)))
          .body.ready,
        true,
      );
    assert.equal(
      (await l.db.prepare("SELECT epoch FROM cashEpoch").first()).epoch,
      1,
    );
    assert.equal(
      (
        await l.journal
          .prepare("SELECT COUNT(*) n FROM cashJournalRequests")
          .first()
      ).n,
      0,
    );
    const a = l.call(l.source, "/sale", inputs[0], "hold-journal", "", "11");
    await until(control, (s) => s.waiting);
    const b = l.call(l.second, "/sale", inputs[1], "", "", "12"),
      c = l.call(l.source, "/sale", inputs[2], "", "", "13"),
      d = l.call(l.second, "/sale", inputs[3], "", "", "14");
    await until(control, (s) => s.pending === 4 && s.primaryReads === 2);
    assert.equal(
      (await l.db.prepare("SELECT COUNT(*) n FROM invoices").first()).n,
      1,
    );
    assert.equal(
      (
        await l.journal
          .prepare("SELECT COUNT(*) n FROM cashJournalCommitted")
          .first()
      ).n,
      0,
    );
    assert.equal(
      (
        await l.journal
          .prepare("SELECT COUNT(*) n FROM cashJournalRequests")
          .first()
      ).n,
      1,
    );
    await control("/test-release");
    const replies = await Promise.all([a, b, c, d]);
    assert.ok(
      replies.every((r) => r.status === 200),
      JSON.stringify(replies),
    );
    assert.ok(replies.every((r) => r.profile.rpcCount === 4));
    assert.ok(replies.slice(1).every((r) => r.writer.lookahead));
    assert.deepEqual(
      (
        await l.db.prepare("SELECT shiftId FROM invoices ORDER BY id").all()
      ).results.map((r) => r.shiftId),
      [11, 12, 13, 14],
    );
    for (let i = 0; i < 4; i++) {
      const terminal = String(11 + i),
        invoiceId = replies[i].body.invoiceId;
      for (const [k, amount] of [
        ["part", "40"],
        ["final", "60"],
      ]) {
        const p = {
          commandType: "COLLECT",
          branchId: 1,
          shiftId: 11 + i,
          invoiceId,
          clientRequestId: "pipeline-pay-" + i + "-" + k,
          method: "CASH",
          amount,
        };
        const copies = await Promise.all([
          l.call(l.source, "/payment", p, "", "", terminal),
          l.call(l.second, "/payment", p, "", "", terminal),
        ]);
        assert.ok(
          copies.every((r) => r.status === 200),
          JSON.stringify(copies),
        );
        assert.equal(
          copies[0].body.recoveryEpoch,
          copies[1].body.recoveryEpoch,
        );
      }
    }
    assert.equal(
      (
        await l.db
          .prepare("SELECT currentBalance FROM customers WHERE id=5")
          .first()
      ).currentBalance,
      "0.00",
    );
    assert.equal(
      (await l.db.prepare("SELECT COUNT(*) n FROM receipts").first()).n,
      8,
    );
    assert.equal(
      (
        await l.db
          .prepare(
            "SELECT COUNT(*) n FROM invoices WHERE invoiceStatus='PAID' AND paidAmount='100.00'",
          )
          .first()
      ).n,
      4,
    );
    assert.equal(
      (await l.call(l.source, "/sale", inputs[0], "", "", "12")).status,
      409,
    );
    assert.equal(l.outbound.length, 0);
  } finally {
    await l.close();
  }
});
test("failed predecessor ACK invalidates a native already-read successor; original-key retries recover exactly once", async () => {
  const l = await nativeLab({ coordinated: true, name: "pipeline-uncertain" });
  try {
    const control = await controls(l),
      one = saleInput("pipeline-unknown-first", { customerId: 5 }),
      two = saleInput("pipeline-unknown-next", { customerId: 5 });
    const a = l.call(l.source, "/sale", one, "hold-then-fail-ack");
    await until(control, (s) => s.waiting);
    const b = l.call(l.second, "/sale", two);
    await until(control, (s) => s.primaryReads === 2);
    await control("/test-release");
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 503);
    assert.equal(rb.status, 503);
    assert.equal(rb.body.code, "LOOKAHEAD_PREDECESSOR_UNCONFIRMED");
    assert.equal(
      (await l.db.prepare("SELECT COUNT(*) n FROM invoices").first()).n,
      1,
    );
    await l.ok(l.source, "/sale", one);
    await l.ok(l.second, "/sale", two);
    await l.ok(l.source, "/sale", two);
    assert.equal(
      (await l.db.prepare("SELECT COUNT(*) n FROM invoices").first()).n,
      2,
    );
    assert.equal(
      (
        await l.journal
          .prepare("SELECT COUNT(*) n FROM cashJournalCommitted")
          .first()
      ).n,
      2,
    );
  } finally {
    await l.close();
  }
});
test("guarded merged batch rejects wrong identity or missing prefix guards even with prior matching reservation/attempt", async () => {
  for (const fault of ["identity", "guard"]) {
    const l = await nativeLab({
      coordinated: true,
      name: "pipeline-proof-" + fault,
    });
    try {
      const input = saleInput("pipeline-existing-proof-" + fault, {
        customerId: 5,
      });
      assert.equal(
        (await l.call(l.source, "/sale", input, "after-prepare")).status,
        503,
      );
      const control = await controls(l);
      try {
        await control("/test-reset");
      } catch {}
      const count = async () => ({
        requests: (
          await l.journal
            .prepare("SELECT COUNT(*) n FROM cashJournalRequests")
            .first()
        ).n,
        attempts: (
          await l.journal
            .prepare("SELECT COUNT(*) n FROM cashJournalAttempts")
            .first()
        ).n,
      });
      const before = await count();
      if (fault === "identity")
        await l.journal
          .prepare("UPDATE cashJournalIdentity SET id='wrong'")
          .run();
      else await l.journal.prepare("DROP TRIGGER cashJournalHead_guard").run();
      assert.equal((await l.call(l.source, "/sale", input)).status, 503);
      assert.deepEqual(await count(), before);
      assert.equal(
        (await l.db.prepare("SELECT COUNT(*) n FROM invoices").first()).n,
        0,
      );
    } finally {
      await l.close();
    }
  }
});
