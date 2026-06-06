// coord.mjs — CLI تنسيق الشرائح بين الجلسات المتوازية (انظر coord-core.mjs والخطة).
// الاستخدام:
//   pnpm coord:claim <شريحة> --files <نمط...> [--hot] [--title "..."] [--lease <ث>] [--session-id <id>]
//   pnpm coord:release <شريحة> [--force]
//   pnpm coord:list [--json]
//   pnpm coord:status [--json]
//   pnpm coord:heartbeat
//   pnpm coord:reclaim [<شريحة>] [--live-session-ids a,b] [--dry-run]
// أكواد الخروج: 0 نجح/أملكها · 3 متنازَع (مالك حيّ آخر) · 4 معطوب (استرجاع متاح) · 1 خطأ استخدام/IO.
import { rmSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import {
  repoInfo, coordRootFor, ensureCoordDirs, sessionKeyFor, normSlice,
  buildClaimRecord, claimAtomic, claimPath, readClaim, readAllClaims,
  readJson, writeJson, isStale, isLive, leaseRemainingMs, appendEvent,
  sessionsDir, reclaimedDir, coordInitialized, hostname, INTEGRATION_SLICE,
} from "./coord-core.mjs";

const [, , sub, ...rest] = process.argv;

// ── تحليل الأعلام ──
const has = (f) => rest.includes(f);
function valueOf(flag) {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}
function multiOf(flag) {
  const i = rest.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < rest.length && !rest[j].startsWith("--"); j++) out.push(rest[j]);
  return out;
}
const positional = rest.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = rest[i - 1];
  // استبعد القيم التابعة لأعلام ذات قيمة واحدة
  if (["--title", "--lease", "--session-id", "--live-session-ids"].includes(prev)) return false;
  // استبعد قيم --files (متعدّدة)
  const fi = rest.indexOf("--files");
  if (fi >= 0 && i > fi) {
    let consumed = true;
    for (let k = fi + 1; k <= i; k++) if (rest[k].startsWith("--")) { consumed = false; break; }
    if (consumed) return false;
  }
  return true;
});

const JSONOUT = has("--json");
function fail(msg, code = 1) { console.error("✗", msg); process.exit(code); }
function out(human, obj) {
  if (JSONOUT) console.log(JSON.stringify(obj, null, 2));
  else console.log(human);
}

// ── التهيئة المشتركة ──
const info = repoInfo(process.cwd());
if (!info.ok) fail(info.err);
const coordRoot = coordRootFor(info.projectRoot);
const mySessionKey = sessionKeyFor(info.root, info.branch);
const myHost = hostname();

function ensureSessionRecord(extra = {}) {
  ensureCoordDirs(coordRoot);
  const file = path.join(sessionsDir(coordRoot), `${mySessionKey}.json`);
  const prev = readJson(file) || {};
  writeJson(file, {
    sessionKey: mySessionKey, branch: info.branch, worktree: info.root,
    cwd: process.cwd(), host: myHost, pid: process.pid,
    registeredAt: prev.registeredAt || Date.now(), heartbeatAt: Date.now(),
    ...prev, ...extra, heartbeatAt: Date.now(),
  });
}

function annotate(claim) {
  const now = Date.now();
  return { ...claim, live: isLive(claim, now, { hostname: myHost }), stale: isStale(claim, now, { hostname: myHost }), leaseRemainingMs: leaseRemainingMs(claim, now) };
}
const mins = (ms) => `${Math.round(ms / 60000)}m`;

// ───────────────────────── الأوامر ─────────────────────────

