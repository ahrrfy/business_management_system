import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { creditCloudContext, verifyCreditResources } from "./cloud-run.mjs";
import { creditRoot } from "./build.mjs";
import { cashCloudClient } from "../cash/cloud-client.mjs";
import { cashRetryKind } from "../cash/retry-policy.mjs";
import {
  readPagedSnapshot,
  exportPagedJournal,
  journalFileRecords,
  validateJournalFile,
} from "../cash/paged-client.mjs";
const identity = {
  labId: "actual-credit-20261018",
  schemaVersion: "actual-credit-v1",
};
if (process.argv[2] !== "--confirm-isolated-credit-lab")
  throw Error("EXPLICIT_ISOLATED_MODE_REQUIRED");
const c = await creditCloudContext();
await verifyCreditResources(c);
let requests = 0,
  sourceBlocked = false;
const dir = path.join(creditRoot, "results/cloud-" + Date.now());
await mkdir(dir, { recursive: true });
const raw = cashCloudClient(c, () => requests++, {
  fetch: async (url, init) => {
    if (sourceBlocked && url.startsWith(c.source))
      throw Error("SOURCE_DISABLED_BY_RECOVERY_TEST");
    const headers = new Headers(init.headers);
    headers.set("x-cash-profile", "1");
    return fetch(url, { ...init, headers });
  },
});
const call = async (...args) => {
  for (let n = 0; ; n++) {
    const r = await raw(...args);
    if (cashRetryKind(r.status, r.body.code) !== "concurrency" || n >= 4)
      return r;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const ok = async (...args) => {
  const r = await call(...args);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r;
};
const sale = (key, extra = {}) => ({
  commandType: "SALE",
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  customerId: 5,
  clientRequestId: key,
  lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
  ...extra,
});
const pay = (invoiceId, key, amount = "100") => ({
  commandType: "COLLECT",
  branchId: 1,
  shiftId: 1,
  invoiceId,
  clientRequestId: key,
  method: "CASH",
  amount,
});
// Save every full envelope before submission. Unknown outcomes never generate new keys.
const inputs = [];
let saves = Promise.resolve();
const saved = async (input) => {
  assert.ok(input.clientRequestId.length <= 50);
  inputs.push(input);
  const bytes = JSON.stringify(inputs, null, 2);
  saves = saves.then(() =>
    writeFile(path.join(dir, "submitted-commands.json"), bytes),
  );
  await saves;
  return input;
};
const before = await readPagedSnapshot(call, c.source);
assert.equal(
  (await ok(c.restore, "/snapshot")).body.epoch,
  1,
  "Independent restore must remain the untouched baseline",
);
const same = await saved(sale("credit-cloud-same-" + Date.now())),
  dupes = await Promise.all([
    ok(c.source, "/sale", same),
    ok(c.source, "/sale", same),
    ok(c.source, "/sale", same),
  ]);
assert.equal(new Set(dupes.map((r) => r.body.invoiceId)).size, 1);
assert.equal(new Set(dupes.map((r) => r.writer.instance)).size, 1);
assert.ok(dupes.every((r) => r.writer.maxActive === 1));
assert.equal(
  (await call(c.source, "/sale", { ...same, customerId: 1 })).status,
  409,
);
const partial = await saved(
  pay(dupes[0].body.invoiceId, "credit-cloud-partial-" + Date.now(), "30"),
);
await ok(c.source, "/payment", partial);
const final = await saved(
  pay(dupes[0].body.invoiceId, "credit-cloud-final-" + Date.now(), "70"),
);
await ok(c.source, "/payment", final);
await ok(c.source, "/sale", same);
await ok(c.source, "/payment", partial);
const evidence = (
  await ok(c.source, "/evidence?invoiceId=" + dupes[0].body.invoiceId)
).body;
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
    let invoiceId;
    if (kind === "COLLECT")
      invoiceId = (
        await ok(
          c.source,
          "/sale",
          await saved(sale("cc-base-" + fault + "-" + Date.now())),
        )
      ).body.invoiceId;
    const key = "cc-" + kind + "-" + fault + "-" + Date.now(),
      input = await saved(
        kind === "SALE" ? sale(key) : pay(invoiceId, key, "20"),
      ),
      route = kind === "SALE" ? "/sale" : "/payment";
    const r = await call(c.source, route, input, fault);
    assert.equal(r.status, 503, JSON.stringify(r));
    const recovered = await ok(c.source, route, input),
      replay = await ok(c.source, route, input);
    assert.equal(replay.body.recoveryEpoch, recovered.body.recoveryEpoch);
    faults.push({ kind, fault, recoveryEpoch: recovered.body.recoveryEpoch });
  }
const timings = [],
  profiles = [];
for (let start = 0; start < 8; start += 4)
  await Promise.all(
    Array.from({ length: 4 }, async (_, j) => {
      const i = start + j,
        input = await saved(sale("credit-cloud-load-" + i + "-" + Date.now())),
        s = await ok(c.source, "/sale", input);
      timings.push(s.ms);
      profiles.push(s.profile);
      for (const [k, amount] of [
        ["part", "40"],
        ["final", "60"],
      ]) {
        const r = await ok(
          c.source,
          "/payment",
          await saved(
            pay(s.body.invoiceId, input.clientRequestId + "-" + k, amount),
          ),
        );
        timings.push(r.ms);
        profiles.push(r.profile);
      }
      await ok(c.source, "/sale", input);
    }),
  );
assert.ok(profiles.every((p) => p.sqlCount <= 48));
const snapshot = await readPagedSnapshot(call, c.source),
  file = path.join(dir, "signed-credit.ndjson"),
  exportOptions = {
    identity,
    snapshotSha256: snapshot.sha256,
    snapshotEpoch: snapshot.epoch,
  };
await assert.rejects(
  exportPagedJournal(call, c.source, file, c.secret, {
    ...exportOptions,
    interruptAfterPages: 1,
  }),
  /SIMULATED_EXPORT_INTERRUPTION/,
);
const exported = await exportPagedJournal(call, c.source, file, c.secret, {
  ...exportOptions,
  resume: true,
});
await validateJournalFile(file, c.secret, identity);
sourceBlocked = true;
let first, last;
for await (const record of journalFileRecords(file, c.secret, identity)) {
  first ??= record;
  last = record;
  const restored = await ok(c.restore, "/restore", { records: [record] });
  assert.equal(restored.body.journalBindingPresent, false);
}
const restored = await readPagedSnapshot(call, c.restore);
assert.deepEqual(restored, snapshot);
for (const record of [first, last])
  await ok(c.restore, "/restore", { records: [record] });
assert.deepEqual(await readPagedSnapshot(call, c.restore), snapshot);
timings.sort((a, b) => a - b);
const result = {
  passed: true,
  at: new Date().toISOString(),
  workers: { primary: c.source, restore: c.restore },
  before,
  after: snapshot,
  restored,
  exported,
  faults,
  load: {
    sales: 8,
    collections: 16,
    concurrency: 4,
    p50Ms: timings[Math.floor(timings.length * 0.5)],
    p95Ms: timings[Math.floor(timings.length * 0.95)],
    maxSql: Math.max(...profiles.map((p) => p.sqlCount)),
    maxHydratedRows: Math.max(
      ...profiles.map((p) => p.stateRead?.totalRows ?? 0),
    ),
  },
  sourceBlockedDuringRestore: true,
  restorationWithoutJournalBinding: true,
  hostingerBinding: false,
  requests,
  newD1Databases: 0,
  planUpgrade: false,
  actualSources: JSON.parse(
    await readFile(
      path.join(creditRoot, "build/cloud/source-evidence.json"),
      "utf8",
    ),
  ).originalSourceSha256,
};
await writeFile(
  path.join(creditRoot, "results/cloud-proof.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: true,
    commands: snapshot.epoch - 1,
    invoices: snapshot.counts.invoices,
    receipts: snapshot.counts.receipts,
    restoredRows: restored.totalRows,
    load: result.load,
    requests,
  }),
);
