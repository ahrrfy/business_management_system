import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const {
  pruneWebArtifactSnapshots,
  rollbackWebArtifact,
  snapshotWebArtifact,
} = await import("./deploy.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploySource = fs.readFileSync(path.join(root, "scripts/deploy.mjs"), "utf8");

const reloadIndex = deploySource.indexOf('step("9/11 إعادة تحميل خادم الويب"');
const smokeIndex = deploySource.indexOf("verify-nginx-storefront-readiness.mjs");
assert.ok(reloadIndex >= 0, "deployment must reload the web process");
assert.ok(smokeIndex > reloadIndex, "external storefront smoke must run after the web reload");
assert.ok(
  deploySource.indexOf('step("11/11 تفعيل إصدار الجسر والتحقق والحفظ الذري"') > smokeIndex,
  "external storefront smoke must finish before the deployment is committed",
);
assert.match(deploySource, /verify-nginx-abuse-controls\.mjs/, "deployment must run the static nginx contract before mutable steps");
assert.match(deploySource, /WEB_STOREFRONT_SMOKE_FAILED_ROLLBACK_OK/, "smoke failure must have an explicit successful-rollback terminal state");

const selftest = spawnSync(process.execPath, ["scripts/verify-nginx-storefront-readiness.mjs", "--selftest"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(selftest.status, 0, `${selftest.stdout}\n${selftest.stderr}`);

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "web-artifact-rollback-test-"));
try {
  fs.mkdirSync(path.join(artifactRoot, "dist/public"), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "dist/index.js"), "previous-server");
  fs.writeFileSync(path.join(artifactRoot, "dist/public/index.html"), "previous-client");
  const snapshot = snapshotWebArtifact(artifactRoot, { id: "web-100-previous" });

  fs.writeFileSync(path.join(artifactRoot, "dist/index.js"), "failed-server");
  fs.writeFileSync(path.join(artifactRoot, "dist/public/index.html"), "failed-client");
  const calls = [];
  rollbackWebArtifact(snapshot, {
    reload: () => calls.push("reload"),
    health: () => calls.push("health"),
  });

  assert.deepEqual(calls, ["reload", "health"]);
  assert.equal(fs.readFileSync(path.join(artifactRoot, "dist/index.js"), "utf8"), "previous-server");
  assert.equal(fs.readFileSync(path.join(snapshot.failedCandidatePath, "index.js"), "utf8"), "failed-server");

  const runtimeFailureSnapshot = snapshotWebArtifact(artifactRoot, { id: "web-150-runtime-failure" });
  fs.writeFileSync(path.join(artifactRoot, "dist/index.js"), "second-failed-server");
  assert.throws(
    () => rollbackWebArtifact(runtimeFailureSnapshot, {
      reload: () => { throw new Error("pm2 failed"); },
      health: () => { throw new Error("health must not run"); },
    }),
    (error) => error?.code === "WEB_ARTIFACT_ROLLBACK_RUNTIME_FAILED",
  );
  assert.equal(fs.readFileSync(path.join(artifactRoot, "dist/index.js"), "utf8"), "previous-server");
  assert.equal(fs.readFileSync(path.join(runtimeFailureSnapshot.failedCandidatePath, "index.js"), "utf8"), "second-failed-server");

  const swapFailureSnapshot = snapshotWebArtifact(artifactRoot, { id: "web-175-swap-failure" });
  fs.writeFileSync(path.join(artifactRoot, "dist/index.js"), "candidate-survives-swap-failure");
  const realRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(source) === swapFailureSnapshot.previousPath && path.resolve(destination) === swapFailureSnapshot.distPath) {
      throw new Error("baseline rename failed");
    }
    return realRename(source, destination);
  };
  try {
    assert.throws(
      () => rollbackWebArtifact(swapFailureSnapshot, { reload: () => {}, health: () => {} }),
      (error) => error?.code === "WEB_ARTIFACT_SWAP_FAILED",
    );
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(path.join(artifactRoot, "dist/index.js"), "utf8"), "candidate-survives-swap-failure");
  assert.equal(fs.existsSync(swapFailureSnapshot.failedCandidatePath), false, "candidate must be restored if baseline swap fails");

  for (const id of ["web-200-two", "web-300-three", "web-400-four"]) {
    fs.mkdirSync(path.join(artifactRoot, ".runtime/web-releases", id), { recursive: true });
  }
  fs.mkdirSync(path.join(artifactRoot, ".runtime/web-releases", ".tmp-web-stale-00000000-0000-0000-0000-000000000000"));
  const retention = pruneWebArtifactSnapshots(artifactRoot, {
    keepRecent: 3,
    protectedIds: [snapshot.id, runtimeFailureSnapshot.id, swapFailureSnapshot.id],
  });
  assert.equal(retention.kept, 3);
  assert.equal(retention.removed, 4);
  assert.equal(fs.existsSync(snapshot.releaseDirectory), true, "failed candidate must remain protected for diagnosis");
} finally {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
}

console.log("deployment storefront-readiness contract test: OK");
