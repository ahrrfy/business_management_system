import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeLab, saleInput, creditIdentity } from "./native.mjs";
import { creditRoot } from "./build.mjs";
import {
  readPagedSnapshot,
  exportPagedJournal,
  journalFileRecords,
  validateJournalFile,
} from "../cash/paged-client.mjs";
const pay = (invoiceId, key, amount = "100") => ({
  commandType: "COLLECT",
  branchId: 1,
  shiftId: 1,
  invoiceId,
  clientRequestId: key,
  method: "CASH",
  amount,
});
test("credit single writer, contention, native restart, ambiguous replies, load and source-offline signed restore", async () => {
  const loadSales = Number(process.env.CREDIT_LOAD_SALES ?? 120);
  assert.ok(
    Number.isSafeInteger(loadSales) &&
      loadSales >= 4 &&
      loadSales <= 1000 &&
      loadSales % 4 === 0,
  );
  if (process.env.CREDIT_LOAD_SALES)
    await mkdir(path.join(creditRoot, "results/perf-20261018"), {
      recursive: true,
    });
  const l = await nativeLab({ name: "recovery", coordinated: true });
  let sourceOff = false;
  try {
    // Synthetic baseline is identical on source and independent restore.
    for (const db of [l.db, l.rd])
      await db
        .prepare("UPDATE branchStock SET quantity=? WHERE id=1")
        .bind(loadSales + 100)
        .run();
    const attempts = await Promise.all([
      l.call(
        l.source,
        "/sale",
        saleInput("credit-limit-race-a", { customerId: 2 }),
      ),
      l.call(
        l.second,
        "/sale",
        saleInput("credit-limit-race-b", { customerId: 2 }),
      ),
    ]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 403]);
    assert.equal(
      (
        await l.db
          .prepare("SELECT currentBalance FROM customers WHERE id=2")
          .first()
      ).currentBalance,
      "100.00",
    );
    const same = saleInput("credit-shared-request", { customerId: 5 }),
      copies = await Promise.all([
        l.ok(l.source, "/sale", same),
        l.ok(l.second, "/sale", same),
        l.ok(l.source, "/sale", same),
      ]);
    assert.equal(new Set(copies.map((r) => r.body.invoiceId)).size, 1);
    assert.equal(new Set(copies.map((r) => r.writer.instance)).size, 1);
    assert.ok(copies.every((r) => r.writer.maxActive === 1));
    assert.equal(
      (await l.call(l.source, "/sale", { ...same, customerId: 1 })).status,
      409,
    );
    assert.equal(
      (await l.call(l.restore, "/sale", saleInput("credit-no-writer"))).status,
      503,
    );
    for (const kind of ["SALE", "COLLECT"])
      for (const fault of [
        "log-unavailable",
        "after-prepare",
        "last-statement",
        "after-primary",
        "drop-response",
      ]) {
        const key = "credit-fault-" + kind + "-" + fault;
        const input =
          kind === "SALE"
            ? saleInput(key, { customerId: 5 })
            : pay(copies[0].body.invoiceId, key, "1");
        const route = kind === "SALE" ? "/sale" : "/payment",
          before = (await l.db.prepare("SELECT epoch FROM cashEpoch").first())
            .epoch,
          r = await l.call(l.source, route, input, fault);
        assert.equal(r.status, 503, JSON.stringify(r));
        const after = (
          await l.db.prepare("SELECT epoch FROM cashEpoch").first()
        ).epoch;
        assert.equal(
          after,
          before + (["after-primary", "drop-response"].includes(fault) ? 1 : 0),
        );
        const recovered = await l.ok(l.second, route, input);
        assert.equal(recovered.body.recoveryAcknowledged, true);
        const replay = await l.ok(l.source, route, input);
        assert.equal(replay.body.recoveryEpoch, recovered.body.recoveryEpoch);
      }
    // Abort a real native Durable Object after the collection batch commits.
    const ns = await l.source.getDurableObjectNamespace(
        "CREDIT_WRITER",
        "primary",
      ),
      stub = () =>
        ns.get(ns.idFromName("actual-credit-20261018:primary:writer-v1")),
      control = async (p) =>
        await (await stub().fetch("http://credit.test" + p)).json();
    const until = async (predicate) => {
      for (let i = 0; i < 500; i++) {
        const s = await control("/test-state");
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("CREDIT_BARRIER_TIMEOUT");
    };
    const old = (await control("/test-state")).instance,
      restartingInput = pay(
        copies[0].body.invoiceId,
        "credit-reset-collection",
        "5",
      ),
      running = l.call(
        l.source,
        "/payment",
        restartingInput,
        "writer-reset-after-primary",
      );
    await until((s) => s.restartWaiting);
    const waitingInput = saleInput("credit-reset-queued", { customerId: 5 }),
      waiting = l.call(l.second, "/sale", waitingInput);
    await until((s) => s.pending === 2);
    const release = control("/test-release-restart");
    const interrupted = await Promise.all([running, waiting]);
    await release;
    assert.equal(interrupted[0].status, 503);
    assert.notEqual((await control("/test-state")).instance, old);
    assert.equal(
      (await l.ok(l.source, "/operation/" + restartingInput.clientRequestId))
        .body.state,
      "PRIMARY_COMMITTED_RECOVERY_PENDING",
    );
    await l.ok(l.second, "/payment", restartingInput);
    await l.ok(l.source, "/sale", waitingInput);
    // Hold an acknowledged sale so a queued collection must wait on the same writer.
    const held = l.ok(
      l.source,
      "/sale",
      saleInput("credit-held-sale", { customerId: 5 }),
      "hold-journal",
    );
    await until((s) => s.waiting);
    const queued = l.ok(
      l.second,
      "/payment",
      pay(copies[0].body.invoiceId, "credit-queued-collection", "5"),
    );
    await until((s) => s.pending === 2);
    await control("/test-release");
    const ordered = await Promise.all([held, queued]);
    assert.ok(
      ordered[0].writer.admissionSequence < ordered[1].writer.admissionSequence,
    );
    const latencies = [],
      profiles = [],
      begin = performance.now();
    for (let start = 0; start < loadSales; start += 4)
      await Promise.all(
        Array.from({ length: 4 }, async (_, j) => {
          const i = start + j,
            target = i % 2 ? l.source : l.second;
          const s = await l.ok(
            target,
            "/sale",
            saleInput("credit-load-" + i, { customerId: 5 }),
          );
          latencies.push(s.ms);
          profiles.push(s.profile);
          for (const [k, amount] of [
            ["partial", "40"],
            ["final", "60"],
          ]) {
            const r = await l.ok(
              target,
              "/payment",
              pay(s.body.invoiceId, "credit-load-" + i + "-" + k, amount),
            );
            latencies.push(r.ms);
            profiles.push(r.profile);
          }
          const replay = await l.ok(
            target,
            "/sale",
            saleInput("credit-load-" + i, { customerId: 5 }),
          );
          assert.equal(replay.body.invoiceId, s.body.invoiceId);
        }),
      );
    assert.ok(profiles.every((p) => p.sqlCount <= 48));
    const snapshot = await readPagedSnapshot(l.call, l.source),
      out = path.join(creditRoot, "results/recovery-" + Date.now());
    await mkdir(out, { recursive: true });
    const file = path.join(out, "signed-credit.ndjson"),
      options = {
        snapshotSha256: snapshot.sha256,
        snapshotEpoch: snapshot.epoch,
        identity: creditIdentity,
      };
    await assert.rejects(
      exportPagedJournal(l.call, l.source, file, l.secret, {
        ...options,
        interruptAfterPages: 1,
      }),
      /SIMULATED_EXPORT_INTERRUPTION/,
    );
    await assert.rejects(
      validateJournalFile(file, l.secret, creditIdentity),
      /incomplete/,
    );
    const exported = await exportPagedJournal(
      l.call,
      l.source,
      file,
      l.secret,
      { ...options, resume: true },
    );
    await assert.rejects(validateJournalFile(file, l.secret), /actual-cash/);
    const records = [];
    for await (const r of journalFileRecords(file, l.secret, creditIdentity))
      records.push(r);
    assert.equal(records.length, snapshot.epoch - 1);
    const first = records[0],
      bad = structuredClone(first);
    bad.plan.result.total = "0.00";
    assert.equal(
      (await l.call(l.restore, "/restore", { records: [bad] })).status,
      400,
    );
    assert.equal(
      (await l.call(l.restore, "/restore", { records: [records[1]] })).status,
      409,
    );
    await l.source.dispose();
    sourceOff = true;
    for (const r of records)
      await l.ok(l.restore, "/restore", { records: [r] });
    const restored = await readPagedSnapshot(l.call, l.restore);
    assert.deepEqual(restored, snapshot);
    for (const r of [first, records.at(-1)])
      await l.ok(l.restore, "/restore", { records: [r] });
    assert.deepEqual(await readPagedSnapshot(l.call, l.restore), snapshot);
    assert.equal(l.outbound.length, 0);
    latencies.sort((a, b) => a - b);
    await writeFile(
      path.join(
        creditRoot,
        process.env.CREDIT_LOAD_SALES
          ? "results/perf-20261018/native-recovery.json"
          : "results/recovery.json",
      ),
      JSON.stringify(
        {
          passed: true,
          loadSales,
          loadCollections: loadSales * 2,
          concurrency: 4,
          measuredMs: performance.now() - begin,
          p50Ms: latencies[Math.floor(latencies.length * 0.5)],
          p95Ms: latencies[Math.floor(latencies.length * 0.95)],
          maxSql: Math.max(...profiles.map((p) => p.sqlCount)),
          nativeRestartAfterCollectionCommit: true,
          crossFrontendSingleWriter: true,
          independentRestoreAfterSourceDisposed: true,
          exported,
          snapshot,
          outboundAttempts: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!sourceOff) await l.source.dispose();
    await l.restore.dispose();
  }
});
