import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mockInstalledHelperOwner } from "./installed-helper-fixture.mjs";
import {
  assertWorkerAttestations,
  classifyErpProcesses,
  createLinuxActivationOperations,
  hashFile,
  readProcessIdentity,
  withInventoryConnectionDeadline,
} from "./inventory-activation-host.mjs";

test("an unresolved database operation destroys its exact connection without reconnect", async () => {
  let destroyed = 0;
  const connection = withInventoryConnectionDeadline(
    {
      query: () => new Promise(() => {}),
      destroy: () => {
        destroyed++;
      },
    },
    10,
  );
  await assert.rejects(connection.query("SELECT 1"), /OPERATION_TIMEOUT/);
  assert.equal(destroyed, 1);
});
import {
  CAPABILITY,
  writeActivationJournal,
} from "./inventory-activation-fence.mjs";
import { assertInventoryResurrection } from "../../deploy/systemd/pm2-systemd-start.mjs";

const root = path.resolve("erp-fixture");
const processes = [
  { pid: 10, parent: 2, startTime: "555", uid: 1000, state: "S" },
];
const row = {
  name: "erp-server",
  pm_id: 0,
  pid: 10,
  pm2_env: { pm_cwd: root, pm_exec_path: path.join(root, "index.js") },
};
test("ownership classification preserves unrelated apps and rejects ambiguous ERP labels", () => {
  const unrelated = {
    name: "other-company",
    pm_id: 5,
    pid: 77,
    pm2_env: {
      pm_cwd: path.resolve("other"),
      pm_exec_path: path.resolve("other/index.js"),
    },
  };
  assert.equal(
    classifyErpProcesses([row, unrelated], root, processes, 1000).length,
    1,
  );
  assert.throws(
    () =>
      classifyErpProcesses(
        [{ ...row, pm2_env: unrelated.pm2_env }],
        root,
        processes,
        1000,
      ),
    /OWNERSHIP/,
  );
  assert.throws(
    () =>
      classifyErpProcesses(
        [{ ...row, name: "unknown-writer" }],
        root,
        processes,
        1000,
      ),
    /UNKNOWN/,
  );
  assert.throws(
    () =>
      classifyErpProcesses([row], root, [{ ...processes[0], uid: 999 }], 1000),
    /IDENTITY/,
  );
});
test("per-PID proof rejects missing, duplicate, wrong DB, capability, start identity and bundle", () => {
  const artifact = {
    name: "erp-server",
    bundle: path.join(root, "index.js"),
    hash: "a".repeat(64),
    instances: 1,
  };
  const journal = { id: "activation", database: "erp", serverUuid: "uuid" };
  const reply = {
    pid: 10,
    startTime: "555",
    name: artifact.name,
    bundle: artifact.bundle,
    hash: artifact.hash,
    capability: CAPABILITY,
    activationId: journal.id,
    database: journal.database,
    serverUuid: journal.serverUuid,
    held: true,
  };
  assertWorkerAttestations([artifact], processes, [reply], journal);
  for (const change of [
    { startTime: "old" },
    { database: "other" },
    { serverUuid: "other" },
    { hash: "b".repeat(64) },
    { capability: "from-env" },
    { held: false },
    { pid: 20 },
  ])
    assert.throws(() =>
      assertWorkerAttestations(
        [artifact],
        processes,
        [{ ...reply, ...change }],
        journal,
      ),
    );
  assert.throws(() =>
    assertWorkerAttestations([artifact], processes, [], journal),
  );
  assert.throws(() =>
    assertWorkerAttestations(
      [{ ...artifact, instances: 2 }],
      [processes[0], { ...processes[0], pid: 11 }],
      [reply, reply],
      journal,
    ),
  );
});
test("Linux process identity includes kernel start time, not PM2 online label", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-proc-"));
  try {
    const dir = path.join(temp, "10");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "stat"),
      `10 (name with spaces) S 2 ${Array(17).fill("0").join(" ")} 999 0\n`,
    );
    fs.writeFileSync(
      path.join(dir, "status"),
      "Uid:\t1000\t1000\t1000\t1000\n",
    );
    assert.equal(readProcessIdentity(10, temp).startTime, "999");
    assert.equal(readProcessIdentity(11, temp), null);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});
