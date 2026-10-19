import test from "node:test";
import assert from "node:assert/strict";
import { nativeLab, saleInput } from "./native.mjs";
import { readPagedSnapshot } from "../cash/paged-client.mjs";

test("sale and collection omit drawer history; a return reads only its invoice ledger and the complete drawer receipts", async () => {
  const l = await nativeLab({ coordinated: true, name: "perf-scoped-history" });
  try {
    const sale = saleInput("perf-scope-first", {
      commandType: "CASH_SALE",
      customerId: 5,
      payment: { method: "CASH", amount: "100" },
    });
    const first = await l.ok(l.source, "/sale", sale);
    const second = await l.ok(l.source, "/sale", {
      ...sale,
      clientRequestId: "perf-scope-other",
    });
    assert.equal(second.profile.stateRead.rows.receipts, 0);
    assert.equal(second.profile.stateRead.rows.accountingEntries, 0);
    const item = await l.db
      .prepare("SELECT id FROM invoiceItems WHERE invoiceId=?")
      .bind(first.body.invoiceId)
      .first();
    const ledger = await l.db
      .prepare(
        "SELECT COUNT(*) n FROM accountingEntries WHERE invoiceId=? OR receiptId IN(SELECT id FROM receipts WHERE invoiceId=?)",
      )
      .bind(first.body.invoiceId, first.body.invoiceId)
      .first();
    const returned = await l.ok(l.source, "/return", {
      commandType: "RETURN",
      branchId: 1,
      shiftId: 1,
      invoiceId: first.body.invoiceId,
      clientRequestId: "perf-scope-return",
      operatorReason: "scoped history proof",
      restock: true,
      lines: [{ invoiceItemId: item.id, baseQuantity: 1 }],
      refund: { method: "CASH", amount: "100", shiftId: 1 },
    });
    assert.equal(returned.profile.stateRead.rows.accountingEntries, ledger.n);
    assert.equal(returned.profile.stateRead.rows.receipts, 2);
  } finally {
    await l.close();
  }
});

test("confirmed returns replay in two reads without reserving or rewriting recovery records", async () => {
  const l = await nativeLab({ coordinated: true, name: "perf-replay" });
  try {
    const sale = await l.ok(
      l.source,
      "/sale",
      saleInput("perf-replay-sale", {
        commandType: "CASH_SALE",
        customerId: 5,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { method: "CASH", amount: "200" },
      }),
    );
    const item = await l.db
      .prepare("SELECT id FROM invoiceItems WHERE invoiceId=?")
      .bind(sale.body.invoiceId)
      .first();
    const input = {
      commandType: "RETURN",
      branchId: 1,
      shiftId: 1,
      invoiceId: sale.body.invoiceId,
      clientRequestId: "perf-replay-return",
      operatorReason: "synthetic replay performance",
      restock: true,
      lines: [{ invoiceItemId: item.id, baseQuantity: 1 }],
      refund: { method: "CASH", amount: "100", shiftId: 1 },
    };
    const first = await l.ok(l.source, "/return", input);
    await l.ok(l.source, "/return", {
      ...input,
      clientRequestId: "perf-replay-later",
    });
    // Current authorization no longer permits a new return. A retry must still
    // recover the immutable original result, before current business validation.
    await l.db.prepare("UPDATE users SET isActive=0 WHERE id=1").run();
    const before = await readPagedSnapshot(l.call, l.source);
    const journal = () =>
      l.journal
        .prepare(
          "SELECT (SELECT COUNT(*) FROM cashJournalRequests) AS requests,(SELECT COUNT(*) FROM cashJournalAttempts) AS attempts,(SELECT COUNT(*) FROM cashJournalCommitted) AS committed",
        )
        .first();
    const counts = await journal();
    const replay = await l.ok(l.source, "/return", input);
    assert.deepEqual(replay.body, { ...first.body, idempotentReplay: true });
    assert.equal(replay.profile.rpcCount, 2, JSON.stringify(replay.profile));
    assert.equal(replay.profile.sqlCount, 7);
    assert.deepEqual(await journal(), counts);
    assert.deepEqual(await readPagedSnapshot(l.call, l.source), before);
    assert.equal(
      (await l.call(l.source, "/return", { ...input, restock: false })).status,
      409,
    );
    assert.deepEqual(await journal(), counts);

    // Inject corruption only in this disposable database and restore all six
    // append-only guards before issuing the request. Prefix validation alone
    // must not allow a corrupted historical ACK to become a successful retry.
    const guards = (
      await l.journal
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='cashJournalCommitted'",
        )
        .all()
    ).results;
    for (const g of guards)
      await l.journal.prepare(`DROP TRIGGER "${g.name}"`).run();
    await l.journal
      .prepare("UPDATE cashJournalCommitted SET signature=? WHERE requestId=?")
      .bind("0".repeat(64), input.clientRequestId)
      .run();
    for (const g of guards) await l.journal.prepare(g.sql).run();
    const corrupt = await l.call(l.source, "/return", input);
    assert.equal(corrupt.status, 503, JSON.stringify(corrupt));
    assert.equal(corrupt.body.code, "RECOVERY_ACK_INVALID_RETRY_SAME_REQUEST");
    const corruptRead = await l.call(
      l.source,
      "/return",
      input,
      "",
      "",
      "",
      true,
    );
    assert.equal(corruptRead.status, 503);
    assert.equal(
      corruptRead.body.code,
      "RECOVERY_ACK_INVALID_RETRY_SAME_REQUEST",
    );
    assert.deepEqual(await readPagedSnapshot(l.call, l.source), before);
  } finally {
    await l.close();
  }
});

