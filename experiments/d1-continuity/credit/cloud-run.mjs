import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCreditWorker, creditRoot } from "./build.mjs";
import { canonical } from "../cash/paged-client.mjs";
const repo = path.resolve(creditRoot, "../../.."),
  record = path.join(repo, ".superpowers/sdd/credit-cloud-runtime.json"),
  secretFile = path.join(repo, ".superpowers/sdd/credit-test-secret.json"),
  exec = promisify(execFile),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const approved = {
  primary: {
    name: "erp-d1-poc-20261017-c60ca2",
    databaseId: "9594cf92-a2aa-49ea-8f75-e15d5cb88d3b",
    prefix: "lab_",
  },
  restore: {
    name: "erp-d1-poc-20261017-887100",
    databaseId: "90a4dd83-614f-42ad-b9f7-43ec8c411843",
    prefix: "lab_",
  },
  journal: {
    name: "erp-edge-poc-20261017-e19867-journal",
    databaseId: "e4df50d4-88fd-404a-a16f-22ade4624900",
    prefix: "edge_",
  },
};
const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {}
  for (const m of s.matchAll(/^[\[{]/gm)) {
    try {
      return JSON.parse(s.slice(m.index));
    } catch {}
  }
  throw Error("INCOMPLETE_CLI_JSON");
};
export async function creditCloudContext({ create = false } = {}) {
  // Reuse only the verified CLI installation/session. Credit never needs the
  // previous cash lab's signing secret to initialize, operate or recover.
  const base = {
    runtime: JSON.parse(
      await readFile(
        path.join(repo, ".superpowers/sdd/cash-runtime.json"),
        "utf8",
      ),
    ),
  };
  assert.equal(base.runtime.accountId, "d4a91e89f1fe496f6a3d7f18dee6938c");
  assert.equal(base.runtime.subdomain, "alarabiya2017");
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(path.dirname(base.runtime.cli), "../package.json"),
        "utf8",
      ),
    ).version,
    "4.151.1",
  );
  let runtime, secret;
  const state = await Promise.allSettled([
    readFile(record, "utf8"),
    readFile(secretFile, "utf8"),
  ]);
  for (const item of state)
    if (item.status === "rejected" && item.reason.code !== "ENOENT")
      throw item.reason;
  if (state.every((item) => item.status === "fulfilled")) {
    runtime = JSON.parse(state[0].value);
    secret = JSON.parse(state[1].value).token;
  } else {
    if (!create || state.some((item) => item.status === "fulfilled"))
      throw Error(
        "CREDIT_PRIVATE_STATE_INCOMPLETE_RESTORE_ORIGINAL_RUNTIME_AND_SECRET",
      );
    const suffix = randomBytes(3).toString("hex");
    secret = randomBytes(32).toString("hex");
    runtime = {
      accountId: base.runtime.accountId,
      subdomain: base.runtime.subdomain,
      suffix,
      workers: {
        primary: "erp-credit-poc-20261018-" + suffix,
        restore: "erp-credit-poc-20261018-" + suffix + "-restore",
      },
      databases: approved,
      createdAt: new Date().toISOString(),
      initialized: [],
    };
    await writeFile(secretFile, JSON.stringify({ token: secret }), {
      flag: "wx",
    });
    await writeFile(record, JSON.stringify(runtime, null, 2), { flag: "wx" });
  }
  assert.equal(runtime.accountId, "d4a91e89f1fe496f6a3d7f18dee6938c");
  assert.equal(runtime.subdomain, "alarabiya2017");
  assert.match(runtime.suffix, /^[a-f0-9]{6}$/);
  assert.ok(secret.length >= 40);
  for (const role of ["primary", "restore", "journal"])
    assert.deepEqual(runtime.databases[role], approved[role]);
  for (const role of ["primary", "restore"])
    assert.equal(
      runtime.workers[role],
      "erp-credit-poc-20261018-" +
        runtime.suffix +
        (role === "restore" ? "-restore" : ""),
    );
  const env = {};
  for (const k of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "COMSPEC",
    "PATHEXT",
  ])
    if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    CLOUDFLARE_ACCOUNT_ID: runtime.accountId,
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_SEND_METRICS: "false",
  });
  const invoke = async (args, parse = false, readOnly = false) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await exec(
          process.execPath,
          ["--dns-result-order=ipv4first", base.runtime.cli, ...args],
          {
            cwd: base.runtime.cwd,
            env,
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 8388608,
          },
        );
        return parse ? json(r.stdout) : r.stdout;
      } catch (e) {
        await writeFile(
          path.join(repo, ".superpowers/sdd/credit-cli-error.json"),
          JSON.stringify({
            at: new Date().toISOString(),
            action: args[0],
            code: e.code,
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? "",
          }),
        );
        if (
          !readOnly ||
          attempt >= 2 ||
          ![e.stderr, e.stdout].some((output) =>
            String(output).includes("fetch failed"),
          )
        )
          throw Error("CREDIT_CLI_FAILED_SEE_PRIVATE_EVIDENCE_" + args[0]);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  const save = () => writeFile(record, JSON.stringify(runtime, null, 2));
  return {
    runtime,
    secret,
    invoke,
    save,
    cwd: base.runtime.cwd,
    source:
      "https://" +
      runtime.workers.primary +
      "." +
      runtime.subdomain +
      ".workers.dev",
    restore:
      "https://" +
      runtime.workers.restore +
      "." +
      runtime.subdomain +
      ".workers.dev",
  };
}
async function sql(c, role, command) {
  return c.invoke(
    [
      "d1",
      "execute",
      approved[role].databaseId,
      "--remote",
      "--command",
      command,
      "--json",
    ],
    true,
    true,
  );
}
export async function legacyProof(c, role) {
  const prefix = approved[role].prefix,
    objects = (
      await sql(
        c,
        role,
        "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
    )[0].results,
    legacy = objects.filter((r) => r.tbl_name.startsWith(prefix)),
    names = legacy
      .filter((r) => r.type === "table")
      .map((r) => r.name)
      .sort();
  assert.ok(names.length);
  const rows = await sql(
    c,
    role,
    names
      .map((n) => {
        assert.match(n, /^\w+$/);
        return "SELECT * FROM `" + n + "`;";
      })
      .join("\n"),
  );
  assert.equal(rows.length, names.length);
  return {
    objectHash: hash(canonical(legacy)),
    tables: Object.fromEntries(
      names.map((n, i) => [
        n,
        {
          count: rows[i].results.length,
          sha256: hash(canonical(rows[i].results.map(canonical).sort())),
        },
      ]),
    ),
  };
}
export async function verifyCreditResources(c) {
  for (const [role, a] of Object.entries(approved)) {
    const info = await c.invoke(
      ["d1", "info", a.databaseId, "--json"],
      true,
      true,
    );
    assert.equal(info.uuid, a.databaseId);
    assert.equal(info.name, a.name);
    assert.ok(info.created_at.startsWith("2026-10-17"));
    const prior = c.runtime.resourceCreatedAt?.[role];
    if (prior) assert.equal(info.created_at, prior);
    else (c.runtime.resourceCreatedAt ??= {})[role] = info.created_at;
  }
  await c.save();
}
async function preflight(c) {
  assert.equal(c.runtime.initialized.length, 0);
  await verifyCreditResources(c);
  const proofs = {};
  for (const role of ["primary", "restore", "journal"]) {
    const all = (
      await sql(
        c,
        role,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
    )[0].results;
    assert.ok(
      all.every((r) => r.name.startsWith(approved[role].prefix)),
      "Existing original-name tables; refuse adoption",
    );
    proofs[role] = await legacyProof(c, role);
  }
  await mkdir(path.join(creditRoot, "results"), { recursive: true });
  await writeFile(
    path.join(creditRoot, "results/legacy-before.json"),
    JSON.stringify(proofs, null, 2),
    { flag: "wx" },
  );
  c.runtime.preflightAt = new Date().toISOString();
  await c.save();
  console.log(
    JSON.stringify({
      verifiedResources: 3,
      legacyTables: Object.fromEntries(
        Object.entries(proofs).map(([r, p]) => [
          r,
          Object.keys(p.tables).length,
        ]),
      ),
      newD1Databases: 0,
      planUpgrade: false,
    }),
  );
}
async function initialize(c) {
  assert.ok(c.runtime.preflightAt);
  await verifyCreditResources(c);
  const before = JSON.parse(
    await readFile(path.join(creditRoot, "results/legacy-before.json"), "utf8"),
  );
  for (const role of ["primary", "restore", "journal"]) {
    assert.deepEqual(await legacyProof(c, role), before[role]);
    if (c.runtime.initialized.includes(role)) continue;
    const all = (
      await sql(
        c,
        role,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
    )[0].results;
    assert.ok(
      all.every((r) => r.name.startsWith(approved[role].prefix)),
      "Unknown previous initialization result: inspect and verify exact schema/fixture before continuing",
    );
    const dir = path.join(creditRoot, "build/cloud"),
      body =
        role === "journal"
          ? await readFile(path.join(dir, "journal.sql"), "utf8")
          : (await readFile(path.join(dir, "schema.sql"), "utf8")) +
            "\n" +
            (await readFile(path.join(dir, "fixture.sql"), "utf8")) +
            `\nCREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL);INSERT INTO cashSandboxIdentity VALUES('actual-credit-20261018','${role}');`;
    assert.ok(!/\b(?:DROP|ALTER|TRUNCATE)\b/i.test(body));
    const file = path.join(c.cwd, "credit-init-" + role + ".sql");
    await writeFile(file, body);
    await c.invoke(
      [
        "d1",
        "execute",
        approved[role].databaseId,
        "--remote",
        "--file",
        file,
        "--yes",
        "--json",
      ],
      true,
    );
    c.runtime.initialized.push(role);
    await c.save();
    console.log(JSON.stringify({ initialized: role, sqlSha256: hash(body) }));
  }
}
async function deploy(c) {
  assert.equal(c.runtime.initialized.length, 3);
  await verifyCreditResources(c);
  const evidence = {
    at: new Date().toISOString(),
    workers: {},
    newD1Databases: 0,
    planUpgrade: false,
  };
  const secrets = path.join(c.cwd, "credit-lab-secret.json");
  await writeFile(secrets, JSON.stringify({ LAB_TOKEN: c.secret }));
  try {
    for (const role of ["primary", "restore"]) {
      const name = c.runtime.workers[role],
        db = approved[role],
        main = path.join(
          creditRoot,
          "build/cloud",
          role === "primary" ? "worker.mjs" : "restore/worker.mjs",
        );
      const config = {
        name,
        account_id: c.runtime.accountId,
        main,
        compatibility_date: "2026-08-01",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        preview_urls: false,
        observability: { enabled: false },
        vars: {
          ...(c.runtime.multiCashierFixtureAt
            ? { CREDIT_MULTI_CASHIER_LAB: "1" }
            : {}),
          CREDIT_PIPELINE: c.runtime.creditPipeline === false ? "0" : "1",
        },
        find_additional_modules: true,
        rules: [
          { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true },
        ],
        d1_databases: [
          { binding: "DB", database_name: db.name, database_id: db.databaseId },
          ...(role === "primary"
            ? [
                {
                  binding: "RECOVERY_LOG",
                  database_name: approved.journal.name,
                  database_id: approved.journal.databaseId,
                },
              ]
            : []),
        ],
        ...(role === "primary"
          ? {
              durable_objects: {
                bindings: [
                  { name: "CREDIT_WRITER", class_name: "CreditWriter" },
                ],
              },
              migrations: [
                {
                  tag: "credit-writer-sqlite-v1",
                  new_sqlite_classes: ["CreditWriter"],
                },
              ],
            }
          : {}),
      };
      const file = path.join(c.cwd, "credit-" + role + ".json");
      await writeFile(file, JSON.stringify(config, null, 2));
      await c.invoke(["deploy", "--config", file, "--no-bundle"]);
      await c.invoke(["secret", "bulk", secrets, "--config", file]);
      const list = await c.invoke(
          ["deployments", "list", "--name", name, "--json"],
          true,
          true,
        ),
        active = [...list]
          .sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on))
          .at(-1);
      assert.equal(active.versions.length, 1);
      assert.equal(active.versions[0].percentage, 100);
      evidence.workers[role] = {
        name,
        url: c[role === "primary" ? "source" : "restore"],
        version: active.versions[0].version_id,
        bundleSha256: hash(await readFile(main)),
        journalBinding: role === "primary",
        writerBinding: role === "primary",
      };
      console.log(
        JSON.stringify({ deployed: role, ...evidence.workers[role] }),
      );
    }
  } finally {
    await unlink(secrets);
  }
  await writeFile(
    path.join(creditRoot, "results/deploy.json"),
    JSON.stringify(evidence, null, 2),
  );
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const action = process.argv[2];
  assert.ok(
    [
      "--build",
      "--preflight",
      "--initialize",
      "--deploy",
      "--verify-legacy",
    ].includes(action),
  );
  if (action === "--build") {
    await buildCreditWorker({
      entry: path.join(creditRoot, "coordinated-worker.ts"),
      outfile: path.join(creditRoot, "build/cloud/worker.mjs"),
    });
    await buildCreditWorker({
      stdin: "export{default}from'./coordinated-worker';",
      outfile: path.join(creditRoot, "build/cloud/restore/worker.mjs"),
    });
  } else {
    assert.equal(process.argv[3], "--confirm-isolated-credit-lab");
    const c = await creditCloudContext({ create: action === "--preflight" });
    if (action === "--preflight") await preflight(c);
    else if (action === "--initialize") await initialize(c);
    else if (action === "--deploy") await deploy(c);
    else {
      const before = JSON.parse(
          await readFile(
            path.join(creditRoot, "results/legacy-before.json"),
            "utf8",
          ),
        ),
        after = {};
      for (const role of ["primary", "restore", "journal"]) {
        after[role] = await legacyProof(c, role);
        assert.deepEqual(after[role], before[role]);
      }
      await writeFile(
        path.join(creditRoot, "results/legacy-after.json"),
        JSON.stringify({ passed: true, proofs: after }, null, 2),
      );
      console.log(
        "All original feasibility and edge-journal legacy tables/objects/rows unchanged",
      );
    }
  }
}
