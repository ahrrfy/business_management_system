import test from "node:test";
import "./fractional-inventory-schema.test.mjs";
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
  forwardRecoveryProjectionBaseline,
} from "./inventory-activation-host.mjs";

test("forward recovery validates retained projection provenance instead of declaring rollback", () => {
  const artifact = { name: "erp-server", script: path.resolve("old/index.js"), bundle: path.resolve("old/index.js"), hash: "a".repeat(64), scriptHash: "a".repeat(64), instances: 2 };
  const active = { readyVersion: 1, activationId: "12345678-1234-1234-1234-123456789abc", commit: "b".repeat(40), projectionCommit: "c".repeat(40), database: "erp_test", serverUuid: "server-one", artifacts: [artifact] };
  const journal = { phase: "FATAL", database: "erp_test", serverUuid: "server-one", initialReadyVersion: 1, priorActive: active, schemaTransition: { id: "fractional-material-quantities-v1", rollbackPolicy: "FORWARD_ONLY", started: true } };
  const before = JSON.stringify(journal);
  assert.equal(forwardRecoveryProjectionBaseline(journal, { readyVersion: 1, activatedCommit: "c".repeat(40) }), active);
  assert.equal(JSON.stringify(journal), before);
  assert.throws(() => forwardRecoveryProjectionBaseline(journal, { readyVersion: 1, activatedCommit: "d".repeat(40) }), /PROJECTION_MISMATCH/);
  assert.throws(() => forwardRecoveryProjectionBaseline(journal, { readyVersion: 0 }), /PROJECTION_MISMATCH/);
});

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
  runInventoryActivation,
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
  "control-root-ancestor-unreadable",
  "control-service-ancestor-unreadable",
  "control-service-ancestor-exec",
  "rollback-pid-zero",
  "rollback-pid-zero-partial",
  "rollback-pid-zero-orphan",
])
  test(`actual Linux adapter ownership census: ${scenario}`, async (t) => {
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
      const addPid = (
        pid,
        startTime = String(pid + 100),
        parent = 2,
        uid = 1000,
      ) => {
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
          `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
        );
      };
      addPid(2);
      addPid(10);
      addPid(11);
      addPid(90);
      let rootFingerprintReads = 0;
      if (scenario.startsWith("control-")) {
        // A deploy shell above sudo/root must still be classified and rechecked.
        addPid(process.pid, "control", 901);
        addPid(901, "service-parent", 902);
        addPid(902, "root-parent", 903, 0);
        addPid(903, "service-grandparent", 1);
        const realpath = fs.realpathSync;
        t.mock.method(fs, "realpathSync", (file, ...args) => {
          if (
            ["cwd", "exe"].some(
              (name) => file === path.join(procRoot, "902", name),
            )
          ) {
            rootFingerprintReads++;
            throw Object.assign(new Error("root ancestor inaccessible"), {
              code: "EACCES",
              path: file,
            });
          }
          if (
            scenario === "control-service-ancestor-unreadable" &&
            file === path.join(procRoot, "903/cwd")
          )
            throw Object.assign(new Error("service ancestor inaccessible"), {
              code: "EACCES",
              path: file,
            });
          return realpath(file, ...args);
        });
      }
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
        version: 1,
        commit: "b".repeat(40),
        id: "12345678-1234-1234-1234-123456789abc",
        phase: "READY",
        nonce: "a".repeat(64),
        database: "erp_test",
        serverUuid: "server",
        artifacts,
      };
      const calls = [];
      const rollbackEvents = [];
      let readyVersion = 0;
      let pendingReadyVersion;
      const execute = (command, args) => {
        calls.push([command, ...args]);
        if (command === "systemctl") return helper;
        if (args[0] === "jlist") return JSON.stringify(live);
        if (args[0] === "delete") {
          const selected = live.find((r) => r.pm_id === Number(args[1]));
          assert.ok(selected && selected.name !== "unrelated-app");
          if (selected.pid > 0)
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
          if (
            args[1] ===
            path.join(
              projectRoot,
              ".runtime",
              `inventory-prior-${journal.id}.json`,
            )
          ) {
            assert.equal(readyVersion, 0);
            const saved = JSON.parse(
              fs.readFileSync(
                path.join(pm2Home, "erp-inventory-activation.json"),
              ),
            );
            assert.equal(saved.phase, "ROLLED_BACK");
            assert.equal(saved.active, null);
            rollbackEvents.push("RESTART_OLD");
            for (const [i, app] of JSON.parse(
              fs.readFileSync(args[1]),
            ).apps.entries()) {
              const pid = 10 + i;
              addPid(pid, String(pid + 900));
              live.push(makeRow(app.name, pid, app.script));
            }
            return "";
          }
          const a = artifacts.find((a) => a.name === args.at(-1));
          for (let i = 0; i < a.instances; i++) {
            const pid = a.name === "erp-server" ? 20 + i : 30;
            const candidate = makeRow(a.name, pid, a.script);
            if (
              scenario.startsWith("rollback-pid-zero") &&
              !(scenario === "rollback-pid-zero-partial" && pid !== 20)
            ) {
              candidate.pid = 0;
              candidate.pm2_env.status = "waiting restart";
            } else addPid(pid);
            live.push(candidate);
          }
          if (scenario === "rollback-pid-zero-orphan") addPid(88, "188", 1);
        }
        return "";
      };
      let orphan = true;
      const connectionA = {
        on() {},
        beginTransaction: async () => {},
        commit: async () => {
          rollbackEvents.push("A_COMMIT");
        },
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
      const connectionB = {
        beginTransaction: async () => {
          pendingReadyVersion = readyVersion;
          rollbackEvents.push("B_BEGIN");
        },
        commit: async () => {
          readyVersion = pendingReadyVersion;
          pendingReadyVersion = undefined;
          rollbackEvents.push("INVALIDATE_COMMIT");
        },
        rollback: async () => {
          pendingReadyVersion = undefined;
          rollbackEvents.push("B_ROLLBACK");
        },
        query: async (sql) => {
          if (sql.includes("CONNECTION_ID()")) return [[{ id: 2 }]];
          if (sql.includes("@@server_uuid"))
            return [[{ db: "erp_test", serverUuid: "server" }]];
          if (sql.startsWith("SELECT id FROM inventoryProjectionState"))
            return [[{ id: 1 }]];
          if (
            sql.startsWith("UPDATE inventoryProjectionState SET readyVersion=0")
          ) {
            pendingReadyVersion = 0;
            rollbackEvents.push("INVALIDATE_UPDATE");
            return [[]];
          }
          throw new Error(sql);
        },
      };
      const op = createLinuxActivationOperations({
        projectRoot,
        pm2Home,
        journal,
        connectionA,
        connectionB,
        candidateWebApp: { name: "erp-server" },
        bridgeConfigPath: bridgeConfig,
        installCandidate: async () => {},
        restoreArtifact: async () => {
          assert.equal(readyVersion, 0);
          rollbackEvents.push("RESTORE_ARTIFACT");
        },
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
      if (scenario.startsWith("rollback-pid-zero")) {
        orphan = false;
        journal.priorArtifacts = live
          .filter((r) => r !== unrelated)
          .map((r) => {
            fs.writeFileSync(r.pm2_env.pm_exec_path, `prior-${r.name}`);
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
        const verify = op.verifyCandidates;
        op.verifyCandidates = async (current) => {
          let time = 0;
          const clock = t.mock.method(Date, "now", () => (time += 31000));
          try {
            return await verify(current);
          } finally {
            clock.mock.restore();
          }
        };
        let latest;
        const activate = async (_b, options) => {
          await options.fence.assertQuiescentAndLocked();
          readyVersion = 1;
          rollbackEvents.push("ACTIVATE_COMMIT");
        };
        const run = () =>
          runInventoryActivation({
            journal,
            connectionB,
            operations: op,
            activate,
            persist: async (value) => {
              latest = structuredClone(value);
              writeActivationJournal(
                path.join(pm2Home, "erp-inventory-activation.json"),
                value,
              );
              rollbackEvents.push(`PERSIST_${value.phase}`);
            },
          }).catch((error) => {
            if (error instanceof AggregateError)
              t.diagnostic(error.errors.map((e) => e.message).join(" | "));
            throw error;
          });
        if (scenario === "rollback-pid-zero-orphan") {
          await assert.rejects(
            run(),
            (e) =>
              e.message === "INVENTORY_ACTIVATION_FATAL" &&
              e.errors[1].message === "INVENTORY_UNCLASSIFIED_PROCESS",
          );
          assert.equal(readyVersion, 1);
          assert.equal(latest.phase, "FATAL");
          assert.ok(!rollbackEvents.includes("INVALIDATE_UPDATE"));
          assert.ok(!rollbackEvents.includes("RESTART_OLD"));
        } else {
          await assert.rejects(run(), /INVENTORY_CANDIDATE_PID_MISSING/);
          assert.equal(readyVersion, 0);
          assert.equal(latest.phase, "ROLLED_BACK");
          assert.equal(latest.active, null);
          assert.deepEqual(
            rollbackEvents.filter((e) =>
              [
                "INVALIDATE_COMMIT",
                "RESTORE_ARTIFACT",
                "PERSIST_ROLLBACK_READY",
                "A_COMMIT",
                "PERSIST_ROLLED_BACK",
                "RESTART_OLD",
              ].includes(e),
            ),
            [
              "INVALIDATE_COMMIT",
              "RESTORE_ARTIFACT",
              "PERSIST_ROLLBACK_READY",
              "A_COMMIT",
              "PERSIST_ROLLED_BACK",
              "RESTART_OLD",
            ],
          );
          assert.deepEqual(
            live
              .filter((r) => r !== unrelated)
              .map((r) => r.pm2_env.pm_exec_path),
            journal.priorArtifacts.map((a) => a.script),
          );
        }
        assert.ok(live.includes(unrelated));
        assert.ok(!calls.some((c) => c.includes("kill") || c.includes("90")));
        return;
      }
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
      if (scenario === "control-service-ancestor-unreadable") {
        await assert.rejects(
          op.preflight(),
          (e) =>
            e.code === "EACCES" && e.path === path.join(procRoot, "903/cwd"),
        );
        assert.equal(rootFingerprintReads, 0);
        assert.equal(live.length, 3);
        assert.ok(
          !calls.some((c) => c.includes("delete") || c.includes("start")),
        );
        return;
      }
      await op.preflight();
      assert.equal(rootFingerprintReads, 0);
      if (scenario === "control-service-ancestor-exec") {
        fs.writeFileSync(
          path.join(procRoot, "903/cmdline"),
          "changed-controller-parent\0",
        );
        await assert.rejects(op.stopOld(), /UNCLASSIFIED|IDENTITY_CHANGED/);
        assert.equal(rootFingerprintReads, 0);
        assert.equal(live.length, 3);
        assert.ok(
          !calls.some((c) => c.includes("delete") || c.includes("start")),
        );
        return;
      }
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
      assert.equal(rootFingerprintReads, 0);
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

test("resolveExternalWritersExcluded requires explicit flag for initial activation or schema cutover, but allows routine deploys with priorActive", async () => {
  const { resolveExternalWritersExcluded } = await import(
    "./inventory-activation-host.mjs"
  );
  const priorActive = { activationId: "prev-1", readyVersion: 1 };
  const schemaTransition = { id: "fractional-cutover", rollbackPolicy: "FORWARD_ONLY" };

  // Initial activation (!priorActive): requires =1
  assert.equal(resolveExternalWritersExcluded({}, { priorActive: null }), false);
  assert.equal(
    resolveExternalWritersExcluded(
      { ERP_INVENTORY_EXTERNAL_WRITERS_EXCLUDED: "1" },
      { priorActive: null },
    ),
    true,
  );

  // Schema cutover: requires =1 even with priorActive
  assert.equal(
    resolveExternalWritersExcluded({}, { priorActive, schemaTransition }),
    false,
  );
  assert.equal(
    resolveExternalWritersExcluded(
      { ERP_INVENTORY_EXTERNAL_WRITERS_EXCLUDED: "1" },
      { priorActive, schemaTransition },
    ),
    true,
  );

  // Routine code deploy (priorActive present, no schemaTransition): allowed unless explicitly "0"
  assert.equal(resolveExternalWritersExcluded({}, { priorActive }), true);
  assert.equal(
    resolveExternalWritersExcluded(
      { ERP_INVENTORY_EXTERNAL_WRITERS_EXCLUDED: "0" },
      { priorActive },
    ),
    false,
  );
});

function createResilienceHostFixture({
  initialReadyVersion = 1,
  initialDumpApps = null,
  threadsProvider,
  innodbTrxProvider = () => [],
  replicationConnectionsProvider = () => [],
  extraProcSetup = null,
  failVerify = false,
  dropGateOnRollback = false,
  schemaTransition = undefined,
} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-resilience-host-"));
  const procRoot = path.join(temp, "proc");
  const projectRoot = path.join(temp, "erp");
  const pm2Home = path.join(temp, "pm2");
  const helper = path.join(temp, "installed.mjs");
  const helperOwner = mockInstalledHelperOwner(helper);
  fs.mkdirSync(procRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(pm2Home, { recursive: true, mode: 0o700 });
  fs.chmodSync(pm2Home, 0o700);
  fs.mkdirSync(path.join(projectRoot, ".runtime/web-releases/web-prior/previous/public"), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(projectRoot, "deploy/systemd"), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(helper, "trusted-helper");
  fs.chmodSync(helper, 0o444);
  fs.writeFileSync(
    path.join(projectRoot, "deploy/systemd/pm2-systemd-start.mjs"),
    "trusted-helper",
  );
  const priorBundle = path.join(
    projectRoot,
    ".runtime/web-releases/web-prior/previous/index.js",
  );
  const candidateBundle = path.join(projectRoot, "candidate.js");
  fs.writeFileSync(priorBundle, "prior-web");
  fs.writeFileSync(
    path.join(projectRoot, ".runtime/web-releases/web-prior/previous/public/index.html"),
    "prior-html",
  );
  fs.writeFileSync(candidateBundle, "candidate-web");

  const addPid = (pid, startTime = String(pid + 100), parent = 2, uid = 1000, cmdline = `node-${pid}\0`) => {
    const dir = path.join(procRoot, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "stat"),
      `${pid} (node) S ${parent} ${Array(17).fill("0").join(" ")} ${startTime} 0\n`,
    );
    fs.mkdirSync(path.join(dir, "cwd"), { recursive: true });
    fs.writeFileSync(path.join(dir, "exe"), "node");
    fs.writeFileSync(path.join(dir, "cmdline"), cmdline);
    fs.writeFileSync(path.join(dir, "status"), `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  };
  addPid(2, "102", 1, 1000, `PM2 v7.0.3: God Daemon (${pm2Home})\0`);
  addPid(10, "110", 2, 1000);
  fs.writeFileSync(path.join(pm2Home, "pm2.pid"), "2");

  const makeRow = (name, pid, script) => ({
    name,
    pm_id: pid,
    pid,
    pm2_env: {
      name,
      pm_cwd: projectRoot,
      pm_exec_path: script,
      exec_mode: "cluster_mode",
      env: {},
    },
  });
  let live = [makeRow("erp-server", 10, priorBundle)];
  if (initialDumpApps) {
    fs.writeFileSync(path.join(pm2Home, "dump.pm2"), JSON.stringify(initialDumpApps));
  }
  const priorArtifacts = [
    {
      name: "erp-server",
      script: priorBundle,
      bundle: priorBundle,
      hash: hashFile(priorBundle),
      scriptHash: hashFile(priorBundle),
      instances: 1,
    },
  ];
  const candidateArtifacts = [
    {
      name: "erp-server",
      script: candidateBundle,
      bundle: candidateBundle,
      hash: hashFile(candidateBundle),
      scriptHash: hashFile(candidateBundle),
      instances: 1,
    },
  ];
  const priorActive = {
    readyVersion: 1,
    activationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    commit: "e".repeat(40),
    projectionCommit: "d".repeat(40),
    database: "erp_test",
    serverUuid: "server-one",
    artifacts: priorArtifacts,
  };
  if (initialReadyVersion === 1) {
    writeActivationJournal(path.join(pm2Home, "erp-inventory-activation.json"), {
      version: 1,
      id: priorActive.activationId,
      phase: "RELEASED",
      nonce: "1".repeat(64),
      commit: priorActive.commit,
      database: "erp_test",
      serverUuid: "server-one",
      artifacts: priorArtifacts,
      priorArtifacts,
      active: priorActive,
    });
  }
  if (extraProcSetup) extraProcSetup({ addPid, procRoot, temp });

  const calls = [];
  let gateLocked = true;
  let gateReleased = false;
  const execute = (command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl") return helper;
    if (args[0] === "jlist") return JSON.stringify(live);
    if (args[0] === "delete") {
      const target = live.find((r) => r.pm_id === Number(args[1]));
      if (target?.pid > 0) {
        fs.rmSync(path.join(procRoot, String(target.pid)), { recursive: true, force: true });
      }
      live = live.filter((r) => r !== target);
    }
    if (args[0] === "save") {
      fs.writeFileSync(
        path.join(pm2Home, "dump.pm2"),
        JSON.stringify(live.map((r) => ({ ...r.pm2_env, name: r.name }))),
      );
    }
    if (args[0] === "start") {
      const cfg = JSON.parse(fs.readFileSync(args[1], "utf8"));
      for (const [idx, app] of cfg.apps.entries()) {
        const pid = args[1].includes("inventory-prior-") ? 40 + idx : 20 + idx;
        addPid(pid);
        live.push(makeRow(app.name, pid, app.script));
      }
    }
    return "";
  };
  const connectionA = {
    on() {},
    beginTransaction: async () => {},
    commit: async () => {
      gateReleased = true;
    },
    query: async (sql) => {
      if (sql.startsWith("SHOW GRANTS")) {
        return [[{ grant: "GRANT ALL PRIVILEGES ON *.* TO root" }]];
      }
      if (sql.includes("event_scheduler")) return [[{ scheduler: "OFF" }]];
      if (sql.includes("replication_connection_status")) {
        return [replicationConnectionsProvider(sql)];
      }
      if (sql.includes("CONNECTION_ID()")) {
        return [[{ id: 1, db: "erp_test", serverUuid: "server-one" }]];
      }
      if (sql.includes("FROM monthCloseSequence")) return [[{ id: 1 }]];
      if (sql.includes("data_locks")) {
        if (!gateLocked) return [[]];
        return [[{ transactionId: 5 }]];
      }
      if (sql.includes("innodb_trx")) return [innodbTrxProvider()];
      if (sql.includes("performance_schema.threads")) return [threadsProvider()];
      throw new Error(sql);
    },
  };
  const connectionB = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    query: async (sql) => {
      if (sql.includes("CONNECTION_ID()")) return [[{ id: 2 }]];
      if (sql.includes("@@server_uuid")) {
        return [[{ db: "erp_test", serverUuid: "server-one" }]];
      }
      return [[]];
    },
  };
  const journal = {
    version: 1,
    id: "12345678-1234-1234-1234-123456789abc",
    phase: "PREPARED",
    nonce: "a".repeat(64),
    commit: "b".repeat(40),
    database: "erp_test",
    serverUuid: "server-one",
    artifacts: candidateArtifacts,
    priorArtifacts,
    priorActive: initialReadyVersion === 1 ? priorActive : undefined,
    schemaTransition,
  };
  const op = createLinuxActivationOperations({
    projectRoot,
    pm2Home,
    journal,
    connectionA,
    connectionB,
    candidateWebApp: { name: "erp-server", script: candidateBundle, cwd: projectRoot, instances: 1 },
    bridgeConfigPath: null,
    installCandidate: async () => {},
    restoreArtifact: async () => {},
    execute,
    procRoot,
    uid: 1000,
    platform: "linux",
    externalWritersExcluded: true,
    installedHelperPath: helper,
    drainTimeoutMs: 100,
    preflightDbRetryMs: 40,
    preflightDbRetryIntervalMs: 5,
    initialReadyVersion,
    requestAttestation: async (socket) => {
      if (failVerify) {
        if (dropGateOnRollback) gateLocked = false;
        throw new Error("FIXTURE_VERIFY_FAILED");
      }
      const pid = Number(path.basename(socket).match(/ia-(\d+)/)[1]);
      return {
        pid,
        startTime: String(pid + 100),
        name: "erp-server",
        bundle: candidateBundle,
        hash: candidateArtifacts[0].hash,
        capability: CAPABILITY,
        activationId: journal.id,
        database: journal.database,
        serverUuid: journal.serverUuid,
        held: true,
      };
    },
  });
  return {
    temp,
    pm2Home,
    procRoot,
    journal,
    priorActive,
    op,
    calls,
    get live() {
      return live;
    },
    get gateReleased() {
      return gateReleased;
    },
    setGateLocked(v) {
      gateLocked = v;
    },
    cleanup() {
      helperOwner.restore();
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o600);
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

test("PRE_STOP_DB_CHECK rejects external root/replication sessions before acquireGate and stopOld while allowing erp_app and transient clear", async (t) => {
  for (const sessionCase of ["root-persistent", "binlog-dump", "transient-clears", "erp-app-allowed"]) {
    let callsCount = 0;
    const fx = createResilienceHostFixture({
      threadsProvider: () => {
        callsCount++;
        const base = [
          { id: 1, user: "root", host: "localhost", db: "erp_test", command: "Sleep", timeSec: 0, state: "", info: null, name: "thread/sql/one_connection" },
          { id: 2, user: "root", host: "localhost", db: "erp_test", command: "Sleep", timeSec: 0, state: "", info: null, name: "thread/sql/one_connection" },
          { id: 50, user: "erp_app", host: "127.0.0.1:44100", db: "erp_test", command: "Sleep", timeSec: 1, state: "", info: null, name: "thread/sql/one_connection" },
        ];
        if (sessionCase === "root-persistent") {
          base.push({
            id: 77,
            user: "root",
            host: "localhost",
            db: "erp_test",
            command: "Query",
            timeSec: 2,
            state: "executing",
            info: "SHOW REPLICA STATUS",
            name: "thread/sql/one_connection",
          });
        } else if (sessionCase === "binlog-dump") {
          base.push({
            id: 78,
            user: "alroya_repl",
            host: "192.168.100.29:51234",
            db: null,
            command: "Binlog Dump GTID",
            timeSec: 120,
            state: "Source has sent all binlog to replica",
            info: null,
            name: "thread/sql/one_connection",
          });
        } else if (sessionCase === "transient-clears" && callsCount === 1) {
          base.push({
            id: 79,
            user: "root",
            host: "localhost",
            db: null,
            command: "Query",
            timeSec: 0,
            state: "init",
            info: "SHOW REPLICA STATUS",
            name: "thread/sql/one_connection",
          });
        }
        return base;
      },
    });
    const stderrLines = [];
    const errMock = t.mock.method(console, "error", (...args) => stderrLines.push(args.join(" ")));
    try {
      if (sessionCase === "root-persistent" || sessionCase === "binlog-dump") {
        await assert.rejects(fx.op.preflight(), (err) => {
          assert.equal(err.code, "INVENTORY_PREFLIGHT_EXTERNAL_DB_SESSION");
          assert.equal(err.message, "INVENTORY_PREFLIGHT_EXTERNAL_DB_SESSION");
          assert.ok(Array.isArray(err.externalSessions) && err.externalSessions.length === 1);
          assert.ok(Array.isArray(err.unownedSessionDetails) && err.unownedSessionDetails.length === 1);
          assert.equal(err.externalSessions[0].id, sessionCase === "root-persistent" ? 77 : 78);
          return true;
        });
        assert.ok(stderrLines.some((line) => line.includes("[INVENTORY_PREFLIGHT_EXTERNAL_DB_SESSION]")));
        assert.equal(fx.live.length, 1, "production workers must remain untouched");
        assert.ok(!fx.calls.some((c) => c.includes("delete")));
      } else {
        await fx.op.preflight();
        if (sessionCase === "transient-clears") assert.ok(callsCount >= 2);
        else assert.equal(callsCount, 1);
      }
    } finally {
      errMock.mock.restore();
      fx.cleanup();
    }
  }
});

test("saveDump preserves dump.pm2.pre-activation on stopOld and emits [INVENTORY_PRE_STOP_SNAPSHOT]", async (t) => {
  const initialDump = [{ name: "erp-server", pm_exec_path: "/opt/erp/old/index.js" }];
  const fx = createResilienceHostFixture({
    initialDumpApps: initialDump,
    threadsProvider: () => [
      { id: 1, user: "root", command: "Sleep", info: null },
      { id: 2, user: "root", command: "Sleep", info: null },
    ],
    replicationConnectionsProvider: (sql) =>
      sql.includes("SERVICE_STATE='ON'")
        ? []
        : [{ channelName: "", serviceState: "OFF" }],
  });
  const stderrLines = [];
  const errMock = t.mock.method(console, "error", (...args) => stderrLines.push(args.join(" ")));
  try {
    await fx.op.preflight();
    await fx.op.acquireGate();
    await fx.op.stopOld();
    const preAct = JSON.parse(fs.readFileSync(path.join(fx.pm2Home, "dump.pm2.pre-activation"), "utf8"));
    assert.deepEqual(preAct, initialDump);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.pm2Home, "dump.pm2"), "utf8")), []);
    const snapLine = stderrLines.find((l) => l.startsWith("[INVENTORY_PRE_STOP_SNAPSHOT] "));
    assert.ok(snapLine);
    const snap = JSON.parse(snapLine.slice("[INVENTORY_PRE_STOP_SNAPSHOT] ".length));
    assert.equal(snap.journalId, fx.journal.id);
    assert.equal(snap.commit, fx.journal.commit);
    assert.equal(snap.initialReadyVersion, 1);
    assert.equal(snap.hasSchemaTransition, false);
    assert.equal(snap.oldIdentities.length, 1);
    assert.deepEqual(snap.replicationConnections, [{ channelName: "", serviceState: "OFF" }]);
  } finally {
    errMock.mock.restore();
    fx.cleanup();
  }
});

