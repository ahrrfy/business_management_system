// session-start.mjs — hook بدء الجلسة (SessionStart).
// يُهيّئ سجلّ التنسيق (يُفعّل الإنفاذ من أول جلسة) ويحقن الصورة الحيّة + تحذير main في سياق الجلسة.
// لا يمنع البدء أبداً (يخرج بهدوء عند أي خطأ). لا يعتمد على node_modules.
import {
  repoInfo, coordRootFor, ensureCoordDirs, sessionKeyFor,
  readAllClaims, isLive, hostname,
} from "../coord-core.mjs";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const payload = JSON.parse((await readStdin()).replace(/^﻿/, "").trim() || "{}");
  const cwd = payload.cwd || process.cwd();
  const info = repoInfo(cwd);
  if (!info.ok) process.exit(0);

  const coordRoot = coordRootFor(info.projectRoot);
  ensureCoordDirs(coordRoot);                          // تهيئة ⇒ يصبح إنفاذ PreToolUse فعّالاً
  const mySessionKey = sessionKeyFor(info.root, info.branch);
  const myHost = hostname();
  const now = Date.now();
  const claims = readAllClaims(coordRoot);
  const onMain = info.branch === "main" || info.branch === "master";

  const L = [];
  L.push("🔒 نظام تنسيق الجلسات (coord) فعّال — يمنع تزاحم الوكلاء المتوازين على نفس الشريحة/الملفات.");
  L.push(`فرعك: ${info.branch} · مفتاح جلستك: ${mySessionKey}`);

  if (onMain) {
    L.push("");
    L.push(`🚫 أنت على «${info.branch}»: الكتابة المباشرة محظورة بـ hook. قبل أي كود: pnpm session:new <اسم> ثم اعمل على فرع الجلسة. (طوارئ: COORD_BYPASS=1)`);
  }

  const active = claims.filter((c) => isLive(c, now, { hostname: myHost }));
  if (active.length) {
    L.push("");
    L.push("الشرائح المُدّعاة الآن — لا تختر شريحة مملوكة ولا تكتب ملف جلسة أخرى:");
    for (const c of active) {
      const who = c.sessionKey === mySessionKey ? "(أنت)" : c.branch;
      L.push(`  • ${c.slice} — ${who}${c.hot ? " [دمج/ساخنة]" : ""} — ${(c.ownedFiles || []).join(", ") || "(الملفات الساخنة)"}`);
    }
  } else {
    L.push("");
    L.push("لا شرائح مُدّعاة بعد. قبل الكتابة: pnpm coord:claim <شريحة> --files <نمط...> (كاتب واحد لكل ملف).");
  }

  const stale = claims.filter((c) => !isLive(c, now, { hostname: myHost }));
  if (stale.length) L.push(`\n⚠ أقفال معطوبة: ${stale.map((c) => c.slice).join(", ")} — استرجاع: pnpm coord:reclaim`);

  L.push("\nأوامر: pnpm coord:list (الصورة الحيّة) · pnpm coord:status (حالتك) · pnpm coord:release <شريحة> (عند الفراغ)");

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: L.join("\n") } }));
  process.exit(0);
} catch {
  process.exit(0);                                     // SessionStart لا يعطّل البدء أبداً
}
