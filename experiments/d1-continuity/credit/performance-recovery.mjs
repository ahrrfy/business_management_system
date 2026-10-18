import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { creditCloudContext, verifyCreditResources } from "./cloud-run.mjs";
import { creditRoot } from "./build.mjs";
import { cashCloudClient } from "../cash/cloud-client.mjs";
import {
  readPagedSnapshot,
  exportPagedJournal,
  journalFileRecords,
  validateJournalFile,
} from "../cash/paged-client.mjs";

assert.equal(process.argv[2], "--confirm-isolated-credit-lab");
assert.ok(process.argv[3] === undefined || process.argv[3] === "--subsecond");
const resultBase =
  process.argv[3] === "--subsecond"
    ? "results/subsecond-20261018"
    : "results/perf-20261018";
const c = await creditCloudContext();
await verifyCreditResources(c);
const identity = {
  labId: "actual-credit-20261018",
  schemaVersion: "actual-credit-v1",
};
const dir = path.join(creditRoot, resultBase, "recovery-" + Date.now());
await mkdir(dir, { recursive: true });
let requests = 0,
  sourceBlocked = false;
const call = cashCloudClient(c, () => requests++, {
  fetch: (url, init) => {
    if (sourceBlocked && url.startsWith(c.source))
      throw Error("SOURCE_DISABLED_BY_RECOVERY_TEST");
    return fetch(url, init);
  },
});
const ok = async (...args) => {
  const r = await call(...args);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
};
const commands = [];
async function saved(input) {
  assert.ok(input.clientRequestId.length <= 50);
  commands.push(input);
  await writeFile(
    path.join(dir, "commands.json"),
    JSON.stringify(commands, null, 2),
  );
  return input;
}
const sale = (key) => ({
  commandType: "SALE",
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  customerId: 5,
  clientRequestId: key,
  lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
});
const collect = (invoiceId, key, amount) => ({
  commandType: "COLLECT",
  branchId: 1,
  shiftId: 1,
  invoiceId,
  clientRequestId: key,
  method: "CASH",
  amount,
});
const before = await readPagedSnapshot(call, c.source);
const restoreBefore = await readPagedSnapshot(call, c.restore);
assert.ok(restoreBefore.epoch <= before.epoch);
const run = Date.now().toString(36);
const input = await saved(sale("cpr-dupe-" + run));
const duplicates = await Promise.all(
  Array.from({ length: 4 }, () => ok(c.source, "/sale", input)),
);
assert.equal(new Set(duplicates.map((r) => r.body.invoiceId)).size, 1);
assert.equal(new Set(duplicates.map((r) => r.writer.instance)).size, 1);
assert.ok(duplicates.every((r) => r.writer.maxActive === 1));
assert.equal(
  (await call(c.source, "/sale", { ...input, customerId: 1 })).status,
  409,
);
const invoiceId = duplicates[0].body.invoiceId;
const partial = await saved(collect(invoiceId, "cpr-part-" + run, "30"));
const partialReplies = await Promise.all(
  Array.from({ length: 4 }, () => ok(c.source, "/payment", partial)),
);
assert.equal(new Set(partialReplies.map((r) => r.body.recoveryEpoch)).size, 1);
await ok(
  c.source,
  "/payment",
  await saved(collect(invoiceId, "cpr-final-" + run, "70")),
);
await ok(c.source, "/sale", input);
await ok(c.source, "/payment", partial);
const evidence = (await ok(c.source, "/evidence?invoiceId=" + invoiceId)).body;
assert.equal(evidence.invoice.paidAmount, "100.00");
assert.equal(evidence.invoice.status, "PAID");
assert.equal(evidence.receiptCount, 2);
const faults = [];
for (const kind of ["SALE", "COLLECT"])
  for (const fault of [
    "after-prepare",
    "last-statement",
    "after-primary",
    "drop-response",
  ]) {
    let targetInvoice;
    if (kind === "COLLECT")
      targetInvoice = (
        await ok(
          c.source,
          "/sale",
          await saved(sale("cpr-base-" + fault + "-" + run)),
        )
      ).body.invoiceId;
    const key = "cpr-" + kind + "-" + fault + "-" + run;
    const command = await saved(
      kind === "SALE" ? sale(key) : collect(targetInvoice, key, "20"),
    );
    const route = kind === "SALE" ? "/sale" : "/payment";
    const failed = await call(c.source, route, command, fault);
    assert.equal(failed.status, 503, JSON.stringify(failed));
    const recovered = await ok(c.source, route, command);
    const replayed = await ok(c.source, route, command);
    assert.equal(replayed.body.recoveryEpoch, recovered.body.recoveryEpoch);
    faults.push({ kind, fault, recoveryEpoch: recovered.body.recoveryEpoch });
  }
const snapshot = await readPagedSnapshot(call, c.source);
assert.equal(snapshot.epoch - before.epoch, 15);
assert.equal(snapshot.counts.invoices - before.counts.invoices, 9);
assert.equal(snapshot.counts.receipts - before.counts.receipts, 6);
const file = path.join(dir, "signed-credit.ndjson");
const options = {
  identity,
  snapshotSha256: snapshot.sha256,
  snapshotEpoch: snapshot.epoch,
};
await assert.rejects(
  exportPagedJournal(call, c.source, file, c.secret, {
    ...options,
    interruptAfterPages: 1,
  }),
  /SIMULATED_EXPORT_INTERRUPTION/,
);
const exported = await exportPagedJournal(call, c.source, file, c.secret, {
  ...options,
  resume: true,
});
await validateJournalFile(file, c.secret, identity);
sourceBlocked = true;
// Replaying the complete signed prefix verifies prior restore history before
// applying newer records. Existing matching commands are read-only replays.
let first,
  last,
  applied = 0,
  replayed = 0;
for await (const record of journalFileRecords(file, c.secret, identity)) {
  first ??= record;
  last = record;
  const r = await ok(c.restore, "/restore", { records: [record] });
  assert.equal(r.body.journalBindingPresent, false);
  applied += r.body.applied;
  replayed += r.body.replayed;
}
assert.equal(applied, snapshot.epoch - restoreBefore.epoch);
assert.equal(replayed, restoreBefore.epoch - 1);
const restored = await readPagedSnapshot(call, c.restore);
assert.deepEqual(restored, snapshot);
for (const record of [first, last])
  await ok(c.restore, "/restore", { records: [record] });
assert.deepEqual(await readPagedSnapshot(call, c.restore), snapshot);
const result = {
  passed: true,
  at: new Date().toISOString(),
  before,
  restoreBefore,
  snapshot,
  restored,
  exported,
  applied,
  replayed,
  faults,
  requests,
  sourceBlockedInDriverDuringRestore: true,
  cloudSourcePhysicallyStopped: false,
  restoreJournalBinding: false,
  hostingerBinding: false,
  newDatabases: 0,
  planUpgrade: false,
  originalSourceSha256: JSON.parse(
    await readFile(
      path.join(creditRoot, "build/cloud/source-evidence.json"),
      "utf8",
    ),
  ).originalSourceSha256,
};
await writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
await writeFile(
  path.join(creditRoot, resultBase, "cloud-recovery.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: true,
    dir,
    commands: snapshot.epoch - 1,
    invoices: snapshot.counts.invoices,
    receipts: snapshot.counts.receipts,
    rows: snapshot.totalRows,
    applied,
    replayed,
    requests,
  }),
);
