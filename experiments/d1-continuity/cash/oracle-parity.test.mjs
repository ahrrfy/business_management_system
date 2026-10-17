import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";
import { buildActualCashWorker, cashRoot } from "./build.mjs";
import { sqlStatements } from "./sql-statements.mjs";

test("D1 original cash command matches real original MySQL financial rows", async () => {
  const oracle = JSON.parse(
    await readFile(path.join(cashRoot, "results/mysql-oracle.json"), "utf8"),
  );
  const buildRoot = path.resolve(
    cashRoot,
    "../../../.superpowers/sdd/cash-parity-build",
  );
  const entry = `import {prepareCashSale,applyCashPlan} from './actual'; import {tables,quote} from './schema'; export default {async fetch(req,env){const data=await req.json();let result=null,error=null;try{const p=await prepareCashSale(env.DB,data.input,data.actor);await applyCashPlan(env.DB,p.plan);result=p.result;}catch(e){error={code:e.code??'ERROR',message:e.message};}const rows=await env.DB.batch(tables.map(t=>env.DB.prepare('SELECT * FROM '+quote(t.name))));return Response.json({result,error,tables:Object.fromEntries(tables.map((t,i)=>[t.name,rows[i].results]))});}};`;
  await buildActualCashWorker({
    stdin: entry,
    outfile: path.join(buildRoot, "worker.mjs"),
  });
  const schema = await readFile(path.join(buildRoot, "schema.sql"), "utf8"),
    fixture = await readFile(path.join(buildRoot, "fixture.sql"), "utf8"),
    metadata = JSON.parse(
      await readFile(path.join(buildRoot, "tables.json"), "utf8"),
    );
  function normalized(rows, table) {
    const meta = metadata.find((t) => t.name === table);
    assert.ok(meta);
    return rows
      .map((row) =>
        Object.fromEntries(
          meta.columns.map((c) => {
            let value = row[c.name];
            if (value != null && /date|time/i.test(c.sqlType)) {
              const s = String(value),
                d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
              assert.ok(Number.isFinite(d.getTime()));
              // Separate executions have different command clocks. Preserve the day and
              // distinguish deterministic fixture midnight from automatically updated time.
              value =
                d.toISOString().slice(0, 10) +
                (d.toISOString().slice(11, 23) === "00:00:00.000"
                  ? ":FIXTURE_MIDNIGHT"
                  : ":COMMAND_TIME");
            } else if (value != null && c.sqlType === "json")
              value = typeof value === "string" ? JSON.parse(value) : value;
            return [c.name, value ?? null];
          }),
        ),
      )
      .sort((a, b) =>
        JSON.stringify(meta.primary.map((k) => a[k])).localeCompare(
          JSON.stringify(meta.primary.map((k) => b[k])),
        ),
      );
  }
  const results = [];
  for (const scenario of oracle.scenarios) {
    const runtime = new Miniflare({
      modules: [
        { type: "ESModule", path: path.join(buildRoot, "worker.mjs") },
        { type: "CompiledWasm", path: path.join(buildRoot, "sql-wasm.wasm") },
      ],
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      log: new Log(LogLevel.NONE),
      d1Databases: ["DB"],
      outboundService: () =>
        new Response("HOSTINGER_UNAVAILABLE", { status: 503 }),
    });
    try {
      const db = await runtime.getD1Database("DB");
      for (const sql of [schema, fixture])
        await db.batch(sqlStatements(sql).map((s) => db.prepare(s)));
      const r = await runtime.dispatchFetch("http://parity.invalid/", {
          method: "POST",
          body: JSON.stringify(scenario),
        }),
        actual = await r.json();
      if (scenario.error) {
        assert.ok(actual.error, scenario.name + " expected original rejection");
        assert.equal(actual.error.code, scenario.error.code);
      } else {
        assert.equal(actual.error, null, JSON.stringify(actual.error));
        assert.deepEqual(
          actual.result,
          scenario.result,
          scenario.name + " result",
        );
      }
      // Assert physical DATE storage before the timestamp comparison below.
      // MySQL DATE cannot retain a command clock in the financial journal.
      for (const row of actual.tables.accountingEntries) {
        assert.match(
          row.entryDate,
          /^\d{4}-\d{2}-\d{2}$/,
          scenario.name + " raw accountingEntries.entryDate",
        );
        const expected = scenario.tables.accountingEntries.find(
          (r) => r.id === row.id,
        );
        assert.ok(expected, scenario.name + " MySQL journal row exists");
        assert.equal(
          row.entryDate,
          new Date(expected.entryDate).toISOString().slice(0, 10),
          scenario.name + " exact MySQL DATE value",
        );
      }
      for (const [table, rows] of Object.entries(scenario.tables))
        assert.deepEqual(
          normalized(actual.tables[table], table),
          normalized(rows, table),
          scenario.name + " " + table + " financial fields",
        );
      results.push({
        name: scenario.name,
        passed: true,
        rejected: !!scenario.error,
        tablesCompared: Object.keys(scenario.tables).length,
      });
    } finally {
      await runtime.dispose();
    }
  }
  await writeFile(
    path.join(cashRoot, "results/mysql-parity.json"),
    JSON.stringify(
      {
        passed: true,
        server: oracle.verifiedServer,
        scenarios: results,
        timestampComparison:
          "same UTC day and deterministic fixture-vs-command distinction; exact money/ids/status/links/quantity/json/remaining fields",
      },
      null,
      2,
    ),
  );
});
