import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { saleInput, creditIdentity, resultRoot } from "./native.mjs";
import { setupLab, oracle } from "./native-support.mjs";
import {
  readPagedSnapshot,
  exportPagedJournal,
  journalFileRecords,
  validateJournalFile,
} from "../cash/paged-client.mjs";
const results = resultRoot;
const dir = results + "/recovery-" + Date.now();
const ret = (invoiceId, itemId, key, patch = {}) => ({
  commandType: "RETURN",
  branchId: 1,
  shiftId: 1,
  invoiceId,
  clientRequestId: key,
  operatorReason: "synthetic recovery return",
  restock: true,
  lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
  ...patch,
});
const item = async (l, id) =>
  (
    await l.db
      .prepare("SELECT id FROM invoiceItems WHERE invoiceId=?")
      .bind(id)
      .first()
  ).id;
test("actual returns: ambiguity, 4 cashiers, source restart, independent signed offline restore", async () => {
  const l = await setupLab("accounting-recovery", {
    coordinated: true,
    multipleCashiers: true,
    name: "recovery",
  });
  let sourceOff = false;
  const saved = [],
    profiles = [],
    times = [],
    save = async (input) => {
      saved.push(input);
      await writeFile(
        dir + "/native-commands.json",
        JSON.stringify(saved, null, 2),
      );
      return input;
    };
  await mkdir(dir, { recursive: true });
  try {
    const baseline = oracle.scenarios.find(
      (s) => s.name === "ACTIVE-cash-partial-full",
    ).commands[0].before;
    await l.seed(baseline);
    await l.seed(baseline, l.rd);
    for (const fault of [
      "log-unavailable",
      "after-prepare",
      "last-statement",
      "after-primary",
      "drop-response",
    ]) {
      const sale = (
        await l.ok(
          l.source,
          "/sale",
          await save(saleInput("ret-fault-sale-" + fault, { customerId: 5 })),
        )
      ).body;
      const input = await save(
        ret(
          sale.invoiceId,
          await item(l, sale.invoiceId),
          "ret-fault-" + fault,
        ),
      );
      const before = await readPagedSnapshot(l.call, l.source),
        bad = await l.call(l.source, "/return", input, fault);
      assert.equal(bad.status, 503, JSON.stringify(bad));
      if (
        ["log-unavailable", "after-prepare", "last-statement"].includes(fault)
      )
        assert.deepEqual(await readPagedSnapshot(l.call, l.source), before);
      if (fault === "after-primary")
        assert.equal(
          (await l.ok(l.source, "/operation/" + input.clientRequestId)).body
            .state,
          "PRIMARY_COMMITTED_RECOVERY_PENDING",
        );
      if (fault === "after-primary" || fault === "drop-response")
        await l.db
          .prepare(
            "UPDATE doubleEntrySettings SET policyApprovalPolicyHash='bad-current-policy' WHERE id=1",
          )
          .run();
      const fixed = await l.ok(l.source, "/return", input);
      if (fault === "after-primary" || fault === "drop-response")
        await l.db
          .prepare(
            "UPDATE doubleEntrySettings SET policyApprovalPolicyHash=? WHERE id=1",
          )
          .bind(oracle.policyHash)
          .run();
      const fixedSnapshot = await readPagedSnapshot(l.call, l.source);
      assert.equal(fixed.body.returnedTotal, "83.37");
      assert.equal(fixed.body.recoveryAcknowledged, true);
      assert.equal(
        (await l.ok(l.second, "/return", input)).body.returnedTotal,
        "83.37",
      );
      assert.deepEqual(
        await readPagedSnapshot(l.call, l.source),
        fixedSnapshot,
      );
      assert.equal(
        (await l.call(l.source, "/return", { ...input, restock: false }))
          .status,
        409,
      );
    }
    const ns = await l.source.getDurableObjectNamespace(
        "CREDIT_WRITER",
        "primary",
      ),
      writer = ns.get(
        ns.idFromName(creditIdentity.labId + ":primary:writer-v1"),
      );
    const startSale = (
      await l.ok(
        l.source,
        "/sale",
        saleInput("ret-restart-sale", { customerId: 5 }),
      )
    ).body;
    const restart = await save(
      ret(
        startSale.invoiceId,
        await item(l, startSale.invoiceId),
        "ret-native-writer-restart",
      ),
    );
    const pending = l
      .call(l.source, "/return", restart, "writer-reset-after-primary")
      .catch((e) => ({ status: 503, error: e.message }));
    for (let n = 0; ; n++) {
      const s = (await l.ok(writer, "/test-state")).body;
      if (s.restartWaiting) break;
      if (n >= 100) throw Error("RESTART_NOT_REACHED");
      await new Promise((r) => setTimeout(r, 10));
    }
    const old = (await l.ok(writer, "/test-state")).body.instance;
    await l.call(writer, "/test-release-restart").catch(() => {});
    assert.equal((await pending).status, 503);
    const recovered = await l.ok(l.source, "/return", restart);
    assert.notEqual(recovered.writer.instance, old);
    assert.equal(
      (await l.ok(l.source, "/operation/" + restart.clientRequestId)).body
        .state,
      "CONFIRMED",
    );
    const count = Number(process.env.ACCOUNTING_LOAD_SALES ?? 8),
      begin = performance.now();
    assert.ok(count >= 4 && count <= 16 && count % 4 === 0);
    for (let base = 0; base < count; base += 4)
      await Promise.all(
        [11, 12, 13, 14].map(async (terminal, offset) => {
          const i = base + offset,
            cash = i % 2 === 0,
            target = i % 3 === 0 ? l.second : l.source;
          const input = await save(
            saleInput("ret-load-sale-" + i, {
              commandType: cash ? "CASH_SALE" : "SALE",
              shiftId: terminal,
              customerId: 5,
              lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
              ...(cash
                ? { payment: { method: "CASH", amount: "166.74" } }
                : {}),
            }),
          );
          const s = await l.ok(
            target,
            "/sale",
            input,
            "",
            "",
            String(terminal),
          );
          times.push(s.ms);
          profiles.push(s.profile);
          const id = await item(l, s.body.invoiceId);
          for (const k of ["partial", "full"]) {
            const input = await save(
              ret(s.body.invoiceId, id, "ret-load-" + i + "-" + k, {
                shiftId: terminal,
                ...(cash
                  ? {
                      refund: {
                        method: "CASH",
                        amount: "83.37",
                        shiftId: terminal,
                      },
                    }
                  : {}),
              }),
            );
            const r = await l.ok(
              target,
              "/return",
              input,
              "",
              "",
              String(terminal),
            );
            assert.equal(r.body.fullyReturned, k === "full");
            times.push(r.ms);
            profiles.push(r.profile);
            if (k === "full")
              assert.equal(
                (
                  await l.ok(
                    l.second,
                    "/return",
                    input,
                    "",
                    "",
                    String(terminal),
                  )
                ).body.returnedTotal,
                "83.37",
              );
          }
        }),
      );
    assert.ok(profiles.every((p) => p.sqlCount <= 48));
    assert.equal(
      (
        await l.db
          .prepare("SELECT quantity FROM branchStock WHERE id=1")
          .first()
      ).quantity,
      100,
    );
    assert.equal(
      (
        await l.db
          .prepare("SELECT currentBalance FROM customers WHERE id=5")
          .first()
      ).currentBalance,
      "0.00",
    );
    // Four actors contend for the same AR balance, then the same refund/stock remainder.
    const contested = await l.ok(
      l.source,
      "/sale",
      saleInput("q1-contended-ar-sale", {
        customerId: 5,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
      }),
    );
    const itemId = await item(l, contested.body.invoiceId);
    const actors = [11, 12, 13, 14];
    const collections = await Promise.all(
      actors.map((terminal) =>
        l.call(
          l.source,
          "/payment",
          {
            commandType: "COLLECT",
            branchId: 1,
            shiftId: terminal,
            invoiceId: contested.body.invoiceId,
            method: "CASH",
            amount: "83.37",
            clientRequestId: "q1-contention-collect-" + terminal,
          },
          "",
          "",
          String(terminal),
        ),
      ),
    );
    assert.equal(collections.filter((r) => r.status === 200).length, 3);
    assert.equal(collections.filter((r) => r.status !== 200).length, 1);
    const competingReturns = await Promise.all(
      actors.map((terminal) =>
        l.call(
          l.source,
          "/return",
          ret(
            contested.body.invoiceId,
            itemId,
            "q1-contention-return-" + terminal,
            {
              shiftId: terminal,
              refund: { method: "CASH", amount: "83.37", shiftId: terminal },
            },
          ),
          "",
          "",
          String(terminal),
        ),
      ),
    );
    assert.equal(competingReturns.filter((r) => r.status === 200).length, 3);
    assert.equal(competingReturns.filter((r) => r.status !== 200).length, 1);
    assert.equal(
      (
        await l.db
          .prepare("SELECT returnedTotal FROM invoices WHERE id=?")
          .bind(contested.body.invoiceId)
          .first()
      ).returnedTotal,
      "250.11",
    );
    assert.equal(
      (
        await l.db
          .prepare("SELECT currentBalance FROM customers WHERE id=5")
          .first()
      ).currentBalance,
      "0.00",
    );
    assert.equal(
      (
        await l.db
          .prepare("SELECT quantity FROM branchStock WHERE id=1")
          .first()
      ).quantity,
      100,
    );
    profiles.push(
      ...collections.map((r) => r.profile),
      ...competingReturns.map((r) => r.profile),
    );
    assert.ok(profiles.every((p) => p.sqlCount <= 48));
    const journalOnlyCall = (target, route, input) =>
      l.call(target, "/journal-only" + route, input);
    // core receives only LAB_TOKEN and RECOVERY_LOG; no DB or writer namespace.
    // Export therefore works even when primary is unavailable to this invocation.
    const snapshot = await readPagedSnapshot(l.call, l.source),
      file = dir + "/native-signed.ndjson",
      options = {
        snapshotSha256: snapshot.sha256,
        snapshotEpoch: snapshot.epoch,
        identity: creditIdentity,
      };
    await assert.rejects(
      exportPagedJournal(journalOnlyCall, l.source, file, l.secret, {
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
        journalOnlyCall,
        l.source,
        file,
        l.secret,
        { ...options, resume: true },
      ),
      records = [];
    for await (const r of journalFileRecords(file, l.secret, creditIdentity))
      records.push(r);
    assert.equal(records.length, snapshot.epoch - 1);
    const corrupt = structuredClone(records[0]);
    corrupt.plan.result.total = "0.00";
    assert.equal(
      (await l.call(l.restore, "/restore", { records: [corrupt] })).status,
      400,
    );
    assert.equal(
      (await l.call(l.restore, "/restore", { records: [records[1]] })).status,
      409,
    );
    await l.freezeLegacySource();
    await l.source.dispose();
    sourceOff = true;
    for (const record of records)
      await l.ok(l.restore, "/restore", { records: [record] });
    assert.deepEqual(await readPagedSnapshot(l.call, l.restore), snapshot);
    for (const record of [records[0], records.at(-1)])
      await l.ok(l.restore, "/restore", { records: [record] });
    assert.deepEqual(await readPagedSnapshot(l.call, l.restore), snapshot);
    assert.equal(l.outbound.length, 0);
    await l.verifyLegacy();
    times.sort((a, b) => a - b);
    const proof = {
      passed: true,
      loadSales: count,
      loadReturns: count * 2,
      measuredSamples: times.length,
      concurrency: 4,
      actors: [11, 12, 13, 14],
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      maxSql: Math.max(...profiles.map((p) => p.sqlCount)),
      measuredMs: performance.now() - begin,
      faults: [
        "log-unavailable",
        "after-prepare",
        "last-statement",
        "after-primary",
        "drop-response",
        "writer-reset-after-primary",
      ],
      sourceDisposed: true,
      exportWithoutPrimaryBinding: true,
      sameInvoiceCollectionContenders: 4,
      sameInvoiceReturnContenders: 4,
      hostingerOutboundAttempts: l.outbound.length,
      pageBytes: l.pageBytes,
      maxPageBytes: Math.max(...l.pageBytes.map((p) => p.bytes)),
      exported,
      snapshot,
      artifactDir: dir,
    };
    await writeFile(
      dir + "/native-recovery.json",
      JSON.stringify(proof, null, 2),
      { flag: "wx" },
    );
    await writeFile(
      results + "/native-recovery.json",
      JSON.stringify(proof, null, 2),
    );
  } finally {
    if (!sourceOff) await l.source.dispose();
    await l.restore.dispose();
  }
});