test("a confirmed retry reads its signed result while another writer awaits ACK; unconfirmed retries still use the writer", async () => {
  const l = await nativeLab({
    coordinated: true,
    name: "perf-independent-replay",
  });
  let held;
  const ns = await l.source.getDurableObjectNamespace(
    "CREDIT_WRITER",
    "primary",
  );
  const control = async (route) =>
    (
      await ns
        .get(ns.idFromName("actual-credit-20261018:primary:writer-v1"))
        .fetch("http://credit.test" + route)
    ).json();
  try {
    const sale = saleInput("perf-readonly-sale", {
      commandType: "CASH_SALE",
      customerId: 5,
      payment: { method: "CASH", amount: "100" },
    });
    const first = await l.ok(l.source, "/sale", sale);
    held = l.call(
      l.source,
      "/sale",
      { ...sale, clientRequestId: "perf-held-sale" },
      "hold-journal",
    );
    for (let i = 0; !(await control("/test-state")).waiting; i++) {
      assert.ok(i < 100);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const replay = await l.ok(l.source, "/sale", sale, "", "", "", true);
    assert.equal(replay.confirmedRead, true);
    assert.deepEqual(replay.body, { ...first.body, idempotentReplay: true });
    assert.equal((await control("/test-state")).pending, 1);
    assert.equal(
      (
        await l.journal
          .prepare("SELECT COUNT(*) n FROM cashJournalCommitted")
          .first()
      ).n,
      1,
    );
    await control("/test-release");
    assert.equal((await held).status, 200);
    const fresh = await l.ok(
      l.source,
      "/sale",
      { ...sale, clientRequestId: "perf-unconfirmed-retry" },
      "",
      "",
      "",
      true,
    );
    assert.equal(fresh.confirmedRead, false);
    assert.ok(fresh.writer);
    assert.equal(fresh.body.idempotentReplay, false);
    const pending = { ...sale, clientRequestId: "perf-read-repair-original" };
    assert.equal(
      (await l.call(l.source, "/sale", pending, "after-primary")).status,
      503,
    );
    const repaired = await l.ok(l.source, "/sale", pending, "", "", "", true);
    assert.equal(repaired.confirmedRead, false);
    assert.equal(repaired.body.recoveryAcknowledged, true);
    assert.equal(repaired.body.idempotentReplay, true);
  } finally {
    await control("/test-release").catch(() => {});
    if (held) await held;
    await l.close();
  }
});
