#!/usr/bin/env node
/**
 * scripts/authz-guard-diff.mjs — حارس الصلاحيات **بمقارنة الأساس المتحرّك (merge-base)**.
 *
 * المشكلة التي يحلّها: الحارس الساكن (`authz-inventory.mjs --check` + `authz-baseline.json` ملتزَم)
 * يقارن ضدّ لقطةٍ ملتزَمة على الفرع، بينما CI لأحداث pull_request يُقيّم **دمج الفرع في main**. فحين
 * يتقدّم `main` بانتهاكاتٍ خاصّةٍ به (راوترات جديدة) تظهر «مستجدّة» زوراً فيفشل CI على كودٍ خارج الـPR.
 *
 * الحلّ (لا أساس ملتزَم): احسب مجموعة الانتهاكات عند **قاعدة الدمج** (base) لحظةَ التشغيل، وقارنها
 * بمجموعة انتهاكات الـhead. **افشل فقط على ما يُدخِله الـPR** — أي بصمة انتهاكٍ عددُها في head أكبر
 * منه في base. انتهاكاتُ main موجودةٌ في base أيضاً ⇒ لا تُحسَب. لا انجراف، لا أساس يُصان.
 *
 * البصمة مستقلّةٌ عن رقم السطر (`router.name.kind|flags`) فلا يُزيِّفها تحرّك الأسطر بين base وhead،
 * ومقارنةُ **العدد** (multiset) تكشف حتى مضاعفة انتهاكٍ على مفتاحٍ متصادم (voucherRouter.create).
 *
 * الأساس: `BASE_REF` (تضبطه CI = base sha للـPR)، وإلّا `origin/main`. إن تعذّر حلّه ⇒ **تحذير +
 * سقوطٌ رشيق** إلى الحارس الساكن (`--check`) فلا يتعطّل CI عند غياب المرجع (push إلى فرعٍ محليّ مثلاً).
 *
 * الاستعمال:  node scripts/authz-guard-diff.mjs
 *   BASE_REF=<sha|ref>  يحدّد قاعدة الدمج (افتراضياً origin/main).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(REPO, "scripts", "authz-inventory.mjs");

/** git بأرغيومنتات مصفوفة (بلا shell) — يتفادى تفسير cmd.exe لـ`^` في `^{commit}` على ويندوز. */
function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

/** يمسح جذراً مّا عبر السكانر ويُعيد عناصر الانتهاك [{sig, loc, flags}]. */
function violationsAt(root) {
  const out = execFileSync("node", [SCANNER, "--emit-violations", "--root", root], {
    cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out).items;
}

function multiset(items) {
  const m = new Map();
  for (const it of items) m.set(it.sig, (m.get(it.sig) || 0) + 1);
  return m;
}

function runStaticFallback(reason) {
  console.error(`⚠ حارس merge-base: ${reason} — سقوطٌ رشيق إلى الحارس الساكن (--check).`);
  try {
    execFileSync("node", [SCANNER, "--check"], { cwd: REPO, stdio: "inherit" });
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

// ── حلّ مرجع الأساس (base) ─────────────────────────────────────────────
const baseRef = process.env.BASE_REF || "origin/main";
let baseSha;
try {
  baseSha = git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`);
} catch {
  // قد لا يكون المرجع مجلوباً (checkout ضحل) — حاول جلبه.
  try {
    git("fetch", "--no-tags", "--depth=1", "origin", baseRef.replace(/^origin\//, ""));
    baseSha = git("rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}");
  } catch { /* يسقط أدناه */ }
}
if (!baseSha) runStaticFallback(`تعذّر حلّ مرجع الأساس "${baseRef}"`);

// ── تجهيز شجرة الأساس في worktree مؤقّت خارج المستودع ──────────────────
const tmp = mkdtempSync(join(tmpdir(), "authz-base-"));
let baseItems;
try {
  git("worktree", "add", "--detach", "--force", tmp, baseSha);
  baseItems = violationsAt(tmp);
} catch (e) {
  try { git("worktree", "remove", "--force", tmp); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  runStaticFallback(`تعذّر تجهيز شجرة الأساس (${(e && e.message ? e.message : e).toString().slice(0, 120)})`);
}

const headItems = violationsAt(REPO);

// نظّف الـworktree المؤقّت
try { git("worktree", "remove", "--force", tmp); } catch {}
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

// ── الفرق: انتهاكاتٌ يُدخِلها الـhead ولا وجود لها (بنفس العدد) في الأساس ──
const baseSet = multiset(baseItems);
const headSet = multiset(headItems);

/** أول loc غير مُستهلَك لبصمةٍ في head — لرسالةٍ مفيدة (تقريبيّ عند التصادم). */
const headByLoc = new Map();
for (const it of headItems) {
  if (!headByLoc.has(it.sig)) headByLoc.set(it.sig, []);
  headByLoc.get(it.sig).push(it);
}

const novel = [];
for (const [sig, hc] of headSet) {
  const extra = hc - (baseSet.get(sig) || 0);
  if (extra > 0) {
    const locs = (headByLoc.get(sig) || []).slice(-extra);
    for (const it of locs) novel.push({ sig, loc: it.loc, flags: it.flags });
  }
}

console.error(
  `حارس merge-base: base=${baseSha.slice(0, 9)} (${baseItems.length} انتهاكاً) · head (${headItems.length} انتهاكاً).`
);

if (novel.length) {
  console.error(`\n✖ ${novel.length} انتهاك سلطةٍ **يُدخِلها هذا الـPR** (غير موجودٍ في الأساس):`);
  for (const n of novel.slice(0, 50)) console.error(`  - ${n.sig}  [${n.flags}]  ${n.loc}`);
  console.error(
    `\nهذه بوّاباتٌ ضعّفها/أضافها الـPR (raw-role / بلا بوّابة وحدة / admin على كتابة). عالِجها،` +
    `\nأو إن كانت مقصودةً فوثّق سببها في وصف الـPR (الحارس يقارن ضدّ قاعدة الدمج تلقائياً — لا أساس يُحدَّث).`
  );
  process.exit(1);
}

console.error(`\n✔ لا انتهاك سلطةٍ مستجدّ من هذا الـPR مقابل قاعدة الدمج.`);
process.exit(0);
