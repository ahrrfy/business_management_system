// pretooluse-guard.mjs — hook إنفاذ (PreToolUse على Write|Edit|MultiEdit|NotebookEdit).
// يقرأ payload الـ hook من stdin، ويقرّر السماح/الرفض حسب سجلّ التنسيق المشترك.
// يرفض: (أ) الكتابة على main · (ب) ملف ساخن لغير مالك التكامل · (ج) ملف تملكه جلسة أخرى حيّة.
// مبدأ السلامة: **يفشل مفتوحاً** — أي خطأ/سجلّ غير مُهيّأ ⇒ يسمح (لا يكسر الكتابة المشروعة أبداً).
// لا يعتمد على node_modules. انظر coord-core.mjs والخطة.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  repoInfo, coordRootFor, sessionKeyFor, coordInitialized,
  readAllClaims, isLive, isHotFile, matchesAny, toRepoRel,
  appendEvent, hostname, INTEGRATION_SLICE,
} from "../coord-core.mjs";

function out(decision, reason) {
  const o = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } };
  if (reason) o.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(o));
  process.exit(0);
}
const allow = () => out("allow");

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const payload = JSON.parse((await readStdin()).replace(/^﻿/, "").trim() || "{}");
  const cwd = payload.cwd || process.cwd();
  const ti = payload.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (!file) allow();                                  // أداة بلا ملف ⇒ لا شأن لنا

  const info = repoInfo(cwd);
  if (!info.ok) allow();                               // خارج مستودع git ⇒ لا إنفاذ
  const coordRoot = coordRootFor(info.projectRoot);

  // مخرج الطوارئ للمالك (يُسجَّل).
  if (process.env.COORD_BYPASS === "1" || existsSync(path.join(coordRoot, "BYPASS"))) {
    appendEvent(coordRoot, "bypass", { branch: info.branch, file });
    allow();
  }

  // فشل مفتوح: النظام لم يُهيّأ بعد (لم تُنشأ claims/) ⇒ لا تعطّل عملاً.
  if (!coordInitialized(coordRoot)) allow();

  const rel = toRepoRel(info.root, cwd, file);
  const mySessionKey = sessionKeyFor(info.root, info.branch);
  const myHost = hostname();
  const now = Date.now();
  const claims = readAllClaims(coordRoot);

  // (أ) منع الكتابة المباشرة على main/master.
  if (info.branch === "main" || info.branch === "master") {
    out("deny", `🚫 الكتابة المباشرة على «${info.branch}» ممنوعة. أنشئ جلسة معزولة: pnpm session:new <اسم> واعمل على فرعها.\n(طوارئ المالك: عيّن COORD_BYPASS=1 في هذه الجلسة.)`);
  }

  // (ب) ملف ساخن: يُسمح فقط لمن يملك ادّعاء التكامل الحيّ.
  if (isHotFile(rel)) {
    const integ = claims.find((c) => c.slice === INTEGRATION_SLICE && isLive(c, now, { hostname: myHost }));
    if (!(integ && integ.sessionKey === mySessionKey)) {
      out("deny", `🔥 «${rel}» ملف ساخن (نقطة تكامل/دمج) يملكه القائد فقط — مغناطيس تعارض الدمج.\nإن كنت قائد الدمج: pnpm coord:claim _integration --hot. وإلا اترك تعديله لمالك التكامل (راوتر/مسار/تنقّل/مخطط/seed).`);
    }
  }

  // (ج) ملف ضمن ملكية جلسة أخرى حيّة.
  for (const c of claims) {
    if (c.sessionKey === mySessionKey) continue;
    if (!["active", "merging"].includes(c.status || "active")) continue;
    if (!isLive(c, now, { hostname: myHost })) continue;
    if (matchesAny(rel, c.ownedFiles)) {
      out("deny", `⛔ «${rel}» مملوك للجلسة «${c.branch}» (شريحة «${c.slice}»). كاتب واحد لكل ملف — لا تكتبه.\nنسّق مع المالك أو اختر ملفاً غير مملوك. الصورة الحيّة: pnpm coord:list`);
    }
  }

  allow();                                             // فرع جلسة + ملف غير متنازَع ⇒ مسموح
} catch {
  // أي خطأ غير متوقّع ⇒ افشل مفتوحاً (لا تكسر الكتابة أبداً).
  try { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })); } catch { /* تجاهل */ }
  process.exit(0);
}
