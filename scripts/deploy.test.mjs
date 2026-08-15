import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const {
  cleanupWebCandidate,
  commitWebArtifact,
  hasPendingWebActivation,
  installWebCandidate,
  isWebCandidateActive,
  prepareWebCandidate,
  pruneWebArtifactSnapshots,
  recoverPendingWebActivation,
  rollbackWebArtifact,
  snapshotWebArtifact,
  verifyRollbackWebArtifactCompatibility,
} = await import("./deploy.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploySource = fs.readFileSync(
  path.join(root, "scripts/deploy.mjs"),
  "utf8",
);
const ecosystemSource = fs.readFileSync(
  path.join(root, "ecosystem.config.cjs"),
  "utf8",
);
assert.match(
  ecosystemSource,
  /script:\s*"\.runtime\/web-current\/index\.js"/,
  "PM2 must boot the server through the atomically replaceable immutable-release link",
);

const liveContractIndex = deploySource.indexOf(
  'step("0/12 مطابقة عقد Nginx الحي',
);
const dependenciesIndex = deploySource.indexOf('step("1/12 تثبيت الاعتماديات');
const candidateIndex = deploySource.indexOf("prepareWebCandidate(PROJECT_ROOT");
const swapIndex = deploySource.indexOf(
  "installWebCandidate(webArtifact, webCandidate)",
);
const reloadIndex = deploySource.indexOf("reloadWebProcess();", swapIndex);
const smokeIndex = deploySource.indexOf(
  "verify-nginx-storefront-readiness.mjs",
);
const webCommitIndex = deploySource.indexOf("commitWebArtifact(webArtifact)");
const schemaVerifyIndex = deploySource.indexOf('run("pnpm", ["db:verify"]');
const rollbackWebPreflightIndex = deploySource.indexOf(
  "await verifyRollbackWebArtifactCompatibility(",
);
assert.ok(
  liveContractIndex >= 0 && liveContractIndex < dependenciesIndex,
  "live nginx drift must stop deployment before install/build/database steps",
);
assert.ok(
  candidateIndex > dependenciesIndex,
  "web must build in an isolated candidate after locked dependencies exist",
);
assert.ok(
  swapIndex > candidateIndex && reloadIndex > swapIndex,
  "candidate directory must swap atomically immediately before reload",
);
assert.ok(
  rollbackWebPreflightIndex > schemaVerifyIndex &&
    rollbackWebPreflightIndex < swapIndex,
  "the previous web release must pass a real schema/API preflight after migrations and before any live swap",
);
assert.ok(reloadIndex >= 0, "deployment must reload the web process");
assert.ok(
  smokeIndex > reloadIndex,
  "external storefront smoke must run after the web reload",
);
assert.ok(
  webCommitIndex > smokeIndex,
  "the durable web activation journal must commit only after external smoke succeeds",
);
assert.ok(
  deploySource.indexOf("await recoverPendingWebActivationBeforePull();") <
    deploySource.indexOf(
      "const expectedHead = synchronizeAndMaybeReexec(releaseSyncLock)",
    ),
  "an interrupted web activation must recover before git pull or a new snapshot",
);
assert.ok(
  deploySource.indexOf('step("11/12 تفعيل إصدار الجسر والتحقق والحفظ الذري"') >
    smokeIndex,
  "external storefront smoke must finish before the deployment is committed",
);
assert.match(
  deploySource,
  /verify-nginx-abuse-controls\.mjs/,
  "deployment must run the static nginx contract before mutable steps",
);
assert.match(
  deploySource,
  /sourceRoot: webCandidate\.sourceRoot/,
  "HR bridge release must use the isolated candidate artifact",
);
assert.match(
  deploySource,
  /NGINX_LIVE_CONTRACT_DRIFT/,
  "ordinary deployment must diagnose live nginx drift without attempting sudo",
);
assert.match(
  deploySource,
  /WEB_STOREFRONT_SMOKE_FAILED_ROLLBACK_OK/,
  "smoke failure must have an explicit successful-rollback terminal state",
);
const rollbackPreflightEnvironmentBlock = deploySource.slice(
  deploySource.indexOf("function defaultRollbackPreflightOperations"),
  deploySource.indexOf(
    "export async function verifyRollbackWebArtifactCompatibility",
  ),
);
assert.match(
  rollbackPreflightEnvironmentBlock,
  /\.\.\.controlSubprocessEnvironment\(\)/,
  "the isolated rollback probe must receive only the deployment control allowlist",
);
assert.match(
  rollbackPreflightEnvironmentBlock,
  /\.\.\.forbiddenEnvironment/,
  "dotenv-visible privileged keys must be shadowed with empty values in the probe",
);
assert.doesNotMatch(
  rollbackPreflightEnvironmentBlock,
  /\.\.\.process\.env/,
  "the isolated rollback probe must not inherit privileged or preload environment keys",
);
for (const key of [
  "DB_ROOT_PW",
  "DB_CONTAINER",
  "DB_APP_PW",
  "DB_CONTROL_PW",
  "ADMIN_PASSWORD",
]) {
  assert.match(
    deploySource.slice(0, deploySource.indexOf("function codedError")),
    new RegExp(`"${key}"`),
    `rollback probe must fence ${key} before dotenv can populate it`,
  );
}

