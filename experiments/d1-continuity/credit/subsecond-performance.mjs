import assert from "node:assert/strict";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { creditCloudContext } from "./cloud-run.mjs";
import { creditRoot } from "./build.mjs";
const phase = process.argv[2];
assert.ok(["baseline", "after", "qualification"].includes(phase));
assert.equal(process.argv[3], "--confirm-isolated-credit-lab");
const c = await creditCloudContext();
assert.ok(c.runtime.multiCashierFixtureAt);
assert.equal(c.runtime.creditPipeline, phase !== "baseline");
const dir = path.join(
  creditRoot,
  "results/subsecond-20261018",
  phase + "-" + Date.now(),
);
await mkdir(dir, { recursive: true });
const file = await open(path.join(dir, "commands.ndjson"), "ax");
let pending = Promise.resolve(),
  evidenceWrites = Promise.resolve(),
  active = 0,
  maxActive = 0,
  financialActive = 0,
  maxFinancialActive = 0;
const rows = [],
  readiness = [],
  runId = Date.now().toString(36);
async function persist(commands) {
  const bytes = commands
    .map((command) => JSON.stringify(command) + "\n")
    .join("");
  pending = pending.then(async () => {
    await file.write(bytes);
    await file.sync();
  });
  await pending;
}
async function send(route, command) {
  const { input, terminal } = command;
  active++;
  if (input) {
    financialActive++;
    maxFinancialActive = Math.max(maxFinancialActive, financialActive);
  }
  maxActive = Math.max(maxActive, active);
  const began = performance.now();
  try {
    const r = await fetch(c.source + route, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + c.secret,
        "content-type": "application/json",
        "x-cash-profile": "1",
        "x-credit-lab-terminal": terminal,
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const body = await r.json(),
      row = {
        operation: input?.commandType ?? "READY",
        terminal,
        status: r.status,
        ms: performance.now() - began,
        body,
        profile: JSON.parse(r.headers.get("x-cash-profile") ?? "null"),
        writer: JSON.parse(r.headers.get("x-cash-writer") ?? "null"),
        ray: r.headers.get("cf-ray"),
      };
    (input ? rows : readiness).push(row);
    const evidence = JSON.stringify(input ? rows : readiness, null, 2);
    evidenceWrites = evidenceWrites.then(() =>
      writeFile(
        path.join(dir, input ? "measurements.json" : "readiness.json"),
        evidence,
      ),
    );
    await evidenceWrites;
    assert.equal(row.status, 200, JSON.stringify(row));
    return row;
  } finally {
    active--;
    if (input) financialActive--;
  }
}
const sale = (i) => {
  const terminal = String(11 + (i % 4)),
    variantId = phase === "qualification" && i >= 12 ? 1 : 2;
  return {
    terminal,
    input: {
      commandType: "SALE",
      branchId: 1,
      shiftId: Number(terminal),
      sourceType: "POS",
      customerId: 5,
      clientRequestId: "css-" + phase.slice(0, 4) + "-" + runId + "-" + i,
      lines: [{ variantId, productUnitId: variantId, quantity: "1" }],
    },
  };
};
const payment = (command, invoiceId, last) => {
  const variant = command.input.lines[0].variantId;
  return {
    terminal: command.terminal,
    input: {
      commandType: "COLLECT",
      branchId: 1,
      shiftId: command.input.shiftId,
      invoiceId,
      clientRequestId:
        command.input.clientRequestId + (last ? "-final" : "-part"),
      method: "CASH",
      amount: variant === 1 ? (last ? "60" : "40") : last ? "48" : "32",
    },
  };
};
async function batch(route, commands) {
  await persist(commands);
  const results = await Promise.allSettled(
    commands.map((command) => send(route, command)),
  );
  for (const r of results) if (r.status === "rejected") throw r.reason;
  return results.map((r) => r.value);
}
try {
  // Mirrors the UI's explicit connection readiness step. Its complete cold
  // timings remain separate; EVERY subsequent financial sample enters P95.
  const ready = await Promise.allSettled(
    [11, 12, 13, 14].map((id) => send("/ready", { terminal: String(id) })),
  );
  for (const r of ready) {
    assert.equal(r.status, "fulfilled", String(r.reason));
    assert.equal(r.value.body.ready, true);
    assert.equal(r.value.body.cachedFinancialRows, false);
  }
  const total = phase === "qualification" ? 24 : 16;
  for (let start = 0; start < total; start += 4) {
    const commands = Array.from({ length: 4 }, (_, j) => sale(start + j));
    if (phase === "qualification") {
      const group = await Promise.allSettled(
        commands.map(async (command) => {
          await persist([command]);
          const s = await send("/sale", command);
          for (const last of [false, true]) {
            const p = payment(command, s.body.invoiceId, last);
            await persist([p]);
            await send("/payment", p);
          }
        }),
      );
      for (const r of group) if (r.status === "rejected") throw r.reason;
    } else {
      const sold = await batch("/sale", commands);
      for (const last of [false, true])
        await batch(
          "/payment",
          commands.map((command, j) =>
            payment(command, sold[j].body.invoiceId, last),
          ),
        );
    }
  }
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const summary = {
    phase,
    at: new Date().toISOString(),
    shape:
      phase === "qualification"
        ? "four independent client chains"
        : "synchronized four-client bursts",
    cashierActors: [11, 12, 13, 14],
    shifts: [11, 12, 13, 14],
    clientGenerators: 1,
    maxConcurrentHttp: maxActive,
    maxConcurrentFinancialHttp: maxFinancialActive,
    readiness: {
      samples: 4,
      p95Ms: percentile(
        readiness.map((r) => r.ms),
        0.95,
      ),
      readOnly: true,
    },
    samples: rows.length,
    allFinancialSamplesIncluded: true,
    automaticFinancialRetries: 0,
    byOperation: {},
  };
  for (const operation of ["SALE", "COLLECT"]) {
    const r = rows.filter((r) => r.operation === operation);
    summary.byOperation[operation] = {
      samples: r.length,
      p50Ms: percentile(
        r.map((r) => r.ms),
        0.5,
      ),
      p95Ms: percentile(
        r.map((r) => r.ms),
        0.95,
      ),
      maxMs: Math.max(...r.map((r) => r.ms)),
      writerP95Ms: percentile(
        r.map((r) => r.writer.executionMs),
        0.95,
      ),
      queueP95Ms: percentile(
        r.map((r) => r.writer.waitMs),
        0.95,
      ),
      rpcCounts: [...new Set(r.map((r) => r.profile.rpcCount))],
      sqlCounts: [...new Set(r.map((r) => r.profile.sqlCount))],
      lookaheadSamples: r.filter((r) => r.writer.lookahead).length,
    };
  }
  summary.passedSlo = Object.values(summary.byOperation).every(
    (r) => r.p95Ms < 1000,
  );
  assert.equal(maxActive, 4);
  assert.equal(maxFinancialActive, 4);
  assert.ok(
    rows.every((r) => r.writer.maxActive === 1 && r.profile.sqlCount <= 48),
  );
  assert.ok(
    rows.every((r) => r.profile.rpcCount === (phase === "baseline" ? 5 : 4)),
  );
  await writeFile(
    path.join(dir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify({ dir, ...summary }));
  if (phase !== "baseline")
    assert.equal(
      summary.passedSlo,
      true,
      "P95_TARGET_NOT_MET; preserve all completed envelopes and samples",
    );
} finally {
  await pending;
  await evidenceWrites;
  await file.close();
}
