// إدارة جلسات/فروع العمل المعزولة عبر git worktree — كي لا تتعارض الجلسات/الوكلاء على نفس الملفات.
// الاستخدام:
//   pnpm session:new <اسم> [--from <فرع-الأساس>] [--port <n>] [--no-install] [--no-db]
//        إنشاء فرع session/<اسم> + شجرة عمل معزولة + قاعدة/منفذ/‎.env مستقلّين + تسجيل في سجلّ التنسيق
//   pnpm session:list                                عرض كل أشجار العمل وفروعها
//   pnpm session:remove <اسم> [--keep-branch]         إزالة شجرة العمل (والفرع ما لم يُطلب إبقاؤه)
// كل شجرة عمل = مجلّد مستقل بفهرس git خاص + قاعدة بيانات + منفذ ⇒ عزل حقيقي (انظر CLAUDE.md §٧ + coord).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  coordRootFor, sessionKeyFor, ensureCoordDirs, sessionsDir, writeJson, readJson,
} from "./coord-core.mjs";

function git(args, { capture = true } = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
}
function tryGit(args) {
  try { return { ok: true, out: git(args).trim() }; } catch (e) { return { ok: false, err: e?.message ?? String(e) }; }
}
function fail(msg) { console.error("✗", msg); process.exit(1); }
function warn(msg) { console.warn("⚠", msg); }

const [, , sub, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const positional = rest.filter((a, i) => {
  if (a.startsWith("--")) return false;
  if (["--from", "--port"].includes(rest[i - 1])) return false;
  return true;
});
const name = positional[0];
const flagVal = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };

const repoRoot = tryGit(["rev-parse", "--show-toplevel"]);
if (!repoRoot.ok) fail("ليست داخل مستودع git.");
const root = repoRoot.out;
// الجذر الأساسي للمشروع = أب الـ .git المشترك ⇒ مفتاح تنسيق موحّد حتى لو نُفّذ الأمر من worktree.
const commonDir = tryGit(["rev-parse", "--git-common-dir"]);
const projectRoot = commonDir.ok ? path.dirname(path.resolve(root, commonDir.out)) : root;
const parent = path.dirname(root);
const base = path.basename(root);
const wtPath = (n) => path.join(parent, `${base}__${n}`);
const validName = (n) => /^[a-z0-9][a-z0-9-]*$/.test(n);

