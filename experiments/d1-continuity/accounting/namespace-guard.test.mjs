import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setupLab, oracle, wire } from "./native-support.mjs";
import { resultRoot } from "./native.mjs";
test("missing new journal guard cannot be masked by six legacy guards", async () => {
  const l = await setupLab("guard-collision", {
    namespace: true,
    coordinated: true,
  });
  try {
    const restoreRows = async () => {
      const names = (
        await l.rawRestore
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,5)='q1gl_' ORDER BY name",
          )
          .all()
      ).results.map((r) => r.name);
      return l.rawRestore.batch([
        ...names.map((name) =>
          l.rawRestore.prepare('SELECT * FROM "' + name + '"'),
        ),
        l.rawRestore.prepare(
          "SELECT name,seq FROM sqlite_sequence WHERE substr(name,1,5)='q1gl_' ORDER BY name",
        ),
      ]);
    };
    assert.equal(l.legacyRecords.length, 1);
    assert.equal(l.legacyRecords[0].labId, "actual-accounting-q1-native");
    const beforeCross = await restoreRows();
    const crossLog = await l.call(l.restore, "/restore", {
      records: l.legacyRecords,
    });
    assert.equal(crossLog.status, 400);
    assert.equal(crossLog.body.code, "INVALID_RECOVERY_RECORD");
    const afterCross = await restoreRows();
    assert.deepEqual(
      afterCross.map((r) => r.results),
      beforeCross.map((r) => r.results),
    );
    const scenario = oracle.scenarios.find(
      (s) => s.name === "ACTIVE-cash-partial-full",
    );
    await l.seed(scenario.commands[0].before);
    const input = wire(scenario.commands[0].input);
    const original = await l.ok(l.source, "/sale", input);
    const replay = await l.ok(l.source, "/sale", input, "", "", "", true);
    assert.equal(replay.confirmedRead, true);
    assert.equal(replay.body.invoiceId, original.body.invoiceId);
    const changed = await l.call(
      l.source,
      "/sale",
      { ...input, customerId: 5 },
      "",
      "",
      "",
      true,
    );
    assert.equal(changed.status, 409);
    const plan = JSON.parse(
      (
        await l.db
          .prepare("SELECT planJson FROM cashCommands WHERE requestId=?")
          .bind(input.clientRequestId)
          .first()
      ).planJson,
    );
    assert.ok(plan.changes.every((c) => !c.table.startsWith("q1gl_")));
    const before = await l.graph(),
      journalBefore = (
        await l.journal.prepare("SELECT * FROM cashJournalRequests").all()
      ).results;
    const legacyGuards = (
      await l.rawJournal
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN('cashJournalCommitted_no_update','cashJournalCommitted_no_delete','cashJournalCommitted_contiguous','cashJournalCommitted_advance_head','cashJournalHead_guard','cashJournalHead_no_delete')",
        )
        .all()
    ).results;
    assert.equal(legacyGuards.length, 6);
    await l.rawJournal.prepare("DROP TRIGGER q1gl_cashJournalHead_guard").run();
    const refusal = await l.call(l.source, "/sale", {
      ...input,
      clientRequestId: "q1-new-missing-guard",
    });
    assert.notEqual(refusal.status, 200);
    assert.equal(refusal.body.code, "RECOVERY_PREFIX_INVALID");
    const exportRefusal = await l.call(l.source, "/journal-only/recovery-log");
    assert.notEqual(exportRefusal.status, 200);
    assert.deepEqual(await l.graph(), before);
    assert.deepEqual(
      (await l.journal.prepare("SELECT * FROM cashJournalRequests").all())
        .results,
      journalBefore,
    );
    await l.verifyLegacy();
    assert.equal(l.outbound.length, 0);
    await writeFile(
      resultRoot + "/native-guard.json",
      JSON.stringify(
        {
          legacyGuards: legacyGuards.length,
          oldSignedLabId: l.legacyRecords[0].labId,
          crossLog,
          crossLogFullRowsUnchanged: true,
          dropped: "q1gl_cashJournalHead_guard",
          refusal,
          exportRefusal,
          logicalPlanTables: plan.changes.map((c) => c.table),
          outboundAttempts: l.outbound.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await l.close();
  }
});