test("refreshOwnership attaches redacted offendingProcesses and assertNoUnownedSessions logs rich unownedSessionDetails", async (t) => {
  const fakeDbPw = ["top", "secret"].join("");
  const fakeCliPw = ["my", "secret"].join("");
  const secretCmd = `node worker.js ${["my", "sql://root:"].join("")}${fakeDbPw}@127.0.0.1:3307/erp ${["--pass", "word="].join("")}${fakeCliPw} ${"x".repeat(260)}\0`;
  const fx = createResilienceHostFixture({
    threadsProvider: () => [
      { id: 1, user: "root", command: "Sleep", info: null },
      { id: 2, user: "root", command: "Sleep", info: null },
    ],
    extraProcSetup: ({ addPid }) => {
      addPid(777, "877", 1, 1000, secretCmd);
    },
  });
  const stderrLines = [];
  const errMock = t.mock.method(console, "error", (...args) => stderrLines.push(args.join(" ")));
  try {
    await assert.rejects(fx.op.preflight(), (err) => {
      assert.equal(err.message, "INVENTORY_UNCLASSIFIED_PROCESS");
      assert.ok(Array.isArray(err.offendingProcesses) && err.offendingProcesses.length === 1);
      const proc = err.offendingProcesses[0];
      assert.equal(proc.pid, 777);
      assert.equal(proc.uid, 1000);
      assert.equal(proc.ppid, 1);
      assert.ok(!proc.cmdline.includes(fakeDbPw));
      assert.ok(!proc.cmdline.includes(fakeCliPw));
      assert.ok(proc.cmdline.includes("[REDACTED_URL]"));
      assert.ok(proc.cmdline.endsWith("...[truncated]"));
      return true;
    });
    assert.ok(stderrLines.some((l) => l.includes("[INVENTORY_UNCLASSIFIED_PROCESS]")));

    // Now test assertNoUnownedSessions rich metadata + innodb_trx
    stderrLines.length = 0;
    const { assertNoUnownedSessions } = await import("./inventory-activation-fence.mjs");
    const mockConn = {
      query: async (sql) => {
        if (sql.includes("performance_schema.threads")) {
          return [[
            { id: 1, user: "root", command: "Sleep", info: null, name: "thread/sql/one_connection" },
            { id: 55, user: "admin", host: "10.0.0.5:9000", db: "erp", command: "Query", timeSec: 4, state: "updating", info: "UPDATE users SET password='secret'", name: "thread/sql/one_connection" },
          ]];
        }
        if (sql.includes("innodb_trx")) {
          return [[
            { id: 55, trxId: "99123", trxState: "RUNNING", trxStarted: "2026-11-18 15:00:00", trxQuery: "UPDATE users SET token=secret", trxIsReadOnly: 0, trxRowsModified: 1 },
          ]];
        }
        throw new Error(sql);
      },
    };
    await assert.rejects(assertNoUnownedSessions(mockConn, new Set([1, 2])), (err) => {
      assert.equal(err.message, "INVENTORY_UNOWNED_DATABASE_SESSION");
      assert.deepEqual(err.unownedSessionIds, [55]);
      assert.equal(err.unownedSessionDetails.length, 1);
      assert.equal(err.unownedSessionDetails[0].user, "admin");
      assert.equal(err.unownedSessionDetails[0].inInnodbTrx, true);
      assert.equal(err.unownedSessionDetails[0].trxRowsModified, 1);
      assert.ok(!err.unownedSessionDetails[0].info.includes("secret"));
      return true;
    });
    assert.ok(stderrLines.some((l) => l.includes("[INVENTORY_UNOWNED_DB_SESSIONS]")));
  } finally {
    errMock.mock.restore();
    fx.cleanup();
  }
});

