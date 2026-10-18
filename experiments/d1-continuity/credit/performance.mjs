import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { creditCloudContext } from "./cloud-run.mjs";
import { creditRoot } from "./build.mjs";
const phase = process.argv[2];
assert.ok(["baseline", "after", "single"].includes(phase));
const concurrency = phase === "single" ? 1 : 4,
  totalSales = phase === "single" ? 8 : 16;
assert.equal(process.argv[3], "--confirm-isolated-credit-lab");
const c = await creditCloudContext(),
  dir = path.join(
    creditRoot,
    "results/perf-20261018",
    phase + "-" + Date.now(),
  );
await mkdir(dir, { recursive: true });
let saves = Promise.resolve();
const inputs = [],
  measurements = [];
async function submit(route, input) {
  inputs.push(input);
  const bytes = JSON.stringify(inputs, null, 2);
  saves = saves.then(() => writeFile(path.join(dir, "commands.json"), bytes));
  await saves;
  const start = performance.now(),
    r = await fetch(c.source + route, {
      method: "POST",
      headers: {
        authorization: "Bearer " + c.secret,
        "content-type": "application/json",
        "x-cash-profile": "1",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30000),
    }),
    body = await r.json(),
    row = {
      operation: input.commandType,
      status: r.status,
      ms: performance.now() - start,
      body,
      profile: JSON.parse(r.headers.get("x-cash-profile") ?? "null"),
      writer: JSON.parse(r.headers.get("x-cash-writer") ?? "null"),
      ray: r.headers.get("cf-ray"),
    };
  measurements.push(row);
  await writeFile(
    path.join(dir, "measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
  assert.equal(r.status, 200, JSON.stringify(row));
  return body;
}
if (phase === "single") {
  const response = await fetch(c.source + "/status", {
    headers: { authorization: "Bearer " + c.secret },
  });
  assert.equal(response.status, 200);
}
const runId = Date.now().toString(36);
for (let start = 0; start < totalSales; start += concurrency)
  await Promise.all(
    Array.from({ length: concurrency }, async (_, j) => {
      const i = start + j,
        key = "cp-" + phase + "-" + runId + "-" + i,
        sale = await submit("/sale", {
          commandType: "SALE",
          branchId: 1,
          shiftId: 1,
          sourceType: "POS",
          customerId: 5,
          clientRequestId: key,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        });
      for (const [k, amount] of [
        ["p", "40"],
        ["f", "60"],
      ])
        await submit("/payment", {
          commandType: "COLLECT",
          branchId: 1,
          shiftId: 1,
          invoiceId: sale.invoiceId,
          clientRequestId: key + "-" + k,
          method: "CASH",
          amount,
        });
    }),
  );
const pct = (a, p) => [...a].sort((a, b) => a - b)[Math.ceil(a.length * p) - 1],
  summary = {
    phase,
    samples: measurements.length,
    concurrency,
    byOperation: {},
  };
for (const op of ["SALE", "COLLECT"]) {
  const rows = measurements.filter((r) => r.operation === op);
  summary.byOperation[op] = {
    samples: rows.length,
    p50Ms: pct(
      rows.map((r) => r.ms),
      0.5,
    ),
    p95Ms: pct(
      rows.map((r) => r.ms),
      0.95,
    ),
    writerP95Ms: pct(
      rows.map((r) => r.writer.executionMs),
      0.95,
    ),
    queueP95Ms: pct(
      rows.map((r) => r.writer.waitMs),
      0.95,
    ),
    rpcCount: [...new Set(rows.map((r) => r.profile.rpcCount))],
    sqlCount: [...new Set(rows.map((r) => r.profile.sqlCount))],
    calls: rows[0].profile.calls,
  };
}
await writeFile(
  path.join(dir, "summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ dir, ...summary }));
