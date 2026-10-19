import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import Decimal from "decimal.js";
import {
  connectAccountingOracle,
  oracleDatabase,
  oracleEnv,
  parentLab,
} from "./mysql-lab.mjs";
import { sqlStatements } from "../cash/sql-statements.mjs";
import { validateEvidence } from "./validate.mjs";

if (process.argv[2] !== "--verify-isolated-mysql")
  throw Error("EXPLICIT_ORACLE_MODE_REQUIRED");
const largerOnly = process.argv[3] === "--larger-only";
const followupsOnly = process.argv[3] === "--failure-followups";
assert.equal(
  path.resolve("."),
  path.resolve(import.meta.dirname, "../../.."),
  "Run from repository root",
);
Object.assign(process.env, oracleEnv);
// No dotenv is loaded. No provider keys/URLs are needed or retained in evidence.
const blockedExternalEffects = [];
globalThis.fetch = async () => {
  blockedExternalEffects.push("fetch");
  throw Error("ORACLE_EXTERNAL_IO_BLOCKED");
};
const { connection: c, server } = await connectAccountingOracle();
const out =
  "experiments/d1-continuity/accounting/results" +
  (largerOnly ? "/larger" : "");
await mkdir(out, { recursive: true });
const { createConfirmedPosSale } =
  await import("../../../server/services/posExternalPayment.ts");
const { processPayment } =
  await import("../../../server/services/sale/payment.ts");
const { returnSaleDirect } =
  await import("../../../server/services/returnService.ts");
const { withTx } = await import("../../../server/services/tx.ts");
const { getDb, closeDb } = await import("../../../server/db.ts");
const s = await import("../../../drizzle/schema.ts");
const { eq, sql } = await import("drizzle-orm");
const { CHART_ACCOUNTS } =
  await import("../../../server/services/accounting/chartSeed.ts");
const { POSTING_POLICY_HASH } =
  await import("../../../server/services/accounting/postingEngine.ts");
const { seedIraqiUnifiedProfile, approveStatutoryProfile } =
  await import("../../../server/services/accounting/statutoryAccounting.ts");
const db = getDb(),
  traces = [],
  shapes = new Set(),
  scenarios = [],
  concerns = [];
assert.ok(db);
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
const fixtureText = await readFile(
  process.env.ACCOUNTING_ORACLE_FIXTURE ??
    parentLab +
      "/experiments/d1-continuity/returns/build/discovery-file/fixture.sql",
  "utf8",
);
await writeFile(out + "/fixture.sql", fixtureText);
const fixture = sqlStatements(fixtureText).filter(
  (q) => !/^UPDATE cashEpoch|^UPDATE customers SET searchNorm/i.test(q),
);
const tables = [
  "invoices",
  "invoiceItems",
  "invoiceItemBundleComponents",
  "invoiceItemServiceMaterials",
  "inventoryMovements",
  "branchStock",
  "productVariants",
  "receipts",
  "accountingEntries",
  "journalEntries",
  "journalLines",
  "idempotencyKeys",
  "documentCounters",
  "invoiceAttributions",
  "customers",
  "auditLogs",
  "documentEffects",
  "accounts",
  "doubleEntrySettings",
  "statutoryAccountingProfiles",
  "statutoryAccounts",
  "statutoryAccountMappings",
  "waOutbox",
];
const actor = { userId: 1, branchId: 1, role: "cashier" };
const sum = (rows, key) =>
  rows.reduce((n, r) => n.plus(r[key]), new Decimal(0)).toFixed(2);
