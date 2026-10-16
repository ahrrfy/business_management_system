import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cleanup,
  sessionHome,
  registeredWorktrees,
  RETENTION_MS,
  prepareSnapshot,
} from "./session-cleanup.mjs";
import { coordRootFor } from "./coord-core.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function fixture(t, { squash = false, merge = true } = {}) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "session-maintenance-test-"),
  );
  const repo = path.join(temp, "project");
  const remote = path.join(temp, "remote.git");
  const storage = path.join(temp, "storage");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Cleanup test");
  git(repo, "config", "user.email", "cleanup@example.invalid");
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    ".env\nnode_modules/\nlocal-data/\n",
  );
  fs.writeFileSync(path.join(repo, "source.txt"), "initial\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  git(temp, "init", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  const root = path.join(sessionHome(repo), "finished");
  git(repo, "worktree", "add", "-b", "session/finished", root);
  fs.writeFileSync(path.join(root, "source.txt"), "finished work\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "feature");
  const head = git(root, "rev-parse", "HEAD");
  if (merge) {
    git(
      repo,
      "merge",
      squash ? "--squash" : "--no-ff",
      "session/finished",
      ...(squash ? [] : ["-m", "merge"]),
    );
    if (squash) git(repo, "commit", "-m", "squashed feature");
    git(repo, "push", "origin", "main");
  }
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE_TEST_VALUE=keep-me\n");
  const old = new Date(Date.now() - RETENTION_MS - 3600_000);
  function age(dir) {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (fs.lstatSync(p).isDirectory()) age(p);
      fs.utimesSync(p, old, old);
    }
    fs.utimesSync(dir, old, old);
  }
  age(root);
  const snapshot = {
    capturedAt: Date.now(),
    complete: true,
    activePaths: [],
    processPaths: [],
    mergedPullRequests: [],
  };
  const coord = coordRootFor(repo);
  assert.equal(fs.existsSync(coord), false);
  t.after(() => {
    // Delete only the exact temporary roots created by this fixture.
    assert.ok(
      path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    fs.rmSync(temp, { recursive: true, force: true });
    if (fs.existsSync(coord)) {
      assert.equal(
        path.dirname(coord),
        path.join(os.homedir(), ".claude", "coord"),
      );
      fs.rmSync(coord, { recursive: true, force: true });
    }
  });
  return {
    repo,
    root,
    head,
    storage,
    snapshot,
    coord,
    temp,
    age,
    run: (apply = false) => cleanup({ repo, snapshot, storage, apply }),
  };
}
const result = (f, r) => r.results.find((x) => x.root === f.root);

test("snapshot preparation refuses unavailable or stale app evidence before inspecting processes", () => {
  const state = {
    threads: [],
    unavailableHosts: ["local"],
    unavailableSources: [],
  };
  assert.throws(
    () => prepareSnapshot(process.cwd(), { capturedAt: Date.now(), state }),
    /incomplete or stale/,
  );
  state.unavailableHosts = [];
  assert.throws(
    () =>
      prepareSnapshot(process.cwd(), {
        capturedAt: Date.now() - 600_000,
        state,
      }),
    /incomplete or stale/,
  );
});

test("dry run preserves files; apply backs up local configuration, keeps branch and main, and never follows dependency junctions", (t) => {
  const f = fixture(t);
  const main = git(f.repo, "rev-parse", "HEAD");
  const external = path.join(f.temp, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "important.txt"), "keep external");
  fs.mkdirSync(path.join(f.root, "node_modules"));
  fs.symlinkSync(
    external,
    path.join(f.root, "node_modules", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  f.age(f.root);
  assert.equal(result(f, f.run()).action, "would_remove");
  assert.ok(fs.existsSync(f.root));
  const removed = result(f, f.run(true));
  assert.equal(removed.action, "removed");
  assert.equal(fs.existsSync(f.root), false);
  assert.equal(
    fs.readFileSync(path.join(removed.archive, "files", ".env"), "utf8"),
    "PRIVATE_TEST_VALUE=keep-me\n",
  );
  assert.equal(
    fs.readFileSync(path.join(external, "important.txt"), "utf8"),
    "keep external",
  );
  assert.equal(git(f.repo, "rev-parse", "session/finished"), f.head);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), main);
  assert.equal(registeredWorktrees(f.repo).length, 1);
});
test("unmerged work is retained", (t) => {
  const f = fixture(t, { merge: false });
  assert.equal(result(f, f.run(true)).reason, "not_proven_merged");
  assert.ok(fs.existsSync(f.root));
});
test("untracked files are retained", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "unsaved.txt"), "important");
  assert.equal(result(f, f.run(true)).reason, "modified_or_untracked_work");
});
test("an active parent chat protects its nested session", (t) => {
  const f = fixture(t);
  f.snapshot.activePaths = [path.dirname(f.root)];
  assert.equal(result(f, f.run(true)).reason, "active_app_or_process");
});
test("stale activity evidence cannot authorize deletion", (t) => {
  const f = fixture(t);
  f.snapshot.capturedAt -= 600_000;
  assert.equal(result(f, f.run(true)).action, "preserved_or_error");
  assert.ok(fs.existsSync(f.root));
});
test("a clean but recent checkout is retained", (t) => {
  const f = fixture(t);
  fs.utimesSync(path.join(f.root, "source.txt"), new Date(), new Date());
  assert.equal(result(f, f.run(true)).reason, "modified_within_7_days");
});
test("assume-unchanged cannot hide local edits", (t) => {
  const f = fixture(t);
  git(f.root, "update-index", "--assume-unchanged", "source.txt");
  fs.writeFileSync(path.join(f.root, "source.txt"), "hidden important change");
  assert.equal(result(f, f.run(true)).reason, "hidden_index_changes");
});
test("fresh coordination records protect a session", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.coord, "claims"), { recursive: true });
  fs.writeFileSync(
    path.join(f.coord, "claims", "active.json"),
    JSON.stringify({ worktree: f.root, heartbeatAt: Date.now() }),
  );
  assert.equal(result(f, f.run(true)).reason, "recent_coord_activity");
});
test("squash merge requires matching PR head and reachable merge commit", (t) => {
  const f = fixture(t, { squash: true });
  assert.equal(result(f, f.run()).reason, "not_proven_merged");
  f.snapshot.mergedPullRequests = [
    {
      state: "MERGED",
      head: "0".repeat(40),
      mergeCommit: git(f.repo, "rev-parse", "main"),
    },
  ];
  assert.equal(result(f, f.run()).reason, "not_proven_merged");
  f.snapshot.mergedPullRequests[0].head = f.head;
  assert.equal(result(f, f.run()).action, "would_remove");
});
test("new ignored important files during backup abort removal", (t) => {
  const f = fixture(t);
  const original = fs.copyFileSync;
  fs.copyFileSync = (...args) => {
    original(...args);
    fs.mkdirSync(path.join(f.root, "local-data"), { recursive: true });
    fs.writeFileSync(
      path.join(f.root, "local-data", "late.txt"),
      "new important file",
    );
  };
  try {
    assert.equal(result(f, f.run(true)).action, "preserved_or_error");
    assert.ok(fs.existsSync(f.root));
  } finally {
    fs.copyFileSync = original;
  }
});