test("runInventoryActivation non-schema v1 rollback tolerates transient read-only DB session warning while keeping write/lock/hash strict", async (t) => {
  for (const mode of ["transient-readonly-recovers", "active-write-trx-fatal", "gate-lost-fatal"]) {
    let phaseInCatch = false;
    const fx = createResilienceHostFixture({
      initialReadyVersion: 1,
      failVerify: true,
      dropGateOnRollback: mode === "gate-lost-fatal",
      threadsProvider: () => {
        const base = [
          { id: 1, user: "root", command: "Sleep", info: null },
          { id: 2, user: "root", command: "Sleep", info: null },
        ];
        if (phaseInCatch) {
          base.push({
            id: 91,
            user: "root",
            host: "localhost",
            db: null,
            command: "Query",
            timeSec: 0,
            state: "executing",
            info: mode === "active-write-trx-fatal" ? "UPDATE productVariants SET stock=1" : "SHOW REPLICA STATUS",
            name: "thread/sql/one_connection",
          });
        }
        return base;
      },
      innodbTrxProvider: () =>
        phaseInCatch && mode === "active-write-trx-fatal"
          ? [{ id: 91, trxId: "42", trxState: "RUNNING", trxIsReadOnly: 0, trxRowsModified: 1, trxQuery: "UPDATE productVariants SET stock=1" }]
          : [],
    });
    const origVerify = fx.op.verifyCandidates;
    fx.op.verifyCandidates = async (current) => {
      phaseInCatch = true;
      let time = 0;
      const clock = t.mock.method(Date, "now", () => (time += 31000));
      try {
        return await origVerify(current);
      } finally {
        clock.mock.restore();
      }
    };
    const warnLines = [];
    const warnMock = t.mock.method(console, "warn", (...args) => warnLines.push(args.join(" ")));
    const errMock = t.mock.method(console, "error", () => {});
    let persisted = null;
    try {
      if (mode === "transient-readonly-recovers") {
        await assert.rejects(
          runInventoryActivation({
            journal: fx.journal,
            initialReadyVersion: 1,
            operations: fx.op,
            persist: async (j) => {
              persisted = structuredClone(j);
              writeActivationJournal(path.join(fx.pm2Home, "erp-inventory-activation.json"), j);
            },
          }),
          /FIXTURE_VERIFY_FAILED/,
        );
        assert.equal(persisted.phase, "ROLLED_BACK");
        assert.deepEqual(persisted.active, fx.priorActive);
        assert.equal(fx.gateReleased, true);
        assert.equal(fx.live.length, 1);
        assert.equal(fx.live[0].pm2_env.pm_exec_path, fx.priorActive.artifacts[0].script);
        assert.ok(warnLines.some((l) => l.includes("[INVENTORY_ROLLBACK_TRANSIENT_DB_SESSION_WARNING]")));
      } else {
        await assert.rejects(
          runInventoryActivation({
            journal: fx.journal,
            initialReadyVersion: 1,
            operations: fx.op,
            persist: async (j) => {
              persisted = structuredClone(j);
              writeActivationJournal(path.join(fx.pm2Home, "erp-inventory-activation.json"), j);
            },
          }),
          (err) => err.message === "INVENTORY_ACTIVATION_FATAL",
        );
        assert.equal(persisted.phase, "FATAL");
        assert.equal(fx.live.length, 0);
      }
    } finally {
      warnMock.mock.restore();
      errMock.mock.restore();
      fx.cleanup();
    }
  }
});