const selftest = spawnSync(
  process.execPath,
  ["scripts/verify-nginx-storefront-readiness.mjs", "--selftest"],
  {
    cwd: root,
    encoding: "utf8",
  },
);
assert.equal(selftest.status, 0, `${selftest.stdout}\n${selftest.stderr}`);

const artifactRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "web-artifact-rollback-test-"),
);
try {
  fs.mkdirSync(path.join(artifactRoot, "dist/public"), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "dist/index.js"), "previous-server");
  fs.writeFileSync(
    path.join(artifactRoot, "dist/public/index.html"),
    "previous-client",
  );
  const snapshot = snapshotWebArtifact(artifactRoot, {
    id: "web-100-previous",
  });
  const activeTarget = () =>
    path.resolve(
      path.dirname(snapshot.activeLinkPath),
      fs.readlinkSync(snapshot.activeLinkPath),
    );
  assert.equal(fs.lstatSync(snapshot.activeLinkPath).isSymbolicLink(), true);
  assert.equal(activeTarget(), snapshot.previousPath);
  const calls = [];
  const preflightEnvironment = {
    REQUIRE_INTERNAL_PROXY_SECRET: "0",
  };
  const preflightOperations = {
    reservePort: async () => 31_337,
    start: async () => {
      calls.push("preflight-start");
      return { fake: true };
    },
    probe: async (_child, context) => {
      calls.push(`preflight-probe:${context.port}`);
    },
    stop: async () => calls.push("preflight-stop"),
  };
  await verifyRollbackWebArtifactCompatibility(snapshot, preflightEnvironment, {
    operations: preflightOperations,
  });
  assert.deepEqual(calls, [
    "preflight-start",
    "preflight-probe:31337",
    "preflight-stop",
  ]);
  calls.length = 0;
  await assert.rejects(
    () =>
      verifyRollbackWebArtifactCompatibility(snapshot, preflightEnvironment, {
        operations: {
          ...preflightOperations,
          probe: async () => {
            calls.push("preflight-incompatible");
            throw new Error("old server cannot read the final schema");
          },
        },
      }),
    (error) => error?.code === "WEB_ROLLBACK_PREFLIGHT_FAILED",
  );
  assert.deepEqual(calls, [
    "preflight-start",
    "preflight-incompatible",
    "preflight-stop",
  ]);

  calls.length = 0;
  rollbackWebArtifact(snapshot, {
    reload: () => calls.push("reload"),
    health: () => calls.push("health"),
  });

  assert.deepEqual(calls, ["reload", "health"]);
  assert.equal(
    fs.readFileSync(path.join(activeTarget(), "index.js"), "utf8"),
    "previous-server",
  );

  const runtimeFailureSnapshot = snapshotWebArtifact(artifactRoot, {
    id: "web-150-runtime-failure",
  });
  assert.throws(
    () =>
      rollbackWebArtifact(runtimeFailureSnapshot, {
        reload: () => {
          throw new Error("pm2 failed");
        },
        health: () => {
          throw new Error("health must not run");
        },
      }),
    (error) => error?.code === "WEB_ARTIFACT_ROLLBACK_RUNTIME_FAILED",
  );
  assert.equal(
    fs.readFileSync(
      path.join(runtimeFailureSnapshot.previousPath, "index.js"),
      "utf8",
    ),
    "previous-server",
  );

  const swapFailureSnapshot = snapshotWebArtifact(artifactRoot, {
    id: "web-175-swap-failure",
  });
  const beforeSwapFailure = fs.readlinkSync(swapFailureSnapshot.activeLinkPath);
  if (process.platform !== "win32") {
    const realRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (
        path.basename(source).startsWith(".web-current-stage-") &&
        path.resolve(destination) === swapFailureSnapshot.activeLinkPath
      ) {
        throw new Error("atomic link replacement failed");
      }
      return realRename(source, destination);
    };
    try {
      assert.throws(
        () =>
          rollbackWebArtifact(swapFailureSnapshot, {
            reload: () => {},
            health: () => {},
          }),
        (error) => error?.code === "WEB_ARTIFACT_SWAP_FAILED",
      );
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(
      fs.readlinkSync(swapFailureSnapshot.activeLinkPath),
      beforeSwapFailure,
      "failed atomic link replacement must leave the complete prior release active",
    );
  } else {
    rollbackWebArtifact(swapFailureSnapshot, {
      reload: () => {},
      health: () => {},
    });
  }

  for (const id of ["web-200-two", "web-300-three", "web-400-four"]) {
    fs.mkdirSync(path.join(artifactRoot, ".runtime/web-releases", id), {
      recursive: true,
    });
  }
  fs.mkdirSync(
    path.join(
      artifactRoot,
      ".runtime/web-releases",
      ".tmp-web-stale-00000000-0000-0000-0000-000000000000",
    ),
  );
  const retention = pruneWebArtifactSnapshots(artifactRoot, {
    keepRecent: 3,
    protectedIds: [swapFailureSnapshot.id],
  });
  assert.equal(retention.kept, 3);
  assert.equal(retention.removed >= 3, true);
  assert.equal(
    fs.existsSync(swapFailureSnapshot.releaseDirectory),
    true,
    "explicitly protected release must remain available for diagnosis",
  );
} finally {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
}

const candidateRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "web-candidate-isolation-test-"),
);
try {
  fs.mkdirSync(path.join(candidateRoot, "dist/public"), { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, "dist/index.js"), "live-server");
  fs.writeFileSync(
    path.join(candidateRoot, "dist/public/index.html"),
    "live-client",
  );
  const expectedSha = "a".repeat(40);
  const makeOperations = (build) => ({
    createWorktree: (sourceRoot) =>
      fs.mkdirSync(sourceRoot, { recursive: true }),
    linkDependencies: () => {},
    build,
    removeWorktree: (sourceRoot) =>
      fs.rmSync(sourceRoot, { recursive: true, force: true }),
  });

  assert.throws(
    () =>
      prepareWebCandidate(candidateRoot, {
        id: "candidate-build-failure",
        expectedSha,
        operations: makeOperations((sourceRoot) => {
          fs.mkdirSync(path.join(sourceRoot, "dist/public"), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(sourceRoot, "dist/index.js"),
            "partial-candidate",
          );
          throw new Error("injected build failure");
        }),
      }),
    (error) => error?.code === "WEB_CANDIDATE_BUILD_FAILED",
  );
  assert.equal(
    fs.readFileSync(path.join(candidateRoot, "dist/index.js"), "utf8"),
    "live-server",
  );
  assert.equal(
    fs.readFileSync(path.join(candidateRoot, "dist/public/index.html"), "utf8"),
    "live-client",
  );

  const candidate = prepareWebCandidate(candidateRoot, {
    id: "candidate-success",
    expectedSha,
    operations: makeOperations((sourceRoot) => {
      fs.mkdirSync(path.join(sourceRoot, "dist/public"), { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, "dist/index.js"),
        "candidate-server",
      );
      fs.writeFileSync(
        path.join(sourceRoot, "dist/public/index.html"),
        "candidate-client",
      );
    }),
  });
  const snapshot = snapshotWebArtifact(candidateRoot, {
    id: "web-500-candidate-swap",
  });
  installWebCandidate(snapshot, candidate);
  const activeArtifact = () =>
    path.resolve(
      path.dirname(snapshot.activeLinkPath),
      fs.readlinkSync(snapshot.activeLinkPath),
    );
  assert.equal(
    fs.readFileSync(path.join(activeArtifact(), "index.js"), "utf8"),
    "candidate-server",
  );
  assert.equal(
    fs.readFileSync(path.join(candidateRoot, "dist/index.js"), "utf8"),
    "live-server",
    "legacy dist must remain byte-for-byte while the immutable release link changes",
  );
  assert.equal(hasPendingWebActivation(candidateRoot), true);
  const activationJournal = JSON.parse(
    fs.readFileSync(
      path.join(candidateRoot, ".runtime", "web-activation-pending.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    {
      version: activationJournal.version,
      phase: activationJournal.phase,
      id: activationJournal.id,
      previous: activationJournal.previous,
      candidate: activationJournal.candidate,
    },
    {
      version: 1,
      phase: "pending",
      id: snapshot.id,
      previous: path.join("web-releases", snapshot.id, "previous"),
      candidate: path.join("web-releases", snapshot.id, "candidate"),
    },
  );
  commitWebArtifact(snapshot);
  assert.equal(
    hasPendingWebActivation(candidateRoot),
    false,
    "the journal clears only after explicit acceptance",
  );
  rollbackWebArtifact(snapshot, { reload: () => {}, health: () => {} });
  assert.equal(
    fs.readFileSync(path.join(activeArtifact(), "index.js"), "utf8"),
    "live-server",
  );
  cleanupWebCandidate(candidate);

  const crashAfterSwapCandidate = prepareWebCandidate(candidateRoot, {
    id: "candidate-crash-after-swap",
    expectedSha,
    operations: makeOperations((sourceRoot) => {
      fs.mkdirSync(path.join(sourceRoot, "dist/public"), { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, "dist/index.js"),
        "unaccepted-server",
      );
      fs.writeFileSync(
        path.join(sourceRoot, "dist/public/index.html"),
        "unaccepted-client",
      );
    }),
  });
  const crashAfterSwapSnapshot = snapshotWebArtifact(candidateRoot, {
    id: "web-550-crash-after-swap",
  });
  installWebCandidate(crashAfterSwapSnapshot, crashAfterSwapCandidate);
  assert.equal(isWebCandidateActive(crashAfterSwapSnapshot), true);
  assert.equal(hasPendingWebActivation(candidateRoot), true);
  const crashRecoveryCalls = [];
  recoverPendingWebActivation(candidateRoot, {
    reload: () => crashRecoveryCalls.push("reload"),
    health: () => crashRecoveryCalls.push("health"),
  });
  assert.deepEqual(crashRecoveryCalls, ["reload", "health"]);
  assert.equal(isWebCandidateActive(crashAfterSwapSnapshot), false);
  assert.equal(hasPendingWebActivation(candidateRoot), false);
  assert.equal(
    fs.readFileSync(
      path.join(
        path.resolve(
          path.dirname(crashAfterSwapSnapshot.activeLinkPath),
          fs.readlinkSync(crashAfterSwapSnapshot.activeLinkPath),
        ),
        "index.js",
      ),
      "utf8",
    ),
    "live-server",
    "startup recovery must reject an unaccepted candidate after abrupt process loss",
  );
  cleanupWebCandidate(crashAfterSwapCandidate);

  if (process.platform !== "win32") {
    const interruptedCandidate = prepareWebCandidate(candidateRoot, {
      id: "candidate-interrupted-switch",
      expectedSha,
      operations: makeOperations((sourceRoot) => {
        fs.mkdirSync(path.join(sourceRoot, "dist/public"), { recursive: true });
        fs.writeFileSync(
          path.join(sourceRoot, "dist/index.js"),
          "complete-next-server",
        );
        fs.writeFileSync(
          path.join(sourceRoot, "dist/public/index.html"),
          "complete-next-client",
        );
      }),
    });
    const interruptedSnapshot = snapshotWebArtifact(candidateRoot, {
      id: "web-600-interrupted-switch",
    });
    const priorLink = fs.readlinkSync(interruptedSnapshot.activeLinkPath);
    const priorTarget = path.resolve(
      path.dirname(interruptedSnapshot.activeLinkPath),
      priorLink,
    );
    const realRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (
        path.basename(source).startsWith(".web-current-stage-") &&
        path.resolve(destination) === interruptedSnapshot.activeLinkPath
      ) {
        throw new Error("injected interruption before atomic link commit");
      }
      return realRename(source, destination);
    };
    try {
      assert.throws(
        () => installWebCandidate(interruptedSnapshot, interruptedCandidate),
        (error) => error?.code === "WEB_CANDIDATE_ATOMIC_SWAP_FAILED",
      );
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(
      fs.readlinkSync(interruptedSnapshot.activeLinkPath),
      priorLink,
    );
    assert.equal(
      fs.readFileSync(path.join(priorTarget, "index.js"), "utf8"),
      "live-server",
      "an interruption before the one atomic rename must leave a complete prior release active",
    );
    assert.equal(
      fs.readFileSync(
        path.join(interruptedSnapshot.candidatePath, "index.js"),
        "utf8",
      ),
      "complete-next-server",
      "the complete candidate remains staged for diagnosis and is never partially live",
    );
    assert.equal(hasPendingWebActivation(candidateRoot), true);
    const recoveryCalls = [];
    const recovered = recoverPendingWebActivation(candidateRoot, {
      reload: () => recoveryCalls.push("reload"),
      health: () => recoveryCalls.push("health"),
    });
    assert.equal(recovered.id, interruptedSnapshot.id);
    assert.deepEqual(recoveryCalls, ["reload", "health"]);
    assert.equal(
      fs.readlinkSync(interruptedSnapshot.activeLinkPath),
      path.relative(
        path.dirname(interruptedSnapshot.activeLinkPath),
        interruptedSnapshot.previousPath,
      ),
      "a second process must restore the previous immutable release from the journal",
    );
    assert.equal(hasPendingWebActivation(candidateRoot), false);
    cleanupWebCandidate(interruptedCandidate);

    const committedThenErroredCandidate = prepareWebCandidate(candidateRoot, {
      id: "candidate-committed-then-errored",
      expectedSha,
      operations: makeOperations((sourceRoot) => {
        fs.mkdirSync(path.join(sourceRoot, "dist/public"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(sourceRoot, "dist/index.js"),
          "committed-next-server",
        );
        fs.writeFileSync(
          path.join(sourceRoot, "dist/public/index.html"),
          "committed-next-client",
        );
      }),
    });
    const committedThenErroredSnapshot = snapshotWebArtifact(candidateRoot, {
      id: "web-700-committed-then-errored",
    });
    const realRenameAfterCommit = fs.renameSync;
    fs.renameSync = (source, destination) => {
      const result = realRenameAfterCommit(source, destination);
      if (
        path.basename(source).startsWith(".web-current-stage-") &&
        path.resolve(destination) ===
          committedThenErroredSnapshot.activeLinkPath
      ) {
        throw new Error("injected I/O report after atomic link commit");
      }
      return result;
    };
    try {
      assert.throws(
        () =>
          installWebCandidate(
            committedThenErroredSnapshot,
            committedThenErroredCandidate,
          ),
        (error) => error?.code === "WEB_CANDIDATE_ATOMIC_SWAP_FAILED",
      );
    } finally {
      fs.renameSync = realRenameAfterCommit;
    }
    assert.equal(
      isWebCandidateActive(committedThenErroredSnapshot),
      true,
      "deployment must recognize a committed link even when a later durability operation reports failure",
    );
    rollbackWebArtifact(committedThenErroredSnapshot, {
      reload: () => {},
      health: () => {},
    });
    cleanupWebCandidate(committedThenErroredCandidate);
  }
} finally {
  fs.rmSync(candidateRoot, { recursive: true, force: true });
}

console.log("deployment storefront-readiness contract test: OK");
