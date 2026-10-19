import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import Decimal from "decimal.js";
import {
  connectReturnsOracle,
  oracleEnv,
  oracleDatabase,
} from "./mysql-lab.mjs";
import { sqlStatements } from "../cash/sql-statements.mjs";
if (process.argv[2] !== "--verify-isolated-mysql")
  throw Error("EXPLICIT_ORACLE_MODE_REQUIRED");
Object.assign(process.env, oracleEnv);
const { connection: c, server } = await connectReturnsOracle();
const { createConfirmedPosSale } =
  await import("../../../server/services/posExternalPayment.ts");
const { processPayment } =
  await import("../../../server/services/sale/payment.ts");
const { returnSaleDirect } =
  await import("../../../server/services/returnService.ts");
const { logAuditTx } = await import("../../../server/services/auditService.ts");
const { RETURN_EXECUTED_AUDIT_ACTION } =
  await import("../../../server/services/returns/auditActions.ts");
const { withTx } = await import("../../../server/services/tx.ts");
const { getDb } = await import("../../../server/db.ts");
const { sql } = await import("drizzle-orm");
const traces = [],
  shapes = new Set();
const db = getDb();
db.$client.on("connection", (connection) => {
  for (const method of ["query", "execute"]) {
    const original = connection[method];
    connection[method] = function (statement, ...args) {
      const query = typeof statement === "string" ? statement : statement.sql;
      shapes.add(
        query
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\(\?(, \?)+\)/g, "(?)"),
      );
      traces.push({
        sql: query,
        params: Array.isArray(args[0]) ? args[0] : [],
      });
      return original.call(this, statement, ...args);
    };
  }
});
const fixture = sqlStatements(
  await readFile(
    "experiments/d1-continuity/returns/build/discovery-file/fixture.sql",
    "utf8",
  ),
).filter((s) => !/^UPDATE cashEpoch|^UPDATE customers SET searchNorm/i.test(s));
const tables = [
  "invoices",
  "invoiceItems",
  "inventoryMovements",
  "branchStock",
  "productVariants",
  "receipts",
  "accountingEntries",
  "idempotencyKeys",
  "documentCounters",
  "invoiceAttributions",
  "customers",
  "auditLogs",
  "documentEffects",
];
const actor = { userId: 1, branchId: 1, role: "cashier" };
async function state() {
  const out = {};
  for (const t of tables)
    out[t] = (await c.query("SELECT * FROM `" + t + "`"))[0];
  return out;
}
async function reset() {
  const names = (
    await c.query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'")
  )[0].map((r) => Object.values(r)[0]);
  await c.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    for (const n of names) {
      assert.match(n, /^\w+$/);
      await c.query("TRUNCATE TABLE `" + n + "`");
    }
  } finally {
    await c.query("SET FOREIGN_KEY_CHECKS=1");
  }
  for (const s of fixture) await c.query(s);
}
const scenarios = [];
try {
  const r = await db.execute(sql`SELECT @@port port,DATABASE() db`);
  assert.equal(r[0][0].port, 13326);
  assert.equal(r[0][0].db, oracleDatabase);
  for (const scenario of [
    {
      name: "cash-walkin",
      mode: "CASH",
      walkin: true,
      quantity: "3",
      returns: [
        { qty: 1, refund: "100" },
        { qty: 2, refund: "200" },
      ],
    },
    {
      name: "cash-customer-credit",
      mode: "CASH",
      quantity: "3",
      returns: [{ qty: 1 }, { qty: 2, refund: "200" }],
    },
    {
      name: "credit-unpaid",
      mode: "CREDIT",
      quantity: "3",
      returns: [{ qty: 1 }, { qty: 2 }],
    },
    {
      name: "credit-part-paid",
      mode: "CREDIT",
      quantity: "3",
      initial: "120",
      payments: ["30"],
      returns: [{ qty: 1 }, { qty: 2, refund: "150" }],
    },
    {
      name: "credit-collected",
      mode: "CREDIT",
      quantity: "2",
      payments: ["200"],
      returns: [{ qty: 2, refund: "200" }],
    },
    {
      name: "damaged-cash",
      mode: "CASH",
      quantity: "2",
      returns: [
        { qty: 1, refund: "100", restock: false },
        { qty: 1, refund: "100", restock: false },
      ],
    },
    {
      name: "decimal-iqd",
      mode: "CASH",
      quantity: "3",
      setup: [
        "UPDATE productPrices SET price='83.37' WHERE id=1",
        "UPDATE productVariants SET costPrice='41.68',updatedAt=CURRENT_TIMESTAMP WHERE id=1",
      ],
      returns: [
        { qty: 1, refund: "83.37" },
        { qty: 2, refund: "166.74" },
      ],
    },
    {
      name: "historical-wavg",
      mode: "CASH",
      quantity: "3",
      afterSale: [
        "UPDATE productVariants SET costPrice='70.00',updatedAt=CURRENT_TIMESTAMP WHERE id=1",
        "INSERT INTO branches(id,name,code,branchType) VALUES(2,'Synthetic second branch','SECOND','SALES')",
        "INSERT INTO branchStock(id,variantId,branchId,quantity) VALUES(10,1,2,10)",
      ],
      returns: [
        { qty: 1, refund: "100" },
        { qty: 2, refund: "200" },
      ],
    },
    {
      name: "rounding-down",
      mode: "CASH",
      quantity: "3",
      total: "250.00",
      cashRoundIQD: true,
      setup: ["UPDATE productPrices SET price='83.37' WHERE id=1"],
      returns: [
        { qty: 1, refund: "83.37" },
        { qty: 2, refund: "166.63" },
      ],
    },
    {
      name: "rounding-up",
      mode: "CASH",
      quantity: "3",
      total: "500.00",
      cashRoundIQD: true,
      setup: ["UPDATE productPrices SET price='130.10' WHERE id=1"],
      returns: [
        { qty: 1, refund: "130.10" },
        { qty: 2, refund: "369.90" },
      ],
    },
    {
      name: "invoice-discount",
      mode: "CASH",
      quantity: "3",
      total: "292.50",
      invoiceDiscount: "7.50",
      returns: [
        { qty: 1, refund: "97.50" },
        { qty: 2, refund: "195.00" },
      ],
    },
  ]) {
    await reset();
    for (const s of scenario.setup ?? []) await c.query(s);
    const commands = [];
    let sale;
    const run = async (input) => {
      let result = null,
        error = null;
      const start = traces.length;
      try {
        const { commandType, branchId, shiftId, ...original } = input;
        if (commandType === "SALE" || commandType === "CASH_SALE")
          result = await createConfirmedPosSale(
            {
              ...original,
              branchId,
              shiftId,
              paymentMode: commandType === "CASH_SALE" ? "PREPAID" : "CREDIT",
            },
            actor,
          );
        else if (commandType === "COLLECT")
          result = await processPayment(
            { ...original, shiftId, enforceBranchId: branchId },
            actor,
          );
        else {
          result = await returnSaleDirect(original, actor);
          await withTx((tx) =>
            logAuditTx(tx, actor, {
              branchId,
              action: RETURN_EXECUTED_AUDIT_ACTION,
              entityType: "invoice",
              entityId: String(input.invoiceId),
              newValue: { ...original, result },
            }),
          );
        }
      } catch (e) {
        error = {
          code: e.code ?? "ERROR",
          message: e.message,
          cause: e.cause?.message,
        };
      }
      commands.push({
        input,
        result,
        error,
        tables: await state(),
        trace: traces.slice(start),
      });
      return result;
    };
    const total =
      scenario.total ??
      (scenario.name === "decimal-iqd"
        ? "250.11"
        : new Decimal(scenario.quantity).times(100).toFixed(2));
    sale = await run({
      commandType: scenario.mode === "CASH" ? "CASH_SALE" : "SALE",
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      ...(!scenario.walkin ? { customerId: 1 } : {}),
      clientRequestId: "return-oracle-" + scenario.name,
      lines: [{ variantId: 1, productUnitId: 1, quantity: scenario.quantity }],
      ...(scenario.cashRoundIQD ? { cashRoundIQD: true } : {}),
      ...(scenario.invoiceDiscount
        ? { invoiceDiscount: scenario.invoiceDiscount }
        : {}),
      ...(scenario.mode === "CASH"
        ? { payment: { method: "CASH", amount: total } }
        : scenario.initial
          ? { payment: { method: "CASH", amount: scenario.initial } }
          : {}),
    });
    assert.ok(sale, JSON.stringify(commands.at(-1).error));
    for (const s of scenario.afterSale ?? []) await c.query(s);
    for (const [i, amount] of (scenario.payments ?? []).entries())
      await run({
        commandType: "COLLECT",
        branchId: 1,
        shiftId: 1,
        invoiceId: sale.invoiceId,
        clientRequestId: "return-oracle-" + scenario.name + "-pay-" + i,
        method: "CASH",
        amount,
      });
    for (const [i, ret] of scenario.returns.entries()) {
      const input = {
        commandType: "RETURN",
        branchId: 1,
        shiftId: 1,
        invoiceId: sale.invoiceId,
        clientRequestId: "return-oracle-" + scenario.name + "-ret-" + i,
        operatorReason: "synthetic test return",
        restock: ret.restock !== false,
        lines: [{ invoiceItemId: 1, baseQuantity: ret.qty }],
        ...(scenario.walkin
          ? {
              resolution: {
                kind: "IMMEDIATE_REFUND",
                method: "CASH",
                amount: ret.refund ?? "0",
                shiftId: 1,
                reason: "synthetic test return",
                disposition: ret.restock === false ? "DAMAGED" : "RESTOCK",
              },
            }
          : ret.refund
            ? { refund: { method: "CASH", amount: ret.refund, shiftId: 1 } }
            : {}),
      };
      await run(input);
      if (i === 0 && scenario.afterSale)
        commands.at(-1).setupBefore = scenario.afterSale;
      assert.equal(
        commands.at(-1).error,
        null,
        JSON.stringify(commands.at(-1).error),
      );
    }
    scenarios.push({ ...scenario, actor, commands });
  }
  await mkdir("experiments/d1-continuity/returns/results", { recursive: true });
  await writeFile(
    "experiments/d1-continuity/returns/results/mysql-oracle.json",
    JSON.stringify(
      {
        verifiedServer: { port: server.port, version: server.version },
        scenarios,
      },
      null,
      2,
    ),
  );
  await writeFile(
    "experiments/d1-continuity/returns/queries-extra.ts",
    "// Captured original MySQL return-service statements; exact admission.\nexport const returnQueries:string[]=" +
      JSON.stringify(
        [...shapes].filter(
          (s) => /^(select|update|insert)/i.test(s) && !s.includes("@@port"),
        ),
        null,
        2,
      ) +
      ";\n",
  );
  console.log(
    JSON.stringify({
      scenarios: scenarios.length,
      commands: scenarios.reduce((n, s) => n + s.commands.length, 0),
      shapes: shapes.size,
    }),
  );
} finally {
  await c.end();
}
process.exit(0);
