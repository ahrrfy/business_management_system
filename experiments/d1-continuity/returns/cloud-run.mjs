import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  creditCloudContext,
  verifyCreditResources,
  legacyProof,
} from "../credit/cloud-run.mjs";
import { cashCloudClient } from "../cash/cloud-client.mjs";
import { readPagedSnapshot, canonical } from "../cash/paged-client.mjs";
import { buildReturnsWorker, returnsRoot } from "./build.mjs";
import { fileURLToPath } from "node:url";
export const dir = path.join(returnsRoot, "results/cloud-20261019");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const query = (c, role, command, readOnly = true) =>
  c.invoke(
    [
      "d1",
      "execute",
      c.runtime.databases[role].databaseId,
      "--remote",
      "--command",
      command,
      "--json",
    ],
    true,
    readOnly,
  );
export async function preflight() {
  const c = await creditCloudContext();
  await verifyCreditResources(c);
  await mkdir(dir, { recursive: true });
  const auth = await c.invoke(["whoami"], false, true);
  assert.ok(auth.includes(c.runtime.accountId));
  const legacy = {},
    versions = {};
  for (const role of ["primary", "restore", "journal"])
    legacy[role] = await legacyProof(c, role);
  for (const role of ["primary", "restore"])
    versions[role] = await c.invoke(
      ["deployments", "list", "--name", c.runtime.workers[role], "--json"],
      true,
      true,
    );
  const all = await c.invoke(["d1", "list", "--json"], true, true);
  assert.equal(all.length, 8);
  const call = cashCloudClient(c, () => {}),
    source = await readPagedSnapshot(call, c.source),
    restore = await readPagedSnapshot(call, c.restore);
  assert.deepEqual(source, restore);
  const proof = {
    at: new Date().toISOString(),
    source,
    restore,
    legacy,
    versions,
    databases: all.map((d) => ({ uuid: d.uuid, name: d.name })),
  };
  await writeFile(
    path.join(dir, "before.json"),
    JSON.stringify(proof, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      verified: true,
      epoch: source.epoch,
      databases: all.length,
      legacyTables: Object.values(legacy).reduce(
        (n, p) => n + Object.keys(p.tables ?? {}).length,
        0,
      ),
    }),
  );
  return c;
}
export async function extend() {
  const c = await creditCloudContext();
  await verifyCreditResources(c);
  const before = JSON.parse(
    await readFile(path.join(dir, "before.json"), "utf8"),
  );
  await buildReturnsWorker({
    outfile: path.join(returnsRoot, "build/cloud/worker.mjs"),
  });
  await buildReturnsWorker({
    stdin: "export{default}from'../credit/coordinated-worker';",
    outfile: path.join(returnsRoot, "build/cloud/restore/worker.mjs"),
  });
  const tables = JSON.parse(
    await readFile(path.join(returnsRoot, "build/cloud/tables.json"), "utf8"),
  );
  const old = JSON.parse(
    await readFile(
      path.join(returnsRoot, "../credit/build/cloud/tables.json"),
      "utf8",
    ),
  ).map((t) => t.name);
  const addition = tables.filter((t) => !old.includes(t.name));
  assert.equal(addition.length, 12);
  const indexes = (
    await readFile(path.join(returnsRoot, "build/cloud/schema.sql"), "utf8")
  )
    .split("\n")
    .filter((s) => s.startsWith("CREATE INDEX IF NOT EXISTS returns_"));
  const ddl = addition
    .map((t) => t.ddl.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "))
    .concat(indexes)
    .join("\n");
  assert.ok(!/\b(DROP|DELETE|UPDATE|ALTER|TRUNCATE|REPLACE)\b/i.test(ddl));
  await writeFile(path.join(dir, "additive-schema.sql"), ddl);
  const call = cashCloudClient(c, () => {});
  for (const role of ["primary", "restore"]) {
    const identity = (
      await query(
        c,
        role,
        "SELECT role FROM cashSandboxIdentity WHERE id='actual-credit-20261018'",
      )
    )[0].results[0];
    assert.equal(identity.role, role);
    assert.deepEqual(
      await readPagedSnapshot(
        call,
        c[role === "primary" ? "source" : "restore"],
      ),
      before.source,
    );
    const existing = (
      await query(
        c,
        role,
        "SELECT name,sql FROM sqlite_master WHERE type='table'",
      )
    )[0].results;
    for (const table of addition) {
      const prior = existing.find((t) => t.name === table.name);
      if (prior) {
        assert.equal(
          prior.sql.replace(/\s+/g, " "),
          table.ddl.replace(/;$/, "").replace(/\s+/g, " "),
        );
        assert.equal(
          (
            await query(c, role, "SELECT COUNT(*) n FROM `" + table.name + "`")
          )[0].results[0].n,
          0,
        );
      }
    }
    const file = path.join(c.cwd, "returns-extension-" + role + ".sql");
    await writeFile(file, ddl);
    await c.invoke(
      [
        "d1",
        "execute",
        c.runtime.databases[role].databaseId,
        "--remote",
        "--file",
        file,
        "--json",
      ],
      true,
      false,
    );
    assert.deepEqual(
      await readPagedSnapshot(
        call,
        c[role === "primary" ? "source" : "restore"],
      ),
      before.source,
    );
    const checks = await query(
      c,
      role,
      addition.map((t) => "SELECT COUNT(*) n FROM `" + t.name + "`").join(";"),
    );
    assert.ok(checks.every((r) => r.results[0].n === 0));
  }
  await writeFile(
    path.join(dir, "extension.json"),
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        retainedEpoch: before.source.epoch,
        addedTables: addition.map((t) => t.name),
        schemaSha256: sha(ddl),
        oldFinancialRowsUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      extended: true,
      addedTables: addition.length,
      epoch: before.source.epoch,
    }),
  );
}
export async function deploy() {
  const c = await creditCloudContext();
  await verifyCreditResources(c);
  const extension = JSON.parse(
    await readFile(path.join(dir, "extension.json"), "utf8"),
  );
  assert.equal(extension.passed, true);
  const result = {
    at: new Date().toISOString(),
    workers: {},
    newD1Databases: 0,
    newWorkers: 0,
    planUpgrade: false,
  };
  // Recovery must understand the new signed effects before the writer can emit them.
  for (const role of ["restore", "primary"]) {
    const auth = await c.invoke(["whoami"], false, true);
    assert.ok(auth.includes(c.runtime.accountId));
    const config = JSON.parse(
      await readFile(path.join(c.cwd, "credit-" + role + ".json"), "utf8"),
    );
    assert.equal(config.name, c.runtime.workers[role]);
    assert.equal(config.account_id, c.runtime.accountId);
    assert.equal(
      config.d1_databases[0].database_id,
      c.runtime.databases[role].databaseId,
    );
    assert.equal(config.d1_databases.length, role === "primary" ? 2 : 1);
    if (role === "primary") {
      assert.equal(
        config.d1_databases[1].database_id,
        c.runtime.databases.journal.databaseId,
      );
      assert.deepEqual(config.durable_objects.bindings, [
        { name: "CREDIT_WRITER", class_name: "CreditWriter" },
      ]);
    } else assert.equal(config.durable_objects, undefined);
    config.main = path.join(
      returnsRoot,
      "build/cloud",
      role === "primary" ? "worker.mjs" : "restore/worker.mjs",
    );
    config.vars = {
      ...config.vars,
      CONTINUITY_SCOPE: "ORIGINAL_STOCKED_CASH_CREDIT_COLLECTION_AND_RETURNS",
    };
    const file = path.join(c.cwd, "returns-" + role + ".json");
    await writeFile(file, JSON.stringify(config, null, 2));
    await c.invoke(["deploy", "--config", file, "--no-bundle"]);
    const versions = await c.invoke(
        ["deployments", "list", "--name", config.name, "--json"],
        true,
        true,
      ),
      active = [...versions]
        .sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on))
        .at(-1);
    assert.equal(active.versions.length, 1);
    assert.equal(active.versions[0].percentage, 100);
    result.workers[role] = {
      name: config.name,
      url: c[role === "primary" ? "source" : "restore"],
      version: active.versions[0].version_id,
      bundleSha256: sha(await readFile(config.main)),
      journalBinding: role === "primary",
      writerBinding: role === "primary",
    };
    console.log(JSON.stringify(result.workers[role]));
  }
  await writeFile(
    path.join(dir, "deploy.json"),
    JSON.stringify(result, null, 2),
  );
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  assert.equal(process.argv[3], "--confirm-isolated-returns-lab");
  const action = process.argv[2];
  assert.ok(["--preflight", "--extend", "--deploy"].includes(action));
  await { "--preflight": preflight, "--extend": extend, "--deploy": deploy }[
    action
  ]();
}
