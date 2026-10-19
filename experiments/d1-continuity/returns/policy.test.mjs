import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { nativeLab, saleInput } from "./native.mjs";
import { readPagedSnapshot } from "../cash/paged-client.mjs";
const input = (invoiceId, itemId, key, patch = {}) => ({
  commandType: "RETURN",
  branchId: 1,
  shiftId: 1,
  invoiceId,
  clientRequestId: key,
  operatorReason: "synthetic policy return",
  restock: true,
  lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
  ...patch,
});
const item = async (l, id) =>
  (
    await l.db
      .prepare("SELECT id FROM invoiceItems WHERE invoiceId=?")
      .bind(id)
      .first()
  ).id;
test("actual returns enforce current authority, drawer, quantity, dependency and period policy atomically", async () => {
  const l = await nativeLab({
      coordinated: true,
      multipleCashiers: true,
      name: "policy",
    }),
    proofs = [];
  try {
    const s = (
      await l.ok(
        l.source,
        "/sale",
        saleInput("ret-policy-sale", {
          commandType: "CASH_SALE",
          customerId: 5,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
          payment: { method: "CASH", amount: "200" },
        }),
      )
    ).body;
    const base = input(
      s.invoiceId,
      await item(l, s.invoiceId),
      "ret-policy-default",
      { refund: { method: "CASH", amount: "100", shiftId: 1 } },
    );
    const reject = async (name, patch, status, setup, teardown) => {
      if (setup) await l.db.prepare(setup).run();
      const before = await readPagedSnapshot(l.call, l.source);
      const result = await l.call(l.source, "/return", {
        ...base,
        clientRequestId: "ret-policy-" + name,
        ...patch,
      });
      assert.equal(result.status, status, JSON.stringify(result.body));
      assert.deepEqual(
        await readPagedSnapshot(l.call, l.source),
        before,
        name + " no partial effects",
      );
      proofs.push({ name, status, code: result.body.code });
      if (teardown) await l.db.prepare(teardown).run();
    };
    await reject(
      "quantity",
      {
        lines: [
          { invoiceItemId: base.lines[0].invoiceItemId, baseQuantity: 3 },
        ],
      },
      400,
    );
    await reject(
      "duplicate-lines",
      { lines: [...base.lines, ...base.lines] },
      400,
    );
    await reject(
      "closed-drawer",
      {},
      412,
      "UPDATE shifts SET shiftStatus='CLOSED',openGuard=NULL WHERE id=1",
      "UPDATE shifts SET shiftStatus='OPEN',openGuard='1:1:RETAIL' WHERE id=1",
    );
    await reject(
      "inactive",
      {},
      403,
      "UPDATE users SET isActive=0 WHERE id=1",
      "UPDATE users SET isActive=1 WHERE id=1",
    );
    await reject(
      "insufficient-drawer",
      {},
      412,
      "UPDATE shifts SET openingBalance='-200.00' WHERE id=1",
      "UPDATE shifts SET openingBalance='0.00' WHERE id=1",
    );
    await reject(
      "over-refund",
      { refund: { method: "CASH", amount: "300", shiftId: 1 } },
      412,
    );
    await reject(
      "service-product",
      {},
      422,
      "UPDATE products SET isService=1 WHERE id=1",
      "UPDATE products SET isService=0 WHERE id=1",
    );
    await reject(
      "pending-control",
      {},
      409,
      "INSERT INTO returnRequests(invoiceId,branchId,linesJson,reason,invoiceReturnedSnapshot,createdBy) VALUES(" +
        s.invoiceId +
        ",1,'[]','synthetic pending','0.00',1)",
      "UPDATE returnRequests SET returnRequestStatus='REJECTED' WHERE invoiceId=" +
        s.invoiceId,
    );
    await reject(
      "locked-period",
      {},
      403,
      "INSERT INTO financialPeriods(cutoffDate,lockedBy) VALUES('2099-01-01',1)",
      "UPDATE financialPeriods SET periodStatus='ARCHIVED'",
    );
    await reject(
      "workorder-dependency",
      {},
      422,
      "INSERT INTO workOrders(orderNumber,branchId,title,invoiceId,createdBy) VALUES('synthetic-dependency',1,'synthetic'," +
        s.invoiceId +
        ",1)",
      "UPDATE workOrders SET invoiceId=NULL WHERE orderNumber='synthetic-dependency'",
    );
    const walk = (
      await l.ok(
        l.source,
        "/sale",
        saleInput("ret-implicit-drawer-sale", {
          commandType: "CASH_SALE",
          customerId: undefined,
          payment: { method: "CASH", amount: "100" },
        }),
      )
    ).body;
    const walkItem = await item(l, walk.invoiceId);
    await reject(
      "implicit-walkin-drawer",
      {
        invoiceId: walk.invoiceId,
        lines: [{ invoiceItemId: walkItem, baseQuantity: 1 }],
        refund: undefined,
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "100",
          reason: "synthetic",
          disposition: "RESTOCK",
        },
      },
      400,
      "INSERT INTO shifts(id,userId,branchId,shiftStatus,shiftType,openingBalance,openGuard) VALUES(21,1,1,'OPEN','RECEPTION','0.00','1:1:RECEPTION')",
      "UPDATE shifts SET shiftStatus='CLOSED',openGuard=NULL WHERE id=21",
    );
    await l.ok(
      l.source,
      "/return",
      input(walk.invoiceId, walkItem, "ret-explicit-walkin-drawer", {
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "100",
          shiftId: 1,
          reason: "synthetic",
          disposition: "RESTOCK",
        },
      }),
    );
    const target = await l.ok(l.source, "/return", base);
    assert.equal(target.body.fullyReturned, false);
    const state = await readPagedSnapshot(l.call, l.source);
    assert.equal(
      (await l.call(l.second, "/return", { ...base, restock: false })).status,
      409,
    );
    assert.deepEqual(await readPagedSnapshot(l.call, l.source), state);
    const evidence = await l.ok(l.source, "/evidence?invoiceId=" + s.invoiceId);
    assert.equal(evidence.body.invoice.returnedTotal, "100.00");
    assert.equal(evidence.body.items[0].returnedRestockedBaseQuantity, 1);
    const credited = (
      await l.ok(
        l.source,
        "/sale",
        saleInput("ret-customer-credit-sale", {
          commandType: "CASH_SALE",
          customerId: 5,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
          payment: { method: "CASH", amount: "200" },
        }),
      )
    ).body;
    const creditItem = await item(l, credited.invoiceId);
    await l.ok(
      l.source,
      "/return",
      input(credited.invoiceId, creditItem, "ret-customer-credit-partial"),
    );
    const creditEvidence = (
      await l.ok(l.source, "/evidence?invoiceId=" + credited.invoiceId)
    ).body;
    assert.equal(creditEvidence.invoice.currentTotal, "100.00");
    assert.equal(creditEvidence.invoice.remainingAmount, "0.00");
    assert.equal(creditEvidence.customer.balance, "-100.00");
    await l.ok(
      l.source,
      "/return",
      input(credited.invoiceId, creditItem, "ret-customer-credit-final"),
    );
    const finalEvidence = (
      await l.ok(l.source, "/evidence?invoiceId=" + credited.invoiceId)
    ).body;
    assert.equal(finalEvidence.invoice.currentTotal, "0.00");
    assert.equal(finalEvidence.invoice.remainingAmount, "0.00");
    assert.equal(finalEvidence.customer.balance, "-200.00");
    assert.equal(finalEvidence.receiptCount, 1);
    await writeFile(
      "experiments/d1-continuity/returns/results/policy.json",
      JSON.stringify({ passed: true, proofs }, null, 2),
    );
  } finally {
    await l.close();
  }
});
test("concurrent collection and return, then two-line full cash return preserve every effect", async () => {
  const l = await nativeLab({
    coordinated: true,
    multipleCashiers: true,
    name: "collection-race",
  });
  try {
    const s = (
        await l.ok(
          l.source,
          "/sale",
          saleInput("ret-collection-race-sale", {
            customerId: 5,
            lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
          }),
        )
      ).body,
      id = await item(l, s.invoiceId);
    await Promise.all([
      l.ok(
        l.source,
        "/return",
        input(s.invoiceId, id, "ret-collection-race-return"),
      ),
      l.ok(l.second, "/payment", {
        commandType: "COLLECT",
        branchId: 1,
        shiftId: 1,
        invoiceId: s.invoiceId,
        clientRequestId: "ret-collection-race-collect",
        method: "CASH",
        amount: "100",
      }),
    ]);
    assert.equal(
      (
        await l.db
          .prepare("SELECT currentBalance FROM customers WHERE id=5")
          .first()
      ).currentBalance,
      "0.00",
    );
    await l.ok(
      l.source,
      "/return",
      input(s.invoiceId, id, "ret-collection-race-final", {
        refund: { method: "CASH", amount: "100", shiftId: 1 },
      }),
    );
    const multi = (
      await l.ok(
        l.source,
        "/sale",
        saleInput("ret-two-line-cash-sale", {
          commandType: "CASH_SALE",
          customerId: 5,
          lines: [
            { variantId: 1, productUnitId: 1, quantity: "1" },
            { variantId: 2, productUnitId: 2, quantity: "1" },
          ],
          payment: { method: "CASH", amount: "180" },
        }),
      )
    ).body;
    const rows = (
      await l.db
        .prepare("SELECT id FROM invoiceItems WHERE invoiceId=? ORDER BY id")
        .bind(multi.invoiceId)
        .all()
    ).results;
    const r = await l.ok(
      l.source,
      "/return",
      input(multi.invoiceId, rows[0].id, "ret-two-line-cash-return", {
        lines: rows.map((i) => ({ invoiceItemId: i.id, baseQuantity: 1 })),
        refund: { method: "CASH", amount: "180", shiftId: 1 },
      }),
    );
    assert.equal(r.body.returnedTotal, "180.00");
    assert.ok(r.profile.sqlCount <= 48);
    assert.deepEqual(
      (await l.db.prepare("SELECT quantity FROM branchStock ORDER BY id").all())
        .results,
      [{ quantity: 100 }, { quantity: 50 }],
    );
    assert.equal(
      (
        await l.db
          .prepare("SELECT currentBalance FROM customers WHERE id=5")
          .first()
      ).currentBalance,
      "0.00",
    );
    await writeFile(
      "experiments/d1-continuity/returns/results/collection-race.json",
      JSON.stringify(
        {
          passed: true,
          concurrentReturnAndCollection: true,
          twoLineCashReturnSql: r.profile.sqlCount,
        },
        null,
        2,
      ),
    );
  } finally {
    await l.close();
  }
});
