import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeLab, saleInput } from "./native.mjs";
import { creditRoot } from "./build.mjs";
const state = (l) =>
  l.db
    .prepare(
      "SELECT epoch,(SELECT COUNT(*) FROM invoices) invoices,(SELECT COUNT(*) FROM receipts) receipts,(SELECT COUNT(*) FROM accountingEntries) entries,(SELECT COUNT(*) FROM inventoryMovements) moves,(SELECT COUNT(*) FROM cashCommands) commands FROM cashEpoch",
    )
    .first();
test("unsupported delivery/provenance, opening waiver, large text and large FIFO fail before financial commit", async () => {
  const l = await nativeLab({ name: "admission" }),
    proofs = [];
  try {
    const reject = async (route, input, status, code) => {
      const before = await state(l),
        r = await l.call(l.source, route, input);
      assert.equal(r.status, status, JSON.stringify(r));
      assert.equal(r.body.code, code, JSON.stringify(r));
      assert.deepEqual(await state(l), before);
      proofs.push(code);
    };
    await l.db
      .prepare("UPDATE customers SET notes=?,address=? WHERE id=1")
      .bind("N".repeat(40000), "A".repeat(40000))
      .run();
    await reject(
      "/sale",
      saleInput("credit-too-large-record"),
      422,
      "RECOVERY_RECORD_TOO_LARGE",
    );
    // Signed record fits; escaped planJson in the command/outbox row does not.
    await l.db
      .prepare("UPDATE customers SET notes=?,address=? WHERE id=1")
      .bind('"'.repeat(10000), "\\".repeat(10000))
      .run();
    await reject(
      "/sale",
      saleInput("credit-too-large-escaped-row"),
      422,
      "RECOVERY_RECORD_TOO_LARGE",
    );
    await l.db
      .prepare("UPDATE customers SET notes=NULL,address=NULL WHERE id=1")
      .run();
    await l.init(
      l.db,
      "INSERT INTO openingModeSettings(id,enabled,endsAt) VALUES(1,1,'2099-01-01 00:00:00')",
    );
    await reject(
      "/sale",
      saleInput("credit-opening-waiver"),
      503,
      "UNSUPPORTED_OPENING_WINDOW",
    );
    await l.db.prepare("UPDATE openingModeSettings SET enabled=0").run();
    const s = await l.ok(l.source, "/sale", saleInput("credit-admission-sale"));
    const payment = {
      commandType: "COLLECT",
      branchId: 1,
      shiftId: 1,
      invoiceId: s.body.invoiceId,
      clientRequestId: "credit-unsupported-pay",
      amount: "10",
      method: "CASH",
    };
    await l.db
      .prepare("UPDATE invoices SET sourceType='ONLINE' WHERE id=?")
      .bind(s.body.invoiceId)
      .run();
    await reject(
      "/payment",
      payment,
      503,
      "UNSUPPORTED_CREDIT_COLLECTION_INVOICE",
    );
    await l.db
      .prepare(
        "UPDATE invoices SET sourceType='POS',customerId=NULL WHERE id=?",
      )
      .bind(s.body.invoiceId)
      .run();
    await reject(
      "/payment",
      { ...payment, clientRequestId: "credit-null-customer-pay" },
      503,
      "UNSUPPORTED_CREDIT_COLLECTION_INVOICE",
    );
    await l.init(
      l.db,
      `INSERT INTO deliveryParties(id,name) VALUES(1,'Synthetic Courier');INSERT INTO deliveryConsignments(id,consignmentNumber,branchId,partyId,invoiceId,sourceId,codAmount) VALUES(1,'CREDIT-DELIVERY',1,1,${s.body.invoiceId},${s.body.invoiceId},'100.00');`,
    );
    await reject(
      "/payment",
      { ...payment, clientRequestId: "credit-null-delivery-pay" },
      503,
      "UNSUPPORTED_CUSTOMER_DELIVERY_HISTORY",
    );
    await l.db
      .prepare("UPDATE invoices SET customerId=1 WHERE id=?")
      .bind(s.body.invoiceId)
      .run();
    await reject(
      "/sale",
      saleInput("credit-related-delivery"),
      503,
      "UNSUPPORTED_CUSTOMER_DELIVERY_HISTORY",
    );
    await l.db.prepare("DELETE FROM deliveryConsignments").run();
    await l.db
      .prepare("UPDATE customers SET currentBalance='-2000.00' WHERE id=5")
      .run();
    for (let i = 0; i < 20; i++)
      await l.db
        .prepare(
          "INSERT INTO invoices(invoiceNumber,sourceType,sourceId,branchId,customerId,total,subtotal,invoiceStatus,paidAmount) VALUES(?,'POS',?,1,5,'100.00','100.00','PENDING','0.00')",
        )
        .bind("FIFO-" + i, "credit-budget-baseline-" + i)
        .run();
    await reject(
      "/sale",
      saleInput("credit-large-fifo", { customerId: 5 }),
      422,
      "CREDIT_INVOCATION_BUDGET_EXCEEDED",
    );
    assert.equal(l.outbound.length, 0);
    await writeFile(
      path.join(creditRoot, "results/admission.json"),
      JSON.stringify(
        {
          passed: true,
          proofs,
          noFinancialWritesOnRejection: true,
          outboundAttempts: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await l.close();
  }
});