async function state() {
  const state = {};
  for (const t of tables)
    state[t] = (await c.query("SELECT * FROM `" + t + "`"))[0].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  return state;
}
function journalTotals(state) {
  return state.journalEntries.map((j) => {
    const lines = state.journalLines.filter(
      (l) => String(l.journalId) === String(j.id),
    );
    const debit = sum(lines, "debit"),
      credit = sum(lines, "credit");
    assert.equal(debit, credit, "Unbalanced journal " + j.id);
    assert.ok(
      state.accountingEntries.some((e) => String(e.id) === String(j.entryId)),
      "Orphan journal",
    );
    if (j.status === "POSTED") {
      assert.ok(lines.length > 0);
      for (const line of lines) {
        assert.ok(
          line.accountId && line.statutoryProfileId && line.statutoryAccountId,
          "Missing account snapshot",
        );
        assert.ok(
          state.accounts.some(
            (a) =>
              String(a.id) === String(line.accountId) &&
              a.systemRole === line.role,
          ),
        );
        assert.ok(
          state.statutoryAccounts.some(
            (a) =>
              String(a.id) === String(line.statutoryAccountId) &&
              String(a.profileId) === String(line.statutoryProfileId),
          ),
        );
      }
    } else assert.equal(lines.length, 0, "Gap/memo must have no lines");
    return {
      journalId: j.id,
      entryId: j.entryId,
      profile: j.postingProfile,
      status: j.status,
      debit,
      credit,
      reason: j.unmappedReason,
    };
  });
}
async function reset(mode, fault) {
  const [[scope]] = await c.query(
    "SELECT DATABASE() db,@@port port,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),NOW()) utcOffset",
  );
  assert.deepEqual(scope, { db: oracleDatabase, port: 13326, utcOffset: 0 });
  const names = (
    await c.query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'")
  )[0].map((r) => Object.values(r)[0]);
  await c.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    for (const name of names) {
      assert.match(name, /^\w+$/);
      await c.query("TRUNCATE TABLE `" + name + "`");
    }
  } finally {
    await c.query("SET FOREIGN_KEY_CHECKS=1");
  }
  for (const query of fixture) await c.query(query);
  await c.query("UPDATE productPrices SET price='83.37' WHERE id=1");
  await c.query("UPDATE productVariants SET costPrice='41.68' WHERE id=1");
  await db.insert(s.accounts).values(CHART_ACCOUNTS);
  await withTx(async (tx) => {
    const profile = await seedIraqiUnifiedProfile(tx, 1);
    await approveStatutoryProfile(
      tx,
      {
        profileId: profile.profileId,
        accountantName: "Synthetic qualification accountant",
        approvalReference: "SYNTHETIC-Q1-ONLY",
      },
      1,
    );
  });
  const cycle = "q1-accounting-synthetic-cycle",
    openingHash = "a".repeat(64);
  // Same valid runtime approval contract as original shadowHook.test.ts.
  await db
    .update(s.doubleEntrySettings)
    .set({
      mode,
      shadowCycleId: cycle,
      shadowOpeningHash: openingHash,
      policyApprovalReference: "SYNTHETIC-Q1-POLICY",
      policyApprovalPolicyHash: POSTING_POLICY_HASH,
      policyApprovalCycleId: cycle,
      policyApprovalOpeningHash: openingHash,
      policyAccountantName: "Synthetic qualification accountant",
      policyApprovedAt: new Date("2026-08-01T00:00:00Z"),
      policyApprovedBy: 1,
    })
    .where(eq(s.doubleEntrySettings.id, 1));
  if (fault === "policy-hash")
    await c.query(
      "UPDATE doubleEntrySettings SET policyApprovalPolicyHash=REPEAT('0',64) WHERE id=1",
    );
  if (fault === "cycle")
    await c.query(
      "UPDATE doubleEntrySettings SET policyApprovalCycleId='wrong-cycle' WHERE id=1",
    );
  if (fault === "opening")
    await c.query(
      "UPDATE doubleEntrySettings SET policyApprovalOpeningHash=REPEAT('0',64) WHERE id=1",
    );
  if (fault === "missing-map")
    await c.query(
      "DELETE m FROM statutoryAccountMappings m JOIN accounts a ON a.id=m.internalAccountId WHERE a.systemRole='AR'",
    );
  assert.equal((await c.query("SELECT COUNT(*) n FROM waOutbox"))[0][0].n, 0);
}
async function run(scenario, input, expectation = "success") {
  const before = await state(),
    start = traces.length;
  let result = null,
    error = null;
  try {
    const { commandType, ...payload } = input;
    result =
      commandType === "SALE"
        ? await createConfirmedPosSale(payload, actor)
        : commandType === "COLLECT"
          ? await processPayment(payload, actor)
          : await returnSaleDirect(payload, actor);
  } catch (e) {
    error = {
      code: e.code ?? "ERROR",
      message: e.message,
      cause: e.cause?.message,
    };
  }
  const trace = traces.slice(start),
    after = await state();
  const command = {
    input,
    result,
    error,
    before,
    after,
    trace,
    sqlCount: trace.length,
    journalTotals: journalTotals(after),
  };
  scenario.commands.push(command);
  await writeFile(
    out + "/in-progress.json",
    JSON.stringify({ scenarios, activeScenario: scenario, concerns }, null, 2),
  );
  if (expectation === "reject") {
    assert.ok(error, "Expected rejection: " + JSON.stringify(input));
    assert.deepEqual(
      after,
      before,
      "Rejected operation changed persistent state",
    );
  } else if (expectation === "changed-payload") {
    assert.deepEqual(after, before, "Changed replay mutated state");
    if (!error)
      concerns.push({
        scenario: scenario.name,
        issue: "Original service accepted changed replay payload as a no-op",
        input,
        result,
      });
  } else {
    assert.equal(error, null, JSON.stringify(error));
  }
  if (expectation === "replay")
    assert.deepEqual(after, before, "Replay duplicated effects");
  return result;
}
function saleInput(key, credit = false) {
  return {
    commandType: "SALE",
    branchId: 1,
    shiftId: 1,
    sourceType: "POS",
    customerId: 1,
    clientRequestId: key,
    paymentMode: credit ? "CREDIT" : "PREPAID",
    lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
    ...(!credit ? { payment: { method: "CASH", amount: "250.11" } } : {}),
  };
}
function returnInput(key, invoiceId, itemId, qty, refund) {
  return {
    commandType: "RETURN",
    invoiceId,
    clientRequestId: key,
    operatorReason: "Synthetic accounting qualification return",
    restock: true,
    lines: [{ invoiceItemId: itemId, baseQuantity: qty }],
    ...(refund
      ? { refund: { method: "CASH", amount: refund, shiftId: 1 } }
      : {}),
  };
}
const sourceFiles = [
  "drizzle/schema.ts",
  "server/db.ts",
  "server/services/tx.ts",
  "server/services/posExternalPayment.ts",
  "server/services/sale/create.ts",
  "server/services/sale/payment.ts",
  "server/services/returnService.ts",
  "server/services/reversalEngine.ts",
  "server/services/inventoryService.ts",
  "server/services/ledgerService.ts",
  "server/services/idempotency.ts",
  "server/services/accounting/postingEngine.ts",
  "server/services/accounting/shadowHook.ts",
  "server/services/accounting/journalStore.ts",
  "server/services/accounting/statutoryAccounting.ts",
  "server/services/accounting/chartSeed.ts",
  "server/services/accounting/iraqiUnifiedChartSeed.ts",
];
const sourceHashes = {};
for (const file of sourceFiles)
  sourceHashes[file] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
