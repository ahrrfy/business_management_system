import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { connectAccountingOracle } from "./mysql-lab.mjs";
import { validateEvidence } from "./validate.mjs";

test("rejects an unapproved port/root before WSL verification or MySQL connection", async () => {
  const directory = new URL("./results/guard/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const file = new URL("runtime.json", directory);
  const previous = process.env.ACCOUNTING_ORACLE_RUNTIME;
  process.env.ACCOUNTING_ORACLE_RUNTIME = file.pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  try {
    for (const record of [
      { port: 3306, root: "/tmp/erp-d1-returns-actual-wsl-20261019-abcdefgh" },
      { port: 13326, root: "/var/lib/mysql" },
    ]) {
      await writeFile(file, JSON.stringify(record));
      await assert.rejects(connectAccountingOracle(), {
        code: "ERR_ASSERTION",
      });
    }
  } finally {
    if (previous == null) delete process.env.ACCOUNTING_ORACLE_RUNTIME;
    else process.env.ACCOUNTING_ORACLE_RUNTIME = previous;
  }
});

test("captured evidence rejects a one-cent ledger drift", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL("./results/mysql-oracle.json", import.meta.url),
      "utf8",
    ),
  );
  validateEvidence(evidence);
  const scenario = evidence.scenarios.find(
    (s) => s.name === "ACTIVE-cash-partial-full",
  );
  scenario.commands.at(-1).after.journalLines[0].debit = "0.01";
  assert.throws(() => validateEvidence(evidence), { code: "ERR_ASSERTION" });
});