test("installed boot guard refuses stale web, provision and bridge dump even after READY", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-systemd-"));
  try {
    const bundle = path.join(temp, "candidate.js");
    fs.writeFileSync(bundle, "compiled-new");
    const artifact = {
      name: "erp-server",
      script: bundle,
      bundle,
      hash: hashFile(bundle),
      scriptHash: hashFile(bundle),
      instances: 1,
    };
    const journal = { version: 1, phase: "READY", artifacts: [artifact] };
    const save = (value) =>
      fs.writeFileSync(path.join(temp, "dump.pm2"), JSON.stringify(value));
    fs.writeFileSync(
      path.join(temp, "erp-inventory-activation.json"),
      JSON.stringify(journal),
      { mode: 0o600 },
    );
    save([{ name: "erp-server", pm_exec_path: bundle }]);
    assertInventoryResurrection(temp);
    for (const bad of [
      { name: "erp-server", pm_exec_path: path.join(temp, "old.js") },
      { name: "erp-provision-worker", pm_exec_path: bundle },
      { name: "erp-hr-bridge", pm_exec_path: bundle },
    ]) {
      save([bad]);
      assert.throws(() => assertInventoryResurrection(temp));
    }
    save([{ name: "unrelated", pm_exec_path: "/unrelated/index.js" }]);
    assertInventoryResurrection(temp);
    save([{ name: "erp-server", pm_exec_path: bundle }]);
    fs.writeFileSync(
      path.join(temp, "erp-inventory-activation.json"),
      JSON.stringify({ ...journal, phase: "FATAL" }),
    );
    assert.throws(() => assertInventoryResurrection(temp), /RECOVERY_REQUIRED/);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

for (const scenario of [
  "normal",
  "compatible-prior",
  "compatible-prior-bad-hash",
  "late-old-orphan",
  "late-candidate-orphan",
  "late-before-stop-child",
  "late-between-fences",
  "candidate-unattested-child",
  "exec-unrelated",
])
  test(`actual Linux adapter ownership census: ${scenario}`, async () => {
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), "inventory-host-adapter-"),
    );
    const procRoot = path.join(temp, "proc"),
      projectRoot = path.join(temp, "erp"),
      pm2Home = path.join(temp, "pm2");
    const helper = path.join(temp, "installed.mjs");
    const helperOwner = mockInstalledHelperOwner(helper);
    try {
      for (const d of [
        procRoot,
        pm2Home,
        path.join(projectRoot, ".runtime"),
        path.join(projectRoot, "deploy/systemd"),
      ])
        fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(helper, "trusted-helper");
      fs.chmodSync(helper, 0o444);
      fs.writeFileSync(
        path.join(projectRoot, "deploy/systemd/pm2-systemd-start.mjs"),
        "trusted-helper",
      );
      const addPid = (pid, startTime = String(pid + 100), parent = 2) => {
        const d = path.join(procRoot, String(pid));
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(
          path.join(d, "stat"),
          `${pid} (node) S ${parent} ${Array(17).fill("0").join(" ")} ${startTime} 0\n`,
        );
        fs.mkdirSync(path.join(d, "cwd"), { recursive: true });
        fs.writeFileSync(path.join(d, "exe"), "node");
        fs.writeFileSync(path.join(d, "cmdline"), `node-${pid}\0`);
        fs.writeFileSync(
          path.join(d, "status"),
          "Uid:\t1000\t1000\t1000\t1000\n",
        );
      };
      addPid(2);
      addPid(10);
      addPid(11);
      addPid(90);
      fs.writeFileSync(
        path.join(procRoot, "2/cmdline"),
        `PM2 v7.0.3: God Daemon (${pm2Home})\0`,
      );
      fs.writeFileSync(path.join(pm2Home, "pm2.pid"), "2");
      const makeRow = (name, pid, script) => ({
        name,
        pm_id: pid,
        pid,
        pm2_env: {
          name,
          pm_cwd: projectRoot,
          pm_exec_path: script,
          exec_mode: name === "erp-server" ? "cluster_mode" : "fork_mode",
          env: {},
        },
      });
      const unrelated = {
        name: "unrelated-app",
        pm_id: 90,
        pid: 90,
        pm2_env: {
          pm_cwd: path.join(temp, "other"),
          pm_exec_path: path.join(temp, "other/index.js"),
        },
      };
      let live = [
        makeRow("erp-server", 10, path.join(projectRoot, "old.js")),
        makeRow("erp-hr-bridge", 11, path.join(projectRoot, "old-bridge.mjs")),
        unrelated,
      ];
      const web = path.join(projectRoot, "candidate.js"),
        bridge = path.join(projectRoot, "bridge.cjs"),
        bridgeConfig = path.join(projectRoot, "bridge.config.json");
      fs.writeFileSync(web, "compiled-new-web");
      fs.writeFileSync(bridge, "compiled-new-bridge");
      const artifacts = [
        {
          name: "erp-server",
          script: web,
          bundle: web,
          hash: hashFile(web),
          scriptHash: hashFile(web),
          instances: 3,
        },
        {
          name: "erp-hr-bridge",
          script: bridge,
          bundle: bridge,
          hash: hashFile(bridge),
          scriptHash: hashFile(bridge),
          instances: 1,
        },
      ];
      const journal = {
        id: "12345678-1234-1234-1234-123456789abc",
        phase: "READY",
        nonce: "a".repeat(64),
        database: "erp_test",
        serverUuid: "server",
        artifacts,
      };
      const calls = [];
      const execute = (command, args) => {
        calls.push([command, ...args]);
        if (command === "systemctl") return helper;
        if (args[0] === "jlist") return JSON.stringify(live);
        if (args[0] === "delete") {
          const selected = live.find((r) => r.pm_id === Number(args[1]));
          assert.ok(selected && selected.name !== "unrelated-app");
          fs.rmSync(path.join(procRoot, String(selected.pid)), {
            recursive: true,
          });
          live = live.filter((r) => r !== selected);
          if (
            (scenario === "late-old-orphan" && selected.pid === 10) ||
            (scenario === "late-candidate-orphan" && selected.pid === 20)
          )
            addPid(88, "188", 1);
        }
        if (args[0] === "save")
          fs.writeFileSync(
            path.join(pm2Home, "dump.pm2"),
            JSON.stringify(live.map((r) => ({ ...r.pm2_env, name: r.name }))),
          );
        if (args[0] === "start") {
          const a = artifacts.find((a) => a.name === args.at(-1));
          for (let i = 0; i < a.instances; i++) {
            const pid = a.name === "erp-server" ? 20 + i : 30;
            addPid(pid);
            live.push(makeRow(a.name, pid, a.script));
          }
        }
        return "";
      };
      let orphan = true;
      const connectionA = {
        on() {},
        beginTransaction: async () => {},
        commit: async () => {},
        query: async (sql) => {
          if (sql.startsWith("SHOW GRANTS"))
            return [[{ grant: "GRANT ALL PRIVILEGES ON *.* TO root" }]];
          if (sql.includes("event_scheduler")) return [[{ scheduler: "OFF" }]];
          if (sql.includes("replication_connection_status")) return [[]];
          if (sql.includes("CONNECTION_ID()"))
            return [[{ id: 1, db: "erp_test", serverUuid: "server" }]];
          if (sql.includes("FROM monthCloseSequence")) return [[{ id: 1 }]];
          if (sql.includes("data_locks")) return [[{ transactionId: 5 }]];
          if (sql.includes("innodb_trx")) return [[{ id: 1 }]];
          if (sql.includes("performance_schema.threads"))
            return [[{ id: 1 }, { id: 2 }, ...(orphan ? [{ id: 99 }] : [])]];
          throw new Error(sql);
        },
      };
      const op = createLinuxActivationOperations({
        projectRoot,
        pm2Home,
        journal,
        connectionA,
        connectionB: { query: async () => [[{ id: 2 }]] },
        candidateWebApp: { name: "erp-server" },
        bridgeConfigPath: bridgeConfig,
        installCandidate: async () => {},
        restoreArtifact: async () => {},
        execute,
        procRoot,
        uid: 1000,
        platform: "linux",
        externalWritersExcluded: true,
        installedHelperPath: helper,
        drainTimeoutMs: 10,
        requestAttestation: async (socket) => {
          const pid = Number(path.basename(socket).match(/ia-(\d+)/)[1]);
          const r = live.find((r) => r.pid === pid);
          const a = artifacts.find((a) => a.name === r.name);
          return {
            pid,
            startTime: String(pid + 100),
            name: r.name,
            bundle: a.bundle,
            hash: a.hash,
            capability: CAPABILITY,
            activationId: journal.id,
            database: journal.database,
            serverUuid: journal.serverUuid,
            held: true,
          };
        },
      });
      if (scenario === "normal") {
        const rejectsUntrustedHelper = () =>
          assert.rejects(op.preflight(), /INSTALLED_BOOT_INTERLOCK_REQUIRED/);
        helperOwner.setOwner(1000);
        await rejectsUntrustedHelper();
        helperOwner.setOwner(0);
        assert.equal(fs.lstatSync(projectRoot).uid, process.getuid?.() ?? 0);
        fs.chmodSync(helper, 0o644);
        fs.writeFileSync(helper, "tampered-helper");
        await rejectsUntrustedHelper();
        fs.writeFileSync(helper, "trusted-helper");
        if (process.platform === "linux") {
          fs.chmodSync(helper, 0o466);
          await rejectsUntrustedHelper();
          fs.chmodSync(helper, 0o444);
          const realHelper = `${helper}.real`;
          fs.renameSync(helper, realHelper);
          fs.symlinkSync(realHelper, helper);
          await rejectsUntrustedHelper();
          fs.unlinkSync(helper);
          fs.renameSync(realHelper, helper);
        }
        fs.chmodSync(helper, 0o444);
      }
      if (scenario.startsWith("compatible-prior")) {
        const priorArtifacts = live
          .filter((r) => r !== unrelated)
          .map((r) => {
            fs.writeFileSync(r.pm2_env.pm_exec_path, `prior-${r.name}-v1`);
            const hash = hashFile(r.pm2_env.pm_exec_path);
            return {
              name: r.name,
              script: r.pm2_env.pm_exec_path,
              bundle: r.pm2_env.pm_exec_path,
              hash,
              scriptHash: hash,
              instances: 1,
            };
          });
        const previous = {
          ...journal,
          version: 1,
          commit: "e".repeat(40),
          phase: "ROLLED_BACK",
          initialReadyVersion: 1,
          priorArtifacts,
          active: {
            readyVersion: 1,
            activationId: journal.id,
            commit: "e".repeat(40),
            projectionCommit: "d".repeat(40),
            database: journal.database,
            serverUuid: journal.serverUuid,
            artifacts: priorArtifacts,
          },
        };
        writeActivationJournal(
          path.join(pm2Home, "erp-inventory-activation.json"),
          previous,
        );
        if (scenario === "compatible-prior-bad-hash") {
          fs.appendFileSync(priorArtifacts[1].bundle, "tampered");
          await assert.rejects(op.preflight(), /PRIOR_CAPABILITY_UNPROVEN/);
          assert.equal(live.length, 3);
          return;
        }
      }
      await op.preflight();
      await op.acquireGate();
      if (scenario === "late-before-stop-child") {
        addPid(88, "188", 10);
        orphan = false;
        await assert.rejects(op.stopOld(), /STILL_ALIVE|UNCLASSIFIED/);
        assert.ok(live.includes(unrelated));
        return;
      }
      if (scenario === "late-old-orphan") {
        orphan = false;
        await assert.rejects(async () => {
          await op.stopOld();
          await op.assertQuiescent();
        }, /UNCLASSIFIED|PROCESS_REMAINS|STILL_ALIVE/);
        assert.ok(live.includes(unrelated));
        return;
      }
      if (scenario === "exec-unrelated") {
        fs.writeFileSync(
          path.join(procRoot, "90/cmdline"),
          "changed-to-unowned-writer\0",
        );
        orphan = false;
        await assert.rejects(async () => {
          await op.stopOld();
          await op.assertQuiescent();
        }, /UNCLASSIFIED|IDENTITY_CHANGED/);
        assert.ok(live.includes(unrelated));
        return;
      }
      await op.stopOld();
      assert.deepEqual(live, [unrelated]);
      await assert.rejects(op.assertQuiescent(), /UNOWNED_DATABASE_SESSION/);
      orphan = false;
      await op.assertQuiescent();
      if (scenario === "late-between-fences") {
        addPid(88, "188", 1);
        await assert.rejects(op.assertQuiescent(), /UNCLASSIFIED/);
        assert.ok(live.includes(unrelated));
        return;
      }
      await op.startCandidates();
      await op.verifyCandidates(journal);
      if (scenario === "candidate-unattested-child") {
        addPid(88, "188", 20);
        await assert.rejects(
          op.saveCompatibleRestartDefinitions(),
          /CHILD_UNATTESTED/,
        );
        assert.ok(live.includes(unrelated));
        return;
      }
      await op.saveCompatibleRestartDefinitions();
      assert.equal(live.filter((r) => r.name === "erp-server").length, 3);
      assert.equal(live.filter((r) => r.name === "erp-hr-bridge").length, 1);
      assert.ok(live.includes(unrelated));
      assert.equal(
        fs.readFileSync(path.join(pm2Home, "dump.pm2"), "utf8"),
        fs.readFileSync(path.join(pm2Home, "dump.pm2.bak"), "utf8"),
      );
      if (scenario === "late-candidate-orphan") {
        await assert.rejects(async () => {
          await op.stopCandidates();
          await op.assertQuiescent();
        }, /UNCLASSIFIED|PROCESS_REMAINS|STILL_ALIVE/);
        assert.ok(live.includes(unrelated));
        return;
      }
      await op.stopCandidates();
      await op.assertQuiescent();
      assert.deepEqual(live, [unrelated]);
      assert.ok(!calls.some((c) => c.includes("kill") || c.includes("90")));
    } finally {
      helperOwner.restore();
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o600);
      fs.rmSync(temp, { recursive: true });
    }
  });