try {
  const probe = await db.execute(
    sql`SELECT @@port port,DATABASE() db,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),NOW()) utcOffset`,
  );
  assert.deepEqual(
    { ...probe[0][0] },
    { port: 13326, db: oracleDatabase, utcOffset: 0 },
  );
  // RED first: policy and mapping failures must roll back the entire real sale.
  if (!followupsOnly && !largerOnly)
    for (const fault of ["policy-hash", "cycle", "opening", "missing-map"]) {
      await reset("ACTIVE", fault);
      const scenario = {
        name: "ACTIVE-reject-" + fault,
        mode: "ACTIVE",
        fault,
        commands: [],
      };
      await run(scenario, saleInput("q1-reject-" + fault), "reject");
      scenarios.push(scenario);
    }
  // SHADOW preserves operational source and the actual unmapped journal gap.
  if (!followupsOnly && !largerOnly) {
    await reset("SHADOW", "missing-map");
    const gap = { name: "SHADOW-missing-map", mode: "SHADOW", commands: [] };
    await run(gap, saleInput("q1-shadow-gap"));
    assert.ok(
      gap.commands[0].after.journalEntries.some((j) => j.status === "UNMAPPED"),
    );
    scenarios.push(gap);
  }
  if (!followupsOnly && !largerOnly)
    for (const mode of ["SHADOW", "ACTIVE"])
      for (const kind of [
        "cash-partial-full",
        "credit-unpaid",
        "credit-part-paid-collected",
      ]) {
        await reset(mode);
        const scenario = { name: mode + "-" + kind, mode, commands: [] },
          key = "q1-" + scenario.name;
        const input = saleInput(key, kind !== "cash-partial-full");
        if (kind === "credit-part-paid-collected")
          input.payment = { method: "CASH", amount: "100.05" };
        const sale = await run(scenario, input);
        await run(scenario, input, "replay");
        await run(
          scenario,
          { ...input, lines: [{ ...input.lines[0], quantity: "2" }] },
          "changed-payload",
        );
        const itemId = scenario.commands[0].after.invoiceItems[0].id;
        if (kind === "credit-part-paid-collected") {
          const pay = {
            commandType: "COLLECT",
            invoiceId: sale.invoiceId,
            shiftId: 1,
            enforceBranchId: 1,
            method: "CASH",
            amount: "150.06",
            clientRequestId: key + "-collect",
          };
          await run(scenario, pay);
          await run(scenario, pay, "replay");
          await run(scenario, { ...pay, amount: "150.07" }, "reject");
        }
        for (const [i, qty] of [1, 2].entries()) {
          const ret = returnInput(
            key + "-return-" + i,
            sale.invoiceId,
            itemId,
            qty,
            kind === "credit-unpaid" ? null : i === 0 ? "83.37" : "166.74",
          );
          await run(scenario, ret);
          await run(scenario, ret, "replay");
          await run(
            scenario,
            { ...ret, operatorReason: "Changed synthetic payload" },
            "reject",
          );
        }
        const final = scenario.commands.at(-1).after;
        assert.equal(final.invoices[0].returnedTotal, "250.11");
        assert.equal(final.invoices[0].invoiceStatus, "RETURNED");
        assert.equal(
          final.customers.find((c) => c.id === 1).currentBalance,
          "0.00",
        );
        assert.equal(final.branchStock.find((b) => b.id === 1).quantity, 100);
        assert.ok(final.journalEntries.every((j) => j.status === "POSTED"));
        assert.equal(final.waOutbox.length, 0);
        scenarios.push(scenario);
      }
  for (const fault of largerOnly ? [] : ["policy-hash", "missing-map"]) {
    await reset("ACTIVE");
    const scenario = {
        name: "ACTIVE-followup-reject-" + fault,
        mode: "ACTIVE",
        fault,
        commands: [],
      },
      key = "q1-followup-" + fault;
    const sale = await run(scenario, {
      ...saleInput(key, true),
      payment: { method: "CASH", amount: "100.05" },
    });
    if (fault === "policy-hash")
      await c.query(
        "UPDATE doubleEntrySettings SET policyApprovalPolicyHash=REPEAT('0',64) WHERE id=1",
      );
    else
      await c.query(
        "DELETE m FROM statutoryAccountMappings m JOIN accounts a ON a.id=m.internalAccountId WHERE a.systemRole='AR'",
      );
    await run(
      scenario,
      {
        commandType: "COLLECT",
        invoiceId: sale.invoiceId,
        shiftId: 1,
        enforceBranchId: 1,
        method: "CASH",
        amount: "150.06",
        clientRequestId: key + "-collect",
      },
      "reject",
    );
    await run(
      scenario,
      returnInput(
        key + "-return",
        sale.invoiceId,
        scenario.commands[0].after.invoiceItems[0].id,
        1,
      ),
      "reject",
    );
    scenarios.push(scenario);
  }
  if (largerOnly) {
    await reset("ACTIVE");
    const scenario = {
      name: "ACTIVE-larger-four-lines",
      mode: "ACTIVE",
      commands: [],
    };
    const input = {
      ...saleInput("q1-larger-four-lines"),
      lines: Array.from({ length: 4 }, () => ({
        variantId: 1,
        productUnitId: 1,
        quantity: "1",
      })),
      payment: { method: "CASH", amount: "333.48" },
    };
    const sale = await run(scenario, input);
    const items = scenario.commands[0].after.invoiceItems;
    assert.equal(items.length, 4);
    for (let offset = 0; offset < 4; offset += 2) {
      const ret = {
        ...returnInput(
          "q1-larger-return-" + offset,
          sale.invoiceId,
          items[offset].id,
          1,
          "166.74",
        ),
        lines: items
          .slice(offset, offset + 2)
          .map((i) => ({ invoiceItemId: i.id, baseQuantity: 1 })),
      };
      await run(scenario, ret);
    }
    const final = scenario.commands.at(-1).after;
    assert.equal(final.invoices[0].returnedTotal, "333.48");
    assert.equal(final.invoices[0].invoiceStatus, "RETURNED");
    assert.equal(final.branchStock.find((s) => s.id === 1).quantity, 100);
    assert.equal(sum(final.journalLines, "debit"), "1667.36");
    assert.equal(sum(final.journalLines, "credit"), "1667.36");
    scenarios.push(scenario);
  }
  const normalize = (q) =>
    q
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\(\?(, \?)+\)/g, "(?)");
  const normalizedSql = [
    ...new Set(
      scenarios.flatMap((s) =>
        s.commands.flatMap((c) => c.trace.map((t) => normalize(t.sql))),
      ),
    ),
  ].sort();
  const tableSet = [
    ...new Set(
      normalizedSql.flatMap((q) =>
        [...q.matchAll(/(?:\bfrom|\bjoin|\binto|^update)\s+`?(\w+)`?/gi)].map(
          (m) => m[1],
        ),
      ),
    ),
  ].sort();
  const summary = {
    status: concerns.length ? "DONE_WITH_CONCERNS" : "DONE",
    scenarios: scenarios.length,
    commands: scenarios.reduce((n, s) => n + s.commands.length, 0),
    sqlShapes: normalizedSql.length,
    tableSet,
    concerns,
    blockedExternalEffects,
  };
  const evidence = {
    actor,
    verifiedServer: {
      port: server.port,
      version: server.version,
      utcOffset: server.utcOffset,
      database: oracleDatabase,
    },
    policyHash: POSTING_POLICY_HASH,
    sourceHashes,
    fixtureSha256: createHash("sha256").update(fixtureText).digest("hex"),
    summary,
    scenarios,
  };
  if (!followupsOnly && !largerOnly) validateEvidence(evidence);
  const suffix = followupsOnly ? "-followups" : "";
  await writeFile(
    out + "/mysql-oracle" + suffix + ".json",
    JSON.stringify(evidence, null, 2),
  );
  await writeFile(
    out + "/sql-shapes" + suffix + ".json",
    JSON.stringify(normalizedSql, null, 2),
  );
  await writeFile(
    out + "/summary" + suffix + ".json",
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} finally {
  await c.end();
  await closeDb();
}
