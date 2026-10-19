import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import {
  readPagedSnapshot,
  exportPagedJournal,
  journalFileRecords,
} from "../cash/paged-client.mjs";
import { setupLab, wire, compareGraph } from "./native-support.mjs";
import { resultRoot, creditIdentity, namespaceEnabled } from "./native.mjs";
const larger = JSON.parse(
  await readFile(
    new URL("./results/larger/mysql-oracle.json", import.meta.url),
    "utf8",
  ),
).scenarios[0];
test("larger source invoice retains safe30-row gate and explicit native64 candidate", async () => {
  const evidence = [];
  for (const candidate of [false, true]) {
    const l = await setupLab(
      candidate ? "larger-candidate64" : "larger-default30",
      { candidate },
    );
    let sourceOff = false;
    try {
      await l.seed(larger.commands[0].before);
      if (candidate) await l.seed(larger.commands[0].before, l.rd);
      for (const [index, cmd] of larger.commands.entries()) {
        const input = wire(cmd.input),
          before = await l.graph();
        const r = await l.call(l.source, index ? "/return" : "/sale", input);
        evidence.push({
          candidate,
          index,
          status: r.status,
          body: r.body,
          profile: r.profile,
        });
        if (!candidate && r.status !== 200) {
          assert.equal(
            r.body.code,
            "CREDIT_INVOCATION_BUDGET_EXCEEDED",
            JSON.stringify(r),
          );
          compareGraph(
            await l.graph(),
            before,
            "safe rejection zero financial effects",
            l.tables,
          );
          assert.equal(index, 2, "ordinary initial+partial should fit default");
          break;
        }
        assert.equal(r.status, 200, JSON.stringify(r));
        compareGraph(await l.graph(), cmd.after, "larger " + index, l.tables);
        assert.ok(r.profile.sqlCount <= 48);
        const saved = await l.db
          .prepare("SELECT planJson FROM cashCommands WHERE requestId=?")
          .bind(input.clientRequestId)
          .first();
        const plan = JSON.parse(saved.planJson);
        evidence.at(-1).changedRows = plan.changes.length;
        assert.ok(plan.changes.length <= (candidate ? 64 : 30));
      }
      if (candidate) {
        const snapshot = await readPagedSnapshot(l.call, l.source);
        const file =
          resultRoot + "/native-larger-signed-" + Date.now() + ".ndjson";
        const identity = {
          labId: creditIdentity.labId,
          schemaVersion: namespaceEnabled
            ? "actual-accounting-q1-namespace-candidate64-v1"
            : "actual-accounting-q1-native-candidate64-v1",
        };
        const exported = await exportPagedJournal(
          (target, route, input) =>
            l.call(target, "/journal-only" + route, input),
          l.source,
          file,
          l.secret,
          {
            snapshotSha256: snapshot.sha256,
            snapshotEpoch: snapshot.epoch,
            identity,
          },
        );
        const records = [];
        for await (const record of journalFileRecords(file, l.secret, identity))
          records.push(record);
        await l.freezeLegacySource();
        await l.source.dispose();
        sourceOff = true;
        for (const record of records)
          await l.ok(l.restore, "/restore", { records: [record] });
        assert.deepEqual(await readPagedSnapshot(l.call, l.restore), snapshot);
        await l.verifyLegacy();
        evidence.push({
          candidate,
          signedColdRestore: true,
          pageBytes: l.pageBytes,
          snapshot,
          exported,
        });
      }
      assert.equal(l.outbound.length, 0);
    } finally {
      if (!sourceOff) {
        await l.verifyLegacy();
        await l.source.dispose();
      }
      await l.restore.dispose();
      await writeFile(
        resultRoot + "/native-larger.json",
        JSON.stringify(evidence, null, 2),
      );
    }
  }
});
