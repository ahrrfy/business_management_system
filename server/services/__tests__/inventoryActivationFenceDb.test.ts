import mysql, { type Connection } from "mysql2/promise";
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
// @ts-expect-error Test-only raw ESM metadata fixture; no production bypass.
import { mockInstalledHelperOwner } from "../../../scripts/lib/installed-helper-fixture.mjs";
import { awaitInventoryActivationRelease } from "../../config/inventoryActivationBoot";
import { closeDb } from "../../db";
import { closeCleanupConn } from "./__setup__";
import { assertIsolatedActivationTestTarget } from "./activationTestTarget";
import {
  acquireInventoryGate,
  runInventoryActivation,
  writeActivationJournal,
  readActivationJournal,
  assertNoUnownedSessions,
  // @ts-expect-error Raw operational ESM intentionally has no ORM dependency.
} from "../../../scripts/lib/inventory-activation-fence.mjs";
// @ts-expect-error Reviewed raw dedicated-connection B module.
import { activateInventoryProjection } from "../../../scripts/lib/inventory-projection-activation.mjs";
// @ts-expect-error Operational private per-process socket client.
import { queryWorkerAttestation } from "../../../scripts/lib/inventory-activation-host.mjs";
// @ts-expect-error Shared raw deployment lifecycle validator.
import { assertInventoryReadinessLifecycle } from "../../../scripts/lib/inventory-activation-journal.mjs";
// Execute standalone helper with native Node; Vite's import transform does not
// strip its CLI shebang. This starts no PM2 daemon and calls only the read guard.
const assertInventoryResurrection = (pm2Home: string) =>
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { assertInventoryResurrection } from ${JSON.stringify(pathToFileURL(path.resolve("deploy/systemd/pm2-systemd-start.mjs")).href)}; assertInventoryResurrection(${JSON.stringify(pm2Home)});`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
  );

async function fixture() {
  const raw = process.env.DATABASE_URL!;
  assertIsolatedActivationTestTarget(raw);
  await closeDb();
  await closeCleanupConn();
  const connections: Connection[] = [];
  const open = async () => {
    const c = await mysql.createConnection(raw);
    connections.push(c);
    return c;
  };
  const a = await open(),
    b = await open();
  await b.query(
    "INSERT INTO monthCloseSequence(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id",
  );
  const [[identity]] = await b.query<any[]>(
    "SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid, CONNECTION_ID() AS id",
  );
  const target = {
    database: identity.databaseName,
    serverUuid: identity.serverUuid,
  };
  const finish = async () => {
    await Promise.all(connections.map((c) => c.end().catch(() => {})));
  };
  return { a, b, open, target, bId: Number(identity.id), finish };
}
async function observedWait(observer: Connection, id: number) {
  const deadline = Date.now() + 5000;
  do {
    const [rows] = await observer.query<any[]>(
      "SELECT w.REQUESTING_ENGINE_TRANSACTION_ID FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?",
      [id],
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("MYSQL_GATE_WAIT_NOT_OBSERVED");
}

it("actual existing gate drains an earlier S transaction and blocks a later S writer", async () => {
  const f = await fixture();
  try {
    const old = await f.open();
    await old.beginTransaction();
    await old.query("SELECT id FROM monthCloseSequence WHERE id=1 FOR SHARE");
    const [[aId]] = await f.a.query<any[]>("SELECT CONNECTION_ID() AS id");
    const pendingA = acquireInventoryGate(f.a, f.target);
    await observedWait(f.b, Number(aId.id));
    await old.commit();
    const gate = await pendingA;
    await gate.assertLocked();
    const late = await f.open();
    const [[lateId]] = await late.query<any[]>("SELECT CONNECTION_ID() AS id");
    await late.beginTransaction();
    let passed = false;
    const pendingLate = late
      .query("SELECT id FROM monthCloseSequence WHERE id=1 FOR SHARE")
      .then(() => {
        passed = true;
      });
    await observedWait(f.b, Number(lateId.id));
    expect(passed).toBe(false);
    await gate.release();
    await pendingLate;
    await late.rollback();
    expect(passed).toBe(true);
    await expect(gate.assertLocked()).rejects.toThrow(/LOST/);
  } finally {
    await f.finish();
  }
});

it("real B backfill/parity commits under A while actual session census permits only A and B", async () => {
  const f = await fixture();
  try {
    await f.b.query(
      "UPDATE inventoryProjectionState SET readyVersion=0,activatedCommit=NULL,activatedAt=NULL WHERE id=1",
    );
    const gate = await acquireInventoryGate(f.a, f.target);
    const fence = {
      assertQuiescentAndLocked: async () => {
        await gate.assertLocked();
        await assertNoUnownedSessions(f.a, new Set([gate.connectionId, f.bId]));
      },
    };
    const result = await activateInventoryProjection(f.b, {
      expectedDatabase: f.target.database,
      expectedServerUuid: f.target.serverUuid,
      commit: "a".repeat(40),
      fence,
    });
    expect(result.readyVersion).toBe(1);
    await gate.assertLocked();
    const [[state]] = await f.b.query<any[]>(
      "SELECT readyVersion FROM inventoryProjectionState WHERE id=1",
    );
    expect(state.readyVersion).toBe(1);
    await gate.release();
  } finally {
    await f.finish();
  }
});

it("a remaining sleeping SQL session forbids READY even after its worker would be gone", async () => {
  const f = await fixture();
  try {
    const gate = await acquireInventoryGate(f.a, f.target);
    const orphan = await f.open();
    await orphan.query("SELECT 1");
    await expect(
      assertNoUnownedSessions(f.a, new Set([gate.connectionId, f.bId])),
    ).rejects.toThrow(/UNOWNED_DATABASE_SESSION/);
    await orphan.end();
    await assertNoUnownedSessions(f.a, new Set([gate.connectionId, f.bId]));
    await gate.release();
  } finally {
    await f.finish();
  }
});

it("missing singleton and wrong server identity refuse, lost A never reconnects", async () => {
  const f = await fixture();
  try {
    await expect(
      acquireInventoryGate(f.a, { ...f.target, serverUuid: "wrong" }),
    ).rejects.toThrow(/IDENTITY/);
    await f.b.query("DELETE FROM monthCloseSequence WHERE id=1");
    await expect(acquireInventoryGate(f.a, f.target)).rejects.toThrow(
      /MISSING/,
    );
    await f.b.query("INSERT INTO monthCloseSequence(id) VALUES(1)");
    const gate = await acquireInventoryGate(f.a, f.target);
    await f.a.end();
    await expect(gate.assertLocked()).rejects.toThrow();
    await expect(gate.release()).rejects.toThrow();
  } finally {
    await f.finish();
  }
});

it("real private boot attestation reads actual DB under A; startup remains held through PRE_RELEASE until committed release", async () => {
  const f = await fixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ia-boot-"));
  const priorEnv = process.env.NODE_ENV;
  let boot: Promise<void> | undefined;
  const file = path.join(temp, "journal.json"),
    bundle = path.join(temp, "candidate.js");
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ia-${randomUUID()}`
      : path.join(temp, "worker.sock");
  let j: any;
  try {
    fs.writeFileSync(bundle, "test-artifact-bytes");
    const hash = createHash("sha256")
      .update(fs.readFileSync(bundle))
      .digest("hex");
    j = {
      version: 1,
      id: randomUUID(),
      nonce: "a".repeat(64),
      commit: "b".repeat(40),
      phase: "CANDIDATES",
      ...f.target,
      artifacts: [
        {
          name: "erp-server",
          script: bundle,
          bundle: fs.realpathSync(bundle),
          hash,
          scriptHash: hash,
          instances: 1,
        },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(j), { mode: 0o600 });
    const gate = await acquireInventoryGate(f.a, f.target);
    let markHeld!: () => void,
      startupRan = false;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    process.env.NODE_ENV = "production";
    boot = awaitInventoryActivationRelease({
      name: "erp-server",
      bundle,
      journalFile: file,
      onHold: markHeld,
      transport: {
        startTime: "owned-test-start",
        socketPath,
        protectSocket: () => {},
      },
      readIdentity: async () => {
        const [[actual]] = await f.b.query<any[]>(
          "SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid",
        );
        return { database: actual.databaseName, serverUuid: actual.serverUuid };
      },
    }).then(() => {
      startupRan = true;
    });
    await held;
    const reply = await queryWorkerAttestation(socketPath, j.nonce);
    expect(reply).toMatchObject({
      pid: process.pid,
      hash,
      held: true,
      database: f.target.database,
      serverUuid: f.target.serverUuid,
      capability: "inventory-projection-v1-fenced-boot",
    });
    expect(startupRan).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ ...j, phase: "PRE_RELEASE" }));
    await gate.assertLocked();
    const second = await queryWorkerAttestation(socketPath, j.nonce);
    expect(second.held).toBe(true);
    expect(startupRan).toBe(false);
    await gate.release();
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...j,
        phase: "RELEASED",
        active: {
          readyVersion: 1,
          activationId: j.id,
          commit: j.commit,
          projectionCommit: j.commit,
          database: j.database,
          serverUuid: j.serverUuid,
          artifacts: j.artifacts,
        },
      }),
    );
    await boot;
    expect(startupRan).toBe(true);
  } finally {
    if (j && boot) {
      fs.writeFileSync(file, JSON.stringify({ ...j, phase: "FATAL" }));
      await boot.catch(() => {});
    }
    if (priorEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorEnv;
    await f.finish();
    fs.rmSync(temp, { recursive: true });
  }
});

