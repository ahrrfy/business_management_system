import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";
import { buildActualCashWorker, cashRoot } from "./build.mjs";
import { sqlStatements } from "./sql-statements.mjs";

test("original cash Worker: durable independent acknowledgement, lost responses and journal-only recovery", async () => {
  const buildRoot = path.resolve(
    cashRoot,
    "../../../.superpowers/sdd/cash-integrated-build",
  );
  const testEntry = String.raw`import worker from './worker';
 import {cashTestBindings} from './test-bindings';
 const state={released:false,waiting:false,prefixReaders:0,preflightReleased:false,preflightWaiting:false};
 export default {async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/test-hold-state')return Response.json({waiting:state.waiting});
  if(url.pathname==='/test-release-ack'){state.released=true;return Response.json({released:true});}
  if(url.pathname==='/test-preflight-state')return Response.json({waiting:state.preflightWaiting});
  if(url.pathname==='/test-release-preflight'){state.preflightReleased=true;return Response.json({released:true});}
  const test=cashTestBindings(env,request,state);
  const response=await worker.fetch(request,test.env);
  const headers=new Headers(response.headers),counts=test.counts();
  headers.set('x-test-d1-queries',String(counts.queries));
  headers.set('x-test-primary-reply-lost',String(counts.droppedPrimaryReply));
  return new Response(response.body,{status:response.status,headers});
 }};`;
  await buildActualCashWorker({
    stdin: testEntry,
    outfile: path.join(buildRoot, "worker.mjs"),
  });
  const outbound = [],
    secret = "local-synthetic-cash-key-20261017";
  const options = {
    modules: [
      { type: "ESModule", path: path.join(buildRoot, "worker.mjs") },
      { type: "CompiledWasm", path: path.join(buildRoot, "sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    log: new Log(LogLevel.NONE),
    bindings: { LAB_TOKEN: secret },
    outboundService: async (r) => {
      outbound.push(r.url);
      return new Response("HOSTINGER_UNAVAILABLE", { status: 503 });
    },
  };
  const source = new Miniflare({
      ...options,
      d1Databases: { DB: "cash-primary", RECOVERY_LOG: "cash-journal" },
    }),
    restore = new Miniflare({
      ...options,
      d1Databases: { DB: "cash-restore" },
    });
  let sourceDisposed = false,
    maxSaleQueries = 0;
  const normalSaleRpcs = [];
  try {
    const db = await source.getD1Database("DB"),
      journal = await source.getD1Database("RECOVERY_LOG"),
      rd = await restore.getD1Database("DB");
    const schema = await readFile(path.join(buildRoot, "schema.sql"), "utf8"),
      fixture = await readFile(path.join(buildRoot, "fixture.sql"), "utf8");
    const initialize = async (binding, sql) =>
      binding.batch(sqlStatements(sql).map((s) => binding.prepare(s)));
    for (const [binding, role] of [
      [db, "primary"],
      [rd, "restore"],
    ]) {
      await initialize(binding, schema);
      await initialize(binding, fixture);
      await initialize(
        binding,
        `INSERT INTO products(id,name) VALUES(3,'Synthetic Stock C'),(4,'Synthetic Stock D'); INSERT INTO productVariants(id,productId,sku,costPrice) VALUES(3,3,'CASH-C','50.00'),(4,4,'CASH-D','50.00'); INSERT INTO productUnits(id,variantId,unitName,conversionFactor,isBaseUnit) VALUES(3,3,'piece','1.0000',1),(4,4,'piece','1.0000',1); INSERT INTO productPrices(id,productUnitId,priceTier,price) VALUES(3,3,'RETAIL','100.00'),(4,4,'RETAIL','100.00'); INSERT INTO branchStock(id,variantId,branchId,quantity) VALUES(3,3,1,100),(4,4,1,100);`,
      );
      await initialize(
        binding,
        `CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL); INSERT INTO cashSandboxIdentity VALUES('actual-cash-20261017','${role}');`,
      );
    }
    const metadata = JSON.parse(
      await readFile(path.join(buildRoot, "tables.json"), "utf8"),
    );
    for (const binding of [db, rd])
      for (const table of metadata) {
        const names = table.columns
          .filter((c) => c.defaultSql === "CURRENT_TIMESTAMP")
          .map((c) => "`" + c.name + "`='2026-10-17 00:00:00'");
        if (names.length)
          await binding
            .prepare("UPDATE `" + table.name + "` SET " + names.join(","))
            .run();
      }
    await initialize(
      journal,
      await readFile(path.join(cashRoot, "journal-schema.sql"), "utf8"),
    );
    const call = async (runtime, route, input, fault = "") => {
      let response;
      try {
        response = await runtime.dispatchFetch("http://cash.test" + route, {
          method: input === undefined ? "GET" : "POST",
          headers: {
            authorization: "Bearer " + secret,
            "content-type": "application/json",
            "x-cash-profile": "1",
            ...(fault ? { "x-cash-fault": fault } : {}),
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
      } catch (e) {
        throw Error(
          route + " " + input?.clientRequestId + " " + fault + ": " + e.message,
          { cause: e },
        );
      }
      const queries = Number(response.headers.get("x-test-d1-queries"));
      if (route === "/sale") {
        assert.ok(queries <= 50, "D1 invocation limit exceeded: " + queries);
        maxSaleQueries = Math.max(maxSaleQueries, queries);
      }
      const raw = await response.text();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw Error(route + ": " + raw);
      }
      const profile = JSON.parse(response.headers.get("x-cash-profile") ?? "null");
      if (route === "/sale" && response.status === 200 && body.idempotentReplay === false)
        normalSaleRpcs.push(profile.rpcCount);
      return { status: response.status, body, queries, profile,
        primaryReplyLost: response.headers.get("x-test-primary-reply-lost") === "true" };
    };
    const input = (id) => ({
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      clientRequestId: id,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      payment: { amount: "200", method: "CASH" },
    });
    const snapshot = async (runtime) =>
      (await call(runtime, "/snapshot")).body.tables;
    const initial = await snapshot(source);
    await mkdir(path.join(cashRoot, "results"), { recursive: true });
    await writeFile(
      path.join(cashRoot, "results/baseline.json"),
      JSON.stringify(initial),
    );
    assert.ok(initial.invoices, "Snapshot must expose financial tables");
    assert.equal(
      (await source.dispatchFetch("http://cash.test/snapshot")).status,
      401,
    );
    const malformed = input("cash-invalid-rounding");
    malformed.cashRoundIQD = "false";
    malformed.payment.amount = "300";
    assert.equal((await call(source, "/sale", malformed)).status, 400,
      "A string false must not silently enable cash rounding");
    assert.deepEqual(await snapshot(source), initial);
    assert.equal(
      (
        await call(
          source,
          "/sale",
          input("cash-log-unavailable"),
          "log-unavailable",
        )
      ).status,
      503,
    );
    assert.deepEqual(await snapshot(source), initial);
    assert.equal(
      (
        await call(
          source,
          "/sale",
          input("cash-only-prepared"),
          "after-prepare",
        )
      ).status,
      503,
    );
    assert.deepEqual(await snapshot(source), initial);
    assert.equal(
      (
        await call(
          source,
          "/sale",
          input("cash-final-sql-fail"),
          "last-statement",
        )
      ).status,
      503,
    );
    assert.deepEqual(await snapshot(source), initial);
    assert.equal(
      (
        await call(
          source,
          "/sale",
          input("cash-primary-pending"),
          "after-primary",
        )
      ).status,
      503,
    );
    const pending = (await call(source, "/operation/cash-primary-pending"))
      .body;
    assert.equal(pending.state, "PRIMARY_COMMITTED_RECOVERY_PENDING");
    assert.equal((await snapshot(source)).invoices.length, 1);
    assert.equal((await call(source, "/recovery-log")).body.records.length, 0);
    // A won primary epoch 2 but has no committed journal entry. B must not
    // acknowledge an epoch-3 plan while its recovery prefix is missing.
    const laterInput = input("cash-later-after-gap");
    let later = await call(source, "/sale", laterInput);
    for (let attempt = 0; later.status !== 200 && attempt < 8; attempt++) {
      assert.ok(
        [
          "RECOVERY_PREFIX_PENDING_RETRY_SAME_REQUEST",
          "STALE_SNAPSHOT_RETRY_SAME_REQUEST",
        ].includes(later.body.code),
        JSON.stringify(later),
      );
      later = await call(source, "/sale", laterInput);
    }
    assert.equal(later.status, 200, JSON.stringify(later));
    const prefix = (await call(source, "/recovery-log")).body.records;
    assert.deepEqual(
      prefix.map((r) => r.epoch),
      [2, 3],
      "B acknowledgement requires the exact durable A -> B prefix",
    );
    const pendingWinner = await db
      .prepare("SELECT planJson FROM cashCommands WHERE requestId=?")
      .bind("cash-primary-pending")
      .first();
    assert.deepEqual(
      prefix[0].plan,
      JSON.parse(pendingWinner.planJson),
      "Repair must copy the original primary winner",
    );
    const recovered = await call(
      source,
      "/sale",
      input("cash-primary-pending"),
    );
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    assert.equal(recovered.body.recoveryAcknowledged, true);
    assert.equal(recovered.body.total, "200.00");
    const stateAfter = await snapshot(source);
    const replay = await call(source, "/sale", input("cash-primary-pending"));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.invoiceId, recovered.body.invoiceId);
    assert.deepEqual(await snapshot(source), stateAfter);
    const changed = input("cash-primary-pending");
    changed.lines[0].quantity = "1";
    changed.payment.amount = "100";
    assert.equal((await call(source, "/sale", changed)).status, 409);
    const dropped = await call(source, "/sale", input("cash-response-lost"), "drop-response");
    assert.equal(dropped.status, 503);
    assert.equal(dropped.primaryReplyLost, true);
    assert.ok(dropped.profile.calls.some(call => call.role === "primary" && call.method === "batch" && !call.ok),
      "An ambiguous successful primary commit must exercise actual winner readback");
    assert.equal(
      (await call(source, "/sale", input("cash-response-lost"))).status,
      200,
    );
    const same = await Promise.all(
      Array.from({ length: 3 }, () =>
        call(source, "/sale", input("cash-concurrent-key")),
      ),
    );
    assert.ok(
      same.every((v) => v.status === 200),
      JSON.stringify(same),
    );
    assert.equal(new Set(same.map((v) => v.body.invoiceId)).size, 1);
    // Hold A's final insert after primary commit. Other finalizers repair the
    // same exact winner concurrently while B remains pending with its saved ID.
    const heldA = call(
      source,
      "/sale",
      input("cash-held-finalizer"),
      "hold-journal",
    ).catch((e) => ({ status: 599, error: e.message }));
    for (
      let i = 0;
      !(await call(source, "/test-hold-state")).body.waiting;
      i++
    ) {
      assert.ok(i < 100, "A must reach held journal append");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const orderedB = input("cash-reordered-later");
    const competitors = await Promise.all(
      Array.from({ length: 2 }, () =>
        call(source, "/sale", orderedB, "delay-prefix"),
      ),
    );
    assert.ok(
      competitors.every(
        (r) =>
          r.status === 409 &&
          r.body.code === "RECOVERY_PREFIX_PENDING_RETRY_SAME_REQUEST",
      ),
      JSON.stringify(competitors),
    );
    assert.equal(
      (await snapshot(source)).invoices.length,
      5,
      "Prefix repair must not execute B",
    );
    await call(source, "/test-release-ack", {});
    assert.equal((await heldA).status, 200);
    const laterReplies = await Promise.all(
      Array.from({ length: 3 }, () => call(source, "/sale", orderedB)),
    );
    assert.ok(
      laterReplies.every((r) => r.status === 200),
      JSON.stringify(laterReplies),
    );
    assert.equal(new Set(laterReplies.map((r) => r.body.invoiceId)).size, 1);
    const worst = input("cash-four-line-rounded");
    worst.cashRoundIQD = true;
    worst.lines = [1, 2, 3, 4].map((id) => ({
      variantId: id,
      productUnitId: id,
      quantity: "1",
    }));
    worst.payment.amount = "500";
    const worstReply = await call(source, "/sale", worst);
    assert.equal(worstReply.status, 200, JSON.stringify(worstReply));
    assert.equal(worstReply.body.total, "500.00");
    const worstSaleQueries = worstReply.queries;
    const beforeRace = (await snapshot(source)).invoices.length;
    const pausedInput = input("cash-preflight-old-primary");
    const paused = call(source, "/sale", pausedInput, "old-primary-new-journal");
    let pausedResult;
    try {
      for (let attempt = 0; ; attempt++) {
        if ((await (await source.dispatchFetch("http://cash.test/test-preflight-state")).json()).waiting) break;
        assert.ok(attempt < 500, "Primary preflight barrier must be reached");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const newer = await call(source, "/sale", input("cash-preflight-newer-winner"));
      assert.equal(newer.status, 200, JSON.stringify(newer));
    } finally {
      await source.dispatchFetch("http://cash.test/test-release-preflight");
      pausedResult = await paused;
    }
    assert.equal(pausedResult.status, 409, JSON.stringify(pausedResult));
    assert.equal(pausedResult.body.code, "STALE_SNAPSHOT_RETRY_SAME_REQUEST");
    assert.equal((await snapshot(source)).invoices.length, beforeRace + 1,
      "An old-primary/new-journal observation must not create an extra sale");
    assert.equal((await call(source, "/sale", pausedInput)).status, 200);
    const records = (await call(source, "/recovery-log")).body.records;
    assert.equal(records.length, 9);
    assert.deepEqual(
      records.map((r) => r.epoch),
      Array.from({length: 9}, (_, i) => i + 2),
    );
    const sourceSnapshot = await snapshot(source);
    await assert.rejects(
      journal
        .prepare("UPDATE cashJournalCommitted SET signature=?")
        .bind("x")
        .run(),
      /IMMUTABLE_JOURNAL/,
    );
    const signedFile = path.join(
      cashRoot,
      "results/signed-local-recovery.json",
    );
    const handle = await open(signedFile, "w");
    try {
      await handle.writeFile(JSON.stringify({ records }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const preparedOnly = await journal
      .prepare(
        "SELECT planHash FROM cashJournalAttempts WHERE requestId=? LIMIT 1",
      )
      .bind("cash-only-prepared")
      .first();
    await assert.rejects(() => journal
      .prepare("INSERT INTO cashJournalCommitted VALUES(?,?,?,?,?)")
      .bind("cash-only-prepared", preparedOnly.planHash, 99, "{}", "x")
      .run(), /RECOVERY_SEQUENCE_GAP/);
    // Even an out-of-band owner disabling append triggers cannot make an
    // invalid prefix exportable. Ordinary journal writes cannot create it.
    await journal.batch([
      journal.prepare('DROP TRIGGER cashJournalCommitted_contiguous'),
      journal.prepare('DROP TRIGGER cashJournalCommitted_advance_head'),
    ]);
    await journal.prepare("INSERT INTO cashJournalCommitted VALUES(?,?,?,?,?)")
      .bind("cash-only-prepared", preparedOnly.planHash, 99, "{}", "x").run();
    const corruptExport = await call(source, "/recovery-log");
    assert.equal(corruptExport.status, 503);
    assert.equal(corruptExport.body.code, "RECOVERY_PREFIX_INVALID");
    await source.dispose();
    sourceDisposed = true;
    const savedRecords = JSON.parse(await readFile(signedFile, "utf8")).records;
    assert.deepEqual(
      savedRecords,
      records,
      "The signed file must preserve all winning plan bytes/fields",
    );
    assert.equal(
      (await call(restore, "/status")).body.journalBindingPresent,
      false,
    );
    const tamper = structuredClone(records[0]);
    tamper.plan.result.total = "0.01";
    const beforeRestore = await snapshot(restore);
    assert.equal(
      (await call(restore, "/restore", { records: [tamper] })).status,
      400,
    );
    assert.deepEqual(await snapshot(restore), beforeRestore);
    assert.equal(
      (await call(restore, "/restore", { records: [records[1]] })).status,
      409,
    );
    assert.deepEqual(await snapshot(restore), beforeRestore);
    assert.equal(
      (await call(restore, "/restore", { records: records.slice(0, 2) }))
        .status,
      400,
    );
    for (const record of savedRecords) {
      const restored = await call(restore, "/restore", { records: [record] });
      assert.equal(
        restored.status,
        200,
        JSON.stringify({ epoch: record.epoch, ...restored }),
      );
    }
    const restoredSnapshot = await snapshot(restore);
    assert.deepEqual(
      restoredSnapshot,
      sourceSnapshot,
      "Every projected source row, id, timestamp, command and outbox must match",
    );
    for (const record of savedRecords) {
      const r = await call(restore, "/restore", { records: [record] });
      assert.equal(r.status, 200);
      assert.equal(r.body.replayed, 1);
    }
    assert.deepEqual(await snapshot(restore), sourceSnapshot);
    assert.deepEqual(outbound, []);
    assert.equal(sourceSnapshot.invoices.length, 9);
    assert.equal(sourceSnapshot.receipts.length, 9);
    assert.equal(sourceSnapshot.inventoryMovements.length, 12);
    assert.equal(sourceSnapshot.accountingEntries.length, 19);
    assert.equal(
      sourceSnapshot.branchStock.find((r) => r.variantId === 1).quantity,
      83,
    );
    assert.ok(normalSaleRpcs.length > 0);
    assert.ok(Math.max(...normalSaleRpcs) <= 9,
      "A successful new cash sale must use at most nine D1 binding calls; observed " + normalSaleRpcs.join(","));
    await mkdir(path.join(cashRoot, "results"), { recursive: true });
    await writeFile(
      path.join(cashRoot, "results/integration.json"),
      JSON.stringify(
        {
          passed: true,
          committedSales: 9,
          restoredSales: 9,
          maxSaleQueries,
          worstSaleQueries,
          normalSaleRpcs,
          sourceDisposedBeforeRestore: true,
          completeSnapshotEquality: true,
          networkAttempts: outbound.length,
          scenarios: [
            "log-unavailable",
            "prepared-only",
            "last-statement-rollback",
            "primary-committed-copy-pending",
            "later-sale-prefix-repair",
            "concurrent-finalizer-reordering",
            "primary-batch-response-lost",
            "old-primary-new-journal-preflight",
            "saved-file-source-unavailable",
            "same-request-replay",
            "changed-payload",
            "response-lost",
            "concurrent-same-key",
            "tamper",
            "sequence-gap",
            "recovery-without-journal-binding",
            "immutable-log",
            "corrupt-prefix-export-refused",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (!sourceDisposed) await source.dispose();
    await restore.dispose();
  }
});
