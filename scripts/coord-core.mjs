// coord-core.mjs — مكتبة التنسيق النقيّة (بلا حالة عامة، قابلة للاختبار بـ node العاري).
// المسؤولية: حساب جذر التنسيق المشترك خارج كل worktrees، القفل الذرّي للشريحة (O_EXCL)،
// هوية الجلسة، كشف الأقفال المعطوبة (lease)، مطابقة glob، وسجلّ الأحداث.
// تعتمد فقط على وحدات Node المدمجة ⇒ تعمل بلا node_modules (مهم: الـ hooks تُنفَّذ مبكراً).
// انظر CLAUDE.md §٧ والخطة: C:\Users\alara\.claude\plans\shiny-singing-seal.md
import { execFileSync } from "node:child_process";
import {
  openSync, writeSync, closeSync, readFileSync, writeFileSync,
  mkdirSync, readdirSync, existsSync, renameSync, appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_MS = 15 * 60 * 1000; // ١٥ دقيقة
export const SKEW_GRACE_MS = 30 * 1000;          // هامش انحراف ساعة قبل اعتبار القفل معطوباً

// الملفات الساخنة (مغناطيس تعارض الدمج — يملكها القائد/الدمج فقط). مطابقة غير حسّاسة لحالة الأحرف.
export const HOT_FILES = [
  "server/routers.ts",
  "client/src/app.tsx",
  "client/src/components/applayout.tsx",
  "drizzle/schema.ts",
  "server/seed.ts",
];

export const INTEGRATION_SLICE = "_integration"; // الشريحة المحجوزة لمالك الملفات الساخنة/الدمج

// ───────────────────────── git/مسارات ─────────────────────────

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function tryGit(args, cwd) {
  try { return { ok: true, out: git(args, cwd) }; }
  catch (e) { return { ok: false, err: e?.message ?? String(e) }; }
}

// معلومات المستودع من أي worktree: الجذر العلوي، الجذر المشترك (.git المشترك)، والفرع الحالي.
export function repoInfo(cwd = process.cwd()) {
  const top = tryGit(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) return { ok: false, err: "ليست داخل مستودع git" };
  const root = path.resolve(top.out);
  const commonRel = tryGit(["rev-parse", "--git-common-dir"], cwd);
  const commonDir = commonRel.ok ? path.resolve(root, commonRel.out) : path.join(root, ".git");
  // الجذر «الأساسي» للمشروع = أب الـ .git المشترك ⇒ متطابق لكل worktrees المشروع.
  const projectRoot = path.dirname(commonDir);
  const br = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = br.ok ? br.out : "(unknown)";
  return { ok: true, root, projectRoot, commonDir, branch };
}

function sha256hex(s) { return createHash("sha256").update(s).digest("hex"); }

// مفتاح المشروع: مستقرّ عبر كل worktrees لأنه مشتقّ من الجذر الأساسي (أب .git المشترك).
export function projectKey(projectRoot) {
  const norm = path.resolve(projectRoot).toLowerCase();
  return `${path.basename(projectRoot)}-${sha256hex(norm).slice(0, 8)}`;
}

// جذر التنسيق المشترك: خارج كل worktrees (تحت ~/.claude) ⇒ تراه كل الجلسات/الـ hooks بنفس المسار.
export function coordRootFor(projectRoot, home = os.homedir()) {
  return path.join(home, ".claude", "coord", projectKey(projectRoot));
}
export const claimsDir = (coordRoot) => path.join(coordRoot, "claims");
export const sessionsDir = (coordRoot) => path.join(coordRoot, "sessions");
export const reclaimedDir = (coordRoot) => path.join(coordRoot, "claims", "_reclaimed");
export const eventsLog = (coordRoot) => path.join(coordRoot, "events.log");

export function ensureCoordDirs(coordRoot) {
  mkdirSync(claimsDir(coordRoot), { recursive: true });
  mkdirSync(sessionsDir(coordRoot), { recursive: true });
  mkdirSync(reclaimedDir(coordRoot), { recursive: true });
}

// هل سُجِّل نظام التنسيق سابقاً؟ (وجود claims/ يعني «النظام مُهيّأ» — وإلا فالـ hook يفشل مفتوحاً).
export function coordInitialized(coordRoot) {
  return existsSync(claimsDir(coordRoot));
}

// ───────────────────────── الهوية ─────────────────────────

export function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

// تطبيع اسم الشريحة مع الحفاظ على الاسم المحجوز «_integration» (الذي يطمسه slugify لـ"integration").
export function normSlice(s) {
  const raw = String(s ?? "").trim();
  if (raw === INTEGRATION_SLICE || slugify(raw) === "integration") return INTEGRATION_SLICE;
  return slugify(raw);
}

// مفتاح الجلسة: يحسبه الـ hook والجلسة بنفس الطريقة بلا MCP — من الفرع + مسار شجرة العمل.
export function sessionKeyFor(worktreeAbsPath, branch) {
  const brSlug = slugify(branch.replace(/^session\//, ""));
  return `session__${brSlug}__${sha256hex(path.resolve(worktreeAbsPath).toLowerCase()).slice(0, 6)}`;
}

// ───────────────────────── JSON ─────────────────────────

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } // تحمّل BOM (محرّرات ويندوز)
  catch { return null; }
}
// كتابة غير ذرّية للسجلّات التي نملكها أصلاً (نبض/جلسات): اكتب مؤقّتاً ثم أعد التسمية.
export function writeJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

// ───────────────────────── القفل الذرّي ─────────────────────────

// claimAtomic: المِفتاح الذرّي. fs.open(..,'wx') = O_CREAT|O_EXCL ⇒ على قرص محلّي:
// كاتب واحد ينجح، الباقون EEXIST. لا سباق ممكن حتى لو بدأت جلستان في نفس اللحظة.
// (ملاحظة: O_EXCL غير موثوق على بعض أنظمة الملفات الشبكية؛ هنا المسار محلّي على ~ ⇒ موثوق.)
export function claimAtomic(coordRoot, slice, record) {
  ensureCoordDirs(coordRoot);
  const file = path.join(claimsDir(coordRoot), `${normSlice(slice)}.json`);
  try {
    const fd = openSync(file, "wx");
    try { writeSync(fd, JSON.stringify(record, null, 2)); } finally { closeSync(fd); }
    return { ok: true, file };
  } catch (e) {
    if (e && e.code === "EEXIST") return { ok: false, code: "EEXIST", file, existing: readJson(file) };
    return { ok: false, code: e?.code ?? "ERR", file, err: e?.message ?? String(e) };
  }
}

export function claimPath(coordRoot, slice) {
  return path.join(claimsDir(coordRoot), `${normSlice(slice)}.json`);
}

export function readClaim(coordRoot, slice) {
  return readJson(claimPath(coordRoot, slice));
}

export function readAllClaims(coordRoot) {
  const dir = claimsDir(coordRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(dir, f)))
    .filter(Boolean);
}