function branchExists(branch) {
  return tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

// ───────────────────────── أدوات العزل ─────────────────────────

// أزواج KEY=VALUE من نصّ .env (يتجاهل التعليقات/الفراغات).
function parseEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

// استبدل اسم القاعدة في عنوان الاتصال (آخر مقطع بعد /، قبل أي ?).
function withDb(url, db) {
  const m = String(url).match(/^(.*\/)([^/?]+)(\?.*)?$/);
  return m ? `${m[1]}${db}${m[3] || ""}` : url;
}

// المنافذ المستعملة في أشجار العمل المجاورة (لاختيار منفذ فريد).
function usedSiblingPorts() {
  const used = new Set([3000]); // 3000 محجوز للجلسة الرئيسية على main
  try {
    for (const entry of readdirSync(parent)) {
      if (!entry.startsWith(`${base}__`)) continue;
      const envFile = path.join(parent, entry, ".env");
      if (!existsSync(envFile)) continue;
      const p = parseEnv(readFileSync(envFile, "utf8")).get("PORT");
      if (p) used.add(Number(p));
    }
  } catch { /* تجاهل */ }
  return used;
}
function pickPort(preferred) {
  if (preferred) return Number(preferred);
  const used = usedSiblingPorts();
  for (let p = 3001; p <= 3019; p++) if (!used.has(p)) return p;
  return 3001;
}

// أنشئ قاعدتَي التطوير والاختبار للجلسة (idempotent). يفشل ناعماً إن كان Docker متوقّفاً.
function provisionDbs(dbName, testDbName) {
  const container = process.env.DB_CONTAINER ?? "erp-mysql";
  const pw = process.env.DB_ROOT_PW ?? "erp_root_pw";
  const sql =
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` +
    `CREATE DATABASE IF NOT EXISTS \`${testDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
  try {
    execFileSync("docker", ["exec", container, "mysql", "-uroot", `-p${pw}`, "-e", sql], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e?.message ?? String(e) };
  }
}

// اكتب .env للـ worktree من قالب الجذر مع تجاوز المفاتيح الثلاثة (دون طمس الأسرار إن وُجد الملف).
function writeWorktreeEnv(dir, overrides) {
  const rootEnvFile = path.join(root, ".env");
  const wtEnvFile = path.join(dir, ".env");
  const srcFile = existsSync(wtEnvFile) ? wtEnvFile : (existsSync(rootEnvFile) ? rootEnvFile : null);
  let lines = srcFile ? readFileSync(srcFile, "utf8").split(/\r?\n/) : [
    "NODE_ENV=development", "PORT=3000", "DATABASE_URL=mysql://root:erp_root_pw@127.0.0.1:3306/erp",
  ];
  for (const [key, val] of Object.entries(overrides)) {
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = `${key}=${val}`;
    else lines.push(`${key}=${val}`);
  }
  writeFileSync(wtEnvFile, lines.join("\n"));
  return wtEnvFile;
}

// شغّل أمراً داخل مجلّد الجلسة (للتثبيت/الهجرة/البذرة).
function runIn(dir, cmd, args) {
  execFileSync(cmd, args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
}

// سجّل الجلسة في سجلّ التنسيق المشترك (يُفعّل إنفاذ الـ hooks من أول جلسة).
function registerSession(dir, branch, port) {
  try {
    const coordRoot = coordRootFor(projectRoot); // الجذر الأساسي (أب .git المشترك) ⇒ مفتاح موحّد
    ensureCoordDirs(coordRoot);
    const key = sessionKeyFor(dir, branch);
    const file = path.join(sessionsDir(coordRoot), `${key}.json`);
    const prev = readJson(file) || {};
    writeJson(file, {
      sessionKey: key, branch, worktree: dir, cwd: dir, host: os.hostname(), port,
      registeredAt: prev.registeredAt || Date.now(), heartbeatAt: Date.now(),
    });
    return { ok: true, key, coordRoot };
  } catch (e) {
    return { ok: false, err: e?.message ?? String(e) };
  }
}

// ───────────────────────── الأوامر ─────────────────────────

function cmdNew() {
  if (!name) fail("الاسم مطلوب: pnpm session:new <اسم>");
  if (!validName(name)) fail("الاسم بحروف صغيرة وأرقام وشُرَط فقط (kebab-case): مثل work-orders أو price-list.");
  const fromBase = flagVal("--from") || "main";
  const branch = `session/${name}`;
  const dir = wtPath(name);
  const noInstall = flags.has("--no-install");
  const noDb = flags.has("--no-db");

  if (existsSync(dir)) fail(`المجلّد موجود سلفاً: ${dir}`);

  // ١) الفرع + شجرة العمل
  const exists = branchExists(branch);
  const args = exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, fromBase];
  console.log(`• ${exists ? "ربط فرع موجود" : `تفريع ${branch} من ${fromBase}`} ⇒ شجرة عمل معزولة…`);
  const res = tryGit(args);
  if (!res.ok) fail(`فشل إنشاء شجرة العمل:\n${res.err}`);

  const dbName = `erp_${name.replace(/-/g, "_")}`;
  const testDbName = `${dbName}_test`;
  const port = pickPort(flagVal("--port"));

  // ٢) قاعدتا البيانات
  if (!noDb) {
    const prov = provisionDbs(dbName, testDbName);
    if (prov.ok) console.log(`• قاعدتان جاهزتان: ${dbName} (تطوير) + ${testDbName} (اختبار)`);
    else warn(`تعذّر إنشاء القاعدتين تلقائياً (Docker متوقّف؟). أنشئهما يدوياً:\n` +
      `   docker exec erp-mysql mysql -uroot -perp_root_pw -e "CREATE DATABASE \\\`${dbName}\\\`; CREATE DATABASE \\\`${testDbName}\\\`;"`);
  }

  // ٣) ‎.env للجلسة (منفذ + قاعدتان مستقلّتان)
  const rootEnv = existsSync(path.join(root, ".env")) ? parseEnv(readFileSync(path.join(root, ".env"), "utf8")) : new Map();
  const baseUrl = rootEnv.get("DATABASE_URL") || "mysql://root:erp_root_pw@127.0.0.1:3306/erp";
  const envFile = writeWorktreeEnv(dir, {
    PORT: String(port),
    DATABASE_URL: withDb(baseUrl, dbName),
    TEST_DATABASE_URL: withDb(baseUrl, testDbName),
  });
  console.log(`• ‎.env مكتوب: ${path.relative(parent, envFile)} (PORT=${port})`);

  // ٤) التثبيت + الهجرة + البذرة
  if (!noInstall) {
    try { console.log("• تثبيت الحزم (شجرة العمل لا ترث node_modules)…"); runIn(dir, "pnpm", ["install"]); }
    catch { warn("فشل pnpm install — ثبّت يدوياً داخل المجلّد."); }
  }
  if (!noDb && !noInstall) {
    try { console.log("• هجرة المخطط + بذرة…"); runIn(dir, "pnpm", ["db:push"]); runIn(dir, "pnpm", ["seed"]); }
    catch { warn("فشل db:push/seed — نفّذهما يدوياً داخل المجلّد بعد تشغيل Docker."); }
  }

  // ٥) تسجيل الجلسة في سجلّ التنسيق
  const reg = registerSession(dir, branch, port);
  if (reg.ok) console.log(`• مُسجَّلة في سجلّ التنسيق: ${reg.key}`);
  else warn(`تعذّر التسجيل في سجلّ التنسيق: ${reg.err}`);

  console.log(`\n✓ جلسة جاهزة ومعزولة: ${branch}`);
  console.log(`  المجلّد:  ${dir}`);
  console.log(`  المنفذ:   ${port}   ·   القاعدة: ${dbName}`);
  console.log(`\nالخطوات التالية:`);
  console.log(`  cd "${dir}"`);
  if (noInstall) console.log(`  pnpm install`);
  if (noDb) console.log(`  # أنشئ القاعدتين ثم: pnpm db:push && pnpm seed`);
  console.log(`  pnpm coord:claim ${name} --files <ملفاتك...>   # ادّعِ شريحتك قبل الكتابة (كاتب واحد لكل ملف)`);
  console.log(`  pnpm dev                                         # على المنفذ ${port}`);
  console.log(`\nتذكير (§٧): الملفات الساخنة (routers.ts / App.tsx / التنقّل / schema.ts / seed.ts) يملكها قائد الدمج فقط.`);
  console.log(`عند الفراغ: ادمج إلى main ثم  pnpm coord:release ${name}  ثم  pnpm session:remove ${name}`);
}

function cmdList() {
  const res = tryGit(["worktree", "list"]);
  if (!res.ok) fail(res.err);
  console.log("أشجار العمل الحالية (كل سطر = جلسة معزولة محتملة):\n");
  console.log(res.out);
  console.log("\nالصورة الحيّة للادّعاءات: pnpm coord:list");
}

function cmdRemove() {
  if (!name) fail("الاسم مطلوب: pnpm session:remove <اسم>");
  const branch = `session/${name}`;
  const dir = wtPath(name);
  const res = tryGit(["worktree", "remove", dir]);
  if (!res.ok) {
    console.error("✗ تعذّرت الإزالة (قد تكون فيها تغييرات غير ملتزمة). للإزالة القسرية:");
    console.error(`  git worktree remove --force "${dir}"`);
    process.exit(1);
  }
  console.log(`✓ أُزيلت شجرة العمل: ${dir}`);
  if (!flags.has("--keep-branch")) {
    const del = tryGit(["branch", "-d", branch]);
    console.log(del.ok ? `✓ حُذف الفرع ${branch}` : `• أُبقي الفرع ${branch} (غير مدموج؟ احذفه بـ git branch -D ${branch}).`);
  }
  console.log(`تذكير: حرّر ادّعاء الشريحة إن لم تفعل — pnpm coord:release ${name}`);
}

switch (sub) {
  case "new": cmdNew(); break;
  case "list": cmdList(); break;
  case "remove": cmdRemove(); break;
  default:
    console.log("الأوامر: new <اسم> [--from <فرع>] [--port <n>] [--no-install] [--no-db] | list | remove <اسم> [--keep-branch]");
    process.exit(sub ? 1 : 0);
}
