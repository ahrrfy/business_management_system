import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeLab, saleInput } from "./native.mjs";
import { creditRoot } from "./build.mjs";
const proofs = [];
const balance = async (db, id = 1) =>
  (
    await db
      .prepare("SELECT currentBalance FROM customers WHERE id=?")
      .bind(id)
      .first()
  ).currentBalance;
const invoice = async (db, id) =>
  db
    .prepare(
      "SELECT invoiceStatus status,paidAmount,total,priceTier,paymentMode FROM invoices WHERE id=?",
    )
    .bind(id)
    .first();
const unchanged = async (l, route, input, status) => {
  const before = await l.db
      .prepare(
        "SELECT epoch,(SELECT COUNT(*) FROM receipts) receipts,(SELECT COUNT(*) FROM invoices) invoices,(SELECT COUNT(*) FROM accountingEntries) entries FROM cashEpoch",
      )
      .first(),
    r = await l.call(l.source, route, input);
  assert.equal(r.status, status, JSON.stringify(r));
  assert.deepEqual(
    await l.db
      .prepare(
        "SELECT epoch,(SELECT COUNT(*) FROM receipts) receipts,(SELECT COUNT(*) FROM invoices) invoices,(SELECT COUNT(*) FROM accountingEntries) entries FROM cashEpoch",
      )
      .first(),
    before,
  );
  return r;
};
async function lab(t, name) {
  const l = await nativeLab({ name });
  t.after(() => l.close());
  return l;
}
test("original initial-partial credit, credit limits zero/exact/null, invalid fields and unchanged rejected overpayment", async (t) => {
  const l = await lab(t, "policy-limits");
  const sale = await l.ok(
    l.source,
    "/sale",
    saleInput("credit-partial-start", {
      payment: { method: "CASH", amount: "30" },
    }),
  );
  assert.equal(await balance(l.db), "70.00");
  assert.equal((await invoice(l.db, sale.body.invoiceId)).paidAmount, "30.00");
  assert.equal(
    (await invoice(l.db, sale.body.invoiceId)).paymentMode,
    "CREDIT",
  );
  const pay = {
    commandType: "COLLECT",
    branchId: 1,
    shiftId: 1,
    invoiceId: sale.body.invoiceId,
    clientRequestId: "credit-overpayment",
    method: "CASH",
    amount: "70.01",
  };
  await unchanged(l, "/payment", pay, 400);
  await unchanged(
    l,
    "/sale",
    saleInput("credit-cash-only", { customerId: 4 }),
    403,
  );
  await unchanged(
    l,
    "/sale",
    saleInput("credit-cod-bypass", { paymentMode: "COD" }),
    400,
  );
  await unchanged(
    l,
    "/sale",
    saleInput("credit-manager-bypass", { creditApproved: true }),
    400,
  );
  await l.db
    .prepare("UPDATE customers SET creditLimit='100.00' WHERE id=2")
    .run();
  await l.ok(
    l.source,
    "/sale",
    saleInput("credit-exact-limit", { customerId: 2 }),
  );
  await unchanged(
    l,
    "/sale",
    saleInput("credit-over-limit", { customerId: 2 }),
    403,
  );
  await l.ok(
    l.source,
    "/sale",
    saleInput("credit-null-limit", { customerId: 5 }),
  );
  assert.equal(await balance(l.db, 2), "100.00");
  assert.equal(l.outbound.length, 0);
  proofs.push("initial-partial/limits/bypass/overpayment");
});
test("customer default tier and original active/inactive contract precedence are preserved", async (t) => {
  const l = await lab(t, "policy-contract");
  await l.init(
    l.db,
    "UPDATE customers SET defaultPriceTier='WHOLESALE' WHERE id IN(1,2);INSERT INTO productPrices(productUnitId,priceTier,price) VALUES(1,'WHOLESALE','110.00');INSERT INTO customerContractPrices(customerId,productUnitId,price,isActive) VALUES(1,1,'90.00',1),(2,1,'85.00',0);",
  );
  const active = await l.ok(
      l.source,
      "/sale",
      saleInput("credit-active-contract"),
    ),
    inactive = await l.ok(
      l.source,
      "/sale",
      saleInput("credit-inactive-contract", { customerId: 2 }),
    );
  assert.equal(active.body.total, "90.00");
  assert.equal(inactive.body.total, "110.00");
  assert.equal(
    (await invoice(l.db, active.body.invoiceId)).priceTier,
    "WHOLESALE",
  );
  assert.equal(await balance(l.db), "90.00");
  proofs.push("customer-tier/contract-precedence");
});
test("Decimal customer balance retains exact cents near the original DECIMAL limit", async (t) => {
  const l = await lab(t, "policy-cents");
  await l.db
    .prepare(
      "UPDATE customers SET currentBalance='9999999999800.90' WHERE id=5",
    )
    .run();
  const s = await l.ok(
    l.source,
    "/sale",
    saleInput("credit-large-cents", { customerId: 5 }),
  );
  assert.equal(await balance(l.db, 5), "9999999999900.90");
  await l.ok(l.source, "/payment", {
    commandType: "COLLECT",
    branchId: 1,
    shiftId: 1,
    invoiceId: s.body.invoiceId,
    clientRequestId: "credit-cent-collection",
    method: "CASH",
    amount: "0.01",
  });
  assert.equal(await balance(l.db, 5), "9999999999900.89");
  assert.equal((await invoice(l.db, s.body.invoiceId)).paidAmount, "0.01");
  proofs.push("exact-large-AR-cents");
});
test("prior customer credit allocates without a receipt and preserves the original saved response", async (t) => {
  const l = await lab(t, "policy-prior-credit");
  const input = saleInput("credit-prior-opening", { customerId: 3 }),
    s = await l.ok(l.source, "/sale", input);
  assert.equal(s.body.status, "PENDING");
  assert.deepEqual(await invoice(l.db, s.body.invoiceId), {
    status: "PARTIALLY_PAID",
    paidAmount: "40.00",
    total: "100.00",
    priceTier: "RETAIL",
    paymentMode: "CREDIT",
  });
  assert.equal(await balance(l.db, 3), "60.00");
  assert.equal(
    (await l.db.prepare("SELECT COUNT(*) n FROM receipts").first()).n,
    0,
  );
  assert.equal(
    (
      await l.db
        .prepare(
          "SELECT COUNT(*) n FROM auditLogs WHERE action='customer.autoSettle'",
        )
        .first()
    ).n,
    1,
  );
  assert.equal((await l.ok(l.source, "/sale", input)).body.status, "PENDING");
  proofs.push("prior-credit/no-fictitious-cash/stable-response");
});
test("full open-invoice FIFO closure crosses branches and ignores unrelated customer history", async (t) => {
  const l = await lab(t, "policy-fifo");
  await l.init(
    l.db,
    "INSERT INTO branches(id,name,code,branchType) VALUES(2,'Synthetic OTHER','OTHER','SALES');UPDATE customers SET currentBalance='120.00' WHERE id=1;INSERT INTO invoices(id,invoiceNumber,sourceType,sourceId,branchId,customerId,invoiceDate,subtotal,total,costTotal,invoiceStatus,paidAmount) VALUES(500,'OLD-500','POS','fifo-baseline-old',2,1,'2026-01-01','100.00','100.00','50.00','PENDING','0.00'),(600,'OLD-600','POS','fifo-baseline-new',1,1,'2026-02-01','100.00','100.00','50.00','PARTIALLY_PAID','20.00');",
  );
  const s = await l.ok(l.source, "/sale", saleInput("credit-fifo-new-sale"));
  assert.equal(s.profile.stateRead.rows.invoices, 2);
  assert.equal((await invoice(l.db, 500)).paidAmount, "60.00");
  assert.equal((await invoice(l.db, 600)).paidAmount, "20.00");
  assert.equal((await invoice(l.db, s.body.invoiceId)).paidAmount, "0.00");
  assert.equal(await balance(l.db), "220.00");
  assert.equal(
    (await l.db.prepare("SELECT COUNT(*) n FROM receipts").first()).n,
    0,
  );
  proofs.push("complete-cross-branch-FIFO-fixture");
});
test("collection enforces branch, shift owner, cash day and locked period without financial writes", async (t) => {
  const l = await lab(t, "policy-guards");
  await l.init(
    l.db,
    "INSERT INTO branches(id,name,code,branchType) VALUES(2,'Synthetic OTHER','OTHER','SALES');INSERT INTO users(id,openId,name,role,loginMethod,branchId) VALUES(2,'credit-other','Other Cashier','cashier','local',2);INSERT INTO shifts(id,userId,branchId,shiftStatus,shiftType,openingBalance,openGuard) VALUES(2,2,2,'OPEN','RETAIL','0.00','2:2:RETAIL');INSERT INTO branchStock(id,variantId,branchId,quantity) VALUES(3,1,2,100);",
  );
  const cross = await l.ok(
    l.source,
    "/sale",
    saleInput("credit-cross-branch", { branchId: 2, shiftId: 2 }),
    "",
    "2",
  );
  const pay = {
    commandType: "COLLECT",
    branchId: 1,
    shiftId: 1,
    invoiceId: cross.body.invoiceId,
    clientRequestId: "credit-wrong-branch",
    method: "CASH",
    amount: "20",
  };
  await unchanged(l, "/payment", pay, 403);
  const own = await l.ok(l.source, "/sale", saleInput("credit-own-guarded"));
  await l.init(
    l.db,
    "INSERT INTO users(id,openId,name,role,loginMethod,branchId) VALUES(3,'credit-owner-other','Other Drawer','cashier','local',1);INSERT INTO shifts(id,userId,branchId,shiftStatus,shiftType,openingBalance,openGuard) VALUES(3,3,1,'OPEN','RETAIL','0.00','3:1:RETAIL');",
  );
  await unchanged(
    l,
    "/payment",
    {
      ...pay,
      invoiceId: own.body.invoiceId,
      shiftId: 3,
      clientRequestId: "credit-other-drawer-owner",
    },
    403,
  );
  await l.db
    .prepare("UPDATE invoices SET invoiceStatus='CANCELLED' WHERE id=?")
    .bind(own.body.invoiceId)
    .run();
  await unchanged(
    l,
    "/payment",
    {
      ...pay,
      invoiceId: own.body.invoiceId,
      clientRequestId: "credit-terminal-invoice",
    },
    412,
  );
  await l.db
    .prepare("UPDATE invoices SET invoiceStatus='PENDING' WHERE id=?")
    .bind(own.body.invoiceId)
    .run();
  await unchanged(
    l,
    "/payment",
    {
      ...pay,
      invoiceId: own.body.invoiceId,
      shiftId: 2,
      clientRequestId: "credit-wrong-shift",
    },
    400,
  );
  await l.db
    .prepare("UPDATE shifts SET shiftStatus='CLOSED',openGuard=NULL WHERE id=1")
    .run();
  await unchanged(
    l,
    "/payment",
    {
      ...pay,
      invoiceId: own.body.invoiceId,
      clientRequestId: "credit-closed-shift",
    },
    412,
  );
  await l.db
    .prepare(
      "UPDATE shifts SET shiftStatus='OPEN',openGuard='1:1:RETAIL' WHERE id=1",
    )
    .run();
  const day = new Date().toISOString().slice(0, 10);
  await l.init(
    l.db,
    `INSERT INTO cashDailyReconciliations(branchId,businessDate,expectedTreasuryCash,countedTreasuryCash,variance,cashDailyReconciliationStatus,lastClientRequestId,evidenceHash,countedByUserId) VALUES(1,'${day}','0.00','0.00','0.00','CLOSED','credit-day-baseline','synthetic',1);`,
  );
  await unchanged(
    l,
    "/payment",
    {
      ...pay,
      invoiceId: own.body.invoiceId,
      clientRequestId: "credit-closed-day",
    },
    412,
  );
  await l.db
    .prepare(
      "UPDATE cashDailyReconciliations SET cashDailyReconciliationStatus='REOPENED'",
    )
    .run();
  await l.init(
    l.db,
    "INSERT INTO financialPeriods(cutoffDate,lockedBy) VALUES('2099-01-01',1)",
  );
  await unchanged(
    l,
    "/payment",
    {
      ...pay,
      invoiceId: own.body.invoiceId,
      clientRequestId: "credit-locked-period",
    },
    403,
  );
  proofs.push("collection-branch/shift/day/period");
});
test.after(async () => {
  await mkdir(path.join(creditRoot, "results"), { recursive: true });
  await writeFile(
    path.join(creditRoot, "results/policy.json"),
    JSON.stringify({ completedGroups: proofs.length, proofs }, null, 2),
  );
});
