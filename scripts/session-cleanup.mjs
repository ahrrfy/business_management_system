// Conservative local worktree maintenance. Process cwd capture uses Python/psutil.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coordRootFor } from "./coord-core.mjs";

export const RETENTION_MS = 7 * 86400_000;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const norm = (p) =>
  process.platform === "win32"
    ? path.resolve(p).toLowerCase()
    : path.resolve(p);
const within = (p, parent) => {
  const r = path.relative(norm(parent), norm(p));
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};
const overlaps = (a, b) => within(a, b) || within(b, a);
function git(cwd, args) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function json(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
export function sessionHome(projectRoot) {
  return path.join(
    path.dirname(projectRoot),
    `${path.basename(projectRoot)}-worktrees`,
  );
}
export function registeredWorktrees(repo) {
  return git(repo, ["worktree", "list", "--porcelain", "-z"])
    .split("\0\0")
    .filter(Boolean)
    .map((block) =>
      Object.fromEntries(
        block
          .split("\0")
          .filter(Boolean)
          .map((s) => {
            const i = s.indexOf(" ");
            return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)];
          }),
      ),
    );
}
export function prepareSnapshot(repo, capturedApp) {
  const now = Date.now();
  const state = capturedApp.state;
  if (
    !Number.isFinite(capturedApp.capturedAt) ||
    Math.abs(now - capturedApp.capturedAt) > 300_000 ||
    !Array.isArray(state?.threads) ||
    !Array.isArray(state.unavailableHosts) ||
    !Array.isArray(state.unavailableSources) ||
    state.unavailableHosts.length ||
    state.unavailableSources.length
  )
    throw new Error("App activity is incomplete or stale; cleanup blocked");
  const active = [...state.threads, ...(state.pinnedThreads || [])].filter(
    (t) =>
      t.kind === "codex" &&
      (!t.hostId || t.hostId === "local") &&
      !["idle", "notLoaded"].includes(t.status),
  );
  if (active.some((t) => typeof t.cwd !== "string" || !t.cwd))
    throw new Error(
      "An active local chat has no inspectable working directory",
    );
  const activePaths = active.map((t) => fs.realpathSync(t.cwd));
  const processPaths = captureProcessPaths(repo);
  return {
    complete: true,
    capturedAt: now,
    activePaths,
    processPaths,
    mergedPullRequests: capturedApp.mergedPullRequests || [],
  };
}
export function captureProcessPaths(repo) {
  if (process.platform !== "win32")
    throw new Error("Automatic process capture is configured for Windows only");
  // Command lines cannot attribute relative launches to a worktree. Read the
  // actual cwd, and fail closed if any relevant live process is inaccessible.
  const script = `import psutil,json,re
records=[]
for p in psutil.process_iter(['name']):
 if not re.fullmatch(r'(node|java|javaw|claude|codex|antigravity|code|code-insiders|cursor|windsurf|studio64|gradle|powershell|pwsh|cmd|bash|python|pythonw|dotnet)(\\.exe)?',p.info['name'] or '',re.I): continue
 try:
  cwd=p.cwd()
  if not cwd: raise RuntimeError('Relevant process has no inspectable cwd')
  records.append({'cwd':cwd,'command':' '.join(p.cmdline())})
 except psutil.NoSuchProcess: pass
print(json.dumps(records,ensure_ascii=True))`;
  const raw = execFileSync("python", ["-c", script], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const records = JSON.parse(raw);
  if (
    !Array.isArray(records) ||
    records.some(
      (r) =>
        typeof r.cwd !== "string" ||
        !path.isAbsolute(r.cwd) ||
        typeof r.command !== "string" ||
        !r.command,
    )
  )
    throw new Error("Process inspection failed; cleanup blocked");
  const paths = records.map((r) => r.cwd);
  // Absolute script/editor arguments can use a checkout outside the process cwd.
  // These command lines stay in memory only, because they can contain secrets.
  for (const tree of registeredWorktrees(repo)) {
    const root = path.resolve(tree.worktree);
    const needle = root.replaceAll("\\", "/").toLowerCase();
    if (
      records.some((r) =>
        r.command.replaceAll("\\", "/").toLowerCase().includes(needle),
      )
    )
      paths.push(root);
  }
  if (
    !Array.isArray(paths) ||
    paths.some((p) => typeof p !== "string" || !path.isAbsolute(p))
  )
    throw new Error("Process cwd inspection failed; cleanup blocked");
  return [...new Set(paths.map((p) => norm(fs.realpathSync(p))))];
}
function generated(rel) {
  const parts = rel.split(/[\\/]/);
  return (
    parts.some((p) =>
      ["node_modules", ".gradle", ".cxx", ".vite", ".turbo"].includes(p),
    ) || ["dist", "coverage"].includes(parts[0])
  );
}
function inventory(root) {
  const files = [];
  let latest = fs.lstatSync(root).mtimeMs;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p);
      const s = fs.lstatSync(p);
      latest = Math.max(latest, s.mtimeMs);
      if (rel === ".git" || generated(rel)) continue;
      if (s.isSymbolicLink()) throw new Error(`Non-generated link: ${rel}`);
      if (name === ".git") throw new Error(`Nested repository: ${rel}`);
      if (s.isDirectory()) stack.push(p);
      else if (s.isFile())
        files.push({
          rel,
          size: s.size,
          mtime: s.mtimeMs,
          sha256: hash(fs.readFileSync(p)),
        });
      else throw new Error(`Unsupported file: ${rel}`);
    }
  }
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), latest };
}
function allowed(root, project) {
  if (
    norm(root) === norm(project) ||
    norm(fs.realpathSync(root)) !== norm(root)
  )
    return false;
  const legacy =
    norm(path.dirname(root)) === norm(path.dirname(project)) &&
    path.basename(root).startsWith(`${path.basename(project)}__`);
  const managed = norm(path.dirname(root)) === norm(sessionHome(project));
  // Codex/IDE-managed C worktrees and agent worktrees inside the repo are never swept.
  return legacy || managed;
}
function liveEvidence(project, root, snapshot, now) {
  if (
    !snapshot ||
    snapshot.complete !== true ||
    !Number.isFinite(snapshot.capturedAt) ||
    Math.abs(now - snapshot.capturedAt) > 300_000 ||
    !Array.isArray(snapshot.activePaths) ||
    !Array.isArray(snapshot.processPaths)
  )
    throw new Error("Fresh complete activity snapshot required");
  if (
    [
      ...snapshot.activePaths,
      ...snapshot.processPaths,
      ...captureProcessPaths(project),
    ].some((p) => typeof p !== "string" || overlaps(p, root))
  )
    return "active_app_or_process";
  for (const name of fs.readdirSync(path.parse(project).root)) {
    const p = path.join(path.parse(project).root, name);
    let s;
    try {
      s = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (s.isSymbolicLink() && within(fs.realpathSync(p), root))
      return "alias_target";
  }
  const coord = coordRootFor(project);
  for (const kind of ["claims", "sessions"]) {
    const dir = path.join(coord, kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const record = json(path.join(dir, name)); // Corrupt evidence blocks, never permits deletion.
      if (
        [record.worktree, record.cwd]
          .filter(Boolean)
          .some((p) => overlaps(p, root))
      ) {
        const heartbeat = Math.max(
          Number(record.heartbeatAt) || 0,
          Number(record.registeredAt) || 0,
          Number(record.createdAt) || 0,
        );
        if (!heartbeat || now - heartbeat < RETENTION_MS)
          return "recent_coord_activity";
        if (
          kind === "claims" &&
          heartbeat + (Number(record.leaseMs) || 900_000) > now
        )
          return "live_claim";
      }
    }
  }
  return null;
}
function merged(repo, head, snapshot) {
  try {
    git(repo, [
      "merge-base",
      "--is-ancestor",
      head,
      "refs/remotes/origin/main",
    ]);
    return true;
  } catch {
    /* Squash requires exact GitHub proof, never patch similarity. */
  }
  return (snapshot?.mergedPullRequests || []).some((pr) => {
    if (
      pr.state !== "MERGED" ||
      pr.head !== head ||
      !/^[a-f0-9]{40}$/.test(pr.mergeCommit || "")
    )
      return false;
    try {
      git(repo, [
        "merge-base",
        "--is-ancestor",
        pr.mergeCommit,
        "refs/remotes/origin/main",
      ]);
      return true;
    } catch {
      return false;
    }
  });
}
export function assess(
  repo,
  project,
  tree,
  snapshot,
  now = Date.now(),
  { ignoreRetention = false } = {},
) {
  const root = path.resolve(tree.worktree);
  if (!fs.existsSync(root) || !allowed(root, project))
    return { root, eligible: false, reason: "protected_or_unmanaged_path" };
  if (!tree.branch || tree.locked || tree.prunable)
    return { root, eligible: false, reason: "detached_locked_or_prunable" };
  if (!tree.branch.startsWith("refs/heads/session/"))
    return { root, eligible: false, reason: "non_session_branch" };
  if (!merged(repo, tree.HEAD, snapshot))
    return { root, eligible: false, reason: "not_proven_merged" };
  if (
    git(root, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).trim()
  )
    return { root, eligible: false, reason: "modified_or_untracked_work" };
  if (
    git(root, ["ls-files", "-v", "-z"])
      .split("\0")
      .some((f) => /^[a-zS]/.test(f))
  )
    return { root, eligible: false, reason: "hidden_index_changes" };
  const activity = liveEvidence(project, root, snapshot, now);
  if (activity) return { root, eligible: false, reason: activity };
  const state = inventory(root);
  if (!ignoreRetention && now - state.latest < RETENTION_MS)
    return { root, eligible: false, reason: "modified_within_7_days" };
  return {
    root,
    head: tree.HEAD,
    branch: tree.branch,
    eligible: true,
    files: state.files,
  };
}
function preserve(repo, candidate, storage) {
  const tracked = new Set(
    git(candidate.root, ["ls-files", "-z"])
      .split("\0")
      .map((p) => p.replaceAll("/", path.sep)),
  );
  const archive = path.join(
    storage,
    "archives",
    `${Date.now()}-${hash(candidate.root).slice(0, 12)}`,
  );
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  const retained = candidate.files.filter((f) => !tracked.has(f.rel));
  for (const f of retained) {
    const src = path.join(candidate.root, f.rel);
    const dst = path.join(archive, "files", f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    if (hash(fs.readFileSync(dst)) !== f.sha256)
      throw new Error(`Backup verification failed: ${f.rel}`);
  }
  const manifest = {
    original: candidate.root,
    head: candidate.head,
    branch: candidate.branch,
    createdAt: Date.now(),
    retained,
    files: candidate.files,
  };
  save(path.join(archive, "manifest.json"), manifest);
  return archive;
}
function removeWithoutLinks(root, project, subtree = root) {
  if (!allowed(root, project))
    throw new Error("Removal escaped allowed workspace roots");
  if (!within(subtree, root)) throw new Error("Subtree escaped workspace");
  const pending = [[subtree, false]];
  while (pending.length) {
    const [p, after] = pending.pop();
    if (after) {
      fs.rmdirSync(p);
      continue;
    }
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink()) {
      fs.unlinkSync(p);
      continue;
    }
    if (!s.isDirectory()) {
      fs.unlinkSync(p);
      continue;
    }
    pending.push([p, true]);
    for (const child of fs.readdirSync(p))
      pending.push([path.join(p, child), false]);
  }
}
export function cleanup({
  repo,
  snapshot,
  apply = false,
  storage = path.join(os.homedir(), ".codex", "session-maintenance"),
  now = Date.now(),
}) {
  repo = path.resolve(repo);
  const common = path.resolve(
    repo,
    git(repo, ["rev-parse", "--git-common-dir"]).trim(),
  );
  const project = path.dirname(common);
  const logDir = path.join(storage, hash(norm(project)).slice(0, 12));
  // Always refresh the one authoritative merge proof. No network => no cleanup.
  git(repo, [
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  fs.mkdirSync(logDir, { recursive: true });
  const lock = path.join(logDir, "cleanup.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
  } catch {
    throw new Error("Cleanup is already running; inspect stale locks manually");
  }
  const results = [];
  try {
    for (const tree of registeredWorktrees(repo)) {
      let c;
      try {
        c = assess(repo, project, tree, snapshot, now);
        if (!c.eligible || !apply) {
          results.push({
            ...c,
            files: undefined,
            action: c.eligible ? "would_remove" : "preserved",
          });
          continue;
        }
        const archive = preserve(repo, c, logDir);
        const fresh = registeredWorktrees(repo).find(
          (t) => norm(t.worktree) === norm(c.root),
        );
        const recheck =
          fresh && assess(repo, project, fresh, snapshot, Date.now());
        if (
          !recheck?.eligible ||
          recheck.head !== c.head ||
          JSON.stringify(recheck.files) !== JSON.stringify(c.files)
        )
          throw new Error("Candidate changed after preservation");
        save(path.join(archive, "operation.json"), {
          phase: "deleting",
          root: c.root,
          head: c.head,
        });
        // Remove generated directories ourselves first, explicitly unlinking
        // dependency junctions. Git must never traverse a dependency target.
        const dirs = [c.root];
        while (dirs.length) {
          const dir = dirs.pop();
          for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const rel = path.relative(c.root, p);
            if (rel === ".git") continue;
            if (generated(rel)) removeWithoutLinks(c.root, project, p);
            else if (fs.lstatSync(p).isDirectory()) dirs.push(p);
          }
        }
        const finalTree = registeredWorktrees(repo).find(
          (t) => norm(t.worktree) === norm(c.root),
        );
        // Our cache removal changes directory mtimes. Only that cooldown check
        // is skipped; HEAD, branch, lock, index, activity and source are rechecked.
        const finalCheck =
          finalTree &&
          assess(repo, project, finalTree, snapshot, Date.now(), {
            ignoreRetention: true,
          });
        if (
          !finalCheck?.eligible ||
          finalCheck.head !== c.head ||
          finalCheck.branch !== c.branch ||
          JSON.stringify(finalCheck.files) !== JSON.stringify(c.files)
        )
          throw new Error("Candidate changed while clearing generated files");
        let gitError;
        try {
          git(repo, [
            "-c",
            "core.longpaths=true",
            "worktree",
            "remove",
            c.root,
          ]);
        } catch (e) {
          gitError = String(e.message);
        }
        if (fs.existsSync(c.root)) {
          if (
            registeredWorktrees(repo).some(
              (t) => norm(t.worktree) === norm(c.root),
            ) ||
            fs.existsSync(path.join(c.root, ".git"))
          )
            throw new Error(`Git removal refused: ${gitError}`);
          // Git on Windows can unregister a worktree and leave files behind.
          // Every remaining source must match the pre-removal hash, then remove
          // only this exact root, without following dependency junctions.
          const before = new Map(c.files.map((f) => [f.rel, f.sha256]));
          for (const f of inventory(c.root).files)
            if (before.get(f.rel) !== f.sha256)
              throw new Error(`Residual changed: ${f.rel}`);
          if (liveEvidence(project, c.root, snapshot, Date.now()))
            throw new Error("Activity appeared during removal");
          removeWithoutLinks(c.root, project);
        }
        if (fs.existsSync(c.root)) throw new Error("Removal incomplete");
        save(path.join(archive, "operation.json"), {
          phase: "removed",
          root: c.root,
          head: c.head,
        });
        results.push({
          root: c.root,
          action: "removed",
          archive,
          branch: c.branch,
        });
      } catch (e) {
        results.push({
          root: c?.root || path.resolve(tree.worktree),
          action: "preserved_or_error",
          reason: String(e.message),
        });
      }
    }
    const report = { at: Date.now(), apply, repo: project, results };
    save(path.join(logDir, `report-${Date.now()}.json`), report);
    save(path.join(logDir, "latest.json"), report);
    return report;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  try {
    if (args.includes("--prepare-snapshot")) {
      if (!args.includes("--repo") || !args.includes("--out"))
        throw new Error("Snapshot preparation requires --repo and --out");
      save(
        value("--out"),
        prepareSnapshot(value("--repo"), json(value("--prepare-snapshot"))),
      );
      console.log(
        "Fresh activity snapshot prepared; process command lines were not stored.",
      );
      process.exit(0);
    }
    if (!args.includes("--repo") || !args.includes("--snapshot"))
      throw new Error(
        "Usage: node session-cleanup.mjs --repo PATH --snapshot JSON [--apply]",
      );
    const report = cleanup({
      repo: value("--repo"),
      snapshot: json(value("--snapshot")),
      apply: args.includes("--apply"),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.results.some((r) => r.action === "preserved_or_error"))
      process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
