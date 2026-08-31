// إدارة جلسات/فروع العمل المعزولة عبر git worktree — كي لا تتعارض الجلسات/الوكلاء على نفس الملفات.
// الاستخدام:
//   pnpm session:new <اسم> [--from <فرع-الأساس>] [--port <n>] [--no-install] [--no-db]
//        إنشاء فرع session/<اسم> + شجرة عمل معزولة + قاعدة/منفذ/‎.env مستقلّين + تسجيل في سجلّ التنسيق
//   pnpm session:list                                عرض كل أشجار العمل وفروعها
//   pnpm session:remove <اسم> [--keep-branch]         إزالة شجرة العمل (والفرع ما لم يُطلب إبقاؤه)
// كل شجرة عمل = مجلّد مستقل بفهرس git خاص + قاعدة بيانات + منفذ ⇒ عزل حقيقي (انظر CLAUDE.md §٧ + coord).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  coordRootFor, sessionKeyFor, ensureCoordDirs, sessionsDir, writeJson, readJson,
} from "./coord-core.mjs";
import { TEST_DB_BASE } from "./lib/test-db-name.mjs";

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
/**
 * **أساسُ رابط قاعدة الاختبار — مصدرٌ واحدٌ للمضيف والمنفذ والاعتماد** (مراجعة Codex P2 #921).
 *
 * كان الإنشاءُ يقرأ كلمةَ المرور من `TEST_DB_ROOT_PW` بينما الرابطُ المكتوب يأخذها من
 * `TEST_DB_BASE` الثابتة (`root:testpw`). فمَن غيّر كلمةَ مرور صندوق اختباره حصل على
 * **إنشاءٍ ناجح ورابطٍ يفشل بالمصادقة** — أسوأُ تركيبة: السكربت يقول «جاهزة» والاختبارات ترفض.
 * ⇒ الاثنان من هنا، ويُتجاوَزان معاً بمتغيّرٍ واحد.
 */
function testBaseUrl() {
  return String(process.env.TEST_DB_BASE_URL ?? TEST_DB_BASE).replace(/\/+$/, "");
}

/** اعتمادُ صندوق الاختبار مشتقٌّ من الرابط نفسه — لا متغيّرَ ثانٍ ينحرف عنه. */
function testCreds() {
  try {
    const u = new URL(testBaseUrl().replace(/^mysql:/, "http:"));
    return {
      user: decodeURIComponent(u.username || "root"),
      pw: decodeURIComponent(u.password || ""),
    };
  } catch {
    return { user: "root", pw: "testpw" };
  }
}

/**
 * **اسمُ قاعدة اختبار الجلسة — من اسم الجلسة الفريد لا من اسم المجلّد** (مراجعة Codex P1 #921).
 *
 * `testDbNameForWorktree` يقتطع اسمَ المجلّد إلى ٤٠ محرفاً، وبادئةُ `business_management_system__`
 * تلتهم ٢٧ منها ⇒ لم يبقَ للاسم إلّا ١٣. فجلستا `refund-return-handling-a` و`-b` تحصلان على
 * **القاعدة نفسها** (`erp_business_management_system_refund_return_test`)، و`__setup__.ts` يمسح
 * كلَّ صفوفِ كلِّ جداولها بعد كلّ ملفّ ⇒ **جلستان تتقاتلان صامتاً** — وهو بالضبط ما وُجد
 * `test-db-name.mjs` ليمنعه. أُثبت التصادمُ بالتشغيل قبل الإصلاح.
 *
 * اسمُ الجلسة فريدٌ بالبناء (`session:new` يفشل إن وُجد المجلّد)، وقصيرٌ فلا يُقتطع عادةً؛
 * وحين يطول تُضاف بصمةٌ تحفظ التمايز بدل أن يُلقى الذيلُ المميِّز.
 *
 * ⚠️ ولذلك **لا يُستعمل `defaultTestDatabaseUrl` هنا**: التوافقُ مع الاشتقاق التلقائيّ مطلوبٌ
 * لكنّه لا يُشترى بتصادمِ قاعدتين. والرابطُ يُكتب صراحةً على أيّ حال فلا اشتقاقَ يجري.
 */
function sessionTestDbName(sessionName) {
  const slug = String(sessionName).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  if (!slug) return "erp_session_test";
  if (slug.length <= 40) return `erp_session_${slug}_test`;
  const hash = createHash("sha1").update(slug).digest("hex").slice(0, 8);
  return `erp_session_${slug.slice(0, 32).replace(/_+$/g, "")}_${hash}_test`;
}

