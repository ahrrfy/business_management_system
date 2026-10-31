import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { readWebRelease, writeWebRelease } from "./build-web.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-release-test-"));
try {
  for (const kind of ["erp", "storefront"]) {
    const directory = path.join(root, kind);
    fs.mkdirSync(path.join(directory, ".vite"), { recursive: true });
    for (const file of [
      "index.html",
      "sw.js",
      "manifest.webmanifest",
      ".vite/manifest.json",
      "push-handler.js",
      "pwa-update-worker.js",
    ])
      fs.writeFileSync(path.join(directory, file), file);
    const first = writeWebRelease(directory, kind);
    assert.equal(
      readWebRelease(directory, kind).fingerprint,
      first.fingerprint,
    );
    assert.equal(
      writeWebRelease(directory, kind).fingerprint,
      first.fingerprint,
    );
    assert.throws(
      () => readWebRelease(directory, kind === "erp" ? "storefront" : "erp"),
      /KIND_INVALID/,
    );
    fs.writeFileSync(path.join(directory, "sw.js"), "changed");
    assert.throws(() => readWebRelease(directory, kind), /CONTENT_MISMATCH/);
    assert.notEqual(
      writeWebRelease(directory, kind).fingerprint,
      first.fingerprint,
    );
    fs.unlinkSync(path.join(directory, "index.html"));
    writeWebRelease(directory, kind);
    assert.throws(() => readWebRelease(directory, kind), /INCOMPLETE/);
  }
} finally {
  fs.rmSync(root, { recursive: true });
}

// Match production bundling: import.meta.url and argv both become the server entry.
// A throwing Vite stub makes the old CLI guard fail safely without any build/write.
const bundledFixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "web-import-bundle-"),
);
try {
  const bundledServer = path.join(bundledFixtureRoot, "server-fixture.mjs");
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const bundled = await esbuild({
    stdin: {
      contents:
        'import { webReleaseFingerprint } from "./scripts/build-web.mjs"; console.log("PURE_BUILD_HELPER_IMPORT", typeof webReleaseFingerprint);',
      resolveDir: projectRoot,
      sourcefile: "server-fixture.mjs",
    },
    bundle: true,
    packages: "external",
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: bundledServer,
    metafile: true,
    plugins: [
      {
        name: "forbid-build-during-runtime-import",
        setup(builder) {
          builder.onResolve({ filter: /^vite$/ }, () => ({
            path: "vite",
            namespace: "build-sentinel",
          }));
          builder.onLoad({ filter: /.*/, namespace: "build-sentinel" }, () => ({
            contents:
              'export async function build() { throw new Error("BUILD_WEB_IMPORT_SIDE_EFFECT"); }',
            loader: "js",
          }));
        },
      },
    ],
  });
  assert.equal(
    Object.keys(bundled.metafile.inputs).some((file) =>
      file.endsWith("build-web-cli.mjs"),
    ),
    false,
  );
  const imported = spawnSync(process.execPath, [bundledServer], {
    cwd: bundledFixtureRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(imported.error);
  assert.equal(
    imported.status,
    0,
    `Bundled helper import must not start Vite: ${imported.stderr}`,
  );
  assert.match(imported.stdout, /PURE_BUILD_HELPER_IMPORT function/);
  assert.equal(imported.stderr, "");
  assert.equal(fs.existsSync(path.join(bundledFixtureRoot, "dist")), false);
} finally {
  fs.rmSync(bundledFixtureRoot, { recursive: true });
}
console.log("bundled server helper import stays pure: passed");

const workerSource = fs.readFileSync(
  new URL("../client/public/pwa-update-worker.js", import.meta.url),
  "utf8",
);
async function activation(clientStates) {
  let listener,
    skipped = 0,
    reply;
  const clients = clientStates.map((state) => {
    const { safe, url } =
      typeof state === "object"
        ? state
        : { safe: state, url: "https://alarabiya.online/store" };
    return {
      url,
      postMessage(_message, ports) {
        if (safe !== "legacy") ports[0].postMessage({ safe });
        ports[0].close();
      },
    };
  });
  vm.runInNewContext(workerSource, {
    self: {
      location: { origin: "https://alarabiya.online" },
      clients: { matchAll: async () => clients },
      addEventListener(_type, callback) {
        listener = callback;
      },
      skipWaiting: async () => {
        skipped++;
      },
    },
    URL,
    Promise,
    MessageChannel,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => ({}),
  });
  let waiting;
  listener({
    data: { type: "PWA_ACTIVATE", requestId: "test" },
    source: { url: "https://alarabiya.online/store" },
    ports: [
      {
        postMessage(value) {
          reply = value;
        },
      },
    ],
    stopImmediatePropagation() {},
    waitUntil(value) {
      waiting = value;
    },
  });
  await waiting;
  return { skipped, reply };
}

// A legacy tab can retain a lost-response request key after leaving /store.
// Its unknown state must veto activation rather than bypass the client checks.
assert.equal(
  (
    await activation([
      { safe: "legacy", url: "https://alarabiya.online/legal/privacy" },
    ])
  ).skipped,
  0,
);
assert.equal(
  (await activation([{ safe: false, url: "https://alarabiya.online/account" }]))
    .skipped,
  0,
);
assert.equal((await activation([])).skipped, 1);
assert.equal((await activation([true, true])).skipped, 1);
assert.equal((await activation(["legacy"])).skipped, 0);
const blocked = await activation([true, false]);
assert.equal(blocked.skipped, 0);
assert.equal(blocked.reply.type, "PWA_ACTIVATION_REJECTED");
console.log(
  "web release content, completeness and cross-tab checkout activation: passed",
);
