import { Miniflare } from "miniflare";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { buildActualCashWorker, cashRoot } from "./build.mjs";
const entry = String.raw`import {initializationSql,fixtureSql,fixtureActor,fixtureInput,prepareCashSale,applyCashPlan} from './actual';
import {snapshotDatabase,snapshotResourceCounts} from './snapshot';
export default {async fetch(request,env){try{const data=await request.json();if(data.action==='init'){for(const sql of (initializationSql+'\n'+fixtureSql).split(';').filter(s=>s.trim()))await env.DB.prepare(sql).run();return Response.json({ok:true});}if(data.action==='resources')return Response.json(snapshotResourceCounts());if(data.action==='snapshot-probe'){let query='';const binding={prepare(sql){query=sql;let bound=[];return {bind(...args){bound=args;return this;},async first(){const snapshot=await env.DB.prepare(sql).bind(...bound).first();if(data.invalid){const rows=JSON.parse(snapshot.productVariants);if(data.invalid==='decimal')rows[0].costPrice='NaN';if(data.invalid==='constraint')rows.push({...rows[0]});if(data.invalid==='sequence')snapshot.sequences=JSON.stringify({productVariants:-1});snapshot.productVariants=JSON.stringify(rows);}return snapshot;}};}};const before=snapshotResourceCounts();try{const snap=await snapshotDatabase(binding,fixtureInput,fixtureActor);snap.close();snap.close();return Response.json({before,after:snapshotResourceCounts(),query});}catch(error){return Response.json({before,after:snapshotResourceCounts(),error:error.message,query});}}if(data.action==='apply')return Response.json(await applyCashPlan(env.DB,data.plan,{fault:data.fault}));const prepared=await prepareCashSale(env.DB,data.input??fixtureInput,fixtureActor);if(data.action!=='prepare')await applyCashPlan(env.DB,prepared.plan,{fault:data.fault});return Response.json(prepared);}catch(error){return Response.json({error:error.message,cause:error.cause?.message,trace:error.cashTrace},{status:500})}}};`;
await buildActualCashWorker({
  stdin: entry,
  outfile: cashRoot + "/build/core/worker.mjs",
});
const mf = new Miniflare({
  modules: [
    { type: "ESModule", path: cashRoot + "/build/core/worker.mjs" },
    { type: "CompiledWasm", path: cashRoot + "/build/core/sql-wasm.wasm" },
  ],
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  outboundService: () => new Response("NETWORK DENIED", { status: 403 }),
});
const traces = [];
let checks = 0;
async function call(data, ok = true) {
  const r = await mf.dispatchFetch("http://cash.test/", {
    method: "POST",
    body: JSON.stringify(data),
  });
  const body = await r.json();
  assert.equal(r.ok, ok, JSON.stringify(body));
  if (body.trace) traces.push(...body.trace);
  return body;
}
const base = {
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  clientRequestId: "actual-cash-1",
  lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
  payment: { amount: "200", method: "CASH" },
};
const input = (id, patch = {}) => ({ ...base, clientRequestId: id, ...patch });
try {
  await call({ action: "init" });
  const db = await mf.getD1Database("DB");
  const rows = async (table) =>
    (await db.prepare("SELECT * FROM `" + table + "` ORDER BY 1").all())
      .results;
  const mutate = async (sql) =>
    db.batch([
      db.prepare(sql),
      db.prepare("UPDATE cashEpoch SET epoch=epoch+1 WHERE id=1"),
    ]);
  const resourceBefore = await call({ action: "resources" });
  for (const invalid of ["decimal", "constraint", "sequence"])
    for (let i = 0; i < 4; i++) {
      const probe = await call({ action: "snapshot-probe", invalid });
      assert.match(
        probe.error,
        invalid === "decimal"
          ? /DECIMAL_RANGE/
          : invalid === "sequence"
            ? /INVALID_SEQUENCE/
            : /UNIQUE constraint/,
      );
      assert.equal(probe.after.allocated - probe.before.allocated, 1);
      assert.equal(
        probe.after.closed - probe.before.closed,
        1,
        "Rejected snapshot must close its real SQLite allocation exactly once",
      );
    }
  assert.equal(
    (await call({ action: "resources" })).closed - resourceBefore.closed,
    12,
  );
  const validProbe = await call({ action: "snapshot-probe" });
  assert.equal(validProbe.after.allocated - validProbe.before.allocated, 1);
  assert.equal(
    validProbe.after.closed - validProbe.before.closed,
    1,
    "Successful snapshot close is idempotent",
  );
  // Count actual generated JSON SQL function arguments, including nested calls.
  const arities = [];
  const stack = [];
  let quoted = false;
  for (let i = 0; i < validProbe.query.length; i++) {
    const c = validProbe.query[i];
    if (c === "'") {
      if (quoted && validProbe.query[i + 1] === "'") {
        i++;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (c === "(")
      stack.push({
        name: /([a-z_]+)$/i.exec(validProbe.query.slice(0, i))?.[1],
        args: 1,
      });
    else if (c === "," && stack.length) stack.at(-1).args++;
    else if (c === ")") {
      const f = stack.pop();
      if (/^json_(object|set)$/i.test(f?.name ?? "")) arities.push(f.args);
    }
  }
  assert.ok(arities.length > 0);
  assert.ok(
    arities.every((n) => n <= 32),
    "D1 JSON function argument limit: " + Math.max(...arities),
  );
  const first = await call({ action: "prepare" });
  assert.equal((await rows("invoices")).length, 0);
  checks++;
  await call({ action: "apply", plan: first.plan, fault: true }, false);
  assert.equal((await rows("cashEpoch"))[0].epoch, 1);
  for (const table of [
    "invoices",
    "invoiceItems",
    "inventoryMovements",
    "receipts",
    "accountingEntries",
    "idempotencyKeys",
    "documentCounters",
    "invoiceAttributions",
    "cashCommands",
    "cashOutbox",
  ])
    assert.equal((await rows(table)).length, 0, "rollback " + table);
  assert.equal((await rows("invoices")).length, 0);
  assert.equal((await rows("branchStock"))[0].quantity, 100);
  checks++;
  await call({ action: "apply", plan: first.plan });
  assert.equal((await rows("invoices"))[0].total, "200.00");
  assert.equal((await rows("invoiceItems"))[0].lineCost, "100.00");
  assert.equal((await rows("branchStock"))[0].quantity, 98);
  assert.equal((await rows("inventoryMovements"))[0].signedDelta, -2);
  assert.equal((await rows("receipts"))[0].amount, "200.00");
  assert.equal((await rows("receipts"))[0].cashBucket, "DRAWER");
  assert.deepEqual(
    (await rows("accountingEntries")).map((x) => x.entryType),
    ["SALE", "PAYMENT_IN"],
  );
  assert.equal((await rows("accountingEntries"))[0].cost, "100.00");
  for (const row of await rows("accountingEntries"))
    assert.match(
      row.entryDate,
      /^\d{4}-\d{2}-\d{2}$/,
      "MySQL DATE must persist only the calendar date",
    );
  assert.equal((await rows("invoiceAttributions"))[0].userId, 1);
  assert.equal((await rows("idempotencyKeys")).length, 1);
  assert.equal((await rows("cashOutbox")).length, 1);
  checks++;
  const replay = await call({ action: "sale" });
  assert.equal(replay.result.idempotentReplay, true);
  assert.equal((await rows("invoices")).length, 1);
  checks++;
  await call(
    {
      action: "sale",
      input: input(base.clientRequestId, {
        payment: { method: "CASH", amount: "201" },
      }),
    },
    false,
  );
  checks++;
  const rounded = await call({
    action: "sale",
    input: input("round", {
      cashRoundIQD: true,
      payment: { method: "CASH", amount: "500" },
    }),
  });
  assert.equal(rounded.result.total, "250.00");
  const ri = (await rows("invoices")).find(
    (x) => x.id === rounded.result.invoiceId,
  );
  assert.equal(ri.cashRoundingAdjustment, "50.00");
  assert.equal(
    (await rows("receipts")).find((x) => x.invoiceId === ri.id).amount,
    "250.00",
  );
  assert(
    (await rows("accountingEntries")).some(
      (x) => x.invoiceId === ri.id && x.entryType === "ADJUST",
    ),
  );
  checks++;
  const multi = await call({
    action: "sale",
    input: input("multi", {
      lines: [...base.lines, { variantId: 2, productUnitId: 2, quantity: "2" }],
      payment: { method: "CASH", amount: "360" },
    }),
  });
  assert.equal(multi.result.total, "360.00");
  checks++;
  const stale = await call({ action: "prepare", input: input("shift-stale") });
  await mutate("UPDATE shifts SET shiftStatus='CLOSED' WHERE id=1");
  await call({ action: "apply", plan: stale.plan }, false);
  await call({ action: "sale", input: input("shift-stale") }, false);
  await mutate("UPDATE shifts SET shiftStatus='OPEN' WHERE id=1");
  checks++;
  const period = await call({
    action: "prepare",
    input: input("period-stale"),
  });
  await mutate(
    "INSERT INTO financialPeriods(cutoffDate,lockedBy) VALUES('2099-01-01',1)",
  );
  await call({ action: "apply", plan: period.plan }, false);
  await call({ action: "sale", input: input("period-stale") }, false);
  await mutate("UPDATE financialPeriods SET periodStatus='ARCHIVED'");
  checks++;
  await mutate("UPDATE branchStock SET quantity=1 WHERE id=1");
  const lastInput = (id) =>
    input(id, {
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { method: "CASH", amount: "100" },
    });
  const a = await call({ action: "prepare", input: lastInput("last-a") });
  const b = await call({ action: "prepare", input: lastInput("last-b") });
  const race = await Promise.all(
    [a, b].map((x) =>
      mf.dispatchFetch("http://cash.test/", {
        method: "POST",
        body: JSON.stringify({ action: "apply", plan: x.plan }),
      }),
    ),
  );
  assert.equal(race.filter((r) => r.ok).length, 1);
  for (const r of race) await r.text();
  await call({ action: "sale", input: lastInput("last-c") }, false);
  assert.equal((await rows("branchStock"))[0].quantity, 0);
  checks++;
  for (const patch of [
    { sourceType: "ORDER" },
    { payment: { method: "CARD", amount: "200" } },
    { customerId: 1 },
    { delivery: {} },
    {
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", isGift: true }],
    },
  ])
    await call({ action: "sale", input: input("unsupported", patch) }, false);
  checks++;
  await mutate("UPDATE products SET isService=1 WHERE id=2");
  await call(
    {
      action: "sale",
      input: input("service", {
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      }),
    },
    false,
  );
  checks++;
  await mutate("UPDATE products SET isService=0 WHERE id=2");
  await mutate("UPDATE productPrices SET price='0.10' WHERE productUnitId=2");
  await mutate("UPDATE productVariants SET costPrice='0.03' WHERE id=2");
  const decimal = await call({
    action: "sale",
    input: input("decimal", {
      lines: [{ variantId: 2, productUnitId: 2, quantity: "3" }],
      payment: { method: "CASH", amount: "0.30" },
    }),
  });
  assert.equal(decimal.result.total, "0.30");
  assert.equal(
    (await rows("invoices")).find((x) => x.id === decimal.result.invoiceId)
      .costTotal,
    "0.09",
  );
  checks++;
  assert.notEqual(
    (await rows("branchStock"))[0].updatedAt,
    "2026-10-17 00:00:00",
  );
  await mutate(
    "UPDATE productPrices SET price='9999999999999.99' WHERE productUnitId=2",
  );
  await mutate(
    "UPDATE productVariants SET costPrice='9999999999998.99' WHERE id=2",
  );
  const large = await call({
    action: "sale",
    input: input("large", {
      lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      payment: { method: "CASH", amount: "9999999999999.99" },
    }),
  });
  assert.equal(large.result.total, "9999999999999.99");
  checks++;
  await writeFile(
    cashRoot + "/build/sql-trace.json",
    JSON.stringify(traces, null, 2),
  );
  await writeFile(
    cashRoot + "/build/last-result.json",
    JSON.stringify(first, null, 2),
  );
  console.log(
    JSON.stringify({
      checks,
      originalSqlCalls: traces.length,
      snapshotCleanupFailures: 12,
      maxJsonFunctionArguments: Math.max(...arities),
      first: first.result,
      rounding: rounded.result,
      decimal: decimal.result,
    }),
  );
} finally {
  await mf.dispose();
}
