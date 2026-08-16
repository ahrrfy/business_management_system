#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const releaseTools = require("./hr-bridge-release.cjs");
const activation = require("./hr-bridge-activation.cjs");
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "hr-bridge-deployment-selftest-"),
);
const sentinel = "deployment-selftest-secret-canary";

function writeFixtureSources(marker) {
  fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "dist"), { recursive: true });
  const files = {
    "scripts/hr-bridge-release-worker.mjs": `export const marker = ${JSON.stringify(marker)};\n`,
    "scripts/hr-bridge-runtime-policy.cjs": `module.exports = { marker: ${JSON.stringify(marker)}, allowedEnvironmentKeys: ["NODE_ENV", "TZ", "HR_BRIDGE_LOAD_DOTENV", "DATABASE_URL", "HR_DEVICE_BRIDGE", "HR_DEVICE_PORT"] };\n`,
    "scripts/hr-bridge-mode.cjs": fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "hr-bridge-mode.cjs"),
      "utf8",
    ),
    "scripts/hr-bridge-pm2-app.cjs": `module.exports = () => ({ marker: ${JSON.stringify(marker)} });\n`,
    "scripts/hr-bridge-pm2.config.cjs": `module.exports = { marker: ${JSON.stringify(marker)} };\n`,
    "dist/hr-bridge-worker.cjs": `exports.runHrBridgeWorker = () => ${JSON.stringify(marker)};\n`,
  };
  for (const [relative, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(fixtureRoot, relative), contents, "utf8");
  }
}

function fixtureEnvironment(databaseUrl = sentinel, extra = {}) {
  return {
    HR_DEVICE_PORT: "7788",
    DATABASE_URL: databaseUrl,
    HR_DEVICE_BRIDGE: "0",
    TZ: "UTC",
    NODE_ENV: "production",
    HR_BRIDGE_LOAD_DOTENV: "0",
    ...extra,
  };
}

function prepare(sourceCommit, environment = fixtureEnvironment()) {
  return releaseTools.prepareRelease(fixtureRoot, {
    sourceCommit,
    deploymentEnvironment: environment,
  });
}

function expectCode(code, action) {
  assert.throws(action, (error) => error?.message === code);
}

