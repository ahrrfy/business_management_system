// إدارة جلسات/فروع العمل المعزولة عبر git worktree — كي لا تتعارض الجلسات/الوكلاء على نفس الملفات.
// الاستخدام:
//   pnpm session:new <اسم> [--from <فرع-الأساس>]   إنشاء فرع session/<اسم> + شجرة عمل معزولة مجاورة
//   pnpm session:list                               عرض كل أشجار العمل وفروعها
//   pnpm session:remove <اسم> [--keep-branch]        إزالة شجرة العمل (والفرع ما لم يُطلب إبقاؤه)
// كل شجرة عمل = مجلّد مستقل بفهرس git خاص ⇒ كتابة متوازية بلا تصادم فيزيائي (انظر CLAUDE.md §٧).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function git(args, { capture = true } = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
}
function tryGit(args) {
  try { return { ok: true, out: git(args).trim() }; } catch (e) { return { ok: false, err: e?.message ?? String(e) }; }
}
function fail(msg) { console.error("✗", msg); process.exit(1); }

const [, , sub, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const positional = rest.filter((a) => !a.startsWith("--"));
const name = positional[0];

const repoRoot = tryGit(["rev-parse", "--show-toplevel"]);
if (!repoRoot.ok) fail("ليست داخل مستودع git.");
const root = repoRoot.out;
const parent = path.dirname(root);
const base = path.basename(root);
const wtPath = (n) => path.join(parent, `${base}__${n}`);
const validName = (n) => /^[a-z0-9][a-z0-9-]*$/.test(n);

function branchExists(branch) {
  return tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function cmdNew() {
  if (!name) fail("الاسم مطلوب: pnpm session:new <اسم>");
  if (!validName(name)) fail("الاسم بحروف صغيرة وأرقام وشُرَط فقط (kebab-case): مثل returns أو price-list.");
  const fromIdx = rest.indexOf("--from");
  const fromBase = fromIdx >= 0 ? rest[fromIdx + 1] : "main";
  const branch = `session/${name}`;
  const dir = wtPath(name);

  if (existsSync(dir)) fail(`المجلّد موجود سلفاً: ${dir}`);

  const exists = branchExists(branch);
  const args = exists
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", "-b", branch, dir, fromBase];
  console.log(`• ${exists ? "ربط فرع موجود" : `تفريع ${branch} من ${fromBase}`} ⇒ شجرة عمل معزولة…`);
  const res = tryGit(args);
  if (!res.ok) fail(`فشل إنشاء شجرة العمل:\n${res.err}`);

  const dbName = `erp_${name.replace(/-/g, "_")}`;
  console.log(`\n✓ جلسة جاهزة: ${branch}`);
  console.log(`  المجلّد:  ${dir}`);
  console.log(`\nالخطوات التالية (في المجلّد الجديد):`);
  console.log(`  cd "${dir}"`);
  console.log(`  pnpm install                         # شجرة العمل لا ترث node_modules`);
  console.log(`  # عزل قاعدة هذه الجلسة (تجنّب مشاركة erp):`);
  console.log(`  #   أنشئ قاعدة ${dbName} ثم اضبط DATABASE_URL إليها في .env، ثم: pnpm db:push && pnpm seed`);
  console.log(`  pnpm dev                             # استعمل منفذاً مختلفاً إن شغّلت جلستين معاً (PORT=3001)`);
  console.log(`\nتذكير الفريق (§٧): كاتب واحد لكل ملف، والملفات الساخنة (routers.ts / App.tsx / التنقّل / schema.ts) يملكها القائد فقط.`);
  console.log(`عند الفراغ: ادمج إلى main ثم  pnpm session:remove ${name}`);
}

function cmdList() {
  const res = tryGit(["worktree", "list"]);
  if (!res.ok) fail(res.err);
  console.log("أشجار العمل الحالية (كل سطر = جلسة معزولة محتملة):\n");
  console.log(res.out);
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
    console.log(del.ok ? `✓ حُذف الفرع ${branch}` : `• أُبقي الفرع ${branch} (غير مدموج؟ احذفه يدوياً بـ git branch -D ${branch}).`);
  }
}

switch (sub) {
  case "new": cmdNew(); break;
  case "list": cmdList(); break;
  case "remove": cmdRemove(); break;
  default:
    console.log("الأوامر: new <اسم> [--from <فرع>] | list | remove <اسم> [--keep-branch]");
    process.exit(sub ? 1 : 0);
}
