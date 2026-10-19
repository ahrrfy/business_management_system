import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  creditCloudContext,
  verifyCreditResources,
  legacyProof,
} from "../credit/cloud-run.mjs";
import { cashCloudClient } from "../cash/cloud-client.mjs";
import { buildReturnsWorker, returnsRoot } from "./build.mjs";
import { deploy } from "./cloud-run.mjs";
assert.equal(process.argv[2], "--confirm-isolated-returns-lab");
const c = await creditCloudContext();
await verifyCreditResources(c);
assert.ok(
  (await c.invoke(["whoami"], false, true)).includes(c.runtime.accountId),
);
const outputDir = path.join(returnsRoot, "results/perf-deploy-" + Date.now());
await mkdir(outputDir, { recursive: true });
const call = cashCloudClient(c, () => {});
const source = (await call(c.source, "/snapshot?manifest=1")).body;
const restore = (await call(c.restore, "/snapshot?manifest=1")).body;
assert.ok(source.epoch >= 417);
assert.equal(source.role, "primary");
assert.equal(restore.role, "restore");
assert.deepEqual(source, { ...restore, role: "primary" });
const original = JSON.parse(
  await readFile(
    path.join(returnsRoot, "results/cloud-20261019/before.json"),
    "utf8",
  ),
);
const legacy = {},
  versions = {};
for (const role of ["primary", "restore", "journal"]) {
  legacy[role] = await legacyProof(c, role);
  assert.deepEqual(legacy[role], original.legacy[role]);
}
for (const role of ["primary", "restore"])
  versions[role] = await c.invoke(
    ["deployments", "list", "--name", c.runtime.workers[role], "--json"],
    true,
    true,
  );
await writeFile(
  path.join(outputDir, "before.json"),
  JSON.stringify(
    { at: new Date().toISOString(), source, restore, legacy, versions },
    null,
    2,
  ),
  { flag: "wx" },
);
const indexSql =
  "CREATE INDEX IF NOT EXISTS returns_receipt_ledger ON accountingEntries(receiptId)";
const indexProof = {};
for (const role of ["restore", "primary"]) {
  const inspect = () =>
    c.invoke(
      [
        "d1",
        "execute",
        c.runtime.databases[role].databaseId,
        "--remote",
        "--command",
        "SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND name='returns_receipt_ledger'",
        "--json",
      ],
      true,
      true,
    );
  let rows = (await inspect())[0].results;
  const normalize = (sql) =>
    sql
      .replace(/IF NOT EXISTS /, " ")
      .replace(/[\s;]/g, "")
      .toLowerCase();
  if (rows.length) assert.equal(normalize(rows[0].sql), normalize(indexSql));
  else
    await c.invoke(
      [
        "d1",
        "execute",
        c.runtime.databases[role].databaseId,
        "--remote",
        "--command",
        indexSql,
        "--json",
      ],
      true,
      false,
    );
  rows = (await inspect())[0].results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tbl_name, "accountingEntries");
  assert.equal(normalize(rows[0].sql), normalize(indexSql));
  indexProof[role] = rows[0];
}
await writeFile(
  path.join(outputDir, "index.json"),
  JSON.stringify({ indexProof, financialRowsChanged: false }, null, 2),
);
await buildReturnsWorker({
  outfile: path.join(returnsRoot, "build/cloud/worker.mjs"),
});
await buildReturnsWorker({
  stdin: "export{default}from'../credit/coordinated-worker';",
  outfile: path.join(returnsRoot, "build/cloud/restore/worker.mjs"),
});
await deploy({ outputDir });
await verifyCreditResources(c);
assert.deepEqual((await call(c.source, "/snapshot?manifest=1")).body, source);
assert.deepEqual((await call(c.restore, "/snapshot?manifest=1")).body, restore);
console.log(
  JSON.stringify({
    passed: true,
    outputDir,
    epoch: source.epoch,
    newResources: 0,
  }),
);
