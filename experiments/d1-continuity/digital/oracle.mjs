import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  appendFile,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { mock } from "node:test";
import mysql from "mysql2/promise";
import Decimal from "decimal.js";
import {
  connectDigitalOracle,
  oracleDatabase,
  oracleEnv,
} from "./mysql-lab.mjs";
import { blockExternalEffects } from "./network.mjs";
import { SyntheticProvider } from "./provider.mjs";

if (process.argv[2] !== "--verify-isolated-mysql")
  throw Error("EXPLICIT_DIGITAL_ORACLE_MODE_REQUIRED");
const resume = process.argv[3] === "--continue-after-harness-repair";
const focused = process.argv[3] === "--uncertain-followup";
const collation = process.argv[3] === "--collation-probe";
const prior =
  resume || focused || collation
    ? JSON.parse(
        await readFile(
          "experiments/d1-continuity/digital/results/latest.json",
          "utf8",
        ),
      )
    : null;
const resumePoint = prior?.blocker?.scenario;
Object.assign(process.env, oracleEnv);
const { connection: c, server } = await connectDigitalOracle();
const networkAttempts = blockExternalEffects();
const out =
  "experiments/d1-continuity/digital/results/" +
  new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(out, { recursive: true });
const F = await import("./fixture.mjs");
mock.timers.enable({ apis: ["Date"], now: Date.parse(F.CLOCK) });
const { getDb, closeDb } = await import("../../../server/db.ts");
const { withTx } = await import("../../../server/services/tx.ts");
const { intentService, finalizeService } =
  await import("../../../server/services/digitalCards/index.ts");
const { salesRouter } =
  await import("../../../server/routers/digitalCards/salesRouter.ts");
const { _clearAllMgrAttempts } =
  await import("../../../server/routers/saleRouter.ts");
const s = await import("../../../drizzle/schema.ts");
const { eq } = await import("drizzle-orm");
const { validateEvidence, assertRefusalUnchanged } =
  await import("./validate.mjs");
const db = getDb(),
  traces = [],
  scenarios = [],
  provider = new SyntheticProvider(out + "/provider-ledger.ndjson");
let phase = "SETUP",
  fault = null,
  current = null;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const money = (x) => new Decimal(x),
  sum = (rows, key) =>
    rows.reduce((n, r) => n.plus(r[key]), money(0)).toFixed(2);
db.$client.on("connection", (connection) => {
  connection.query("SET timestamp=" + Date.parse(F.CLOCK) / 1000);
  for (const method of ["query", "execute"]) {
    const original = connection[method];
    connection[method] = function (statement, ...args) {
      const query = typeof statement === "string" ? statement : statement.sql;
      const row = {
        phase,
        sql: query,
        params: Array.isArray(args[0]) ? args[0] : [],
      };
      traces.push(row);
      if (fault && /^insert into `digitalWalletTransactions`/i.test(query)) {
        fault = null;
        row.injectedFailure = "AFTER_INVOICE_BEFORE_WALLET_CLOSURE";
        throw Error("Q2_INJECTED_FINANCIAL_CLOSURE_FAILURE");
      }
      return original.call(this, statement, ...args);
    };
  }
});
await c.query("SET timestamp=" + Date.parse(F.CLOCK) / 1000);
const snap = await mysql.createConnection({
  host: "127.0.0.1",
  port: 13326,
  user: "root",
  password: "",
  database: oracleDatabase,
  timezone: "Z",
  decimalNumbers: false,
  multipleStatements: true,
});
const [[snapshotScope]] = await snap.query(
  "SELECT @@port port,DATABASE() db,@@datadir dataDir,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),NOW()) utcOffset",
);
assert.deepEqual(snapshotScope, {
  port: 13326,
  db: oracleDatabase,
  dataDir: server.dataDir,
  utcOffset: 0,
});
await snap.query("SET SESSION TRANSACTION READ ONLY");
const names = (
  await c.query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'")
)[0]
  .map((r) => Object.values(r)[0])
  .sort();
for (const name of names) assert.match(name, /^\w+$/);
assert.ok(names.includes("digitalSaleExecutionClaims"));
const [[claimDdl]] = await c.query(
  "SHOW CREATE TABLE digitalSaleExecutionClaims",
);
async function state() {
  const [sets] = await snap.query(
    names.map((n) => "SELECT * FROM `" + n + "`").join(";"),
  );
  return Object.fromEntries(
    names.map((n, i) => [
      n,
      sets[i].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ]),
  );
}
const evidence = {
  base: "908074a8767641079a92b7264f93d6a5ec608b04",
  clock: F.CLOCK,
  verifiedServer: {
    port: server.port,
    version: server.version,
    database: oracleDatabase,
    utcOffset: server.utcOffset,
  },
  claimDdl: claimDdl["Create Table"],
  sourceHashes: {},
  preservedQ1: {},
  scenarios,
  networkAttempts,
};
const originals = [
  "drizzle/schema.ts",
  "drizzle/migrations/0154_digital_sale_execution_claims.sql",
  "server/db.ts",
  "server/trpc.ts",
  "server/routers/digitalCards/salesRouter.ts",
  "server/routers/saleRouter.ts",
  "server/services/sale/create.ts",
  "server/services/posExternalPayment.ts",
  "server/services/ledgerService.ts",
  "server/services/inventoryService.ts",
  "server/services/creditApprovalService.ts",
  "server/services/tx.ts",
  "server/services/idempotency.ts",
];
for (const file of await readdir("server/services/digitalCards"))
  if (file.endsWith(".ts"))
    originals.push("server/services/digitalCards/" + file);
