import test from "node:test";
import assert from "node:assert/strict";
import { nativeLab, saleInput } from "./native.mjs";
test("an actor expiring during predecessor ACK cannot commit an eagerly calculated return", async () => {
  const l = await nativeLab({ coordinated: true, name: "perf-prepare-expiry" });
  const ns = await l.source.getDurableObjectNamespace(
    "CREDIT_WRITER",
    "primary",
  );
  const control = async (p) =>
    (
      await ns
        .get(ns.idFromName("actual-credit-20261018:primary:writer-v1"))
        .fetch("http://credit.test" + p)
    ).json();
  const until = async (check) => {
    for (let i = 0; i < 300; i++) {
      const s = await control("/test-state");
      if (check(s)) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("EXPIRY_PREPARATION_NOT_READY");
  };
  let a, b;
  try {
    const sale = await l.ok(
      l.source,
      "/sale",
      saleInput("prepare-expiry-sale", {
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
    const expiry = new Date(Date.now() + 2500)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    await l.db
      .prepare("UPDATE users SET accessExpiresAt=? WHERE id=1")
      .bind(expiry)
      .run();
    const input = {
      commandType: "RETURN",
      branchId: 1,
      shiftId: 1,
      invoiceId: sale.body.invoiceId,
      clientRequestId: "prepare-expiry-first",
      operatorReason: "expiry boundary proof",
      restock: true,
      lines: [{ invoiceItemId: item.id, baseQuantity: 1 }],
      refund: { method: "CASH", amount: "100", shiftId: 1 },
    };
    a = l.call(l.source, "/return", input, "hold-journal");
    const waiting = await until((s) => s.waiting);
    b = l.call(l.second, "/return", {
      ...input,
      clientRequestId: "prepare-expiry-next",
    });
    await until((s) => s.preparations === waiting.preparations + 1);
    await new Promise((r) =>
      setTimeout(
        r,
        Math.max(
          0,
          Date.parse(expiry.replace(" ", "T") + "Z") - Date.now() + 50,
        ),
      ),
    );
    await control("/test-release");
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 403);
    assert.equal(
      (await l.db.prepare("SELECT COUNT(*) n FROM cashCommands").first()).n,
      2,
    );
  } finally {
    await control("/test-release").catch(() => {});
    await Promise.allSettled([a, b]);
    await l.close();
  }
});
for (const fault of ["hold-journal", "hold-then-fail-ack"])
  test(
    "private return calculation overlaps predecessor ACK without another financial or journal write: " +
      fault,
    async () => {
      const l = await nativeLab({
        coordinated: true,
        name: "perf-prepare-" + fault,
      });
      const ns = await l.source.getDurableObjectNamespace(
        "CREDIT_WRITER",
        "primary",
      );
      const control = async (p) =>
        (
          await ns
            .get(ns.idFromName("actual-credit-20261018:primary:writer-v1"))
            .fetch("http://credit.test" + p)
        ).json();
      const until = async (check) => {
        for (let i = 0; i < 300; i++) {
          const s = await control("/test-state");
          if (check(s)) return s;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error("PRIVATE_PREPARATION_NOT_READY");
      };
      let a, b;
      try {
        const sale = await l.ok(
          l.source,
          "/sale",
          saleInput("prepare-overlap-sale", {
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
          clientRequestId: "prepare-overlap-first",
          operatorReason: "private calculation overlap",
          restock: true,
          lines: [{ invoiceItemId: item.id, baseQuantity: 1 }],
          refund: { method: "CASH", amount: "100", shiftId: 1 },
        };
        a = l.call(l.source, "/return", input, fault);
        const waiting = await until((s) => s.waiting);
        const next = { ...input, clientRequestId: "prepare-overlap-next" };
        b = l.call(l.second, "/return", next);
        await until((s) => s.preparations === waiting.preparations + 1);
        assert.equal(
          (await l.db.prepare("SELECT COUNT(*) n FROM cashCommands").first()).n,
          2,
        );
        assert.equal(
          (
            await l.journal
              .prepare("SELECT COUNT(*) n FROM cashJournalRequests")
              .first()
          ).n,
          2,
        );
        assert.equal(
          (
            await l.journal
              .prepare("SELECT COUNT(*) n FROM cashJournalCommitted")
              .first()
          ).n,
          1,
        );
        await control("/test-release");
        const replies = await Promise.all([a, b]);
        if (fault === "hold-then-fail-ack") {
          assert.deepEqual(
            replies.map((r) => r.status),
            [503, 503],
          );
          assert.equal(
            (await l.db.prepare("SELECT COUNT(*) n FROM cashCommands").first())
              .n,
            2,
          );
          await l.ok(l.source, "/return", input);
          await l.ok(l.source, "/return", next);
        } else
          assert.deepEqual(
            replies.map((r) => r.status),
            [200, 200],
          );
        assert.equal(
          (await l.db.prepare("SELECT COUNT(*) n FROM cashCommands").first()).n,
          3,
        );
        assert.equal(
          (
            await l.journal
              .prepare("SELECT COUNT(*) n FROM cashJournalCommitted")
              .first()
          ).n,
          3,
        );
        assert.equal(
          (
            await l.db
              .prepare("SELECT quantity FROM branchStock WHERE id=1")
              .first()
          ).quantity,
          100,
        );
      } finally {
        await control("/test-release").catch(() => {});
        await Promise.allSettled([a, b]);
        await l.close();
      }
    },
  );
