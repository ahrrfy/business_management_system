import assert from "node:assert/strict";
import { mkdir, open, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { cashCloudContext, verifyResources } from "./cloud-run.mjs";
import { cashRetryKind } from "./retry-policy.mjs";
import { cashCloudClient } from "./cloud-client.mjs";
if (
  process.argv.length !== 3 ||
  process.argv[2] !== "--confirm-isolated-cash-lab"
)
  throw Error("EXPLICIT_CASH_CLOUD_TEST_REQUIRED");
const c = await cashCloudContext();
await verifyResources(c);
const deployment = JSON.parse(await readFile(path.join(c.root, "results/deploy.json"), "utf8"));
assert.equal(deployment.workers.primary.writerBinding, true, "Deploy the coordinated lab entry first");
assert.equal(deployment.workers.restore.writerBinding, false);
let requests = 0,
  retries = 0,
  transportRetries = 0;
const measurements = [],
  steps = [],
  loadCommands = [];
const canonical = (v) =>
  Array.isArray(v)
    ? "[" + v.map(canonical).join(",") + "]"
    : v && typeof v === "object"
      ? "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
          .join(",") +
        "}"
      : JSON.stringify(v);
const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : canonical(v))
    .digest("hex");
const prefix = "cash-cloud-" + randomBytes(4).toString("hex");
const sale = (id, quantity = "2") => ({
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  clientRequestId: prefix + "-" + id,
  lines: [{ variantId: 2, productUnitId: 2, quantity }],
  payment: { amount: quantity === "1" ? "80" : "160", method: "CASH" },
});
const send = cashCloudClient(c, () => assert.ok(++requests <= 160, "Cloud request budget exceeded"));
async function call(target, route, input, fault = "") {
  const result = await send(target, route, input, fault);
  transportRetries += result.transportAttempts.length - 1;
  return result;
}
async function successful(input) {
  const start = performance.now();
  const attempts = [];
  const savedInput = canonical(input);
  const savedDir = path.join(c.root, "results/saved-requests");
  await mkdir(savedDir, {recursive: true});
  const savedFile = path.join(savedDir, input.clientRequestId + ".json");
  try { await writeFile(savedFile, savedInput, {flag: "wx"}); }
  catch (error) { if (error.code !== "EEXIST") throw error; assert.equal(await readFile(savedFile, "utf8"), savedInput); }
  for (let i = 0; i < 12; i++) {
    assert.equal(canonical(input), savedInput, "A replay must retain the exact saved request payload");
    const result = await call(c.source, "/sale", input);
    attempts.push({status: result.status, code: result.body.code ?? null, ms: result.ms, profile: result.profile, writer: result.writer, transportAttempts: result.transportAttempts});
    if (result.status === 200) {
      assert.equal(result.body.recoveryAcknowledged, true);
      assert.equal(result.writer?.maxActive, 1, "All live sales must pass the singleton writer");
      return { ...result, ms: performance.now() - start, attempts };
    }
    const retry = cashRetryKind(result.status, result.body.code);
    if (retry) {
      retries++;
      if (retry === "transport") {
        const lookup = await call(c.source, "/operation/" + encodeURIComponent(input.clientRequestId));
        attempts.at(-1).reconciliation = {status: lookup.status, state: lookup.body.state ?? null};
      }
      continue;
    }
    assert.fail(JSON.stringify(result));
  }
  throw Error("Bounded retry budget exhausted; preserve original request");
}
async function step(name, fn) {
  await fn();
  steps.push({ name, passed: true });
  console.log(JSON.stringify({ passed: name }));
}
const before = await call(c.source, "/snapshot");
assert.equal(before.status, 200, JSON.stringify(before));
const initial = before.body.tables;
assert.ok(initial.branchStock.find(row => row.variantId === 2 && row.branchId === 1)?.quantity >= 20,
  "The retained synthetic SKU must cover the complete test without replenishment");
