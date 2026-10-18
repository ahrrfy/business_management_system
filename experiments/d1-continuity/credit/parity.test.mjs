import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeLab } from "./native.mjs";
import { creditRoot } from "./build.mjs";
test("original MySQL8 credit and collections match native D1 financial rows", async () => {
  const oracle = JSON.parse(
      await readFile(
        path.join(creditRoot, "results/mysql-oracle.json"),
        "utf8",
      ),
    ),
    proofs = [];
  for (const scenario of oracle.scenarios) {
    const l = await nativeLab({ name: "parity-" + scenario.name });
    try {
      for (const sql of scenario.setup) await l.db.prepare(sql).run();
      const metadata = JSON.parse(
        await readFile(path.join(l.buildDir, "tables.json"), "utf8"),
      );
      const normalized = (rows, name) => {
        const meta = metadata.find((t) => t.name === name);
        return rows
          .map((row) =>
            Object.fromEntries(
              meta.columns.map((c) => {
                let v = row[c.name];
                if (v != null && /date|time/i.test(c.sqlType)) {
                  const s = String(v),
                    d = new Date(
                      s.includes("T") ? s : s.replace(" ", "T") + "Z",
                    );
                  assert.ok(Number.isFinite(d.getTime()));
                  v =
                    d.toISOString().slice(0, 10) +
                    (d.toISOString().slice(11, 23) === "00:00:00.000"
                      ? ":FIXTURE_MIDNIGHT"
                      : ":COMMAND_TIME");
                } else if (v != null && c.sqlType === "json")
                  v = typeof v === "string" ? JSON.parse(v) : v;
                return [c.name, v ?? null];
              }),
            ),
          )
          .sort((a, b) =>
            JSON.stringify(meta.primary.map((k) => a[k])).localeCompare(
              JSON.stringify(meta.primary.map((k) => b[k])),
            ),
          );
      };
      for (const command of scenario.commands) {
        const r = await l.call(
          l.source,
          command.input.commandType === "SALE" ? "/sale" : "/payment",
          command.input,
        );
        if (command.error) {
          assert.equal(r.body.code, command.error.code);
          assert.notEqual(r.status, 200);
        } else {
          assert.equal(r.status, 200, JSON.stringify(r.body));
          for (const [k, v] of Object.entries(command.result))
            assert.deepEqual(r.body[k], v, scenario.name + " result " + k);
        }
        for (const [name, rows] of Object.entries(command.tables)) {
          const actual = (
            await l.db.prepare("SELECT * FROM `" + name + "`").all()
          ).results;
          assert.deepEqual(
            normalized(actual, name),
            normalized(rows, name),
            scenario.name + " " + command.input.commandType + " " + name,
          );
        }
        for (const row of (
          await l.db.prepare("SELECT entryDate FROM accountingEntries").all()
        ).results)
          assert.match(row.entryDate, /^\d{4}-\d{2}-\d{2}$/);
      }
      proofs.push({
        name: scenario.name,
        commands: scenario.commands.length,
        tablesCompared: 11,
      });
    } finally {
      await l.close();
    }
  }
  await writeFile(
    path.join(creditRoot, "results/mysql-parity.json"),
    JSON.stringify(
      {
        passed: true,
        verifiedServer: oracle.verifiedServer,
        proofs,
        timestamps:
          "UTC day and deterministic fixture/command distinction; all money, ids, links, statuses, quantities and JSON exact",
      },
      null,
      2,
    ),
  );
});