async function verifyConcurrentIntentLock(namespace) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `hr-bridge-${namespace}-lock-race-`),
  );
  try {
    const lockDirectory = path.join(
      releaseTools.runtimeRoot(root),
      `${namespace}-locks`,
    );
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    const stalePid = 2_147_483_647;
    const staleToken = "00000000-0000-4000-8000-000000000001";
    fs.writeFileSync(
      path.join(lockDirectory, `${stalePid}-${staleToken}.json`),
      `${JSON.stringify({
        version: 1,
        namespace,
        token: staleToken,
        createdNs: "1",
        held: true,
        pids: [stalePid],
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const gate = path.join(root, "gate");
    const winner = path.join(root, "winner");
    const childSource = String.raw`
const fs = require("node:fs");
const tools = require(process.argv[1]);
const [root, namespace, gate, winner] = process.argv.slice(2);
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.writeFileSync(gate + "." + process.pid + ".ready", "ready\n", { flag: "wx" });
while (!fs.existsSync(gate)) wait(10);
try {
  const unlock = tools.acquireRuntimeIntentLock(root, namespace);
  try {
    fs.writeFileSync(winner, String(process.pid), { flag: "wx" });
    process.stdout.write("WINNER\n");
    wait(750);
  } finally { unlock(); }
} catch (error) {
  const expected = namespace === "sync"
    ? "HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING"
    : "HR_BRIDGE_DEPLOY_ALREADY_RUNNING";
  if (error?.message !== expected) throw error;
  process.stdout.write("BLOCKED\n");
}`;
    const children = [0, 1].map(() =>
      spawn(
        process.execPath,
        [
          "-e",
          childSource,
          path.join(path.dirname(fileURLToPath(import.meta.url)), "hr-bridge-release.cjs"),
          root,
          namespace,
          gate,
          winner,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const deadline = Date.now() + 10_000;
    while (
      fs.readdirSync(root).filter((name) => name.endsWith(".ready")).length < 2
    ) {
      if (Date.now() >= deadline) throw new Error("LOCK_RACE_READY_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(gate, "go\n", { flag: "wx" });
    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => (stdout += String(chunk)));
            child.stderr.on("data", (chunk) => (stderr += String(chunk)));
            child.once("error", reject);
            child.once("exit", (status) => resolve({ status, stdout, stderr }));
          }),
      ),
    );
    assert.deepEqual(results.map((result) => result.status), [0, 0]);
    assert.equal(results.filter((result) => /WINNER/.test(result.stdout)).length, 1);
    assert.equal(results.filter((result) => /BLOCKED/.test(result.stdout)).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function verifyHeldIntentHasPriority(namespace) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `hr-bridge-${namespace}-held-priority-`),
  );
  try {
    const directory = path.join(
      releaseTools.runtimeRoot(root),
      `${namespace}-locks`,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const token = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    fs.writeFileSync(
      path.join(directory, `${process.pid}-${token}.json`),
      `${JSON.stringify({
        version: 1,
        namespace,
        token,
        createdNs: "9".repeat(30),
        held: true,
        pids: [process.pid],
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    expectCode(
      namespace === "sync"
        ? "HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING"
        : "HR_BRIDGE_DEPLOY_ALREADY_RUNNING",
      () => releaseTools.acquireRuntimeIntentLock(root, namespace),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function operations(events, failure = null) {
  let failed = false;
  return {
    stop() {
      events.push("stop");
    },
    start(descriptor) {
      events.push(`start:${descriptor.id}:${descriptor.mode}`);
    },
    verify(descriptor) {
      const mode = descriptor?.mode ?? "disabled";
      events.push(`verify:${mode}`);
      if (failure?.(descriptor, failed)) {
        failed = true;
        throw new Error("SIMULATED_GATE_FAILURE");
      }
    },
    save() {
      events.push("save");
    },
  };
}

try {
  writeFixtureSources("first");
  const first = prepare("a".repeat(40));
  assert.equal(prepare(null).id, first.id);
  assert.equal(releaseTools.validateRelease(fixtureRoot, first.id).id, first.id);
  assert.equal(
    releaseTools.loadReleaseEnvironment(fixtureRoot, first.id).DATABASE_URL,
    sentinel,
  );
  const reordered = prepare(null, {
    HR_BRIDGE_LOAD_DOTENV: "0",
    NODE_ENV: "production",
    HR_DEVICE_BRIDGE: "0",
    DATABASE_URL: sentinel,
    TZ: "UTC",
    HR_DEVICE_PORT: "7788",
  });
  assert.equal(reordered.id, first.id);
  assert.equal(
    prepare(null, fixtureEnvironment(sentinel, { UNKNOWN_SHARED_SECRET: "ignored" })).id,
    first.id,
  );
  assert.notEqual(prepare(null, fixtureEnvironment("changed-allowed-value")).id, first.id);
  assert.equal(
    fs.readFileSync(first.manifestPath, "utf8").includes(sentinel),
    false,
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(first.environmentPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
  }

  const originalManifest = fs.readFileSync(first.manifestPath, "utf8");
  const manifestWithExtraTopLevel = JSON.parse(originalManifest);
  manifestWithExtraTopLevel.unexpected = "must-be-rejected";
  fs.writeFileSync(
    first.manifestPath,
    `${JSON.stringify(manifestWithExtraTopLevel, null, 2)}\n`,
  );
  expectCode("HR_BRIDGE_RELEASE_MANIFEST_INVALID", () =>
    releaseTools.validateRelease(fixtureRoot, first.id),
  );
  const manifestWithExtraFile = JSON.parse(originalManifest);
  manifestWithExtraFile.files.unexpected = "0".repeat(64);
  fs.writeFileSync(
    first.manifestPath,
    `${JSON.stringify(manifestWithExtraFile, null, 2)}\n`,
  );
  expectCode("HR_BRIDGE_RELEASE_MANIFEST_INVALID", () =>
    releaseTools.validateRelease(fixtureRoot, first.id),
  );
  fs.writeFileSync(first.manifestPath, originalManifest);
  releaseTools.validateRelease(fixtureRoot, first.id);

  for (const invalidPort of ["abc", "0", "70000"]) {
    expectCode("HR_BRIDGE_RELEASE_ENVIRONMENT_CONFIG_INVALID", () =>
      prepare(null, fixtureEnvironment(sentinel, { HR_DEVICE_PORT: invalidPort })),
    );
  }

  const unexpected = path.join(first.directory, "unexpected.txt");
  fs.writeFileSync(unexpected, "unexpected", "utf8");
  expectCode("HR_BRIDGE_RELEASE_CONTENTS_INVALID", () =>
    releaseTools.validateRelease(fixtureRoot, first.id),
  );
  fs.unlinkSync(unexpected);

  const originalArtifact = fs.readFileSync(first.artifactPath);
  fs.appendFileSync(first.artifactPath, "// tampered\n");
  expectCode("HR_BRIDGE_RELEASE_HASH_MISMATCH", () =>
    releaseTools.validateRelease(fixtureRoot, first.id),
  );
  fs.writeFileSync(first.artifactPath, originalArtifact);
  releaseTools.validateRelease(fixtureRoot, first.id);

  const originalEnvironment = fs.readFileSync(first.environmentPath);
  fs.appendFileSync(first.environmentPath, " ");
  expectCode("HR_BRIDGE_RELEASE_HASH_MISMATCH", () =>
    releaseTools.validateRelease(fixtureRoot, first.id),
  );
  fs.writeFileSync(first.environmentPath, originalEnvironment);
  releaseTools.validateRelease(fixtureRoot, first.id);
  if (process.platform !== "win32") {
    const environmentBackup = path.join(fixtureRoot, "environment-backup.json");
    fs.renameSync(first.environmentPath, environmentBackup);
    fs.symlinkSync(environmentBackup, first.environmentPath, "file");
    expectCode("HR_BRIDGE_RELEASE_FILE_INVALID", () =>
      releaseTools.validateRelease(fixtureRoot, first.id),
    );
    fs.unlinkSync(first.environmentPath);
    fs.renameSync(environmentBackup, first.environmentPath);
    releaseTools.validateRelease(fixtureRoot, first.id);
  }

  writeFixtureSources("second");
  const second = prepare(
    "b".repeat(40),
    fixtureEnvironment("second-secret", {
      HR_DEVICE_PORT: "",
      HR_DEVICE_BRIDGE: "0",
    }),
  );
  assert.notEqual(second.id, first.id);
  assert.equal(
    releaseTools.loadReleaseEnvironment(fixtureRoot, first.id).DATABASE_URL,
    sentinel,
  );
  assert.equal(
    releaseTools.loadReleaseEnvironment(fixtureRoot, second.id).DATABASE_URL,
    "second-secret",
  );

  const firstDescriptor = { id: first.id, mode: "enabled" };
  const secondDisabled = { id: second.id, mode: "disabled" };
  expectCode("HR_BRIDGE_RELEASE_CANDIDATE_MODE_MISMATCH", () =>
    releaseTools.beginActivation(fixtureRoot, {
      id: first.id,
      mode: "disabled",
    }),
  );
  const firstEvents = [];
  activation.activateBridgeRelease(
    fixtureRoot,
    firstDescriptor,
    operations(firstEvents),
  );
  assert.deepEqual(firstEvents, [
    "verify:disabled",
    "stop",
    `start:${first.id}:enabled`,
    "verify:enabled",
    "save",
  ]);
  assert.deepEqual(releaseTools.readState(fixtureRoot).current, firstDescriptor);

  const disabledEvents = [];
  activation.activateBridgeRelease(
    fixtureRoot,
    secondDisabled,
    operations(disabledEvents),
  );
  assert.deepEqual(disabledEvents, ["stop", "verify:disabled", "save"]);
  let state = releaseTools.readState(fixtureRoot);
  assert.deepEqual(state.current, secondDisabled);
  assert.deepEqual(state.previous, firstDescriptor);

  const rollbackEvents = [];
  assert.throws(
    () =>
      activation.activateBridgeRelease(
        fixtureRoot,
        firstDescriptor,
        operations(
          rollbackEvents,
          (descriptor, failed) => descriptor?.mode === "enabled" && !failed,
        ),
      ),
    (error) =>
      error instanceof activation.BridgeActivationError &&
      error.code === "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_OK",
  );
  assert.deepEqual(rollbackEvents, [
    "stop",
    `start:${first.id}:enabled`,
    "verify:enabled",
    "stop",
    "verify:disabled",
    "save",
  ]);
  state = releaseTools.readState(fixtureRoot);
  assert.deepEqual(state.current, secondDisabled);
  assert.equal(state.pending, null);

  const failedRollbackEvents = [];
  assert.throws(
    () =>
      activation.activateBridgeRelease(
        fixtureRoot,
        firstDescriptor,
        operations(failedRollbackEvents, () => true),
      ),
    (error) =>
      error instanceof activation.BridgeActivationError &&
      error.code === "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_FAILED",
  );
  state = releaseTools.readState(fixtureRoot);
  assert.equal(state.pending?.phase, "rolling-back");
  const recoveryEvents = [];
  assert.equal(
    activation.recoverInterruptedActivation(
      fixtureRoot,
      operations(recoveryEvents),
    ),
    true,
  );
  assert.deepEqual(recoveryEvents, ["stop", "verify:disabled", "save"]);
  assert.equal(releaseTools.readState(fixtureRoot).pending, null);

  const noBaselineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hr-bridge-no-baseline-selftest-"),
  );
  try {
    fs.cpSync(path.join(fixtureRoot, "scripts"), path.join(noBaselineRoot, "scripts"), {
      recursive: true,
    });
    fs.cpSync(path.join(fixtureRoot, "dist"), path.join(noBaselineRoot, "dist"), {
      recursive: true,
    });
    const noBaselineRelease = releaseTools.prepareRelease(noBaselineRoot, {
      sourceCommit: "c".repeat(40),
      deploymentEnvironment: fixtureEnvironment("no-baseline-secret"),
    });
    const noBaselineEvents = [];
    assert.throws(
      () =>
        activation.activateBridgeRelease(
          noBaselineRoot,
          { id: noBaselineRelease.id, mode: "enabled" },
          operations(
            noBaselineEvents,
            (descriptor, failed) => descriptor?.mode === "enabled" && !failed,
          ),
        ),
      (error) =>
        error instanceof activation.BridgeActivationError &&
        error.code === "HR_BRIDGE_ACTIVATION_FAILED_NO_BASELINE",
    );
    assert.deepEqual(noBaselineEvents, [
      "verify:disabled",
      "stop",
      `start:${noBaselineRelease.id}:enabled`,
      "verify:enabled",
      "stop",
      "verify:disabled",
      "save",
    ]);
    assert.equal(releaseTools.readState(noBaselineRoot).current, null);

    const adoptionEvents = [];
    let candidateFailed = false;
    const adoptionOperations = {
      ...operations(adoptionEvents),
      verify(descriptor) {
        adoptionEvents.push(`verify:${descriptor?.mode ?? "disabled"}`);
        if (!candidateFailed) {
          candidateFailed = true;
          throw new Error("SIMULATED_ADOPTION_CANDIDATE_FAILURE");
        }
      },
      verifyLegacy() {
        adoptionEvents.push("verify-legacy");
      },
      startLegacy() {
        adoptionEvents.push("start-legacy");
      },
      beginAdoptionJournal() {
        adoptionEvents.push("journal-begin");
      },
      finishAdoptionJournal() {
        adoptionEvents.push("journal-finish");
      },
    };
    assert.throws(
      () =>
        activation.adoptLegacyBridgeBaseline(
          noBaselineRoot,
          { id: noBaselineRelease.id, mode: "enabled" },
          adoptionOperations,
        ),
      (error) =>
        error instanceof activation.BridgeActivationError &&
        error.code === "HR_BRIDGE_ADOPTION_FAILED_LEGACY_RESTORED",
    );
    assert.deepEqual(adoptionEvents, [
      "verify-legacy",
      "journal-begin",
      "stop",
      `start:${noBaselineRelease.id}:enabled`,
      "verify:enabled",
      "stop",
      "start-legacy",
      "verify-legacy",
      "save",
      "journal-finish",
    ]);
    assert.equal(releaseTools.readState(noBaselineRoot).current, null);

    const unhealthyEvents = [];
    let unhealthyCandidateFailed = false;
    const unhealthyOperations = {
      ...operations(unhealthyEvents),
      legacyHealth: "unhealthy",
      verify(descriptor) {
        unhealthyEvents.push(`verify:${descriptor?.mode ?? "disabled"}`);
        if (!unhealthyCandidateFailed) {
          unhealthyCandidateFailed = true;
          throw new Error("SIMULATED_UNHEALTHY_ADOPTION_FAILURE");
        }
      },
      verifyLegacy() {
        unhealthyEvents.push("verify-legacy-unhealthy");
      },
      startLegacy() {
        unhealthyEvents.push("start-legacy");
      },
      beginAdoptionJournal() {
        unhealthyEvents.push("journal-begin");
      },
      finishAdoptionJournal() {
        unhealthyEvents.push("journal-finish");
      },
    };
    assert.throws(
      () =>
        activation.adoptLegacyBridgeBaseline(
          noBaselineRoot,
          { id: noBaselineRelease.id, mode: "enabled" },
          unhealthyOperations,
        ),
      (error) =>
        error instanceof activation.BridgeActivationError &&
        error.code ===
          "HR_BRIDGE_ADOPTION_FAILED_UNHEALTHY_LEGACY_RESTORED",
    );
    assert.equal(releaseTools.readState(noBaselineRoot).current, null);

    const disabledRelease = releaseTools.prepareRelease(noBaselineRoot, {
      sourceCommit: "e".repeat(40),
      deploymentEnvironment: fixtureEnvironment("disabled-adoption", {
        HR_DEVICE_PORT: "",
        HR_DEVICE_BRIDGE: "0",
      }),
    });
    const disabledAdoptionEvents = [];
    const disabledAdoptionOperations = {
      ...operations(disabledAdoptionEvents),
      verifyLegacy() {
        disabledAdoptionEvents.push("verify-legacy");
      },
      startLegacy() {
        disabledAdoptionEvents.push("start-legacy");
      },
      beginAdoptionJournal() {
        disabledAdoptionEvents.push("journal-begin");
      },
      finishAdoptionJournal() {
        disabledAdoptionEvents.push("journal-finish");
      },
    };
    activation.adoptLegacyBridgeBaseline(
      noBaselineRoot,
      { id: disabledRelease.id, mode: "disabled" },
      disabledAdoptionOperations,
    );
    assert.deepEqual(disabledAdoptionEvents, [
      "verify-legacy",
      "journal-begin",
      "stop",
      "verify:disabled",
      "save",
      "journal-finish",
    ]);
  } finally {
    fs.rmSync(noBaselineRoot, { recursive: true, force: true });
  }

  const staged = releaseTools.beginActivation(fixtureRoot, firstDescriptor);
  const stagedRecoveryEvents = [];
  activation.recoverInterruptedActivation(
    fixtureRoot,
    operations(stagedRecoveryEvents),
  );
  assert.deepEqual(stagedRecoveryEvents, []);
  expectCode("HR_BRIDGE_RELEASE_TRANSACTION_MISMATCH", () =>
    releaseTools.markActivationPhase(
      fixtureRoot,
      staged.txId,
      "switching",
    ),
  );

  const releaseLock = releaseTools.acquireDeploymentLock(fixtureRoot);
  expectCode("HR_BRIDGE_DEPLOY_ALREADY_RUNNING", () =>
    releaseTools.acquireDeploymentLock(fixtureRoot),
  );
  releaseLock();
  releaseTools.acquireDeploymentLock(fixtureRoot)();
  await verifyConcurrentIntentLock("deploy");
  await verifyConcurrentIntentLock("sync");
  verifyHeldIntentHasPriority("deploy");
  verifyHeldIntentHasPriority("sync");

  const retentionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hr-bridge-retention-selftest-"),
  );
  try {
    fs.cpSync(path.join(fixtureRoot, "scripts"), path.join(retentionRoot, "scripts"), {
      recursive: true,
    });
    fs.cpSync(path.join(fixtureRoot, "dist"), path.join(retentionRoot, "dist"), {
      recursive: true,
    });
    const retentionReleases = [];
    for (let index = 0; index < 5; index += 1) {
      writeFixtureSources(`retention-${index}`);
      fs.cpSync(path.join(fixtureRoot, "scripts"), path.join(retentionRoot, "scripts"), {
        recursive: true,
        force: true,
      });
      fs.cpSync(path.join(fixtureRoot, "dist"), path.join(retentionRoot, "dist"), {
        recursive: true,
        force: true,
      });
      retentionReleases.push(
        releaseTools.prepareRelease(retentionRoot, {
          sourceCommit: String(index + 1).repeat(40),
          deploymentEnvironment: fixtureEnvironment(`retention-${index}`),
        }),
      );
    }
    releaseTools.establishBaseline(retentionRoot, {
      id: retentionReleases[0].id,
      mode: "enabled",
    });
    const tx = releaseTools.beginActivation(retentionRoot, {
      id: retentionReleases[1].id,
      mode: "enabled",
    });
    const skipped = releaseTools.pruneBridgeReleasesAfterCommit(retentionRoot, {
      committedCandidateId: retentionReleases[0].id,
      keepRecent: 0,
    });
    assert.equal(skipped.skipped, true);
    assert.equal(retentionReleases.every((release) => fs.existsSync(release.directory)), true);
    releaseTools.abortActivation(retentionRoot, tx.txId);
    let injectedDelete = false;
    const failedRetention = releaseTools.pruneBridgeReleasesAfterCommit(
      retentionRoot,
      {
        committedCandidateId: retentionReleases[0].id,
        keepRecent: 0,
        removeRelease() {
          injectedDelete = true;
          throw new Error("SIMULATED_RETENTION_DELETE_FAILURE");
        },
      },
    );
    assert.equal(injectedDelete, true);
    assert.equal(failedRetention.failed, 1);
    assert.equal(fs.existsSync(retentionReleases[0].directory), true);
    const retained = releaseTools.pruneBridgeReleasesAfterCommit(retentionRoot, {
      committedCandidateId: retentionReleases[0].id,
      keepRecent: 1,
    });
    assert.equal(retained.failed, 0);
    assert.equal(fs.existsSync(retentionReleases[0].directory), true);
    assert.equal(
      retentionReleases.filter((release) => fs.existsSync(release.directory)).length,
      2,
    );
  } finally {
    fs.rmSync(retentionRoot, { recursive: true, force: true });
  }

  if (process.platform !== "win32") {
    const makeDurabilityFixture = (suffix) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `hr-bridge-durability-${suffix}-`),
      );
      fs.cpSync(path.join(fixtureRoot, "scripts"), path.join(root, "scripts"), {
        recursive: true,
      });
      fs.cpSync(path.join(fixtureRoot, "dist"), path.join(root, "dist"), {
        recursive: true,
      });
      const release = releaseTools.prepareRelease(root, {
        sourceCommit: "d".repeat(40),
        deploymentEnvironment: fixtureEnvironment(`durability-${suffix}`),
      });
      return { root, release };
    };
    const withDirectoryFsyncFault = (shouldFail, action) => {
      const originalFsync = fs.fsyncSync;
      let directoryCall = 0;
      fs.fsyncSync = (fd) => {
        if (fs.fstatSync(fd).isDirectory()) {
          directoryCall += 1;
          if (shouldFail(directoryCall)) {
            const error = new Error("SIMULATED_DIRECTORY_FSYNC_FAILURE");
            error.code = "EIO";
            throw error;
          }
        }
        return originalFsync(fd);
      };
      try {
        return action();
      } finally {
        fs.fsyncSync = originalFsync;
      }
    };

    const retryFixture = makeDurabilityFixture("retry");
    try {
      withDirectoryFsyncFault(
        (directoryCall) => directoryCall === 1,
        () =>
          releaseTools.establishBaseline(retryFixture.root, {
            id: retryFixture.release.id,
            mode: "enabled",
          }),
      );
      assert.equal(
        releaseTools.readState(retryFixture.root).current?.id,
        retryFixture.release.id,
      );
    } finally {
      fs.rmSync(retryFixture.root, { recursive: true, force: true });
    }

    const persistentFixture = makeDurabilityFixture("persistent");
    try {
      assert.throws(
        () =>
          withDirectoryFsyncFault(
            (directoryCall) => directoryCall >= 5,
            () =>
              activation.activateBridgeRelease(
                persistentFixture.root,
                { id: persistentFixture.release.id, mode: "enabled" },
                operations([]),
              ),
          ),
        (error) =>
          error instanceof activation.BridgeActivationError &&
          error.code ===
            "HR_BRIDGE_ACTIVATION_COMMIT_DURABILITY_UNCERTAIN",
      );
      releaseTools.ensureStateDurable(persistentFixture.root);
    } finally {
      fs.rmSync(persistentFixture.root, { recursive: true, force: true });
    }
  }

  const syncLockSelftest = spawnSync(
    process.execPath,
    [path.join(path.dirname(fileURLToPath(import.meta.url)), "deploy.mjs"), "--selftest-sync-lock"],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(syncLockSelftest.status, 0, syncLockSelftest.stderr);
  assert.match(syncLockSelftest.stdout, /fenced stale race passed/);
  const prePullGuardSelftest = spawnSync(
    process.execPath,
    [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "deploy.mjs"),
      "--selftest-prepull-guard",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(prePullGuardSelftest.status, 0, prePullGuardSelftest.stderr);
  assert.match(prePullGuardSelftest.stdout, /legacy dump blocks source mutation/);
  const pm2ContractSelftest = spawnSync(
    process.execPath,
    [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "hr-bridge-pm2-contract.cjs",
      ),
      "--selftest",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(pm2ContractSelftest.status, 0, pm2ContractSelftest.stderr);
  assert.match(pm2ContractSelftest.stdout, /pm2 contract selftest: passed/);
  const controlEnvironmentSelftest = spawnSync(
    process.execPath,
    [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "deploy.mjs"),
      "--selftest-control-environment",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "--trace-warnings",
        NODE_PATH: "deployment-selftest-node-path-canary",
        HR_BRIDGE_PRELOAD_CANARY: "1",
      },
    },
  );
  assert.equal(
    controlEnvironmentSelftest.status,
    0,
    controlEnvironmentSelftest.stderr,
  );
  assert.match(
    controlEnvironmentSelftest.stdout,
    /NODE_OPTIONS\/NODE_PATH stripped/,
  );
  const adoptionDumpContextSelftest = spawnSync(
    process.execPath,
    [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "adopt-hr-bridge-legacy.mjs",
      ),
      "--selftest-dump-context",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    adoptionDumpContextSelftest.status,
    0,
    adoptionDumpContextSelftest.stderr,
  );
  assert.match(
    adoptionDumpContextSelftest.stdout,
    /disabled candidate \+ legacy rollback passed/,
  );
  const adoptionDefinitionTransportSelftest = spawnSync(
    process.execPath,
    [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "adopt-hr-bridge-legacy.mjs",
      ),
      "--selftest-legacy-definition",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    adoptionDefinitionTransportSelftest.status,
    0,
    adoptionDefinitionTransportSelftest.stderr,
  );
  assert.match(
    adoptionDefinitionTransportSelftest.stdout,
    /noisy stdout and scalar stop exit code normalized/,
  );

  assert.equal(fs.readFileSync(first.environmentPath, "utf8").includes(sentinel), true);
  for (const file of [first.manifestPath, second.manifestPath, path.join(releaseTools.runtimeRoot(fixtureRoot), "state.json")]) {
    assert.equal(fs.readFileSync(file, "utf8").includes(sentinel), false);
  }

  console.log("hr bridge deployment selftest: release integrity + state + rollback passed");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