function cmdClaim() {
  const sliceRaw = positional[0];
  if (!sliceRaw) fail("الاسم مطلوب: coord claim <شريحة> --files <نمط...>");
  const slice = normSlice(sliceRaw);
  const files = multiOf("--files");
  const hot = has("--hot");
  if (hot && slice !== INTEGRATION_SLICE) fail(`--hot صالح فقط للشريحة المحجوزة «${INTEGRATION_SLICE}» (مالك الملفات الساخنة/الدمج).`);
  if (!hot && slice === INTEGRATION_SLICE) fail(`الشريحة «${INTEGRATION_SLICE}» محجوزة — استعملها مع --hot فقط.`);
  if (!files.length && !hot) fail("حدّد الملفات: --files <نمط...> (ملكية صريحة، كاتب واحد لكل ملف).");

  const record = buildClaimRecord({
    slice, title: valueOf("--title"), sessionKey: mySessionKey, sessionId: valueOf("--session-id"),
    branch: info.branch, worktree: info.root, ownedFiles: files, hot, leaseMs: valueOf("--lease") ? Number(valueOf("--lease")) * 1000 : undefined,
  });

  const res = claimAtomic(coordRoot, slice, record);
  if (res.ok) {
    ensureSessionRecord();
    appendEvent(coordRoot, "claim", { slice, sessionKey: mySessionKey, branch: info.branch, files });
    out(`✓ ادّعيتَ «${slice}»${hot ? " (الدمج/الملفات الساخنة)" : ""} للفرع ${info.branch}.\n  الملفات: ${files.join(", ") || "(الساخنة)"}\n  نبض كل ١٥ د — حرّر عند الفراغ: pnpm coord:release ${slice}`, { ok: true, slice, sessionKey: mySessionKey });
    process.exit(0);
  }
  if (res.code === "EEXIST") {
    const ex = annotate(res.existing);
    if (ex.sessionKey === mySessionKey) {
      writeJson(res.file, { ...res.existing, heartbeatAt: Date.now(), ownedFiles: files.length ? files : res.existing.ownedFiles });
      out(`• تملك «${slice}» أصلاً (نبض مُحدَّث).`, { ok: true, owned: true, slice });
      process.exit(0);
    }
    if (ex.stale) {
      out(`⚠ «${slice}» قفلٌ معطوب لـ ${ex.branch} (نبض منذ ${mins(-ex.leaseRemainingMs)} بعد المهلة).\n  استرجعه: pnpm coord:reclaim ${slice}`, { ok: false, code: "STALE", slice, existing: ex });
      process.exit(4);
    }
    out(`⛔ مرفوض: «${slice}» مملوكة للجلسة ${ex.branch} (حيّة، تبقّى ${mins(ex.leaseRemainingMs)}).\n  اختر شريحة أخرى — الصورة الحيّة: pnpm coord:list`, { ok: false, code: "CONTESTED", slice, existing: ex });
    process.exit(3);
  }
  fail(`تعذّر الادّعاء: ${res.err || res.code}`);
}

function cmdRelease() {
  const slice = normSlice(positional[0] || "");
  if (!positional[0]) fail("الاسم مطلوب: coord release <شريحة>");
  const file = claimPath(coordRoot, slice);
  const claim = readClaim(coordRoot, slice);
  if (!claim) { out(`• لا ادّعاء باسم «${slice}» (لا شيء لتحريره).`, { ok: true, slice, missing: true }); process.exit(0); }
  const force = has("--force");
  if (claim.sessionKey !== mySessionKey && !force) {
    out(`⛔ «${slice}» مملوكة للفرع ${claim.branch} لا لك. للإجبار (مخرج طوارئ): pnpm coord:release ${slice} --force`, { ok: false, code: "NOT_OWNER", slice });
    process.exit(3);
  }
  rmSync(file, { force: true });
  appendEvent(coordRoot, force && claim.sessionKey !== mySessionKey ? "force-release" : "release", { slice, by: mySessionKey, owner: claim.sessionKey });
  out(`✓ حُرِّرت «${slice}».`, { ok: true, slice, released: true });
  process.exit(0);
}

