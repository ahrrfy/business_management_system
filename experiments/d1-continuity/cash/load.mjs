import assert from "node:assert/strict";
import { mkdir, open, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { cashCloudContext, verifyResources } from "./cloud-run.mjs";
if (
  process.argv.length !== 3 ||
  process.argv[2] !== "--confirm-isolated-cash-lab"
)
  throw Error("EXPLICIT_CASH_CLOUD_TEST_REQUIRED");
const c = await cashCloudContext();
await verifyResources(c);
let requests = 0,
  retries = 0;
const measurements = [],
  steps = [];
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
  lines: [{ variantId: 1, productUnitId: 1, quantity }],
  payment: { amount: quantity === "1" ? "100" : "200", method: "CASH" },
});
async function call(target, route, input, fault = "") {
  assert.ok(++requests <= 160, "Cloud request budget exceeded");
  const start = performance.now();
  const response = await fetch(target + route, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + c.secret,
      "content-type": "application/json",
      ...(fault ? { "x-cash-fault": fault } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw Error(
      "Non-JSON test response " + response.status + ": " + raw.slice(0, 150),
    );
  }
  return { status: response.status, body, ms: performance.now() - start };
}
async function successful(input) {
  const start = performance.now();
  for (let i = 0; i < 12; i++) {
    const result = await call(c.source, "/sale", input);
    if (result.status === 200) {
      assert.equal(result.body.recoveryAcknowledged, true);
      return { ...result, ms: performance.now() - start };
    }
    if (
      result.status === 409 &&
      [
        "STALE_SNAPSHOT_RETRY_SAME_REQUEST",
        "RECOVERY_PREFIX_PENDING_RETRY_SAME_REQUEST",
      ].includes(result.body.code)
    ) {
      retries++;
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
    changed.payment.amount = "100";
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
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (index < jobs.length) {
          const job = jobs[index++],
            r = await successful(job);
          measurements.push(r.ms);
        }
      }),
    );
    const seconds = (performance.now() - start) / 1000;
    measurements.sort((a, b) => a - b);
    steps.push({
      financialLoad: {
        commands: jobs.length,
        concurrency: 2,
        retries,
        seconds,
        rps: jobs.length / seconds,
        p50: measurements[Math.floor(measurements.length * 0.5)],
        p95: measurements[
          Math.min(
            measurements.length - 1,
            Math.ceil(measurements.length * 0.95) - 1,
          )
        ],
        max: measurements.at(-1),
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
  steps,
  source: c.source,
  restore: c.restore,
  externalFile,
  externalFileSha256: exportHash,
  snapshotSha256: hash(finalSnapshot),
  totalSales: finalSnapshot.invoices.length,
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