await mkdir(path.join(c.root, "results"), {recursive: true});
await writeFile(path.join(c.root, "results/cloud-start-" + prefix + ".json"), JSON.stringify({
  prefix, at: new Date().toISOString(), initial,
  plannedLoad: Array.from({length: 12}, (_, i) => sale("load-" + i, "1")),
  sourceDeployment: JSON.parse(await readFile(path.join(c.root, "results/deploy.json"), "utf8")),
}), {flag: "wx"});
await step(
  "unavailable recovery log and final SQL failure leave all primary rows unchanged",
  async () => {
    for (const [id, fault] of [
      ["log-down", "log-unavailable"],
      ["last-sql", "last-statement"],
      ["prepared", "after-prepare"],
    ]) {
      const r = await call(c.source, "/sale", sale(id), fault);
      assert.equal(r.status, 503, JSON.stringify(r));
    }
    const after = await call(c.source, "/snapshot");
    assert.deepEqual(after.body.tables, initial);
  },
);
await step(
  "primary commit without journal confirmation stays pending; original replay completes copy",
  async () => {
    const input = sale("pending"),
      laterInput = sale("later-after-pending");
    assert.equal(
      (await call(c.source, "/sale", input, "after-primary")).status,
      503,
    );
    const pending = await call(c.source, "/operation/" + input.clientRequestId);
    assert.equal(pending.body.state, "PRIMARY_COMMITTED_RECOVERY_PENDING");
    const later = await successful(laterInput);
    assert.equal(later.body.recoveryAcknowledged, true);
    const first = await successful(input),
      replay = await successful(input);
    assert.equal(first.body.invoiceId, replay.body.invoiceId);
    const changed = structuredClone(input);
    changed.lines[0].quantity = "1";
    changed.payment.amount = "80";
    assert.equal((await call(c.source, "/sale", changed)).status, 409);
  },
);
await step(
  "response loss after both durable commits does not create another sale",
  async () => {
    const input = sale("lost-response");
    assert.equal(
      (await call(c.source, "/sale", input, "drop-response")).status,
      503,
    );
    const a = await successful(input),
      b = await successful(input);
    assert.equal(a.body.invoiceId, b.body.invoiceId);
  },
);
await step("same request concurrent replay returns one invoice", async () => {
  const rows = await Promise.all(
    Array.from({ length: 3 }, () => successful(sale("same-concurrent"))),
  );
  assert.equal(new Set(rows.map((r) => r.body.invoiceId)).size, 1);
});
await step(
  "bounded actual financial load with fixed request replay",
  async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => sale("load-" + i, "1"));
    let index = 0;
    const retriesBefore = retries, transportBefore = transportRetries;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (index < jobs.length) {
          const job = jobs[index++],
            r = await successful(job);
          measurements.push(r.ms);
          loadCommands.push({requestId: job.clientRequestId, invoiceId: r.body.invoiceId, logicalMs: r.ms, attempts: r.attempts});
        }
      }),
    );
    const seconds = (performance.now() - start) / 1000;
    measurements.sort((a, b) => a - b);
    const writers = loadCommands.map(c => c.attempts.at(-1).writer);
    assert.equal(new Set(writers.map(w => w.instance)).size, 1, "One shared cloud writer instance");
    assert.equal(new Set(writers.map(w => w.admissionSequence)).size, jobs.length);
    const admitted = [...loadCommands].sort((a,b) => a.attempts.at(-1).writer.admissionSequence - b.attempts.at(-1).writer.admissionSequence);
    assert.ok(admitted.every((c,i) => i === 0 || c.invoiceId > admitted[i-1].invoiceId), "Financial commits follow admission order");
    steps.push({
      financialLoad: {
        commands: jobs.length,
        concurrency: 2,
        retries: retries - retriesBefore,
        transportRetries: transportRetries - transportBefore,
        seconds,
        rps: jobs.length / seconds,
        p50: measurements[Math.ceil(measurements.length * 0.5) - 1],
        p95: measurements[
          Math.min(
            measurements.length - 1,
            Math.ceil(measurements.length * 0.95) - 1,
          )
        ],
        max: measurements.at(-1),
        samples: measurements.length,
        percentile: "nearest-rank; client logical latency includes retries",
        commandsDetail: loadCommands,
        writerInstances: [...new Set(writers.map(w => w.instance))],
        maxQueueWaitMs: Math.max(...writers.map(w => w.waitMs)),
        maxExecutionMs: Math.max(...writers.map(w => w.executionMs)),
      },
    });
  },
);
let finalSnapshot, externalFile, exportHash, dateProof;
await step(
  "signed external log restores all financial rows on Worker without source or journal bindings",
  async () => {
    const snapshot = await call(c.source, "/snapshot");
    assert.equal(snapshot.status, 200);
    finalSnapshot = snapshot.body.tables;
    const oldInvoices = new Set(initial.invoices.map((row) => row.id));
    const oldLedger = new Set(initial.accountingEntries.map((row) => row.id));
    const newInvoices = finalSnapshot.invoices.filter((row) => !oldInvoices.has(row.id));
    const newLedger = finalSnapshot.accountingEntries.filter((row) => !oldLedger.has(row.id));
    assert.equal(newInvoices.length, 16, "Exactly sixteen new actual cash sales");
    assert.equal(newLedger.length, 32, "SALE and PAYMENT_IN for each new sale");
    for (const row of newLedger) {
      assert.match(row.entryDate, /^\d{4}-\d{2}-\d{2}$/, "MySQL DATE canonical storage");
      assert.equal(new Date(row.entryDate + "T00:00:00Z").toISOString().slice(0, 10), row.entryDate);
    }
    dateProof = { baselineSales: initial.invoices.length, newSales: newInvoices.length, newCanonicalDateRows: newLedger.length };
    const log = await call(c.source, "/recovery-log");
    assert.equal(log.status, 200);
    assert.ok(log.body.records.length >= 16);
    assert.deepEqual(
      log.body.records.map((r) => r.epoch),
      Array.from({ length: log.body.records.length }, (_, i) => i + 2),
      "All acknowledged exports must be contiguous from the fixture baseline",
    );
    const packageData = {
      ...log.body,
      exportedAt: new Date().toISOString(),
      snapshotSha256: hash(finalSnapshot),
      schemaSha256: c.runtime.schemaSha256,
      fixtureSha256: c.runtime.fixtureSha256,
      sourceDeployment: JSON.parse(
        await readFile(path.join(c.root, "results/deploy.json"), "utf8"),
      ),
    };
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "erp-cash-external-recovery-"),
    );
    externalFile = path.join(dir, "signed-cash-journal.json");
    const serialized = JSON.stringify(packageData, null, 2),
      handle = await open(externalFile, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    exportHash = hash(serialized);
    const external = JSON.parse(await readFile(externalFile, "utf8"));
    const status = await call(c.restore, "/status");
    assert.equal(status.body.journalBindingPresent, false);
    assert.equal(status.body.writerBindingPresent, false);
    const tamper = structuredClone(external.records[0]);
    tamper.plan.result.total = "0.01";
    const prior = await call(c.restore, "/snapshot");
    assert.equal(
      (await call(c.restore, "/restore", { records: [tamper] })).status,
      400,
    );
    assert.deepEqual(
      (await call(c.restore, "/snapshot")).body.tables,
      prior.body.tables,
    );
    for (const record of external.records) {
      const r = await call(c.restore, "/restore", { records: [record] });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal(r.body.journalBindingPresent, false);
    }
    const restored = await call(c.restore, "/snapshot");
    assert.deepEqual(
      restored.body.tables,
      finalSnapshot,
      "Complete projected snapshot must match including IDs, times, commands and outbox",
    );
    for (const record of [external.records[0], external.records.at(-1)]) {
      const r = await call(c.restore, "/restore", { records: [record] });
      assert.equal(r.status, 200);
      assert.equal(r.body.replayed, 1);
    }
    assert.deepEqual(
      (await call(c.restore, "/snapshot")).body.tables,
      finalSnapshot,
    );
  },
);
const result = {
  passed: true,
  at: new Date().toISOString(),
  prefix,
  requests,
  retries,
  transportRetries,
  steps,
  source: c.source,
  restore: c.restore,
  externalFile,
  externalFileSha256: exportHash,
  snapshotSha256: hash(finalSnapshot),
  totalSales: finalSnapshot.invoices.length,
  syntheticDataset: { variantId: 2, productUnitId: 2, unitPrice: "80.00", openingStock: initial.branchStock.find(row => row.variantId === 2).quantity },
  dateProof,
  sourceDeployment: JSON.parse(
    await readFile(path.join(c.root, "results/deploy.json"), "utf8"),
  ),
  limits: {
    hostingerOutage:
      "Dependency absent in deployed cash graph; outbound-denied local workerd test, no production shutdown",
    recovery:
      "Separate Cloudflare D1 databases, signed external export at measured checkpoint; no continuous off-provider ACK guarantee",
    scope:
      "Original full-cash ordinary stocked-owned POS; double-entry OFF; no other cashier/storefront functions",
  },
};
await mkdir(path.join(c.root, "results"), { recursive: true });
await writeFile(
  path.join(c.root, "results/cloud-latest.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