for (const file of await readdir("server/services/accounting"))
  if (file.endsWith(".ts"))
    originals.push("server/services/accounting/" + file);
for (const file of originals)
  evidence.sourceHashes[file] = sha(await readFile(file));
if (resume) {
  assert.equal(prior.status, "BLOCKED");
  assert.ok(
    [
      "mixed-multiprovider-educational",
      "credit-verified-approval-and-recovery",
    ].includes(resumePoint),
  );
  const bytes = await readFile(prior.out + "/oracle.json");
  const previous = JSON.parse(bytes);
  assert.deepEqual(previous.sourceHashes, evidence.sourceHashes);
  if (resumePoint === "mixed-multiprovider-educational")
    assert.match(
      previous.blocker.message,
      /Q2_INJECTED_FINANCIAL_CLOSURE_FAILURE/,
    );
  else {
    const refused = previous.scenarios.at(-1).commands.at(-1);
    assert.equal(refused.op, "VERIFIED_PREPARE");
    assert.match(refused.error.message, /SOD-03/);
    assertRefusalUnchanged(refused);
  }
  scenarios.push(...previous.scenarios.slice(0, -1));
  assert.equal(
    scenarios.length,
    resumePoint === "mixed-multiprovider-educational" ? 6 : 7,
  );
  await writeFile(
    provider.file,
    await readFile(prior.out + "/provider-ledger.ndjson"),
  );
  evidence.continuedFrom = {
    path: prior.out + "/oracle.json",
    sha256: sha(bytes),
    retainedCompletedScenarios: scenarios.length,
    reason:
      resumePoint === "mixed-multiprovider-educational"
        ? "Drizzle wrapped injected rollback error in cause; full row rollback already passed"
        : "Original RPC middleware failure audit accompanies verifier SOD audit; full financial graph unchanged",
  };
}
if (focused || collation) {
  assert.equal(prior.status, "DONE_WITH_CONCERNS");
  const bytes = await readFile(prior.out + "/oracle.json"),
    previous = JSON.parse(bytes);
  assert.deepEqual(previous.sourceHashes, evidence.sourceHashes);
  assert.equal(previous.scenarios.length, collation ? 9 : 8);
  scenarios.push(...previous.scenarios);
  await writeFile(
    provider.file,
    await readFile(prior.out + "/provider-ledger.ndjson"),
  );
  evidence.continuedFrom = {
    path: prior.out + "/oracle.json",
    sha256: sha(bytes),
    retainedCompletedScenarios: previous.scenarios.length,
    reason: collation
      ? "One metadata-backed ASCII case-collision probe; no matrix rerun"
      : "One authorized bounded UNKNOWN-retry and claimed-unissued-expiry followup; no matrix rerun",
  };
}
for (const file of [
  "experiments/d1-continuity/accounting/results/mysql-oracle.json",
  "experiments/d1-continuity/accounting/results/evidence-manifest.json",
]) {
  try {
    evidence.preservedQ1[file] = sha(await readFile(file));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
const fixtureText = await readFile(F.fixturePath, "utf8");
await writeFile(out + "/fixture.sql", fixtureText);
evidence.fixtureHash = sha(fixtureText);
async function save(status, error) {
  evidence.status = status;
  if (error)
    evidence.blocker = {
      scenario: current?.name,
      message: error.message,
      stack: error.stack,
    };
  evidence.providerLedger = await provider.rows();
  await writeFile(out + "/oracle.json", JSON.stringify(evidence, null, 2));
  const shapes = [
    ...new Set(
      scenarios.flatMap((s) =>
        s.commands.flatMap((c) =>
          c.trace.map((t) =>
            t.sql
              .replace(/\s+/g, " ")
              .trim()
              .replace(/\(\?(, \?)+\)/g, "(?)"),
          ),
        ),
      ),
    ),
  ].sort();
  await writeFile(out + "/sql-shapes.json", JSON.stringify(shapes, null, 2));
  const summary = {
    status,
    scenarios: scenarios.length,
    commands: scenarios.reduce((n, s) => n + s.commands.length, 0),
    sqlShapes: shapes.length,
    snapshotTables: names.length,
    providerCalls: evidence.providerLedger.length,
    networkAttempts: networkAttempts.length,
    blocker: evidence.blocker ?? null,
    out,
  };
  await writeFile(out + "/summary.json", JSON.stringify(summary, null, 2));
  await writeFile(
    "experiments/d1-continuity/digital/results/latest.json",
    JSON.stringify({ out, ...summary }, null, 2),
  );
  return summary;
}
async function scenario(name, mode = "ACTIVE") {
  phase = "SETUP";
  const start = traces.length;
  _clearAllMgrAttempts();
  await F.foundation(db, c, mode);
  current = {
    name,
    mode,
    actors: {
      cashier: F.cashier,
      manager: F.manager,
      secondCashier: F.secondCashier,
      foreignCashier: F.foreignCashier,
    },
    setupTrace: traces.slice(start),
    initial: await state(),
    commands: [],
  };
  scenarios.push(current);
  return current;
}
async function setup(label, callback) {
  phase = "SETUP";
  const start = traces.length;
  const result = await callback();
  current.setupTrace.push({ label, trace: traces.slice(start), result });
  return result;
}
async function call(
  op,
  input,
  actor = F.cashier,
  { reject = false, replay = false, errorPattern } = {},
) {
  const before = await state(),
    providerBefore = (await provider.rows()).length,
    start = traces.length;
  phase = "COMMAND";
  let result = null,
    error = null;
  try {
    if (op === "PREPARE")
      result = await withTx((tx) => intentService.prepare(tx, input, actor));
    else if (op === "VERIFIED_PREPARE") {
      const [user] = await db
        .select()
        .from(s.users)
        .where(eq(s.users.id, actor.userId));
      result = await salesRouter
        .createCaller({
          req: { headers: {} },
          res: {},
          user,
          sessionId: null,
          authenticationError: null,
          platformAdmin: null,
        })
        .prepare(input);
    } else if (op === "CLAIM")
      result = await withTx((tx) =>
        intentService.claimExecution(tx, input, actor),
      );
    else if (op === "MARK")
      result = await withTx((tx) =>
        intentService.markExecution(tx, input, actor),
      );
    else if (op === "FINALIZE" || op === "FINALIZE_FAULT") {
      if (op === "FINALIZE_FAULT") fault = true;
      result = await withTx((tx) => finalizeService.finalize(tx, input, actor));
    } else if (op === "RECOVER")
      result = await withTx((tx) =>
        finalizeService.recoverNeedsReview(tx, input.intentId, actor),
      );
    else if (op === "CANCEL")
      result = await withTx((tx) =>
        intentService.cancelIntent(tx, input, actor),
      );
    else if (op === "EXPIRE")
      result = await withTx((tx) =>
        intentService.expireStaleIntents(tx, new Date(input.now)),
      );
    else if (op === "PROVIDER")
      result = await provider.issue(input.request, input.options);
    else if (op === "PROVIDER_RESTART")
      result = await new SyntheticProvider(provider.file).issue(
        input.request,
        input.options,
      );
    else if (op === "RACE_PREPARE" || op === "RACE_CLAIM")
      result = (
        await Promise.allSettled(
          input.map((p) =>
            withTx((tx) =>
              op === "RACE_PREPARE"
                ? intentService.prepare(tx, p, actor)
                : intentService.claimExecution(tx, p, actor),
            ),
          ),
        )
      ).map((r) =>
        r.status === "fulfilled"
          ? r
          : {
              status: "rejected",
              reason: {
                code: r.reason.code ?? "ERROR",
                message: r.reason.message,
                cause: r.reason.cause?.message,
              },
            },
      );
    else throw Error("UNKNOWN_ORACLE_OPERATION:" + op);
  } catch (e) {
    error = {
      code: e.code ?? "ERROR",
      message: e.message,
      cause: e.cause?.message,
    };
  } finally {
    fault = null;
  }
  const after = await state(),
    trace = traces.slice(start),
    providerAfter = await provider.rows();
  const command = {
    op,
    input,
    actor,
    result,
    error,
    expected: { reject, replay, errorPattern: errorPattern?.source },
    before,
    after,
    trace,
    sqlCount: trace.length,
    providerEvents: providerAfter.slice(providerBefore),
  };
  current.commands.push(command);
  await appendFile(
    out + "/commands.ndjson",
    JSON.stringify({ scenario: current.name, ...command }) + "\n",
  );
  if (reject) {
    assert.ok(error, "Expected original refusal: " + op);
    assertRefusalUnchanged(command);
    if (errorPattern)
      assert.match(error.message + "\n" + (error.cause ?? ""), errorPattern);
  } else assert.equal(error, null, JSON.stringify(error));
  if (replay)
    assert.deepEqual(
      after,
      before,
      "Replay repeated financial/source effects: " + op,
    );
  return result;
}
async function rows(table, where = "1=1") {
  return (await c.query("SELECT * FROM `" + table + "` WHERE " + where))[0];
}
function finalInput(intentId, total, extra = {}) {
  return {
    intentId,
    clientRequestId: "q2-final-" + current.name,
    paymentAmount: total,
    paymentMethod: "CASH",
    ...extra,
  };
}
async function issue(intentId, { lostItem = null, status = "SUCCESS" } = {}) {
  const items = await rows("digitalSaleIntentItems", "intentId=" + intentId);
  for (const item of items) {
    const claim = await call("CLAIM", {
      intentId,
      intentItemId: item.id,
      claimToken: "q2-claim-" + current.name + "-" + item.id,
    });
    const request = {
      synthetic: true,
      namespace: current.name,
      providerIdempotencyKey: claim.providerIdempotencyKey,
      providerReference: item.providerReference,
    };
    if (item.id === lostItem) {
      await call(
        "PROVIDER",
        { request, options: { loseResponse: true } },
        F.cashier,
        { reject: true, errorPattern: /SYNTHETIC_PROVIDER_RESPONSE_LOST/ },
      );
      await call("MARK", {
        intentId,
        intentItemId: item.id,
        claimToken: claim.claimToken,
        status: "UNKNOWN",
        providerReference: item.providerReference,
      });
    } else {
      const result = await call("PROVIDER", {
        request,
        options: { outcome: status },
      });
      await call("MARK", {
        intentId,
        intentItemId: item.id,
        claimToken: claim.claimToken,
        status: result.status,
        providerReference: result.providerReference,
      });
    }
  }
}
async function assertWallet(walletId, balance, reserved) {
  const [w] = await rows("digitalWallets", "id=" + walletId);
  assert.equal(w.currentBalance, balance);
  assert.equal(w.reservedBalance, reserved);
}
try {
  if (collation) {
    await scenario("reference-collation-probe");
    const [columns] = await c.query(
      "SELECT COLUMN_NAME,COLLATION_NAME,GENERATION_EXPRESSION,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='digitalSaleIntentItems' AND COLUMN_NAME IN ('refKey','providerReference') ORDER BY COLUMN_NAME",
    );
    const [indexes] = await c.query(
      "SHOW INDEX FROM digitalSaleIntentItems WHERE Key_name='uq_dsii_provider_ref'",
    );
    const [[ddl]] = await c.query("SHOW CREATE TABLE digitalSaleIntentItems");
    const migration = "drizzle/migrations/0332_digital_card_baskets.sql";
    current.collation = {
      columns,
      indexes,
      ddl: ddl["Create Table"],
      migration,
      migrationSha256: sha(await readFile(migration)),
    };
    const keyColumn = columns.find((c) => c.COLUMN_NAME === "refKey");
    assert.match(keyColumn.GENERATION_EXPRESSION, /referenceOwnerItemId/);
    assert.ok(
      indexes.some((i) => i.Non_unique === 0 && i.Column_name === "refKey"),
    );
    const p = await setup("collation provider", () =>
      F.provider(db, { name: "collation" }),
    );
    const reference = "Q2CollationAbC001",
      variant = reference.toLowerCase();
    await call(
      "PREPARE",
      F.input("collation-original", [
        F.digitalLine(p, "collation-original", {
          providerReference: reference,
        }),
      ]),
    );
    const ci = /_ci$/i.test(keyColumn.COLLATION_NAME ?? "");
    await call(
      "PREPARE",
      F.input("collation-variant", [
        F.digitalLine(p, "collation-variant", { providerReference: variant }),
      ]),
      F.cashier,
      { reject: ci },
    );
    current.collation.observed = ci
      ? "ASCII_CASE_VARIANT_REFUSED_FULL_GRAPH_UNCHANGED"
      : "NON_CI_COLLATION_CASE_VARIANT_ACCEPTED";
    assert.equal(current.commands.at(-1).after.invoices.length, 0);
    assert.equal(current.commands.at(-1).after.receipts.length, 0);
    assert.equal(current.commands.at(-1).after.accountingEntries.length, 0);
  } else if (focused) {
    await scenario("uncertain-retry-and-unissued-expiry");
    const p = await setup("followup prepaid provider", () =>
      F.provider(db, { name: "uncertain-followup" }),
    );
    const pending = await call(
      "PREPARE",
      F.input("pending-claim", [F.digitalLine(p, "pending-claim")]),
    );
    const [pendingItem] = await rows(
      "digitalSaleIntentItems",
      "intentId=" + pending.intentId,
    );
    const pendingClaim = await call("CLAIM", {
      intentId: pending.intentId,
      intentItemId: pendingItem.id,
      claimToken: "q2-pending-unissued",
    });
    await call("EXPIRE", { now: "2026-10-19T13:00:00Z" });
    assert.equal(
      (await rows("digitalSaleIntents", "id=" + pending.intentId))[0].status,
      "NEEDS_REVIEW",
    );
    await call("EXPIRE", { now: "2026-10-19T13:00:00Z" }, F.cashier, {
      replay: true,
    });
    assert.ok(
      !(await provider.rows()).some(
        (r) =>
          r.namespace === current.name &&
          r.key === pendingClaim.providerIdempotencyKey,
      ),
    );
    const unknown = await call(
      "PREPARE",
      F.input("unknown-retry", [F.digitalLine(p, "unknown-retry")]),
    );
    const [unknownItem] = await rows(
      "digitalSaleIntentItems",
      "intentId=" + unknown.intentId,
    );
    const claim = await call("CLAIM", {
      intentId: unknown.intentId,
      intentItemId: unknownItem.id,
      claimToken: "q2-unknown-original",
    });
    await call(
      "PROVIDER",
      {
        request: {
          synthetic: true,
          namespace: current.name,
          providerIdempotencyKey: claim.providerIdempotencyKey,
          providerReference: unknownItem.providerReference,
        },
        options: { loseResponse: true },
      },
      F.cashier,
      { reject: true, errorPattern: /SYNTHETIC_PROVIDER_RESPONSE_LOST/ },
    );
    await call("MARK", {
      intentId: unknown.intentId,
      intentItemId: unknownItem.id,
      claimToken: claim.claimToken,
      status: "UNKNOWN",
      providerReference: unknownItem.providerReference,
    });
    for (const claimToken of ["q2-unknown-new-window", claim.claimToken])
      await call(
        "CLAIM",
        {
          intentId: unknown.intentId,
          intentItemId: unknownItem.id,
          claimToken,
        },
        F.cashier,
        { reject: true, errorPattern: /مراجعة/ },
      );
    await call("CANCEL", {
      intentId: unknown.intentId,
      reason: "Synthetic UNKNOWN retained for review",
    });
    await call("EXPIRE", { now: "2026-10-19T13:00:00Z" }, F.cashier, {
      replay: true,
    });
    await assertWallet(
      p.walletId,
      "100000.00",
      money(p.share).times(2).toFixed(2),
    );
    const final = current.commands.at(-1).after;
    assert.equal(final.invoices.length, 0);
    assert.equal(final.receipts.length, 0);
    assert.equal(final.accountingEntries.length, 0);
  } else {
    if (!resume) {
      // Financial paths in both runtime modes; all approvals/maps are synthetic setup.
      for (const mode of ["SHADOW", "ACTIVE"])
        for (const settlement of ["PREPAID", "POSTPAID"]) {
          await scenario(mode + "-" + settlement, mode);
          const p = await setup(
            "original provider/catalog/price publication",
            () => F.provider(db, { name: current.name, mode: settlement }),
          );
          const count = settlement === "POSTPAID" ? 2 : 1,
            lines = Array.from({ length: count }, (_, i) =>
              F.digitalLine(p, current.name + "-" + i),
            ),
            request = F.input(current.name, lines);
          const prepared = await call("PREPARE", request),
            total = money(p.price).times(count).toFixed(2);
          await call("PREPARE", request, F.cashier, { replay: true });
          await call(
            "PREPARE",
            {
              ...request,
              lines: [
                {
                  ...lines[0],
                  expectedSellPrice: money(p.price).plus("0.01").toFixed(2),
                },
              ],
            },
            F.cashier,
            { reject: true },
          );
          const preparedState = current.commands[0].after;
          assert.equal(preparedState.invoices.length, 0);
          assert.equal(preparedState.receipts.length, 0);
          assert.equal(preparedState.digitalWalletTransactions.length, 0);
          if (p.walletId) await assertWallet(p.walletId, "100000.00", p.share);
          else assert.equal(preparedState.digitalWalletReservations.length, 0);
          await call(
            "FINALIZE",
            finalInput(prepared.intentId, total),
            F.cashier,
            {
              reject: true,
            },
          );
          await issue(prepared.intentId);
          await call(
            "FINALIZE",
            finalInput(
              prepared.intentId,
              money(total).minus("0.01").toFixed(2),
            ),
            F.cashier,
            { reject: true },
          );
          const result = await call(
            "FINALIZE",
            finalInput(prepared.intentId, total),
          );
          const replay = await call(
            "FINALIZE",
            finalInput(prepared.intentId, total),
            F.cashier,
            { replay: true },
          );
          assert.equal(replay.invoiceId, result.invoiceId);
          const final = current.commands.at(-1).after,
            details = final.digitalSaleDetails;
          assert.equal(details.length, count);
          assert.equal(
            sum(details, "providerShareSnapshot"),
            money(p.share).times(count).toFixed(2),
          );
          assert.equal(final.inventoryMovements.length, 0);
          if (p.walletId) {
            await assertWallet(
              p.walletId,
              money("100000").minus(p.share).toFixed(2),
              "0.00",
            );
            assert.equal(final.digitalWalletTransactions.length, 1);
            assert.ok(details[0].walletTransactionId);
          } else {
            const ap = final.accountingEntries.filter((e) =>
              e.dedupeKey?.startsWith("DIGITAL:AP:"),
            );
            assert.equal(ap.length, 1);
            assert.equal(ap[0].amount, money(p.share).times(count).toFixed(2));
            assert.equal(
              final.suppliers.find((s) => s.id === p.supplierId).currentBalance,
              ap[0].amount,
            );
          }
        }
      await scenario("reservation-race-cleanup");
      const raceProvider = await setup("last available balance", () =>
        F.provider(db, { name: "last-balance", balance: "13400.37" }),
      );
      const requests = ["race-a", "race-b"].map((key) =>
        F.input(key, [F.digitalLine(raceProvider, key)]),
      );
      const race = await call("RACE_PREPARE", requests);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(race.filter((r) => r.status === "rejected").length, 1);
      await assertWallet(raceProvider.walletId, "13400.37", "13400.37");
      const winner = race.find((r) => r.status === "fulfilled").value.intentId;
      await call("CANCEL", {
        intentId: winner,
        reason: "Synthetic unused reservation",
      });
      await call(
        "CANCEL",
        { intentId: winner, reason: "Synthetic unused reservation" },
        F.cashier,
        { replay: true },
      );
      await assertWallet(raceProvider.walletId, "13400.37", "0.00");
      const expiry = await call(
        "PREPARE",
        F.input("expiry-safe", [F.digitalLine(raceProvider, "expiry-safe")]),
      );
      await call("EXPIRE", { now: "2026-10-19T13:00:00Z" });
      await call("EXPIRE", { now: "2026-10-19T13:00:00Z" }, F.cashier, {
        replay: true,
      });
      assert.equal(
        (await rows("digitalSaleIntents", "id=" + expiry.intentId))[0].status,
        "EXPIRED",
      );
      await assertWallet(raceProvider.walletId, "13400.37", "0.00");

      await scenario("claim-and-uncertain-provider");
      const cp = await setup("two-card provider", () =>
        F.provider(db, { name: "claim-provider" }),
      );
      const ci = await call(
        "PREPARE",
        F.input("claim-main", [
          F.digitalLine(cp, "claim-a"),
          F.digitalLine(cp, "claim-b"),
        ]),
      );
      const [a, b] = await rows(
        "digitalSaleIntentItems",
        "intentId=" + ci.intentId,
      );
      const claims = ["q2-window-alpha", "q2-window-bravo"].map(
        (claimToken) => ({
          intentId: ci.intentId,
          intentItemId: a.id,
          claimToken,
        }),
      );
      const cr = await call("RACE_CLAIM", claims);
      assert.equal(cr.filter((r) => r.status === "fulfilled").length, 1);
      const owner = cr.find((r) => r.status === "fulfilled").value;
      await call(
        "CLAIM",
        {
          intentId: ci.intentId,
          intentItemId: a.id,
          claimToken: owner.claimToken,
        },
        F.cashier,
        { replay: true },
      );
      await call(
        "MARK",
        {
          intentId: ci.intentId,
          intentItemId: a.id,
          claimToken: owner.claimToken,
          status: "SUCCESS",
          providerReference: a.providerReference,
        },
        F.secondCashier,
        { reject: true },
      );
      await call(
        "CLAIM",
        {
          intentId: ci.intentId,
          intentItemId: a.id,
          claimToken: "q2-foreign-window",
        },
        F.foreignCashier,
        { reject: true },
      );
      await call(
        "CLAIM",
        {
          intentId: ci.intentId,
          intentItemId: 999999,
          claimToken: "q2-wrong-item",
        },
        F.cashier,
        { reject: true },
      );
      await setup("expire lease only", () =>
        c.query(
          "UPDATE digitalSaleExecutionClaims SET expiresAt=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 1 MINUTE) WHERE intentItemId=?",
          [a.id],
        ),
      );
      await call(
        "CLAIM",
        {
          intentId: ci.intentId,
          intentItemId: a.id,
          claimToken: "q2-no-reassignment",
        },
        F.manager,
        { reject: true },
      );
      const firstRequest = {
        synthetic: true,
        namespace: current.name,
        providerIdempotencyKey: owner.providerIdempotencyKey,
        providerReference: a.providerReference,
      };
      await call("PROVIDER", { request: firstRequest });
      const firstMark = {
        intentId: ci.intentId,
        intentItemId: a.id,
        claimToken: owner.claimToken,
        status: "SUCCESS",
        providerReference: a.providerReference,
      };
      await call("MARK", firstMark);
      await call("MARK", firstMark, F.cashier, { replay: true });
      await call("MARK", { ...firstMark, status: "FAILED" }, F.cashier, {
        reject: true,
      });
      assert.equal(
        (await rows("digitalSaleIntents", "id=" + ci.intentId))[0].status,
        "EXECUTING",
      );
      const bc = await call("CLAIM", {
        intentId: ci.intentId,
        intentItemId: b.id,
        claimToken: "q2-lost-response",
      });
      const lostRequest = {
        synthetic: true,
        namespace: current.name,
        providerIdempotencyKey: bc.providerIdempotencyKey,
        providerReference: b.providerReference,
      };
      await call(
        "PROVIDER",
        { request: lostRequest, options: { loseResponse: true } },
        F.cashier,
        { reject: true, errorPattern: /SYNTHETIC_PROVIDER_RESPONSE_LOST/ },
      );
      await call("MARK", {
        intentId: ci.intentId,
        intentItemId: b.id,
        claimToken: bc.claimToken,
        status: "UNKNOWN",
        providerReference: b.providerReference,
      });
      const lostReplay = await call("PROVIDER_RESTART", {
        request: lostRequest,
      });
      assert.equal(lostReplay.replay, true);
      await call(
        "MARK",
        {
          intentId: ci.intentId,
          intentItemId: b.id,
          claimToken: bc.claimToken,
          status: "SUCCESS",
          providerReference: b.providerReference,
        },
        F.manager,
        { reject: true },
      );
      await call(
        "FINALIZE",
        finalInput(ci.intentId, money(cp.price).times(2).toFixed(2)),
        F.cashier,
        { reject: true },
      );
      const review = await call("CANCEL", {
        intentId: ci.intentId,
        reason: "Lost synthetic response",
      });
      assert.equal(review.outcome, "NEEDS_REVIEW");
      await call("EXPIRE", { now: "2026-10-19T13:00:00Z" });
      await assertWallet(
        cp.walletId,
        "100000.00",
        money(cp.share).times(2).toFixed(2),
      );
      const failed = await call(
        "PREPARE",
        F.input("failed-safe", [F.digitalLine(cp, "failed-safe")]),
      );
      await issue(failed.intentId, { status: "FAILED" });
      await call("CANCEL", {
        intentId: failed.intentId,
        reason: "Definitive synthetic rejection",
      });
      await assertWallet(
        cp.walletId,
        "100000.00",
        money(cp.share).times(2).toFixed(2),
      );
    }
    if (resumePoint !== "credit-verified-approval-and-recovery") {
      await scenario("mixed-multiprovider-educational");
      const pre = await setup("mixed PREPAID", () =>
        F.provider(db, { name: "mixed-pre" }),
      );
      const post = await setup("mixed POSTPAID", () =>
        F.provider(db, { name: "mixed-post", mode: "POSTPAID" }),
      );
      const mixedLines = [
        F.digitalLine(pre, "mixed-pre"),
        F.digitalLine(post, "mixed-post"),
      ];
      mixedLines[1].providerReference = mixedLines[0].providerReference;
      const mi = F.input("mixed", mixedLines, {
        regularLines: [
          {
            lineKey: "ordinary-1",
            variantId: 1,
            productUnitId: 1,
            quantity: "2",
          },
        ],
      });
      await call(
        "PREPARE",
        {
          ...mi,
          clientRequestId: "q2-wrong-version",
          lines: [{ ...mixedLines[0], priceVersionId: 999999 }],
        },
        F.cashier,
        { reject: true },
      );
      const mp = await call("PREPARE", mi);
      await call(
        "PREPARE",
        F.input("collision", [
          {
            ...F.digitalLine(pre, "collision"),
            providerReference: mixedLines[0].providerReference,
          },
        ]),
        F.cashier,
        { reject: true },
      );
      await issue(mp.intentId);
      const mixedTotal = money(pre.price)
        .plus(post.price)
        .plus("200")
        .toFixed(2);
      await call(
        "FINALIZE_FAULT",
        finalInput(mp.intentId, mixedTotal),
        F.cashier,
        {
          reject: true,
          errorPattern: /Q2_INJECTED_FINANCIAL_CLOSURE_FAILURE/,
        },
      );
      await call("FINALIZE", finalInput(mp.intentId, mixedTotal));
      await call("FINALIZE", finalInput(mp.intentId, mixedTotal), F.cashier, {
        replay: true,
      });
      const ms = current.commands.at(-1).after;
      assert.equal(ms.inventoryMovements.length, 1);
      assert.equal(ms.branchStock.find((r) => r.id === 1).quantity, 98);
      const edu = await setup("educational offering", () =>
        F.provider(db, { name: "edu", mode: "POSTPAID", educational: true }),
      );
      await call(
        "PREPARE",
        F.input("edu-missing", [F.digitalLine(edu, "edu-missing")]),
        F.cashier,
        { reject: true },
      );
      const student = {
        studentName: "Q2 Synthetic Student",
        studentPhone: "07700000000",
      };
      await call(
        "PREPARE",
        F.input("tel-student", [
          F.digitalLine(pre, "tel-student", { student }),
        ]),
        F.cashier,
        { reject: true },
      );
      const ep = await call(
        "PREPARE",
        F.input("edu-valid", [F.digitalLine(edu, "edu-valid", { student })]),
      );
      await issue(ep.intentId);
      await call(
        "FINALIZE",
        finalInput(ep.intentId, edu.price, { clientRequestId: "q2-edu-final" }),
      );
      const es = current.commands.at(-1).after;
      assert.equal(es.studentProfiles.length, 0);
      assert.equal(es.digitalSubscriptionContracts.length, 0);
      assert.equal(
        es.digitalOfferings.find((r) => r.id === edu.offeringId)
          .subscriptionDurationDays,
        null,
      );
      assert.equal(
        es.digitalSaleDetails.find((r) => r.offeringId === edu.offeringId)
          .studentNameSnapshot,
        student.studentName,
      );
    }
    await scenario("credit-verified-approval-and-recovery");
    const credit = await setup("credit provider", () =>
      F.provider(db, { name: "credit" }),
    );
    await setup("cash-only credit limit", () =>
      db
        .update(s.customers)
        .set({ creditLimit: "0.00" })
        .where(eq(s.customers.id, 1)),
    );
    const denied = F.invoiceInput("credit-plain", [credit]);
    await call(
      "PREPARE",
      { ...denied, priceApprovedBy: 2, creditApprovedBy: 2 },
      F.cashier,
      { reject: true },
    );
    await call(
      "PREPARE",
      {
        ...denied,
        clientRequestId: "q2-credit-json",
        creditApprovedBy: 2,
        creditApprovalCapability: "VERIFIED_DIGITAL_CREDIT_APPROVAL",
      },
      F.cashier,
      { reject: true },
    );
    await call(
      "VERIFIED_PREPARE",
      F.invoiceInput("credit-self", [credit], { approved: true }),
      F.manager,
      { reject: true, errorPattern: /نفس|ذاتي|منفذ|منفّذ/ },
    );
    const approved = await call(
      "VERIFIED_PREPARE",
      F.invoiceInput("credit-approved", [credit], { approved: true }),
    );
    await issue(approved.intentId);
    const [approvedRow] = await rows(
      "digitalSaleIntents",
      "id=" + approved.intentId,
    );
    assert.equal(approvedRow.checkoutSnapshot.priceApprovedBy, 2);
    assert.ok(approvedRow.checkoutSnapshot.creditApprovalId);
    await setup("expire approved credit after issuance", () =>
      db
        .update(s.creditApprovals)
        .set({ expiresAt: new Date("2026-10-19T11:59:00Z") })
        .where(
          eq(
            s.creditApprovals.id,
            approvedRow.checkoutSnapshot.creditApprovalId,
          ),
        ),
    );
    await call(
      "FINALIZE",
      finalInput(approved.intentId, "0.00", {
        paymentMethod: "CREDIT",
        customerId: 1,
      }),
      F.cashier,
      { reject: true },
    );
    await call("CANCEL", {
      intentId: approved.intentId,
      reason: "Synthetic expired approval review",
    });
    await call("RECOVER", { intentId: approved.intentId }, F.cashier, {
      reject: true,
    });
    const recovered = await call(
      "RECOVER",
      { intentId: approved.intentId },
      F.manager,
    );
    const recoveredState = current.commands.at(-1).after;
    assert.equal(recoveredState.receipts.length, 0);
    assert.equal(
      recoveredState.customers.find((c) => c.id === 1).currentBalance,
      credit.price,
    );
    assert.equal(recoveredState.invoices[0].createdBy, 1);
    assert.equal(
      recoveredState.creditApprovals.filter(
        (a) => a.consumedByInvoiceId === recovered.invoiceId,
      ).length,
      1,
    );
    await setup("valid preflight credit policy", () =>
      db
        .update(s.customers)
        .set({ creditLimit: "100000.00" })
        .where(eq(s.customers.id, 1)),
    );
    const admitted = await call(
      "PREPARE",
      F.invoiceInput("credit-preflight", [credit]),
    );
    await issue(admitted.intentId);
    await setup("credit limit changed after actual synthetic issuance", () =>
      db
        .update(s.customers)
        .set({ creditLimit: "0.00" })
        .where(eq(s.customers.id, 1)),
    );
    await call(
      "FINALIZE",
      finalInput(admitted.intentId, "0.00", {
        paymentMethod: "CREDIT",
        customerId: 1,
        clientRequestId: "q2-preflight-final",
      }),
    );
    assert.equal(current.commands.at(-1).after.receipts.length, 0);
    assert.equal(
      current.commands.at(-1).after.customers.find((c) => c.id === 1)
        .currentBalance,
      money(credit.price).times(2).toFixed(2),
    );
    assert.equal(current.commands.at(-1).after.creditApprovals.length, 2);
  }
  for (const [file, hash] of Object.entries(evidence.sourceHashes))
    assert.equal(
      sha(await readFile(file)),
      hash,
      "Original source drift: " + file,
    );
  for (const [file, hash] of Object.entries(evidence.preservedQ1))
    assert.equal(
      sha(await readFile(file)),
      hash,
      "Prior evidence changed: " + file,
    );
  evidence.providerLedger = await provider.rows();
  validateEvidence(evidence);
  assert.equal(networkAttempts.length, 0, "An external effect was attempted");
  const summary = await save("DONE_WITH_CONCERNS");
  console.log(JSON.stringify(summary));
} catch (error) {
  console.log(JSON.stringify(await save("BLOCKED", error)));
  throw error;
} finally {
  await snap.end();
  await c.end();
  await closeDb();
  mock.timers.reset();
}