test("deploy bootstrap runs before dependencies exist, reexecutes changed controller and refuses unsafe early recovery", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-bootstrap-"));
  try {
    fs.mkdirSync(path.join(temp, "scripts/lib"), { recursive: true });
    fs.copyFileSync(
      path.resolve("scripts/deploy.mjs"),
      path.join(temp, "scripts/deploy.mjs"),
    );
    for (const name of fs.readdirSync(path.resolve("scripts/lib")))
      if (name.endsWith(".mjs"))
        fs.copyFileSync(
          path.resolve("scripts/lib", name),
          path.join(temp, "scripts/lib", name),
        );
    const r = spawnSync(
      process.execPath,
      [path.join(temp, "scripts/deploy.mjs"), "--selftest-ci-gate"],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /selftest: OK/);
    const { synchronizeAndMaybeReexec } = await import(
      pathToFileURL(path.join(temp, "scripts/deploy.mjs"))
    );
    const order = [];
    let reads = 0;
    assert.throws(
      () =>
        synchronizeAndMaybeReexec(
          {
            token: "test-lock",
            release() {
              order.push("release");
            },
          },
          {
            args: [],
            repository: () => {
              order.push("read");
              return {
                head: (++reads === 1 ? "a" : "b").repeat(40),
                remote: "b".repeat(40),
              };
            },
            execute(command, args) {
              assert.equal(command, "git");
              assert.deepEqual(args, ["pull", "--ff-only", "origin", "main"]);
              order.push("sync");
              fs.appendFileSync(
                path.join(temp, "scripts/deploy.mjs"),
                '\nexport const changedControllerProof = "fresh";\n',
              );
            },
            spawnChild(file, args) {
              assert.equal(file, process.execPath);
              assert.deepEqual(args.slice(1), ["--after-pull", "b".repeat(40)]);
              order.push("reexec");
              const fresh = spawnSync(
                file,
                [
                  "--input-type=module",
                  "-e",
                  `const m=await import(${JSON.stringify(pathToFileURL(args[0]).href)}); if(m.changedControllerProof!=="fresh") throw Error("stale");`,
                ],
                { encoding: "utf8", timeout: 10000 },
              );
              assert.equal(fresh.status, 0, fresh.stderr);
              return fresh;
            },
            exit(code) {
              assert.equal(code, 0);
              order.push("exit");
              throw Error("fixture-exit");
            },
          },
        ),
      /fixture-exit/,
    );
    assert.deepEqual(order, [
      "read",
      "sync",
      "read",
      "reexec",
      "release",
      "exit",
    ]);
    const pm2 = path.join(temp, "pm2");
    fs.mkdirSync(pm2);
    const fixtureJournal = () => ({
      version: 1,
      id: "12345678-1234-1234-1234-123456789abc",
      commit: "b".repeat(40),
      nonce: "a".repeat(64),
      database: "erp_test",
      serverUuid: "server",
      artifacts: [
        {
          name: "erp-server",
          script: path.join(temp, "old.js"),
          bundle: path.join(temp, "old.js"),
          hash: "c".repeat(64),
          instances: 1,
        },
      ],
    });
    // A child with NO dependencies must reject unresolved intent before touching a
    // malformed old web snapshot (and before any process start could occur).
    fs.writeFileSync(
      path.join(pm2, "erp-inventory-activation.json"),
      JSON.stringify({ ...fixtureJournal(), phase: "PRE_RELEASE" }),
      { mode: 0o600 },
    );
    const code = `const m=await import(${JSON.stringify(pathToFileURL(path.join(temp, "scripts/deploy.mjs")).href)}); try {m.rollbackWebArtifact({}, {reload(){throw Error("UNSAFE_START")},health(){}}); throw Error("missing guard");} catch(e) {if(!e.message.includes("INVENTORY_ACTIVATION_RECOVERY_REQUIRED")) throw e;}`;
    const recovery = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      {
        env: { ...process.env, PM2_HOME: pm2 },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(recovery.status, 0, recovery.stderr);
    const source = fs.readFileSync(path.resolve("scripts/deploy.mjs"), "utf8");
    assert.ok(
      source.indexOf('await import("./lib/inventory-activation-host.mjs")') >
        source.indexOf('["install", "--frozen-lockfile"]'),
    );
    assert.ok(
      source.indexOf('await import("./lib/db-target.mjs")') >
        source.indexOf('["install", "--frozen-lockfile"]'),
    );
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});
