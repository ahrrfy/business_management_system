// Read-only completion of an already executed/exported/restored qualification.
// Never resubmits sale, collection, return or restore commands.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  creditCloudContext,
  verifyCreditResources,
  legacyProof,
} from "../credit/cloud-run.mjs";
import { cashCloudClient } from "../cash/cloud-client.mjs";
import {
  readPagedSnapshot,
  validateJournalFile,
  journalFileRecords,
  canonical,
} from "../cash/paged-client.mjs";
import { returnsRoot } from "./build.mjs";
import { assertHistoricalRows } from "./history.mjs";
assert.equal(process.argv[2], "--confirm-isolated-returns-lab");
const run = process.argv[3];
assert.match(run, /^qualification-\d{13}$/);
const dir = path.join(returnsRoot, "results/cloud-20261019", run);
const baseline = JSON.parse(
  await readFile(path.join(dir, "baseline.json"), "utf8"),
);
const attempts = (await readFile(path.join(dir, "attempts.ndjson"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const c = await creditCloudContext();
await verifyCreditResources(c);
const identity = {
  labId: "actual-credit-20261018",
  schemaVersion: "actual-credit-v1",
};
const file = path.join(dir, "signed.ndjson");
const exported = await validateJournalFile(file, c.secret, identity);
const requests = attempts.filter((a) => a.phase === "BEFORE_REQUEST");
const responses = new Map(
  attempts.filter((a) => a.phase === "RESPONSE").map((a) => [a.attempt, a]),
);
const firstRestore = requests.findIndex((a) => a.category === "restore");
assert.ok(firstRestore >= 0);
assert.ok(
  requests.slice(firstRestore).every((a) => a.target === c.restore),
  "Source accessed during offline recovery",
);
const restoredIds = new Set(
  requests
    .filter(
      (a) =>
        a.category === "restore" &&
        a.target === c.restore &&
        a.route === "/restore" &&
        responses.get(a.attempt)?.status === 200,
    )
    .map((a) => a.input.records[0].requestId),
);
assert.equal(
  restoredIds.size,
  exported.count,
  "Original run did not finish restoring every signed record",
);
for await (const record of journalFileRecords(file, c.secret, identity))
  assert.ok(restoredIds.has(record.requestId));
const measured = requests.filter((a) => a.category === "measurement");
assert.equal(measured.length, 39);
assert.equal(new Set(measured.map((a) => a.input.clientRequestId)).size, 39);
const samples = measured.map((a) => {
  const r = responses.get(a.attempt);
  assert.equal(r?.status, 200);
  assert.ok(Number.isFinite(r.profile?.sqlCount));
  return {
    route: a.route,
    terminal: Number(a.terminal),
    ms: r.ms,
    sql: r.profile.sqlCount,
  };
});
const transport = cashCloudClient(c, () => {});
const readOnlyRestore = (target, route, input) => {
  assert.equal(target, c.restore);
  assert.equal(input, undefined);
  assert.match(route, /^\/snapshot(?:\?|$)/);
  return transport(target, route);
};
const recoveredRows = {};
const recovered = await readPagedSnapshot(readOnlyRestore, c.restore, {
  onRow: (table, row) => (recoveredRows[table] ??= []).push(row),
});
assert.equal(recovered.epoch, exported.throughEpoch);
assert.equal(recovered.sha256, exported.header.snapshotSha256);
assert.equal(
  recovered.counts.cashCommands,
  baseline.snapshot.counts.cashCommands + 49,
);
const meta = JSON.parse(
  await readFile(path.join(returnsRoot, "build/cloud/tables.json"), "utf8"),
);
const history = assertHistoricalRows({
  baselineRows: baseline.rows,
  recoveredRows,
  before: baseline.snapshot,
  recovered,
  tableNames: meta.map((t) => t.name),
});
assert.equal(history.addedInvoices, 17);
const original = JSON.parse(
  await readFile(
    path.join(returnsRoot, "results/cloud-20261019/before.json"),
    "utf8",
  ),
);
for (const role of ["primary", "restore", "journal"])
  assert.deepEqual(await legacyProof(c, role), original.legacy[role]);
const databases = await c.invoke(["d1", "list", "--json"], true, true);
assert.equal(
  canonical(
    databases
      .map((d) => ({ uuid: d.uuid, name: d.name }))
      .sort((a, b) => a.uuid.localeCompare(b.uuid)),
  ),
  canonical(
    original.databases.toSorted((a, b) => a.uuid.localeCompare(b.uuid)),
  ),
);
const p95 = (values) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const summary = {
  passed: true,
  at: new Date().toISOString(),
  samples: samples.length,
  measuredSales: samples.filter((s) => s.route === "/sale").length,
  measuredReturns: samples.filter((s) => s.route === "/return").length,
  measuredCollections: samples.filter((s) => s.route === "/payment").length,
  concurrency: 4,
  actors: [11, 12, 13, 14],
  p95Ms: p95(samples.map((s) => s.ms)),
  returnP95Ms: p95(
    samples.filter((s) => s.route === "/return").map((s) => s.ms),
  ),
  maxSql: Math.max(...samples.map((s) => s.sql)),
  noHiddenMeasurementRetries: true,
  sourceDisabledForRestore: true,
  restored: exported.count,
  exported,
  before: baseline.snapshot,
  snapshot: recovered,
  recovered,
  history,
  newResources: 0,
  planUpgrade: false,
  readOnlyVerificationContinuation: true,
  financialCommandsRepeated: 0,
  correctedAssertion:
    "Invoice counter advances by17 new invoices; protocol epoch advances to the signed checkpoint; all historical financial rows remain preserved",
  hostinger:
    "No Hostinger binding or request; production server was not stopped",
};
assert.ok(summary.maxSql <= 48);
await writeFile(
  path.join(dir, "samples.json"),
  JSON.stringify(samples, null, 2),
  { flag: "wx" },
);
await writeFile(
  path.join(dir, "summary.json"),
  JSON.stringify(summary, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    passed: true,
    restored: summary.restored,
    epoch: recovered.epoch,
    p95Ms: summary.p95Ms,
    returnP95Ms: summary.returnP95Ms,
    maxSql: summary.maxSql,
    financialCommandsRepeated: 0,
  }),
);
