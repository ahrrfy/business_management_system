import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { accountingRoot } from "./build.mjs";
await mkdir(new URL("./build/", import.meta.url), { recursive: true });
await build({
  stdin: {
    contents:
      "export{planChangeGroups,planMutationStatements}from'../cash/plan-runtime';export{tables}from'./schema';export{tables as originalTables}from'../returns/schema'",
    resolveDir: accountingRoot,
    loader: "ts",
  },
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: accountingRoot + "/build/port-unit.mjs",
  logLevel: "silent",
});
const { planChangeGroups, planMutationStatements, tables, originalTables } =
  await import("./build/port-unit.mjs");
test("native grouping preserves30-row default and100-bind chunks", () => {
  const changes = Array.from({ length: 20 }, (_, id) => ({
    table: "journalLines",
    key: { id },
    before: null,
    after: Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => ["c" + i, i]),
    ),
  }));
  assert.equal(planMutationStatements(changes), 20);
  const grouped = planChangeGroups(changes, true);
  assert.deepEqual(
    grouped.map((g) => g.length),
    [7, 7, 6],
  );
  assert.ok(grouped.every((g) => g.length * 14 <= 100));
  assert.deepEqual(grouped.flat(), changes);
  assert.equal(planMutationStatements(changes, true), 3);
  const mixed = [changes[0], { ...changes[1], before: {} }, changes[2]];
  assert.equal(planMutationStatements(mixed, true), 4);
});
test("existing projection definitions and original Q1A source/evidence remain unchanged", async () => {
  for (const original of originalTables)
    assert.deepEqual(
      tables.find((t) => t.name === original.name),
      original,
    );
  const oracleBytes = await readFile(
    new URL("./results/mysql-oracle.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(oracleBytes).digest("hex"),
    "19cdde735acf78eb130b2e418267a95e9c140c5d804fc31d7b273b6f27b492ca",
  );
  const oracle = JSON.parse(oracleBytes);
  for (const [name, expected] of Object.entries(oracle.sourceHashes))
    assert.equal(
      createHash("sha256")
        .update(await readFile(name))
        .digest("hex"),
      expected,
      name,
    );
});