it("compatible v1 failure retains approved ACTIVE web+HR across cold boot and NEXT deployment with the actual DB epoch", async () => {
  const f = await fixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ia-rollback-"));
  const file = path.join(temp, "erp-inventory-activation.json");
  const priorEnv = process.env.NODE_ENV;
  try {
    const artifacts = ["erp-server", "erp-hr-bridge"].map((name) => {
      const bundle = path.join(temp, `${name}-prior.js`);
      fs.writeFileSync(bundle, `compiled-${name}-prior-v1`);
      const hash = createHash("sha256")
        .update(fs.readFileSync(bundle))
        .digest("hex");
      return {
        name,
        bundle: fs.realpathSync(bundle),
        script: bundle,
        hash,
        scriptHash: hash,
        instances: 1,
      };
    });
    const candidates = artifacts.map((a) => {
      const bundle = path.join(temp, `${a.name}-candidate.js`);
      fs.writeFileSync(bundle, `compiled-${a.name}-candidate-v1`);
      const hash = createHash("sha256")
        .update(fs.readFileSync(bundle))
        .digest("hex");
      return {
        ...a,
        bundle: fs.realpathSync(bundle),
        script: bundle,
        hash,
        scriptHash: hash,
      };
    });
    const priorActive = {
      readyVersion: 1,
      activationId: randomUUID(),
      commit: "e".repeat(40),
      projectionCommit: "d".repeat(40),
      ...f.target,
      artifacts,
    };
    await f.b.query(
      "UPDATE inventoryProjectionState SET readyVersion=1,activatedCommit=?,activatedAt=CURRENT_TIMESTAMP WHERE id=1",
      [priorActive.projectionCommit],
    );
    const readState = async () =>
      (
        await f.b.query<any[]>(
          "SELECT readyVersion,activatedCommit FROM inventoryProjectionState WHERE id=1",
        )
      )[0][0];
    const readIdentity = async () => {
      const [[r]] = await f.b.query<any[]>(
        "SELECT DATABASE() AS databaseName,@@server_uuid AS serverUuid",
      );
      return { database: r.databaseName, serverUuid: r.serverUuid };
    };
    process.env.NODE_ENV = "production";
    const boot = async (a: any) =>
      awaitInventoryActivationRelease({
        name: a.name,
        bundle: a.bundle,
        journalFile: file,
        readIdentity,
      });
    const saveDump = (list: any[]) =>
      fs.writeFileSync(
        path.join(temp, "dump.pm2"),
        JSON.stringify(
          list.map((a) => ({ name: a.name, pm_exec_path: a.script })),
        ),
      );
    let restored = false;
    const operations = {
      preflight: async () => {},
      acquireGate: () => acquireInventoryGate(f.a, f.target),
      stopOld: async () => {},
      stopCandidates: async () => {},
      assertQuiescent: async () => {
        const [[a]] = await f.a.query<any[]>("SELECT CONNECTION_ID() AS id");
        await assertNoUnownedSessions(f.a, new Set([Number(a.id), f.bId]));
      },
      installCandidate: async () => {},
      startCandidates: async () => {},
      verifyCandidates: async () => {
        throw new Error("candidate-refused");
      },
      saveCompatibleRestartDefinitions: async () => saveDump(candidates),
      restoreArtifact: async () => {},
      restartOld: async () => {
        saveDump(artifacts);
        assertInventoryResurrection(temp);
        for (const a of artifacts) await boot(a);
        restored = true;
      },
    };
    const base = {
      version: 1,
      id: randomUUID(),
      nonce: "a".repeat(64),
      commit: "b".repeat(40),
      phase: "PREPARED",
      ...f.target,
      artifacts: candidates,
      priorArtifacts: artifacts,
      priorActive,
    };
    await expect(
      runInventoryActivation({
        journal: base,
        persist: (j: any) => writeActivationJournal(file, j),
        operations,
        connectionB: f.b,
        initialReadyVersion: 1,
      }),
    ).rejects.toThrow("candidate-refused");
    expect(restored).toBe(true);
    const rollback = readActivationJournal(file);
    expect(rollback.phase).toBe("ROLLED_BACK");
    expect(
      assertInventoryReadinessLifecycle(rollback, await readState()),
    ).toEqual(priorActive);
    // A second cold resurrection reads only durable artifacts/state, not controller memory.
    assertInventoryResurrection(temp);
    for (const a of artifacts) await boot(a);
    const badEpoch = {
      ...(await readState()),
      activatedCommit: "f".repeat(40),
    };
    expect(() => assertInventoryReadinessLifecycle(rollback, badEpoch)).toThrow(
      /LIFECYCLE/,
    );
    const wrongDb = {
      ...rollback,
      database: "other",
      active: { ...rollback.active, database: "other" },
    };
    writeActivationJournal(file, wrongDb);
    await expect(boot(artifacts[0])).rejects.toThrow(/DATABASE_MISMATCH/);
    const swapped = structuredClone(rollback);
    [swapped.active.artifacts[0].hash, swapped.active.artifacts[1].hash] = [
      swapped.active.artifacts[1].hash,
      swapped.active.artifacts[0].hash,
    ];
    swapped.priorArtifacts = structuredClone(swapped.active.artifacts);
    writeActivationJournal(file, swapped);
    expect(() => assertInventoryResurrection(temp)).toThrow(
      /ARTIFACT_MISMATCH/,
    );
    await expect(boot(artifacts[0])).rejects.toThrow(/ARTIFACT_MISMATCH/);
    writeActivationJournal(file, rollback);
    const nextPrior = assertInventoryReadinessLifecycle(
      readActivationJournal(file),
      await readState(),
    );
    const next = await runInventoryActivation({
      journal: {
        ...base,
        id: randomUUID(),
        commit: "c".repeat(40),
        priorActive: nextPrior,
      },
      initialReadyVersion: 1,
      connectionB: f.b,
      persist: (j: any) => writeActivationJournal(file, j),
      operations: { ...operations, verifyCandidates: async () => {} },
    });
    expect(next.phase).toBe("RELEASED");
    expect(next.active.projectionCommit).toBe(priorActive.projectionCommit);
    expect(
      assertInventoryReadinessLifecycle(
        readActivationJournal(file),
        await readState(),
      ),
    ).toEqual(next.active);
    assertInventoryResurrection(temp);
    for (const a of candidates) await boot(a);
  } finally {
    if (priorEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorEnv;
    await f.finish();
    fs.rmSync(temp, { recursive: true });
  }
});

it("actual Linux ownership adapter prevents native B READY for a late orphan with no SQL session", async () => {
  const f = await fixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ia-native-orphan-"));
  const procRoot = path.join(temp, "proc"),
    projectRoot = path.join(temp, "erp"),
    pm2Home = path.join(temp, "pm2");
  const helper = path.join(temp, "helper.mjs");
  const helperOwner = mockInstalledHelperOwner(helper);
  try {
    for (const dir of [
      procRoot,
      pm2Home,
      path.join(projectRoot, ".runtime"),
      path.join(projectRoot, "deploy/systemd"),
    ])
      fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(helper, "trusted-fixture-helper");
    fs.chmodSync(helper, 0o444);
    fs.writeFileSync(
      path.join(projectRoot, "deploy/systemd/pm2-systemd-start.mjs"),
      "trusted-fixture-helper",
    );
    const addPid = (pid: number, parent = 2) => {
      const dir = path.join(procRoot, String(pid));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "stat"),
        `${pid} (node) S ${parent} ${Array(17).fill("0").join(" ")} ${pid + 100} 0\n`,
      );
      fs.writeFileSync(
        path.join(dir, "status"),
        "Uid:\t1000\t1000\t1000\t1000\n",
      );
      fs.mkdirSync(path.join(dir, "cwd"));
      fs.writeFileSync(path.join(dir, "exe"), "node");
      fs.writeFileSync(path.join(dir, "cmdline"), `node-${pid}\0`);
    };
    addPid(2);
    addPid(10);
    addPid(90);
    fs.writeFileSync(
      path.join(procRoot, "2/cmdline"),
      `PM2 v7.0.3: God Daemon (${pm2Home})\0`,
    );
    fs.writeFileSync(path.join(pm2Home, "pm2.pid"), "2");
    const unrelated = {
      name: "unrelated",
      pm_id: 90,
      pid: 90,
      pm2_env: {
        pm_cwd: path.join(temp, "other"),
        pm_exec_path: path.join(temp, "other/index.js"),
      },
    };
    let rows = [
      {
        name: "erp-server",
        pm_id: 10,
        pid: 10,
        pm2_env: {
          pm_cwd: projectRoot,
          pm_exec_path: path.join(projectRoot, "old.js"),
        },
      },
      unrelated,
    ];
    const journal = {
      version: 1,
      id: randomUUID(),
      nonce: "a".repeat(64),
      commit: "b".repeat(40),
      phase: "PREPARED",
      ...f.target,
      artifacts: [
        {
          name: "erp-server",
          script: path.join(projectRoot, "candidate.js"),
          bundle: path.join(projectRoot, "candidate.js"),
          hash: "c".repeat(64),
          scriptHash: "c".repeat(64),
          instances: 1,
        },
      ],
    };
    const modulePath = path.resolve(
      "scripts/lib/inventory-activation-host.mjs",
    );
    const { createLinuxActivationOperations } = await import(
      pathToFileURL(modulePath).href
    );
    const op = createLinuxActivationOperations({
      projectRoot,
      pm2Home,
      procRoot,
      journal,
      connectionA: f.a,
      connectionB: f.b,
      candidateWebApp: { name: "erp-server" },
      uid: 1000,
      platform: "linux",
      externalWritersExcluded: true,
      installedHelperPath: helper,
      drainTimeoutMs: 10,
      execute(command: string, args: string[]) {
        if (command === "systemctl") return helper;
        if (args[0] === "jlist") return JSON.stringify(rows);
        if (args[0] === "delete") {
          expect(args[1]).toBe("10");
          fs.rmSync(path.join(procRoot, "10"), { recursive: true });
          rows = [unrelated];
          addPid(88, 1);
        }
        if (args[0] === "save")
          fs.writeFileSync(
            path.join(pm2Home, "dump.pm2"),
            JSON.stringify(rows.map((r) => ({ ...r.pm2_env, name: r.name }))),
          );
        return "";
      },
    });
    await f.b.query(
      "UPDATE inventoryProjectionState SET readyVersion=0,activatedCommit=NULL,activatedAt=NULL WHERE id=1",
    );
    await op.preflight();
    const gate = await op.acquireGate();
    let refused = false;
    try {
      await op.stopOld();
      await activateInventoryProjection(f.b, {
        expectedDatabase: f.target.database,
        expectedServerUuid: f.target.serverUuid,
        commit: journal.commit,
        fence: {
          async assertQuiescentAndLocked() {
            await gate.assertLocked();
            await op.assertQuiescent();
            await gate.assertLocked();
          },
        },
      });
    } catch (error) {
      expect(String(error)).toMatch(/UNCLASSIFIED|PROCESS_REMAINS|STILL_ALIVE/);
      refused = true;
    }
    const [[state]] = await f.b.query<any[]>(
      "SELECT readyVersion FROM inventoryProjectionState WHERE id=1",
    );
    expect(state.readyVersion).toBe(0);
    expect(refused).toBe(true);
    expect(rows).toEqual([unrelated]);
    await gate.assertLocked();
    await gate.release();
  } finally {
    helperOwner.restore();
    await f.finish();
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o600);
    fs.rmSync(temp, { recursive: true });
  }
});