/** إنشاءُ قاعدةٍ واحدة على حاويةٍ بعينها. */
function createDbIn(container, user, pw, dbName) {
  const sql = `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
  try {
    execFileSync("docker", ["exec", container, "mysql", `-u${user}`, `-p${pw}`, "-e", sql], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e?.message ?? String(e) };
  }
}

/**
 * **حاويتان لا واحدة** (٣١/٨) — وهذا جوهرُ الإصلاح.
 *
 * كانت القاعدتان تُنشآن معاً على حاوية **التطوير** (3306)، ويُشتقّ `TEST_DATABASE_URL` من
 * `DATABASE_URL` في `.env` الجذر ⇒ يرث المنفذ 3306. ونتيجتُه عطبٌ مزدوج:
 *
 *  ١) **حرّاسُ السلامة ترفضه فوراً**: [`init-test-db.mjs`](./init-test-db.mjs) و
 *     [`__setup__.ts`](../server/services/__tests__/__setup__.ts) يرفضان المنفذ 3306 صراحةً
 *     ⇒ **جلسةٌ جديدة لا تستطيع تشغيل اختبارٍ واحد** حتى يُعدَّل `.env` يدوياً.
 *  ٢) **وأخطر**: على هذا الجهاز حاويةُ 3306 هي `erp-mysql-prod` — مرآةُ الإنتاج، وخطٌّ أحمر
 *     في CLAUDE.md. فكان السكربت يُنشئ قواعدَ اختبارٍ داخل مرآة الإنتاج، وقاعدةُ الاختبار
 *     يمسحها `__setup__.ts` **كلَّ صفوفِ كلِّ جداولها** بعد كل ملفّ.
 *
 * ⇒ قاعدةُ التطوير على حاوية التطوير، وقاعدةُ الاختبار على **صندوق الاختبار 3310** الذي
 * يفترضه `TEST_DB_BASE` أصلاً — فيتوافق السكربت مع الاشتقاق التلقائيّ بدل أن ينقضه.
 */
function provisionDbs(dbName, testDbName) {
  const devContainer = process.env.DB_CONTAINER ?? "erp-mysql";
  const devPw = process.env.DB_ROOT_PW ?? "erp_root_pw";
  const testContainer = process.env.TEST_DB_CONTAINER ?? "erp-test-db";
  const { user: testUser, pw: testPw } = testCreds();
  const dev = createDbIn(devContainer, "root", devPw, dbName);
  const test = createDbIn(testContainer, testUser, testPw, testDbName);
  return {
    ok: dev.ok && test.ok,
    dev,
    test,
    devContainer,
    testContainer,
  };
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
  /**
   * اسمُ قاعدة الاختبار **مشتقٌّ من مجلّد شجرة العمل** بنفس دالّة الاشتقاق التلقائيّ
   * ([`lib/test-db-name.mjs`](./lib/test-db-name.mjs)) — لا `${dbName}_test`.
   * فالاسمُ الذي يكتبه السكربت هو عينُه الذي يحسبه `vitest` حين يغيب `TEST_DATABASE_URL`
   * ⇒ لا انحرافَ ممكنٌ بين الاثنين، ولا قاعدةٌ يتيمةٌ يُنشئها أحدُهما ويبحث عنها الآخر.
   */
  const testDbName = sessionTestDbName(name);
  const port = pickPort(flagVal("--port"));

  // ٢) قاعدتا البيانات — كلٌّ على حاويتها (تطوير 3306 · اختبار 3310)
  if (!noDb) {
    const prov = provisionDbs(dbName, testDbName);
    if (prov.ok) {
      console.log(`• قاعدتان جاهزتان: ${dbName} على ${prov.devContainer} (تطوير) + ${testDbName} على ${prov.testContainer} (اختبار)`);
    } else {
      if (!prov.dev.ok) {
        warn(`تعذّر إنشاء قاعدة التطوير (Docker متوقّف؟). أنشئها يدوياً:\n` +
          `   docker exec ${prov.devContainer} mysql -uroot -perp_root_pw -e "CREATE DATABASE \\\`${dbName}\\\`;"`);
      }
      if (!prov.test.ok) {
        warn(`تعذّر إنشاء قاعدة الاختبار على صندوق الاختبار. أنشئها يدوياً:\n` +
          `   docker exec ${prov.testContainer} mysql -uroot -ptestpw -e "CREATE DATABASE \\\`${testDbName}\\\`;"\n` +
          `   (أو شغّل داخل المجلّد: pnpm test:db:init)`);
      }
    }
  }

  // ٣) ‎.env للجلسة (منفذ + قاعدتان مستقلّتان)
  const rootEnv = existsSync(path.join(root, ".env")) ? parseEnv(readFileSync(path.join(root, ".env"), "utf8")) : new Map();
  const baseUrl = rootEnv.get("DATABASE_URL") || "mysql://root:erp_root_pw@127.0.0.1:3306/erp";
  /**
   * ⛔ **لا يُشتقّ رابطُ الاختبار من `DATABASE_URL`** — هذا كان الجذر: يرث منه المنفذ 3306
   * (مرآةَ الإنتاج على هذا الجهاز) فترفضه حرّاسُ الاختبار، ويُلغي في الوقت نفسه الاشتقاقَ
   * التلقائيّ الصحيح لأنّ الكتابةَ الصريحة تسبقه.
   * مصدرُه الآن `testBaseUrl()` (صندوق الاختبار 3310) — **نفسُ الأساس الذي أُنشئت به القاعدة
   * فعلاً**، فلا يفترق الاعتمادُ عن الإنشاء. واسمُها من `sessionTestDbName` لا من اسم المجلّد
   * (تصادمُ الاقتطاع — مراجعة Codex P1).
   */
  const envFile = writeWorktreeEnv(dir, {
    PORT: String(port),
    DATABASE_URL: withDb(baseUrl, dbName),
    TEST_DATABASE_URL: `${testBaseUrl()}/${testDbName}`,
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