// ───────────────────────── الأقفال المعطوبة ─────────────────────────

// قفل قابل للاسترجاع فقط إذا: ① انتهت المهلة، ② نفس المضيف، ③ (إن توفّر) المالك غير حيّ.
// القواعد ②③ تجعل الاسترجاع أكثر تحفّظاً فقط ⇒ جلسة حيّة تنبض لا تُسترجَع أبداً.
export function isStale(claim, now = Date.now(), opts = {}) {
  if (!claim) return false;
  const lease = Number(claim.leaseMs) || DEFAULT_LEASE_MS;
  const hb = Number(claim.heartbeatAt) || Number(claim.createdAt) || 0;
  const leaseExpired = now > hb + lease + SKEW_GRACE_MS;
  if (!leaseExpired) return false;                                   // ① نبض حديث = حيّ
  if (claim.host && opts.hostname && claim.host !== opts.hostname) return false; // ② مضيف آخر
  // ③ إن أُعطيت قائمة الجلسات الحيّة وكان sessionId للمالك ضمنها ⇒ حيّ، لا تسترجع.
  if (Array.isArray(opts.liveSessionIds) && claim.sessionId && opts.liveSessionIds.includes(claim.sessionId)) return false;
  return true;
}

// نبض حيّ: قفل غير معطوب (للعرض «حيّ/معطوب»).
export function isLive(claim, now = Date.now(), opts = {}) {
  return !!claim && !isStale(claim, now, opts);
}

export function leaseRemainingMs(claim, now = Date.now()) {
  const lease = Number(claim?.leaseMs) || DEFAULT_LEASE_MS;
  const hb = Number(claim?.heartbeatAt) || Number(claim?.createdAt) || 0;
  return hb + lease - now;
}

// ───────────────────────── مطابقة glob ─────────────────────────

// تطبيع مسار إلى «نسبي للجذر، فواصل POSIX، حالة موحّدة» للمقارنة على ويندوز.
export function toRepoRel(repoRoot, cwd, file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join("/");
}
export function normRel(rel) {
  return rel.split("\\").join("/").replace(/^\.\//, "").toLowerCase();
}

// glob مبسّط: ** ⇒ أي شيء، * ⇒ غير الفواصل، ? ⇒ محرف واحد غير فاصل. مقارنة غير حسّاسة للحالة.
export function globToRegExp(glob) {
  const g = normRel(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export function matchGlob(rel, glob) {
  return globToRegExp(glob).test(normRel(rel));
}
export function matchesAny(rel, globs) {
  return Array.isArray(globs) && globs.some((g) => matchGlob(rel, g));
}
export function isHotFile(rel) {
  return HOT_FILES.includes(normRel(rel));
}

// ───────────────────────── سجلّ الأحداث ─────────────────────────

export function appendEvent(coordRoot, type, data = {}) {
  try {
    ensureCoordDirs(coordRoot);
    const line = JSON.stringify({ at: Date.now(), type, ...data }) + "\n";
    appendFileSync(eventsLog(coordRoot), line);
  } catch { /* السجلّ مساعد لا حرج — لا تُفشل العملية بسببه */ }
}

// ───────────────────────── أدوات عامة ─────────────────────────

export function nowMs() { return Date.now(); }
export function hostname() { return os.hostname(); }

// بناء سجلّ ادّعاء كامل.
export function buildClaimRecord({ slice, title, sessionKey, sessionId, branch, worktree, ownedFiles, hot, leaseMs }) {
  const now = Date.now();
  return {
    schema: SCHEMA_VERSION,
    slice: normSlice(slice),
    title: title || slice,
    sessionKey,
    sessionId: sessionId || null,
    branch,
    worktree,
    ownedFiles: Array.isArray(ownedFiles) ? ownedFiles : [],
    hot: !!hot,
    status: "active",
    createdAt: now,
    heartbeatAt: now,
    leaseMs: Number(leaseMs) || DEFAULT_LEASE_MS,
    pid: process.pid,
    host: os.hostname(),
  };
}
