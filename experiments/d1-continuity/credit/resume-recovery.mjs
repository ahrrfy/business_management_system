import assert from "node:assert/strict";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { creditCloudContext, verifyCreditResources } from "./cloud-run.mjs";
import { creditRoot } from "./build.mjs";
import { countRestoreResult } from "./restore-progress.mjs";
import {
  canonical,
  readPagedSnapshot,
  validateJournalFile,
  journalFileRecords,
} from "../cash/paged-client.mjs";

assert.equal(process.argv[2], "--confirm-isolated-credit-lab");
assert.match(process.argv[3] ?? "", /^recovery-\d+$/);
const base = path.join(creditRoot, "results/subsecond-20261018"),
  previous = path.join(base, process.argv[3]),
  file = path.join(previous, "signed-credit.ndjson"),
  c = await creditCloudContext(),
  identity = {
    labId: "actual-credit-20261018",
    schemaVersion: "actual-credit-v1",
  };
await verifyCreditResources(c);
const exported = await validateJournalFile(file, c.secret, identity),
  commands = JSON.parse(
    await readFile(path.join(previous, "commands.json"), "utf8"),
  ),
  dir = path.join(previous, "resume-" + Date.now());
await mkdir(dir, { recursive: true });
const evidence = await open(path.join(dir, "attempts.ndjson"), "ax");
const attempts = [];
let sourceBlocked = false;
async function call(target, route, input) {
  assert.ok([c.source, c.restore].includes(target));
  if (sourceBlocked && target === c.source)
    throw Error("SOURCE_DISABLED_BY_RECOVERY_TEST");
  const payload = input === undefined ? undefined : JSON.stringify(input);
  for (let attempt = 1; attempt <= 4; attempt++) {
    let status = 503,
      body;
    try {
      const r = await fetch(target + route, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + c.secret,
          "content-type": "application/json",
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(30000),
      });
      status = r.status;
      const raw = await r.text();
      try {
        body = JSON.parse(raw);
      } catch {
        body = { code: "NON_JSON_RESPONSE" };
      }
    } catch (e) {
      if (!["TypeError", "TimeoutError", "AbortError"].includes(e.name))
        throw e;
      body = { code: "HTTP_TRANSPORT_UNCERTAIN" };
    }
    const row = {
      target: target === c.source ? "primary" : "restore",
      route,
      epoch: input?.records?.[0]?.epoch ?? null,
      attempt,
      status,
      code: body.code ?? null,
    };
    attempts.push(row);
    await evidence.write(JSON.stringify(row) + "\n");
    await evidence.sync();
    if (status === 200) return { status, body };
    // Only read-only snapshots and identical signed restore records are retried.
    // This is recovery evidence; it never contributes samples to performance P95.
    assert.ok([502, 503, 504].includes(status), JSON.stringify(row));
    if (attempt === 4)
      throw Error("RECOVERY_RETRY_BUDGET_EXHAUSTED_KEEP_CHECKPOINT");
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
}
try {
  const snapshot = await readPagedSnapshot(call, c.source);
  assert.equal(snapshot.sha256, exported.header.snapshotSha256);
  assert.equal(snapshot.epoch, exported.header.throughEpoch);
  const before = await readPagedSnapshot(call, c.restore);
  await writeFile(
    path.join(dir, "checkpoint.json"),
    JSON.stringify({ snapshot, before, exported }, null, 2),
    { flag: "wx" },
  );
  sourceBlocked = true;
  const progress = {
    applied: 0,
    replayed: 0,
    observedApplied: 0,
    observedReplayed: 0,
  };
  let matchedCommands = 0,
    first,
    last;
  const expected = new Map(
    commands.map((command) => [command.clientRequestId, command]),
  );
  assert.equal(expected.size, commands.length);
  for await (const record of journalFileRecords(file, c.secret, identity)) {
    first ??= record;
    last = record;
    if (expected.has(record.requestId)) {
      assert.equal(
        canonical(record.plan.request.input),
        canonical(expected.get(record.requestId)),
      );
      matchedCommands++;
    }
    const r = await call(c.restore, "/restore", { records: [record] });
    assert.equal(r.body.journalBindingPresent, false);
    countRestoreResult(progress, before.epoch, record.epoch, r.body);
  }
  const { applied, replayed } = progress;
  assert.equal(matchedCommands, commands.length);
  assert.equal(applied, snapshot.epoch - before.epoch);
  assert.equal(replayed, before.epoch - 1);
  const restored = await readPagedSnapshot(call, c.restore);
  assert.deepEqual(restored, snapshot);
  for (const record of [first, last])
    await call(c.restore, "/restore", { records: [record] });
  assert.deepEqual(await readPagedSnapshot(call, c.restore), snapshot);
  const result = {
    passed: true,
    at: new Date().toISOString(),
    previous,
    dir,
    resumedAfterCloudD1Internal503: true,
    snapshot,
    restored,
    restoreBeforeResume: before,
    exported,
    applied,
    replayed,
    observedApplied: progress.observedApplied,
    observedReplayed: progress.observedReplayed,
    matchedCommands,
    sourceBlockedInDriverDuringRestore: true,
    cloudSourcePhysicallyStopped: false,
    restoreJournalBinding: false,
    restoreWriterBinding: false,
    hostingerBinding: false,
    newDatabases: 0,
    planUpgrade: false,
    retryAttempts: attempts.filter((row) => row.attempt > 1).length,
    attempts: attempts.length,
    signedFileSha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
  await writeFile(
    path.join(dir, "result.json"),
    JSON.stringify(result, null, 2),
    { flag: "wx" },
  );
  await writeFile(
    path.join(base, "cloud-recovery.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      epoch: snapshot.epoch,
      commands: snapshot.epoch - 1,
      invoices: snapshot.counts.invoices,
      receipts: snapshot.counts.receipts,
      rows: snapshot.totalRows,
      applied,
      replayed,
      matchedCommands,
      retries: result.retryAttempts,
      dir,
    }),
  );
} finally {
  await evidence.close();
}