test("relative process launches are captured and newly started processes protect old snapshots", async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: f.root,
    windowsHide: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  try {
    const prepared = prepareSnapshot(f.repo, {
      capturedAt: Date.now(),
      state: {
        threads: [],
        pinnedThreads: [],
        unavailableHosts: [],
        unavailableSources: [],
      },
    });
    assert.ok(
      prepared.processPaths.includes(path.resolve(f.root).toLowerCase()),
    );
    assert.equal(result(f, f.run(true)).reason, "active_app_or_process");
    assert.ok(fs.existsSync(f.root));
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

test("a new empty commit during cache removal preserves the checkout", (t) => {
  const f = fixture(t);
  const modules = path.join(f.root, "node_modules");
  fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, "generated.txt"), "cache");
  f.age(f.root);
  const original = fs.rmdirSync;
  fs.rmdirSync = (...args) => {
    original(...args);
    if (args[0] === modules)
      git(f.root, "commit", "--allow-empty", "-m", "new work");
  };
  try {
    assert.equal(result(f, f.run(true)).action, "preserved_or_error");
    assert.ok(fs.existsSync(f.root));
    assert.ok(
      registeredWorktrees(f.repo).some(
        (w) => w.worktree.replaceAll("/", path.sep) === f.root,
      ),
    );
    assert.notEqual(git(f.root, "rev-parse", "HEAD"), f.head);
  } finally {
    fs.rmdirSync = original;
  }
});

test("absolute script references protect a checkout even with a different process cwd", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "node_modules"));
  const script = path.join(f.root, "node_modules", "serve.cjs");
  fs.writeFileSync(script, "setInterval(()=>{},1000)");
  f.age(f.root);
  const child = spawn(process.execPath, [script], {
    cwd: f.repo,
    windowsHide: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  try {
    assert.equal(result(f, f.run(true)).reason, "active_app_or_process");
    assert.ok(fs.existsSync(script));
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

test("restricted fetch mappings cannot leave a stale merge proof", (t) => {
  const f = fixture(t);
  const initial = git(f.repo, "rev-parse", "main~1");
  git(
    path.join(f.temp, "remote.git"),
    "update-ref",
    "refs/heads/main",
    initial,
  );
  git(
    f.repo,
    "config",
    "remote.origin.fetch",
    "+refs/heads/other:refs/remotes/origin/other",
  );
  assert.equal(result(f, f.run(true)).reason, "not_proven_merged");
  assert.equal(git(f.repo, "rev-parse", "origin/main"), initial);
  assert.ok(fs.existsSync(f.root));
});
