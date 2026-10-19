import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { connectDigitalOracle } from "./mysql-lab.mjs";
import { SyntheticProvider } from "./provider.mjs";
import { validateEvidence } from "./validate.mjs";
const dir = new URL("./results/tests-" + Date.now() + "/", import.meta.url);
await mkdir(dir, { recursive: true });
test("invalid port/datadir refuses before WSL or MySQL", async () => {
  const file = new URL("runtime.json", dir),
    previous = process.env.ACCOUNTING_ORACLE_RUNTIME;
  process.env.ACCOUNTING_ORACLE_RUNTIME = fileURLToPath(file);
  try {
    for (const record of [
      { port: 3306, root: "/tmp/erp-d1-returns-actual-wsl-20261019-abcdefgh" },
      { port: 13326, root: "/var/lib/mysql" },
    ]) {
      await writeFile(file, JSON.stringify(record));
      await assert.rejects(connectDigitalOracle(), { code: "ERR_ASSERTION" });
    }
  } finally {
    if (previous == null) delete process.env.ACCOUNTING_ORACLE_RUNTIME;
    else process.env.ACCOUNTING_ORACLE_RUNTIME = previous;
  }
});
test("network guards refuse fetch, HTTP and socket before dispatch", () => {
  const source = `import assert from 'node:assert/strict';import http from 'node:http';import net from 'node:net';import{blockExternalEffects}from'./experiments/d1-continuity/digital/network.mjs';const attempts=blockExternalEffects();await assert.rejects(fetch('https://synthetic.invalid'));assert.throws(()=>http.get('http://synthetic.invalid'));assert.throws(()=>net.connect({host:'192.0.2.1',port:443}));assert.equal(attempts.length,3);console.log('3 blocked before dispatch');`;
  assert.match(
    execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      windowsHide: true,
    }),
    /3 blocked/,
  );
});
test("durable synthetic key survives lost response, restart and concurrent replay", async () => {
  const file = fileURLToPath(new URL("provider.ndjson", dir)),
    p = new SyntheticProvider(file);
  const request = {
    synthetic: true,
    namespace: "unit",
    providerIdempotencyKey: "digital-issue:1:1",
    providerReference: "Q2-UNIT-ONLY",
  };
  await assert.rejects(
    p.issue(request, { loseResponse: true }),
    /SYNTHETIC_PROVIDER_RESPONSE_LOST/,
  );
  const restart = new SyntheticProvider(file);
  const replay = await Promise.all([
    restart.issue(request),
    restart.issue(request),
  ]);
  assert.ok(replay.every((r) => r.replay));
  const rows = await restart.rows();
  assert.equal(rows.filter((r) => r.event === "ISSUED").length, 1);
  assert.equal(rows.length, 3);
  await assert.rejects(
    restart.issue({ ...request, providerReference: "changed" }),
    /payload conflict/,
  );
});
test("one-cent money/evidence/provider tampering is rejected", async () => {
  const latest = JSON.parse(
    await readFile(
      "experiments/d1-continuity/digital/results/latest.json",
      "utf8",
    ),
  );
  const original = JSON.parse(
    await readFile(latest.out + "/oracle.json", "utf8"),
  );
  assert.equal(original.status, "DONE_WITH_CONCERNS");
  validateEvidence(original);
  for (const mutate of [
    (e) => {
      e.scenarios[0].commands.at(-1).after.journalLines[0].debit = "0.01";
    },
    (e) => {
      e.scenarios[0].commands.at(
        -1,
      ).after.digitalSaleDetails[0].providerShareSnapshot = "0.01";
    },
    (e) => {
      e.scenarios[0].commands.at(
        -1,
      ).after.accountingEntries[0].postingIntentHash = "0".repeat(64);
    },
    (e) => {
      e.providerLedger.push(e.providerLedger.find((r) => r.event === "ISSUED"));
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateEvidence(changed));
  }
});