function cmdList() {
  const claims = readAllClaims(coordRoot).map(annotate)
    .sort((a, b) => a.slice.localeCompare(b.slice));
  if (JSONOUT) { console.log(JSON.stringify({ coordRoot, claims }, null, 2)); process.exit(0); }
  if (!claims.length) { console.log("لا ادّعاءات نشطة. سجّل شريحتك: pnpm coord:claim <شريحة> --files <نمط...>"); process.exit(0); }
  console.log(`الادّعاءات (السجلّ: ${coordRoot}):\n`);
  console.log("الشريحة".padEnd(18) + "الفرع".padEnd(26) + "الحالة".padEnd(9) + "المهلة".padEnd(12) + "الملفات");
  console.log("─".repeat(96));
  for (const c of claims) {
    const state = c.stale ? "معطوب!" : c.status;
    const lease = c.stale ? "STALE" : `ok(${mins(c.leaseRemainingMs)})`;
    const files = c.hot ? "[ساخنة/دمج]" : (c.ownedFiles || []).join(", ");
    console.log(String(c.slice).padEnd(18) + String(c.branch).padEnd(26) + state.padEnd(9) + lease.padEnd(12) + files);
  }
  process.exit(0);
}

function cmdStatus() {
  const all = readAllClaims(coordRoot).map(annotate);
  const mine = all.filter((c) => c.sessionKey === mySessionKey);
  const onMain = info.branch === "main" || info.branch === "master";
  const data = { ok: true, sessionKey: mySessionKey, branch: info.branch, worktree: info.root, coordRoot, initialized: coordInitialized(coordRoot), onMain, myClaims: mine.map((c) => c.slice) };
  if (JSONOUT) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }
  console.log(`الجلسة:   ${mySessionKey}`);
  console.log(`الفرع:    ${info.branch}`);
  console.log(`المجلّد:  ${info.root}`);
  console.log(`السجلّ:   ${coordRoot} ${coordInitialized(coordRoot) ? "(مُهيّأ)" : "(غير مُهيّأ بعد)"}`);
  if (onMain) console.log(`\n🚫 أنت على ${info.branch} — لا تكتب كوداً مباشرة. أنشئ جلسة: pnpm session:new <اسم>`);
  console.log(`\nادّعاءاتك: ${mine.length ? mine.map((c) => c.slice).join(", ") : "(لا شيء — ادّعِ شريحة قبل الكتابة)"}`);
  process.exit(0);
}

function cmdHeartbeat() {
  ensureSessionRecord();
  const now = Date.now();
  let n = 0;
  for (const c of readAllClaims(coordRoot)) {
    if (c.sessionKey === mySessionKey) { writeJson(claimPath(coordRoot, c.slice), { ...c, heartbeatAt: now }); n++; }
  }
  out(`✓ نبض مُحدَّث (${n} ادّعاء).`, { ok: true, refreshed: n });
  process.exit(0);
}

function cmdReclaim() {
  const onlySlice = positional[0] ? normSlice(positional[0]) : null;
  const dry = has("--dry-run");
  const liveIds = (valueOf("--live-session-ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const now = Date.now();
  const reclaimed = [];
  for (const c of readAllClaims(coordRoot)) {
    if (onlySlice && c.slice !== onlySlice) continue;
    if (!isStale(c, now, { hostname: myHost, liveSessionIds: liveIds })) continue;
    reclaimed.push(c.slice);
    if (!dry) {
      const dest = path.join(reclaimedDir(coordRoot), `${c.slice}-${now}.json`);
      try { renameSync(claimPath(coordRoot, c.slice), dest); } catch { rmSync(claimPath(coordRoot, c.slice), { force: true }); }
      appendEvent(coordRoot, "reclaim", { slice: c.slice, formerOwner: c.sessionKey, by: mySessionKey });
    }
  }
  out(`${dry ? "(تجربة) " : ""}أقفال معطوبة مُسترجَعة: ${reclaimed.length ? reclaimed.join(", ") : "لا شيء"}.`, { ok: true, dryRun: dry, reclaimed });
  process.exit(0);
}

switch (sub) {
  case "claim": cmdClaim(); break;
  case "release": cmdRelease(); break;
  case "list": cmdList(); break;
  case "status": cmdStatus(); break;
  case "heartbeat": cmdHeartbeat(); break;
  case "reclaim-stale": case "reclaim": cmdReclaim(); break;
  default:
    console.log("الأوامر: claim <شريحة> --files <نمط...> [--hot] | release <شريحة> [--force] | list | status | heartbeat | reclaim [<شريحة>]");
    process.exit(sub ? 1 : 0);
}
