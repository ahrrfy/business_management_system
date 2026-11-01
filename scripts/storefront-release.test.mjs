import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeWebRelease } from "./build-web.mjs";
import { prepareStorefrontRelease, activateStorefrontRelease, pruneStorefrontReleases } from "./storefront-release.mjs";

const project = fs.mkdtempSync(path.join(os.tmpdir(), "storefront-release-test-"));
function fixture(name, content = name) {
  const directory = path.join(project, name);
  fs.mkdirSync(path.join(directory, ".vite"), { recursive: true });
  for (const file of ["index.html", "sw.js", "manifest.webmanifest", ".vite/manifest.json", "push-handler.js", "pwa-update-worker.js"]) {
    fs.writeFileSync(path.join(directory, file), content);
  }
  writeWebRelease(directory, "storefront");
  return directory;
}
try {
  const first = prepareStorefrontRelease(project, fixture("a"));
  const current = path.join(project, ".runtime/storefront-current");
  assert.equal(fs.existsSync(current), false, "preparation must not activate before server health");
  assert.deepEqual(activateStorefrontRelease(project, first.fingerprint), {
    changed: true, fingerprint: first.fingerprint, previousFingerprint: null,
  });
  const originalLink = fs.lstatSync(current).mtimeMs;
  const same = prepareStorefrontRelease(project, fixture("same-content", "a"));
  assert.equal(same.fingerprint, first.fingerprint);
  assert.equal(activateStorefrontRelease(project, same.fingerprint).changed, false);
  assert.equal(fs.lstatSync(current).mtimeMs, originalLink, "admin-only rebuild leaves pointer untouched");

  const broken = fixture("broken");
  fs.writeFileSync(path.join(broken, "sw.js"), "interrupted replacement");
  assert.throws(() => prepareStorefrontRelease(project, broken), /CONTENT_MISMATCH/);
  assert.equal(fs.realpathSync(current), fs.realpathSync(first.target));
  const missing = fixture("missing");
  fs.unlinkSync(path.join(missing, "sw.js"));
  writeWebRelease(missing, "storefront");
  assert.throws(() => prepareStorefrontRelease(project, missing), /WEB_RELEASE_INCOMPLETE:sw\.js/);

  const versions = [first];
  for (const [index, name] of ["b", "c", "d"].entries()) {
    const version = prepareStorefrontRelease(project, fixture(name));
    const date = new Date(Date.now() + (index + 1) * 1_000);
    fs.utimesSync(version.target, date, date);
    activateStorefrontRelease(project, version.fingerprint);
    versions.push(version);
  }
  assert.throws(() => pruneStorefrontReleases(project, { keep: 2 }), /TOO_SMALL/);
  // A frontend rollback protects the selected old complete root, not a database snapshot.
  assert.equal(activateStorefrontRelease(project, first.fingerprint).changed, true);
  assert.equal(pruneStorefrontReleases(project).removed, 1);
  assert.equal(fs.existsSync(first.target), true);
  assert.equal(fs.existsSync(versions[1].target), false);
  assert.equal(fs.existsSync(versions[2].target), true);
  assert.equal(fs.existsSync(versions[3].target), true);
  assert.throws(() => activateStorefrontRelease(project, "../escape"), /FINGERPRINT_INVALID/);

  fs.unlinkSync(current);
  fs.symlinkSync(project, current, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => activateStorefrontRelease(project, first.fingerprint), /CURRENT_LINK_INVALID/);
  fs.unlinkSync(current);
  console.log("storefront release: prepare, content reuse, interrupted artifacts, activation, retention and rollback passed");
} finally {
  if (!project.startsWith(path.join(os.tmpdir(), "storefront-release-test-"))) throw new Error("TEST_CLEANUP_OUTSIDE_SCOPE");
  fs.rmSync(project, { recursive: true });
}
