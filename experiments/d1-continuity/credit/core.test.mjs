import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";
import { buildCreditWorker, creditRoot } from "./build.mjs";
import { sqlStatements } from "../cash/sql-statements.mjs";
test("original credit sale and subsequent partial/final CASH collection keep AR, stock, receipts and ledger atomic", async () => {
  await buildCreditWorker({ entry: path.join(creditRoot, "worker.ts") });
  const secret = "synthetic-credit-core-key-only",
    b = path.join(creditRoot, "build");
  const mf = new Miniflare({
    modules: [
      { type: "ESModule", path: path.join(b, "worker.mjs") },
      { type: "CompiledWasm", path: path.join(b, "sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { LAB_TOKEN: secret },
    d1Databases: ["DB", "RECOVERY_LOG"],
    cf: false,
    log: new Log(LogLevel.NONE),
    outboundService: () =>
      new Response("HOSTINGER_UNAVAILABLE", { status: 503 }),
  });
  try {
    const db = await mf.getD1Database("DB"),
      log = await mf.getD1Database("RECOVERY_LOG"),
      run = (d, s) => d.batch(sqlStatements(s).map((v) => d.prepare(v)));
    for (const f of ["schema.sql", "fixture.sql"])
      await run(db, await readFile(path.join(b, f), "utf8"));
    await run(
      db,
      "INSERT INTO customers(id,name,creditLimit,currentBalance) VALUES(1,'Synthetic Credit Buyer','1000.00','0.00') ON CONFLICT(id) DO NOTHING;CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL);INSERT INTO cashSandboxIdentity VALUES('actual-credit-20261018','primary');",
    );
    await run(
      log,
      (
        await readFile(
          path.join(creditRoot, "../cash/journal-schema.sql"),
          "utf8",
        )
      ).replaceAll("actual-cash-20261017", "actual-credit-20261018"),
    );
    const call = async (route, data) => {
      const r = await mf.dispatchFetch("http://credit.test" + route, {
        method: "POST",
        headers: {
          authorization: "Bearer " + secret,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      });
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      return body;
    };
    const saleInput = {
      commandType: "SALE",
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      customerId: 1,
      clientRequestId: "credit-core-sale",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    };
    const sale = await call("/sale", saleInput);
    assert.equal(sale.recoveryAcknowledged, true);
    assert.equal(sale.total, "100.00");
    const row = () =>
      db
        .prepare(
          "SELECT invoiceStatus status,paidAmount FROM invoices WHERE id=?",
        )
        .bind(sale.invoiceId)
        .first();
    assert.deepEqual(await row(), { status: "PENDING", paidAmount: "0.00" });
    assert.equal(
      (
        await db
          .prepare("SELECT currentBalance FROM customers WHERE id=1")
          .first()
      ).currentBalance,
      "100.00",
    );
    assert.equal(
      (await db.prepare("SELECT quantity FROM branchStock WHERE id=1").first())
        .quantity,
      99,
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) n FROM receipts").first()).n,
      0,
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM accountingEntries WHERE entryType='SALE'",
          )
          .first()
      ).n,
      1,
    );
    const pay = {
      commandType: "COLLECT",
      branchId: 1,
      shiftId: 1,
      invoiceId: sale.invoiceId,
      clientRequestId: "credit-core-pay-part",
      method: "CASH",
      amount: "30",
    };
    const partial = await call("/payment", pay);
    assert.equal(partial.recoveryAcknowledged, true);
    assert.deepEqual(await row(), {
      status: "PARTIALLY_PAID",
      paidAmount: "30.00",
    });
    assert.equal(
      (
        await db
          .prepare("SELECT currentBalance FROM customers WHERE id=1")
          .first()
      ).currentBalance,
      "70.00",
    );
    await call("/payment", {
      ...pay,
      clientRequestId: "credit-core-pay-final",
      amount: "70",
    });
    assert.deepEqual(await row(), { status: "PAID", paidAmount: "100.00" });
    assert.equal(
      (
        await db
          .prepare("SELECT currentBalance FROM customers WHERE id=1")
          .first()
      ).currentBalance,
      "0.00",
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) n FROM receipts").first()).n,
      2,
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) n FROM inventoryMovements").first()).n,
      1,
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM accountingEntries WHERE entryType='PAYMENT_IN'",
          )
          .first()
      ).n,
      2,
    );
    const replay = await call("/sale", saleInput);
    assert.equal(replay.invoiceId, sale.invoiceId);
    assert.equal(replay.idempotentReplay, true);
    await call("/payment", pay);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) n FROM receipts").first()).n,
      2,
    );
    await mkdir(path.join(creditRoot, "results"), { recursive: true });
    await writeFile(
      path.join(creditRoot, "results/core.json"),
      JSON.stringify(
        {
          passed: true,
          sale,
          partial,
          invoice: await row(),
          commands: 3,
          receipts: 2,
          stockMovements: 1,
          originalSaleReplayAfterCollection: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await mf.dispose();
  }
});
