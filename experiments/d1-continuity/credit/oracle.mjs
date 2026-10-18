import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { creditRoot } from "./build.mjs";
import {
  connectCreditOracle,
  oracleEnv,
  oracleDatabase,
} from "./mysql-lab.mjs";
import { sqlStatements } from "../cash/sql-statements.mjs";
if (process.argv[2] !== "--verify-isolated-mysql")
  throw Error("EXPLICIT_ORACLE_MODE_REQUIRED");
Object.assign(process.env, oracleEnv);
const { connection: c, server } = await connectCreditOracle();
const { createConfirmedPosSale } =
    await import("../../../server/services/posExternalPayment.ts"),
  { processPayment } = await import("../../../server/services/sale/payment.ts"),
  { getDb } = await import("../../../server/db.ts"),
  { sql } = await import("drizzle-orm");
const fixture = sqlStatements(
  await readFile(
    path.join(creditRoot, "build/schema-fixture/fixture.sql"),
    "utf8",
  ),
).filter((s) => !/^UPDATE cashEpoch|^UPDATE customers SET searchNorm/i.test(s));
const actor = { userId: 1, branchId: 1, role: "cashier" };
const tables = [
  "invoices",
  "invoiceItems",
  "inventoryMovements",
  "branchStock",
  "receipts",
  "accountingEntries",
  "idempotencyKeys",
  "documentCounters",
  "invoiceAttributions",
  "customers",
  "auditLogs",
];
async function state() {
  const out = {};
  for (const t of tables) {
    const [rows] = await c.query("SELECT * FROM `" + t + "`");
    out[t] = rows;
  }
  return out;
}
async function reset() {
  const [rows] = await c.query(
    "SHOW FULL TABLES WHERE Table_type='BASE TABLE'",
  );
  await c.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    for (const row of rows) {
      const name = Object.values(row)[0];
      assert.match(name, /^\w+$/);
      await c.query("TRUNCATE TABLE `" + name + "`");
    }
  } finally {
    await c.query("SET FOREIGN_KEY_CHECKS=1");
  }
  for (const s of fixture) await c.query(s);
}
const input = (id, patch = {}) => ({
  commandType: "SALE",
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  customerId: 1,
  clientRequestId: id,
  lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
  ...patch,
});
try {
  const db = getDb();
  const raw = await db.execute(sql`SELECT @@port port,DATABASE() db`);
  assert.equal(Number(raw[0][0].port), 13323);
  assert.equal(raw[0][0].db, oracleDatabase);
  const scenarios = [];
  for (const [name, patch, payments, setup] of [
    ["unpaid", {}, [], []],
    [
      "initial-partial",
      { payment: { method: "CASH", amount: "30" } },
      ["20", "50"],
      [],
    ],
    ["prior-credit", { customerId: 3 }, ["60"], []],
    [
      "exact-limit",
      { customerId: 2 },
      [],
      ["UPDATE customers SET creditLimit='100.00' WHERE id=2"],
    ],
    ["cash-only", { customerId: 4 }, [], []],
    [
      "contract",
      {},
      ["90"],
      [
        "INSERT INTO customerContractPrices(customerId,productUnitId,price,isActive) VALUES(1,1,'90.00',1)",
      ],
    ],
    [
      "large-cents",
      { customerId: 5 },
      ["0.01"],
      ["UPDATE customers SET currentBalance='9999999999800.90' WHERE id=5"],
    ],
  ]) {
    await reset();
    for (const s of setup) await c.query(s);
    const commands = [],
      request = input("credit-oracle-" + name, patch);
    let sale;
    const run = async (command) => {
      let result = null,
        error = null;
      try {
        const { commandType, branchId, ...original } = command;
        result =
          commandType === "SALE"
            ? await createConfirmedPosSale(
                { ...original, branchId, paymentMode: "CREDIT" },
                actor,
              )
            : await processPayment(
                { ...original, enforceBranchId: branchId },
                actor,
              );
      } catch (e) {
        error = { code: e.code ?? "ERROR", message: e.message };
      }
      commands.push({ input: command, result, error, tables: await state() });
      return result;
    };
    sale = await run(request);
    if (sale)
      for (let i = 0; i < payments.length; i++)
        await run({
          commandType: "COLLECT",
          branchId: 1,
          shiftId: 1,
          invoiceId: sale.invoiceId,
          clientRequestId: "credit-oracle-" + name + "-pay-" + i,
          method: "CASH",
          amount: payments[i],
        });
    scenarios.push({ name, setup, actor, commands });
  }
  await mkdir(path.join(creditRoot, "results"), { recursive: true });
  await writeFile(
    path.join(creditRoot, "results/mysql-oracle.json"),
    JSON.stringify(
      {
        verifiedServer: { port: server.port, version: server.version },
        scenarios,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      scenarios: scenarios.map((s) => ({
        name: s.name,
        commands: s.commands.length,
        errors: s.commands.filter((c) => c.error).map((c) => c.error.code),
      })),
    }),
  );
} finally {
  await c.end();
}
process.exit(0);
