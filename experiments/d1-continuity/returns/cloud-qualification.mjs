import assert from "node:assert/strict";
import { mkdir, open, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";
import {
  creditCloudContext,
  verifyCreditResources,
  legacyProof,
} from "../credit/cloud-run.mjs";
import {
  readPagedSnapshot,
  exportPagedJournal,
  journalFileRecords,
} from "../cash/paged-client.mjs";
import { returnsRoot } from "./build.mjs";
import { assertHistoricalRows } from "./history.mjs";
assert.equal(process.argv[2], "--confirm-isolated-returns-lab");
const c = await creditCloudContext();
await verifyCreditResources(c);
const dir = path.join(
  returnsRoot,
  "results/cloud-20261019",
  "qualification-" + Date.now(),
);
await mkdir(dir, { recursive: true });
const attempts = await open(path.join(dir, "attempts.ndjson"), "wx");
let sequence = Promise.resolve(),
  sourceBlocked = false,
  requests = 0;
const append = async (value) => {
  sequence = sequence.then(async () => {
    await attempts.write(JSON.stringify(value) + "\n");
    await attempts.sync();
  });
  await sequence;
};
const call = async (
  target,
  route,
  input,
  fault = "",
  terminal = "1",
  category = "read",
) => {
  assert.ok(target === c.source || target === c.restore);
  if (sourceBlocked && target === c.source)
    throw Error("SOURCE_DISABLED_BY_RECOVERY_TEST");
  const attempt = ++requests;
  await append({
    attempt,
    phase: "BEFORE_REQUEST",
    target,
    route,
    input,
    fault,
    terminal,
    category,
    at: new Date().toISOString(),
  });
  const start = performance.now();
  let result;
  try {
    const r = await fetch(target + route, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + c.secret,
        "content-type": "application/json",
        "x-cash-profile": "1",
        ...(terminal === "1" ? {} : { "x-credit-lab-terminal": terminal }),
        ...(fault ? { "x-cash-fault": fault } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(45000),
    });
    result = {
      status: r.status,
      body: await r.json(),
      ms: performance.now() - start,
      profile: JSON.parse(r.headers.get("x-cash-profile") ?? "null"),
    };
  } catch (e) {
    await append({
      attempt,
      phase: "TRANSPORT_FAILURE",
      message: e.message,
      ms: performance.now() - start,
    });
    throw e;
  }
  await append({ attempt, phase: "RESPONSE", ...result });
  return result;
};
const ok = async (...args) => {
  const r = await call(...args);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r;
};
const samples = [],
  id = "rt-" + Date.now();
const sale = (
  key,
  actor,
  variant = 1,
  mode = "CASH_SALE",
  quantity = "1",
  payment,
) => ({
  commandType: mode,
  branchId: 1,
  shiftId: actor,
  sourceType: "POS",
  customerId: 1,
  clientRequestId: key,
  lines: [{ variantId: variant, productUnitId: variant, quantity }],
  ...(payment ? { payment: { method: "CASH", amount: payment } } : {}),
});
const ret = (invoiceId, itemId, key, actor, refund, walkin = false) => ({
  commandType: "RETURN",
  branchId: 1,
  shiftId: actor,
  invoiceId,
  clientRequestId: key,
  operatorReason: "isolated cloud return qualification",
  restock: true,
  lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
  ...(walkin
    ? {
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: refund,
          shiftId: actor,
          reason: "isolated cloud return qualification",
          disposition: "RESTOCK",
        },
      }
    : refund
      ? { refund: { method: "CASH", amount: refund, shiftId: actor } }
      : {}),
});
const measure = async (route, input, terminal) => {
  const r = await ok(
    c.source,
    route,
    input,
    "",
    String(terminal),
    "measurement",
  );
  samples.push({ route, terminal, ms: r.ms, sql: r.profile?.sqlCount });
  return r;
};
try {
  const status = (await ok(c.source, "/status")).body;
  assert.equal(
    status.scope,
    "ORIGINAL_STOCKED_CASH_CREDIT_COLLECTION_AND_RETURNS",
  );
  const baselineRows = {},
    before = await readPagedSnapshot(call, c.source, {
      onRow: (t, r) => (baselineRows[t] ??= []).push(r),
    });
  assert.deepEqual(await readPagedSnapshot(call, c.restore), before);
  assert.equal(
    baselineRows.customers.find((r) => r.id === 1).currentBalance,
    "0.00",
  );
  assert.ok(
    new Decimal(baselineRows.customers.find((r) => r.id === 1).creditLimit).gte(
      320,
    ),
  );
  assert.ok(
    !baselineRows.invoices.some(
      (i) =>
        i.customerId === 1 &&
        ["PENDING", "PARTIALLY_PAID"].includes(i.invoiceStatus),
    ),
  );
  assert.ok(before.counts.documentEffects === 0);
  await writeFile(
    path.join(dir, "baseline.json"),
    JSON.stringify({ snapshot: before, rows: baselineRows }, null, 2),
    { flag: "wx" },
  );
  assert.ok(
    baselineRows.branchStock.find((r) => r.variantId === 1 && r.branchId === 1)
      .quantity >= 4,
  );
  assert.ok(
    baselineRows.branchStock.find((r) => r.variantId === 2 && r.branchId === 1)
      .quantity >= 4,
  );
  for (const terminal of [11, 12, 13, 14])
    await ok(c.source, "/ready", undefined, "", String(terminal));
  for (let round = 0; round < 3; round++)
    await Promise.all(
      [11, 12, 13, 14].map(async (actor) => {
        const variant = actor % 2 ? 1 : 2,
          unit = variant === 1 ? "100" : "80",
          total = variant === 1 ? "200" : "160",
          mode = actor === 12 || actor === 14 ? "SALE" : "CASH_SALE";
        const input = sale(
          id + "-" + round + "-" + actor,
          actor,
          variant,
          mode,
          "2",
          mode === "CASH_SALE" ? total : actor === 12 ? "40" : undefined,
        );
        if (actor === 11) delete input.customerId;
        const s = await measure("/sale", input, actor),
          e = (await ok(c.source, "/evidence?invoiceId=" + s.body.invoiceId))
            .body,
          item = e.items[0].id;
        if (actor === 14)
          await measure(
            "/payment",
            {
              commandType: "COLLECT",
              branchId: 1,
              shiftId: actor,
              invoiceId: s.body.invoiceId,
              clientRequestId: id + "-" + round + "-" + actor + "-pay",
              method: "CASH",
              amount: total,
            },
            actor,
          );
        for (const k of ["partial", "full"]) {
          const refund =
              actor === 12 ? (k === "full" ? "40" : undefined) : unit,
            request = ret(
              s.body.invoiceId,
              item,
              id + "-" + round + "-" + actor + "-" + k,
              actor,
              refund,
              actor === 11,
            );
          const r = await measure("/return", request, actor);
          assert.equal(r.body.fullyReturned, k === "full");
          const replay = await ok(
            c.source,
            "/return",
            request,
            "",
            String(actor),
            "replay",
          );
          assert.equal(replay.body.returnedTotal, r.body.returnedTotal);
          if (k === "full")
            assert.equal(
              (
                await call(
                  c.source,
                  "/return",
                  { ...request, restock: false },
                  "",
                  String(actor),
                  "conflict",
                )
              ).status,
              409,
            );
        }
      }),
    );
  for (const fault of [
    "log-unavailable",
    "after-prepare",
    "last-statement",
    "after-primary",
    "drop-response",
  ]) {
    const s = await ok(
        c.source,
        "/sale",
        sale(id + "-fault-sale-" + fault, 11, 1, "CASH_SALE", "1", "100"),
        "",
        "11",
        "fault-setup",
      ),
      e = (await ok(c.source, "/evidence?invoiceId=" + s.body.invoiceId)).body;
    const request = ret(
        s.body.invoiceId,
        e.items[0].id,
        id + "-fault-" + fault,
        11,
        "100",
      ),
      beforeFault = await readPagedSnapshot(call, c.source);
    assert.equal(
      (await call(c.source, "/return", request, fault, "11", "fault")).status,
      503,
    );
    if (["log-unavailable", "after-prepare", "last-statement"].includes(fault))
      assert.deepEqual(await readPagedSnapshot(call, c.source), beforeFault);
    if (fault === "after-primary")
      assert.equal(
        (await ok(c.source, "/operation/" + request.clientRequestId)).body
          .state,
        "PRIMARY_COMMITTED_RECOVERY_PENDING",
      );
    await ok(c.source, "/return", request, "", "11", "fault-recovery");
    const fixed = await readPagedSnapshot(call, c.source);
    await ok(c.source, "/return", request, "", "11", "replay");
    assert.deepEqual(await readPagedSnapshot(call, c.source), fixed);
  }
  const snapshot = await readPagedSnapshot(call, c.source),
    file = path.join(dir, "signed.ndjson"),
    identity = {
      labId: "actual-credit-20261018",
      schemaVersion: "actual-credit-v1",
    },
    options = {
      snapshotSha256: snapshot.sha256,
      snapshotEpoch: snapshot.epoch,
      identity,
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
  sourceBlocked = true;
  let restored = 0;
  for await (const record of journalFileRecords(file, c.secret, identity)) {
    for (let attempt = 0; ; attempt++) {
      let result;
      try {
        result = await call(
          c.restore,
          "/restore",
          { records: [record] },
          "",
          "1",
          "restore",
        );
      } catch (e) {
        if (attempt >= 3) throw e;
        await append({
          phase: "RESTORE_RETRY",
          requestId: record.requestId,
          attempt: attempt + 1,
          message: e.message,
        });
        continue;
      }
      if (result.status === 200) break;
      assert.ok(result.status >= 500 && attempt < 3, JSON.stringify(result));
      await append({
        phase: "RESTORE_RETRY",
        requestId: record.requestId,
        attempt: attempt + 1,
        status: result.status,
      });
    }
    restored++;
  }
  const recoveredRows = {},
    recovered = await readPagedSnapshot(call, c.restore, {
      onRow: (t, r) => (recoveredRows[t] ??= []).push(r),
    });
  assert.deepEqual(recovered, snapshot);
  for (const variant of [1, 2])
    assert.equal(
      recoveredRows.branchStock.find(
        (r) => r.branchId === 1 && r.variantId === variant,
      ).quantity,
      baselineRows.branchStock.find(
        (r) => r.branchId === 1 && r.variantId === variant,
      ).quantity,
    );
  assert.equal(
    recoveredRows.customers.find((r) => r.id === 1).currentBalance,
    baselineRows.customers.find((r) => r.id === 1).currentBalance,
  );
  const meta = JSON.parse(
    await readFile(path.join(returnsRoot, "build/cloud/tables.json"), "utf8"),
  );
  assertHistoricalRows({
    baselineRows,
    recoveredRows,
    before,
    recovered,
    tableNames: meta.map((t) => t.name),
  });
  const original = JSON.parse(
    await readFile(
      path.join(returnsRoot, "results/cloud-20261019/before.json"),
      "utf8",
    ),
  );
  for (const role of ["primary", "restore", "journal"])
    assert.deepEqual(await legacyProof(c, role), original.legacy[role]);
  const p95 = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  };
  const result = {
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
    restored,
    exported,
    before,
    snapshot,
    recovered,
    newResources: 0,
    planUpgrade: false,
    hostinger:
      "No Hostinger binding or request; production server was not stopped",
  };
  assert.ok(result.maxSql <= 48);
  await writeFile(
    path.join(dir, "samples.json"),
    JSON.stringify(samples, null, 2),
  );
  await writeFile(
    path.join(dir, "summary.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await sequence;
  await attempts.close();
}
