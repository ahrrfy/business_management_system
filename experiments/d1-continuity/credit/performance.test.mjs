import test from "node:test";
import assert from "node:assert/strict";
import { nativeLab, saleInput } from "./native.mjs";
test("credit protocol removes sequential RPCs while retaining exact saved rejected keys and identities", async () => {
  const l = await nativeLab({ coordinated: true, name: "perf-contract" });
  try {
    const input = saleInput("credit-perf-rpc-contract", { customerId: 5 }),
      s = await l.ok(l.source, "/sale", input);
    assert.ok(s.profile.rpcCount <= 5, JSON.stringify(s.profile));
    assert.equal(s.profile.stateRead.mode, "CREDIT_SCOPED");
    assert.ok(s.profile.stateRead.totalRows > 0);
    assert.ok(s.profile.sqlCount <= 48);
    assert.equal((await l.call(l.source, "/sale", input, "", "2")).status, 409);
    const p = {
        commandType: "COLLECT",
        branchId: 1,
        shiftId: 1,
        invoiceId: s.body.invoiceId,
        clientRequestId: "credit-perf-rpc-payment",
        method: "CASH",
        amount: "40",
      },
      r = await l.ok(l.source, "/payment", p);
    assert.ok(r.profile.rpcCount <= 5, JSON.stringify(r.profile));
    assert.equal(r.profile.stateRead.rows.invoices, 1);
    const rejected = saleInput("credit-perf-rejected-key", { customerId: 4 });
    assert.equal((await l.call(l.source, "/sale", rejected)).status, 403);
    assert.equal(
      (await l.call(l.source, "/sale", { ...rejected, customerId: 5 })).status,
      409,
    );
    assert.equal((await l.call(l.source, "/sale", rejected)).status, 403);
    const counts = async () => ({
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
    for (const [db, table] of [
      [l.db, "cashSandboxIdentity"],
      [l.journal, "cashJournalIdentity"],
    ]) {
      const before = await counts();
      await db.prepare("UPDATE " + table + " SET id='wrong'").run();
      assert.equal(
        (
          await l.call(
            l.source,
            "/sale",
            saleInput("credit-bad-" + table, { customerId: 5 }),
          )
        ).status,
        503,
      );
      assert.deepEqual(await counts(), before);
      await db
        .prepare("UPDATE " + table + " SET id=?")
        .bind("actual-credit-20261018")
        .run();
    }
    for (const fault of ["drop-merged-response", "merged-last-statement"]) {
      const request = saleInput("credit-" + fault, { customerId: 5 }),
        before = (await l.db.prepare("SELECT epoch FROM cashEpoch").first())
          .epoch,
        r = await l.call(l.source, "/sale", request, fault);
      assert.equal(r.status, 503, JSON.stringify(r));
      assert.equal(
        (await l.db.prepare("SELECT epoch FROM cashEpoch").first()).epoch,
        before,
      );
      assert.equal(
        (
          await l.journal
            .prepare(
              "SELECT COUNT(*) n FROM cashJournalCommitted WHERE requestId=?",
            )
            .bind(request.clientRequestId)
            .first()
        ).n,
        0,
      );
      await l.ok(l.source, "/sale", request);
      await l.ok(l.second, "/sale", request);
    }
    await l.db
      .prepare("UPDATE customers SET notes=?,address=? WHERE id=5")
      .bind("N".repeat(60000), "A".repeat(60000))
      .run();
    await l.db.prepare("UPDATE doubleEntrySettings SET mode='ACTIVE'").run();
    const replay = await l.ok(l.source, "/sale", input);
    assert.equal(replay.body.invoiceId, s.body.invoiceId);
    assert.equal(replay.profile.stateRead, null);
    await l.db.prepare("UPDATE doubleEntrySettings SET mode='OFF'").run();
    await l.db
      .prepare("UPDATE customers SET notes=NULL,address=NULL WHERE id=5")
      .run();
    assert.equal(l.outbound.length, 0);
  } finally {
    await l.close();
  }
});
test("a snapshot superseded after the atomic preflight cannot spend stale customer headroom", async () => {
  const l = await nativeLab({ coordinated: true, name: "perf-stale" });
  try {
    const r = await l.call(
      l.source,
      "/sale",
      saleInput("credit-stale-prefetched", { customerId: 5 }),
      "stale-preloaded",
    );
    assert.equal(r.status, 409, JSON.stringify(r));
    assert.equal(
      (await l.db.prepare("SELECT COUNT(*) n FROM invoices").first()).n,
      0,
    );
    assert.equal(
      (
        await l.db
          .prepare("SELECT currentBalance FROM customers WHERE id=5")
          .first()
      ).currentBalance,
      "80.00",
    );
    assert.equal(
      (
        await l.journal
          .prepare("SELECT COUNT(*) n FROM cashJournalCommitted")
          .first()
      ).n,
      0,
    );
  } finally {
    await l.close();
  }
});
